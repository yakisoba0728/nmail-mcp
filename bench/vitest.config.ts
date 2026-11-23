import { defineConfig } from 'vitest/config';
// CPU per tool call, measured in Node (same V8 as workerd). Run: npm run bench [-- -t <filter>]
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': `${import.meta.dirname}/cloudflare-workers-stub.ts` } },
  test: {
    include: ['bench/**/*.bench.test.ts'],
    testTimeout: 900_000,
    pool: 'forks',
    // PROF=<dir> writes a V8 CPU profile of the test process
    execArgv: process.env.PROF ? ['--cpu-prof', `--cpu-prof-dir=${process.env.PROF}`] : [],
  },
});
