// Bundles the self-hosted runtime (src/node/cli.ts) into one file: dist/nmail-mcp.mjs (Node 22.13+, no node_modules needed).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/node/cli.ts'],
  outfile: 'dist/nmail-mcp.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  alias: { 'cloudflare:workers': './src/node/cf-shim.ts' },
  // Some dependencies are CommonJS and call require(); give the ESM bundle one.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('built dist/nmail-mcp.mjs');
