// Stand-in for the `cloudflare:workers` module when running on Node (aliased at build time).
// `env` is filled by the Node runtime before the first request; tools read it lazily.
export const env: Record<string, unknown> = {};

/** Only used by the OAuth library for an `instanceof` check. */
export class WorkerEntrypoint {}

// On Node the OAuth library keeps CIMD (fetching URL-style client ids) off: there is no equivalent of the Workers
// global_fetch_strictly_public guard against fetching private addresses, so that stays off on purpose (clients fall
// back to dynamic registration). Its startup hint about wrangler.jsonc does not apply here; this module is evaluated
// before the library, so drop just that line.
const warn = console.warn.bind(console);
console.warn = (...a: unknown[]) => {
  if (typeof a[0] === 'string' && a[0].startsWith('CIMD (Client ID Metadata Document) is disabled')) return;
  warn(...a);
};
