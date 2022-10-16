import { checkDeleteDurableObjectAllowed } from './admin_api.ts';
import { ApiTokenPermission, hasPermission, isExternalNotification, RpcClient } from '../rpc_model.ts';
import { newMethodNotAllowedResponse, newJsonResponse, newForbiddenJsonResponse, newTextResponse } from '../responses.ts';
import { computeQueryRedirectLogsResponse } from './api_query_redirect_logs.ts';
import { consoleError } from '../tracer.ts';
import { computeRawIpAddress } from '../cloudflare_request.ts';
import { computeApiKeyResponse, computeApiKeysResponse } from './api_api_keys.ts';
import { validateSessionToken } from '../session_token.ts';
import { isValidInstant } from '../check.ts';
import { StatusError } from '../errors.ts';
import { PodcastIndexClient } from '../podcast_index_client.ts';

export function tryParseApiRequest(opts: { instance: string, method: string, hostname: string, pathname: string, searchParams: URLSearchParams, headers: Headers, bodyProvider: JsonProvider }): ApiRequest | undefined {
    const { instance, method, hostname, pathname, searchParams, headers, bodyProvider } = opts;
    const m = /^\/api\/1(\/[a-z\/-]+(\/.+?)?)$/.exec(pathname);
    if (!m) return undefined;
    const [ _, path ] = m;
    const m2 = /^bearer (.*?)$/i.exec(headers.get('authorization') ?? '');
    const bearerToken = m2 ? m2[1] : undefined;
    const rawIpAddress = computeRawIpAddress(headers);
    return { instance, method, hostname, path, searchParams, bearerToken, rawIpAddress, bodyProvider };
}

// deno-lint-ignore no-explicit-any
export type JsonProvider = () => Promise<any>;

export async function computeApiResponse(request: ApiRequest, opts: { rpcClient: RpcClient, adminTokens: Set<string>, previewTokens: Set<string>, turnstileSecretKey: string | undefined, podcastIndexCredentials: string | undefined }): Promise<Response> {
    const { instance, method, hostname, path, searchParams, bearerToken, rawIpAddress, bodyProvider } = request;
    const { rpcClient, adminTokens, previewTokens, turnstileSecretKey, podcastIndexCredentials } = opts;

    try {
        // first, we need to know who's calling
        const identity = await computeIdentityResult(bearerToken, searchParams, adminTokens, previewTokens, rpcClient);
        console.log(`computeApiResponse`, { method, path, identity: identityResultToJson(identity) });
    
        // all api endpoints require an auth token
        if (identity.kind === 'invalid' && identity.reason === 'missing-token') return newJsonResponse({ error: 'unauthorized' }, 401);
        if (identity.kind === 'invalid' && identity.reason === 'expired-token') return newJsonResponse({ error: 'expired' }, 401);
        if (identity.kind === 'invalid' && identity.reason === 'blocked-token') return newJsonResponse({ error: 'blocked' }, 401);
    
        // invalid token or any other invalid reason
        if (identity.kind === 'invalid') return newForbiddenJsonResponse();

        const { permissions } = identity;
        if (path === '/admin/metrics') return await computeAdminGetMetricsResponse(permissions, method, rpcClient);
        const isAdmin = permissions.has('admin');
        if (path.startsWith('/admin/')) {
            // all other admin endpoints require admin
            if (!isAdmin) return newForbiddenJsonResponse();

            if (path === '/admin/data') return await computeAdminDataResponse(method, bodyProvider, rpcClient);
            if (path === '/admin/rebuild-index') return await computeAdminRebuildResponse(method, bodyProvider, rpcClient);
        }
        if (path === '/redirect-logs') return await computeQueryRedirectLogsResponse(permissions, method, searchParams, rpcClient);
        if (path === '/api-keys') return await computeApiKeysResponse({ instance, method, hostname, bodyProvider, rawIpAddress, turnstileSecretKey, rpcClient });
        const m = /^\/api-keys\/([0-9a-f]{32})$/.exec(path); if (m) return await computeApiKeyResponse(m[1], isAdmin, { instance, method, hostname, bodyProvider, rawIpAddress, turnstileSecretKey, rpcClient });
        if (path === '/notifications') return await computeNotificationsResponse(permissions, method, bodyProvider, rpcClient); 
        if (path === '/feeds/search') return await computeFeedsSearchResponse(method, bodyProvider, podcastIndexCredentials); 
    
        // unknown api endpoint
        return newJsonResponse({ error: 'not found' }, 404);
    } catch (e) {
        if (e instanceof StatusError) {
            return newJsonResponse({ error: e.message }, e.status);
        } else {
            const error = `${e.stack || e}`;
            consoleError('api-call', `Error in api call: ${error}`);
            return newJsonResponse({ error }, 500);
        }
    }
}

