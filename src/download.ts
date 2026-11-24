import { Buffer } from 'node:buffer';
import type { Env } from './auth';
import { account, MAX_ATTACHMENT_BYTES, withImap, type ImapClient } from './mail';
import { AttachmentTooLargeError, fetchAttachmentBytes, openAttachment } from './read';

export const ATTACHMENT_PATH = '/attachments/';
const DOWNLOAD_TTL = 300;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const key = (token: string) => `app:download:${token}`;
const privateHeaders = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' };

export const attachmentDownloadLimit = (env: Env) => env.ATTACHMENT_DOWNLOAD_MAX_BYTES ?? MAX_ATTACHMENT_BYTES;
export const attachmentLimitNotice = (bytes: number) => `이 첨부는 ${Math.round(bytes / 1_000_000)}MB 제한을 넘습니다. 네이버 메일에서 직접 내려받으세요.`;

interface AttachmentRef {
  folder: string;
  uid: number;
  index: number;
  messageKey: string;
}

export async function attachmentMessageKey(client: ImapClient, uid: number, uidValidity: number | undefined) {
  if (uidValidity) return `uidvalidity:${uidValidity}`;
  // Naver can report UIDVALIDITY 0. Bind the link to the message headers in that case.
  const message = await client.fetchOne(String(uid), { headers: true }, { uid: true });
  if (!message || !message.headers?.length) throw new Error('Mailbox identity unavailable for attachment download');
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(message.headers));
  return `headers:${Buffer.from(digest).toString('hex')}`;
}

export async function attachmentLink(env: Env, origin: string, ref: AttachmentRef) {
  const token = crypto.randomUUID();
  await env.OAUTH_KV.put(key(token), JSON.stringify({ ...ref, origin, user: account(env).login }), { expirationTtl: DOWNLOAD_TTL });
  return { downloadUrl: new URL(ATTACHMENT_PATH + token, origin).href, expiresInSeconds: DOWNLOAD_TTL };
}

export const isTextAttachment = (mimeType: string) => /^(text\/|application\/(json|xml|csv)$)/i.test(mimeType);

export function canPreviewAttachment(filename: string, mimeType: string) {
  return isTextAttachment(mimeType) || /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/i.test(mimeType) ||
    /\.(png|jpe?g|gif|webp|pdf|txt|md|csv|json|xml)$/i.test(filename);
}

function previewType(bytes: Buffer, filename: string, mimeType: string) {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) return 'image/jpeg';
  const header = bytes.toString('ascii', 0, 12);
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8) === 'WEBP') return 'image/webp';
  if (header.startsWith('%PDF-')) return 'application/pdf';
  if (isTextAttachment(mimeType) || /\.(txt|md|csv|json|xml)$/i.test(filename)) return 'text/plain';
}

export function attachmentResponse(bytes: Buffer, filename: string, mimeType: string, preview: boolean) {
  const type = previewType(bytes, filename, mimeType);
  const encodedName = encodeURIComponent(Buffer.from(filename).toString()).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16)}`);
  const body = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  return new Response(body, { headers: {
    ...privateHeaders,
    'content-type': type ?? 'application/octet-stream',
    'content-disposition': `${preview && type ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodedName}`,
    'x-content-type-options': 'nosniff',
  } });
}

export async function downloadAttachment(req: Request, env: Env) {
  const url = new URL(req.url);
  const token = url.pathname.slice(ATTACHMENT_PATH.length);
  const notFound = () => new Response('Download unavailable or expired.', { status: 404, headers: privateHeaders });
  if (req.method !== 'GET') return new Response(null, { status: 405, headers: { ...privateHeaders, allow: 'GET' } });
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(token)) return notFound();
  const ref = await env.OAUTH_KV.get<AttachmentRef & { origin: string; user: string }>(key(token), 'json');
  if (!ref || ref.origin !== url.origin || ref.user !== account(env).login) return notFound();

  const maxBytes = attachmentDownloadLimit(env);
  return withImap(env, async (client) => {
    const { mailbox, node, filename, mimeType } = await openAttachment(client, ref.folder, ref.uid, ref.index);
    if (await attachmentMessageKey(client, ref.uid, mailbox.uidValidity) !== ref.messageKey) return notFound();
    const bytes = await fetchAttachmentBytes(client, ref.uid, node, maxBytes);
    return attachmentResponse(bytes, filename, mimeType, url.searchParams.get('preview') === '1');
  }).catch((error: unknown) => error instanceof AttachmentTooLargeError
    ? new Response(attachmentLimitNotice(maxBytes), { status: 413, headers: privateHeaders })
    : new Response('Unable to retrieve the attachment.', { status: 502, headers: privateHeaders }));
}
