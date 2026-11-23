import { Buffer } from 'node:buffer';
import type { MessageStructureObject } from './imap';

// Text, MIME and calendar helpers shared by the IMAP client, mail actions and search.

const MAX_TEXT_CHARS = 100_000;

type Addr = { name?: string; address?: string; group?: Addr[] };
export const fmt = (list?: Addr[]) =>
  ((list ?? []) as Addr[])
    .flatMap((a) => a.group ?? [a])
    .map((a) => (a.name ? `${a.name} <${a.address}>` : a.address))
    .filter(Boolean) as string[];
export const addressesOf = (list?: Addr[]) =>
  ((list ?? []) as Addr[]).flatMap((a) => a.group ?? [a]).filter((a) => a.address) as { name?: string; address: string }[];

export const leafName = (n: MessageStructureObject) => n.dispositionParameters?.filename ?? n.parameters?.name;
export const isAttachmentNode = (n: MessageStructureObject) =>
  !n.childNodes && (n.disposition === 'attachment' || (!!leafName(n) && n.disposition !== 'inline'));
export const attachmentNames = (n?: MessageStructureObject): string[] =>
  !n ? [] : n.childNodes ? n.childNodes.flatMap(attachmentNames) : isAttachmentNode(n) ? [leafName(n) ?? '(unnamed)'] : [];

const leaves = (n?: MessageStructureObject): MessageStructureObject[] => (!n ? [] : n.childNodes ? n.childNodes.flatMap(leaves) : [n]);
/** IMAP section of a leaf; a single-part message's body is BODY[1]. */
export const section = (n: MessageStructureObject) => n.part ?? '1';

/** The readable bodies: first non-attachment text/plain and text/html. */
export function bodyParts(n?: MessageStructureObject) {
  const ok = leaves(n).filter((l) => !isAttachmentNode(l));
  return { plain: ok.find((l) => l.type === 'text/plain'), html: ok.find((l) => l.type === 'text/html') };
}

/** The part to read for a text preview: plain text if there is one, else HTML. */
export function textPart(n?: MessageStructureObject): MessageStructureObject | undefined {
  const b = bodyParts(n);
  return b.plain ?? b.html;
}

/** Every leaf that is not one of the readable bodies: files, inline images, calendar parts. Index = attachment index. */
export function attachmentNodes(n?: MessageStructureObject): MessageStructureObject[] {
  const b = bodyParts(n);
  return leaves(n).filter((l) => l !== b.plain && l !== b.html);
}

/** BODYSTRUCTURE sizes are encoded sizes; base64 carries ~3 bytes per 4 (plus line breaks). */
export const decodedSize = (n: MessageStructureObject) => Math.round((n.size ?? 0) * (n.encoding === 'base64' ? 0.74 : 1));