export interface ApiRequest {
    readonly instance: string;
    readonly method: string;
    readonly hostname: string;
    readonly path: string;
    readonly searchParams: URLSearchParams;
    readonly bearerToken?: string;
    readonly rawIpAddress?: string;
    readonly bodyProvider: JsonProvider;
}

//

type IdentityResult = ValidIdentityResult | InvalidIdentityResult;

interface ValidIdentityResult {
    readonly kind: 'valid';
    readonly permissions: ReadonlySet<ApiTokenPermission>;
}

interface InvalidIdentityResult {
    readonly kind: 'invalid';
    readonly reason: 'missing-token' | 'invalid-token' | 'blocked-token' | 'expired-token';
}

function identityResultToJson(result: IdentityResult) {
    return result.kind === 'valid' ? { kind: result.kind, permissions: [...result.permissions] } : result;
}

//

async function computeIdentityResult(bearerToken: string | undefined, searchParams: URLSearchParams, adminTokens: Set<string>, previewTokens: Set<string>, rpcClient: RpcClient): Promise<IdentityResult> {
    const token = typeof bearerToken === 'string' ? bearerToken : searchParams.get('token') ?? undefined;
    if (token === undefined) return { kind: 'invalid', reason: 'missing-token' };
    if (adminTokens.has(token)) return { kind: 'valid', permissions: new Set([ 'admin' ]) };
    if (previewTokens.has(token)) return { kind: 'valid', permissions: new Set([ 'preview' ]) };
    const res = await rpcClient.resolveApiToken({ token }, 'api-key-server');
    if (res.permissions !== undefined) return { kind: 'valid', permissions: new Set(res.permissions) };
    if (res.reason === 'blocked') return { kind: 'invalid', reason: 'blocked-token' };
    if (res.reason === 'expired') return { kind: 'invalid', reason: 'expired-token' };
    return { kind: 'invalid', reason: 'invalid-token' };
}

async function computeAdminDataResponse(method: string, bodyProvider: JsonProvider, rpcClient: RpcClient): Promise<Response> {
    if (method !== 'POST') return newMethodNotAllowedResponse(method);

    const { operationKind, targetPath, dryRun } = await bodyProvider();
    if (operationKind === 'select' && targetPath === '/registry') {
        const { results } = await rpcClient.adminExecuteDataQuery({ operationKind, targetPath, dryRun }, 'registry');
        return newJsonResponse({ results });
    } else if (operationKind === 'select' && targetPath === '/keys') {
        const { results } = await rpcClient.adminExecuteDataQuery({ operationKind, targetPath, dryRun }, 'key-server');
        return newJsonResponse({ results });
    } else if (operationKind === 'select' && targetPath.startsWith('/crl/')) {
        const { results } = await rpcClient.adminExecuteDataQuery({ operationKind, targetPath, dryRun }, 'combined-redirect-log');
        return newJsonResponse({ results });
    } else if (operationKind === 'select' && targetPath === '/crl/records') {
        const { results } = await rpcClient.adminExecuteDataQuery({ operationKind, targetPath, dryRun }, 'combined-redirect-log');
        return newJsonResponse({ results });
    } else if (operationKind === 'delete' && targetPath.startsWith('/durable-object/')) {
        const doName = checkDeleteDurableObjectAllowed(targetPath);
        const { message } = await rpcClient.adminExecuteDataQuery({ operationKind, targetPath, dryRun }, doName);
        return newJsonResponse({ message });
    } else if (operationKind === 'select' && targetPath === '/api-keys') {
        const { results } = await rpcClient.adminExecuteDataQuery({ operationKind, targetPath, dryRun }, 'api-key-server');
        return newJsonResponse({ results });
    } else if (operationKind === 'select' && targetPath.startsWith('/api-keys/info/')) {
        const { results } = await rpcClient.adminExecuteDataQuery({ operationKind, targetPath, dryRun }, 'api-key-server');
        return newJsonResponse({ results });
    }  else if (operationKind === 'select' && targetPath === '/feed-notifications') {
        const { results } = await rpcClient.adminExecuteDataQuery({ operationKind, targetPath, dryRun }, 'show-server');
        return newJsonResponse({ results });
    } else {
        throw new StatusError(`Unsupported operationKind ${operationKind} and targetPath ${targetPath}`);
    }
}

