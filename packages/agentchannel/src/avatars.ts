import type { Client, FetchLike } from './client.js';
import type { Exec } from './import.js';

/**
 * Feishu avatars are fetched on the admin's machine (lark-cli is logged in
 * there, the hub is not) and uploaded to the hub, which caches them; the panel
 * only ever loads avatars from the hub. GitHub and Gravatar are fetched by the
 * hub itself (POST /api/ach/admin/avatars/refresh, and weekly).
 */

export const AVATAR_MAX_BYTES = 200 * 1024;
export const AVATAR_SOURCES = ['upload', 'feishu', 'github', 'gravatar'];

/** png | jpeg | gif | webp from the first bytes, else '' (never SVG). */
export function imageKind(b: Uint8Array): string {
  if (b.length < 12) return '';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return '';
}

const EXT: Record<string, string> = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp' };

/** The best avatar URL in a Feishu user object (search or contact result). */
export function feishuAvatarUrl(u: any): string {
  const a = u?.avatar ?? {};
  const url = a.avatar_240 || a.avatar_640 || a.avatar_72 || a.avatar_origin || u?.avatar_url || '';
  return typeof url === 'string' && /^https:\/\//.test(url) ? url : '';
}

/** Look a person up in Feishu by email (or open_id) with lark-cli; returns the avatar URL or ''. */
export async function feishuAvatarFor(exec: Exec, p: { email?: string; feishu_open_id?: string; name?: string }): Promise<string> {
  const q = String(p.email || p.name || '').trim();
  if (!q) return '';
  const r = await exec('lark-cli', ['contact', '+search-user', '--query', q, '--as', 'user', '--exclude-external-users', '--format', 'json']);
  if (r.code !== 0) return '';
  try {
    const j = JSON.parse(r.stdout);
    const users: any[] = j?.data?.users ?? j?.users ?? [];
    const hit =
      users.find((u) => p.feishu_open_id && u.open_id === p.feishu_open_id) ??
      users.find((u) => p.email && [u.email, u.enterprise_email].some((e) => String(e ?? '').toLowerCase() === String(p.email).toLowerCase()));
    return hit ? feishuAvatarUrl(hit) : '';
  } catch {
    return '';
  }
}

/** Download an image (<= 200 KB, PNG/JPEG/GIF/WebP). */
export async function downloadImage(url: string, fetchFn: FetchLike): Promise<{ bytes: Uint8Array; ext: string }> {
  const res = await fetchFn(url, { method: 'GET', headers: { accept: 'image/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > AVATAR_MAX_BYTES) throw new Error('larger than 200 KB');
  const kind = imageKind(bytes);
  if (!kind) throw new Error('not a PNG/JPEG/GIF/WebP image');
  return { bytes, ext: EXT[kind] };
}

/**
 * Upload Feishu avatars for these people (hub ids). Returns how many were
 * uploaded; problems are logged, never fatal (an avatar is cosmetic).
 */
export async function syncFeishuAvatars(
  admin: Client,
  people: { id: string; name?: string; email?: string; feishu_open_id?: string }[],
  o: { exec: Exec; fetch?: FetchLike; log: (s: string) => void },
): Promise<number> {
  const fetchFn = o.fetch ?? ((u, i) => fetch(u, i));
  let n = 0;
  for (const p of people) {
    try {
      const url = await feishuAvatarFor(o.exec, p);
      if (!url) continue;
      const img = await downloadImage(url, fetchFn);
      await admin.sendImage('POST', `/api/ach/admin/avatars/users/${encodeURIComponent(p.id)}`, img.bytes, `feishu.${img.ext}`, { source: 'feishu' });
      n++;
    } catch (e: any) {
      o.log(`avatar for ${p.name || p.id}: ${e?.message ?? e}`);
    }
  }
  return n;
}

export function parsePriority(s: string): string[] {
  const list = s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const x of list) if (!AVATAR_SOURCES.includes(x)) throw new Error(`unknown avatar source "${x}" (use ${AVATAR_SOURCES.join(', ')})`);
  return list;
}