// TextDecoder knows euc-kr (and ks_c_5601-1987) but not the cp949 aliases common in Korean mail.
const KOREAN_ALIASES = /^(cp949|x-windows-949|ms949|windows-949|uhc|ksc5601)$/i;
export function decodeBytes(bytes: Uint8Array, charset = 'utf-8'): string {
  const label = KOREAN_ALIASES.test(charset) ? 'euc-kr' : charset;
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** Undoes the Content-Transfer-Encoding of a (possibly truncated) part. */
export function decodeTransfer(raw: Buffer, encoding = ''): Buffer {
  const enc = encoding.toLowerCase();
  if (enc === 'base64') {
    const s = raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(s.slice(0, s.length - (s.length % 4)), 'base64');
  }
  if (enc === 'quoted-printable')
    return Buffer.from(raw.toString('latin1').replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  return raw;
}

/** Decodes a text part fetched raw from IMAP. `raw` keeps HTML as is (cheaper, for keyword matching). */
export function decodePart(raw: Buffer, node: MessageStructureObject, mode: 'text' | 'raw' = 'text'): string {
  const text = decodeBytes(decodeTransfer(raw, node.encoding), node.parameters?.charset);
  if (mode === 'raw') return text;
  return node.type === 'text/html' ? htmlToText(text) : noComments(text);
}

/** Unfolded header lines from a raw header block, encoded words decoded; keys lowercased in the map. */
export function headerLines(raw?: Buffer): { key: string; name: string; value: string }[] {
  return (raw?.toString('utf8') ?? '')
    .replace(/\r?\n[ \t]+/g, ' ')
    .split(/\r?\n/)
    .map((l) => {
      const i = l.indexOf(':');
      return i > 0 ? { key: l.slice(0, i).trim().toLowerCase(), name: l.slice(0, i).trim(), value: decodeWords(l.slice(i + 1).trim()) ?? '' } : undefined;
    })
    .filter((x): x is { key: string; name: string; value: string } => !!x);
}
export const headerMap = (raw?: Buffer) => Object.fromEntries(headerLines(raw).map((h) => [h.key, h.value]));

/** "Name <a@b>, c@d" (already decoded) → addresses. Commas inside quotes are kept. */
export function parseAddresses(value = ''): { name?: string; address: string }[] {
  return (value.match(/(?:"[^"]*"|[^,])+/g) ?? [])
    .map((s) => {
      const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(s);
      const address = (m ? m[2] : s).trim();
      return /@/.test(address) ? { ...(m?.[1].trim() && { name: m[1].trim() }), address } : undefined;
    })
    .filter((x): x is { name?: string; address: string } => !!x);
}

// postal-mime's own HTML→text conversion keeps HTML comments (e.g. Outlook <!--[if mso]> blocks).
export const noComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '');

export const htmlToText = (html: string) =>
  noComments(html)
    // also drops a block left unclosed by a truncated fetch
    .replace(/<(style|script|head)\b[\s\S]*?(<\/\1>|$)/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const clip = (s: string, max = MAX_TEXT_CHARS) => (s.length > max ? s.slice(0, max) + '\n…[truncated]' : s);

// ---------- calendar (.ics) ----------

export const unfold = (ics: string) => ics.replace(/\r?\n[ \t]/g, '');
export const icsLine = (block: string, key: string) => block.match(new RegExp(`^${key}(?:;[^:\\r\\n]*)?:.*$`, 'mi'))?.[0];
export const icsValue = (block: string, key: string) =>
  icsLine(block, key)
    ?.replace(/^[^:]*:/, '')
    .replace(/\\n/gi, '\n')
    .replace(/\\([,;\\])/g, '$1')
    .trim();

export function parseIcs(ics: string) {
  const s = unfold(ics);
  const method = icsValue(s, 'METHOD');
  return [...s.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].map(([, b]) => ({
    method,
    summary: icsValue(b, 'SUMMARY'),
    start: icsLine(b, 'DTSTART')?.replace(/^DTSTART/i, ''),
    end: icsLine(b, 'DTEND')?.replace(/^DTEND/i, ''),
    location: icsValue(b, 'LOCATION'),
    organizer: icsValue(b, 'ORGANIZER')?.replace(/^mailto:/i, ''),
    description: icsValue(b, 'DESCRIPTION')?.slice(0, 2000),
    uid: icsValue(b, 'UID'),
  }));
}


/** RFC 2047 encoded words; adjacent words of one charset are decoded together so split multi-byte characters survive. */
export function decodeWords(s?: string): string | undefined {
  if (!s || !s.includes('=?')) return s;
  let out = '';
  let last = 0;
  let run: { charset: string; bytes: Buffer[] } | null = null;
  const flush = () => {
    if (run) out += decodeBytes(Buffer.concat(run.bytes), run.charset);
    run = null;
  };
  for (const m of s.matchAll(/=\?([^?*]+)(?:\*[^?]*)?\?([bBqQ])\?([^?]*)\?=/g)) {
    const gap = s.slice(last, m.index);
    const charset = m[1].toLowerCase();
    // Whitespace between two encoded words is not part of the text (RFC 2047 §6.2).
    if (!run || !/^\s*$/.test(gap) || run.charset !== charset) {
      flush();
      out += gap;
    }
    const bytes = m[2].toUpperCase() === 'B' ? Buffer.from(m[3], 'base64') : Buffer.from(m[3].replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    (run ??= { charset, bytes: [] }).bytes.push(bytes);
    last = m.index + m[0].length;
  }
  flush();
  return out + s.slice(last);
}
