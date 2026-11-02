import { createWriteStream, mkdirSync, openAsBlob, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Message, TaskBundle } from './client.js';

/** What the hub accepts (it re-checks the type from the file content). */
export const ATTACH_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  // Text and code (≤ 2 MB each, previewed as escaped text) and .html reports
  // (previewed only in a sandboxed iframe; downloaded as text/plain).
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  ts: 'text/plain',
  js: 'text/plain',
  py: 'text/plain',
  go: 'text/plain',
  sh: 'text/plain',
  diff: 'text/plain',
  patch: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  yaml: 'text/plain',
  yml: 'text/plain',
  sql: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
};
export const TEXT_MAX_BYTES = 2 * 1024 * 1024;
const MEDIA_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov']);
export const MAX_ATTACHMENTS = 10;

export interface Attachment {
  /** Stored file name on the hub (safe: [A-Za-z0-9._-]). */
  name: string;
  /** Uploader's file name (untrusted text). */
  original: string;
  size: number;
  type: string;
  /** Hub-relative download path (/api/ach/files/... or /api/ach/uploads/<id>/raw), or an https link for `ref: "link"`. */
  url: string;
  /** "link" = an object referenced by URL (not on the hub); "upload" = a direct upload to the hub's bucket. */
  ref?: 'link' | 'upload';
  upload?: string;
  keep?: boolean;
}

/** An `--attach`/`--attach-url` entry that references an object by URL instead of uploading it. */
export function isLinkRef(p: string): boolean {
  return /^https:\/\//i.test(p);
}

/** A link reference for `attachment_refs` ({url, name}); throws AttachError on anything but a plain https URL. */
export function linkRef(p: string): { url: string; name?: string } {
  let u: URL;
  try {
    u = new URL(p);
  } catch {
    throw new AttachError(`attachment link ${p} is not a URL`);
  }
  if (u.protocol !== 'https:' || u.username || u.password) throw new AttachError(`attachment link ${p}: only https URLs without credentials`);
  const seg = u.pathname.split('/').pop() || u.hostname;
  let name = seg;
  try {
    name = decodeURIComponent(seg);
  } catch {
    /* keep raw */
  }
  return { url: p, name };
}

export class AttachError extends Error {}

const SAFE_NAME = /^[A-Za-z0-9._-]{1,255}$/;

export function typeOf(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return (m && ATTACH_TYPES[m[1].toLowerCase()]) || '';
}

/**
 * Resolve `--attach` paths. Inside a spawned agent (run token) every file must
 * resolve through realpath inside the working directory, like `--result-file`
 * (S2): an agent cannot upload ~/.agentchannel-v2/config.json as a "frame".
 */
export function resolveAttachments(paths: string[] | undefined, io: { env: NodeJS.ProcessEnv; cwd?: string }): string[] {
  const list = (paths ?? []).filter((p) => typeof p === 'string' && p.length);
  if (!list.length) return [];
  if (list.length > MAX_ATTACHMENTS) throw new AttachError(`at most ${MAX_ATTACHMENTS} attachments`);
  const cwd = io.cwd ?? process.cwd();
  return list.map((p) => {
    // An https URL is a reference (R2/S3/OSS/TOS presigned or public); nothing is read or uploaded
    if (isLinkRef(p)) return linkRef(p).url;
    let real: string;
    try {
      real = realpathSync(resolve(cwd, p));
    } catch {
      throw new AttachError(`cannot read attachment ${p}`);
    }
    if (io.env.ACH_RUN_TOKEN) {
      const rel = relative(realpathSync(cwd), real);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new AttachError(`refusing to attach ${p}: inside a spawned agent, files must be inside the working directory`);
      }
    }
    if (!statSync(real).isFile()) throw new AttachError(`attachment ${p} is not a file`);
    if (!typeOf(real)) throw new AttachError(`attachment ${p}: only ${Object.keys(ATTACH_TYPES).join(', ')} files are accepted`);
    const ext = (/\.([A-Za-z0-9]+)$/.exec(real)?.[1] ?? '').toLowerCase();
    if (!MEDIA_EXT.has(ext) && statSync(real).size > TEXT_MAX_BYTES) throw new AttachError(`attachment ${p}: text files are limited to 2 MB`);
    return real;
  });
}

/** Multipart body: the JSON body in field "json", files in "attachments". */
export async function attachmentForm(json: unknown, files: string[]): Promise<FormData> {
  const fd = new FormData();
  fd.append('json', JSON.stringify(json ?? {}));
  for (const f of files) {
    const blob = await openAsBlob(f, { type: typeOf(f) || 'application/octet-stream' });
    fd.append('attachments', blob, basename(f));
  }
  return fd;
}

