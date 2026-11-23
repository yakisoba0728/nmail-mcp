import { Buffer } from 'node:buffer';
import { expect, test } from 'vitest';
import { decodePart, parseIcs, textPart } from '../src/mime';
import { mergeCriteria, parseQuery } from '../src/search';

test('parseQuery maps Gmail operators and reports unsupported ones', () => {
  const now = new Date('2026-11-23T12:00:00+09:00');
  const { criteria: c, warnings } = parseQuery('결제 "카드 승인" -광고 from:shop@x.com -from:spam subject:영수증 newer_than:7d before:2026/11/30 is:unread is:starred has:attachment filename:pdf larger:2M in:sent OR category:promo', now);
  expect(c.keywords).toEqual(['결제', '카드 승인']);
  expect(c.exclude).toEqual(['광고']);
  expect(c.from).toEqual(['shop@x.com']);
  expect(c.notFrom).toEqual(['spam']);
  expect(c.subject).toEqual(['영수증']);
  expect(c.since?.toISOString()).toBe('2026-11-16T03:00:00.000Z');
  expect(c.before?.toISOString()).toBe('2026-11-29T15:00:00.000Z'); // 2026-11-30 00:00 KST
  expect([c.unread, c.flagged, c.hasAttachment]).toEqual([true, true, true]);
  expect(c.filename).toEqual(['pdf']);
  expect(c.larger).toBe(2 * 1024 * 1024);
  expect(c.folders).toEqual(['sent']);
  expect(warnings).toHaveLength(2); // OR, category:
});

test('parseQuery negations and merge', () => {
  const { criteria } = parseQuery('-has:attachment -is:unread in:anywhere');
  expect([criteria.hasAttachment, criteria.unread, criteria.anywhere]).toEqual([false, false, true]);
  const m = mergeCriteria(criteria, { from: ['a@b.c'], unread: true, to: undefined });
  expect(m.from).toEqual(['a@b.c']);
  expect(m.unread).toBe(true);
  expect(m.to).toEqual([]);
});

test('decodePart handles truncated base64, quoted-printable and euc-kr', () => {
  const full = Buffer.from('안녕하세요 반갑습니다', 'utf8').toString('base64');
  expect(decodePart(Buffer.from(full.slice(0, 17) + '\r\n'), { type: 'text/plain', encoding: 'base64', parameters: { charset: 'utf-8' } } as never)).toBe('안녕하세');
  expect(decodePart(Buffer.from('a=3D1 =EC=95=88=\r\n=EB=85=95'), { type: 'text/plain', encoding: 'quoted-printable', parameters: { charset: 'UTF-8' } } as never)).toBe('a=1 안녕');
  expect(decodePart(Buffer.from([0xbe, 0xc8, 0xb3, 0xe7]), { type: 'text/plain', encoding: '8bit', parameters: { charset: 'cp949' } } as never)).toBe('안녕');
  expect(decodePart(Buffer.from('<p>Hi&amp;<!-- x --></p>'), { type: 'text/html', encoding: '7bit' } as never)).toBe('Hi&');
});

test('textPart prefers text/plain over html and skips attachments', () => {
  const tree = { type: 'multipart/mixed', childNodes: [{ type: 'text/plain', part: '1', disposition: 'attachment', dispositionParameters: { filename: 'a.txt' } }, { type: 'multipart/alternative', childNodes: [{ type: 'text/html', part: '2.2' }, { type: 'text/plain', part: '2.1' }] }] };
  expect(textPart(tree as never)?.part).toBe('2.1');
});

test('parseIcs reads folded VEVENT fields', () => {
  const ics = 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:abc\r\nSUMMARY:주간 회의\\, 3층\r\nDTSTART;TZID=Asia/Seoul:20261201T100000\r\nDTEND;TZID=Asia/Seoul:20261201T110000\r\nORGANIZER;CN=Kim:mailto:kim@example.com\r\nDESCRIPTION:line1\\nline\r\n 2\r\nEND:VEVENT\r\nEND:VCALENDAR';
  expect(parseIcs(ics)[0]).toMatchObject({ method: 'REQUEST', uid: 'abc', summary: '주간 회의, 3층', start: ';TZID=Asia/Seoul:20261201T100000', organizer: 'kim@example.com', description: 'line1\nline2' });
});

import { autoReplyTarget, parseWhen } from '../src/automation';

test('parseWhen: naive times are KST, offsets honoured', () => {
  expect(parseWhen('2026-11-25 09:00').toISOString()).toBe('2026-11-25T00:00:00.000Z');
  expect(parseWhen('2026-11-25').toISOString()).toBe('2026-11-24T15:00:00.000Z');
  expect(parseWhen('2026-11-25T09:00:00Z').toISOString()).toBe('2026-11-25T09:00:00.000Z');
  expect(parseWhen('2026-11-25T09:00+01:00').toISOString()).toBe('2026-11-25T08:00:00.000Z');
  expect(() => parseWhen('next tuesday')).toThrow();
});

test('autoReplyTarget follows RFC 3834 and never answers yourself', () => {
  const me = 'me@naver.com';
  expect(autoReplyTarget('Friend@Example.com', {}, me)).toBe('friend@example.com');
  expect(autoReplyTarget('me@naver.com', {}, me)).toBeUndefined();
  expect(autoReplyTarget('noreply@shop.com', {}, me)).toBeUndefined();
  expect(autoReplyTarget('mailer-daemon@x.com', {}, me)).toBeUndefined();
  expect(autoReplyTarget('a@b.com', { 'auto-submitted': 'auto-replied' }, me)).toBeUndefined();
  expect(autoReplyTarget('a@b.com', { 'auto-submitted': 'no' }, me)).toBe('a@b.com');
  expect(autoReplyTarget('a@b.com', { precedence: 'bulk' }, me)).toBeUndefined();
  expect(autoReplyTarget('a@b.com', { 'list-unsubscribe': '<mailto:x>' }, me)).toBeUndefined();
  expect(autoReplyTarget('a@b.com', { 'return-path': '<>' }, me)).toBeUndefined();
});
