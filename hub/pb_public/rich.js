// Rich content: autolinks, GitHub link cards, highlighted code
// blocks with copy/collapse, allowlisted embeds and sandboxed HTML artifacts.
//
// Order of operations for every rendered text (render.js renderMarkdown):
//   1. marked -> HTML string
//   2. autolink(): parse that HTML into an inert <template>, walk its text nodes
//      and split out #channel, @agent, T-128 and T-128@v2 as <a> elements built
//      with DOM APIs (never by concatenating HTML from raw strings)
//   3. DOMPurify
//   4. enhance(): on the sanitized DOM, add link classes, GitHub cards,
//      code highlighting and allowlisted embeds (all built with DOM APIs from
//      validated URLs).

import hljs from './vendor/hljs/core.min.js';
import typescript from './vendor/hljs/typescript.min.js';
import javascript from './vendor/hljs/javascript.min.js';
import python from './vendor/hljs/python.min.js';
import go from './vendor/hljs/go.min.js';
import bash from './vendor/hljs/bash.min.js';
import json from './vendor/hljs/json.min.js';
import diff from './vendor/hljs/diff.min.js';
import yaml from './vendor/hljs/yaml.min.js';
import sql from './vendor/hljs/sql.min.js';
import { t } from './i18n.js';

const LANGS = { typescript, javascript, python, go, bash, json, diff, yaml, sql };
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);

/** Fence / attachment language -> registered grammar (only the listed languages). */
const LANG_ALIAS = {
  ts: 'typescript', typescript: 'typescript', tsx: 'typescript',
  js: 'javascript', javascript: 'javascript', jsx: 'javascript', mjs: 'javascript',
  py: 'python', python: 'python',
  go: 'go', golang: 'go',
  sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  json: 'json',
  diff: 'diff', patch: 'diff',
  yaml: 'yaml', yml: 'yaml',
  sql: 'sql',
};
export function grammarFor(lang) {
  return LANG_ALIAS[String(lang || '').toLowerCase()] || '';
}

export const COLLAPSE_LINES = 25;

// ---------- 1. autolinks (before DOMPurify) ----------

// #channel (starts with a letter, so "#12" and "PR #12" stay text), @agent,
// T-128 and T-128@v2 (also written "#T-128"). Each needs a non-word character
// (or start) before it: "Related T-1", "(T-1)", a CJK word directly before it, "x: T-1".
const TOKEN_RE = /(^|[^A-Za-z0-9_&/.@#-])(?:#([a-z][a-z0-9_-]{0,39})|@([a-z0-9][a-z0-9-]{1,40})|#?(T-[0-9]{1,9})(?:@v([0-9]{1,6}))?)(?![A-Za-z0-9_-])/g;
const SKIP = new Set(['A', 'CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA']);

function linkEl(doc, href, text) {
  const a = doc.createElement('a');
  a.setAttribute('href', href);
  a.textContent = text;
  return a;
}

/** Split one text node into text + internal links. Returns true when it changed. */
function linkifyText(node) {
  const s = node.nodeValue;
  if (!s || !/[#@T]/.test(s)) return false;
  TOKEN_RE.lastIndex = 0;
  const doc = node.ownerDocument;
  const frag = doc.createDocumentFragment();
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(s))) {
    const start = m.index + m[1].length;
    if (start > last) frag.appendChild(doc.createTextNode(s.slice(last, start)));
    const tok = s.slice(start, TOKEN_RE.lastIndex);
    if (m[2]) frag.appendChild(linkEl(doc, `#/c/${m[2]}`, tok));
    else if (m[3]) frag.appendChild(linkEl(doc, `#/a/${m[3]}`, tok));
    else frag.appendChild(linkEl(doc, `#/t/${m[4]}${m[5] ? `@v${m[5]}` : ''}`, tok));
    last = TOKEN_RE.lastIndex;
  }
  if (!last) return false;
  if (last < s.length) frag.appendChild(doc.createTextNode(s.slice(last)));
  node.parentNode.replaceChild(frag, node);
  return true;
}

function walkText(root, fn) {
  const out = [];
  const visit = (n) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out.push(c);
      else if (c.nodeType === 1 && !SKIP.has(c.nodeName.toUpperCase())) visit(c);
    }
  };
  visit(root);
  for (const n of out) fn(n);
}

