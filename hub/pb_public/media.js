// Attachments on messages, handoff versions and channel posts: images and
// videos (inline), text/code (escaped preview with highlighting) and .html
// agent artifacts (preview only in a sandboxed srcdoc iframe).
// Files are PocketBase protected files: the URL carries a short-lived file
// token. A URL is only ever built from validated pieces and set through
// setMediaSrc(); a stored name or id that fails validation renders as text.

import { h, tag } from './render.js';
import { t } from './i18n.js';
import { artifactFrame, codeBlock, grammarFor, highlightCode } from './rich.js';
import DOMPurifyFactory from './vendor/purify.es.js';
import { refsOf, refItem } from './storage.js';

export const DEFAULT_LIMITS = {
  max_file_mb: 200,
  max_files: 10,
  mime_types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'],
  // text/code and .html reports, by extension, ≤ max_text_mb each
  text_ext: ['txt', 'md', 'json', 'ts', 'js', 'py', 'go', 'sh', 'diff', 'patch', 'log', 'csv', 'yaml', 'yml', 'sql', 'html', 'htm'],
  max_text_mb: 2,
};

const FILE_COLLECTIONS = new Set(['messages', 'handoff_versions', 'posts']);
const REC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_NAME_RE = /^[A-Za-z0-9._-]{1,255}$/;
const TOKEN_RE = /^[A-Za-z0-9._-]{0,4096}$/;

const EXT_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};

export function typeFromName(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return (m && EXT_TYPES[m[1]]) || '';
}

export function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

