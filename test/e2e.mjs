// Live end-to-end check against `npm run dev` (http://localhost:8787) using the account in .dev.vars.
// It only mails your own address, tags everything with a run id, and permanently deletes what it created.
// Usage: npm run dev (other terminal), then: node test/e2e.mjs
// One tool call by hand: node test/client.mjs call <tool> '<json args>'
import { randomBytes } from 'node:crypto';
import { BASE, ME, call, connect, rpc, setToken, vars } from './client.mjs';

const TAG = `MCP-E2E-${Date.now().toString(36)}`;
const BODY_TOKEN = `bodyonly${randomBytes(4).toString('hex')}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(query, n = 1, folders = 'all', tries = 15) {
  for (let i = 0; i < tries; i++) {
    const r = await call('search_emails', { query, folders, limit: 50, snippets: false });
    if (r.messages.length >= n) return r.messages;
    await sleep(2000);
  }
  return (await call('search_emails', { query, folders, limit: 50, snippets: false })).messages;
}
const tagged = (extra = '') => `subject:"${TAG}" ${extra}`.trim();

// 1x1 red PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function main() {
  const t = await connect({ fresh: true });
  check('oauth token (with refresh token)', t?.access_token && t.refresh_token);
  // ChatGPT keeps a connection alive by refreshing; the refreshed token must work and the old refresh token must not.
  const refreshed = await (await fetch(`${BASE}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id, resource: `${BASE}/mcp` }) })).json();
  check('refresh_token grant', refreshed.access_token && (await rpc('tools/list', undefined, refreshed.access_token)).tools.length > 20);
  const noAuth = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('no token → 401 with resource metadata', noAuth.status === 401 && /resource_metadata=/.test(noAuth.headers.get('www-authenticate') ?? ''));
  const get = await fetch(`${BASE}/mcp`, { headers: { authorization: `Bearer ${refreshed.access_token}`, accept: 'text/event-stream' } });
  check('GET /mcp (no SSE stream) → 405', get.status === 405, String(get.status));
  setToken(refreshed.access_token);
  let notFound = '';
  await call('read_email', { folder: 'inbox', uid: 999999999 }).catch((err) => (notFound = err.message));
  check('missing message → clear error', /not found/i.test(notFound), notFound.slice(0, 80));
  let noFolder = '';
  await call('search_emails', { folders: ['없는폴더zz'], limit: 1 }).then((r) => (noFolder = JSON.stringify(r.warnings ?? r))).catch((err) => (noFolder = err.message));
  check('missing folder → reported', /없는폴더zz/.test(noFolder) || /exist|NO/i.test(noFolder), noFolder.slice(0, 100));

  // ---- tier 1: read side
  const prof = await call('get_profile');
  check('get_profile storage', prof.storage?.limitMB > 0, `${prof.storage?.usedMB}/${prof.storage?.limitMB}MB`);
  const folders = await call('list_folders');
  check('list_folders', folders.some((f) => f.role === '\\Sent'));
  const kw = await call('search_emails', { query: '결제', limit: 3, snippets: true });
  check('search keyword across folders', kw.messages.length > 0 && kw.searchedFolders.length > 1, `${kw.messages.length} hits, folders=${kw.searchedFolders.length}, complete=${kw.complete}`);
  // A failed IMAP SEARCH is reported as a warning, not an error: a clean search must have none.
  check('keyword search: no swallowed IMAP errors', !kw.warnings, JSON.stringify(kw.warnings));
  check('search snippets', kw.messages.some((m) => m.snippet));
  const page2 = await call('search_emails', { folders: ['inbox'], limit: 5, offset: 5, snippets: false });
  const page1 = await call('search_emails', { folders: ['inbox'], limit: 5, snippets: false });
  check('pagination', page2.messages.length === 5 && !page1.messages.some((m) => page2.messages.some((n) => n.uid === m.uid)) && page1.hasMore);
  const bad = await call('search_emails', { query: 'category:promo OR x', limit: 1 });
  check('unsupported operators warned', (bad.warnings ?? []).length >= 2);

  // ---- tier 2: send & compose
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VEVENT', `UID:${TAG}@e2e`, 'DTSTAMP:20261123T000000Z', 'DTSTART;TZID=Asia/Seoul:20261201T100000', 'DTEND;TZID=Asia/Seoul:20261201T110000', `SUMMARY:${TAG} 회의`, `ORGANIZER:mailto:${ME}`, `ATTENDEE:mailto:${ME}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const sent = await call('send_email', {
    to: [ME],
    subject: `[${TAG}] 원본 메일`,
    text: `본문입니다 ${BODY_TOKEN}\n.점으로 시작`,
    html: `<p>본문입니다 ${BODY_TOKEN}</p><img src="cid:dot1">`,
    attachments: [
      { filename: '메모.txt', contentBase64: Buffer.from('첨부 텍스트').toString('base64'), mimeType: 'text/plain' },
      { filename: 'dot.png', contentBase64: PNG, mimeType: 'image/png' },
      { filename: 'dot-inline.png', contentBase64: PNG, mimeType: 'image/png', contentId: 'dot1' },
      { filename: 'invite.ics', contentBase64: Buffer.from(ics).toString('base64'), mimeType: 'text/calendar' },
    ],
    replyTo: [ME],
    priority: 'high',
    readReceipt: true,
  });
  check('send_email', sent.sent && sent.savedTo);
  const [orig] = await waitFor(tagged('-subject:Re -subject:Fwd'), 1, ['inbox']);
  check('arrived in inbox', orig);
  if (!orig) throw new Error('test mail did not arrive');
  const bodyHit = await call('search_emails', { query: BODY_TOKEN, folders: ['inbox'], limit: 5, snippets: false });
  const starved = await call('search_emails', { query: BODY_TOKEN, folders: ['inbox'], maxScan: 0 });
  check('budget stop returns a resume point', !starved.complete && starved.resume?.fromUid > 0, JSON.stringify(starved.resume));
  const resumed = await call('search_emails', { query: BODY_TOKEN, folders: ['inbox'], maxScan: 5, resume: starved.resume });
  check('resume continues the body scan', resumed.messages.some((m) => m.uid === orig.uid), `scanned=${resumed.scannedBodies}`);
  const krx = await call('search_emails', { query: tagged('-광고없는제목 newer_than:1d is:unread'), folders: ['inbox'] });
  check('Korean exclude + newer_than + is:unread', krx.messages.some((m) => m.uid === orig.uid) && !krx.warnings, JSON.stringify(krx.warnings));
  const allClean = await call('search_emails', { query: tagged(), limit: 5 });
  check('all-folder search: no warnings', !allClean.warnings, JSON.stringify(allClean.warnings));
  check('body-only keyword found (client-side scan)', bodyHit.messages.some((m) => m.uid === orig.uid), `scannedBodies=${bodyHit.scannedBodies}`);
  const attHit = await call('search_emails', { query: tagged('has:attachment filename:dot.png'), folders: ['inbox'] });
  check('has:attachment + filename filter', attHit.messages.some((m) => m.uid === orig.uid));
  const noAtt = await call('search_emails', { query: tagged('-has:attachment'), folders: ['inbox'] });
  check('-has:attachment excludes it', !noAtt.messages.some((m) => m.uid === orig.uid));
  const r = await call('read_email', { folder: 'inbox', uid: orig.uid });
  check('read_email attachments', r.attachments.length >= 3, r.attachments.map((a) => a.filename).join(','));
  check('read_email calendar invite', r.calendarEvents?.[0]?.summary === `${TAG} 회의`);
  const ext = (await call('search_emails', { query: "-from:naver.com -from:navercorp.com", folders: ['inbox'], limit: 1, snippets: false })).messages[0];
  const er = ext && (await call('read_email', { folder: 'inbox', uid: ext.uid }));
  check('read_email auth results (external mail)', er?.authentication && Object.keys(er.authentication).length > 0, JSON.stringify(er?.authentication));
  const h = await call('read_email', { folder: 'inbox', uid: orig.uid, format: 'headers' });
  check('priority + read receipt + reply-to headers', /x-priority: 1/i.test(h.headers.join('\n')) && /disposition-notification-to/i.test(h.headers.join('\n')) && /reply-to/i.test(h.headers.join('\n')));
  const raw = await call('read_email', { folder: 'inbox', uid: orig.uid, format: 'raw' });
  check('raw format', /^[\s\S]*MIME-Version/i.test(raw.raw));
  const pngIdx = r.attachments.find((a) => a.filename === 'dot.png').index;
  const img = await call('get_attachment', { folder: 'inbox', uid: orig.uid, index: pngIdx }, true);
  check('get_attachment image content', img.content.some((c) => c.type === 'image' && c.data === PNG));
  const txt = await call('get_attachment', { folder: 'inbox', uid: orig.uid, index: r.attachments.find((a) => a.filename === '메모.txt').index });
  check('get_attachment text', txt.text === '첨부 텍스트');

  await call('reply_email', { folder: 'inbox', uid: orig.uid, text: '답장입니다' });
  await call('forward_email', { folder: 'inbox', uid: orig.uid, to: [ME], text: '전달합니다' });
  await call('send_email', { to: [ME], subject: `[${TAG}] 첨부 재사용`, text: 'attachFrom', attachFrom: [{ folder: 'inbox', uid: orig.uid, indexes: [pngIdx] }] });
  await call('respond_to_invite', { folder: 'inbox', uid: orig.uid, response: 'accepted', comment: '참석합니다' });
  const arrived = await waitFor(tagged(), 5, ['inbox']);
  const subj = (p) => arrived.find((m) => p.test(m.subject));
  check('reply arrived', subj(/^Re:/));
  check('forward arrived with attachments', subj(/^Fwd:/)?.attachments.length >= 3);
  check('attachFrom re-attached file', subj(/첨부 재사용/)?.attachments.includes('dot.png'));
  const acc = subj(/^Accepted:/);
  check('invite reply arrived', acc);
  if (acc) {
    const ar = await call('read_email', { folder: 'inbox', uid: acc.uid });
    check('invite reply is iCalendar REPLY', ar.calendarEvents?.[0]?.method === 'REPLY' || /METHOD:REPLY/.test(JSON.stringify(ar)));
  }
  const big = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 255;
  await call('send_email', { to: [ME], subject: `[${TAG}] 2MB`, text: 'big', attachments: [{ filename: '큰파일.bin', contentBase64: big.toString('base64'), mimeType: 'application/octet-stream' }] });
  const bigMsg = (await waitFor(tagged('subject:2MB'), 1, ['inbox']))[0];
  const bigR = bigMsg && (await call('read_email', { folder: 'inbox', uid: bigMsg.uid }));
  const bigAtt = bigR && (await call('get_attachment', { folder: 'inbox', uid: bigMsg.uid, index: 0 }, true));
  const blob = bigAtt?.content.find((c) => c.type === 'resource')?.resource.blob;
  check('2MB attachment round-trip (Korean filename)', bigR?.attachments[0]?.filename === '큰파일.bin' && blob && Buffer.from(blob, 'base64').equals(big));
  const answered = await call('search_emails', { query: tagged('is:answered'), folders: ['inbox'] });
  check('original marked answered', answered.messages.some((m) => m.uid === orig.uid));
  const reMsg = subj(/^Re:/);
  const thread = reMsg && (await call('get_thread', { folder: 'inbox', uid: reMsg.uid }));
  check('get_thread links original + reply across folders', thread && thread.count >= 2 && thread.messages.some((m) => /원본 메일/.test(m.subject) && !/^Re/.test(m.subject)), thread && thread.messages.map((m) => `${m.folder}:${m.subject.slice(0, 12)}`).join(' | '));

  // ---- drafts
  const d = await call('save_draft', { to: [ME], bcc: [ME], subject: `[${TAG}] 임시`, text: '초안 v1', signature: false });
  check('save_draft', d.draft && d.uid);
  const dl = await call('list_drafts');
  check('list_drafts', dl.messages.some((m) => m.uid === d.uid));
  const du = await call('update_draft', { uid: d.uid, subject: `[${TAG}] 임시 수정`, text: '초안 v2' });
  check('update_draft new uid', du.uid && du.uid !== d.uid);
  const dr = await call('read_email', { folder: 'drafts', uid: du.uid, format: 'headers' });
  check('draft keeps bcc header', /^bcc:/im.test(dr.headers.join('\n')));
  const ds = await call('send_draft', { uid: du.uid });
  check('send_draft', ds.sent);
  const afterSend = await call('list_drafts');
  check('draft removed after send', !afterSend.messages.some((m) => m.uid === du.uid));
  const sentDraft = await waitFor(tagged('subject:수정'), 1, ['inbox']);
  check('sent draft arrived', sentDraft.length);
  const rd = await call('reply_email', { folder: 'inbox', uid: orig.uid, text: '임시 답장', asDraft: true });
  check('reply asDraft', rd.draft);
  // Reply whose subject was changed: only the Message-ID lookup can link it back to the original.
  const renamed = await call('update_draft', { uid: rd.uid, subject: `${TAG} 완전히 다른 제목` });
  await call('send_draft', { uid: renamed.uid });
  const odd = (await waitFor(`subject:"${TAG} 완전히 다른 제목"`, 1, ['inbox']))[0];
  const oddThread = odd && (await call('get_thread', { folder: 'inbox', uid: odd.uid }));
  check('thread links a renamed reply to its original', oddThread?.messages.some((m) => /원본 메일/.test(m.subject)), oddThread?.messages.map((m) => m.subject.slice(0, 20)).join(' | '));

  // ---- people
  const ct = await call('find_contacts', { query: ME.split('@')[0] });
  check('find_contacts', ct.contacts.some((p) => p.address.toLowerCase() === ME));
  const st = await call('sender_stats', { folders: ['inbox'], top: 5 });
  check('sender_stats', st.top.length > 0, `${st.scannedMessages} scanned`);

  // ---- flags & bulk
  const mine = await waitFor(tagged(), 6, ['inbox']);
  await call('set_flags', { messages: mine.map((m) => ({ folder: 'inbox', uid: m.uid })), flagged: true, read: false });
  const dry = await call('bulk_action', { query: tagged('is:starred'), folders: ['inbox'], action: 'mark_read' });
  check('bulk dry run count', dry.dryRun && dry.count === mine.length, `${dry.count} vs ${mine.length}`);
  let refused = false;
  try {
    await call('bulk_action', { query: tagged('is:starred'), folders: ['inbox'], action: 'mark_read', dryRun: false, expectedCount: dry.count + 1 });
  } catch (err) {
    refused = /Refused/.test(err.message);
  }
  check('bulk refuses on count mismatch', refused);
  const done = await call('bulk_action', { query: tagged('is:starred'), folders: ['inbox'], action: 'mark_read', dryRun: false, expectedCount: dry.count });
  const unreadLeft = await call('search_emails', { query: tagged('is:unread'), folders: ['inbox'] });
  check('bulk mark_read applied', done.count === dry.count && unreadLeft.messages.length === 0);

  // ---- folders, move, trash
  const F = `${TAG}-폴더`;
  await call('manage_folder', { action: 'create', path: F });
  const mv = await call('bulk_action', { query: tagged(), folders: ['inbox'], action: 'move', destination: F, dryRun: true });
  await call('bulk_action', { query: tagged(), folders: ['inbox'], action: 'move', destination: F, dryRun: false, expectedCount: mv.count });
  const inF = await call('search_emails', { query: tagged(), folders: [F] });
  check('bulk move into new folder', inF.messages.length === mv.count && mv.count > 0, `${inF.messages.length}/${mv.count}`);
  await call('manage_folder', { action: 'rename', path: F, newPath: `${F}2` });
  const tr = await call('delete_emails', { messages: inF.messages.map((m) => ({ folder: `${F}2`, uid: m.uid })) });
  check('delete → trash', tr.movedToTrash.length === inF.messages.length);
  const inTrash = await call('bulk_action', { query: tagged(), folders: ['trash'], action: 'trash' });
  check('bulk trash never erases mail already in Trash', inTrash.count === 0 && inTrash.skippedAlreadyInTrash >= 1, JSON.stringify(inTrash));
  const back = await call('move_emails', { messages: tr.movedToTrash.slice(0, 1), destination: 'inbox' });
  check('restore from trash via alias', back.destination === 'INBOX');
  await call('manage_folder', { action: 'delete', path: `${F}2` });
  check('folder deleted', !(await call('list_folders')).some((f) => f.path.startsWith(F)));

  // ---- tier 3: automation (needs `wrangler dev --test-scheduled`)
  const cron = async (expr) => {
    const r = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent(expr)}`);
    if (!r.ok) throw new Error(`cron trigger ${r.status}: start the server with --test-scheduled`);
    await sleep(6000); // the handler runs in waitUntil
  };
  const soon = new Date(Date.now() + 5000).toISOString();
  const job = await call('schedule_email', { sendAt: soon, to: [ME], subject: `[${TAG}] 예약 발송`, text: '예약' });
  const later = await call('schedule_email', { sendAt: '2099-01-01 09:00', to: [ME], subject: `[${TAG}] 취소될 예약`, text: 'x' }).catch((err) => ({ error: err.message }));
  check('schedule beyond a year refused', later.error && /within a year/.test(later.error));
  const tomorrow = new Date(Date.now() + 86400_000).toISOString();
  const keep = await call('schedule_email', { sendAt: tomorrow, to: [ME], subject: `[${TAG}] 취소될 예약`, text: 'x' });
  await sleep(6000);
  await cron('* * * * *');
  const autos = await call('list_automations');
  const jobStatus = autos.scheduledEmails.find((j) => j.id === job.id)?.status;
  check('scheduled email sent by cron', jobStatus === 'sent', jobStatus);
  check('future job still pending', autos.scheduledEmails.find((j) => j.id === keep.id)?.status === 'pending');
  check('scheduled email arrived', (await waitFor(tagged('subject:예약 발송'), 1, ['inbox'])).length === 1);
  await call('cancel_scheduled', { id: keep.id });
  check('cancel_scheduled', !(await call('list_automations')).scheduledEmails.some((j) => j.id === keep.id));
  let sentCancel = false;
  try {
    await call('cancel_scheduled', { id: job.id });
  } catch (err) {
    sentCancel = /already sent/.test(err.message);
  }
  check('cannot cancel a sent job', sentCancel);

  const badRule = await call('create_rule', { name: 'x', query: '', markRead: true }).catch((err) => ({ error: err.message }));
  check('rule with empty query refused', badRule.error);
  const orRule = await call('create_rule', { name: 'x', query: 'a OR b', markRead: true }).catch((err) => ({ error: err.message }));
  check('rule with unsupported operator refused', orRule.error);
  const RF = `${TAG}-규칙`;
  await call('manage_folder', { action: 'create', path: RF });
  const rule = await call('create_rule', { name: `${TAG} rule`, query: `subject:"${TAG}-rule"`, markRead: true, moveTo: RF });
  const vac = await call('set_vacation', { enabled: true, text: '부재중입니다', subject: `[${TAG}] 부재중`, end: tomorrow });
  check('set_vacation', vac.enabled);
  await call('send_email', { to: [ME], subject: `[${TAG}-rule] 규칙 대상`, text: 'rule target' });
  await call('send_email', { to: [ME], subject: `[${TAG}] 규칙 비대상`, text: 'not a target' });
  await waitFor(tagged('subject:규칙'), 2, ['inbox']);
  await cron('*/5 * * * *');
  const moved = await call('search_emails', { query: `subject:"${TAG}-rule"`, folders: [RF] });
  check('rule moved new matching mail', moved.messages.length === 1 && !moved.messages[0].unread, `${moved.messages.length} in ${RF}`);
  const stay = await call('search_emails', { query: tagged('subject:비대상'), folders: ['inbox'] });
  check('rule left non-matching mail alone', stay.messages.length === 1);
  await sleep(8000);
  const autoReplies = await call('search_emails', { query: tagged('subject:부재중'), folders: 'all' });
  check('vacation never answers your own address', autoReplies.messages.length === 0);
  await call('delete_rule', { id: rule.created.id });
  await call('set_vacation', { enabled: false });
  const after = await call('list_automations');
  check('rule and vacation removed', !after.rules.some((r) => r.id === rule.created.id) && !after.vacation.enabled);

  // Mail that arrives while every automation is off must not be acted on when one is turned back on.
  await call('send_email', { to: [ME], subject: `[${TAG}-rule2] 꺼져 있을 때 도착`, text: 'backlog' });
  await waitFor(`subject:"${TAG}-rule2"`, 1, ['inbox']);
  const rule2 = await call('create_rule', { name: `${TAG} rule2`, query: `subject:"${TAG}-rule2"`, moveTo: RF });
  await cron('*/5 * * * *');
  const backlog = await call('search_emails', { query: `subject:"${TAG}-rule2"`, folders: ['inbox'] });
  check('re-enabled rule ignores the backlog', backlog.messages.length === 1);
  await call('delete_rule', { id: rule2.created.id });

  // unsubscribe (mailto): a crafted list mail whose List-Unsubscribe points back to us
  const { ImapFlow } = await import('imapflow');
  const im = new ImapFlow({ host: 'imap.naver.com', port: 993, secure: true, auth: { user: ME.split('@')[0], pass: vars.NAVER_APP_PASSWORD.replace(/\s+/g, '') }, logger: false });
  await im.connect();
  await im.append('INBOX', [`From: list@example.com`, `To: ${ME}`, `Subject: [${TAG}] 뉴스레터`, `Message-ID: <${TAG}@e2e>`, `List-Unsubscribe: <mailto:${ME}?subject=${TAG}%20unsub>`, 'Content-Type: text/plain; charset=utf-8', '', 'newsletter'].join('\r\n'));
  // A legacy Korean mail: EUC-KR words in headers, body labelled ks_c_5601-1987, base64.
  const euckr = Buffer.from([0xbe, 0xc8, 0xb3, 0xe7, 0xc7, 0xcf, 0xbc, 0xbc, 0xbf, 0xe4]); // 안녕하세요
  await im.append('INBOX', Buffer.concat([
    Buffer.from([`From: =?EUC-KR?B?${Buffer.from([0xc8, 0xab, 0xb1, 0xe6, 0xb5, 0xbf]).toString('base64')}?= <old@example.co.kr>`, `To: ${ME}`, `Subject: [${TAG}] =?ks_c_5601-1987?B?${euckr.toString('base64')}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="ks_c_5601-1987"', 'Content-Transfer-Encoding: base64', '', euckr.toString('base64'), ''].join('\r\n')),
  ]));
  await im.logout();
  const old = (await call('search_emails', { query: tagged('from:old@example.co.kr'), folders: ['inbox'] })).messages[0];
  check('EUC-KR headers decoded in search', old?.subject === `[${TAG}] 안녕하세요` && /홍길동/.test(old?.from ?? ''), `${old?.subject} / ${old?.from}`);
  const oldR = old && (await call('read_email', { folder: 'inbox', uid: old.uid }));
  check('EUC-KR body decoded', oldR?.text.trim() === '안녕하세요', JSON.stringify(oldR?.text));
  const nl = (await call('search_emails', { query: tagged('subject:뉴스레터'), folders: ['inbox'] })).messages[0];
  const un = nl && (await call('unsubscribe', { folder: 'inbox', uid: nl.uid }));
  check('unsubscribe via mailto', un?.method === 'mailto');
  check('unsubscribe request arrived', (await waitFor(`subject:"${TAG} unsub"`, 1, ['inbox'])).length === 1);

  if (vars.NAVER_SIGNATURE) {
    await call('send_email', { to: [ME], subject: `[${TAG}] 서명`, text: '서명 확인' });
    const sm = (await waitFor(tagged('subject:서명'), 1, ['inbox']))[0];
    const sr = sm && (await call('read_email', { folder: 'inbox', uid: sm.uid }));
    check('signature appended', sr?.text.includes(vars.NAVER_SIGNATURE.replace(/\\n/g, '\n')));
  } else console.log('SKIP  signature (NAVER_SIGNATURE not set in .dev.vars)');
}

