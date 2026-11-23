import { defineConfig } from 'vitest/config';
// Unit tests only; the live CPU bench has its own config (bench/vitest.config.ts).
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
