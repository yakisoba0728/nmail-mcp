import { Buffer } from 'node:buffer';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { Address } from 'postal-mime';
import type { ImapClient } from './imap';
import { MAX_MESSAGE_BYTES, SMTP, account, resolveFolder, specialFolder, type MailEnv } from './mail';
import { attachmentNodes, fmt, headerMap, icsLine, icsValue, unfold } from './mime';
import { bodyText, fetchSource, getAttachment, icsOf, parseMail } from './read';
import { smtpSend } from './smtp';

export interface Compose {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  attachments?: { filename: string; contentBase64: string; mimeType?: string; contentId?: string }[];
  /** Re-attach files from existing emails (all attachments unless indexes given) */
  attachFrom?: { folder: string; uid: number; indexes?: number[] }[];
  replyTo?: string[];
  priority?: 'high' | 'normal' | 'low';
  readReceipt?: boolean;
  signature?: boolean;
}
type RawAttachment = { filename?: string; content: Buffer; contentType?: string; cid?: string };
type Extra = { inReplyTo?: string; references?: string[]; raw?: RawAttachment[]; icalEvent?: { method: string; content: string }; headers?: Record<string, string> };

const PRIORITY = {
  high: { 'X-Priority': '1 (Highest)', 'X-MSMail-Priority': 'High', Importance: 'High' },
  low: { 'X-Priority': '5 (Lowest)', 'X-MSMail-Priority': 'Low', Importance: 'Low' },
};

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
const textToHtml = (s: string) => escapeHtml(s).replace(/\n/g, '<br>');

/** Adds the signature (NAVER_SIGNATURE) to the user's own text, before any quoted original. */
function signed(env: MailEnv, m: Compose): Compose {
  const sig = env.NAVER_SIGNATURE?.replace(/\\n/g, '\n');
  if (!sig || m.signature === false) return m;
  return {
    ...m,
    text: m.text !== undefined || m.html === undefined ? `${m.text ?? ''}\n\n-- \n${sig}` : undefined,
    html: m.html !== undefined ? `${m.html}<br><br>-- <br>${textToHtml(sig)}` : undefined,
  };
}

async function attachmentsFrom(c: ImapClient, list: Compose['attachFrom']): Promise<RawAttachment[]> {
  const out: RawAttachment[] = [];
  for (const src of list ?? []) {
    await c.mailboxOpen(await resolveFolder(c, src.folder), { readOnly: true });
    const m = await c.fetchOne(String(src.uid), { uid: true, bodyStructure: true }, { uid: true });
    if (!m) throw new Error(`attachFrom: message uid ${src.uid} not found in ${src.folder}`);
    const count = attachmentNodes(m.bodyStructure).length;
    for (const i of src.indexes ?? [...Array(count).keys()]) {
      const f = await getAttachment(c, src.folder, src.uid, i);
      out.push({ filename: f.filename, content: f.bytes, contentType: f.mimeType });
    }
  }
  return out;
}

/** Builds the MIME message; Bcc stays in the SMTP envelope only (kept as a header for drafts). */
export async function compose(env: MailEnv, m: Compose, x: Extra = {}, keepBcc = false) {
  const a = account(env);
  const node = new MailComposer({
    from: a.name ? { name: a.name, address: a.email } : a.email,
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    replyTo: m.replyTo,
    subject: m.subject,
    text: m.text,
    html: m.html,
    inReplyTo: x.inReplyTo,
    references: x.references,
    icalEvent: x.icalEvent,
    headers: {
      ...(m.readReceipt && { 'Disposition-Notification-To': a.email }),
      // MailComposer ignores `priority` (nodemailer applies it in the mailer layer), so set the headers here.
      ...(m.priority && m.priority !== 'normal' && PRIORITY[m.priority]),
      ...x.headers,
    },
    attachments: [
      ...(m.attachments ?? []).map((f) => ({ filename: f.filename, content: Buffer.from(f.contentBase64, 'base64'), contentType: f.mimeType, cid: f.contentId })),
      ...(x.raw ?? []),
    ],
  }).compile();
  node.keepBcc = keepBcc;
  const raw = await node.build();
  if (raw.length > MAX_MESSAGE_BYTES) throw new Error(`Message is larger than ${MAX_MESSAGE_BYTES} bytes`);
  const envelope = node.getEnvelope();
  return { raw, from: envelope.from || a.email, to: envelope.to, messageId: node.messageId() };
}

export async function appendToSent(c: ImapClient, raw: Buffer) {
  try {
    const folder = await specialFolder(c, '\\Sent');
    await c.append(folder, raw, ['\\Seen']);
    return { savedTo: folder };
  } catch (e) {
    return { warning: `Sent, but saving a copy to Sent failed: ${(e as Error).message}` };
  }
}

export async function smtp(env: MailEnv, from: string, to: string[], raw: Buffer) {
  const a = account(env);
  await smtpSend({ ...SMTP, user: a.login, pass: a.pass }, from, to, raw);
}