export function humanSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(v < 10240 ? 1 : 0)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 ** 3).toFixed(2)} GB`;
}

/** Same-origin protected-file URL, or null when any piece is not well-formed. */
export function fileUrl(collection, recordId, name, token) {
  if (!FILE_COLLECTIONS.has(collection) || !REC_ID_RE.test(String(recordId || '')) || !FILE_NAME_RE.test(String(name || ''))) return null;
  const tok = String(token || '');
  if (!TOKEN_RE.test(tok)) return null;
  return `/api/files/${collection}/${recordId}/${name}${tok ? `?token=${encodeURIComponent(tok)}` : ''}`;
}

/** The only way a src reaches the DOM: same-origin /api/files/... or a blob: preview. */
export function setMediaSrc(el, url) {
  const u = String(url || '');
  const ok = /^\/api\/files\/(messages|handoff_versions|posts)\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+(\?token=[A-Za-z0-9._%-]*)?$/.test(u)
    || /^blob:/.test(u);
  if (!ok) throw new Error('media url not allowed');
  el.setAttribute('src', u);
  return el;
}

/** [{name, original, size, type}] for a record's `attachments`, tolerant of missing meta. */
export function attachmentsOf(rec) {
  if (!rec) return [];
  // references (links, direct uploads: objects with `ref`) are rendered by refsOf (storage.js)
  const names = (Array.isArray(rec.attachments) ? rec.attachments : (rec.attachments ? [rec.attachments] : [])).filter((n) => !(n && typeof n === 'object' && n.ref));
  const meta = Array.isArray(rec.attachments_meta) ? rec.attachments_meta : [];
  return names.map((n) => {
    const name = typeof n === 'string' ? n : (n && n.name) || '';
    const m = meta.find((x) => x && !x.ref && x.name === name) || (typeof n === 'object' && n) || {};
    const ext = extOf(name);
    const textLang = DEFAULT_LIMITS.text_ext.includes(ext) ? (ext === 'htm' ? 'html' : ext) : '';
    // the type comes from the name the hub stored, never from agent-written meta alone
    const type = textLang ? (textLang === 'html' ? 'text/html' : 'text/plain')
      : (DEFAULT_LIMITS.mime_types.includes(m.type) ? m.type : typeFromName(name));
    return { name, original: String(m.original || name), size: m.size, type, lang: textLang };
  });
}

function caption(a) {
  const size = humanSize(a.size);
  return h('div', { class: 'att-cap' },
    h('span', { class: 'att-name', text: a.original }),
    size ? h('span', { class: 'att-size', text: size }) : null);
}

/**
 * Attachment strip for a record.
 * opts: { collection, token(): string, freshToken(): Promise<string>, onOpen(item) }
 */
export function attachmentList(rec, opts) {
  const items = attachmentsOf(rec);
  // references (links, direct uploads) from attachments_meta (storage.js)
  const refs = refsOf(rec);
  if (!items.length && !refs.length) return null;
  return h('div', { class: 'atts' }, items.map((a) => attachmentItem(rec, a, opts)), refs.map((r) => refItem(r, opts)));
}

export function attachmentItem(rec, a, opts) {
  const url = fileUrl(opts.collection, rec && rec.id, a.name, opts.token ? opts.token() : '');
  if (!url) return h('div', { class: 'att att-file' }, tag(t('file')), ' ', caption(a));
  if (a.type.startsWith('image/')) {
    const img = h('img', { class: 'att-img', attrs: { alt: a.original, loading: 'lazy' } });
    setMediaSrc(img, url);
    const btn = h('button', {
      class: 'att-thumb', attrs: { type: 'button', 'aria-label': `${t('open_file')}: ${a.original}` },
      on: { click: () => opts.onOpen && opts.onOpen({ rec, a, collection: opts.collection }) },
    }, img);
    return h('figure', { class: 'att att-image' }, btn, caption(a));
  }
  if (a.type.startsWith('video/')) {
    const v = h('video', { class: 'att-video', attrs: { controls: true, preload: 'metadata' } });
    setMediaSrc(v, url);
    // The file token is short-lived: on a load error, retry once with a fresh one.
    let retried = false;
    v.addEventListener('error', async () => {
      if (retried || !opts.freshToken) return;
      retried = true;
      try {
        const u2 = fileUrl(opts.collection, rec.id, a.name, await opts.freshToken());
        if (u2) { setMediaSrc(v, u2); v.load(); }
      } catch (_) { /* leave it */ }
    });
    return h('figure', { class: 'att att-video-wrap' }, v, caption(a));
  }
  if (a.type === 'text/plain' || a.type === 'text/html') return textAttachment(rec, a, opts);
  return h('div', { class: 'att att-file' }, tag(t('file')), ' ', caption(a));
}

let purifier = null;
function purify(html, cfg) {
  if (!purifier) purifier = DOMPurifyFactory(window);
  return purifier.sanitize(html, cfg);
}

/**
 * Text/code or HTML attachment: a card; "preview" fetches the text (served by
 * the hub as text/plain) and shows it escaped + highlighted, or for .html in a
 * sandboxed srcdoc iframe; "download" saves it as a text/plain file.
 * opts.fetchText(collection, recordId, name) -> Promise<string>
 */
export function textAttachment(rec, a, opts) {
  const isHtml = a.type === 'text/html';
  const body = h('div', { class: 'att-preview', attrs: { hidden: true } });
  const err = h('span', { class: 'error' });
  let loaded = null;
  const load = async () => {
    if (loaded !== null) return loaded;
    if (!opts.fetchText) throw new Error('no preview');
    loaded = String(await opts.fetchText(opts.collection, rec.id, a.name));
    return loaded;
  };
  const preview = h('button', {
    class: 'btn link', attrs: { type: 'button' }, text: `[${t('preview')}]`,
    on: {
      click: async () => {
        err.textContent = '';
        if (!body.hidden) { body.hidden = true; return; }
        try {
          const text = await load();
          if (!body.firstChild) {
            if (isHtml) body.appendChild(artifactFrame(text, a.original));
            else {
              const code = document.createElement('code');
              code.textContent = text;
              const pre = document.createElement('pre');
              pre.appendChild(code);
              body.appendChild(pre);
              if (grammarFor(a.lang)) highlightCode(code, a.lang, purify);
              codeBlock(pre, a.lang);
            }
          }
          body.hidden = false;
        } catch (ex) { err.textContent = `${t('error')}: ${(ex && ex.message) || ex}`; }
      },
    },
  });
  const download = h('button', {
    class: 'btn link', attrs: { type: 'button' }, text: `[${t('download')}]`,
    on: {
      click: async () => {
        err.textContent = '';
        try {
          const blob = new Blob([await load()], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = String(a.original || a.name).replace(/[^A-Za-z0-9._-]/g, '_') + (isHtml ? '.txt' : '');
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch (ex) { err.textContent = `${t('error')}: ${(ex && ex.message) || ex}`; }
      },
    },
  });
  return h('div', { class: `att att-text${isHtml ? ' att-html' : ''}`, attrs: { 'data-id': a.name } },
    h('div', { class: 'att-row' }, tag(isHtml ? 'html' : (a.lang || 'text')), ' ', caption(a), preview, download, err),
    body);
}

/** Full-screen image viewer. Esc, a click, or the close button dismisses it. */
export function openLightbox(url, label) {
  const img = h('img', { class: 'lb-img', attrs: { alt: label || '' } });
  setMediaSrc(img, url);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const overlay = h('div', { class: 'lightbox', attrs: { role: 'dialog', 'aria-label': label || t('open_file') }, on: { click: close } },
    img,
    h('div', { class: 'lb-cap', text: label || '' }),
    h('button', { class: 'btn lb-close', attrs: { type: 'button' }, text: t('close'), on: { click: close } }));
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  return overlay;
}

/** Client-side checks before upload. Returns {ok: File[], errors: string[]}. */
export function checkFiles(files, limits, already = 0) {
  const L = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const ok = [];
  const errors = [];
  for (const f of files) {
    const ext = extOf(f.name);
    const isText = (L.text_ext || []).includes(ext);
    const type = isText ? 'text' : (f.type || typeFromName(f.name));
    if (!isText && !L.mime_types.includes(type)) { errors.push(t('file_type', { name: f.name })); continue; }
    if (isText && f.size > (L.max_text_mb || 2) * 1024 * 1024) { errors.push(t('file_too_big', { name: f.name, mb: L.max_text_mb || 2 })); continue; }
    if (f.size > L.max_file_mb * 1024 * 1024) { errors.push(t('file_too_big', { name: f.name, mb: L.max_file_mb })); continue; }
    if (already + ok.length >= L.max_files) { errors.push(t('too_many_files', { n: L.max_files })); break; }
    ok.push(f);
  }
  return { ok, errors };
}
