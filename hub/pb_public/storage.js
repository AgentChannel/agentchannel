// attachment references (links to existing objects and
// direct uploads to the hub's bucket), big-file uploads straight to the
// bucket with a progress bar, and the admin storage view (usage per channel,
// retention). The CSP (a hub response header) allows img/media only from the
// link allowlist and the bucket origin, so a link outside the allowlist is a
// link card, never an <img>.

import { h, tag, extLink } from './render.js';
import { getLang } from './i18n.js';

const UPLOAD_ID_RE = /^[a-z0-9]{15}$/;
const TOKEN_RE = /^[A-Za-z0-9._-]{0,4096}$/;
const MEDIA = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'];
const MEDIA_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
const URL_RE = /^https:\/\/([A-Za-z0-9.-]+)(:[0-9]{1,5})?(\/[^\s"'<>\\^`{|}]*)?$/;

const STR = {
  en: {
    link: 'link', uploaded: 'file', open: 'open', retention: 'Retention', keep_all: 'keep all', days: '{n} days',
    direct: 'Direct uploads', direct_on: 'on (files over {t} MB go straight to storage, max {m} MB)', direct_off: 'off (needs S3/R2 storage)',
    links: 'Linked objects', channel: 'Channel', hub_files: 'On the hub', uploads: 'Uploads', save: 'Save',
    retention_hint: 'Deletes attachments of finished tasks older than N days, except those flagged keep (ach keep). 0 keeps everything. Links are never deleted.',
    last_run: 'Last run', uploading: 'Uploading {name} to storage…',
  },
  zh: {
    link: '链接', uploaded: '文件', open: '打开', retention: '保留期', keep_all: '全部保留', days: '{n} 天',
    direct: '直传存储', direct_on: '已开启（超过 {t} MB 的文件直传存储，上限 {m} MB）', direct_off: '未开启（需要 S3/R2 存储）',
    links: '链接引用', channel: '频道', hub_files: '存在 hub', uploads: '直传', save: '保存',
    retention_hint: '删除已结束任务中超过 N 天的附件，标记为 keep 的除外（ach keep）。0 表示全部保留。链接不会被删除。',
    last_run: '上次执行', uploading: '正在上传 {name} 到存储…',
  },
};
function s(key, vars) {
  const d = STR[getLang && getLang() === 'zh' ? 'zh' : 'en'];
  return String(d[key] || STR.en[key] || key).replace(/\{(\w+)\}/g, (_, k) => String(vars && vars[k] != null ? vars[k] : ''));
}

function size(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 ** 3).toFixed(2)} GB`;
}

// ---------- config (GET /api/ach/storage/config, loaded once after login) ----------

let cfg = { direct_upload: false, direct_threshold_mb: 90, direct_max_mb: 5120, link_hosts: [], storage_origin: '' };

export function setStorageConfig(c) {
  if (!c || typeof c !== 'object') return;
  cfg = {
    direct_upload: c.direct_upload === true,
    direct_threshold_mb: Math.max(5, Number(c.direct_threshold_mb) || 90),
    direct_max_mb: Math.max(1, Number(c.direct_max_mb) || 5120),
    link_hosts: Array.isArray(c.link_hosts) ? c.link_hosts.map((x) => String(x).toLowerCase()).filter((x) => /^[a-z0-9.-]+$/.test(x)) : [],
    storage_origin: typeof c.storage_origin === 'string' ? c.storage_origin : '',
  };
}
export function storageConfig() { return cfg; }

/** Composer limits: with direct upload on, images and videos may be as big as the bucket allows. */
export function effectiveLimits(limits) {
  if (!cfg.direct_upload || !limits) return limits;
  return { ...limits, max_file_mb: Math.max(Number(limits.max_file_mb) || 0, cfg.direct_max_mb) };
}

function hostAllowed(host) {
  host = String(host || '').toLowerCase();
  return cfg.link_hosts.some((d) => host === d || host.endsWith(`.${d}`));
}

/** True when the panel may load this https URL as an image/video (its host is on the link allowlist, as in the CSP). */
export function previewable(url) {
  const m = URL_RE.exec(String(url || ''));
  return !!m && hostAllowed(m[1]);
}

// ---------- references on a record ----------

/** [{ref, url|upload, name, type, size, keep}] from a raw record's attachments_meta (validated). */
export function refsOf(rec) {
  // the API puts references in `attachments` (objects with `ref`); raw
  // records keep them in `attachments_meta`. Read both, once each.
  const meta = rec && Array.isArray(rec.attachments_meta) ? rec.attachments_meta : [];
  const inline = rec && Array.isArray(rec.attachments) ? rec.attachments.filter((x) => x && typeof x === 'object' && x.ref) : [];
  const out = [];
  const seen = new Set();
  for (const x of meta.concat(inline)) {
    if (!x || typeof x !== 'object') continue;
    const k = x.ref === 'link' ? `l:${x.url}` : `u:${x.upload}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!x || typeof x !== 'object' || x.purged) continue;
    const name = String(x.original || x.name || '').slice(0, 255);
    const ext = (/\.([A-Za-z0-9]{2,5})(?:[?#]|$)/.exec(String(x.url || x.name || '')) || [])[1];
    const type = MEDIA.includes(x.type) ? x.type : (MEDIA_EXT[String(ext || '').toLowerCase()] || '');
    if (x.ref === 'link' && URL_RE.test(String(x.url || ''))) out.push({ ref: 'link', url: String(x.url), name: name || 'link', type, size: Number(x.size) || 0, keep: !!x.keep });
    else if (x.ref === 'upload' && UPLOAD_ID_RE.test(String(x.upload || ''))) out.push({ ref: 'upload', upload: String(x.upload), name: name || 'file', type, size: Number(x.size) || 0, keep: !!x.keep });
  }
  return out;
}

/** Same-origin download URL of a direct upload (redirects to a presigned bucket URL), or null. */
export function uploadUrl(id, token) {
  const tok = String(token || '');
  if (!UPLOAD_ID_RE.test(String(id || '')) || !TOKEN_RE.test(tok)) return null;
  return `/api/ach/uploads/${id}/raw${tok ? `?token=${encodeURIComponent(tok)}` : ''}`;
}

/** The only way a reference's src reaches the DOM. */
export function setRefSrc(el, url) {
  const u = String(url || '');
  const ok = /^\/api\/ach\/uploads\/[a-z0-9]{15}\/raw(\?token=[A-Za-z0-9._%-]*)?$/.test(u) || previewable(u);
  if (!ok) throw new Error('reference url not allowed');
  el.setAttribute('src', u);
  if (u.startsWith('https://')) el.setAttribute('referrerpolicy', 'no-referrer');
  return el;
}

function cap(r) {
  return h('div', { class: 'att-cap' },
    h('span', { class: 'att-name', text: r.name }),
    size(r.size) ? h('span', { class: 'att-size', text: size(r.size) }) : null,
    r.keep ? h('span', { class: 'muted small', text: ' keep' }) : null);
}

/** A reference: inline image/video when allowed, else a link card. opts.token(): file token. */
export function refItem(r, opts = {}) {
  const src = r.ref === 'upload' ? uploadUrl(r.upload, opts.token ? opts.token() : '') : (previewable(r.url) ? r.url : null);
  if (src && r.type.startsWith('image/')) {
    const img = h('img', { class: 'att-img', attrs: { alt: r.name, loading: 'lazy' } });
    setRefSrc(img, src);
    return h('figure', { class: 'att att-image att-ref', attrs: { 'data-type': r.ref } }, img, cap(r));
  }
  if (src && r.type.startsWith('video/')) {
    const v = h('video', { class: 'att-video', attrs: { controls: true, preload: 'metadata' } });
    setRefSrc(v, src);
    return h('figure', { class: 'att att-video-wrap att-ref', attrs: { 'data-type': r.ref } }, v, cap(r));
  }
  const href = r.ref === 'link' ? r.url : src;
  return h('div', { class: 'att att-file att-ref att-link', attrs: { 'data-type': r.ref } },
    tag(r.ref === 'link' ? s('link') : s('uploaded')), ' ',
    href && /^https:\/\//.test(href) ? extLink(href, r.name) : (href ? downloadLink(href, r.name) : h('span', { text: r.name })),
    size(r.size) ? h('span', { class: 'att-size', text: ` ${size(r.size)}` }) : null,
    r.ref === 'link' ? h('span', { class: 'muted small', text: ` ${URL_RE.exec(r.url)[1]}` }) : null);
}

function downloadLink(href, text) {
  const a = document.createElement('a');
  if (!/^\/api\/ach\/uploads\/[a-z0-9]{15}\/raw(\?token=[A-Za-z0-9._%-]*)?$/.test(href)) return h('span', { text });
  a.setAttribute('href', href);
  a.setAttribute('target', '_blank');
  a.setAttribute('rel', 'noopener noreferrer');
  a.textContent = text;
  return a;
}

// ---------- big files straight to the bucket ----------

/** The upload target for a panel route (same mapping as the CLI). */
export function uploadTarget(path) {
  const p = String(path || '').split('?')[0];
  let m = /^\/tasks\/([^/]+)\/[a-z-]+$/.exec(p);
  if (m) return `task:${decodeURIComponent(m[1])}`;
  m = /^\/posts\/([^/]+)\/replies$/.exec(p);
  if (m) return `post:${decodeURIComponent(m[1])}`;
  m = /^\/channels\/([^/]+)\/posts$/.exec(p);
  if (m) return `channel:${decodeURIComponent(m[1])}`;
  return null;
}

function mimeOf(f) {
  const ext = (String(f.name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  return MEDIA_EXT[ext] || '';
}

/** Files that go direct: images/videos over the threshold, when the hub has S3 storage and the route has a target. */
export function bigFiles(path, files) {
  if (!cfg.direct_upload || !uploadTarget(path)) return [];
  const min = cfg.direct_threshold_mb * 1024 * 1024;
  return files.filter((f) => mimeOf(f) && f.size > min);
}

function putWithProgress(url, headers, file, onBytes) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    for (const [k, v] of Object.entries(headers || {})) x.setRequestHeader(k, v);
    if (x.upload) x.upload.onprogress = (e) => { if (e.lengthComputable) onBytes(e.loaded); };
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error(`storage: HTTP ${x.status}`)));
    x.onerror = () => reject(new Error('storage: network error (check the bucket CORS rules)'));
    x.send(file);
  });
}

