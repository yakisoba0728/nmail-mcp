// Starts `nmail-mcp stdio` the way a local MCP client does and runs initialize → tools/list → list_folders.
// Usage: npm run build && node test/stdio.mjs   (uses .dev.vars)
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const child = spawn(process.execPath, ['--env-file=.dev.vars', 'dist/nmail-mcp.mjs', 'stdio'], {
  env: { ...process.env, DATA_DIR: mkdtempSync(join(tmpdir(), 'nmail-stdio-')) },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const pending = new Map();
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0; ) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line); // anything that is not JSON-RPC on stdout would throw here
    pending.get(msg.id)?.(msg);
  }
});
let id = 0;
const rpc = (method, params) =>
  new Promise((resolve) => {
    pending.set(++id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params && { params }) }) + '\n');
  });

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-check', version: '1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const tools = await rpc('tools/list');
const folders = await rpc('tools/call', { name: 'list_folders', arguments: {} });
const ok = init.result?.serverInfo?.name === "nmail-mcp" && tools.result?.tools.length >= 28 && /INBOX/.test(folders.result?.content?.[0]?.text ?? '');
console.log(`server ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}, ${tools.result?.tools.length} tools, list_folders ${folders.result?.isError ? 'error' : 'ok'}`);
console.log(ok ? 'stdio check passed' : 'stdio check FAILED');
child.stdin.end();
child.on('exit', (code) => process.exit(ok ? 0 : 1));
