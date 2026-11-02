// Pure render helpers for the panel. No network, no global state beyond the
// document. Every piece of data reaches the DOM either as a text node / safe
// attribute through h(), or as markdown through renderMarkdown() (marked, then
// DOMPurify). Never assign data to innerHTML anywhere else.

import { marked } from './vendor/marked.esm.js';
import DOMPurifyFactory from './vendor/purify.es.js';
import { t, has, QUICK_DECISIONS } from './i18n.js';
import { autolink, enhance, autolinkText } from './rich.js';

export const TERMINAL = new Set(['completed', 'failed', 'canceled']);
export const IDLE_WARN_MS = 24 * 3600 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---------- escaping & markdown ----------

export function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"'`]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;',
  }[c]));
}

let purifier = null;
function getPurifier() {
  if (purifier) return purifier;
  const win = globalThis.window;
  if (!win || !win.document) throw new Error('renderMarkdown needs a DOM window');
  purifier = DOMPurifyFactory(win);
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') || '';
      if (!/^(https?:|mailto:|#)/i.test(href)) node.removeAttribute('href');
      // in-panel links (#/c/…, #/t/T-128, …) stay in this tab; the rest open a new one
      if (/^#\/[A-Za-z0-9_/@.%-]*$/.test(href)) {
        node.removeAttribute('target');
      } else {
        if (href.startsWith('#')) node.removeAttribute('href');
        node.setAttribute('target', '_blank');
      }
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
  return purifier;
}

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option',
    'iframe', 'frame', 'object', 'embed', 'base', 'link', 'meta', 'svg', 'math'],
  FORBID_ATTR: ['style', 'id', 'name', 'class', 'srcset'],
  ALLOW_DATA_ATTR: false,
};

/**
 * Markdown string -> sanitized HTML string. The only path from data to HTML:
 * marked, then the autolink tokenizer (DOM-built links in an inert
 * template), then DOMPurify.
 */
export function renderMarkdown(src) {
  const raw = marked.parse(String(src ?? ''), { async: false, gfm: true, breaks: true });
  return getPurifier().sanitize(autolink(raw), PURIFY_CONFIG);
}

// hosts whose links render as embeds (admin-managed; the hub's CSP
// frame-src is built from the same list). Set by app.js from /api/ach/settings.
let embedHosts = [];
export function setEmbedHosts(list) {
  embedHosts = Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
}

// ---------- avatars (hub-cached images, pb_hooks/ach_avatars.js) ----------
// People: the hub's chosen picture, else initials. Agents: the owner's picture
// with a small runtime badge, else initials with the badge. Images come only
// from this hub (/api/files/avatars/...?thumb=128x128); any other URL is ignored.
// TODO(brand): the badge is a neutral text glyph. To use the official Claude
// (Anthropic) and OpenAI/Codex marks, drop the unmodified files from their
// brand/press pages into vendor/brand/ (note source URL + license in
// vendor/VERSIONS.txt), check both brand guidelines, then render them here.
const AVATAR_URL_RE = /^\/api\/files\/avatars\/[a-z0-9]{15}\/[A-Za-z0-9_.-]{1,120}\?thumb=128x128$/;
export const RUNTIME_GLYPH = { claude: 'C', codex: 'X' };
// Official marks, unmodified (sources in vendor/VERSIONS.txt); the glyph stays as alt text and fallback.
export const RUNTIME_MARK = { claude: 'vendor/brand/claude-icon.svg', codex: 'vendor/brand/openai-symbol.svg' };
const GENERIC_GLYPH = '•';
let avatarData = { byName: new Map(), byId: new Map(), agents: new Map() };

/** Set from GET /api/ach/avatars (app.js). */
export function setAvatars(d) {
  const byName = new Map();
  const byId = new Map();
  const agents = new Map();
  for (const u of (d && Array.isArray(d.users) ? d.users : [])) {
    const url = typeof u.url === 'string' && AVATAR_URL_RE.test(u.url) ? u.url : null;
    if (typeof u.id === 'string') byId.set(u.id, url);
    if (typeof u.name === 'string' && url && !byName.has(u.name)) byName.set(u.name, url);
  }
  for (const a of (d && Array.isArray(d.agents) ? d.agents : [])) {
    if (typeof a.name === 'string') agents.set(a.name, { owner: String(a.owner || ''), runtime: String(a.runtime || 'other') });
  }
  avatarData = { byName, byId, agents };
}