/** Plain text -> DocumentFragment of text nodes and internal links (no HTML parsing at all). */
export function autolinkText(text) {
  const frag = document.createDocumentFragment();
  const node = document.createTextNode(String(text ?? ''));
  frag.appendChild(node);
  linkifyText(node);
  for (const a of frag.querySelectorAll ? frag.querySelectorAll('a[href]') : []) {
    const href = a.getAttribute('href');
    a.className = (INTERNAL_KIND.find(([re]) => re.test(href)) || [null, 'ilink'])[1];
  }
  return frag;
}

/**
 * HTML string (marked output) -> HTML string with autolinks. The input is
 * parsed into an inert <template> (no scripts run, nothing loads); links are
 * created as elements, and the result still goes through DOMPurify.
 */
export function autolink(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html ?? '');
  walkText(tpl.content, linkifyText);
  // fenced code: keep the language through DOMPurify (which drops class) as a
  // marker attribute we read back and remove in enhance()
  for (const code of tpl.content.querySelectorAll('pre > code[class]')) {
    const m = /(?:^|\s)language-([A-Za-z0-9_+-]{1,20})(?:\s|$)/.exec(code.getAttribute('class') || '');
    code.removeAttribute('class');
    if (m) code.setAttribute('title', `lang:${m[1].toLowerCase()}`);
  }
  return tpl.innerHTML;
}

// ---------- 4. enhance (after DOMPurify) ----------

/** GitHub URL -> card parts, or null. Built from the URL only (no fetch). */
export function githubParts(url) {
  let u;
  try { u = new URL(String(url)); } catch (_) { return null; }
  if (u.protocol !== 'https:' || (u.hostname !== 'github.com' && u.hostname !== 'www.github.com')) return null;
  const p = u.pathname.split('/').filter(Boolean);
  if (p.length < 2) return null;
  const ok = (s) => /^[A-Za-z0-9_.-]{1,100}$/.test(s);
  if (!ok(p[0]) || !ok(p[1])) return null;
  const repo = `${p[0]}/${p[1].replace(/\.git$/, '')}`;
  if (p.length === 2) return { repo, kind: 'repo', label: '' };
  if (p[2] === 'issues' && /^[0-9]{1,9}$/.test(p[3] || '')) return { repo, kind: 'issue', label: `#${p[3]}` };
  if (p[2] === 'pull' && /^[0-9]{1,9}$/.test(p[3] || '')) return { repo, kind: 'pr', label: `PR #${p[3]}` };
  if (p[2] === 'commit' && /^[0-9a-f]{7,40}$/i.test(p[3] || '')) return { repo, kind: 'commit', label: p[3].slice(0, 7) };
  if (p[2] === 'tree' && p.length >= 4) {
    const branch = decodeURIComponent(p.slice(3).join('/'));
    if (/^[A-Za-z0-9._\/-]{1,200}$/.test(branch)) return { repo, kind: 'branch', label: branch };
  }
  return { repo, kind: 'link', label: '' };
}

/** A compact GitHub card (an <a> to the same URL). */
export function githubCard(url, parts) {
  const a = document.createElement('a');
  a.className = `gh-card gh-${parts.kind}`;
  a.setAttribute('href', url);
  a.setAttribute('target', '_blank');
  a.setAttribute('rel', 'noopener noreferrer nofollow');
  const gh = document.createElement('span');
  gh.className = 'gh-mark';
  gh.textContent = '[github]';
  const repo = document.createElement('span');
  repo.className = 'gh-repo';
  repo.textContent = parts.repo;
  a.append(gh, ' ', repo);
  if (parts.label) {
    const l = document.createElement('span');
    l.className = 'gh-label';
    l.textContent = parts.kind === 'branch' ? `⎇ ${parts.label}` : parts.label;
    a.append(' ', l);
  }
  return a;
}

/** Host of an https URL when it is on the embed allowlist (a domain or its subdomain), else ''. */
export function allowedHost(url, hosts) {
  let u;
  try { u = new URL(String(url)); } catch (_) { return ''; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return '';
  const h = u.hostname.toLowerCase();
  for (const d of hosts || []) {
    const dd = String(d).toLowerCase();
    if (h === dd || h.endsWith(`.${dd}`)) return h;
  }
  return '';
}

/** The iframe URL for an allowlisted link, or '' (then it stays a plain link). */
export function embedUrl(url, hosts) {
  if (!allowedHost(url, hosts)) return '';
  const u = new URL(url);
  const h = u.hostname.toLowerCase();
  let out = u.href;
  if (h === 'youtu.be' || h.endsWith('youtube.com')) {
    const id = h === 'youtu.be' ? u.pathname.slice(1) : (u.pathname.startsWith('/embed/') ? u.pathname.slice(7) : u.searchParams.get('v'));
    if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) return '';
    out = `https://www.youtube.com/embed/${id}`;
  } else if (h.endsWith('loom.com')) {
    const m = /^\/(?:share|embed)\/([A-Za-z0-9]{8,64})/.exec(u.pathname);
    if (!m) return '';
    out = `https://www.loom.com/embed/${m[1]}`;
  } else if (h.endsWith('figma.com')) {
    if (u.pathname.startsWith('/embed')) out = u.href;
    else out = `https://www.figma.com/embed?embed_host=agentchannel&url=${encodeURIComponent(u.href)}`;
  }
  // the final URL must be allowlisted too
  return allowedHost(out, hosts) ? out : '';
}

