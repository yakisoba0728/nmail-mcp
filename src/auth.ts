import { AuthorizationError, type ConsentDescription, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import * as mail from './mail';

export interface Env extends mail.MailEnv {
  OAUTH_KV: KVNamespace;
  LOGIN_LIMITER: RateLimit;
  OAUTH_PROVIDER: OAuthHelpers;
}

// OAuth login for a single owner: the password is the Naver app password stored as a Worker secret.
const esc = (s = '') => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const KNOWN = /(^|\.)(chatgpt\.com|openai\.com|claude\.ai|claude\.com)$/;

function loginPage(d: ConsentDescription, handle: string, error?: string) {
  const warn = !d.redirectIsLoopback && !KNOWN.test(d.redirectHost)
    ? `<p class="err"><b>주의:</b> 권한이 <code>${esc(d.redirectHost)}</code>(으)로 전달됩니다. 직접 연결을 시작한 게 아니라면 거부하세요.</p>`
    : '';
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>네이버 메일 연결</title>
<style>:root{color-scheme:light dark}body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.6}
input{width:100%;box-sizing:border-box;padding:.6rem;font-size:1rem}button{padding:.6rem 1rem;font-size:1rem;margin-right:.5rem}.err{color:#d33}.m{opacity:.7;font-size:.9rem}</style>
<h1>${esc(d.clientName)}에 네이버 메일을 연결할까요?</h1>
<p class="m">권한이 전달될 곳: <b>${esc(d.redirectHost)}</b><br>연결하면 메일 읽기·보내기·삭제를 할 수 있습니다.</p>${warn}
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<label for="p">네이버 애플리케이션 비밀번호</label><input id="p" name="password" type="password" autocomplete="current-password" required autofocus>
<p><button name="decision" value="approve">연결</button><button name="decision" value="deny" formnovalidate>거부</button></p></form></html>`;
}

async function safeEqual(a: string, b: string) {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
  return crypto.subtle.timingSafeEqual(x, y);
}

const text = (body: string, status: number) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

export async function authorize(req: Request, e: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/') return text('nmail-mcp: MCP endpoint is /mcp', 200);
  if (url.pathname !== '/authorize') return text('Not Found', 404);
  // Fail closed: without the secrets there is nothing to check the password against.
  if (!e.NAVER_ID || !e.NAVER_APP_PASSWORD) return text('Server is not configured: set NAVER_ID and NAVER_APP_PASSWORD secrets.', 503);
  const oauth = e.OAUTH_PROVIDER;
  try {
    const authRequest = await oauth.parseAuthRequest(req);
    const details = await oauth.describeConsent(authRequest);
    const html = (body: string, headers: Headers, status = 200) => (headers.set('Content-Type', 'text/html; charset=utf-8'), new Response(body, { status, headers }));
    if (req.method === 'GET') {
      const consent = await oauth.beginConsent(authRequest);
      return html(loginPage(details, consent.handle), consent.headers);
    }
    if (req.method !== 'POST') return text('Method Not Allowed', 405);
    const form = await req.formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') return new Response(null, { status: 302, headers: (await oauth.denyConsent(req, handle)).headers });
    const ip = req.headers.get('cf-connecting-ip') ?? 'local';
    if (!(await e.LOGIN_LIMITER.limit({ key: ip })).success) return html(loginPage(details, handle, '시도가 너무 많습니다. 1분 뒤에 다시 시도하세요.'), new Headers(), 429);
    if (!(await safeEqual(String(form.get('password') ?? '').replace(/\s+/g, ''), mail.account(e).pass)))
      return html(loginPage(details, handle, '비밀번호가 맞지 않습니다.'), new Headers(), 401);
    const approved = await oauth.approveConsent(req, handle);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: mail.account(e).login,
      metadata: {},
      scope: approved.request.scope,
      props: { user: mail.account(e).login },
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectTo) return Response.redirect(err.redirectTo, 302);
    if (err instanceof AuthorizationError) return text(err.description ?? 'Invalid authorization request', 400);
    throw err;
  }
}
