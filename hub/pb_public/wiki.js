// Team Memory views (formerly "wiki"). Pure DOM builders, text nodes only
// (never HTML from data): a channel's topic index, a page (sections with
// source chips, figures table with superseded rows struck through, decisions),
// its history with a diff, the decision log, the Inbox "confirm decision"
// controls, and a store-only zip writer for "export as Markdown".
// Permalinks: #/c/<channel>/memory, #/m/<slug>, #/m/<slug>/history,
// #/m/<slug>@v<n>, #/d/<decisionId> (the decision log, item highlighted).
// The older #/c/<channel>/wiki and #/w/... links still open the same views.

import { h, tag, extLink, linkedText, ago, errText, safeInternalHref } from './render.js';
import { diffView } from './thread.js';
import { t } from './i18n.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
// "as of YYYY-MM-DD"; the Chinese words are language support for Chinese pages.
const ASOF_RE = /\(?\s*(?:as of|截至|截止)\s*([0-9]{4}-[0-9]{2}-[0-9]{2})(?:\s*[,，]\s*([A-Za-z][A-Za-z0-9_-]{0,39}))?\s*\)?/i;
const LINK_RE = /\[([^\]\n]{0,200})\]\(([^)\s]{1,600})\)|(https:\/\/github\.com\/[A-Za-z0-9_.\/#?=&%-]+)|((?:https?:\/\/[^\s)\]#]+\/)?#\/(?:p|t|w|m|d|c|f)\/[A-Za-z0-9_\/@.%-]+)/g;

export function wikiHref(slug) { return SLUG_RE.test(String(slug || '')) ? `#/m/${slug}` : '#/'; }
export function wikiIndexHref(channel) { return NAME_RE.test(String(channel || '')) ? `#/c/${channel}/memory` : '#/m'; }
export const OVERVIEW_SLUG = 'team-overview';

/** Section headings are kept in English in the page source (the tools key on them); shown in the panel's language. */
const SECTION_KEYS = { 'current state': 'sec_current_state', decisions: 'sec_decisions', lessons: 'sec_lessons', 'open questions': 'sec_open_questions' };
export function sectionTitle(title) {
  const k = SECTION_KEYS[String(title || '').trim().toLowerCase()];
  return k ? t(k) : String(title || '');
}

/** "#/…" part of a source (absolute hub links become in-app links); "" when not internal. */
function internalOf(url) {
  const s = String(url || '');
  const i = s.indexOf('#/');
  if (i < 0) return '';
  const hsh = s.slice(i);
  return /^#\/[A-Za-z0-9_/@.%-]*$/.test(hsh) ? hsh : '';
}

function shortLabel(url) {
  const s = String(url || '');
  const gh = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)(?:#issuecomment-(\d+))?/.exec(s);
  if (gh) return `${gh[2]}#${gh[3]}${gh[4] ? ' c' : ''}`;
  const hsh = internalOf(s);
  if (hsh) return hsh.slice(2).replace(/^t\//, '').replace(/^p\//, 'post ').replace(/^d\//, 'decision ').replace(/^[wm]\//, '').slice(0, 40);
  return s.replace(/^https?:\/\//, '').slice(0, 40);
}

/** A source as a chip: in-app links stay in the panel, GitHub opens a new tab. */
export function sourceChip(url, label) {
  const hsh = internalOf(url);
  const text = label && String(label).trim() ? String(label).slice(0, 60) : shortLabel(url);
  if (hsh) return h('a', { class: 'chip src-chip', href: safeInternalHref(hsh), text });
  const a = extLink(url, text);
  a.classList.add('chip', 'src-chip');
  return a;
}

/** One bullet: {text, asOf, env, sources:[{url,label}]} with the links and the as-of note taken out of the text. */
export function parseBullet(line) {
  let s = String(line || '').replace(/^\s*[-*]\s+/, '');
  const sources = [];
  s = s.replace(LINK_RE, (m, label, url, gh, perm) => {
    sources.push({ url: url || gh || perm, label: label || '' });
    return ' ';
  });
  let asOf = '';
  let env = '';
  const a = ASOF_RE.exec(s);
  if (a) {
    asOf = a[1];
    env = a[2] || '';
    s = s.replace(a[0], ' ');
  }
  return { text: tidy(s), asOf, env, sources };
}

/**
 * The statement left after its links and date were taken out, without the
 * punctuation they leave behind: empty ( ) [ ] (ASCII or full-width), a comma right
 * before a full stop, a dangling comma or colon at the end. Full-width (CJK)
 * punctuation is handled too, for Chinese pages.
 */
export function tidy(s) {
  let x = String(s || '').replace(/\s+/g, ' ');
  for (let i = 0; i < 3; i++) {
    x = x
      .replace(/[（(【\[]\s*[,，、;；:：]?\s*[）)】\]]/g, ' ')
      .replace(/\s+([，。；：、！？）】,.;:!?)\]])/g, '$1')
      .replace(/([（(【\[])\s+/g, '$1')
      .replace(/[,，、;；:：]+\s*([。.!！?？])/g, '$1')
      .replace(/([，、；：])[,，、;；:：]+/g, '$1')
      .replace(/\s+/g, ' ');
  }
  return x.replace(/^[\s,，、;；:：。.]+/, '').replace(/[\s,，、;；:：]+$/, '').trim();
}

/** Text with ~~struck~~ runs as <s>, the rest autolinked text (never HTML). */
function richText(text) {
  const parts = String(text).split(/~~/);
  return parts.map((p, i) => (i % 2 === 1 ? h('s', { class: 'superseded' }, linkedText(p)) : linkedText(p)));
}

function bulletItem(line, o = {}) {
  const b = parseBullet(line);
  return h('li', { class: `wiki-fact${o.stale ? ' stale' : ''}` },
    h('span', { class: 'wiki-text' }, richText(b.text)),
    o.stale ? h('span', { class: 'tag wiki-stale', attrs: { title: t('wiki_stale_title', { n: o.staleDays || 30 }) }, text: `[${t('wiki_stale')}]` }) : null,
    b.asOf || b.env ? h('span', { class: 'wiki-asof muted', text: `${b.asOf ? t('wiki_as_of', { date: b.asOf }) : ''}${b.env ? ` · ${b.env}` : ''}` }) : null,
    b.sources.length ? h('span', { class: 'chips inline' }, b.sources.map((x) => sourceChip(x.url, x.label))) : null);
}

/** Sections from Markdown: [{title, lines}] (lines before the first ## have title ""). */
export function sectionsOf(body) {
  const out = [{ title: '', lines: [] }];
  for (const line of String(body || '').split('\n')) {
    const m = /^##\s+(.+)$/.exec(line);
    if (m) out.push({ title: m[1].trim(), lines: [] });
    else out[out.length - 1].lines.push(line);
  }
  return out.filter((s) => s.title || s.lines.some((l) => l.trim()));
}

function sectionBody(lines, o = {}) {
  const out = [];
  let list = null;
  for (const l of lines) {
    if (/^<!--.*-->\s*$/.test(l)) continue;
    if (/^\s*[-*]\s+\S/.test(l)) {
      if (!list) { list = h('ul', { class: 'wiki-list' }); out.push(list); }
      list.appendChild(bulletItem(l, { stale: !!(o.stale && o.stale.has(l)), staleDays: o.staleDays }));
    } else if (l.trim() && !/^#\s/.test(l) && !/^```/.test(l)) {
      list = null;
      out.push(h('p', { class: 'wiki-p' }, richText(l.replace(/^#{3,6}\s+/, ''))));
    } else list = null;
  }
  return out;
}

// ---------- decisions ----------

/** One decision: text, who, when, [confirmed] or [draft][agent], [money], source chip. */
export function decisionRow(d, ctx, o = {}) {
  const confirmed = d.status === 'confirmed' || d.human_confirmed === true;
  const cls = `wiki-decision ${confirmed ? 'confirmed' : d.status === 'rejected' ? 'rejected' : 'draft'}${d.money && !confirmed ? ' money-flag' : ''}${o.focus && o.focus === d.id ? ' focused' : ''}`;
  return h('li', { class: cls, attrs: { 'data-id': String(d.id || '') } },
    confirmed ? tag(t('wiki_confirmed'), 'strong') : d.status === 'rejected' ? tag(t('wiki_rejected')) : tag(t('wiki_draft')),
    !confirmed && d.agent_made ? tag(t('wiki_agent_made')) : null,
    confirmed && d.auto_recorded ? tag(t('wiki_recorded')) : null,
    d.team_important ? tag(t('wiki_team_important'), 'strong') : null,
    d.money ? tag(t('wiki_money'), confirmed ? '' : 'strong accent') : null,
    ' ',
    h('span', { class: 'wiki-text' }, richText(d.text || '')),
    h('span', { class: 'wiki-asof muted', text: [d.decider_name ? t('wiki_decider', { name: d.decider_name }) : '', d.as_of || ''].filter(Boolean).join(' · ') }),
    d.source ? h('span', { class: 'chips inline' }, sourceChip(d.source)) : null,
    d.id ? h('a', { class: 'btn link', href: safeInternalHref(`#/d/${d.id}`), text: t('copy_link_short') }) : null,
    confirmed && d.id && o.promote && !d.team_important
      ? h('button', { class: 'btn link wiki-important', attrs: { type: 'button' }, text: `[${t('wiki_mark_important')}]`, on: { click: () => o.promote.onImportant(String(d.id)).catch(() => {}) } })
      : null);
}

/** "[Promote to team]": one statement from a (private) source becomes team-visible. */
export function promoteButton(source, defaultText, handlers) {
  const err = h('span', { class: 'error small' });
  const btn = h('button', {
    class: 'btn link wiki-promote', attrs: { type: 'button' }, text: `[${t('wiki_promote')}]`,
    on: {
      click: async () => {
        const text = (typeof window !== 'undefined' && window.prompt ? window.prompt(t('wiki_promote_prompt'), String(defaultText || '').slice(0, 300)) : String(defaultText || '')) || '';
        if (!text.trim()) return;
        err.textContent = '';
        btn.disabled = true;
        try { await handlers.onPromote({ text: text.trim(), source }); btn.textContent = t('wiki_promoted_ok'); } catch (e) { err.textContent = `${t('error')}: ${errText(e)}`; btn.disabled = false; }
      },
    },
  });
  return h('span', { class: 'wiki-promote-wrap' }, btn, err);
}

// ---------- figures ----------

/** Figures table; superseded rows are struck through. */
export function figuresTable(figures) {
  const rows = (Array.isArray(figures) ? figures : []).filter((f) => f && typeof f === 'object');
  if (!rows.length) return null;
  const head = h('tr', null, ...['wiki_metric', 'wiki_value', 'wiki_env', 'wiki_as_of_col', 'wiki_source'].map((k) => h('th', { text: t(k) })));
  return h('table', { class: 'wiki-figures' },
    h('thead', null, head),
    h('tbody', null, rows.map((f) => {
      const sup = f.status === 'superseded';
      const val = `${f.value ?? ''}${f.unit ? ` ${f.unit}` : ''}`;
      return h('tr', { class: sup ? 'superseded' : 'active', attrs: { 'data-id': String(f.id || '') } },
        h('td', { text: String(f.metric ?? '') }),
        h('td', null, sup ? h('s', { text: val }) : h('strong', { text: val }), sup ? h('span', { class: 'muted small', text: ` ${t('wiki_superseded')}` }) : null),
        h('td', { text: String(f.env || '') }),
        h('td', null, String(f.as_of || ''), f.stale ? [' ', h('span', { class: 'tag wiki-stale', text: `[${t('wiki_stale')}]` })] : null),
        h('td', null, f.source ? sourceChip(f.source) : null));
    })));
}

// ---------- views ----------

function head(title, sub, ...extra) {
  return h('div', { class: 'pane-head' },
    h('h1', { class: 'pane-title', text: title }),
    sub ? h('span', { class: 'pane-sub muted', text: sub }) : null,
    ...extra);
}

function scroll(...children) {
  return h('div', { class: 'thread-scroll' }, h('div', { class: 'thread-inner wiki' }, ...children));
}

/** The topic index (one channel, or all pages). data: GET /wiki. o: {channel, onExport} */
export function wikiIndexView(data, ctx, o = {}) {
  const pages = (data && Array.isArray(data.pages) ? data.pages : []).filter((p) => p && SLUG_RE.test(String(p.slug)));
  const waiting = Number(data && data.waiting) || 0;
  const title = o.channel ? `# ${o.channel} · ${t('wiki')}` : t('wiki');
  const exportBtn = o.onExport ? h('button', { class: 'btn', attrs: { type: 'button' }, text: t('wiki_export'), on: { click: () => o.onExport() } }) : null;
  return h('div', { class: 'pane wiki-index' },
    head(title, '', o.channel ? h('a', { class: 'btn link', href: `#/c/${o.channel}`, text: t('wiki_back_channel') }) : null, exportBtn),
    scroll(
      waiting ? h('div', { class: 'notice small wiki-waiting' }, t('wiki_waiting', { n: waiting }),
        data.backlog && Number(data.backlog.age_hours) >= 24 ? ` (${t('wiki_waiting_age', { d: Math.floor(Number(data.backlog.age_hours) / 24) })})` : null,
        data.upkeep_task && data.upkeep_task.ref ? [' ', h('a', { href: safeInternalHref(`#/t/${data.upkeep_task.ref}`), text: data.upkeep_task.ref })] : null) : null,
      h('a', { class: 'result wiki-overview-link', href: wikiHref(OVERVIEW_SLUG) }, h('div', { class: 'result-head' }, tag(t('wiki_overview')))),
      h('a', { class: 'result wiki-decision-log', href: '#/d' }, h('div', { class: 'result-head' }, tag(t('wiki_decision_log')),
        Number(data && data.drafts) ? h('span', { class: 'muted', text: t('wiki_drafts_n', { n: Number(data.drafts) }) }) : null)),
      pages.length
        ? pages.filter((p) => p.slug !== OVERVIEW_SLUG).map((p) => h('a', { class: 'result wiki-page-row', href: wikiHref(p.slug) },
          h('div', { class: 'result-head' },
            h('span', { class: 'title', text: String(p.title || p.slug) }),
            p.channel_name && !o.channel ? h('span', { class: 'ch', text: `#${p.channel_name}` }) : null,
            h('span', { class: 'muted', text: `v${Number(p.version) || 0}` }),
            p.updated ? h('span', { class: 'time', text: ago(p.updated, ctx.now) }) : null),
          Array.isArray(p.topics) && p.topics.length ? h('div', { class: 'snippet muted', text: p.topics.map(String).join(' · ') }) : null))
        : h('div', { class: 'empty-state muted', text: t('wiki_empty') })),
    o.error ? h('p', { class: 'error pad', text: o.error }) : null);
}

/** Who owns what (team overview): team channels with people and pages; a private channel is one line. */
export function teamMapView(map) {
  const rows = (Array.isArray(map) ? map : []).filter((c) => c && NAME_RE.test(String(c.name || '')));
  if (!rows.length) return null;
  return h('section', { class: 'wiki-section wiki-team-map' },
    h('h2', { text: t('wiki_who_owns') }),
    h('ul', { class: 'wiki-list' }, rows.map((c) => (c.visibility === 'private'
      ? h('li', { class: 'muted', text: t('wiki_private_line', { name: c.name, owner: String(c.owner || '?') }) })
      : h('li', null,
        h('a', { href: `#/c/${c.name}`, text: `#${c.name}` }),
        c.description ? h('span', { class: 'muted', text: ` ${String(c.description)}` }) : null,
        c.owner ? h('span', { class: 'muted', text: ` · ${t('wiki_owner', { owner: String(c.owner) })}` }) : null,
        Array.isArray(c.people) && c.people.length ? h('div', { class: 'small', text: c.people.map((p) => `${String(p.name || '')}${p.role ? ` (${String(p.role)})` : ''}`).join(', ') }) : null,
        Array.isArray(c.pages) && c.pages.length ? h('div', { class: 'chips inline' }, c.pages.filter((p) => SLUG_RE.test(String(p.slug))).map((p) => h('a', { class: 'chip', href: wikiHref(p.slug), text: String(p.title || p.slug) }))) : null)))));
}

/** Statements promoted to the team; a private source shows as "source: private channel". */
export function promotionsView(list) {
  const rows = (Array.isArray(list) ? list : []).filter((x) => x && typeof x === 'object');
  if (!rows.length) return null;
  return h('section', { class: 'wiki-section wiki-promotions' },
    h('h2', { text: t('wiki_promoted') }),
    h('ul', { class: 'wiki-list' }, rows.map((x) => h('li', { class: 'wiki-fact' },
      h('span', { class: 'wiki-text', text: String(x.text || '') }),
      x.source ? h('span', { class: 'chips inline' }, sourceChip(x.source)) : x.source_private ? h('span', { class: 'muted small', text: ` ${t('wiki_source_private')}` }) : null))));
}

/** A page. page: GET /memory/pages/{slug}. o: {version (an old version: {version, body, note}), promote} */
export function wikiPageView(page, ctx, o = {}) {
  const p = page || {};
  const old = o.version || null;
  const body = old ? old.body : p.body;
  const decisions = (Array.isArray(p.decisions) ? p.decisions : []).filter((d) => d && typeof d === 'object');
  // stale lines by number in the current body
  const stale = new Set();
  if (!old && Array.isArray(p.stale)) {
    const lines = String(body || '').split('\n');
    for (const x of p.stale) if (x && Number(x.line) > 0 && lines[Number(x.line) - 1] !== undefined) stale.add(lines[Number(x.line) - 1]);
  }
  const secs = sectionsOf(body).map((s) => {
    // section title in English or Chinese (language support for Chinese pages)
    const isDecisions = /^decisions?$|决定|决策/i.test(s.title);
    return h('section', { class: 'wiki-section' },
      s.title ? h('h2', { text: sectionTitle(s.title) }) : null,
      sectionBody(s.lines, { stale, staleDays: p.stale_days }),
      isDecisions && decisions.length && !old ? h('ul', { class: 'wiki-list decisions' }, decisions.map((d) => decisionRow(d, ctx, { promote: o.promote }))) : null);
  });
  const hasDecisionSection = sectionsOf(body).some((s) => /^decisions?$|决定|决策/i.test(s.title));
  const sub = [p.channel_name ? `#${p.channel_name}` : '', `v${old ? old.version : Number(p.version) || 0}`, p.updated_by ? t('wiki_updated_by', { name: p.updated_by }) : '', p.updated ? ago(p.updated, ctx.now) : ''].filter(Boolean).join(' · ');
  const figs = old ? null : figuresTable(p.figures);
  const overview = p.slug === OVERVIEW_SLUG && !old;
  return h('div', { class: 'pane wiki-page' },
    head(String(p.title || p.slug || ''), sub,
      p.channel_name ? h('a', { class: 'btn link', href: wikiIndexHref(p.channel_name), text: t('wiki') }) : null,
      h('a', { class: 'btn link', href: `${wikiHref(p.slug)}/history`, text: t('wiki_history') })),
    scroll(
      old ? h('div', { class: 'notice small' }, t('wiki_old_version', { n: old.version }), ' ', h('a', { href: wikiHref(p.slug), text: t('wiki_current') })) : null,
      overview && p.missing ? h('div', { class: 'notice small', text: t('wiki_overview_missing') }) : null,
      secs,
      !hasDecisionSection && decisions.length && !old ? h('section', { class: 'wiki-section' }, h('h2', { text: t('wiki_decisions') }), h('ul', { class: 'wiki-list decisions' }, decisions.map((d) => decisionRow(d, ctx, { promote: o.promote })))) : null,
      figs ? h('section', { class: 'wiki-section' }, h('h2', { text: t('wiki_figures') }), figs) : null,
      overview ? promotionsView(p.promotions) : null,
      overview ? teamMapView(p.team_map) : null));
}

/** History: versions, newest first; the selected one with its diff. hist: GET …/versions; sel: GET …/versions/{n} or null. */
export function wikiHistoryView(hist, sel, ctx) {
  const list = (hist && Array.isArray(hist.versions) ? hist.versions : []);
  const slug = hist && hist.slug;
  return h('div', { class: 'pane wiki-history' },
    head(`${String((hist && hist.title) || slug || '')} · ${t('wiki_history')}`, '', h('a', { class: 'btn link', href: wikiHref(slug), text: t('wiki_current') })),
    scroll(
      h('ul', { class: 'wiki-versions' }, list.map((v) => h('li', { class: sel && sel.version === v.version ? 'focused' : '' },
        h('a', { href: safeInternalHref(`${wikiHref(slug)}/history@v${Number(v.version)}`), text: `v${Number(v.version)}` }),
        ' ', h('span', { class: 'wiki-text', text: String(v.note || '') }),
        h('span', { class: 'wiki-asof muted', text: [v.author || '', v.created ? ago(v.created, ctx.now) : ''].filter(Boolean).join(' · ') })))),
      sel ? h('section', { class: 'wiki-section' },
        h('h2', { text: `v${Number(sel.version)}` }),
        diffView(sel.previous_body || '', sel.body || '', Math.max(0, Number(sel.version) - 1))) : null));
}

/** The global decision log. o: {focus} */
export function decisionLogView(data, ctx, o = {}) {
  const list = (data && Array.isArray(data.decisions) ? data.decisions : []).filter((d) => d && typeof d === 'object');
  return h('div', { class: 'pane wiki-decisions' },
    head(t('wiki_decision_log'), t('wiki_decision_log_sub')),
    scroll(list.length ? h('ul', { class: 'wiki-list decisions' }, list.map((d) => decisionRow(d, ctx, { focus: o.focus, promote: o.promote }))) : h('div', { class: 'empty-state muted', text: t('wiki_no_decisions') })));
}

// ---------- export as a Markdown zip (store-only, no compression) ----------

let CRC = null;
function crc32(bytes) {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [{name, content}] -> Uint8Array of a .zip (names sanitized to [a-z0-9._-]). */
export function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  for (const f of files || []) {
    const name = enc.encode(String(f.name || 'page.md').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120));
    const data = enc.encode(String(f.content ?? ''));
    const crc = crc32(data);
    const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)]);
    parts.push(local, name, data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
    offset += local.length + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16((files || []).length), ...u16((files || []).length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

// ---------- admin: Memory trial metrics ----------

/** The admin view of GET /admin/memory/metrics: uptake, accuracy, confirmation load, context size, holds, backlog. */
export function memoryMetricsView(m) {
  if (!m || typeof m !== 'object') return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const u = m.uptake || {};
  const a = m.accuracy || {};
  const c = m.context_chars || {};
  const hd = m.contradiction_holds || {};
  const b = m.backlog || {};
  const row = (k, v) => h('div', { class: 'mem-metric' }, h('span', { class: 'muted', text: `${t(k)}: ` }), h('strong', { text: String(v) }));
  return h('section', { class: 'mem-metrics' },
    h('h2', { text: t('mem_metrics') }),
    row('mem_uptake', `${n(u.pct)}% (${n(u.with_memory_or_recall)} / ${n(u.task_runs)})`),
    row('mem_accuracy', `${n(a.pct)}% (${n(a.later_superseded_or_invalidated)} / ${n(a.injected_items)})`),
    row('mem_confirm_load', (Array.isArray(m.confirmation_load) ? m.confirmation_load : []).map((x) => `${String(x.person || '?')} ${n(x.per_week)}`).join(', ') || '0'),
    row('mem_context', `${n(c.avg)} / ${n(c.p95)} (≤ ${n(c.budget)})`),
    row('mem_holds', `${n(hd.accepted)} / ${n(hd.discarded)} / ${n(hd.open)}`),
    row('mem_backlog', `${t('wiki_waiting', { n: n(b.waiting) })}${n(b.age_hours) >= 24 ? ` (${t('wiki_waiting_age', { d: Math.floor(n(b.age_hours) / 24) })})` : ''}`));
}
