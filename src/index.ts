import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import { authorize, type Env } from './auth';
import { runCron } from './automation';
import { createServer } from './tools';

// Tokens are bound to the URL clients connect to, so build one provider per origin (workers.dev, a custom domain,
// or a self-hosted server). The MCP handler's Host/Origin check only knows localhost and workers.dev by default, so it
// is told about the origin it serves; every /mcp request is already authenticated by the OAuth provider in front of it.
const providers = new Map<string, OAuthProvider<Env>>();
// Only routed hostnames reach a Worker and the Node server pins its origin, so few origins exist; the cap is a backstop.
const MAX_ORIGINS = 8;

export default {
  fetch(req: Request, e: Env, ctx: ExecutionContext) {
    const origin = new URL(req.url).origin;
    let p = providers.get(origin);
    if (!p) {
      const host = new URL(origin).hostname;
      const mcp = createMcpHandler(() => createServer(origin), { allowedHostnames: [host], allowedOriginHostnames: [host] });
      p = new OAuthProvider<Env>({
        apiRoute: '/mcp',
        apiHandler: { fetch: (r: Request, en: Env, c: ExecutionContext) => mcp(r, en, c) } as never,
        defaultHandler: { fetch: (r: Request, en: Env) => authorize(r, en) } as never,
        authorizeEndpoint: '/authorize',
        tokenEndpoint: '/oauth/token',
        clientRegistrationEndpoint: '/oauth/register',
        clientIdMetadataDocumentEnabled: true,
        resourceMetadata: { resource: `${origin}/mcp` },
      });
      if (providers.size >= MAX_ORIGINS) providers.delete(providers.keys().next().value!);
      providers.set(origin, p);
    }
    // The library caches its helpers on env (`env.OAUTH_PROVIDER ??= …`) the first time; a shared env would then
    // serve every origin with the first origin's provider. Give each request its own shallow copy.
    return p.fetch(req, { ...e, OAUTH_PROVIDER: undefined } as unknown as Env, ctx);
  },
  // "* * * * *" sends due scheduled mail; "*/5 * * * *" runs rules and the vacation responder.
  scheduled(controller: ScheduledController, e: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(e, controller.cron));
  },
};
