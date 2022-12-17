import { computeChainDestinationUrl } from '../chain_estimate.ts';
import { check, checkMatches, isNotBlank, isValidHttpUrl, tryParseUrl } from '../check.ts';
import { isValidSha1Hex, isValidSha256Hex } from '../crypto.ts';
import { Bytes } from '../deps.ts';
import { DoNames } from '../do_names.ts';
import { packError } from '../errors.ts';
import { newForbiddenJsonResponse, newJsonResponse, newMethodNotAllowedResponse } from '../responses.ts';
import { ApiTokenPermission, hasPermission, QueryRedirectLogsRequest, RpcClient, Unkinded } from '../rpc_model.ts';
import { isValidUuid } from '../uuid.ts';
import { QUERY_REDIRECT_LOGS } from './api_contract.ts';
import { computeApiQueryCommonParameters } from './api_query_common.ts';

export async function computeQueryRedirectLogsResponse(permissions: ReadonlySet<ApiTokenPermission>, method: string, searchParams: URLSearchParams, rpcClient: RpcClient): Promise<Response> {
    if (!hasPermission(permissions, 'preview', 'read-data')) return newForbiddenJsonResponse();
    if (method !== 'GET') return newMethodNotAllowedResponse(method);

    let request: Unkinded<QueryRedirectLogsRequest>;
    try {
        request = await parseRequest(searchParams);
    } catch (e) {
        const { message } = packError(e);
        return newJsonResponse({ message }, 400);
    }
    return await rpcClient.queryRedirectLogs(request, DoNames.combinedRedirectLog);
}

//

async function parseRequest(searchParams: URLSearchParams): Promise<Unkinded<QueryRedirectLogsRequest>> {
    let request: Unkinded<QueryRedirectLogsRequest> = { ...computeApiQueryCommonParameters(searchParams, QUERY_REDIRECT_LOGS) };
    const { url, urlSha256, userAgent, referer, hashedIpAddress, edgeColo, ulid, method, uuid } = Object.fromEntries(searchParams);

    if ([ url, urlSha256, userAgent, referer, hashedIpAddress, edgeColo, ulid, method, uuid ].filter(v => typeof v === 'string').length > 1) throw new Error(`Cannot specify more than one filter parameter`);
    if (typeof url === 'string' && typeof urlSha256 === 'string') throw new Error(`Specify either 'url' or 'urlSha256', not both`);
    if (typeof url === 'string') {
        const m = /^(https?:\/\/.+?)\*$/.exec(url);
        if (m) {
            const [ _, urlStartsWith ] = m;
            const destinationUrl = computeChainDestinationUrl(urlStartsWith) ?? urlStartsWith;
            const u = tryParseUrl(destinationUrl);
            if (!u) throw new Error(`Bad urlStartsWith: ${urlStartsWith}, invalid destination url ${destinationUrl}`);
            if (u.pathname.length <= 1) throw new Error(`Bad urlStartsWith: ${urlStartsWith}, destination url pathname must be at least one character long, found ${u.pathname}`);
            request = { ...request, urlStartsWith };
        } else {
            check('url', url, isValidHttpUrl);
            const urlSha256 = (await Bytes.ofUtf8(url).sha256()).hex();
            request = { ...request, urlSha256 };
        }
    }
    if (typeof urlSha256 === 'string') {
        check('urlSha256', urlSha256, isValidSha256Hex);
        request = { ...request, urlSha256 };
    }
    if (typeof userAgent === 'string') {
        check('userAgent', userAgent, isNotBlank);
        request = { ...request, userAgent };
    }
    if (typeof referer === 'string') {
        check('referer', referer, isNotBlank);
        request = { ...request, referer };
    }
    if (typeof hashedIpAddress === 'string') {
        check('hashedIpAddress', hashedIpAddress, isValidSha1Hex);
        request = { ...request, hashedIpAddress };
    }
    if (typeof edgeColo === 'string') {
        check('edgeColo', edgeColo, isNotBlank);
        request = { ...request, edgeColo };
    }
    if (typeof ulid === 'string') {
        check('ulid', ulid, isNotBlank);
        request = { ...request, ulid };
    }
    if (typeof method === 'string') {
        checkMatches('method', method, /^(HEAD|PUT|PATCH|POST|DELETE|OPTIONS)$/);
        request = { ...request, method };
    }
    if (typeof uuid === 'string') {
        check('uuid', uuid, isValidUuid);
        request = { ...request, uuid };
    }
    return request;
}
