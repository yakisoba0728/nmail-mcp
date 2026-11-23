import type { FetchMessageObject, ImapClient, MessageStructureObject, SearchObject } from './imap';
import { invalidateFolders, resolveFolder, searchableFolders } from './mail';
import type { Ref } from './organize';
import { attachmentNames, clip, decodePart, fmt, headerMap, parseAddresses, textPart } from './mime';

/**
 * Naver IMAP facts (probed on a live account): no SORT/THREAD/ESEARCH; BODY/TEXT search always returns 0;
 * SUBJECT/FROM (Korean included), OR, NOT, LARGER/SMALLER and HEADER searches work.
 * So keywords are matched on subject/sender by the server and on the body by fetching text here, under a budget.
 */

export interface Criteria {
  keywords: string[];
  exclude: string[];
  from: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string[];
  notFrom: string[];
  notSubject: string[];
  filename: string[];
  folders: string[];
  anywhere?: boolean;
  since?: Date;
  before?: Date;
  unread?: boolean;
  flagged?: boolean;
  answered?: boolean;
  hasAttachment?: boolean;
  larger?: number;
  smaller?: number;
  /** IMAP UID range, e.g. "1500:*" (used by rules to look only at new mail) */
  uidRange?: string;
}

export const emptyCriteria = (): Criteria => ({ keywords: [], exclude: [], from: [], to: [], cc: [], bcc: [], subject: [], notFrom: [], notSubject: [], filename: [], folders: [] });