/** SMTP send then APPEND to Sent (Naver does not store SMTP-sent mail), or save as a draft. */
export async function deliver(env: MailEnv, c: ImapClient, m: Compose, x: Extra = {}, asDraft = false) {
  const full: Extra = { ...x, raw: [...(x.raw ?? []), ...(await attachmentsFrom(c, m.attachFrom))] };
  if (asDraft) return saveDraftRaw(c, (await compose(env, m, full, true)).raw);
  const msg = await compose(env, m, full);
  await smtp(env, msg.from, msg.to, msg.raw);
  return { sent: true, messageId: msg.messageId, recipients: msg.to, ...(await appendToSent(c, msg.raw)) };
}

export const send = (env: MailEnv, c: ImapClient, m: Compose) => deliver(env, c, signed(env, m));

/** Full outgoing message (signature + attachFrom) without sending: used for scheduled mail. */
export async function composeFull(env: MailEnv, c: ImapClient, m: Compose) {
  return compose(env, signed(env, m), { raw: await attachmentsFrom(c, m.attachFrom) });
}

const prefixed = (p: string, s = '') => (new RegExp(`^${p}:`, 'i').test(s) ? s : `${p}: ${s}`);

export async function reply(env: MailEnv, c: ImapClient, folder: string, uid: number, r: Compose & { replyAll?: boolean; asDraft?: boolean }) {
  const o = await parseMail(await fetchSource(c, folder, uid));
  const me = account(env).email.toLowerCase();
  const others = (l?: Address[]) => fmt(l).filter((s) => !s.toLowerCase().includes(me));
  const to = r.to ?? (o.replyTo?.length ? fmt(o.replyTo) : fmt(o.from ? [o.from] : []));
  const cc = r.cc ?? (r.replyAll ? [...others(o.to), ...others(o.cc)].filter((s) => !to.includes(s)) : undefined);
  const s = signed(env, r);
  const head = `${o.date ?? ''} ${fmt(o.from ? [o.from] : [])[0] ?? ''} wrote:`;
  const res = await deliver(
    env,
    c,
    {
      ...s,
      to,
      cc,
      subject: prefixed('Re', o.subject),
      text: s.text !== undefined ? `${s.text}\n\n${head}\n${bodyText(o).replace(/^/gm, '> ')}` : undefined,
      html: s.html !== undefined ? `${s.html}<br><br>${escapeHtml(head)}<blockquote>${o.html ?? textToHtml(bodyText(o))}</blockquote>` : undefined,
    },
    { inReplyTo: o.messageId, references: [...(o.references?.split(/\s+/).filter(Boolean) ?? []), ...(o.messageId ? [o.messageId] : [])] },
    r.asDraft,
  );
  // The mail is already sent: never fail the call (and invite a duplicate resend) over the flag.
  if (!r.asDraft) await c.mailboxOpen(await resolveFolder(c, folder)).then(() => c.messageFlagsAdd(String(uid), ['\\Answered'], { uid: true })).catch(() => {});
  return res;
}

export async function forward(env: MailEnv, c: ImapClient, folder: string, uid: number, f: Compose & { asDraft?: boolean }) {
  const o = await parseMail(await fetchSource(c, folder, uid));
  const head = ['---------- Forwarded message ----------', `From: ${fmt(o.from ? [o.from] : []).join(', ')}`, `Date: ${o.date ?? ''}`, `Subject: ${o.subject ?? ''}`, `To: ${fmt(o.to).join(', ')}`];
  const s = signed(env, f);
  return deliver(
    env,
    c,
    {
      ...s,
      subject: prefixed('Fwd', o.subject),
      text: `${s.text ?? ''}\n\n${head.join('\n')}\n\n${bodyText(o)}`,
      html: o.html || s.html ? `${s.html ?? textToHtml(s.text ?? '')}<br><br>${head.map(escapeHtml).join('<br>')}<br><br>${o.html ?? textToHtml(bodyText(o))}` : undefined,
    },
    { raw: o.attachments.map((x) => ({ filename: x.filename ?? undefined, content: Buffer.from(x.content as ArrayBuffer), contentType: x.mimeType, cid: x.contentId?.replace(/[<>]/g, '') })) },
    f.asDraft,
  );
}

// ---------- drafts ----------

async function saveDraftRaw(c: ImapClient, raw: Buffer) {
  const folder = await specialFolder(c, '\\Drafts');
  const res = await c.append(folder, raw, ['\\Draft', '\\Seen']);
  return { draft: true, folder, uid: res ? res.uid : undefined };
}

export const saveDraft = (env: MailEnv, c: ImapClient, m: Compose) => deliver(env, c, signed(env, m), {}, true);

/** Re-reads a draft into compose fields, keeping its attachments and threading headers. */
async function draftFields(c: ImapClient, uid: number) {
  const o = await parseMail(await fetchSource(c, 'drafts', uid));
  const fields: Compose = { to: fmt(o.to), cc: fmt(o.cc), bcc: fmt(o.bcc), subject: o.subject, text: o.text, html: o.html, replyTo: fmt(o.replyTo), signature: false };
  const extra: Extra = {
    inReplyTo: o.inReplyTo,
    references: o.references?.split(/\s+/).filter(Boolean),
    raw: o.attachments.map((x) => ({ filename: x.filename ?? undefined, content: Buffer.from(x.content as ArrayBuffer), contentType: x.mimeType, cid: x.contentId?.replace(/[<>]/g, '') })),
  };
  return { fields, extra };
}