async function cleanup() {
  let n = 0;
  for (const folders of ['all', ['trash'], ['drafts']]) {
    const r = await call('search_emails', { query: tagged(), folders, includeTrashAndSpam: true, limit: 100, snippets: false }).catch(() => ({ messages: [] }));
    if (r.messages.length) {
      await call('delete_emails', { messages: r.messages.map((m) => ({ folder: m.folder, uid: m.uid })), permanent: true });
      n += r.messages.length;
    }
  }
  const autos = await call('list_automations').catch(() => null);
  for (const r of autos?.rules ?? []) if (r.name.includes(TAG)) await call('delete_rule', { id: r.id }).catch(() => {});
  for (const j of autos?.scheduledEmails ?? []) if (j.subject?.includes(TAG) && j.status === 'pending') await call('cancel_scheduled', { id: j.id }).catch(() => {});
  if (autos?.vacation?.subject?.includes(TAG)) await call('set_vacation', { enabled: false }).catch(() => {});
  for (const f of await call('list_folders').catch(() => [])) if (f.path.includes(TAG)) await call('manage_folder', { action: 'delete', path: f.path }).catch(() => {});
  console.log(`cleanup: permanently deleted ${n} test emails`);
}

try {
  await main();
} catch (err) {
  check('run', false, err.message);
} finally {
  await cleanup().catch((err) => console.log('cleanup failed:', err.message));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}
