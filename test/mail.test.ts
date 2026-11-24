import { Buffer } from 'node:buffer';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { expect, test, vi } from 'vitest';
import type { FetchQuery, ImapClient } from '../src/imap';
import { AttachmentTooLargeError, fetchAttachmentBytes, parseMail, readEmail } from '../src/read';
import { compose } from '../src/send';
import { htmlToText } from '../src/mime';
import { smtpSend } from '../src/smtp';
import type { Env } from '../src/auth';
import { attachmentDownloadLimit, attachmentLimitNotice, attachmentLink, attachmentMessageKey, attachmentResponse, downloadAttachment } from '../src/download';

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

test('readEmail pages text and extracts links only on request', async () => {
  const text = 'a'.repeat(3999) + '😀 end';
  const link = 'https://example.com/details';
  const unsubscribe = 'https://example.com/unsubscribe';
  const fetchOne = vi.fn(async (_uid: string, query: FetchQuery) => query.bodyParts ? {
    bodyParts: new Map([['1', Buffer.from(text)], ['2', Buffer.from(`<a href="${link}">Details</a>`)]])
  } : {
    bodyStructure: { type: 'multipart/alternative', childNodes: [{ type: 'text/plain', part: '1' }, { type: 'text/html', part: '2' }] },
    headers: Buffer.from(`List-Unsubscribe: <${unsubscribe}>\r\n`),
  });
  const client = { mailboxOpen: vi.fn(), fetchOne } as unknown as ImapClient;

  const first = await readEmail(client, 'INBOX', 1);
  expect(first).toMatchObject({ text: text.slice(0, 3999), nextOffset: 3999 });
  expect(first).not.toHaveProperty('links');
  expect(first).not.toHaveProperty('listUnsubscribe');
  expect(fetchOne.mock.calls[1][1].bodyParts).toEqual([{ key: '1', maxLength: 256 * 1024 }]);

  const second = await readEmail(client, 'INBOX', 1, { offset: 3999, includeLinks: true });
  expect(second).toMatchObject({ text: '😀 end', links: [link], listUnsubscribe: { targets: [unsubscribe] } });
  expect(second).not.toHaveProperty('nextOffset');
});

test('attachment links expire and are bound to the server origin', async () => {
  const put = vi.fn();
  const get = vi.fn();
  const runtime = { ...env, OAUTH_KV: { put, get } } as unknown as Env;
  const client = { fetchOne: vi.fn().mockResolvedValue({ headers: Buffer.from('Message-ID: <one@example.com>\r\n') }) } as unknown as ImapClient;
  expect(await attachmentMessageKey(client, 1, 2)).toBe('uidvalidity:2');
  const messageKey = await attachmentMessageKey(client, 1, 0);
  expect(messageKey).toMatch(/^headers:[a-f0-9]{64}$/);
  const { downloadUrl } = await attachmentLink(runtime, 'https://mail.example.com', { folder: 'INBOX', uid: 1, index: 0, messageKey });
  const [key, value, options] = put.mock.calls[0];
  expect(options.expirationTtl).toBe(300);
  expect(key).toBe(`app:download:${new URL(downloadUrl).pathname.split('/').at(-1)}`);
  expect(JSON.parse(value)).toEqual({ folder: 'INBOX', uid: 1, index: 0, messageKey, origin: 'https://mail.example.com', user: 'me' });
  expect((await downloadAttachment(new Request(downloadUrl), runtime)).status).toBe(404);
  get.mockResolvedValue(JSON.parse(value));
  expect((await downloadAttachment(new Request(downloadUrl.replace('mail.example.com', 'other.example.com')), runtime)).status).toBe(404);
});

test('browser previews use known image and PDF signatures and render text safely', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const preview = attachmentResponse(png, '포스터.png', 'application/octet-stream', true);
  expect(preview.headers.get('content-type')).toBe('image/png');
  expect(preview.headers.get('content-disposition')).toMatch(/^inline;/);
  expect(attachmentResponse(png, 'poster.png', 'image/png', false).headers.get('content-disposition')).toMatch(/^attachment;/);
  const pdf = attachmentResponse(Buffer.from('%PDF-1.7'), 'document.pdf', 'application/octet-stream', true);
  expect(pdf.headers.get('content-type')).toBe('application/pdf');
  expect(pdf.headers.get('content-disposition')).toMatch(/^inline;/);
  const html = attachmentResponse(Buffer.from('<html>'), 'example.html', 'text/html', true);
  expect(html.headers.get('content-type')).toBe('text/plain');
  expect(html.headers.get('x-content-type-options')).toBe('nosniff');
  const spoof = attachmentResponse(Buffer.from('<html>'), 'poster.png', 'image/png', true);
  expect(spoof.headers.get('content-type')).toBe('application/octet-stream');
  expect(spoof.headers.get('content-disposition')).toMatch(/^attachment;/);
});

test('attachment downloads cap decoded bytes and give a direct-download message', async () => {
  const fetchOne = vi.fn().mockResolvedValue({ bodyParts: new Map([['1', Buffer.from('YWJjZGU=')]]) });
  const client = { fetchOne } as unknown as ImapClient;
  const node = { type: 'application/octet-stream', encoding: 'base64' };
  expect((await fetchAttachmentBytes(client, 1, node, 5)).toString()).toBe('abcde');
  await expect(fetchAttachmentBytes(client, 1, node, 4)).rejects.toBeInstanceOf(AttachmentTooLargeError);
  const limit = attachmentDownloadLimit({ ATTACHMENT_DOWNLOAD_MAX_BYTES: 100_000_000 } as Env);
  expect(limit).toBe(100_000_000);
  expect(attachmentLimitNotice(limit)).toContain('100MB 제한을 넘습니다. 네이버 메일에서 직접 내려받으세요.');
});