async function removeDraft(c: ImapClient, uid: number) {
  await c.mailboxOpen(await specialFolder(c, '\\Drafts'));
  await c.messageDelete(String(uid), { uid: true });
}

/** Replaces the given fields of a draft (others are kept); the draft gets a new uid. */
export async function updateDraft(env: MailEnv, c: ImapClient, uid: number, m: Compose) {
  const { fields, extra } = await draftFields(c, uid);
  const merged = Object.fromEntries(Object.entries({ ...fields, ...m }).filter(([, v]) => v !== undefined)) as Compose;
  if (m.text !== undefined && m.html === undefined) merged.html = undefined; // new plain text replaces the old HTML
  const res = await deliver(env, c, merged, extra, true);
  await removeDraft(c, uid);
  return { ...res, replacedUid: uid };
}

export async function sendDraft(env: MailEnv, c: ImapClient, uid: number) {
  const { fields, extra } = await draftFields(c, uid);
  if (![...(fields.to ?? []), ...(fields.cc ?? []), ...(fields.bcc ?? [])].length) throw new Error('Draft has no recipients; set them with update_draft first');
  const res = await deliver(env, c, fields, extra);
  await removeDraft(c, uid).catch(() => {});
  return res;
}

// ---------- calendar invitations ----------

export async function respondInvite(env: MailEnv, c: ImapClient, folder: string, uid: number, response: 'accepted' | 'declined' | 'tentative', comment?: string) {
  const o = await parseMail(await fetchSource(c, folder, uid));
  const ics = icsOf(o).map(unfold).find((s) => /BEGIN:VEVENT/.test(s));
  if (!ics) throw new Error('This email has no calendar invitation');
  const ev = ics.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/)![1];
  const organizer = icsValue(ev, 'ORGANIZER')?.replace(/^mailto:/i, '');
  if (!organizer) throw new Error('Invitation has no organizer to reply to');
  const me = account(env).email;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const keep = ['UID', 'DTSTART', 'DTEND', 'SEQUENCE', 'SUMMARY', 'RECURRENCE-ID'].map((k) => icsLine(ev, k)).filter(Boolean);
  const content = [
    'BEGIN:VCALENDAR', 'PRODID:-//nmail-mcp//EN', 'VERSION:2.0', 'METHOD:REPLY', 'BEGIN:VEVENT',
    ...keep, `DTSTAMP:${stamp}`, `ORGANIZER:mailto:${organizer}`, `ATTENDEE;PARTSTAT=${response.toUpperCase()}:mailto:${me}`,
    ...(comment ? [`COMMENT:${comment.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n')}`] : []),
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const label = { accepted: 'Accepted', declined: 'Declined', tentative: 'Tentative' }[response];
  return deliver(env, c, { to: [organizer], subject: `${label}: ${icsValue(ev, 'SUMMARY') ?? o.subject ?? ''}`, text: comment ?? label }, { icalEvent: { method: 'REPLY', content } });
}

// ---------- unsubscribe ----------

/** RFC 8058 one-click POST when offered, else a mailto: request; plain links are returned for the user to open. */
export async function unsubscribe(env: MailEnv, c: ImapClient, folder: string, uid: number) {
  await c.mailboxOpen(await resolveFolder(c, folder), { readOnly: true });
  const m = await c.fetchOne(String(uid), { uid: true, headers: ['list-unsubscribe', 'list-unsubscribe-post'] }, { uid: true });
  if (!m) throw new Error(`Message uid ${uid} not found in ${folder}`);
  const h = headerMap(m.headers);
  const targets = [...(h['list-unsubscribe'] ?? '').matchAll(/<([^>]+)>/g)].map((x) => x[1].trim());
  if (!targets.length) throw new Error('This email has no List-Unsubscribe header');
  const https = targets.find((t) => /^https:\/\//i.test(t));
  if (https && /one-click/i.test(h['list-unsubscribe-post'] ?? '')) {
    // The URL is chosen by the sender: POST only, no redirects followed.
    const r = await fetch(https, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    return { method: 'one-click', host: new URL(https).host, status: r.status, ok: r.status >= 200 && r.status < 300 };
  }
  const mailto = targets.find((t) => /^mailto:/i.test(t));
  if (mailto) {
    const u = new URL(mailto);
    const to = decodeURIComponent(u.pathname);
    await deliver(env, c, { to: [to], subject: u.searchParams.get('subject') ?? 'unsubscribe', text: u.searchParams.get('body') ?? 'unsubscribe' });
    return { method: 'mailto', to };
  }
  return { method: 'manual', url: https ?? targets[0], note: 'No automatic method offered; the user must open this link.' };
}