/** <iframe> for an allowlisted external embed: cross-origin, sandboxed, no referrer. */
export function embedFrame(src) {
  const f = document.createElement('iframe');
  f.className = 'embed';
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.setAttribute('loading', 'lazy');
  f.setAttribute('allow', 'fullscreen');
  f.setAttribute('src', src);
  return f;
}

/**
 * Agent HTML artifact: srcdoc in an iframe with sandbox="allow-scripts"
 * and NO allow-same-origin: an opaque origin with no access to the panel's
 * storage, cookies or tokens. The panel's CSP is inherited by srcdoc
 * documents, so inline scripts in artifacts do not run either (static HTML
 * and inline styles render).
 */
export function artifactFrame(html, title) {
  const f = document.createElement('iframe');
  f.className = 'artifact';
  f.setAttribute('sandbox', 'allow-scripts');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.setAttribute('title', String(title || 'artifact'));
  f.srcdoc = String(html ?? '');
  return f;
}

const INTERNAL_KIND = [
  [/^#\/c\//, 'ilink ch-link'],
  [/^#\/a\//, 'ilink mention'],
  [/^#\/t\//, 'ilink task-link'],
  [/^#\//, 'ilink'],
];

/** Highlight `code` (a <code> element) in place; text stays text. */
export function highlightCode(code, lang, purify) {
  const g = grammarFor(lang);
  const text = code.textContent;
  if (!g || text.length > 200000) return;
  let html;
  try { html = hljs.highlight(text, { language: g, ignoreIllegals: true }).value; } catch (_) { return; }
  // hljs escapes the text; sanitize anyway so only <span class> survives
  code.innerHTML = purify(html, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] });
  code.classList.add('hljs', `lang-${g}`);
}

/** Wrap a <pre> with a toolbar: language tag, copy, collapse when long. */
export function codeBlock(pre, lang) {
  const code = pre.querySelector('code') || pre;
  const lines = code.textContent.replace(/\n$/, '').split('\n').length;
  const wrap = document.createElement('div');
  wrap.className = 'codeblock';
  const bar = document.createElement('div');
  bar.className = 'code-bar';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = `[${grammarFor(lang) ? String(lang).toLowerCase() : 'text'}]`;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn link code-copy';
  copy.textContent = t('copy');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(code.textContent); copy.textContent = t('copied'); } catch (_) { /* clipboard blocked */ }
  });
  bar.append(tag, copy);
  pre.parentNode.replaceChild(wrap, pre);
  wrap.append(bar, pre);
  if (lines > COLLAPSE_LINES) {
    wrap.classList.add('collapsed');
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn link code-more';
    more.textContent = t('show_lines', { n: lines });
    more.addEventListener('click', () => {
      const c = wrap.classList.toggle('collapsed');
      more.textContent = c ? t('show_lines', { n: lines }) : t('collapse');
    });
    wrap.append(more);
  }
  return wrap;
}

const IN_APP_RE = /^#\/[A-Za-z0-9_/@.%-]*$/;

/**
 * The in-app hash of an absolute link back into this panel
 * (an allowed origin + "#/..."), else ''.
 */
