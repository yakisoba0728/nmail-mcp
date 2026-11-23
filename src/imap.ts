import { Buffer } from 'node:buffer';
import tls from 'node:tls';
import { decodeBytes, decodeWords } from './mime';

/**
 * Minimal IMAP4rev1 client for what this server needs, with the method names and result shapes of the parts of
 * imapflow it replaced. imapflow cost ~7–20 ms CPU per login alone (extra ID/LIST round trips and a general
 * parser); Workers Free allows 10 ms per request. Relies on LITERAL+ and SASL-IR (Naver supports both), so no
 * command ever waits for a "+" continuation. One command at a time; no IDLE, no pipelining.
 */

export type Token = string | Buffer | null | Token[];

export interface Address {
  name?: string;
  address?: string;
}
export interface Envelope {
  date?: Date;
  subject?: string;
  from?: Address[];
  sender?: Address[];
  replyTo?: Address[];
  to?: Address[];
  cc?: Address[];
  bcc?: Address[];
  inReplyTo?: string;
  messageId?: string;
}
export interface MessageStructureObject {
  /** IMAP part number; undefined for the root of a single-part message (whose body is BODY[1]) */
  part?: string;
  type: string;
  parameters?: Record<string, string>;
  id?: string;
  encoding?: string;
  size?: number;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  childNodes?: MessageStructureObject[];
}
export interface FetchMessageObject {
  seq: number;
  uid: number;
  flags?: Set<string>;
  size?: number;
  internalDate?: Date;
  envelope?: Envelope;
  bodyStructure?: MessageStructureObject;
  headers?: Buffer;
  source?: Buffer;
  bodyParts?: Map<string, Buffer>;
}
export interface FetchQuery {
  uid?: boolean;
  flags?: boolean;
  envelope?: boolean;
  size?: boolean;
  internalDate?: boolean;
  bodyStructure?: boolean;
  /** true = all headers, or a list of header names */
  headers?: boolean | string[];
  source?: boolean;
  bodyParts?: { key: string; maxLength?: number }[];
}
export interface ListResponse {
  path: string;
  name: string;
  delimiter: string;
  flags: Set<string>;
  specialUse?: string;
  status?: { messages?: number; unseen?: number };
}
export interface SearchObject {
  all?: boolean;
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
  deleted?: boolean;
  draft?: boolean;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  text?: string;
  since?: Date;
  before?: Date;
  larger?: number;
  smaller?: number;
  uid?: string;
  header?: Record<string, string>;
  not?: SearchObject;
  or?: SearchObject[];
}

export class ImapError extends Error {
  constructor(
    message: string,
    readonly responseText?: string,
    readonly authenticationFailed = false,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ImapError';
  }
}

// ---------- byte reader ----------

class Reader {
  private head = Buffer.alloc(0);
  private chunks: Buffer[] = [];
  private queued = 0;
  private wake = () => {};
  error?: Error;

  push(d: Buffer) {
    this.chunks.push(d);
    this.queued += d.length;
    this.wake();
  }
  fail(e: Error) {
    this.error ??= e;
    this.wake();
  }
  private async more() {
    if (this.error) throw this.error;
    await new Promise<void>((r) => (this.wake = r));
    if (this.error && !this.queued) throw this.error;
  }
  // Chunks are merged only when needed, so a 20 MB literal is copied once, not once per packet.
  private absorb() {
    if (!this.queued) return;
    this.head = this.head.length ? Buffer.concat([this.head, ...this.chunks]) : this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    this.chunks = [];
    this.queued = 0;
  }
  async line(): Promise<string> {
    for (let from = 0; ; ) {
      const i = this.head.indexOf('\r\n', from);
      if (i >= 0) {
        const l = this.head.toString('utf8', 0, i);
        this.head = this.head.subarray(i + 2);
        return l;
      }
      from = Math.max(0, this.head.length - 1);
      if (!this.queued) await this.more();
      this.absorb();
    }
  }
  async bytes(n: number): Promise<Buffer> {
    while (this.head.length + this.queued < n) await this.more();
    if (this.head.length < n) this.absorb();
    const out = this.head.subarray(0, n);
    this.head = this.head.subarray(n);
    return out;
  }
}

