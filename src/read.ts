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

const READ_HEADERS = ['in-reply-to', 'references', 'authentication-results'];
const LINK_HEADERS = ['list-unsubscribe', 'list-unsubscribe-post'];
const TEXT_PAGE_CHARS = 4000;
const MAX_PLAIN_BYTES = 256 * 1024;
const MAX_HTML_BYTES = 512 * 1024;

/**
 * Reads only what is shown: envelope, structure, a few headers and the text parts (not the whole message, whose
 * attachments would be downloaded and parsed for nothing). Attachments are listed from the structure.
 */
export async function readEmail(c: ImapClient, folder: string, uid: number, { format = 'text', offset = 0, includeLinks = false }: { format?: ReadFormat; offset?: number; includeLinks?: boolean } = {}) {
  if (format === 'raw') return { folder, uid, raw: clip((await fetchSource(c, folder, uid)).toString('utf8')) };
  await c.mailboxOpen(await resolveFolder(c, folder), { readOnly: true });
  const headers = format === 'headers' ? true : includeLinks ? [...READ_HEADERS, ...LINK_HEADERS] : READ_HEADERS;
  const m = await c.fetchOne(String(uid), { uid: true, envelope: true, bodyStructure: true, flags: true, size: true, headers }, { uid: true });
  if (!m) throw new Error(`Message uid ${uid} not found in ${folder}`);
  if (format === 'headers') return { folder, uid, headers: headerLines(m.headers).map((h) => `${h.name}: ${h.value}`) };
  const h = headerMap(m.headers);
  const { plain, html } = bodyParts(m.bodyStructure);
  const atts = attachmentNodes(m.bodyStructure);
  const ics = atts.filter((n) => n.type === 'text/calendar' || /\.ics$/i.test(leafName(n) ?? ''));
  const wantHtml = html && (format === 'html' || includeLinks || !plain);
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
  let end = offset + TEXT_PAGE_CHARS;
  // Keep a surrogate pair intact at the page boundary.
  if (/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text.slice(end - 1, end + 1))) end--;
  const links = includeLinks
    ? [...new Set([...htmlSource.matchAll(/href\s*=\s*["']([^"']+)["']/gi), ...text.matchAll(/(https?:\/\/[^\s<>"')\]]+)/gi)].map((x) => x[1]).filter((u) => /^https?:/i.test(u)))].slice(0, 50)
    : [];
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
    text: format === 'text' ? text.slice(offset, end) : clip(text),
    ...(format === 'text' && end < text.length && { nextOffset: end }),
    ...(format === 'html' && htmlSource && { html: clip(htmlSource) }),
    attachments: atts.map((n, index) => ({ index, filename: leafName(n), mimeType: n.type, size: decodedSize(n), ...(n.id && { contentId: n.id }), ...(n.disposition === 'inline' && { inline: true }) })),
    ...(links.length && { links }),
    ...(h['authentication-results'] && { authentication: Object.fromEntries([...h['authentication-results'].matchAll(/\b(spf|dkim|dmarc)=(\w+)/gi)].map((x) => [x[1].toLowerCase(), x[2].toLowerCase()])) }),
    ...(includeLinks && h['list-unsubscribe'] && { listUnsubscribe: { targets: [...h['list-unsubscribe'].matchAll(/<([^>]+)>/g)].map((x) => x[1]), oneClick: /one-click/i.test(h['list-unsubscribe-post'] ?? '') } }),
    ...(ics.length && { calendarEvents: ics.flatMap((n) => parseIcs(get(n))) }),
  };
}

export async function openAttachment(c: ImapClient, folder: string, uid: number, index: number) {
  const mailbox = await c.mailboxOpen(folder, { readOnly: true });
  const m = await c.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
  if (!m) throw new Error(`Message uid ${uid} not found in ${folder}`);
  const node = attachmentNodes(m.bodyStructure)[index];
  if (!node) throw new Error(`Attachment ${index} not found`);
  return { mailbox, node, filename: leafName(node) ?? `attachment-${index}`, mimeType: node.type };
}

export class AttachmentTooLargeError extends Error {}

export async function fetchAttachmentBytes(c: ImapClient, uid: number, node: MessageStructureObject, maxBytes = MAX_ATTACHMENT_BYTES) {
  const tooLarge = () => new AttachmentTooLargeError(`Attachment is larger than ${maxBytes} bytes`);
  if (decodedSize(node) > maxBytes * 1.05) throw tooLarge();
  const encoding = node.encoding?.toLowerCase();
  // Include enough room for MIME base64 line breaks and detect incomplete partial fetches.
  const maxLength = (encoding === 'base64' ? Math.ceil(4 * Math.ceil(maxBytes / 3) * 1.05)
    : encoding === 'quoted-printable' ? Math.ceil(maxBytes * 1.05) : maxBytes) + 1;
  const part = await c.fetchOne(String(uid), { uid: true, bodyParts: [{ key: section(node), maxLength }] }, { uid: true });
  const raw = part && part.bodyParts?.get(section(node));
  if (!raw) throw new Error('Attachment data not found');
  if (raw.length >= maxLength) throw tooLarge();
  const bytes = encoding === 'base64' ? Buffer.from(raw.toString('latin1'), 'base64') : decodeTransfer(raw, encoding);
  if (bytes.length > maxBytes) throw tooLarge();
  return bytes;
}

/** Downloads one attachment part for clients that need the bytes. */
export async function getAttachment(c: ImapClient, folder: string, uid: number, index: number) {
  const { filename, mimeType, node } = await openAttachment(c, await resolveFolder(c, folder), uid, index);
  return { filename, mimeType, bytes: await fetchAttachmentBytes(c, uid, node), contentId: node.id };
}