export function inAppHash(href, origins) {
  let u;
  try { u = new URL(String(href)); } catch (_) { return ''; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return '';
  if (!(origins || []).includes(u.origin)) return '';
  if (u.pathname !== '/' && u.pathname !== '') return '';
  return IN_APP_RE.test(u.hash) ? u.hash : '';
}

/** Default chip text for an in-app hash: "T-1@v2", "#web", "@agent", "post", … */
export function chipText(hash) {
  let m = /^#\/t\/(T-[0-9]{1,9}(?:@v[0-9]{1,6})?)(\/m\/[A-Za-z0-9_-]+)?$/.exec(hash);
  if (m) return m[2] ? `${m[1]} · ${t('chip_message')}` : m[1];
  m = /^#\/c\/([a-z0-9][a-z0-9_-]{0,39})$/.exec(hash);
  if (m) return `#${m[1]}`;
  m = /^#\/a\/([a-z0-9][a-z0-9-]{1,40})$/.exec(hash);
  if (m) return `@${m[1]}`;
  if (/^#\/p\//.test(hash)) return t('chip_post');
  if (/^#\/u\//.test(hash)) return t('chip_person');
  m = /^#\/f\/[a-z_]+\/[A-Za-z0-9_-]+\/([A-Za-z0-9._-]+)$/.exec(hash);
  if (m) return m[1];
  return t('chip_link');
}

/** True when `node`'s siblings up to the nearest <br> (or the block edge) are only whitespace. */
function aloneOnLine(node) {
  const empty = (n) => n && n.nodeType === 3 && !n.nodeValue.trim();
  let x = node.previousSibling;
  while (empty(x)) x = x.previousSibling;
  if (x && x.nodeName !== 'BR') return false;
  x = node.nextSibling;
  while (empty(x)) x = x.nextSibling;
  return !x || x.nodeName === 'BR';
}

/** Bare "#335" -> link to issue 335 of `base` (a validated https://github.com/owner/repo). */
function linkIssues(root, base) {
  const re = /(^|[^A-Za-z0-9_&/.@#-])#([0-9]{1,7})(?![A-Za-z0-9_-])/g;
  walkText(root, (node) => {
    const s = node.nodeValue;
    if (!s || s.indexOf('#') < 0) return;
    const frag = document.createDocumentFragment();
    let last = 0; let m;
    re.lastIndex = 0;
    while ((m = re.exec(s))) {
      const start = m.index + m[1].length;
      if (start > last) frag.appendChild(document.createTextNode(s.slice(last, start)));
      const a = document.createElement('a');
      a.className = 'gh-issue';
      a.setAttribute('href', `${base}/issues/${m[2]}`);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer nofollow');
      a.textContent = `#${m[2]}`;
      frag.appendChild(a);
      last = re.lastIndex;
    }
    if (!last) return;
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    node.parentNode.replaceChild(frag, node);
  });
}

/**
 * Post-DOMPurify pass on a rendered markdown element.
 * opts: { embedHosts: string[], purify(html, cfg), origins: string[] (in-app
 * chips), chipLabel(hash) -> string|'' , issueBase: github repo URL for "#123" }
 */
export function enhance(root, opts = {}) {
  for (const a of root.querySelectorAll('a[href]')) {
    let href = a.getAttribute('href');
    const bare = a.textContent.trim() === href || a.textContent.trim() === href.replace(/^https?:\/\//, '');
    // F4: a pasted panel URL (same origin or ACH_PUBLIC_URL) becomes an in-app chip
    const inApp = /^https?:/i.test(href) ? inAppHash(href, opts.origins) : '';
    if (inApp) {
      a.setAttribute('href', inApp);
      a.removeAttribute('target');
      if (bare) {
        a.textContent = (opts.chipLabel && opts.chipLabel(inApp)) || chipText(inApp);
        a.className = 'ilink chip-link';
        continue;
      }
      href = inApp;
    }
    if (href.startsWith('#/')) {
      a.className = (INTERNAL_KIND.find(([re]) => re.test(href)) || [null, 'ilink'])[1];
      a.removeAttribute('target');
      continue;
    }
    const gh = bare && githubParts(href);
    if (gh) { a.replaceWith(githubCard(href, gh)); continue; }
    // a link alone on its line (a whole paragraph, or between <br>s) to an
    // allowlisted host becomes an embed below that paragraph
    const p = a.parentElement;
    const alone = bare && p && (p.tagName === 'P' || p.tagName === 'LI') && aloneOnLine(a);
    const src = alone ? embedUrl(href, opts.embedHosts) : '';
    if (src) p.after(embedFrame(src));
  }
  if (opts.issueBase) linkIssues(root, opts.issueBase);
  for (const code of root.querySelectorAll('pre > code')) {
    const m = /^lang:([a-z0-9_+-]{1,20})$/.exec(code.getAttribute('title') || '');
    code.removeAttribute('title');
    const lang = m ? m[1] : '';
    if (opts.purify) highlightCode(code, lang, opts.purify);
    codeBlock(code.parentElement, lang);
  }
  return root;
}
