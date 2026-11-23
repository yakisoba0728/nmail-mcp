import { Buffer } from 'node:buffer';
import type { ImapClient } from './imap';
import * as mail from './mail';
import { addressesOf, headerMap } from './mime';
import * as organize from './organize';
import * as send from './send';
import * as search from './search';

/**
 * Cron-driven features: scheduled send, filing rules, vacation responder.
 * State lives in the OAUTH_KV namespace under "app:" (the OAuth library uses its own prefixes).
 * Free-plan KV allows ~1000 writes and ~1000 list calls a day, so the every-minute cron only reads,
 * and writes happen only when something actually changes.
 */
export interface AutoEnv extends mail.MailEnv {
  OAUTH_KV: KVNamespace;
}

const K = {
  schedule: 'app:schedule',
  job: (id: string, part: 'raw' | 'meta' | 'status') => `app:job:${id}:${part}`,
  rules: 'app:rules',
  vacation: 'app:vacation',
  replied: 'app:vacation:replied',
  watch: 'app:watch',
};
const getJson = async <T>(kv: KVNamespace, key: string, fallback: T): Promise<T> => (await kv.get<T>(key, 'json')) ?? fallback;
const putJson = (kv: KVNamespace, key: string, v: unknown) => kv.put(key, JSON.stringify(v));

