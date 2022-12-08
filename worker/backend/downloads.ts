import { isValidDate, isValidInstant } from '../check.ts';
import { computeServerUrl } from '../client_params.ts';
import { Bytes, TextLineStream, zip } from '../deps.ts';
import { DoNames } from '../do_names.ts';
import { findPublicSuffix } from '../public_suffixes.ts';
import { estimateByteRangeSize, tryParseRangeHeader } from '../range_header.ts';
import { RpcClient } from '../rpc_model.ts';
import { addHours, timestampToInstant } from '../timestamp.ts';
import { computeUserAgentEntityResult } from '../user_agents.ts';
import { AttNums } from './att_nums.ts';
import { Blobs } from './blobs.ts';

export async function computeHourlyDownloads(hour: string, { statsBlobs, rpcClient, maxQueries, querySize, maxHits }: { statsBlobs: Blobs, rpcClient: RpcClient, maxQueries: number, querySize: number, maxHits: number }) {
    const start = Date.now();

    const startInstant = `${hour}:00:00.000Z`;
    if (!isValidInstant(startInstant)) throw new Error(`Bad hour: ${hour}`);
    const endInstant = addHours(startInstant, 1).toISOString();
    let startAfterRecordKey: string | undefined;
    const downloads = new Set<string>();
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    chunks.push(encoder.encode(['serverUrl', 'audienceId', 'time', 'hashedIpAddress', 'encryptedIpAddress', 'agentType', 'agentName', 'deviceType', 'deviceName', 'referrerType', 'referrerName', 'countryCode', 'continentCode', 'regionCode', 'regionName', 'timezone', 'metroCode' ].join('\t') + '\n'));
    let queries = 0;
    let hits = 0;
    while (true) {
        if (queries >= maxQueries) break;
        const { namesToNums, records } = await rpcClient.queryPackedRedirectLogs({ limit: querySize, startTimeInclusive: startInstant, endTimeExclusive: endInstant, startAfterRecordKey }, DoNames.combinedRedirectLog);
        queries++;
        const attNums = new AttNums(namesToNums);
        const entries = Object.entries(records);
        for (const [ recordKey, record ] of entries) {
            if (hits >= maxHits) break;
            hits++;
            if (recordKey > (startAfterRecordKey ?? '')) startAfterRecordKey = recordKey;
            const obj = attNums.unpackRecord(record);
            const { method, range, ulid, url, hashedIpAddress, userAgent, referer, timestamp, encryptedIpAddress, 'other.country': countryCode, 'other.continent': continentCode, 'other.regionCode': regionCode, 'other.region': regionName, 'other.timezone': timezone, 'other.metroCode': metroCode } = obj;
            if (method !== 'GET') continue; // ignore all non-GET requests
            const ranges = range ? tryParseRangeHeader(range) : undefined;
            if (ranges && !ranges.some(v => estimateByteRangeSize(v) > 2)) continue; // ignore range requests that don't include a range of more than two bytes
            const serverUrl = computeServerUrl(url);
            const audienceId = (await Bytes.ofUtf8(`${hashedIpAddress}|${userAgent ?? ''}|${referer ?? ''}|${ulid ?? ''}`).sha256()).hex();
            const download = `${serverUrl}|${audienceId}`;
            if (downloads.has(download)) continue;
            const time = timestampToInstant(timestamp);
            const result = userAgent ? computeUserAgentEntityResult(userAgent, referer) : undefined;
            const agentType = result?.type ?? 'unknown';
            const agentName = result?.name ?? userAgent;
            const deviceType = result?.device?.category;
            const deviceName = result?.device?.name;
            const referrerType = result?.type === 'browser' ? (result?.referrer?.category ?? (referer ? 'domain' : undefined)) : undefined;
            const referrerName = result?.type === 'browser' ? (result?.referrer?.name ?? (referer ? (findPublicSuffix(referer, 1) ?? `unknown:[${referer}]`) : undefined)) : undefined;
            const line = [ serverUrl, audienceId, time, hashedIpAddress, encryptedIpAddress, agentType, agentName, deviceType, deviceName, referrerType, referrerName, countryCode, continentCode, regionCode, regionName, timezone, metroCode ].map(v => v ?? '').join('\t') + '\n';
            chunks.push(encoder.encode(line));
            downloads.add(download);
        }
        if (entries.length < querySize || hits >= maxHits) {
            break;
        }
    }

    const { contentLength } = await write(chunks, statsBlobs, computeHourlyKey(hour));
    
    return { hour, maxQueries, querySize, maxHits, queries, hits, downloads: downloads.size, millis: Date.now() - start, contentLength };
}

