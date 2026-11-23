import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import { authorize, type Env } from './auth';
import { runCron } from './automation';
import { createServer } from './tools';

const mcp = createMcpHandler(createServer);

// Tokens are bound to the URL clients connect to, so build one provider per origin (workers.dev or a custom domain).
const providers = new Map<string, OAuthProvider<Env>>();

export default {
  fetch(req: Request, e: Env, ctx: ExecutionContext) {
    const origin = new URL(req.url).origin;
    let p = providers.get(origin);
    if (!p) {
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
      providers.set(origin, p);
    }
    return p.fetch(req, e, ctx);
  },
  // "* * * * *" sends due scheduled mail; "*/5 * * * *" runs rules and the vacation responder.
  scheduled(controller: ScheduledController, e: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(e, controller.cron));
  },
};