// ---------- tokenizer ----------

/** Parses one response (text pieces with the literals that followed them) into nested tokens. */
export function tokenize(pieces: (string | Buffer)[]): Token[] {
  const root: Token[] = [];
  const stack: Token[][] = [root];
  for (const p of pieces) {
    const top = stack[stack.length - 1];
    if (typeof p !== 'string') {
      top.push(p as Buffer);
      continue;
    }
    for (let i = 0; i < p.length; ) {
      const ch = p[i];
      const cur = stack[stack.length - 1];
      if (ch === ' ') i++;
      else if (ch === '(') {
        const l: Token[] = [];
        cur.push(l);
        stack.push(l);
        i++;
      } else if (ch === ')') {
        if (stack.length > 1) stack.pop();
        i++;
      } else if (ch === '"') {
        // Copy runs between escapes with slice (subjects and BODYSTRUCTURE are full of long quoted strings).
        let j = i + 1;
        let out = '';
        for (;;) {
          const q = p.indexOf('"', j);
          const bs = p.indexOf('\\', j);
          if (q < 0) {
            out += p.slice(j);
            j = p.length;
            break;
          }
          if (bs >= 0 && bs < q) {
            out += p.slice(j, bs) + p[bs + 1];
            j = bs + 2;
          } else {
            out += p.slice(j, q);
            j = q;
            break;
          }
        }
        cur.push(out);
        i = j + 1;
      } else if (ch === '{' && /^\{\d+\+?\}$/.test(p.slice(i))) {
        i = p.length; // literal marker: the Buffer is the next piece
      } else {
        let j = i;
        while (j < p.length && p[j] !== ' ' && p[j] !== '(' && p[j] !== ')') {
          if (p[j] === '[') {
            const k = p.indexOf(']', j);
            j = k < 0 ? p.length : k + 1;
          } else j++;
        }
        const atom = p.slice(i, j);
        cur.push(atom === 'NIL' ? null : atom);
        i = j;
      }
    }
  }
  return root;
}

const str = (t: Token | undefined): string | undefined => (t === null || t === undefined || Array.isArray(t) ? undefined : typeof t === 'string' ? t : t.toString('utf8'));
const buf = (t: Token | undefined): Buffer => (Buffer.isBuffer(t) ? (t as Buffer) : Buffer.from(str(t) ?? '', 'utf8'));

// ---------- modified UTF-7 (RFC 3501 mailbox names) ----------

export function encodeMailbox(name: string): string {
  return name.replace(/&/g, '&-').replace(/[^\x20-\x7e]+/g, (run) => {
    const b = Buffer.alloc(run.length * 2);
    for (let i = 0; i < run.length; i++) b.writeUInt16BE(run.charCodeAt(i), i * 2);
    return '&' + b.toString('base64').replace(/=+$/, '').replace(/\//g, ',') + '-';
  });
}

export function decodeMailbox(name: string): string {
  return name.replace(/&([^-]*)-/g, (_, b64: string) => {
    if (!b64) return '&';
    const b = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    let out = '';
    for (let i = 0; i + 1 < b.length; i += 2) out += String.fromCharCode(b.readUInt16BE(i));
    return out;
  });
}

// ---------- structured values ----------

function addresses(t: Token): Address[] | undefined {
  if (!Array.isArray(t)) return undefined;
  const out: Address[] = [];
  for (const a of t) {
    if (!Array.isArray(a)) continue;
    const [name, , mailbox, host] = a.map(str);
    if (host === undefined) continue; // RFC 2822 group start/end markers
    out.push({ ...(name && { name: decodeWords(name) }), address: mailbox ? `${mailbox}@${host}` : undefined });
  }
  return out;
}

const parseDate = (s?: string) => {
  if (!s) return undefined;
  const d = new Date(s.replace(/\s*\([^)]*\)\s*$/, '').replace(/^(\d{1,2})-(\w{3})-(\d{4})/, '$1 $2 $3'));
  return Number.isNaN(d.getTime()) ? undefined : d;
};

