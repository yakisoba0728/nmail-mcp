import { ImapClient, type ListResponse } from './imap';

// Account, IMAP session and folders. Reading, sending and organizing mail live in read.ts, send.ts, organize.ts.

export type { ImapClient } from './imap';

export interface MailEnv {
  NAVER_ID: string;
  NAVER_APP_PASSWORD: string;
  NAVER_NAME?: string;
  /** Appended to outgoing mail unless a tool call passes signature: false */
  NAVER_SIGNATURE?: string;
}

const IMAP = { host: 'imap.naver.com', port: 993 };
export const SMTP = { host: 'smtp.naver.com', port: 465 };
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Naver logs in with the bare id (no @naver.com); app passwords are often copied with spaces. */
export function account(env: MailEnv) {
  const login = env.NAVER_ID.trim().replace(/@naver\.com$/i, '');
  return { login, email: `${login}@naver.com`, pass: env.NAVER_APP_PASSWORD.replace(/\s+/g, ''), name: env.NAVER_NAME };
}

/** One connection per tool call, always logged out. */
export async function withImap<T>(env: MailEnv, fn: (c: ImapClient) => Promise<T>): Promise<T> {
  const a = account(env);
  const open = () => new ImapClient({ ...IMAP, user: a.login, pass: a.pass });
  // "Command failed" alone says nothing; the server's reason is in responseText.
  const explain = (e: Error & { responseText?: string }) => {
    if (e.responseText) e.message = `${e.message}: ${e.responseText}`;
    throw e;
  };
  let c = open();
  await c.connect().catch(async (e: Error & { code?: string }) => {
    // One retry for network hiccups only; auth failures are final.
    if (!/^E(TIMEDOUT|CONNRESET|CONNREFUSED|PIPE)$|^ETIMEOUT$/.test(e.code ?? '')) return explain(e);
    await new Promise((r) => setTimeout(r, 1500));
    c = open();
    await c.connect().catch(explain);
  });
  try {
    return await fn(c).catch(explain);
  } finally {
    await c.logout().catch(() => c.close());
  }
}

// ---------- folders ----------

// Naver advertises SPECIAL-USE; the names are a fallback for servers that don't.
export type Special = '\\Sent' | '\\Drafts' | '\\Trash' | '\\Junk';
const SPECIAL_NAMES: Record<Special, RegExp> = {
  '\\Sent': /^(sent|보낸\s*메일)/i,
  '\\Drafts': /^(drafts?|임시\s*보관)/i,
  '\\Trash': /^(trash|deleted|휴지통)/i,
  '\\Junk': /^(junk|spam|스팸)/i,
};
const roleOf = (f: { name: string; specialUse?: string }) =>
  f.specialUse || (Object.keys(SPECIAL_NAMES) as Special[]).find((k) => SPECIAL_NAMES[k].test(f.name));

const ALIASES: Record<string, Special | 'INBOX'> = {
  inbox: 'INBOX', 받은메일함: 'INBOX',
  sent: '\\Sent', 보낸메일함: '\\Sent',
  draft: '\\Drafts', drafts: '\\Drafts', 임시보관함: '\\Drafts',
  trash: '\\Trash', 휴지통: '\\Trash',
  spam: '\\Junk', junk: '\\Junk', 스팸메일함: '\\Junk',
};

// Folder list (roles, paths) cached per isolate: almost every tool needs it and it rarely changes.
// shortcut: another isolate's manage_folder is seen here only after the TTL; fine for one user.
const FOLDER_TTL_MS = 5 * 60_000;
let folderCache: { at: number; list: Promise<ListResponse[]> } | undefined;
export function folderList(c: ImapClient): Promise<ListResponse[]> {
  if (folderCache && Date.now() - folderCache.at < FOLDER_TTL_MS) return folderCache.list;
  const p = c.list();
  folderCache = { at: Date.now(), list: p };
  p.catch(() => (folderCache = undefined));
  return p;
}

/** Forget the cached list (after a folder change, or when a cached folder turns out to be gone). */
export const invalidateFolders = () => void (folderCache = undefined);

export async function specialFolder(c: ImapClient, use: Special): Promise<string> {
  const f = (await folderList(c)).find((f) => roleOf(f) === use);
  if (!f) throw new Error(`${use} folder not found; pass the folder path explicitly (see list_folders)`);
  return f.path;
}

/** Accepts a folder path or an alias: inbox, sent, drafts, trash, spam (or the Korean names). */
export async function resolveFolder(c: ImapClient, name = 'INBOX'): Promise<string> {
  const role = ALIASES[name.trim().toLowerCase().replace(/\s+/g, '')];
  if (role === 'INBOX') return 'INBOX';
  return role ? specialFolder(c, role) : name;
}

/** Folders searched for "all": everything selectable except Trash, Junk and Drafts (unless asked). */
export async function searchableFolders(c: ImapClient, includeTrashAndSpam = false): Promise<string[]> {
  return (await folderList(c))
    .filter((f) => !f.flags.has('\\Noselect') && (includeTrashAndSpam || !['\\Trash', '\\Junk', '\\Drafts'].includes(roleOf(f) ?? '')))
    .map((f) => f.path);
}

export async function listFolders(c: ImapClient) {
  const list = await c.list({ statusQuery: { messages: true, unseen: true } });
  return list
    .filter((f) => !f.flags.has('\\Noselect'))
    .map((f) => ({ path: f.path, role: roleOf(f), messages: f.status?.messages, unseen: f.status?.unseen }));
}

export async function manageFolder(c: ImapClient, action: 'create' | 'rename' | 'delete', path: string, newPath?: string) {
  invalidateFolders();
  if (action === 'create') return c.mailboxCreate(path);
  if (action === 'delete') return c.mailboxDelete(path);
  if (!newPath) throw new Error('newPath is required for rename');
  return c.mailboxRename(path, newPath);
}

export async function getProfile(env: MailEnv, c: ImapClient) {
  const a = account(env);
  const quota = await c.getQuota().catch(() => false as const);
  const mb = (n?: number) => (n === undefined ? undefined : Math.round(n / 1024 / 1024));
  return {
    email: a.email,
    displayName: a.name,
    signature: env.NAVER_SIGNATURE ? 'set' : 'none',
    inbox: await c.status('INBOX', { messages: true, unseen: true }),
    storage: quota && quota.storage ? { usedMB: mb(quota.storage.usage), limitMB: mb(quota.storage.limit), status: quota.storage.status } : undefined,
  };
}