/**
 * Upload the big files of a send directly to the bucket. Returns
 * {files: the rest (sent through the hub as before), refs: [{upload}]}.
 * api(path, method, body) is the panel's /api/ach caller.
 */
export async function directUploads(path, files, onProgress, api) {
  const big = bigFiles(path, files);
  if (!big.length) return { files, refs: [] };
  const target = uploadTarget(path);
  const total = files.reduce((n, f) => n + (f.size || 0), 0) || 1;
  let done = 0;
  const refs = [];
  for (const f of big) {
    const mime = mimeOf(f);
    const p = await api('/uploads/presign', 'POST', { name: f.name, mime, size: f.size, target });
    if (!p || !p.put || !/^https?:\/\//.test(String(p.put.url || ''))) throw new Error('presign failed');
    await putWithProgress(p.put.url, p.put.headers || { 'content-type': mime }, f, (n) => onProgress && onProgress(Math.min(1, (done + n) / total)));
    done += f.size;
    const c = await api('/uploads/complete', 'POST', { upload: p.upload.id });
    refs.push({ upload: String((c && c.ref && c.ref.upload) || p.upload.id) });
  }
  // the hub part of the send continues the bar from here
  const rest = files.filter((f) => !big.includes(f));
  const scaled = onProgress ? (frac) => onProgress(Math.min(1, (done + frac * (total - done)) / total)) : onProgress;
  return { files: rest, refs, onProgress: scaled };
}

// ---------- admin: storage detail and retention ----------

/** o: { detail, onRetention(channelName, days) } */
export function storageDetailView(o) {
  const d = o && o.detail;
  if (!d || !Array.isArray(d.channels)) return null;
  const err = h('div', { class: 'error' });
  const rows = d.channels.map((c) => {
    const inp = h('input', { attrs: { type: 'number', min: 0, max: 3650, step: 1, value: String(c.retention_days || 0), 'aria-label': `${s('retention')} #${c.name}` } });
    const form = h('form', {
      class: 'retention',
      on: {
        submit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          try { await o.onRetention(c.name, Math.max(0, Math.floor(Number(inp.value) || 0))); } catch (ex) { err.textContent = String((ex && ex.message) || ex); }
        },
      },
    }, inp, h('button', { class: 'btn', attrs: { type: 'submit' }, text: s('save') }));
    return h('tr', { attrs: { 'data-id': c.id } },
      h('td', { text: `#${c.name}` }),
      h('td', { text: `${c.files} · ${size(c.bytes) || '0 B'}` }),
      h('td', { text: `${c.direct_files} · ${size(c.direct_bytes) || '0 B'}` }),
      h('td', {}, form, h('span', { class: 'muted small', text: c.retention_days ? s('days', { n: c.retention_days }) : s('keep_all') })));
  });
  const last = d.retention_last_run && d.retention_last_run.at ? `${s('last_run')}: ${String(d.retention_last_run.at).slice(0, 16).replace('T', ' ')}` : '';
  return h('div', { class: 'storage-detail' },
    h('div', { class: 'muted small', text: `${s('direct')}: ${d.direct_upload ? s('direct_on', { t: d.direct_threshold_mb, m: d.direct_max_mb }) : s('direct_off')} · ${d.direct_uploads.files} · ${size(d.direct_uploads.bytes) || '0 B'}` }),
    h('div', { class: 'muted small', text: `${s('links')}: ${d.link_refs}` }),
    h('h3', { text: s('retention') }),
    h('p', { class: 'muted small', text: s('retention_hint') }),
    h('table', { class: 'storage-table' },
      h('thead', {}, h('tr', {}, h('th', { text: s('channel') }), h('th', { text: s('hub_files') }), h('th', { text: s('uploads') }), h('th', { text: s('retention') }))),
      h('tbody', {}, rows)),
    last ? h('div', { class: 'muted small', text: last }) : null,
    err);
}