function envelope(t: Token): Envelope | undefined {
  if (!Array.isArray(t)) return undefined;
  const [date, subject, from, sender, replyTo, to, cc, bcc, inReplyTo, messageId] = t;
  return {
    date: parseDate(str(date)),
    subject: decodeWords(str(subject)),
    from: addresses(from),
    sender: addresses(sender),
    replyTo: addresses(replyTo),
    to: addresses(to),
    cc: addresses(cc),
    bcc: addresses(bcc),
    inReplyTo: str(inReplyTo),
    messageId: str(messageId),
  };
}

/** Body parameters, with RFC 2231 continuations/charsets (filename*0*=UTF-8''…) and RFC 2047 words decoded. */
function params(t: Token): Record<string, string> | undefined {
  if (!Array.isArray(t)) return undefined;
  const raw: Record<string, string> = {};
  for (let i = 0; i + 1 < t.length; i += 2) raw[(str(t[i]) ?? '').toLowerCase()] = str(t[i + 1]) ?? '';
  const out: Record<string, string> = {};
  const ext = new Map<string, { idx: number; v: string; enc: boolean }[]>();
  for (const [k, v] of Object.entries(raw)) {
    const m = /^([^*]+)\*(\d+)?(\*)?$/.exec(k);
    if (!m) out[k] = decodeWords(v) ?? v;
    else ext.set(m[1], [...(ext.get(m[1]) ?? []), { idx: Number(m[2] ?? 0), v, enc: !!m[3] || m[2] === undefined }]);
  }
  for (const [k, parts] of ext) {
    parts.sort((a, b) => a.idx - b.idx);
    let charset = 'utf-8';
    const bytes: number[] = [];
    for (const [n, p] of parts.entries()) {
      let v = p.v;
      if (n === 0 && p.enc) {
        const m = /^([^']*)'[^']*'(.*)$/.exec(v);
        if (m) (charset = m[1] || charset), (v = m[2]);
      }
      if (!p.enc) bytes.push(...Buffer.from(v, 'utf8'));
      else
        for (let i = 0; i < v.length; i++) {
          const hex = v[i] === '%' ? v.slice(i + 1, i + 3) : '';
          if (/^[0-9a-f]{2}$/i.test(hex)) (bytes.push(parseInt(hex, 16)), (i += 2));
          else bytes.push(v.charCodeAt(i));
        }
    }
    out[k] = decodeBytes(Uint8Array.from(bytes), charset);
  }
  return out;
}

function disposition(t: Token) {
  if (!Array.isArray(t) || !t.length) return {};
  return { disposition: str(t[0])?.toLowerCase(), dispositionParameters: params(t[1]) };
}

export function bodyStructure(t: Token, part?: string): MessageStructureObject {
  const l = t as Token[];
  if (Array.isArray(l[0])) {
    const childNodes: MessageStructureObject[] = [];
    let i = 0;
    for (; Array.isArray(l[i]); i++) childNodes.push(bodyStructure(l[i], part ? `${part}.${i + 1}` : String(i + 1)));
    return { part, type: `multipart/${(str(l[i]) ?? 'mixed').toLowerCase()}`, parameters: params(l[i + 1]), childNodes, ...disposition(l[i + 2]) };
  }
  const type = `${str(l[0])}/${str(l[1])}`.toLowerCase();
  // text/* has a line count, message/rfc822 has envelope + body + lines, then MD5, then disposition.
  const dispAt = 7 + (type.startsWith('text/') ? 1 : type === 'message/rfc822' ? 3 : 0) + 1;
  return { part, type, parameters: params(l[2]), id: str(l[3]), encoding: str(l[5])?.toLowerCase(), size: Number(str(l[6]) ?? 0), ...disposition(l[dispAt]) };
}

export function fetchResult(seq: number, list: Token): FetchMessageObject {
  const m: FetchMessageObject = { seq, uid: 0 };
  const l = Array.isArray(list) ? list : [];
  for (let i = 0; i + 1 < l.length; i += 2) {
    const key = (str(l[i]) ?? '').toUpperCase();
    const v = l[i + 1];
    if (key === 'UID') m.uid = Number(str(v));
    else if (key === 'FLAGS') m.flags = new Set(Array.isArray(v) ? (v.map(str).filter(Boolean) as string[]) : []);
    else if (key === 'RFC822.SIZE') m.size = Number(str(v));
    else if (key === 'INTERNALDATE') m.internalDate = parseDate(str(v));
    else if (key === 'ENVELOPE') m.envelope = envelope(v);
    else if (key === 'BODYSTRUCTURE') m.bodyStructure = bodyStructure(v);
    else if (key.startsWith('BODY[')) {
      const section = key.slice(5, key.indexOf(']'));
      if (!section) m.source = buf(v);
      else if (section.startsWith('HEADER')) m.headers = buf(v);
      else (m.bodyParts ??= new Map()).set(section.toLowerCase(), buf(v));
    }
  }
  return m;
}

// ---------- command building ----------

type Part = string | Buffer;
/** ASCII without quotes/backslashes/controls is sent quoted; anything else as a LITERAL+ literal (UTF-8). */
const astring = (s: string): Part => (/^[\x20-\x7e]*$/.test(s) && !/["\\]/.test(s) ? `"${s}"` : Buffer.from(s, 'utf8'));
const mailbox = (path: string): Part => astring(encodeMailbox(path));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** IMAP dates have no time zone; Naver evaluates them in Korea time, so dates are written in KST. */
const imapDate = (d: Date) => {
  const k = new Date(d.getTime() + 9 * 3600_000);
  return `${k.getUTCDate()}-${MONTHS[k.getUTCMonth()]}-${k.getUTCFullYear()}`;
};

export function searchParts(q: SearchObject): Part[] {
  const out: Part[] = [];
  const flag = (v: boolean | undefined, on: string, off: string) => v !== undefined && out.push(v ? on : off);
  if (q.all) out.push('ALL');
  flag(q.seen, 'SEEN', 'UNSEEN');
  flag(q.flagged, 'FLAGGED', 'UNFLAGGED');
  flag(q.answered, 'ANSWERED', 'UNANSWERED');
  flag(q.deleted, 'DELETED', 'UNDELETED');
  flag(q.draft, 'DRAFT', 'UNDRAFT');
  for (const k of ['from', 'to', 'cc', 'bcc', 'subject', 'body', 'text'] as const) if (q[k] !== undefined) out.push(k.toUpperCase(), astring(q[k]!));
  if (q.since) out.push('SINCE', imapDate(q.since));
  if (q.before) out.push('BEFORE', imapDate(q.before));
  if (q.larger !== undefined) out.push('LARGER', String(q.larger));
  if (q.smaller !== undefined) out.push('SMALLER', String(q.smaller));
  if (q.uid) out.push('UID', q.uid);
  for (const [k, v] of Object.entries(q.header ?? {})) out.push('HEADER', astring(k), astring(v));
  if (q.not) out.push('NOT', '(', ...searchParts(q.not), ')');
  if (q.or?.length) {
    // OR is binary: OR a (OR b c)
    const nest = (xs: SearchObject[]): Part[] => (xs.length === 1 ? ['(', ...searchParts(xs[0]), ')'] : ['OR', '(', ...searchParts(xs[0]), ')', ...nest(xs.slice(1))]);
    out.push(...nest(q.or));
  }
  return out.length ? out : ['ALL'];
}

function fetchItems(q: FetchQuery): string {
  const items = ['UID'];
  if (q.flags) items.push('FLAGS');
  if (q.size) items.push('RFC822.SIZE');
  if (q.internalDate) items.push('INTERNALDATE');
  if (q.envelope) items.push('ENVELOPE');
  if (q.bodyStructure) items.push('BODYSTRUCTURE');
  if (q.headers) items.push(q.headers === true ? 'BODY.PEEK[HEADER]' : `BODY.PEEK[HEADER.FIELDS (${q.headers.map((h) => h.toUpperCase()).join(' ')})]`);
  if (q.source) items.push('BODY.PEEK[]');
  for (const p of q.bodyParts ?? []) items.push(`BODY.PEEK[${p.key}]${p.maxLength ? `<0.${p.maxLength}>` : ''}`);
  return `(${items.join(' ')})`;
}

// ---------- client ----------

export interface ImapOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  tls?: tls.ConnectionOptions;
  timeoutMs?: number;
}

export class ImapClient {
  private sock?: tls.TLSSocket;
  private reader = new Reader();
  private tag = 0;
  private selected?: { path: string; readOnly: boolean };
  capabilities = new Set<string>();

  constructor(private readonly o: ImapOptions) {}

  async connect() {
    const sock = tls.connect({ host: this.o.host, port: this.o.port, ...this.o.tls });
    this.sock = sock;
    sock.setTimeout?.(this.o.timeoutMs ?? 30_000, () => sock.destroy(Object.assign(new Error('IMAP timeout'), { code: 'ETIMEOUT' })));
    sock.on('data', (d: Buffer) => this.reader.push(d));
    sock.on('error', (e: Error) => this.reader.fail(e));
    sock.on('close', () => this.reader.fail(new Error('IMAP connection closed')));
    const greeting = await this.reader.line();
    if (!greeting.startsWith('* OK')) throw new ImapError(`Unexpected greeting: ${greeting}`, greeting);
    try {
      const r = await this.run(['AUTHENTICATE PLAIN ', Buffer.from(`\0${this.o.user}\0${this.o.pass}`).toString('base64')]);
      const caps = /\[CAPABILITY ([^\]]+)\]/.exec(r.text)?.[1] ?? /\[CAPABILITY ([^\]]+)\]/.exec(greeting)?.[1] ?? '';
      this.capabilities = new Set(caps.split(' '));
    } catch (e) {
      throw e instanceof ImapError ? new ImapError('Command failed', e.responseText, true) : e;
    }
  }

  /** Sends one command and collects untagged responses until its tagged completion. */
  async run(parts: Part[]): Promise<{ untagged: Token[][]; text: string }> {
    if (!this.sock) throw new Error('Not connected');
    const tag = `A${++this.tag}`;
    const bufs: Buffer[] = [Buffer.from(tag + ' ')];
    for (const p of parts) {
      if (typeof p === 'string') bufs.push(Buffer.from(p, 'utf8'));
      else bufs.push(Buffer.from(`{${p.length}+}\r\n`), p);
    }
    bufs.push(Buffer.from('\r\n'));
    this.sock.write(Buffer.concat(bufs));
    const untagged: Token[][] = [];
    for (;;) {
      const pieces: Part[] = [];
      for (;;) {
        const line = await this.reader.line();
        pieces.push(line);
        const m = /\{(\d+)\+?\}$/.exec(line);
        if (!m) break;
        pieces.push(await this.reader.bytes(Number(m[1])));
      }
      const first = pieces[0] as string;
      if (first.startsWith('* ')) untagged.push(tokenize([first.slice(2), ...pieces.slice(1)]));
      else if (first.startsWith(tag + ' ')) {
        const text = first.slice(tag.length + 1);
        if (!text.startsWith('OK')) throw new ImapError(`Command failed`, text.replace(/^(NO|BAD)\s*/, ''));
        return { untagged, text };
      }
    }
  }

  /** Space-separated command parts; no space after "(" or before ")" (search key lists). */
  private join(...xs: Part[]): Part[] {
    const out: Part[] = [];
    xs.forEach((x, i) => {
      if (i && x !== ')' && xs[i - 1] !== '(') out.push(' ');
      out.push(x);
    });
    return out;
  }

  async list(opts?: { statusQuery?: { messages?: boolean; unseen?: boolean } }): Promise<ListResponse[]> {
    const { untagged } = await this.run(['LIST "" "*"']);
    const out: ListResponse[] = [];
    for (const t of untagged) {
      if (str(t[0])?.toUpperCase() !== 'LIST') continue;
      const flags = new Set((Array.isArray(t[1]) ? t[1] : []).map(str).filter(Boolean) as string[]);
      const delimiter = str(t[2]) ?? '/';
      const path = decodeMailbox(str(t[3]) ?? '');
      const specialUse = path.toUpperCase() === 'INBOX' ? '\\Inbox' : [...flags].find((f) => /^\\(Sent|Drafts|Trash|Junk|Archive|All|Flagged)$/i.test(f));
      out.push({ path, name: path.split(delimiter).pop() ?? path, delimiter, flags, specialUse });
    }
    if (opts?.statusQuery)
      for (const f of out) if (!f.flags.has('\\Noselect')) f.status = await this.status(f.path, opts.statusQuery);
    return out;
  }

  async status(path: string, q: { messages?: boolean; unseen?: boolean; uidNext?: boolean }) {
    const items = [q.messages && 'MESSAGES', q.unseen && 'UNSEEN', q.uidNext && 'UIDNEXT'].filter(Boolean).join(' ');
    const { untagged } = await this.run(this.join('STATUS', mailbox(path), `(${items})`));
    const l = untagged.find((t) => str(t[0])?.toUpperCase() === 'STATUS')?.[2];
    const out: { messages?: number; unseen?: number; uidNext?: number } = {};
    if (Array.isArray(l)) for (let i = 0; i + 1 < l.length; i += 2) {
      const k = str(l[i])?.toUpperCase();
      const v = Number(str(l[i + 1]));
      if (k === 'MESSAGES') out.messages = v;
      if (k === 'UNSEEN') out.unseen = v;
      if (k === 'UIDNEXT') out.uidNext = v;
    }
    return out;
  }

  /** SELECT/EXAMINE, skipped when that mailbox is already open in a sufficient mode. */
  async mailboxOpen(path: string, opts?: { readOnly?: boolean }) {
    const readOnly = !!opts?.readOnly;
    if (this.selected?.path === path && (!this.selected.readOnly || readOnly)) return { path, cached: true as const };
    const { untagged, text } = await this.run(this.join(readOnly ? 'EXAMINE' : 'SELECT', mailbox(path)));
    this.selected = { path, readOnly };
    const lines = untagged.map((t) => t.map((x) => str(x) ?? '').join(' ')).join('\n') + text;
    const code = (k: string) => Number(new RegExp(`\\[${k} (\\d+)\\]`).exec(lines)?.[1] ?? 0);
    const exists = Number(str(untagged.find((t) => str(t[1])?.toUpperCase() === 'EXISTS')?.[0]) ?? 0);
    return { path, exists, uidValidity: code('UIDVALIDITY'), uidNext: code('UIDNEXT') };
  }

  async search(q: SearchObject, _opts?: { uid?: boolean }): Promise<number[]> {
    const parts = searchParts(q);
    const utf8 = parts.some((p) => typeof p !== 'string');
    const { untagged } = await this.run(this.join('UID SEARCH', ...(utf8 ? ['CHARSET UTF-8'] : []), ...parts));
    const out: number[] = [];
    for (const t of untagged) if (str(t[0])?.toUpperCase() === 'SEARCH') for (const n of t.slice(1)) out.push(Number(str(n)));
    return out;
  }

  async fetchAll(range: string, q: FetchQuery, _opts?: { uid?: boolean }): Promise<FetchMessageObject[]> {
    if (!range) return [];
    const { untagged } = await this.run([`UID FETCH ${range} ${fetchItems(q)}`]);
    const out: FetchMessageObject[] = [];
    for (const t of untagged) if (str(t[1])?.toUpperCase() === 'FETCH') out.push(fetchResult(Number(str(t[0])), t[2]));
    return out;
  }

  async fetchOne(uid: string, q: FetchQuery, opts?: { uid?: boolean }): Promise<FetchMessageObject | false> {
    return (await this.fetchAll(uid, q, opts))[0] ?? false;
  }

  async messageFlagsAdd(range: string, flags: string[], _opts?: { uid?: boolean }) {
    await this.run([`UID STORE ${range} +FLAGS.SILENT (${flags.join(' ')})`]);
    return true;
  }

  async messageFlagsRemove(range: string, flags: string[], _opts?: { uid?: boolean }) {
    await this.run([`UID STORE ${range} -FLAGS.SILENT (${flags.join(' ')})`]);
    return true;
  }

  /** UID MOVE (RFC 6851); new UIDs come from COPYUID (UIDPLUS). */
  async messageMove(range: string, destination: string, _opts?: { uid?: boolean }) {
    const { untagged, text } = await this.run(this.join(`UID MOVE ${range}`, mailbox(destination)));
    const all = [text, ...untagged.map((t) => t.map((x) => str(x as Token) ?? '').join(' '))].join('\n');
    const m = /\[COPYUID \d+ ([\d:,]+) ([\d:,]+)\]/i.exec(all);
    const uidMap = new Map<number, number>();
    if (m) {
      const expand = (s: string) => s.split(',').flatMap((r) => {
        const [a, b] = r.split(':').map(Number);
        return b === undefined ? [a] : Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => Math.min(a, b) + i);
      });
      const [src, dst] = [expand(m[1]), expand(m[2])];
      src.forEach((u, i) => uidMap.set(u, dst[i]));
    }
    return { uidMap };
  }

  async messageDelete(range: string, _opts?: { uid?: boolean }) {
    await this.run([`UID STORE ${range} +FLAGS.SILENT (\\Deleted)`]);
    await this.run([`UID EXPUNGE ${range}`]);
    return true;
  }

  async append(path: string, content: Buffer | Uint8Array, flags: string[] = []) {
    const { text } = await this.run(this.join('APPEND', mailbox(path), `(${flags.join(' ')})`, Buffer.from(content)));
    const m = /\[APPENDUID \d+ (\d+)\]/i.exec(text);
    return { uid: m ? Number(m[1]) : undefined };
  }

  async mailboxCreate(path: string) {
    await this.run(this.join('CREATE', mailbox(path)));
    return { path, created: true };
  }

  async mailboxRename(path: string, newPath: string) {
    await this.run(this.join('RENAME', mailbox(path), mailbox(newPath)));
    if (this.selected?.path === path) this.selected = undefined;
    return { path, newPath };
  }

  async mailboxDelete(path: string) {
    if (this.selected?.path === path) {
      await this.run(['UNSELECT']).catch(() => {});
      this.selected = undefined;
    }
    await this.run(this.join('DELETE', mailbox(path)));
    return { path };
  }

  /** GETQUOTAROOT; STORAGE is reported in KB and returned in bytes. */
  async getQuota(path = 'INBOX') {
    const { untagged } = await this.run(this.join('GETQUOTAROOT', mailbox(path)));
    const q = untagged.find((t) => str(t[0])?.toUpperCase() === 'QUOTA')?.[2];
    if (!Array.isArray(q)) return false as const;
    const i = q.findIndex((x) => str(x)?.toUpperCase() === 'STORAGE');
    if (i < 0) return false as const;
    const usage = Number(str(q[i + 1])) * 1024;
    const limit = Number(str(q[i + 2])) * 1024;
    return { path, storage: { usage, limit, status: `${Math.round((usage / limit) * 100)}%` } };
  }

  async logout() {
    try {
      await this.run(['LOGOUT']);
    } finally {
      this.close();
    }
  }

  close() {
    this.sock?.destroy();
    this.sock = undefined;
  }
}