async function computeAdminRebuildResponse(method: string, bodyProvider: JsonProvider, rpcClient: RpcClient): Promise<Response> {
    if (method !== 'POST') return newMethodNotAllowedResponse(method);

    const { indexName, start, inclusive, limit } = await bodyProvider();

    if (typeof indexName !== 'string') throw new StatusError(`Bad indexName: ${indexName}`);
    if (typeof start !== 'string') throw new StatusError(`Bad start: ${start}`);
    if (typeof inclusive !== 'boolean') throw new StatusError(`Bad inclusive: ${inclusive}`);
    if (typeof limit !== 'number') throw new StatusError(`Bad limit: ${limit}`);

    const { first, last, count, millis } = await rpcClient.adminRebuildIndex({ indexName, start, inclusive, limit }, 'combined-redirect-log');
    return newJsonResponse({ first, last, count, millis });
}

async function computeAdminGetMetricsResponse(permissions: ReadonlySet<ApiTokenPermission>, method: string, rpcClient: RpcClient): Promise<Response> {
    if (!hasPermission(permissions, 'admin-metrics')) return newForbiddenJsonResponse();
    if (method !== 'GET') return newMethodNotAllowedResponse(method);
    return await rpcClient.adminGetMetrics({}, 'combined-redirect-log');
}

async function computeNotificationsResponse(permissions: ReadonlySet<ApiTokenPermission>, method: string, bodyProvider: JsonProvider, rpcClient: RpcClient): Promise<Response> {
    if (!hasPermission(permissions, 'notification')) return newForbiddenJsonResponse();
    if (method !== 'POST') return newMethodNotAllowedResponse(method);

    const received = new Date().toISOString();
    const notification = await bodyProvider();
    if (!isExternalNotification(notification)) throw new StatusError(`Bad notification body`);

    await rpcClient.receiveExternalNotification({ notification, received }, 'show-server');

    return newTextResponse('thanks');
}

async function computeFeedsSearchResponse(method: string, bodyProvider: JsonProvider, podcastIndexCredentials: string | undefined): Promise<Response> {
    if (method !== 'POST') return newMethodNotAllowedResponse(method);
    if (typeof podcastIndexCredentials !== 'string') return newForbiddenJsonResponse();
    const client = PodcastIndexClient.of({ podcastIndexCredentials, userAgent: 'op3.dev' });
    if (!client) return newForbiddenJsonResponse();
    const { sessionToken, q: qFromObj } = await bodyProvider();
    if (typeof sessionToken !== 'string') return newForbiddenJsonResponse();
    const { k, t } = await validateSessionToken(sessionToken, podcastIndexCredentials);
    if (typeof k !== 'string' || k !== 'i') return newForbiddenJsonResponse();
    if (typeof t !== 'string' || !isValidInstant(t) || (Date.now() - new Date(t).getTime()) > 1000 * 60 * 5) return newForbiddenJsonResponse();
    const q = typeof qFromObj === 'string' ? qFromObj.trim() : '';
    if (q === '') throw new StatusError(`Bad q: ${qFromObj}`);

    const res = await client.searchPodcastsByTerm(q);
    const { feeds } = res;
    
    return newJsonResponse({ feeds });
}
