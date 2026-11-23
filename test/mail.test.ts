import { Buffer } from 'node:buffer';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { expect, test } from 'vitest';
import { parseMail } from '../src/read';
import { compose } from '../src/send';
import { htmlToText } from '../src/mime';
import { smtpSend } from '../src/smtp';

const env = { NAVER_ID: 'me@naver.com', NAVER_APP_PASSWORD: 'ABCD EFGH', NAVER_NAME: '홍길동' };

test('smtpSend: auth, envelope with bcc, dot-stuffing, no Bcc header', async () => {
  let got: Record<string, any> = {};
  const server = new SMTPServer({
    secure: true, // smtp-server's built-in self-signed cert
    authMethods: ['PLAIN'],
    onAuth: (a, _s, cb) => ((got.user = a.username), (got.pass = a.password), cb(null, { user: a.username })),
    onData: (stream, s, cb) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        got = { ...got, from: s.envelope.mailFrom && s.envelope.mailFrom.address, to: s.envelope.rcptTo.map((r) => r.address), data: Buffer.concat(chunks).toString() };
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.server.address() as AddressInfo;
  try {
    const msg = await compose(env, { to: ['a@example.com'], bcc: ['hidden@example.com'], subject: '안녕하세요', text: 'line1\n.starts with dot\nend' });
    await smtpSend({ host: '127.0.0.1', port, user: 'me', pass: 'ABCDEFGH', tls: { rejectUnauthorized: false } }, msg.from, msg.to, msg.raw);
  } finally {
    server.close();
  }
  expect(got.user).toBe('me');
  expect(got.pass).toBe('ABCDEFGH');
  expect(got.from).toBe('me@naver.com');
  expect(got.to).toEqual(['a@example.com', 'hidden@example.com']);
  expect(got.data).not.toMatch(/^bcc:/im);
  const parsed = await parseMail(Buffer.from(got.data!));
  expect(parsed.subject).toBe('안녕하세요');
  expect(parsed.from?.name).toBe('홍길동');
  expect(parsed.text?.trim()).toBe('line1\n.starts with dot\nend');
});

test('parseMail decodes cp949-labelled Korean mail', async () => {
  const euckr = Buffer.from([0xbe, 0xc8, 0xb3, 0xe7]); // "안녕" in EUC-KR
  const raw = Buffer.concat([
    Buffer.from('Subject: =?cp949?B?' + euckr.toString('base64') + '?=\r\nContent-Type: text/plain; charset=cp949\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'),
    euckr,
  ]);
  const m = await parseMail(raw);
  expect(m.subject).toBe('안녕');
  expect(m.text?.trim()).toBe('안녕');
});

test('htmlToText', () => {
  expect(htmlToText('<!--[if mso]><table><![endif]--><style>x{}</style><p>a&amp;b</p><br>c')).toBe('a&b\n\nc');
});