const UPLOAD_URL = /^\/api\/ach\/uploads\/[a-z0-9]{15}\/raw$/;

export function attachmentsOf(v: unknown): Attachment[] {
  if (!Array.isArray(v)) return [];
  return v.filter((a) => {
    if (!a || typeof a.url !== 'string' || typeof a.name !== 'string') return false;
    if (a.ref === 'link') return /^https:\/\//i.test(a.url);
    if (a.ref === 'upload') return UPLOAD_URL.test(a.url);
    return SAFE_NAME.test(a.name);
  }) as Attachment[];
}

/** A path-safe local file name for an attachment (references keep their upload id as prefix). */
export function localName(a: Attachment): string {
  if (!a.ref) return a.name;
  const safe = String(a.original || a.name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').slice(0, 120) || 'file';
  return a.ref === 'upload' && a.upload ? `${a.upload}_${safe}` : safe;
}

export interface TaskFile extends Attachment {
  /** Where it was attached: "handoff v2" or "<kind> <messageId> by <author>". */
  from: string;
  /** Local path after a download. */
  path?: string;
}

function author(m: Message): string {
  if (m.author_type === 'human') return `human ${String(m.author_name ?? '')}`.trim();
  if (m.author_type === 'system') return 'system';
  return `agent ${String(m.author_name ?? m.author_agent ?? '?')}`;
}

/** Every attachment on a task: current handoff first, then messages (oldest first). */
export function taskFiles(bundle: TaskBundle): TaskFile[] {
  const out: TaskFile[] = [];
  const seen = new Set<string>();
  const add = (a: Attachment, from: string) => {
    if (seen.has(a.url)) return;
    seen.add(a.url);
    out.push({ ...a, from });
  };
  const v = bundle.task.handoff_version ?? 1;
  for (const a of attachmentsOf(bundle.handoffAttachments)) add(a, `handoff v${v}`);
  for (const h of bundle.history) for (const a of attachmentsOf((h as any).attachments)) add(a, `handoff v${h.version}`);
  for (const m of bundle.messages) for (const a of attachmentsOf((m as any).attachments)) add(a, `${m.kind} ${m.id} by ${author(m)}`);
  return out;
}

/** Download to `dir/<stored name>` (stored names are unique and path-safe). Skips files already there with the same size. */
export async function downloadFile(
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  headers: Record<string, string>,
  dir: string,
  a: Attachment,
): Promise<string> {
  if (a.ref === 'link') throw new AttachError(`${a.original || a.name} is a link (${a.url}), not stored on the hub`);
  const name = localName(a);
  if (!SAFE_NAME.test(name)) throw new AttachError(`unsafe file name ${name}`);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, name);
  try {
    if (a.size && statSync(dest).size === a.size) return dest;
  } catch {
    /* not there yet */
  }
  let res = await fetchFn(url, { method: 'GET', headers, ...(a.ref === 'upload' ? { redirect: 'manual' as const } : {}) });
  // direct uploads: the hub answers with a presigned bucket URL; fetch it without our credentials
  if (a.ref === 'upload' && res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    res = await fetchFn(String(res.headers.get('location')), { method: 'GET' });
  }
  if (!res.ok || !res.body) throw new AttachError(`download ${a.original || a.name}: ${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest, { mode: 0o600 }));
  return dest;
}

export function humanSize(n: number): string {
  if (!n) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// ---- Direct upload to the hub's bucket for big files

export interface StorageConfig {
  direct_upload: boolean;
  direct_threshold_mb: number;
  direct_max_mb: number;
}

/** The upload target for a hub route: task:<id>, post:<id>, channel:<name>, or new_task (POST /tasks). */
export function uploadTarget(path: string): string | null {
  const p = path.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api\/ach/, '').split('?')[0];
  let m = /^\/tasks\/([^/]+)\/[a-z-]+$/.exec(p);
  if (m) return `task:${decodeURIComponent(m[1])}`;
  if (p === '/tasks') return 'new_task';
  m = /^\/posts\/([^/]+)\/replies$/.exec(p);
  if (m) return `post:${decodeURIComponent(m[1])}`;
  m = /^\/channels\/([^/]+)\/posts$/.exec(p);
  if (m) return `channel:${decodeURIComponent(m[1])}`;
  return null;
}

/** Files that should go straight to the bucket: media over the hub's threshold. */
export function bigFiles(files: string[], cfg: StorageConfig | null): string[] {
  if (!cfg || !cfg.direct_upload) return [];
  const min = cfg.direct_threshold_mb * 1048576;
  return files.filter((f) => !isLinkRef(f) && MEDIA_EXT.has((/\.([A-Za-z0-9]+)$/.exec(f)?.[1] ?? '').toLowerCase()) && statSync(f).size > min);
}
