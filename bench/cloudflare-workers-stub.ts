// Node stand-in for `cloudflare:workers`: env comes from .dev.vars.
import { readFileSync } from 'node:fs';
export const env = Object.fromEntries(
  readFileSync(`${import.meta.dirname}/../.dev.vars`, 'utf8')
    .split('\n')
    .filter((l) => /^\w+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
