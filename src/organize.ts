import type { ImapClient } from './imap';
import { resolveFolder, specialFolder } from './mail';

// Moving, flagging and deleting messages given as {folder, uid}; one call may span folders.

export type Ref = { folder: string; uid: number };

async function byFolder(c: ImapClient, refs: Ref[]) {
  const m = new Map<string, number[]>();
  for (const r of refs) {
    const f = await resolveFolder(c, r.folder);
    m.set(f, [...(m.get(f) ?? []), r.uid]);
  }
  return m;
}

export async function moveEmails(c: ImapClient, refs: Ref[], destination: string) {
  const dest = await resolveFolder(c, destination);
  const moved: { from: Ref; to: Ref }[] = [];
  for (const [folder, uids] of await byFolder(c, refs)) {
    await c.mailboxOpen(folder);
    const res = await c.messageMove(uids.join(','), dest, { uid: true });
    if (!res) throw new Error(`Move from ${folder} failed`);
    for (const u of uids) moved.push({ from: { folder, uid: u }, to: { folder: dest, uid: res.uidMap?.get(u) ?? u } });
  }
  return { destination: dest, moved };
}

export async function deleteEmails(c: ImapClient, refs: Ref[], permanent = false) {
  const trash = await specialFolder(c, '\\Trash');
  const out: { movedToTrash: Ref[]; permanentlyDeleted: Ref[] } = { movedToTrash: [], permanentlyDeleted: [] };
  for (const [folder, uids] of await byFolder(c, refs)) {
    if (!permanent && folder !== trash) {
      out.movedToTrash.push(...(await moveEmails(c, uids.map((uid) => ({ folder, uid })), trash)).moved.map((m) => m.to));
      continue;
    }
    await c.mailboxOpen(folder);
    await c.messageDelete(uids.join(','), { uid: true });
    out.permanentlyDeleted.push(...uids.map((uid) => ({ folder, uid })));
  }
  return out;
}

export type Flags = { read?: boolean; flagged?: boolean; answered?: boolean };
export async function setFlags(c: ImapClient, refs: Ref[], f: Flags) {
  for (const [folder, uids] of await byFolder(c, refs)) {
    await c.mailboxOpen(folder);
    const range = uids.join(',');
    for (const [flag, on] of [['\\Seen', f.read], ['\\Flagged', f.flagged], ['\\Answered', f.answered]] as const) {
      if (on === true) await c.messageFlagsAdd(range, [flag], { uid: true });
      if (on === false) await c.messageFlagsRemove(range, [flag], { uid: true });
    }
  }
  return { updated: refs.length, ...f };
}