/** {url, runtime} for a person ("human") or an agent, by display name. */
export function avatarInfo(kind, name) {
  const n = String(name || '');
  if (kind === 'human') return { url: avatarData.byName.get(n) || null, runtime: null };
  const a = avatarData.agents.get(n);
  if (!a) return { url: null, runtime: null };
  return { url: avatarData.byId.get(a.owner) || null, runtime: a.runtime };
}

/** The avatar element: picture (from the hub only) or `text`, plus the runtime badge for agents. */
export function avatarNode(kind, name, cls, text) {
  const info = avatarInfo(kind, name);
  const el = h('span', { class: `avatar ${kind === 'human' ? 'human' : 'agent'}${cls ? ` ${cls}` : ''}${info.url ? ' pic' : ''}`, attrs: { 'aria-hidden': 'true' } });
  const label = h('span', { class: 'av-text', text });
  if (info.url) {
    const img = document.createElement('img');
    img.setAttribute('alt', '');
    img.setAttribute('loading', 'lazy');
    img.addEventListener('error', () => { img.remove(); el.classList.remove('pic'); el.insertBefore(label, el.firstChild); });
    img.setAttribute('src', info.url);
    el.appendChild(img);
  } else el.appendChild(label);
  if (kind !== 'human' && info.runtime) {
    const rt = /^[a-z]+$/.test(info.runtime) ? info.runtime : 'other';
    const badge = h('span', { class: `av-badge rt-${rt}`, attrs: { title: has(`rt_${rt}`) ? t(`rt_${rt}`) : t('rt_other') }, text: RUNTIME_GLYPH[rt] || GENERIC_GLYPH });
    if (RUNTIME_MARK[rt]) {
      const mark = document.createElement('img');
      mark.setAttribute('alt', RUNTIME_GLYPH[rt]);
      mark.setAttribute('src', RUNTIME_MARK[rt]);
      mark.addEventListener('error', () => { mark.remove(); badge.textContent = RUNTIME_GLYPH[rt]; });
      badge.textContent = '';
      badge.classList.add('mark');
      badge.appendChild(mark);
    }
    el.appendChild(badge);
  }
  return el;
}

// absolute links back into this panel (same origin, or the hub's
// ACH_PUBLIC_URL) render as in-app chips; `label(hash)` may name the target.
let linkCtx = { origins: [], label: null };
export function setLinkContext(o) {
  const origins = [];
  for (const u of (o && o.origins) || []) {
    try { const x = new URL(String(u)); if (/^https?:$/.test(x.protocol)) origins.push(x.origin); } catch (_) { /* skip */ }
  }
  linkCtx = { origins, label: o && typeof o.label === 'function' ? o.label : null };
}

// B16: bare "#335" links to the issue of the repo in context (a task's links).
let issueBase = '';
/** Run fn with "#123" autolinking to `base` (https://github.com/owner/repo), then restore. */
export function withIssueBase(base, fn) {
  const prev = issueBase;
  issueBase = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(String(base || '')) ? String(base) : '';
  try { return fn(); } finally { issueBase = prev; }
}

/** GitHub repo URL for a task's links (links.issue / links.pr / "owner/repo" in links.repo), or ''. */
export function issueBaseOf(links) {
  if (!links || typeof links !== 'object') return '';
  for (const k of ['issue', 'pr']) {
    const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})(?:\/|$)/.exec(String(links[k] || ''));
    if (m) return `https://github.com/${m[1]}/${m[2]}`;
  }
  const r = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(String(links.repo || ''));
  return r ? `https://github.com/${r[1]}/${r[2]}` : '';
}

