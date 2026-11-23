// CPU of building outgoing messages (no network): the write side of send_email / schedule_email.
import { writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { compose } from '../src/send';

test('compose cpu', async () => {
  const env = { NAVER_ID: 'me', NAVER_APP_PASSWORD: 'x' };
  const out = ['    min  scenario   (ms CPU, Node)'];
  for (const [name, size] of [['text only', 0], ['100 KB attachment', 100 << 10], ['1 MB attachment', 1 << 20], ['5 MB attachment', 5 << 20]] as const) {
    const att = size ? [{ filename: 'x.bin', contentBase64: Buffer.alloc(size, 7).toString('base64') }] : undefined;
    const t: number[] = [];
    for (let i = 0; i < 5; i++) {
      const s = process.cpuUsage();
      await compose(env, { to: ['a@b.c'], subject: '제목', text: '본문', attachments: att });
      const d = process.cpuUsage(s);
      t.push((d.user + d.system) / 1000);
    }
    out.push(`${Math.min(...t).toFixed(1).padStart(7)}  compose, ${name}`);
  }
  writeFileSync(`${import.meta.dirname}/last-compose.txt`, out.join('\n') + '\n');
});
