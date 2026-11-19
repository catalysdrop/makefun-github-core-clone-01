// The server: one HTTP process, one store, four surfaces — git smart HTTP,
// REST v3, GraphQL v4 and MCP — behind a single bearer-token gate. Every
// reply carries X-GitHub-Request-Id; every JSON reply is JSON (never HTML).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { handleGraphql } from './src/graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './src/gitserver.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest, SCOPES_HEADER, type RestRequest } from './src/rest.ts';
import { Store } from './src/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}`;
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  send(res, status, JSON_TYPE, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), headers);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 256 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';

      // The env's boot check calls this twice: 200 {"ok":true}. No auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Every other surface needs the shop token.
      const authorization = req.headers.authorization ?? '';
      const authed = shopToken !== '' && authorization === `Bearer ${shopToken}`;
      if (!authed) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }

      try {
        // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const endpoint = gitMatch[3] as string;
          const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : null;
          if (endpoint === 'info/refs') {
            if (method !== 'GET') {
              sendJson(res, 405, { message: 'Method Not Allowed' });
              return;
            }
            const service = queryOf(req).get('service') ?? '';
            const result = handleInfoRefs(store, owner, repoName, service, gitProtocol);
            send(res, result.status, result.contentType, result.body);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(req);
          if (endpoint === 'git-upload-pack') {
            const result = handleUploadPack(store, owner, repoName, body, gitProtocol);
            send(res, result.status, result.contentType, result.body);
            return;
          }
          const result = handleReceivePack(store, owner, repoName, body);
          send(res, result.status, result.contentType, result.body);
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(req);
          const result = handleGraphql(store, body);
          send(res, result.status, JSON_TYPE, result.body, { 'x-oauth-scopes': SCOPES_HEADER });
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(req);
          const result = handleMcp(store, body);
          send(res, result.status, result.contentType, result.body);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const body = method === 'GET' || method === 'HEAD' ? null : await readBody(req);
          const restReq: RestRequest = {
            method,
            path,
            query: queryOf(req),
            host: req.headers.host ?? '127.0.0.1',
            body,
          };
          const result = handleRest(store, restReq);
          send(res, result.status, result.contentType, result.body, {
            'x-oauth-scopes': SCOPES_HEADER,
            ...(result.extraHeaders ?? {}),
          });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      }
    })().catch(() => {
      try {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } catch {
        // The response is already gone.
      }
    });
  });
}