/** Markdown -> <div class="md"> element, with code blocks, GitHub cards and embeds. */
export function mdNode(src) {
  const div = document.createElement('div');
  div.className = 'md';
  div.innerHTML = renderMarkdown(src);
  enhance(div, {
    embedHosts, purify: (html, cfg) => getPurifier().sanitize(html, cfg),
    origins: [window.location.origin, ...linkCtx.origins], chipLabel: linkCtx.label, issueBase,
  });
  return div;
}

/** Plain text with #channel, @agent and T-128 as in-app links (system lines, task header text). */
export function linkedText(text, cls) {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.appendChild(autolinkText(String(text ?? '')));
  return span;
}

// ---------- element builder ----------

const SAFE_ATTRS = new Set(['type', 'placeholder', 'value', 'name', 'title', 'min', 'step',
  'pattern', 'required', 'autocomplete', 'rows', 'for', 'id', 'disabled', 'selected',
  'checked', 'readonly', 'aria-label', 'data-draft', 'datetime', 'inputmode', 'maxlength',
  'data-key', 'data-id', 'data-task', 'data-type', 'open', 'controls', 'preload', 'alt', 'accept', 'multiple', 'hidden',
  'tabindex', 'role', 'aria-expanded', 'aria-hidden', 'max', 'loading', 'data-ago', 'data-prefix', 'aria-pressed', 'aria-live', 'enterkeyhint']);
// src is never a generic attribute: media URLs go through setMediaSrc() (media.js).

/**
 * h(tag, props, ...children)
 * props: { class, text, href (internal "#/..." only), attrs: {...}, on: {event: fn} }
 * children: Node | string | number | null | array; strings become text nodes.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  const p = props || {};
  if (p.class) el.className = p.class;
  if (p.text != null) el.textContent = String(p.text);
  if (p.href != null) el.setAttribute('href', safeInternalHref(p.href));
  if (p.attrs) {
    for (const [k, v] of Object.entries(p.attrs)) {
      if (v == null || v === false) continue;
      if (!SAFE_ATTRS.has(k)) throw new Error(`attribute not allowed: ${k}`);
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (p.on) for (const [ev, fn] of Object.entries(p.on)) el.addEventListener(ev, fn);
  appendAll(el, children);
  return el;
}

function appendAll(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendAll(el, c);
    else if (typeof c === 'object' && c.nodeType) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function safeInternalHref(href) {
  const s = String(href);
  return /^#\/[A-Za-z0-9_/@.%-]*$/.test(s) ? s : '#/';
}

/** A task's permalink: #/t/T-128 when the number is known, else #/t/<id>. */
export function taskHref(id, seq) {
  if (Number.isInteger(Number(seq)) && Number(seq) > 0) return `#/t/T-${Number(seq)}`;
  const s = String(id ?? '');
  if (/^T-[0-9]{1,9}$/.test(s)) return `#/t/${s}`;
  return ID_RE.test(s) ? `#/t/${s}` : '#/';
}

/** Task label: "T-128" when numbered. */
export function taskRefOf(task) {
  const n = Number(task && task.seq);
  return Number.isInteger(n) && n > 0 ? `T-${n}` : '';
}

/**
 * External link (P7: GitHub issue / PR). Only absolute http(s) URLs become
 * links (new tab, no referrer, no opener); anything else is plain text.
 */
