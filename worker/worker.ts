import { computeColo, computeOther, computeRawIpAddress } from './cloudflare_request.ts';
import { ModuleWorkerContext } from './deps.ts';
import { computeHomeResponse } from './home.ts';
import { computeInfoResponse } from './info.ts';
import { computeRedirectResponse, tryParseRedirectRequest } from './redirect_episode.ts';
import { WorkerEnv } from './worker_env.ts';
import { IsolateId } from './isolate_id.ts';
import { computeApiResponse, tryParseApiRequest } from './api.ts';
import { CloudflareRpcClient } from './cloudflare_rpc_client.ts';
import { generateUuid } from './uuid.ts';
import { tryParseUlid } from './ulid.ts';
import { RawRequest } from './rpc_model.ts';
export { BackendDO } from './backend/backend_do.ts';

export default {
    
    async fetch(request: Request, env: WorkerEnv, context: ModuleWorkerContext): Promise<Response> {
        const requestTime = Date.now();
       
        // first, handle redirects - the most important function
        // be careful here: must never throw
        const redirectResponse = tryComputeRedirectResponse(request, { env, context, requestTime });
        if (redirectResponse) return redirectResponse;

        // handle all other requests
        try {
            const { instance, backendNamespace } = env;
            IsolateId.log();
            const { pathname } = new URL(request.url);
            const { method, headers } = request;
            const adminTokens = new Set((env.adminTokens ?? '').split(',').map(v => v.trim()).filter(v => v !== ''));

            if (method === 'GET' && pathname === '/') return computeHomeResponse({ instance });
            if (method === 'GET' && pathname === '/info.json') return computeInfoResponse(env);

            const rpcClient = new CloudflareRpcClient(backendNamespace);
            const apiRequest = tryParseApiRequest({ method, pathname, headers, bodyProvider: () => request.json() }); if (apiRequest) return await computeApiResponse(apiRequest, { rpcClient, adminTokens });

            return new Response('not found', { status: 404 });
        } catch (e) {
            console.error(`Unhandled error computing response: ${e.stack || e}`);
            return new Response('failed', { status: 500 });
        }
    }
    
}

//

const pendingRawRequests: RawRequest[] = [];

function tryComputeRedirectResponse(request: Request, opts: { env: WorkerEnv, context: ModuleWorkerContext, requestTime: number }): Response | undefined {
    // must never throw!
    const redirectRequest = tryParseRedirectRequest(request.url);
    if (!redirectRequest) return undefined;

    const { env, context, requestTime } = opts;
    const rawRequests = pendingRawRequests.splice(0);
    // do the expensive work after quickly returning the redirect response
    context.waitUntil((async () => {
        const { backendNamespace, dataset1 } = env;
        const { method } = request;
        let colo = 'XXX';
        try {
            IsolateId.log();
            if (!backendNamespace) throw new Error(`backendNamespace not defined!`);
            if (redirectRequest.kind === 'valid') {
                const rawIpAddress = computeRawIpAddress(request) ?? '<missing>';
                const other = computeOther(request) ?? {};
                colo = (other ?? {}).colo ?? colo;
                other.isolateId = IsolateId.get();
                const rawRequest = computeRawRequest(request, { time: requestTime, method, rawIpAddress, other });
                console.log(`rawRequest: ${JSON.stringify({ ...rawRequest, rawIpAddress: '<hidden>' }, undefined, 2)}`);
                
                rawRequests.push(rawRequest);
            }
            
            if (rawRequests.length > 0) {
                const doName = `raw-request-${colo}`;
                const rpcClient = new CloudflareRpcClient(backendNamespace);
                await rpcClient.saveRawRequests({ rawRequests }, doName);
            }
        } catch (e) {
            console.error(`Error sending raw requests: ${e.stack || e}`);
            // we'll retry if this isolate gets hit again, otherwise lost
            // TODO retry inline?
            pendingRawRequests.push(...rawRequests);
            colo = computeColo(request) ?? colo;
            dataset1?.writeDataPoint({ blobs: [ 'error-saving-redirect', colo, `${e.stack || e}`.substring(0, 1024) ], doubles: [ 1 ] });
        } finally {
            if (colo === 'XXX') colo = computeColo(request) ?? colo;
            dataset1?.writeDataPoint({ blobs: [ redirectRequest.kind === 'valid' ? 'valid-redirect' : 'invalid-redirect', colo, request.url.substring(0, 1024) ], doubles: [ 1 ] });
        }
    })());
    if (redirectRequest.kind === 'valid') {
        console.log(`Redirecting to: ${redirectRequest.targetUrl}`);
        return computeRedirectResponse(redirectRequest);
    } else {
        console.log(`Invalid redirect url: ${request.url}`);
        return new Response('Invalid redirect url', { status: 400 });
    }
}

function computeRawRequest(request: Request, opts: { time: number, method: string, rawIpAddress: string, other?: Record<string, string> }): RawRequest {
    const { time, method, rawIpAddress, other } = opts;
    const uuid = generateUuid();
    const { url, ulid } = tryParseUlid(request.url);
    const userAgent = request.headers.get('user-agent') ?? undefined;
    const referer = request.headers.get('referer') ?? undefined;
    const range = request.headers.get('range') ?? undefined;
    return { uuid, time, rawIpAddress, method, url, userAgent, referer, range, ulid, other };
}
