// Each tool call goes through the real MCP handler (zod validation, JSON output), repeated.
// Noise (GC threads, other processes) only adds CPU, so the minimum over runs is the best estimate.
// Node's TLS (secure-context setup ~3 ms per connection, stream wrappers) is included; workerd does it natively.
import { writeFileSync } from 'node:fs';
import { createMcpHandler } from 'agents/mcp/server';
import { test } from 'vitest';
import { createServer } from '../src/tools';

// Scenarios that need a message use the newest one in the inbox (`uid: NEWEST`), so this runs on any account.
const NEWEST = -1;
const SCENARIOS: [string, string, Record<string, unknown>, number?][] = [
  ['tools/list', '', {}],
  ['get_profile', 'get_profile', {}],
  ['list_folders', 'list_folders', {}],
  ['search inbox 10 + snippets', 'search_emails', { folders: ['inbox'], limit: 10, snippets: true }],
  ['search inbox 10, no snippets', 'search_emails', { folders: ['inbox'], limit: 10, snippets: false }],
  ['search all folders 10', 'search_emails', { limit: 10, snippets: false }],
  ['search subject (all folders)', 'search_emails', { query: 'subject:메일', limit: 10, snippets: false }],
  ['search keyword (body scan)', 'search_emails', { query: '메일', folders: ['inbox'], limit: 10, snippets: false }, 3],
  ['read_email (newest)', 'read_email', { folder: 'inbox', uid: NEWEST }],
  ['get_thread (newest)', 'get_thread', { folder: 'inbox', uid: NEWEST }, 3],
  ['list_drafts', 'list_drafts', {}],
  ['sender_stats inbox', 'sender_stats', { folders: ['inbox'] }, 3],
];

test('cpu', async () => {
  const mcp = createMcpHandler(() => createServer());
  const rpc = async (method: string, params?: object) => {
    const r = await mcp(new Request('http://localhost/mcp', { method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), {}, {} as never);
    const body = await r.text();
    const msg = JSON.parse(body.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? body);
    if (msg.error || msg.result?.isError) throw new Error(`${method}: ${JSON.stringify(msg.error ?? msg.result.content)}`.slice(0, 300));
    return msg.result;
  };
  const latest = await rpc('tools/call', { name: 'search_emails', arguments: { folders: ['inbox'], limit: 1 } });
  const newest: number = JSON.parse(latest.content[0].text).messages[0]?.uid;
  if (!newest) throw new Error('The inbox is empty; the read/thread scenarios need one message.');
  const filter = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
  const f = (n: number) => n.toFixed(1).padStart(7);
  const out: string[] = ['  first     min  median  runs  scenario   (ms CPU, Node; first = cold path in this process)'];
  for (const [name, tool, args, runs = 7] of SCENARIOS) {
    if (filter && !filter.test(name)) continue;
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const s = process.cpuUsage();
      const a = args.uid === NEWEST ? { ...args, uid: newest } : args;
      await (tool ? rpc('tools/call', { name: tool, arguments: a }) : rpc('tools/list'));
      const d = process.cpuUsage(s);
      times.push((d.user + d.system) / 1000);
    }
    const sorted = [...times].sort((a, b) => a - b);
    out.push(`${f(times[0])} ${f(sorted[0])} ${f(sorted[Math.floor(sorted.length / 2)])} ${String(runs).padStart(5)}  ${name}`);
  }
  writeFileSync(`${import.meta.dirname}/last-run.txt`, out.join('\n') + '\n');
});