export function extLink(url, text) {
  const u = String(url ?? '');
  if (!/^https?:\/\/[^\s"'<>`]+$/i.test(u)) return h('span', { text: text ?? u });
  const a = document.createElement('a');
  a.setAttribute('href', u);
  a.setAttribute('target', '_blank');
  a.setAttribute('rel', 'noopener noreferrer nofollow');
  a.textContent = text ?? u;
  return a;
}

/** P1: who holds the claim: the runner (auto-wake) or the owner's interactive agent. */
export function claimTag(task) {
  const m = task && task.claim_mode;
  if (m !== 'runner' && m !== 'interactive') return null;
  return tag(t(`claim_${m}`), m === 'interactive' ? 'strong' : '');
}

/** "[text]" label, the panel's only kind of badge. */
export function tag(text, cls) {
  return h('span', { class: 'tag' + (cls ? ' ' + cls : ''), text: `[${text}]` });
}

// ---------- formatting ----------

export function parseDate(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function ago(s, now = Date.now()) {
  const d = parseDate(s);
  if (!d) return t('never');
  const sec = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (sec < 60) return t('ago_s');
  if (sec < 3600) return t('ago_m', { n: Math.floor(sec / 60) });
  if (sec < 86400) return t('ago_h', { n: Math.floor(sec / 3600) });
  return t('ago_d', { n: Math.floor(sec / 86400) });
}

/**
 * A relative time that keeps itself fresh: app.js re-renders every
 * [data-ago] once a minute (tickTimes) without rebuilding the pane.
 */
export function agoSpan(s, now = Date.now(), o = {}) {
  const prefix = o.prefix || '';
  return h('span', { class: o.class || 'time', attrs: { title: o.title === false ? null : when(s, now), 'data-ago': String(s || ''), 'data-prefix': prefix || null }, text: `${prefix}${ago(s, now)}` });
}
/** Refresh every [data-ago] under el (relative times, once a minute). */
export function tickTimes(el, now = Date.now()) {
  if (!el) return;
  for (const x of el.querySelectorAll('[data-ago]')) {
    const v = `${x.getAttribute('data-prefix') || ''}${ago(x.getAttribute('data-ago'), now)}`;
    if (x.textContent !== v) x.textContent = v;
  }
}

/** The task's free-text money field, or '' when it says nothing ("n/a", "none", "-", empty, or the Chinese for "none" / "n/a"). */
export function moneyText(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return !s || /^(n\/?a|none|null|no|-+|—|0|\$0(\.0+)?|无|不适用)$/i.test(s) ? '' : s;
}

/** Markdown and filler stripped from a search/inbox snippet (plain text, one line). */
export function plainSnippet(v) {
  return String(v ?? '')
    .replace(/```[a-z0-9_+-]*/gi, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(^|\s)(?:>|[-*+]|\d+\.)\s+/g, '$1')
    .replace(/(^|\s)n\/a(?=\s|$|[.,;])/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function money(v, estimated) {
  const n = Number(v);
  const s = '$' + (Number.isFinite(n) ? n : 0).toFixed(n && Math.abs(n) < 0.01 ? 4 : 2);
  // F13: "$0.00 est." says nothing; drop the marker when the cost is 0
  return estimated && Number.isFinite(n) && n !== 0 ? `${s} ${t('est')}` : s;
}

const pad2 = (n) => String(n).padStart(2, '0');
/** Local day key "YYYY-MM-DD" (day separators). */
export function dayKey(s) {
  const d = parseDate(s);
  return d ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : '';
}
/** "Today" / "Yesterday" / "Mon 10-27" / "2025-10-27". */
export function dayLabel(s, now = Date.now()) {
  const d = parseDate(s);
  if (!d) return '';
  const k = dayKey(s);
  const today = new Date(now);
  if (k === dayKey(today.toISOString())) return t('today');
  if (k === dayKey(new Date(now - 86400000).toISOString())) return t('yesterday');
  return d.getFullYear() === today.getFullYear() ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : k;
}
/** F3: a real time, not just "just now": "14:02" today, else "10-29 14:02". */
export function when(s, now = Date.now()) {
  const d = parseDate(s);
  if (!d) return t('never');
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (dayKey(s) === dayKey(new Date(now).toISOString())) return hm;
  const md = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return d.getFullYear() === new Date(now).getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`;
}

/** F8: translated status / message-kind labels ([submitted] -> its translation). */
export function statusLabel(s) { return s && has(`st_${s}`) ? t(`st_${s}`) : String(s || '?'); }
export function kindLabel(k) { return k && has(`k_${k}`) ? t(`k_${k}`) : String(k || 'note'); }
export function statusTag(s) { return tag(statusLabel(s), s === 'input-required' ? 'strong accent' : ''); }

export function isIdle(task, now = Date.now()) {
  if (!task || TERMINAL.has(task.status)) return false;
  const d = parseDate(task.last_activity || task.updated || task.created);
  return !!d && now - d.getTime() > IDLE_WARN_MS;
}

// ---------- context helpers ----------
// ctx = { agentName(id|obj) -> string, agentRuntime(id) -> string, userName(id) -> string, now }

function relId(v) { return v && typeof v === 'object' ? v.id : v; }

export function agentLabel(ctx, task, field) {
  const exp = task && task.expand && task.expand[field];
  if (exp && exp.name) return exp.name;
  const direct = task && (task[`${field}_name`] || (field === 'from_agent' ? task.from_name : task.to_name));
  if (direct) return direct;
  const v = task && task[field];
  if (v && typeof v === 'object' && v.name) return v.name;
  return ctx.agentName(relId(v));
}

export function isEstimated(ctx, task) {
  if (!task) return false;
  if (task.cost_estimated === true || task.estimated === true) return true;
  const exp = task.expand && task.expand.to_agent;
  const rt = (exp && exp.runtime) || ctx.agentRuntime(relId(task.to_agent));
  return rt === 'codex';
}

export function waitingLabel(ctx, w) {
  if (!w) return '';
  const [kind, id] = String(w).split(':');
  if (kind === 'agent') return ctx.agentName(id);
  if (kind === 'human') return ctx.userName(id);
  return String(w);
}

// ---------- view pieces ----------

/** One task line in a home section. */
export function taskRow(task, ctx) {
  const from = agentLabel(ctx, task, 'from_agent');
  const to = agentLabel(ctx, task, 'to_agent');
  const est = isEstimated(ctx, task);
  const row = h('div', { class: 'row' },
    h('div', { class: 'row-main' },
      tag(task.priority || 'P?', task.priority === 'P0' ? 'strong' : ''),
      ' ',
      h('a', { class: 'title', href: taskHref(task.id, task.seq), text: task.title || task.id || '?' }),
    ),
    h('div', { class: 'row-meta' },
      h('span', { class: 'agents', text: `${from} → ${to}` }),
      statusTag(task.status),
      TERMINAL.has(task.status) ? null : claimTag(task),
      h('span', { text: `${t('version')}${task.handoff_version ?? 1}` }),
      task.waiting_on ? h('span', { text: `${t('waiting_on')}: ${waitingLabel(ctx, task.waiting_on)}` }) : null,
      h('span', { class: 'muted', text: ago(task.last_activity || task.updated, ctx.now) }),
      Number(task.cost_usd) ? h('span', { text: money(task.cost_usd, est) }) : null,
      isIdle(task, ctx.now) ? h('span', { class: 'warn', text: `⚠ ${t('idle')} >24h` }) : null,
    ),
  );
  return row;
}

/** One option as the person reads it: "label (Recommended) — detail · money" (the mark is plain text, no badge). */
export function optionLabel(o, recommended) {
  return `${String(o.label || '')}${recommended ? t('recommended_mark') : ''}${o.detail ? ` — ${o.detail}` : ''}${o.money ? ` · ${o.money}` : ''}`;
}

/** What a button sends: the option's label and detail (the reply is the decision). */
export function optionReply(o) {
  return `${String(o.label || '')}${o.detail ? ` — ${o.detail}` : ''}`;
}

/**
 * A multiple-choice reply form: the question, one button per option
 * (recommended first and marked "(Recommended)"), then a free-text reply box.
 * send(text) -> Promise. key: the draft key.
 */
export function choiceForm(choices, send, o = {}) {
  const draftKey = o.key || '';
  const ta = h('textarea', { attrs: { rows: 2, placeholder: t('or_reply'), 'data-draft': draftKey, 'aria-label': t('or_reply') } });
  ta.value = (draftKey && o.drafts && o.drafts.get(draftKey)) || '';
  ta.addEventListener('input', () => draftKey && o.drafts && o.drafts.set(draftKey, ta.value));
  const err = h('div', { class: 'error' });
  const submit = async (text) => {
    const v = String(text || '').trim();
    if (!v) { ta.focus(); return; }
    err.textContent = '';
    for (const b of form.querySelectorAll('button')) b.disabled = true;
    try {
      await send(v);
      if (draftKey && o.drafts) o.drafts.delete(draftKey);
    } catch (e) {
      err.textContent = `${t('error')}: ${errText(e)}`;
    } finally {
      for (const b of form.querySelectorAll('button')) b.disabled = false;
    }
  };
  const opts = Array.isArray(choices && choices.options) ? choices.options : [];
  const rec = Number(choices && choices.recommended) || 0;
  // o.pick: an option preselected by a notification link: it fills the reply box
  // and is marked; nothing is sent until the person presses a button
  const pick = Number.isInteger(o.pick) && o.pick >= 0 && opts[o.pick] ? o.pick : -1;
  if (pick >= 0 && !ta.value) {
    ta.value = optionReply(opts[pick]);
    if (draftKey && o.drafts) o.drafts.set(draftKey, ta.value);
  }
  const form = h('form', { class: 'decide choices', on: { submit: (e) => { e.preventDefault(); submit(ta.value); } } },
    o.question === false ? null : h('div', { class: 'choice-q', text: String((choices && choices.question) || '') }),
    h('div', { class: 'choice-opts' }, opts.map((x, i) =>
      h('button', { class: 'btn choice' + (i === rec ? ' recommended' : '') + (i === pick ? ' picked' : ''), attrs: { type: 'button', 'data-id': String(i), 'aria-pressed': i === pick ? 'true' : 'false' }, text: optionLabel(x, i === rec), on: { click: () => submit(optionReply(x)) } }))),
    ta,
    h('div', { class: 'btns' }, h('button', { class: 'btn primary', attrs: { type: 'submit' }, text: t('send') })),
    err,
  );
  return form;
}

/**
 * Decide form for a decision_request message: multiple choice when it has
 * options (choices), else free text with quick replies.
 * handlers: { onDecide(taskId, messageId, text) -> Promise, drafts: Map }
 */
export function decideForm(taskId, messageId, handlers, choices) {
  if (choices && Array.isArray(choices.options) && choices.options.length) {
    const p = handlers.pick && handlers.pick.id === messageId ? handlers.pick.option : -1;
    return choiceForm(choices, (v) => handlers.onDecide(taskId, messageId, v), { key: `decide:${messageId}`, drafts: handlers.drafts, pick: p });
  }
  const draftKey = `decide:${messageId}`;
  const ta = h('textarea', {
    attrs: { rows: 2, placeholder: t('decision_placeholder'), 'data-draft': draftKey, 'aria-label': t('decide') },
  });
  ta.value = (handlers.drafts && handlers.drafts.get(draftKey)) || '';
  ta.addEventListener('input', () => handlers.drafts && handlers.drafts.set(draftKey, ta.value));
  const err = h('div', { class: 'error' });
  const submit = async (text) => {
    const v = String(text || '').trim();
    if (!v) { ta.focus(); return; }
    err.textContent = '';
    for (const b of form.querySelectorAll('button')) b.disabled = true;
    try {
      await handlers.onDecide(taskId, messageId, v);
      if (handlers.drafts) handlers.drafts.delete(draftKey);
    } catch (e) {
      err.textContent = `${t('error')}: ${errText(e)}`;
    } finally {
      for (const b of form.querySelectorAll('button')) b.disabled = false;
    }
  };
  const quick = QUICK_DECISIONS.map((q) =>
    h('button', { class: 'btn', attrs: { type: 'button' }, text: t(q.key), on: { click: () => submit(t(q.valueKey)) } }));
  const form = h('form', { class: 'decide', on: { submit: (e) => { e.preventDefault(); submit(ta.value); } } },
    ta,
    h('div', { class: 'btns' },
      h('button', { class: 'btn primary', attrs: { type: 'submit' }, text: t('send') }),
      quick),
    err,
  );
  return form;
}

/** One "needs your decision" item: {task, msg}. */
export function decisionItem(item, ctx, handlers) {
  const { task, msg } = item;
  const from = msg.author_agent ? ctx.agentName(relId(msg.author_agent)) : agentLabel(ctx, task, 'to_agent');
  return h('div', { class: 'row decision' },
    h('div', { class: 'row-main' },
      tag(task.priority || 'P?', task.priority === 'P0' ? 'strong' : ''),
      ' ',
      h('a', { class: 'title', href: taskHref(task.id, task.seq), text: task.title || task.id || '?' }),
    ),
    h('div', { class: 'row-meta' },
      h('span', { class: 'agents', text: `${agentLabel(ctx, task, 'from_agent')} → ${agentLabel(ctx, task, 'to_agent')}` }),
      statusTag(task.status || 'input-required'),
      h('span', { text: `${t('version')}${task.handoff_version ?? 1}` }),
      h('span', { class: 'muted', text: `${from} · ${ago(msg.created || task.last_activity, ctx.now)}` }),
      isIdle(task, ctx.now) ? h('span', { class: 'warn', text: `⚠ ${t('idle')} >24h` }) : null,
    ),
    mdNode(msg.body),
    msg.id ? decideForm(task.id, msg.id, handlers, msg.choices) : null,
  );
}

/** One message in the task timeline. */
export function messageItem(msg, ctx) {
  let author = 'system';
  if (msg.author_type === 'human' || msg.author_user) author = ctx.userName(relId(msg.author_user)) || 'human';
  else if (msg.author_agent) author = ctx.agentName(relId(msg.author_agent));
  const target = msg.to_agent ? ctx.agentName(relId(msg.to_agent))
    : msg.to_user ? ctx.userName(relId(msg.to_user)) : '';
  const kindsWithState = new Set(['question', 'decision_request']);
  return h('div', { class: `msg kind-${/^[a-z_]+$/.test(msg.kind || '') ? msg.kind : 'note'}` },
    h('div', { class: 'msg-head' },
      tag(kindLabel(msg.kind), msg.kind === 'decision_request' ? 'strong' : ''),
      h('span', { class: 'author', text: target ? `${author} → ${target}` : author }),
      kindsWithState.has(msg.kind) ? tag(msg.resolved ? t('resolved') : t('open'), msg.resolved ? 'muted' : 'strong') : null,
      h('span', { class: 'muted', text: ago(msg.created, ctx.now) }),
    ),
    mdNode(msg.body),
    msg.evidence ? h('div', { class: 'evidence' }, tag(t('evidence')), ' ', mdNode(msg.evidence)) : null,
  );
}

/** Handoff history list (newest first). */
export function handoffHistory(versions) {
  const list = [...versions].sort((a, b) => (b.version || 0) - (a.version || 0));
  return h('div', { class: 'history' },
    list.map((v) => h('details', { class: 'hv' },
      h('summary', null,
        tag(`${t('version')}${v.version}`),
        ' ',
        h('span', { text: v.change_note || (v.version === 1 ? '—' : '') }),
        ' ',
        h('span', { class: 'muted', text: v.created ? ago(v.created) : '' }),
      ),
      mdNode(v.body),
    )),
  );
}

/** Task header key/value grid. */
export function taskHeader(task, ctx) {
  const est = isEstimated(ctx, task);
  const kv = (k, v) => (v == null || v === '' ? null : h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v' }, v)));
  const deps = Array.isArray(task.depends_on) ? task.depends_on : (task.depends_on ? [task.depends_on] : []);
  return h('div', { class: 'task-head' },
    h('h1', null, tag(task.priority || 'P?', task.priority === 'P0' ? 'strong' : ''), ' ', h('span', { text: task.title || task.id })),
    h('div', { class: 'grid' },
      kv(t('status'), [statusTag(task.status), isIdle(task, ctx.now) ? h('span', { class: 'warn', text: ` ⚠ ${t('idle')} >24h` }) : null]),
      kv(t('from'), agentLabel(ctx, task, 'from_agent')),
      kv(t('to'), agentLabel(ctx, task, 'to_agent')),
      kv(t('worked_by'), claimTag(task)),
      kv(t('waiting_on'), task.waiting_on ? waitingLabel(ctx, task.waiting_on) : null),
      kv(t('handoff'), `${t('version')}${task.handoff_version ?? 1}`),
      kv(t('cost'), money(task.cost_usd, est)),
      kv(t('hops'), task.agent_hops != null ? String(task.agent_hops) : null),
      kv(t('last_activity'), ago(task.last_activity || task.updated, ctx.now)),
      kv(t('created'), task.created ? ago(task.created, ctx.now) : null),
      deps.length ? kv(t('depends_on'), deps.map((d) => h('a', { href: taskHref(relId(d)), text: relId(d) + ' ' }))) : null,
      linkKv(task.links, 'issue', kv),
      linkKv(task.links, 'pr', kv),
      kv(t('repos'), repoList(task.links)),
      task.links && typeof task.links === 'object' && Object.keys(task.links).length
        ? kv(t('links'), h('code', { text: JSON.stringify(task.links) })) : null,
    ),
    task.key_question ? h('div', { class: 'block key-question' }, h('div', { class: 'label', text: t('key_question') }), h('div', { class: 'pre strong', text: task.key_question })) : null,
    task.purpose ? h('div', { class: 'block' }, h('div', { class: 'label', text: t('purpose') }), h('div', { class: 'pre', text: task.purpose })) : null,
    task.money ? h('div', { class: 'block' }, h('div', { class: 'label', text: t('money') }), h('div', { class: 'pre', text: task.money })) : null,
  );
}

/** Repos the task works in: primary (links.repo) first, then links.repos (read-only). Text only. */
export function repoList(links) {
  if (!links || typeof links !== 'object') return null;
  const out = [];
  if (typeof links.repo === 'string' && links.repo) out.push(links.repo + (typeof links.base === 'string' && links.base ? `@${links.base}` : ''));
  if (Array.isArray(links.repos)) {
    for (const r of links.repos) {
      if (r && typeof r.repo === 'string') out.push(`${r.repo}${typeof r.base === 'string' && r.base ? `@${r.base}` : ''} (${t('read_only')})`);
    }
  }
  return out.length ? out.join(', ') : null;
}

function linkKv(links, key, kv) {
  if (!links || typeof links !== 'object') return null;
  const v = links[key];
  if (typeof v !== 'string' || !v) return null;
  return kv(t(key), extLink(v));
}

/** The hub's error body ({error, code, ...}) from a PocketBase / upload error, or {}. */
export function errBody(e) {
  if (!e || typeof e !== 'object') return {};
  const r = e.response || e.data;
  return r && typeof r === 'object' ? r : {};
}
export function errCode(e) {
  const c = errBody(e).code;
  return typeof c === 'string' && /^[a-z_]{1,40}$/.test(c) ? c : '';
}

/**
 * F8: every hub error shown through its stable `code` (API.md), translated;
 * the server text is the fallback for unknown codes.
 */
export function errText(e) {
  if (!e) return '';
  const r = errBody(e);
  const code = errCode(e);
  if (code === 'not_invited' && typeof r.email === 'string' && r.email) return t('not_invited_email', { email: r.email });
  if (/^(link_used|link_expired|link_kind|invalid_link)$/.test(code)) return linkErrText(e);
  if (code && has(`err_${code}`)) return t(`err_${code}`);
  if (e.status === 0 || /network error|Failed to fetch/i.test(String(e.message || ''))) return t('err_network');
  if (e.status === 429) return t('err_rate_limited');
  return String(r.error || r.message || e.message || e);
}

/** Login-link failures: what happened + what to do, by the link's kind (open / invite / relogin / device). */
export function linkErrText(e) {
  const r = errBody(e);
  const code = errCode(e) || 'invalid_link';
  const kind = typeof r.kind === 'string' && /^[a-z]{1,20}$/.test(r.kind) ? r.kind : '';
  const what = has(`err_${code}`) ? t(`err_${code}`) : t('err_invalid_link');
  const hint = kind && has(`link_hint_${kind}`) ? t(`link_hint_${kind}`) : t('link_hint_invite');
  return `${what} ${hint}`;
}
