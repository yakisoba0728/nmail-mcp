import { Buffer } from 'node:buffer';
import { expect, test } from 'vitest';
import { bodyStructure, decodeMailbox, encodeMailbox, tokenize } from '../src/imap';
import { decodeWords } from '../src/mime';

// Responses captured from imap.naver.com

test('tokenize FETCH with ENVELOPE, quoted escapes, NIL and literals', () => {
  const line = '821 FETCH (UID 1464 FLAGS (\\Seen \\Flagged) RFC822.SIZE 19662 ENVELOPE ("Mon, 23 Nov 2026 23:18:23 +0900" "a \\"q\\" b" (("=?utf-8?B?64Sk7J2067KE?=" NIL "account_noreply" "navercorp.com")) NIL NIL NIL NIL NIL NIL "<id@x>") BODY[HEADER.FIELDS (FROM SUBJECT)] {5}';
  const t = tokenize([line, Buffer.from('ab\r\nc'), ' BODY[1]<0> {2}', Buffer.from('hi'), ')']);
  expect(t[0]).toBe('821');
  const l = t[2] as unknown[];
  expect(l.slice(0, 2)).toEqual(['UID', '1464']);
  expect(l[3]).toEqual(['\\Seen', '\\Flagged']);
  const env = l[7] as unknown[];
  expect(env[1]).toBe('a "q" b');
  expect(env[3]).toBeNull();
  expect(l[8]).toBe('BODY[HEADER.FIELDS (FROM SUBJECT)]');
  expect((l[9] as Buffer).toString()).toBe('ab\r\nc');
  expect(l[10]).toBe('BODY[1]<0>');
  expect((l[11] as Buffer).toString()).toBe('hi');
});

test('bodyStructure: single part, multipart with RFC 2231 and RFC 2047 names', () => {
  const single = tokenize(['("text" "html" ("charset" "utf-8") NIL NIL "quoted-printable" 39082 513 NIL NIL NIL NIL)'])[0];
  expect(bodyStructure(single)).toMatchObject({ part: undefined, type: 'text/html', parameters: { charset: 'utf-8' }, encoding: 'quoted-printable', size: 39082 });
  const multi = tokenize([
    '(("text" "plain" ("charset" "utf-8") NIL NIL "base64" 100 2 NIL NIL NIL NIL)' +
      '("application" "pdf" ("name" "=?utf-8?B?7JiB7IiY7KadLnBkZg==?=") NIL NIL "base64" 5000 NIL ("attachment" ("filename*" "UTF-8\'\'%EC%98%81%EC%88%98%EC%A6%9D.pdf")) NIL NIL)' +
      '("image" "png" NIL "<img1>" NIL "base64" 300 NIL ("inline" ("filename*0" "a" "filename*1" "b.png")) NIL NIL) "mixed" ("boundary" "x") NIL NIL NIL)',
  ])[0];
  const s = bodyStructure(multi);
  expect(s.type).toBe('multipart/mixed');
  expect(s.childNodes!.map((c) => c.part)).toEqual(['1', '2', '3']);
  expect(s.childNodes![1]).toMatchObject({ type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: '영수증.pdf' }, parameters: { name: '영수증.pdf' } });
  expect(s.childNodes![2]).toMatchObject({ id: '<img1>', disposition: 'inline', dispositionParameters: { filename: 'ab.png' } });
});

test('modified UTF-7 mailbox names round-trip (Naver folders)', () => {
  expect(decodeMailbox('&sLSsjMT0ulTHfNVo-')).toBe('내게쓴메일함');
  expect(decodeMailbox('&zK2tbAC3rLDIHA-')).toBe('청구·결제');
  for (const n of ['내게쓴메일함', '청구·결제', 'A&B', 'MCP-E2E-x-폴더2', 'Projects/알파']) expect(decodeMailbox(encodeMailbox(n))).toBe(n);
  expect(encodeMailbox('A&B')).toBe('A&-B');
});

test('decodeWords joins adjacent words and keeps split multi-byte chars', () => {
  expect(decodeWords('=?utf-8?B?64Sk7J2067KE?=')).toBe('네이버');
  const bytes = Buffer.from('안녕하세요', 'utf8');
  const a = bytes.subarray(0, 4).toString('base64');
  const b = bytes.subarray(4).toString('base64');
  expect(decodeWords(`=?UTF-8?B?${a}?= \r\n =?UTF-8?B?${b}?=`)).toBe('안녕하세요');
  expect(decodeWords('Re: =?euc-kr?Q?=BE=C8=B3=E7?= world')).toBe('Re: 안녕 world');
  expect(decodeWords('plain')).toBe('plain');
});

import { fetchResult, searchParts } from '../src/imap';

test('fetchResult parses INTERNALDATE, flags, size and sections', () => {
  const t = tokenize(['820 FETCH (UID 1454 FLAGS (\\Seen) RFC822.SIZE 45989 INTERNALDATE "20-Nov-2026 23:37:42 +0900" BODY[1.2]<0> {3}', Buffer.from('abc'), ')']);
  const m = fetchResult(Number(t[0]), t[2]);
  expect(m.uid).toBe(1454);
  expect(m.internalDate?.toISOString()).toBe('2026-11-20T14:37:42.000Z');
  expect([...m.flags!]).toEqual(['\\Seen']);
  expect(m.size).toBe(45989);
  expect(m.bodyParts?.get('1.2')?.toString()).toBe('abc');
});

test('searchParts builds valid IMAP SEARCH keys (KST dates, literals, NOT/OR)', () => {
  const p = searchParts({
    since: new Date('2026-11-16T00:00:00+09:00'),
    before: new Date('2026-11-30T00:00:00+09:00'),
    seen: false,
    from: 'a@b.com',
    subject: '결제',
    not: { or: [{ subject: '광고' }, { from: '광고' }] },
    header: { 'message-id': '<x@y>' },
  });
  const flat = p.map((x) => (typeof x === 'string' ? x : `{${x.toString()}}`));
  expect(flat).toEqual(['UNSEEN', 'FROM', '"a@b.com"', 'SUBJECT', '{결제}', 'SINCE', '16-Nov-2026', 'BEFORE', '30-Nov-2026', 'HEADER', '"message-id"', '"<x@y>"', 'NOT', '(', 'OR', '(', 'SUBJECT', '{광고}', ')', '(', 'FROM', '{광고}', ')', ')']);
  expect(searchParts({})).toEqual(['ALL']);
  // quotes and backslashes never go inside a quoted string
  expect(typeof searchParts({ subject: 'a"b' })[1]).not.toBe('string');
});
