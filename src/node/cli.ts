import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { env as shared } from 'cloudflare:workers';
import { runCron } from '../automation';
import worker from '../index';
import { createServer as createMcpServer } from '../tools';
import { SqliteKV } from './kv';
import { clientKey, rateLimiter } from './limit';

/**
 * Self-hosted entry point: the same Worker code on Node.
 *   nmail-mcp serve   HTTP server with OAuth (/mcp), like the Worker
 *   nmail-mcp stdio   MCP over stdin/stdout for local clients, no OAuth
 * KV is SQLite (DATA_DIR), Cron Triggers are a timer, the login rate limit is in memory.
 */

// stdout belongs to the MCP protocol in stdio mode, so all logging goes to stderr.
const log = (...a: unknown[]) => console.error('[nmail-mcp]', ...a);

const HELP = `Usage: nmail-mcp <serve|stdio>

Environment:
  NAVER_ID, NAVER_APP_PASSWORD   required
  NAVER_NAME, NAVER_SIGNATURE    optional sender name / signature (\\n for line breaks)
  DATA_DIR                       state directory (default ./data)
serve only:
  PORT (default 8787), HOST (default 127.0.0.1)
  PUBLIC_URL                     external base URL, e.g. https://mail.example.com (required unless only localhost is used)
  TRUST_PROXY=1                  use X-Forwarded-For / -Proto / -Host from the reverse proxy
`;

function loadEnv() {
  const missing = ['NAVER_ID', 'NAVER_APP_PASSWORD'].filter((k) => !process.env[k]);
  if (missing.length) {
    log(`missing environment variables: ${missing.join(', ')}\n\n${HELP}`);
    process.exit(2);
  }
  const kv = new SqliteKV(join(process.env.DATA_DIR ?? './data', 'nmail.db'));
  const e = {
    NAVER_ID: process.env.NAVER_ID!,
    NAVER_APP_PASSWORD: process.env.NAVER_APP_PASSWORD!,
    NAVER_NAME: process.env.NAVER_NAME,
    NAVER_SIGNATURE: process.env.NAVER_SIGNATURE,
    ATTACHMENT_DOWNLOAD_MAX_BYTES: 100_000_000,
    OAUTH_KV: kv,
    LOGIN_LIMITER: rateLimiter(5, 60), // same as wrangler.jsonc
  };
  Object.assign(shared, e); // the object the MCP tools read
  return { e, kv };
}

/** Cron Triggers on a timer: every minute, plus the 5-minute job when the minute is a multiple of 5. Never overlaps. */
function startCron(e: object, kv: SqliteKV) {
  const tick = async () => {
    const jobs = ['* * * * *', ...(new Date().getUTCMinutes() % 5 === 0 ? ['*/5 * * * *'] : [])];
    for (const cron of jobs) await runCron(e as never, cron).catch((err: Error) => log(`cron ${cron}:`, err.message));
    kv.sweep();
  };
  const next = () => setTimeout(() => void tick().finally(next), 60_000 - (Date.now() % 60_000) + 500).unref();
  next();
}

async function serve() {
  const { e, kv } = loadEnv();
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  const publicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, '');
  const trustProxy = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? '');
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0].trim();
  // The client controls the left of X-Forwarded-For; the right-most entry is the one the trusted proxy appended.
  const lastHop = (v: string | string[] | undefined) => [v ?? []].flat().join(',').split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  const loopback = /^(localhost|127(\.\d+){3}|\[::1\])(:\d+)?$/i;

  const server = createHttpServer(async (req, res) => {
    try {
      const proto = (trustProxy && first(req.headers['x-forwarded-proto'])) || 'http';
      const hostHeader = (trustProxy && first(req.headers['x-forwarded-host'])) || req.headers.host || `localhost:${port}`;
      // OAuth tokens are bound to this origin, so it must be the URL clients use.
      // Without PUBLIC_URL only loopback hosts are served: a Host header from anywhere else would mint a new OAuth origin.
      if (!publicUrl && !loopback.test(hostHeader)) {
        res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Set PUBLIC_URL to the address clients use (e.g. https://mail.example.com) to serve non-local hosts.\n');
        return;
      }
      const url = new URL(req.url ?? '/', publicUrl ?? `${proto}://${hostHeader}`);
      if (process.env.NMAIL_TEST_SCHEDULED === '1' && url.pathname === '/__scheduled') {
        await runCron(e as never, url.searchParams.get('cron') ?? '* * * * *');
        res.end('ran');
        return;
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && k !== 'host') for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
      headers.set('host', url.host);
      // The rate limiter keys on this header (set by Cloudflare on Workers); never trust a client-sent one.
      headers.set('cf-connecting-ip', clientKey((trustProxy && lastHop(req.headers['x-forwarded-for'])) || req.socket.remoteAddress || 'unknown'));
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(url, { method: req.method, headers, body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined, duplex: 'half' } as RequestInit);
      const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch((err: Error) => log(err.message)), passThroughOnException() {}, props: {} };
      const response = await worker.fetch(request, e as never, ctx as never);
      res.statusCode = response.status;
      response.headers.forEach((v, k) => k !== 'set-cookie' && res.setHeader(k, v));
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader('set-cookie', cookies);
      if (response.body) Readable.fromWeb(response.body as never).pipe(res);
      else res.end();
    } catch (err) {
      log((err as Error).stack ?? err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    }
  });

  server.listen(port, host, () => log(`listening on ${host}:${port}; MCP endpoint ${publicUrl ?? `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`}/mcp`));
  startCron(e, kv);
  const stop = () => server.close(() => (kv.close(), process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

async function stdio() {
  const { e, kv } = loadEnv();
  await createMcpServer().connect(new StdioServerTransport());
  startCron(e, kv); // scheduled mail and rules run only while the client keeps this process alive
  log('stdio server ready');
}

const cmd = process.argv[2] ?? 'serve';
if (cmd === 'serve') await serve();
else if (cmd === 'stdio') await stdio();
else {
  process.stdout.write(HELP);
  process.exit(cmd === 'help' || cmd === '--help' || cmd === '-h' ? 0 : 2);
}