/** "2026-11-25 09:00" without an offset means Korea time; "Z" or "+hh:mm" is honoured. */
export function parseWhen(s: string): Date {
  const t = s.trim().replace(' ', 'T');
  const d = new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t.length === 10 ? `${t}T00:00` : t}+09:00`);
  if (Number.isNaN(d.getTime())) throw new Error(`Cannot read the time "${s}"; use YYYY-MM-DD HH:mm (KST) or ISO 8601`);
  return d;
}
const kst = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 16) + ' KST';

// ---------- scheduled send ----------

interface Job {
  id: string;
  sendAt: string;
  createdAt: string;
  subject?: string;
  to: string[];
}

export async function scheduleEmail(env: AutoEnv, c: ImapClient, m: send.Compose, sendAt: string) {
  const when = parseWhen(sendAt);
  const now = Date.now();
  if (when.getTime() < now - 60_000) throw new Error(`sendAt ${kst(when)} is in the past`);
  if (when.getTime() > now + 366 * 86400_000) throw new Error('sendAt must be within a year');
  const msg = await send.composeFull(env, c, m);
  const id = crypto.randomUUID().slice(0, 8);
  await env.OAUTH_KV.put(K.job(id, 'raw'), msg.raw);
  await putJson(env.OAUTH_KV, K.job(id, 'meta'), { from: msg.from, rcpts: msg.to });
  const jobs = await getJson<Job[]>(env.OAUTH_KV, K.schedule, []);
  jobs.push({ id, sendAt: when.toISOString(), createdAt: new Date().toISOString(), subject: m.subject, to: msg.to });
  await putJson(env.OAUTH_KV, K.schedule, jobs);
  return { scheduled: true, id, sendAt: kst(when), recipients: msg.to, note: 'Sent by the server within about a minute of sendAt.' };
}

export async function listScheduled(env: AutoEnv) {
  const jobs = await getJson<Job[]>(env.OAUTH_KV, K.schedule, []);
  return Promise.all(jobs.map(async (j) => ({ ...j, sendAt: kst(new Date(j.sendAt)), status: (await env.OAUTH_KV.get(K.job(j.id, 'status'))) ?? 'pending' })));
}

export async function cancelScheduled(env: AutoEnv, id: string) {
  const jobs = await getJson<Job[]>(env.OAUTH_KV, K.schedule, []);
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new Error(`No scheduled email with id ${id}`);
  const status = await env.OAUTH_KV.get(K.job(id, 'status'));
  // A job removed from the list is never sent; only "sending" or "sent" can no longer be stopped.
  if (status === 'sending' || status === 'sent') throw new Error(`Too late: the email is already ${status}`);
  await putJson(env.OAUTH_KV, K.schedule, jobs.filter((j) => j.id !== id));
  await Promise.all((['raw', 'meta', 'status'] as const).map((p) => env.OAUTH_KV.delete(K.job(id, p))));
  return { cancelled: id };
}

/** Removes finished jobs older than 7 days from the list (called by tools, never by cron). */
export async function pruneScheduled(env: AutoEnv) {
  const jobs = await getJson<Job[]>(env.OAUTH_KV, K.schedule, []);
  const keep: Job[] = [];
  for (const j of jobs) {
    const st = await env.OAUTH_KV.get(K.job(j.id, 'status'));
    if (st && st !== 'sending' && Date.parse(j.sendAt) < Date.now() - 7 * 86400_000) await env.OAUTH_KV.delete(K.job(j.id, 'status'));
    else keep.push(j);
  }
  if (keep.length !== jobs.length) await putJson(env.OAUTH_KV, K.schedule, keep);
}

async function sendDueJobs(env: AutoEnv) {
  const jobs = await getJson<Job[]>(env.OAUTH_KV, K.schedule, []);
  const due: Job[] = [];
  for (const j of jobs) if (Date.parse(j.sendAt) <= Date.now() && !(await env.OAUTH_KV.get(K.job(j.id, 'status')))) due.push(j);
  if (!due.length) return;
  await mail.withImap(env, async (c) => {
    for (const j of due) {
      // Marked before SMTP and never retried from "sending": a stuck job is visible, a duplicate email is not undoable.
      await env.OAUTH_KV.put(K.job(j.id, 'status'), 'sending');
      try {
        const raw = await env.OAUTH_KV.get(K.job(j.id, 'raw'), 'arrayBuffer');
        const meta = await getJson<{ from: string; rcpts: string[] } | null>(env.OAUTH_KV, K.job(j.id, 'meta'), null);
        if (!raw || !meta) throw new Error('stored message is missing');
        await send.smtp(env, meta.from, meta.rcpts, Buffer.from(raw));
        await env.OAUTH_KV.put(K.job(j.id, 'status'), 'sent');
        await send.appendToSent(c, Buffer.from(raw));
        await env.OAUTH_KV.delete(K.job(j.id, 'raw'));
      } catch (e) {
        await env.OAUTH_KV.put(K.job(j.id, 'status'), `failed: ${(e as Error).message}`.slice(0, 500));
      }
    }
  });
}

// ---------- new-mail watermark ----------

interface Watch {
  uidValidity: string;
  lastUid: number;
}

/**
 * Position of the newest INBOX message already handled. `reset` moves it to "now": used when the first
 * rule or the responder is turned on, so a backlog that arrived while everything was off is never acted on.
 */
export async function ensureWatch(env: AutoEnv, c: ImapClient, reset = false) {
  const box = await c.mailboxOpen('INBOX', { readOnly: true });
  const cur = await getJson<Watch | null>(env.OAUTH_KV, K.watch, null);
  if (!reset && cur && cur.uidValidity === String(box.uidValidity)) return cur;
  // Naver's UIDNEXT can lag behind existing UIDs (UIDs are account-wide there), so take the real maximum too.
  const highest = Math.max(0, ...((await c.search({ all: true }, { uid: true })) || []));
  const w = { uidValidity: String(box.uidValidity), lastUid: Math.max(Number(box.uidNext) - 1, highest) };
  await putJson(env.OAUTH_KV, K.watch, w);
  return w;
}

/** True while the cron keeps the watermark moving (any rule, or a responder set even if not started yet). */
async function watching(env: AutoEnv) {
  return (await getJson<Rule[]>(env.OAUTH_KV, K.rules, [])).length > 0 || !!(await env.OAUTH_KV.get(K.vacation));
}

// ---------- rules ----------

export interface Rule {
  id: string;
  name: string;
  query: string;
  markRead?: boolean;
  flag?: boolean;
  moveTo?: string;
  trash?: boolean;
  createdAt: string;
}

export async function createRule(env: AutoEnv, c: ImapClient, r: Omit<Rule, 'id' | 'createdAt'>) {
  if (!r.query.trim()) throw new Error('A rule needs a query; an empty one would match every email');
  const { warnings, criteria } = search.parseQuery(r.query);
  if (warnings.length) throw new Error(`Rule query not accepted: ${warnings.join('; ')}`);
  if (criteria.folders.length || criteria.anywhere) throw new Error('Rules only watch new INBOX mail; remove in:/label: from the query');
  if (!r.markRead && !r.flag && !r.moveTo && !r.trash) throw new Error('Give at least one action: markRead, flag, moveTo or trash');
  if (r.moveTo && r.trash) throw new Error('Choose moveTo or trash, not both');
  const moveTo = r.moveTo ? await mail.resolveFolder(c, r.moveTo) : undefined;
  if (moveTo && !(await mail.folderList(c)).some((f) => f.path === moveTo)) throw new Error(`Folder ${r.moveTo} does not exist; create it with manage_folder first`);
  await ensureWatch(env, c, !(await watching(env)));
  const rules = await getJson<Rule[]>(env.OAUTH_KV, K.rules, []);
  const rule: Rule = { ...r, moveTo, id: crypto.randomUUID().slice(0, 8), createdAt: new Date().toISOString() };
  rules.push(rule);
  await putJson(env.OAUTH_KV, K.rules, rules);
  return { created: rule, note: 'Applies to new INBOX mail, checked every 5 minutes. For existing mail use bulk_action with the same query.' };
}

export async function deleteRule(env: AutoEnv, id: string) {
  const rules = await getJson<Rule[]>(env.OAUTH_KV, K.rules, []);
  if (!rules.some((r) => r.id === id)) throw new Error(`No rule with id ${id}`);
  await putJson(env.OAUTH_KV, K.rules, rules.filter((r) => r.id !== id));
  return { deleted: id };
}

// ---------- vacation responder (RFC 3834) ----------

export interface Vacation {
  enabled: boolean;
  subject?: string;
  text: string;
  start: string;
  end: string;
  /** reply to the same sender at most once per this many days */
  days: number;
}

export async function setVacation(env: AutoEnv, c: ImapClient, v: { enabled: boolean; subject?: string; text?: string; start?: string; end?: string; days?: number }) {
  if (!v.enabled) {
    await env.OAUTH_KV.delete(K.vacation);
    return { enabled: false };
  }
  if (!v.text) throw new Error('text is required');
  if (!v.end) throw new Error('end is required, so an auto-reply can never run forever');
  const start = v.start ? parseWhen(v.start) : new Date();
  const end = parseWhen(v.end);
  if (end <= start) throw new Error('end must be after start');
  if (end.getTime() > Date.now() + 366 * 86400_000) throw new Error('end must be within a year');
  await ensureWatch(env, c, !(await watching(env)));
  const vac: Vacation = { enabled: true, subject: v.subject, text: v.text, start: start.toISOString(), end: end.toISOString(), days: v.days ?? 4 };
  await putJson(env.OAUTH_KV, K.vacation, vac);
  return { enabled: true, start: kst(start), end: kst(end), oncePerSenderDays: vac.days };
}

/** The address to auto-reply to, or undefined when RFC 3834 says not to (lists, bots, auto-replies, yourself). */
export function autoReplyTarget(from: string | undefined, h: Record<string, string>, me: string): string | undefined {
  const addr = from?.toLowerCase();
  if (!addr || addr === me.toLowerCase()) return;
  if (/^(mailer-daemon|postmaster|.*no-?reply|.*do-?not-?reply|bounce)/i.test(addr.split('@')[0])) return;
  if (h['auto-submitted'] && !/^no\b/i.test(h['auto-submitted'])) return;
  if (/bulk|list|junk|auto_reply/i.test(h['precedence'] ?? '')) return;
  if (h['list-id'] || h['list-unsubscribe'] || h['x-auto-response-suppress'] || h['return-path'] === '<>') return;
  return addr;
}

// ---------- the cron ----------

const POLL_HEADERS = ['auto-submitted', 'precedence', 'list-id', 'list-unsubscribe', 'x-auto-response-suppress', 'return-path'];

async function processNewMail(env: AutoEnv) {
  const rules = await getJson<Rule[]>(env.OAUTH_KV, K.rules, []);
  let vac = await getJson<Vacation | null>(env.OAUTH_KV, K.vacation, null);
  if (vac && Date.parse(vac.end) < Date.now()) {
    await env.OAUTH_KV.delete(K.vacation);
    vac = null;
  }
  // A responder that has not started yet still keeps the watermark moving, so it never answers older mail.
  if (!rules.length && !vac) return;
  await mail.withImap(env, async (c) => {
    const w = await ensureWatch(env, c);
    await c.mailboxOpen('INBOX');
    const range = `${w.lastUid + 1}:*`;
    // "n:*" always includes the newest message, even when it is older than n.
    const fresh = (((await c.search({ uid: range }, { uid: true })) || []) as number[]).filter((u) => u > w.lastUid).sort((a, b) => a - b);
    if (!fresh.length) return;
    const me = mail.account(env).email;
    if (vac && Date.parse(vac.start) <= Date.now()) {
      const replied = await getJson<Record<string, number>>(env.OAUTH_KV, K.replied, {});
      let sentThisRun = 0;
      for (const m of await c.fetchAll(fresh.join(','), { uid: true, envelope: true, internalDate: true, headers: POLL_HEADERS }, { uid: true })) {
        if (sentThisRun >= 20) break; // a flood of mail must not turn into a flood of replies
        const arrived = m.internalDate ? new Date(m.internalDate).getTime() : 0;
        if (arrived < Date.parse(vac.start)) continue; // only mail that arrived during the vacation
        const to = autoReplyTarget(addressesOf(m.envelope?.from)[0]?.address, headerMap(m.headers), me);
        if (!to || (replied[to] && Date.now() - replied[to] < vac.days * 86400_000)) continue;
        try {
          const msg = await send.compose(
            env,
            { to: [to], subject: vac.subject ?? `Re: ${m.envelope?.subject ?? ''}`, text: vac.text },
            { inReplyTo: m.envelope?.messageId, references: m.envelope?.messageId ? [m.envelope.messageId] : undefined, headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All', Precedence: 'auto_reply' } },
          );
          // Recorded before sending: a crash after SMTP must not lead to a second reply on the next run.
          replied[to] = Date.now();
          await putJson(env.OAUTH_KV, K.replied, replied);
          sentThisRun++;
          await send.smtp(env, msg.from, msg.to, msg.raw);
          await send.appendToSent(c, msg.raw);
        } catch {
          // A failed auto-reply is skipped, not retried, to avoid repeated mail to the same sender.
        }
      }
      const stale = Object.keys(replied).filter((k) => Date.now() - replied[k] > 30 * 86400_000);
      if (stale.length) {
        for (const k of stale) delete replied[k];
        await putJson(env.OAUTH_KV, K.replied, replied);
      }
    }
    // Rules run in order; a message that a rule moved or trashed is not seen by later rules.
    let pending = new Set(fresh);
    for (const r of rules) {
      if (!pending.size) break;
      const { criteria } = search.parseQuery(r.query);
      const warnings: string[] = [];
      const res = await search.searchFolder(c, 'INBOX', { ...criteria, uidRange: range }, 5000, search.newBudget(200), warnings);
      const hit = res.matches.filter((u) => pending.has(u));
      if (!hit.length) continue;
      const refs = hit.map((uid) => ({ folder: 'INBOX', uid }));
      try {
        if (r.markRead || r.flag) await organize.setFlags(c, refs, { ...(r.markRead && { read: true }), ...(r.flag && { flagged: true }) });
        if (r.moveTo) await organize.moveEmails(c, refs, r.moveTo);
        if (r.trash) await organize.deleteEmails(c, refs, false);
        if (r.moveTo || r.trash) pending = new Set([...pending].filter((u) => !hit.includes(u)));
      } catch {
        // e.g. the target folder was deleted: skip this rule this round, keep the others working.
      }
    }
    await putJson(env.OAUTH_KV, K.watch, { ...w, lastUid: fresh[fresh.length - 1] });
  });
}

export async function runCron(env: AutoEnv, cron: string) {
  if (cron === '*/5 * * * *') await processNewMail(env);
  else await sendDueJobs(env);
}

export async function listAutomations(env: AutoEnv) {
  await pruneScheduled(env);
  const vac = await getJson<Vacation | null>(env.OAUTH_KV, K.vacation, null);
  return {
    scheduledEmails: await listScheduled(env),
    rules: await getJson<Rule[]>(env.OAUTH_KV, K.rules, []),
    vacation: vac ? { ...vac, start: kst(new Date(vac.start)), end: kst(new Date(vac.end)), active: Date.parse(vac.start) <= Date.now() } : { enabled: false },
  };
}