const SIZE_UNITS: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
const parseSize = (v: string) => {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(v);
  return m ? Math.round(Number(m[1]) * SIZE_UNITS[m[2].toLowerCase()]) : undefined;
};
/** YYYY/MM/DD or YYYY-MM-DD, as a KST calendar date. */
export const parseDate = (v: string) => {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(v);
  return m ? new Date(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T00:00:00+09:00`) : undefined;
};
const relDate = (v: string, now: Date) => {
  const m = /^(\d+)([dwmy])$/i.exec(v);
  if (!m) return undefined;
  const d = new Date(now);
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'd') d.setDate(d.getDate() - n);
  if (unit === 'w') d.setDate(d.getDate() - 7 * n);
  if (unit === 'm') d.setMonth(d.getMonth() - n);
  if (unit === 'y') d.setFullYear(d.getFullYear() - n);
  return d;
};

/** Gmail-style query → Criteria. Unsupported operators are reported, never silently dropped. */
export function parseQuery(q: string, now = new Date()): { criteria: Criteria; warnings: string[] } {
  const c = emptyCriteria();
  const warnings: string[] = [];
  for (const m of q.matchAll(/(-?)(?:([a-z_]+):)?(?:"([^"]*)"|(\S+))/gi)) {
    const neg = m[1] === '-';
    const key = m[2]?.toLowerCase();
    const v = m[3] ?? m[4];
    const bad = (why = `"${m[0]}" is not supported`) => warnings.push(why + '; ignored');
    if (!key) {
      if (v === 'OR' || v === 'AND') bad('OR/AND are not supported (terms are always ANDed)');
      else (neg ? c.exclude : c.keywords).push(v);
      continue;
    }
    switch (key) {
      case 'from':
        (neg ? c.notFrom : c.from).push(v);
        break;
      case 'subject':
        (neg ? c.notSubject : c.subject).push(v);
        break;
      case 'to':
      case 'cc':
      case 'bcc':
        if (neg) bad();
        else c[key].push(v);
        break;
      case 'after':
      case 'since':
      case 'before': {
        const d = parseDate(v);
        if (!d || neg) bad();
        else if (key === 'before') c.before = d;
        else c.since = d;
        break;
      }
      case 'newer_than':
      case 'older_than': {
        const d = relDate(v, now);
        if (!d || neg) bad();
        else if (key === 'newer_than') c.since = d;
        else c.before = d;
        break;
      }
      case 'is': {
        const s = v.toLowerCase();
        const val = (b: boolean) => (neg ? !b : b);
        if (s === 'unread' || s === 'read') c.unread = val(s === 'unread');
        else if (s === 'starred' || s === 'flagged' || s === 'important') c.flagged = val(true);
        else if (s === 'unstarred') c.flagged = val(false);
        else if (s === 'answered' || s === 'replied') c.answered = val(true);
        else bad();
        break;
      }
      case 'has':
        if (v.toLowerCase() === 'attachment') c.hasAttachment = !neg;
        else bad();
        break;
      case 'filename':
        if (neg) bad();
        else c.filename.push(v);
        break;
      case 'larger':
      case 'smaller': {
        const n = parseSize(v);
        if (n === undefined || neg) bad();
        else c[key] = n;
        break;
      }
      case 'in':
      case 'label':
        if (neg) bad();
        else if (v.toLowerCase() === 'anywhere') c.anywhere = true;
        else c.folders.push(v);
        break;
      default:
        bad(`operator "${key}:" is not supported`);
    }
  }
  return { criteria: c, warnings };
}

export function mergeCriteria(a: Criteria, b: Partial<Criteria>): Criteria {
  const out: Criteria = { ...a };
  for (const [k, v] of Object.entries(b) as [keyof Criteria, unknown][]) {
    if (v === undefined) continue;
    (out as unknown as Record<string, unknown>)[k] = Array.isArray(v) ? [...((a[k] as unknown[]) ?? []), ...v] : v;
  }
  return out;
}

/** Server-side part of the criteria: one SEARCH per object, results ANDed (SearchObject can't repeat a key). */
function serverQueries(c: Criteria): SearchObject[] {
  const base: SearchObject = {};
  const extra: SearchObject[] = [];
  const add = (key: 'from' | 'to' | 'cc' | 'bcc' | 'subject', vals: string[]) => vals.forEach((v, i) => (i === 0 ? (base[key] = v) : extra.push({ [key]: v })));
  add('from', c.from);
  add('to', c.to);
  add('cc', c.cc);
  add('bcc', c.bcc);
  add('subject', c.subject);
  if (c.since) base.since = c.since;
  if (c.before) base.before = c.before;
  if (c.unread !== undefined) base.seen = !c.unread;
  if (c.flagged !== undefined) base.flagged = c.flagged;
  if (c.answered !== undefined) base.answered = c.answered;
  if (c.larger !== undefined) base.larger = c.larger;
  if (c.smaller !== undefined) base.smaller = c.smaller;
  if (c.uidRange) base.uid = c.uidRange;
  for (const v of c.notFrom) extra.push({ not: { from: v } });
  for (const v of c.notSubject) extra.push({ not: { subject: v } });
  for (const v of c.exclude) extra.push({ not: { or: [{ subject: v }, { from: v }] } });
  return [Object.keys(base).length ? base : { all: true }, ...extra];
}

export interface Budget {
  /** messages whose body may still be downloaded for keyword matching */
  bodies: number;
  deadline: number;
}
/**
 * Body downloads per call. Each costs roughly 0.5–1.5 ms CPU (fetch, transfer decoding, charset), so the default stays
 * small enough for the 10 ms Workers Free budget to be overrun only rarely; callers can raise maxScan.
 */
export const DEFAULT_SCAN = 25;
export const newBudget = (bodies = DEFAULT_SCAN, ms = 8_000): Budget => ({ bodies, deadline: Date.now() + ms });

/**
 * Downloads up to `maxBytes` of each message's text part and decodes it. mode "raw" leaves HTML unconverted
 * (enough for keyword matching, and much cheaper than turning it into text).
 */
export async function fetchTexts(c: ImapClient, uids: number[], maxBytes = 16_384, mode: 'text' | 'raw' = 'text'): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!uids.length) return out;
  const groups = new Map<string, { uid: number; node: MessageStructureObject }[]>();
  for (const m of await c.fetchAll(uids.join(','), { uid: true, bodyStructure: true }, { uid: true })) {
    const node = textPart(m.bodyStructure);
    if (!node) continue;
    const key = node.part ?? '1'; // a single-part message's body is BODY[1]
    const g = `${key}|${node.type}`;
    groups.set(g, [...(groups.get(g) ?? []), { uid: m.uid, node }]);
  }
  for (const [g, list] of groups) {
    const key = g.split('|')[0];
    const nodes = new Map(list.map((x) => [x.uid, x.node]));
    // HTML spends its first kilobytes on <head>/<style>, so it gets a bigger window.
    const max = list[0].node.type === 'text/html' ? Math.max(maxBytes * 3, 16_384) : maxBytes;
    for (const m of await c.fetchAll(list.map((x) => x.uid).join(','), { uid: true, bodyParts: [{ key, maxLength: max }] }, { uid: true })) {
      const raw = m.bodyParts?.get(key);
      if (raw) out.set(m.uid, decodePart(raw, nodes.get(m.uid)!, mode));
    }
  }
  return out;
}

const norm = (s = '') => s.normalize('NFC').toLowerCase();
const toDate = (d?: string | Date) => (d ? new Date(d) : undefined);

interface FolderResult {
  folder: string;
  matches: number[];
  /** stopped because the body-scan budget or time ran out (older candidates unchecked) */
  budgetHit: boolean;
  scannedBodies: number;
  /** newest UID whose body was not checked; a follow-up call resumes from here */
  resumeFrom?: number;
}

/** Newest-first matches in one folder, stopping at `need` matches or when the budget runs out. */
export async function searchFolder(c: ImapClient, folder: string, cr: Criteria, need: number, budget: Budget, warnings: string[]): Promise<FolderResult> {
  try {
    await c.mailboxOpen(folder, { readOnly: true });
  } catch (e) {
    // Renamed or deleted elsewhere (e.g. in Naver's web UI) while still in the folder cache: skip it, refresh the cache.
    invalidateFolders();
    warnings.push(`${folder}: cannot open (${(e as Error).message}); skipped`);
    return { folder, matches: [], budgetHit: false, scannedBodies: 0 };
  }
  const run = async (q: SearchObject) => {
    try {
      return new Set((await c.search(q, { uid: true })) || []);
    } catch (e) {
      warnings.push(`${folder}: search ${JSON.stringify(q)} failed: ${(e as Error).message}`);
      return new Set<number>();
    }
  };
  let cand: Set<number> | undefined;
  for (const q of serverQueries(cr)) {
    const r = await run(q);
    cand = cand ? new Set([...cand].filter((u) => r.has(u))) : r;
    if (!cand.size) break;
  }
  const sorted = [...(cand ?? [])].sort((a, b) => b - a);
  // Keyword k matches when subject/sender (server) or body (fetched here) contains it.
  const headerHits: Set<number>[] = [];
  for (const k of cr.keywords) headerHits.push(sorted.length ? await run({ or: [{ subject: k }, { from: k }] }) : new Set<number>());
  const needStructure = cr.hasAttachment !== undefined || cr.filename.length > 0;
  const matches: number[] = [];
  let scannedBodies = 0;
  let budgetHit = false;
  let resumeFrom: number | undefined;
  for (let i = 0; i < sorted.length && matches.length < need; i += 50) {
    let chunk = sorted.slice(i, i + 50);
    if (needStructure) {
      const s = await c.fetchAll(chunk.join(','), { uid: true, bodyStructure: true }, { uid: true });
      const names = new Map(s.map((m) => [m.uid, attachmentNames(m.bodyStructure)]));
      chunk = chunk.filter((u) => {
        const n = names.get(u) ?? [];
        if (cr.hasAttachment !== undefined && n.length > 0 !== cr.hasAttachment) return false;
        return cr.filename.every((f) => n.some((x) => norm(x).includes(norm(f))));
      });
    }
    if (cr.keywords.length) {
      const proven = (u: number) => headerHits.every((h) => h.has(u));
      const needBody = chunk.filter((u) => !proven(u));
      // Scan the newest bodies the budget allows; past it, keep only what the server proved (subject/sender).
      const allowed = Date.now() > budget.deadline ? 0 : budget.bodies;
      if (needBody.length > allowed) {
        budgetHit = true;
        resumeFrom ??= needBody[allowed];
      }
      const scan = needBody.slice(0, allowed);
      // Keywords almost always appear early; the first 6 KB (18 KB of HTML) keeps each body cheap.
      const texts = scan.length ? await fetchTexts(c, scan, 6_144, 'raw') : new Map<number, string>();
      budget.bodies -= scan.length;
      scannedBodies += scan.length;
      chunk = chunk.filter((u) => proven(u) || (texts.has(u) && cr.keywords.every((k, j) => headerHits[j].has(u) || norm(texts.get(u)).includes(norm(k)))));
    }
    matches.push(...chunk.slice(0, need - matches.length));
  }
  return { folder, matches, budgetHit, scannedBodies, resumeFrom };
}

export interface SearchOptions {
  folders?: string[] | 'all';
  includeTrashAndSpam?: boolean;
  limit?: number;
  offset?: number;
  snippets?: boolean;
  maxScan?: number;
  /** continue an incomplete body scan: start at this folder, UIDs ≤ fromUid, then the folders after it */
  resume?: { folder: string; fromUid: number };
}

const summary = (folder: string, m: FetchMessageObject) => ({
  folder,
  uid: m.uid,
  date: (m.envelope?.date ?? m.internalDate)?.toString(),
  from: fmt(m.envelope?.from).join(', '),
  to: fmt(m.envelope?.to).join(', '),
  subject: m.envelope?.subject,
  unread: !m.flags?.has('\\Seen'),
  flagged: !!m.flags?.has('\\Flagged'),
  answered: !!m.flags?.has('\\Answered'),
  size: m.size,
  attachments: attachmentNames(m.bodyStructure),
});
export type Summary = ReturnType<typeof summary> & { snippet?: string };

export async function targetFolders(c: ImapClient, cr: Criteria, o: SearchOptions) {
  if (cr.anywhere || o.folders === 'all' || (!o.folders && !cr.folders.length)) return searchableFolders(c, o.includeTrashAndSpam || cr.anywhere);
  const names = [...(Array.isArray(o.folders) ? o.folders : []), ...cr.folders];
  return Promise.all(names.map((f) => resolveFolder(c, f)));
}

export async function search(c: ImapClient, cr: Criteria, o: SearchOptions = {}, warnings: string[] = []) {
  const limit = o.limit ?? 20;
  const offset = o.offset ?? 0;
  const need = offset + limit;
  const budget = newBudget(o.maxScan);
  let folders = await targetFolders(c, cr, o);
  if (o.resume) {
    const at = folders.indexOf(await resolveFolder(c, o.resume.folder));
    if (at < 0) throw new Error(`resume.folder ${o.resume.folder} is not among the searched folders`);
    folders = folders.slice(at);
  }
  const results: FolderResult[] = [];
  // Ordering: within a folder UIDs follow arrival; across folders, merge on INTERNALDATE (arrival time).
  const order: { folder: string; uid: number; at: number }[] = [];
  for (const folder of folders) {
    const scoped = o.resume && folder === folders[0] ? { ...cr, uidRange: `1:${o.resume.fromUid}` } : cr;
    const r = await searchFolder(c, folder, scoped, need, budget, warnings);
    results.push(r);
    if (!r.matches.length) continue;
    if (folders.length === 1) r.matches.forEach((uid, i) => order.push({ folder, uid, at: -i }));
    else for (const m of await c.fetchAll(r.matches.join(','), { uid: true, internalDate: true }, { uid: true })) order.push({ folder, uid: m.uid, at: m.internalDate?.getTime() ?? 0 });
  }
  order.sort((a, b) => b.at - a.at);
  const chosen = order.slice(offset, offset + limit);
  // Details only for the page being returned.
  const page: Summary[] = [];
  for (const folder of new Set(chosen.map((x) => x.folder))) {
    await c.mailboxOpen(folder, { readOnly: true });
    const uids = chosen.filter((x) => x.folder === folder).map((x) => x.uid);
    const details = await c.fetchAll(uids.join(','), { uid: true, envelope: true, flags: true, size: true, bodyStructure: true }, { uid: true });
    const mine: Summary[] = details.map((m) => summary(folder, m));
    if (o.snippets) {
      const texts = await fetchTexts(c, uids, 1024);
      for (const p of mine) p.snippet = texts.get(p.uid)?.replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    page.push(...mine);
  }
  const rank = new Map(chosen.map((x, i) => [`${x.folder}\0${x.uid}`, i]));
  page.sort((a, b) => rank.get(`${a.folder}\0${a.uid}`)! - rank.get(`${b.folder}\0${b.uid}`)!);
  const items = order;
  const complete = !results.some((r) => r.budgetHit);
  const stop = results.find((r) => r.budgetHit && r.resumeFrom !== undefined);
  return {
    messages: page,
    // A folder that filled `need` may hold more; a budget stop may hide more.
    hasMore: !complete || items.length > offset + limit || results.some((r) => r.matches.length >= need),
    nextOffset: offset + page.length,
    complete,
    searchedFolders: folders,
    scannedBodies: results.reduce((n, r) => n + r.scannedBodies, 0),
    ...(warnings.length && { warnings }),
    ...(stop && { resume: { folder: stop.folder, fromUid: stop.resumeFrom! } }),
    ...(!complete && {
      note: 'Body scan budget reached: older messages were checked by subject/sender only. To check their bodies too, call again with resume (and offset 0), narrow the query (dates, folder), or raise maxScan.',
    }),
  };
}

/** All matching refs (for bulk actions), capped. Body keywords respect the same budget. */
export async function matchAll(c: ImapClient, cr: Criteria, o: SearchOptions, cap: number, warnings: string[]) {
  const budget = newBudget(o.maxScan, 25_000);
  const refs: Ref[] = [];
  let complete = true;
  for (const folder of await targetFolders(c, cr, o)) {
    const r = await searchFolder(c, folder, cr, cap + 1 - refs.length, budget, warnings);
    refs.push(...r.matches.map((uid) => ({ folder, uid })));
    complete &&= !r.budgetHit;
    if (refs.length > cap) break;
  }
  return { refs, complete };
}

// ---------- threads ----------

const ids = (s?: string) => (s ?? '').match(/<[^>]+>/g) ?? [];
const baseSubject = (s = '') => s.replace(/^(\s*(re|fwd?|회신|전달|답장)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();

/** Conversation = messages connected through Message-ID / In-Reply-To / References, across folders. */
export async function getThread(c: ImapClient, folder: string, uid: number, maxMessages = 30) {
  const start = await resolveFolder(c, folder);
  await c.mailboxOpen(start, { readOnly: true });
  const first = await c.fetchOne(String(uid), { uid: true, envelope: true, headers: ['references', 'in-reply-to'] }, { uid: true });
  if (!first) throw new Error(`Message uid ${uid} not found in ${folder}`);
  const seedIds = new Set([first.envelope?.messageId, ...ids(first.headers?.toString())].filter(Boolean) as string[]);
  const subject = baseSubject(first.envelope?.subject);
  type Node = { folder: string; uid: number; msgId?: string; refs: string[]; date?: Date; envelope: FetchMessageObject['envelope'] };
  const nodes: Node[] = [{ folder: start, uid, msgId: first.envelope?.messageId, refs: ids(first.headers?.toString()), date: toDate(first.envelope?.date), envelope: first.envelope }];
  // Naver: HEADER search works for Message-ID only (References/In-Reply-To return nothing, and OR over HEADER
  // returns nothing). So ancestors are found by their Message-ID, descendants by the shared base subject.
  const queries: SearchObject[] = [...seedIds].map((id) => ({ header: { 'message-id': id } }));
  if (subject) queries.push({ subject });
  for (const f of await searchableFolders(c)) {
    await c.mailboxOpen(f, { readOnly: true });
    const found = new Set<number>();
    for (const q of queries) for (const u of (await c.search(q, { uid: true }).catch(() => [])) || []) found.add(u);
    const fresh = [...found].filter((u) => !(f === start && u === uid)).sort((a, b) => a - b);
    if (!fresh.length) continue;
    for (const m of await c.fetchAll(fresh.slice(-500).join(','), { uid: true, envelope: true, headers: ['references', 'in-reply-to'] }, { uid: true }))
      nodes.push({ folder: f, uid: m.uid, msgId: m.envelope?.messageId, refs: ids(m.headers?.toString()), date: toDate(m.envelope?.date), envelope: m.envelope });
  }
  // Grow the conversation from the seed ids; subject matches only count when they link by id.
  const known = new Set(seedIds);
  const inThread = new Set<Node>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of nodes) {
      if (inThread.has(n)) continue;
      if ((n.msgId && known.has(n.msgId)) || n.refs.some((r) => known.has(r))) {
        inThread.add(n);
        for (const r of [n.msgId, ...n.refs]) if (r && !known.has(r)) known.add(r);
        grew = true;
      }
    }
  }
  // Same message stored twice (e.g. a self-sent copy in INBOX and Sent) shows once per folder; keep both refs.
  const list = [...inThread].sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0)).slice(-maxMessages);
  const messages = [];
  for (const f of new Set(list.map((n) => n.folder))) {
    await c.mailboxOpen(f, { readOnly: true });
    const mine = list.filter((n) => n.folder === f);
    const texts = await fetchTexts(c, mine.map((n) => n.uid), 65_536);
    for (const n of mine) messages.push({ folder: f, uid: n.uid, messageId: n.msgId, date: n.date, from: fmt(n.envelope?.from).join(', '), to: fmt(n.envelope?.to), subject: n.envelope?.subject, text: clip(texts.get(n.uid) ?? '', 8000) });
  }
  messages.sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
  return { subject, count: messages.length, messages };
}

// ---------- people ----------

/** Newest `perFolder` messages per folder with only the named headers: far lighter than ENVELOPE. */
async function headerScan(c: ImapClient, folders: string[], fields: string[], perFolder: number, since?: Date) {
  const out: { folder: string; uid: number; unread: boolean; at?: Date; h: Record<string, string> }[] = [];
  for (const f of folders) {
    await c.mailboxOpen(f, { readOnly: true });
    const uids = ((await c.search(since ? { since } : { all: true }, { uid: true })) || []).sort((a, b) => b - a).slice(0, perFolder);
    if (uids.length)
      for (const m of await c.fetchAll(uids.join(','), { uid: true, flags: true, internalDate: true, headers: fields }, { uid: true }))
        out.push({ folder: f, uid: m.uid, unread: !m.flags?.has('\\Seen'), at: m.internalDate, h: headerMap(m.headers) });
  }
  return out;
}

export const DEFAULT_PEOPLE_WINDOW = 150;

/** Who mails you most (optionally only unread / since a date): useful for cleanup and unsubscribes. */
export async function senderStats(c: ImapClient, folders: string[], o: { since?: Date; unreadOnly?: boolean; perFolder?: number; top?: number }) {
  const rows = await headerScan(c, folders, ['from', 'subject'], o.perFolder ?? DEFAULT_PEOPLE_WINDOW, o.since);
  const stats = new Map<string, { address: string; name?: string; count: number; unread: number; latest?: Date; latestSubject?: string }>();
  for (const r of rows) {
    if (o.unreadOnly && !r.unread) continue;
    for (const a of parseAddresses(r.h.from)) {
      const k = a.address.toLowerCase();
      const s = stats.get(k) ?? { address: a.address, name: a.name, count: 0, unread: 0 };
      s.count++;
      if (r.unread) s.unread++;
      if (r.at && (!s.latest || r.at > s.latest)) (s.latest = r.at), (s.latestSubject = r.h.subject);
      stats.set(k, s);
    }
  }
  const all = [...stats.values()].sort((a, b) => b.count - a.count);
  return { scannedMessages: rows.length, senders: all.length, top: all.slice(0, o.top ?? 30), note: `Newest ${o.perFolder ?? DEFAULT_PEOPLE_WINDOW} per folder; raise perFolder or set since for more.` };
}

/** Address book built from mail you sent and received, ranked by how often you wrote to them. */
export async function findContacts(c: ImapClient, sent: string, query = '', limit = 20, perFolder = DEFAULT_PEOPLE_WINDOW) {
  const q = norm(query);
  const people = new Map<string, { address: string; name?: string; sentTo: number; receivedFrom: number; last?: Date }>();
  const bump = (a: { name?: string; address: string }, key: 'sentTo' | 'receivedFrom', d?: Date) => {
    const k = a.address.toLowerCase();
    const p = people.get(k) ?? { address: a.address, name: a.name, sentTo: 0, receivedFrom: 0 };
    p[key]++;
    p.name ||= a.name;
    if (d && (!p.last || d > p.last)) p.last = d;
    people.set(k, p);
  };
  for (const r of await headerScan(c, [sent], ['to', 'cc'], perFolder)) for (const a of [...parseAddresses(r.h.to), ...parseAddresses(r.h.cc)]) bump(a, 'sentTo', r.at);
  for (const r of await headerScan(c, ['INBOX'], ['from'], perFolder)) for (const a of parseAddresses(r.h.from)) bump(a, 'receivedFrom', r.at);
  const hits = [...people.values()].filter((p) => !q || norm(p.address).includes(q) || norm(p.name).includes(q));
  hits.sort((a, b) => b.sentTo * 3 + b.receivedFrom - (a.sentTo * 3 + a.receivedFrom));
  return { contacts: hits.slice(0, limit) };
}
