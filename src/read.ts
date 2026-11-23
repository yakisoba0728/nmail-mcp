import { Buffer } from 'node:buffer';
import PostalMime, { type Email } from 'postal-mime';
import type { ImapClient, MessageStructureObject } from './imap';
import { MAX_ATTACHMENT_BYTES, MAX_MESSAGE_BYTES, resolveFolder } from './mail';
import { attachmentNodes, bodyParts, clip, decodeBytes, decodedSize, decodePart, decodeTransfer, fmt, headerLines, headerMap, htmlToText, leafName, noComments, parseIcs, section } from './mime';

/** Full parse, for the few paths that rebuild a message (reply, forward, drafts, invitations). */
export function parseMail(source: Buffer): Promise<Email> {
  const fixed = source
    .toString('latin1')
    .replace(/(charset\s*=\s*"?)(cp949|x-windows-949|ms949|windows-949|uhc|ksc5601)\b/gi, '$1euc-kr')
    .replace(/=\?(cp949|x-windows-949|ms949|windows-949|uhc|ksc5601)\?/gi, '=?euc-kr?');
  return PostalMime.parse(Buffer.from(fixed, 'latin1'));
}

export const bodyText = (m: Email) => noComments(m.text ?? '').trim() || htmlToText(m.html ?? '');

export async function fetchSource(c: ImapClient, folder: string, uid: number): Promise<Buffer> {
  await c.mailboxOpen(await resolveFolder(c, folder), { readOnly: true });
  const meta = await c.fetchOne(String(uid), { size: true }, { uid: true });
  if (!meta) throw new Error(`Message uid ${uid} not found in ${folder}`);
  if ((meta.size ?? 0) > MAX_MESSAGE_BYTES) throw new Error(`Message is larger than ${MAX_MESSAGE_BYTES} bytes`);
  const msg = await c.fetchOne(String(uid), { source: true }, { uid: true });
  if (!msg || !msg.source) throw new Error(`Message uid ${uid} not found in ${folder}`);
  return msg.source;
}

export const icsOf = (m: Email) =>
  m.attachments.filter((a) => /calendar/i.test(a.mimeType) || /\.ics$/i.test(a.filename ?? '')).map((a) => decodeBytes(new Uint8Array(a.content as ArrayBuffer)));

// ---------- read ----------

export type ReadFormat = 'text' | 'html' | 'raw' | 'headers';

const READ_HEADERS = ['in-reply-to', 'references', 'authentication-results', 'list-unsubscribe', 'list-unsubscribe-post'];
const MAX_PLAIN_BYTES = 256 * 1024;
const MAX_HTML_BYTES = 512 * 1024;

/**
 * Reads only what is shown: envelope, structure, a few headers and the text parts (not the whole message, whose
 * attachments would be downloaded and parsed for nothing). Attachments are listed from the structure.
 */
export async function readEmail(c: ImapClient, folder: string, uid: number, format: ReadFormat = 'text') {
  if (format === 'raw') return { folder, uid, raw: clip((await fetchSource(c, folder, uid)).toString('utf8')) };
  await c.mailboxOpen(await resolveFolder(c, folder), { readOnly: true });
  const m = await c.fetchOne(String(uid), { uid: true, envelope: true, bodyStructure: true, flags: true, size: true, headers: format === 'headers' ? true : READ_HEADERS }, { uid: true });
  if (!m) throw new Error(`Message uid ${uid} not found in ${folder}`);
  if (format === 'headers') return { folder, uid, headers: headerLines(m.headers).map((h) => `${h.name}: ${h.value}`) };
  const h = headerMap(m.headers);
  const { plain, html } = bodyParts(m.bodyStructure);
  const atts = attachmentNodes(m.bodyStructure);
  const ics = atts.filter((n) => n.type === 'text/calendar' || /\.ics$/i.test(leafName(n) ?? ''));
  const wantHtml = html && (format === 'html' || !plain);
  const parts = [
    ...(plain ? [{ key: section(plain), maxLength: MAX_PLAIN_BYTES }] : []),
    ...(wantHtml ? [{ key: section(html), maxLength: MAX_HTML_BYTES }] : []),
    ...ics.map((n) => ({ key: section(n), maxLength: 65_536 })),
  ];
  const body = parts.length ? (await c.fetchOne(String(uid), { uid: true, bodyParts: parts }, { uid: true })) || undefined : undefined;
  const get = (n: MessageStructureObject, mode?: 'raw') => {
    const raw = body?.bodyParts?.get(section(n));
    return raw ? decodePart(raw, n, mode) : '';
  };
  let htmlSource = wantHtml ? get(html, 'raw') : '';
  let text = plain ? get(plain).trim() : '';
  // Some senders ship an empty text/plain next to the real HTML body.
  if (!text && html && !htmlSource) {
    const more = await c.fetchOne(String(uid), { uid: true, bodyParts: [{ key: section(html), maxLength: MAX_HTML_BYTES }] }, { uid: true });
    const raw = more ? more.bodyParts?.get(section(html)) : undefined;
    htmlSource = raw ? decodePart(raw, html, 'raw') : '';
  }
  if (!text && htmlSource) text = htmlToText(htmlSource);
  const links = [...new Set([...(htmlSource ? htmlSource.matchAll(/href\s*=\s*["']([^"']+)["']/gi) : []), ...text.matchAll(/(https?:\/\/[^\s<>"')\]]+)/gi)].map((x) => x[1]).filter((u) => /^https?:/i.test(u)))];
  const e = m.envelope;
  return {
    folder,
    uid,
    messageId: e?.messageId,
    inReplyTo: h['in-reply-to'],
    references: h['references'],
    date: e?.date,
    from: fmt(e?.from).join(', '),
    to: fmt(e?.to),
    cc: fmt(e?.cc),
    replyTo: fmt(e?.replyTo),
    subject: e?.subject,
    unread: !m.flags?.has('\\Seen'),
    flagged: !!m.flags?.has('\\Flagged'),
    text: clip(text),
    ...(format === 'html' && htmlSource && { html: clip(htmlSource) }),
    attachments: atts.map((n, index) => ({ index, filename: leafName(n), mimeType: n.type, size: decodedSize(n), ...(n.id && { contentId: n.id }), ...(n.disposition === 'inline' && { inline: true }) })),
    ...(links.length && { links: links.slice(0, 50) }),
    ...(h['authentication-results'] && { authentication: Object.fromEntries([...h['authentication-results'].matchAll(/\b(spf|dkim|dmarc)=(\w+)/gi)].map((x) => [x[1].toLowerCase(), x[2].toLowerCase()])) }),
    ...(h['list-unsubscribe'] && { listUnsubscribe: { targets: [...h['list-unsubscribe'].matchAll(/<([^>]+)>/g)].map((x) => x[1]), oneClick: /one-click/i.test(h['list-unsubscribe-post'] ?? '') } }),
    ...(ics.length && { calendarEvents: ics.flatMap((n) => parseIcs(get(n))) }),
  };
}

/** Downloads one attachment part (index as listed by read_email). */
export async function getAttachment(c: ImapClient, folder: string, uid: number, index: number) {
  await c.mailboxOpen(await resolveFolder(c, folder), { readOnly: true });
  const m = await c.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
  if (!m) throw new Error(`Message uid ${uid} not found in ${folder}`);
  const node = attachmentNodes(m.bodyStructure)[index];
  if (!node) throw new Error(`Attachment ${index} not found`);
  if (decodedSize(node) > MAX_ATTACHMENT_BYTES * 1.05) throw new Error(`Attachment is larger than ${MAX_ATTACHMENT_BYTES} bytes`);
  const part = await c.fetchOne(String(uid), { uid: true, bodyParts: [{ key: section(node) }] }, { uid: true });
  const bytes = decodeTransfer(part ? (part.bodyParts?.get(section(node)) ?? Buffer.alloc(0)) : Buffer.alloc(0), node.encoding);
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment is larger than ${MAX_ATTACHMENT_BYTES} bytes`);
  return { filename: leafName(node) ?? `attachment-${index}`, mimeType: node.type, bytes, contentId: node.id };
}

