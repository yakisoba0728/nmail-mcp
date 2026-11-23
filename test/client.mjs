// Shared by e2e.mjs and bench/workerd-cpu.mjs: OAuth login against the local server and MCP tool calls.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const BASE = process.env.BASE ?? 'http://localhost:8787';
export const vars = Object.fromEntries(
  readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => /^\w+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
export const ME = vars.NAVER_ID.replace(/@naver\.com$/i, '') + '@naver.com';

const b64url = (b) => b.toString('base64url');
let clientId;
async function login() {
  const redirect = 'http://localhost:9999/cb';
  const reg = await (await fetch(`${BASE}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none', client_name: 'e2e' }) })).json();
  const verifier = b64url(randomBytes(32));
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state: 's', resource: `${BASE}/mcp` });
  const page = await fetch(`${BASE}/authorize?${q}`);
  const cookie = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)[1];
  const post = await fetch(`${BASE}/authorize?${q}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle, password: vars.NAVER_APP_PASSWORD, decision: 'approve' }) });
  const code = new URL(post.headers.get('location')).searchParams.get('code');
  clientId = reg.client_id;
  return (await (await fetch(`${BASE}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }) })).json());
}

let TOKEN;
export const setToken = (t) => (TOKEN = t);
/** Every login counts against the 5/min password limit, so one token is cached across runs. */
export async function connect({ fresh = false } = {}) {
  const cache = new URL('../.wrangler/e2e-token', import.meta.url);
  TOKEN = !fresh && existsSync(cache) ? readFileSync(cache, 'utf8') : '';
  const probe = TOKEN && (await rpc('tools/list').catch(() => null));
  if (!probe) {
    const t = await login();
    writeFileSync(cache, (TOKEN = t.access_token));
    return { ...t, client_id: t.client_id ?? clientId };
  }
}

let id = 0;
export async function rpc(method, params, token = TOKEN) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params && { params }) }),
  });
  if (r.status === 401) throw new Error('401');
  const body = await r.text();
  const msg = JSON.parse(body.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? body);
  if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
  return msg.result;
}

/** Calls a tool; returns parsed JSON of the first text block (or the raw result with raw=true). */
export async function call(name, args = {}, raw = false) {
  const result = await rpc('tools/call', { name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
  if (raw) return result;
  const t = result.content.find((c) => c.type === 'text')?.text;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1] && process.argv[2] === 'call') {
  // node test/client.mjs call <tool> '<json args>'
  await connect();
  console.log(JSON.stringify(await call(process.argv[3], JSON.parse(process.argv[4] ?? '{}'), true), null, 2));
}