export async function computeDailyDownloads(date: string, { onlyResaveShowUuids, statsBlobs, lookupShow } : { onlyResaveShowUuids?: string[], statsBlobs: Blobs, lookupShow: (url: string) => Promise<{ showUuid: string, episodeId?: string } | undefined> }) {
    const start = Date.now();

    if (!isValidDate(date)) throw new Error(`Bad date: ${date}`);

    const lookupShowCached = (function() {
        const cache = new Map<string, { showUuid?: string, episodeId?: string }>();
        return async (url: string) => {
            const existing = cache.get(url);
            if (existing) return existing;
            const result = await lookupShow(url);
            cache.set(url, result ?? {});
            return result ?? {};
        }
    })();

    let hours = 0;
    let rows = 0;
    const downloads = new Set<string>();
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    const showChunkIndexes = new Map<string, number[]>();
    chunks.push(encoder.encode(['serverUrl', 'audienceId', 'showUuid', 'episodeId', 'time', 'hashedIpAddress', 'encryptedIpAddress', 'agentType', 'agentName', 'deviceType', 'deviceName', 'referrerType', 'referrerName', 'countryCode', 'continentCode', 'regionCode', 'regionName', 'timezone', 'metroCode' ].join('\t') + '\n'));
    for (let hourNum = 0; hourNum < 24; hourNum++) {
        const hour = `${date}T${hourNum.toString().padStart(2, '0')}`;
        const key = computeHourlyKey(hour);
        const stream = await statsBlobs.get(key, 'stream');
        if (!stream) continue;
        hours++;
        const lines = stream
            .pipeThrough(new TextDecoderStream())
            .pipeThrough(new TextLineStream());

        let headers: string[] | undefined;
        for await (const hourlyLine of lines) {
            if (hourlyLine === '') continue;
            const values = hourlyLine.split('\t');
            if (!headers) {
                headers = values;
                continue;
            }
            rows++;
            const obj = Object.fromEntries(zip(headers, values));
            const { serverUrl, audienceId, time, hashedIpAddress, encryptedIpAddress, agentType, agentName, deviceType, deviceName, referrerType, referrerName, countryCode, continentCode, regionCode, regionName, timezone, metroCode } = obj;
            const download = `${serverUrl}|${audienceId}`;
            if (downloads.has(download)) continue;
            downloads.add(download);
            const { showUuid, episodeId } = await lookupShowCached(serverUrl);
            const line = [ serverUrl, audienceId, showUuid, episodeId, time, hashedIpAddress, encryptedIpAddress, agentType, agentName, deviceType, deviceName, referrerType, referrerName, countryCode, continentCode, regionCode, regionName, timezone, metroCode ].map(v => v ?? '').join('\t') + '\n';
            const chunkIndex = chunks.push(encoder.encode(line)) - 1;
            if (showUuid) {
                let arr = showChunkIndexes.get(showUuid);
                if (!arr) {
                    arr = [ 0 ]; // header row
                    showChunkIndexes.set(showUuid, arr);
                }
                arr.push(chunkIndex);
            }
        }
    }

    const { contentLength } = await write(chunks, statsBlobs, computeDailyKey(date));
    const showContentLengths: Record<string, number> = {};
    for (const [ showUuid, chunkIndexes ] of showChunkIndexes) {
        if (!onlyResaveShowUuids || onlyResaveShowUuids.includes(showUuid)) {
            const { contentLength } = await write(chunks, statsBlobs, computeShowDailyKey({ date, showUuid }), chunkIndexes);
            showContentLengths[showUuid] = contentLength;
        }
    }

    return { date, millis: Date.now() - start, hours, rows, downloads: downloads.size, contentLength, showContentLengths };
}

//

function computeHourlyKey(hour: string): string {
    return `downloads/hourly/${hour}.tsv`;
}

function computeDailyKey(date: string): string {
    return `downloads/daily/${date}.tsv`;
}

function computeShowDailyKey({ date, showUuid}: { date: string, showUuid: string }): string {
    return `downloads/show-daily/${showUuid}/${showUuid}-${date}.tsv`;
}

async function write(chunks: Uint8Array[], blobs: Blobs, key: string, chunkIndexes?: number[]): Promise<{ contentLength: number }> {
    const contentLength = chunkIndexes ? chunkIndexes.reduce((a, b) => a + chunks[b].byteLength, 0): chunks.reduce((a, b) => a + b.byteLength, 0);
   // deno-lint-ignore no-explicit-any
   const { readable, writable } = new (globalThis as any).FixedLengthStream(contentLength);
   const putPromise = blobs.put(key, readable);
   const writer = writable.getWriter();
    if (chunkIndexes) {
        for (const i of chunkIndexes) {
            writer.write(chunks[i]);
        }
    } else {
        for (const chunk of chunks) {
            writer.write(chunk);
        }
    }
   await writer.close();
   // await writable.close(); // will throw on cf
   await putPromise;
   return { contentLength };
}
