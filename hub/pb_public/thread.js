// Thread pieces: the sidebar's people & agents rows, a task's one-line status,
// the task thread (title + status line, collapsed handoff with history and
// diffs, one timeline of messages, decisions and channel replies) and the
// composer. Pure DOM builders (no network): every callback that talks to the
// hub comes in through `opts`. Data reaches the DOM only as text through h(),
// as sanitized markdown through mdNode(), or as a validated media URL through
// media.js.

import {
  h, mdNode, taskHref, ago, when, money, parseDate, agentLabel, isEstimated, isIdle,
  claimTag, repoList, extLink, waitingLabel, decideForm, TERMINAL, kindLabel, linkedText, agoSpan, moneyText, avatarNode,
} from './render.js';
import { attachmentList, attachmentsOf, checkFiles, setMediaSrc, humanSize, DEFAULT_LIMITS } from './media.js';
import { t, has } from './i18n.js';

const SAFE_KIND = /^[a-z_]{1,32}$/;
const AGENT_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function relId(v) { return v && typeof v === 'object' ? v.id : v; }

// ---------- avatars ----------

const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

/** Avatar letters: "BC" for bob-claude, one character for CJK names (its first character). */
export function initials(name) {
  const s = String(name || '?').trim() || '?';
  if (CJK_RE.test(s[0])) return s[0];
  const parts = s.split(/[\s._-]+/).filter(Boolean);
  const two = parts.length > 1 ? parts[0][0] + parts[1][0] : s.slice(0, 2);
  return two.toUpperCase();
}

export function avatar(kind, name, cls) {
  return avatarNode(kind, name, cls, initials(name));
}

function authorOf(msg, ctx) {
  if (msg.author_type === 'human' || (msg.author_user && !msg.author_agent)) {
    return { kind: 'human', name: msg.author_name || ctx.userName(relId(msg.author_user)) || 'human' };
  }
  if (msg.author_agent) return { kind: 'agent', name: msg.author_name || ctx.agentName(relId(msg.author_agent)) };
  return { kind: 'system', name: 'system' };
}

// ---------- sidebar: people & agents ----------

/** Online: an agent seen in the last 5 minutes. */
export function isOnline(agent, now = Date.now()) {
  const d = agent && agent.last_seen && parseDate(agent.last_seen);
  return !!d && now - d.getTime() < 5 * 60 * 1000;
}

/**
 * One DM-like row: an agent (#/a/<name>) or a person (#/u/<id>).
 * p: {kind: 'agent'|'human', id, name, online, inactive}. o: {active}
 */
export function personRow(p, o = {}) {
  const href = p.kind === 'agent'
    ? (AGENT_RE.test(String(p.name || '')) ? `#/a/${p.name}` : '#/')
    : (ID_RE.test(String(p.id || '')) ? `#/u/${p.id}` : '#/');
  return h('a', {
    class: 'side-row person-row' + (o.active ? ' active' : '') + (p.inactive ? ' dim' : ''),
    href, attrs: { title: p.description || '' },
  },
  avatar(p.kind, p.name, 'xs'),
  h('span', { class: 'side-title', text: p.name || p.id || '?' }),
  p.kind === 'agent' ? h('span', { class: 'presence' + (p.online ? ' on' : ''), attrs: { 'aria-hidden': 'true' } }) : null);
}

// ---------- status in plain words ----------

/** The stream's short status word: "waiting to be claimed", "in progress", "done"… */
export function statusWord(status) {
  const k = `stw_${status}`;
  const s = t(k);
  return s === k ? String(status || '') : s;
}

/** The thread's one status line: "Waiting for bob-worker to claim it", "Needs your decision", "Done · 14:02". */
export function statusLine(task, ctx, me) {
  const to = agentLabel(ctx, task, 'to_agent');
  const at = when(task.updated || task.last_activity, ctx.now);
  const w = String(task.waiting_on || '');
  switch (task.status) {
    case 'completed': return t('tl_completed', { when: at });
    case 'failed': return t('tl_failed', { when: at });
    case 'canceled': return t('tl_canceled', { when: at });
    case 'submitted': return t('tl_submitted', { to });
    default: break;
  }
  if (w.startsWith('human:')) {
    const uid = w.slice(6);
    return me && uid === me ? t('tl_decide_me') : t('tl_decide', { name: ctx.userName(uid) || '?' });
  }
  if (w.startsWith('agent:') && w.slice(6) !== relId(task.to_agent)) return t('tl_waiting_agent', { name: waitingLabel(ctx, w) });
  if (task.status === 'input-required') return t('stw_input-required');
  return t('tl_working', { to });
}

// ---------- task thread ----------

/** Thread head: ▣ T-1 title, one plain status line, actions (copy, cancel, close). */
export function taskHead(task, ctx, o = {}) {
  return h('div', { class: 'thread-head' },
    h('div', { class: 'th-top' },
      h('h2', { class: 'th-title' },
        task.priority === 'P0' ? h('span', { class: 'p0-dot', attrs: { title: t('p0'), 'aria-label': t('p0') } }) : null,
        h('span', { class: 'th-mark', attrs: { 'aria-hidden': 'true' }, text: '▣ ' }),
        task.seq ? h('span', { class: 'task-ref', text: `T-${Number(task.seq)} ` }) : null,
        h('span', { text: task.title || task.id || '?' })),
      o.copy || null,
      o.close || null),
    h('div', { class: 'th-status' },
      h('span', { class: 'status-line' + (task.status === 'input-required' ? ' needs' : ''), text: statusLine(task, ctx, o.me) }),
      o.channel || null,
      o.cancel || null));
}

/** Task facts (inside the handoff): sender → worker, money, cost, links, repos, key question, purpose. */
function taskFacts(task, ctx) {
  const est = isEstimated(ctx, task);
  const links = task.links && typeof task.links === 'object' ? task.links : null;
  const bits = [];
  bits.push(h('span', { class: 'agents', text: `${agentLabel(ctx, task, 'from_agent')} → ${agentLabel(ctx, task, 'to_agent')}` }));
  if (task.priority && task.priority !== 'P2') bits.push(h('span', { text: task.priority }));
  if (!TERMINAL.has(task.status)) { const c = claimTag(task); if (c) bits.push(c); }
  if (moneyText(task.money)) bits.push(h('span', { text: `${t('money')}: ${moneyText(task.money)}` }));
  if (Number(task.cost_usd)) bits.push(h('span', { text: `${t('cost')} ${money(task.cost_usd, est)}` }));
  if (isIdle(task, ctx.now)) bits.push(h('span', { class: 'warn', text: `${t('idle')} >24h` }));
  if (links && typeof links.issue === 'string' && links.issue) bits.push(h('span', null, `${t('issue')} `, extLink(links.issue)));
  if (links && typeof links.pr === 'string' && links.pr) bits.push(h('span', null, `${t('pr')} `, extLink(links.pr)));
  const repos = repoList(links);
  if (repos) bits.push(h('span', { text: `${t('repos')}: ${repos}` }));
  const deps = Array.isArray(task.depends_on) ? task.depends_on : [];
  if (deps.length) bits.push(h('span', null, `${t('depends_on')} `, deps.map((d) => h('a', { href: taskHref(relId(d)), text: `${relId(d)} ` }))));
  return h('div', { class: 'facts' },
    h('div', { class: 'facts-line' }, bits.map((b, i) => [i ? h('span', { class: 'sep', text: ' · ' }) : null, b])),
    task.key_question ? h('div', { class: 'th-kq' }, h('span', { class: 'label', text: t('key_question') }), linkedText(task.key_question, 'kq')) : null,
    task.purpose ? h('div', { class: 'th-purpose muted' }, linkedText(task.purpose)) : null);
}

/**
 * The handoff, collapsed: "Handoff v2 ▸". Inside: facts, body, attachments and
 * the version history with diffs. o: { open, media, focusVersion }
 */
export function handoffCard(task, versions, ctx, o = {}) {
  const cur = task.handoff_version ?? 1;
  const curRec = versions.find((v) => Number(v.version) === Number(cur));
  const list = [...versions].sort((a, b) => (b.version || 0) - (a.version || 0));
  const nFiles = curRec ? attachmentsOf(curRec).length : 0;
  return h('details', { class: 'handoff-card', attrs: { open: !!o.open, 'data-key': `handoff:${task.id}` } },
    h('summary', null,
      h('span', { class: 'hc-label', text: t('handoff_v', { n: cur }) }),
      nFiles ? h('span', { class: 'muted', text: ` · ${nFiles} ${t('files')}` }) : null,
      h('span', { class: 'caret', attrs: { 'aria-hidden': 'true' }, text: ' ▸' })),
    taskFacts(task, ctx),
    mdNode(task.handoff),
    curRec && o.media ? attachmentList(curRec, { ...o.media, collection: 'handoff_versions' }) : null,
    list.length > 1 ? h('details', { class: 'hc-history', attrs: { 'data-key': `history:${task.id}`, open: !!o.focusVersion } },
      h('summary', { text: `${t('history')} (${list.length})` }),
      list.map((v) => {
        const n = Number(v.version);
        const prev = versions.find((x) => Number(x.version) === n - 1);
        const isCur = n === Number(cur);
        return h('details', { class: 'hv' + (o.focusVersion === n ? ' hl' : ''), attrs: { 'data-key': `hv:${task.id}:${v.version}`, 'data-id': `v${v.version}`, open: o.focusVersion === n } },
          h('summary', null,
            h('span', { class: 'hv-n', text: `v${v.version}` }), ' ',
            h('span', { text: v.change_note || '—' }), ' ',
            isCur ? h('span', { class: 'muted', text: `(${t('current_version')}) ` }) : null,
            h('span', { class: 'muted', text: v.created ? ago(v.created, ctx.now) : '' })),
          // F12: the current version is shown above; each version shows what changed vs the one before
          prev ? diffView(prev.body, v.body, prev.version) : null,
          isCur ? null : prev
            ? h('details', { class: 'hv-full', attrs: { 'data-key': `hvf:${task.id}:${v.version}` } }, h('summary', { text: t('full_text') }), mdNode(v.body))
            : mdNode(v.body),
          o.media && !isCur ? attachmentList(v, { ...o.media, collection: 'handoff_versions' }) : null);
      })) : null);
}

// ---------- line diff (handoff history) ----------

/**
 * Line diff of two texts: [{op: ' ' | '+' | '-', line}], LCS-based. Inputs past
 * ~1500 lines each fall back to "all removed, all added".
 */
export function lineDiff(a, b) {
  const A = String(a ?? '').split('\n');
  const B = String(b ?? '').split('\n');
  const n = A.length; const m = B.length;
  if (n * m > 2250000) return [...A.map((line) => ({ op: '-', line })), ...B.map((line) => ({ op: '+', line }))];
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ op: ' ', line: A[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', line: A[i++] });
    else out.push({ op: '+', line: B[j++] });
  }
  while (i < n) out.push({ op: '-', line: A[i++] });
  while (j < m) out.push({ op: '+', line: B[j++] });
  return out;
}

/** Diff as text lines (+/-), unchanged runs longer than 2×ctx collapsed to "…". Text nodes only. */
export function diffView(a, b, prevVersion, ctxLines = 2) {
  const d = lineDiff(a, b);
  if (!d.some((x) => x.op !== ' ')) return h('div', { class: 'muted small', text: t('no_changes') });
  const keep = new Array(d.length).fill(false);
  d.forEach((x, i) => { if (x.op !== ' ') for (let k = Math.max(0, i - ctxLines); k <= Math.min(d.length - 1, i + ctxLines); k++) keep[k] = true; });
  const rows = [];
  let skipped = false;
  d.forEach((x, i) => {
    if (!keep[i]) { if (!skipped) rows.push(h('span', { class: 'dl skip', text: '…\n' })); skipped = true; return; }
    skipped = false;
    rows.push(h('span', { class: `dl ${x.op === '+' ? 'add' : x.op === '-' ? 'del' : 'same'}`, text: `${x.op} ${x.line}\n` }));
  });
  return h('div', { class: 'hv-diff' },
    h('div', { class: 'muted small', text: t('diff_vs', { n: prevVersion }) }),
    h('pre', { class: 'diff' }, rows));
}

// ---------- timeline ----------

const HANDOFF_NOTE_RE = /^handoff v(\d+): /;

/**
 * Messages, handoff updates, the claim and the task's channel replies in time
 * order. Each entry: {type: 'msg', msg} | {type: 'sys', text, at} | {type: 'post', post}
 */
export function timelineEntries(task, versions, msgs, ctx, replies = []) {
  const versionNums = new Set(versions.map((v) => Number(v.version)));
  const out = [];
  out.push({ type: 'sys', at: String(task.created || ''), text: t('sys_created', { from: agentLabel(ctx, task, 'from_agent'), to: agentLabel(ctx, task, 'to_agent') }) });
  for (const v of versions) {
    if (Number(v.version) > 1) out.push({ type: 'sys', at: String(v.created || ''), text: t('sys_handoff', { n: v.version, note: v.change_note || '' }) });
  }
  if (task.claimed_at) {
    out.push({ type: 'sys', at: String(task.claimed_at), text: t('sys_claimed', { agent: agentLabel(ctx, task, 'to_agent'), mode: task.claim_mode ? t('paren', { x: t(`claim_${task.claim_mode}`) }) : '' }) });
  }
  for (const m of msgs) {
    // The hub logs a handoff update as an agent note; the version line above shows it.
    const hm = m.kind === 'note' && m.author_type === 'agent' && String(m.body || '').match(HANDOFF_NOTE_RE);
    if (hm && versionNums.has(Number(hm[1]))) continue;
    if (m.author_type === 'system') out.push({ type: 'sys', at: String(m.created || ''), text: sysText(m) });
    else out.push({ type: 'msg', at: String(m.created || ''), msg: m });
  }
  for (const p of replies || []) out.push({ type: 'post', at: String(p.created || ''), post: p });
  out.sort((a, b) => a.at.localeCompare(b.at));
  return out;
}

/**
 * A hub system line in the reader's language: the hub stores a code + params
 * (sys_code / sys_params) next to the English body; unknown codes show the body.
 */
export function sysText(m) {
  const code = m && typeof m.sys_code === 'string' && SAFE_KIND.test(m.sys_code) ? m.sys_code : '';
  if (!code || !has(`sysc_${code}`)) return String((m && m.body) || '');
  let p = m.sys_params;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { p = null; } }
  const vars = {};
  if (p && typeof p === 'object') for (const [k, v] of Object.entries(p)) if (/^[a-z_]{1,20}$/.test(k) && (typeof v === 'string' || typeof v === 'number')) vars[k] = String(v).slice(0, 200);
  if (vars.was) vars.was = statusWord(vars.was);
  const s = t(`sysc_${code}`, vars);
  return /\{[a-z_]+\}/.test(s) ? String(m.body || '') : s;
}

export function systemLine(text, at, ctx) {
  return h('div', { class: 'sys-line' },
    linkedText(text), at ? agoSpan(at, ctx.now, { prefix: ' · ' }) : null);
}

const KIND_WORD = new Set(['question', 'answer', 'result']);

/**
 * One message, Slack-style: avatar, name, time, body. Only questions, answers
 * and results carry a small plain word; a decision request is an inline card.
 * o: { me, isAdmin, decide: {drafts, onDecide}, media, taskId, focus, linkOf }
 */
export function messageRow(msg, ctx, o = {}) {
  const kind = SAFE_KIND.test(msg.kind || '') ? msg.kind : 'note';
  const a = authorOf(msg, ctx);
  const target = msg.to_agent ? ctx.agentName(relId(msg.to_agent)) : '';
  const time = agoSpan(msg.created, ctx.now);
  const media = o.media ? attachmentList(msg, { ...o.media, collection: 'messages' }) : null;
  const link = o.linkOf ? o.linkOf(msg) : null;
  if (kind === 'progress') {
    return h('div', { class: 'msg compact kind-progress' + (o.focus === msg.id ? ' hl' : ''), attrs: { 'data-id': msg.id } },
      h('span', { class: 'gutter' }, h('span', { class: 'mini-dot', attrs: { 'aria-hidden': 'true' } })),
      h('div', { class: 'msg-main' },
        h('div', { class: 'compact-line' },
          h('span', { class: 'author', text: a.name }), ' ',
          h('span', { class: 'body-inline' }, mdNode(msg.body)), ' ', time, link),
        media));
  }
  return h('div', { class: `msg kind-${kind} by-${a.kind}` + (o.focus === msg.id ? ' hl' : ''), attrs: { 'data-id': msg.id } },
    avatar(a.kind, a.name),
    h('div', { class: 'msg-main' },
      h('div', { class: 'msg-head' },
        h('span', { class: 'author', text: a.name }),
        KIND_WORD.has(kind) ? h('span', { class: 'kind', text: kindLabel(kind) }) : null,
        kind === 'question' && target ? h('span', { class: 'target', text: `→ ${target}` }) : null,
        time, link),
      kind === 'decision_request' ? decisionCard(msg, ctx, o) : mdNode(msg.body),
      msg.evidence ? h('details', { class: 'evidence', attrs: { 'data-key': `ev:${msg.id}` } },
        h('summary', { text: t('evidence') }), mdNode(msg.evidence)) : null,
      media));
}

/** Inline decision request: question + (when I may decide) quick buttons and free text. */
export function decisionCard(msg, ctx, o = {}) {
  const mine = !!(o.me && relId(msg.to_user) === o.me);
  const canDecide = !msg.resolved && (mine || o.isAdmin) && o.decide && o.taskId;
  return h('div', { class: 'decision-card' + (msg.resolved ? ' resolved' : ' open') },
    h('div', { class: 'dc-head', text: msg.resolved ? t('decided') : mine ? t('tl_decide_me') : t('waiting_on_user', { name: ctx.userName(relId(msg.to_user)) || '?' }) }),
    canDecide && msg.choices ? null : mdNode(msg.body),
    canDecide ? decideForm(o.taskId, msg.id, o.decide, msg.choices) : null);
}

/** o: decision/media opts plus renderPost(post) for the task's channel replies. */
export function timeline(task, versions, msgs, ctx, o = {}) {
  const entries = timelineEntries(task, versions, msgs, ctx, o.replies);
  return h('div', { class: 'timeline' },
    entries.map((e) => (e.type === 'sys' ? systemLine(e.text, e.at, ctx)
      : e.type === 'post' ? (o.renderPost ? o.renderPost(e.post) : null)
        : messageRow(e.msg, ctx, o))),
    task.result && !msgs.some((m) => m.kind === 'result') ? h('div', { class: 'msg kind-result' },
      h('div', { class: 'msg-main' }, h('div', { class: 'msg-head' }, h('span', { class: 'kind', text: kindLabel('result') })), mdNode(task.result))) : null);
}

// ---------- composer ----------

/** A touch device (no hover, coarse pointer): Enter is a new line there. */
export function isTouch() {
  try {
    const mm = globalThis.window && window.matchMedia;
    return !!(mm && mm('(hover: none) and (pointer: coarse)').matches);
  } catch (_) { return false; }
}

export function composer(o) {
  const draftKey = o.draftKey || `note:${o.taskId}`;
  const L = { ...DEFAULT_LIMITS, ...(o.limits || {}) };
  const ph = o.placeholder || t('composer_placeholder', { name: o.meName || '' });
  const ta = h('textarea', {
    attrs: { rows: 2, placeholder: ph, 'data-draft': draftKey, 'aria-label': o.label || ph.replace(/…$/, '') || t('composer_label'), enterkeyhint: isTouch() ? 'enter' : 'send' },
  });
  // @agent / #channel suggestions (app.js passes the builder)
  const suggest = o.autocomplete ? o.autocomplete(ta) : null;
  ta.value = (o.drafts && o.drafts.get(draftKey)) || '';
  ta.addEventListener('input', () => o.drafts && o.drafts.set(draftKey, ta.value));
  const err = h('div', { class: 'error' });
  const bar = h('div', { class: 'progress', attrs: { hidden: true } }, h('span', { class: 'progress-fill' }));
  const fileInput = h('input', {
    class: 'file-input',
    attrs: { type: 'file', multiple: true, accept: [...L.mime_types, ...(L.text_ext || []).map((x) => `.${x}`)].join(','), hidden: true, 'aria-label': t('attach') },
  });
  const chips = h('div', { class: 'chips' });

  const addFiles = (list) => {
    const { ok, errors } = checkFiles([...list], L, o.files.length);
    o.files.push(...ok);
    err.textContent = errors.join(' ');
    drawChips();
    if (o.onFilesChange) o.onFilesChange();
  };
  const drawChips = () => {
    chips.replaceChildren(...o.files.map((f, i) => {
      const isImg = /^image\//.test(f.type);
      let thumb = null;
      if (isImg && globalThis.URL && URL.createObjectURL) {
        thumb = h('img', { class: 'chip-thumb', attrs: { alt: '' } });
        try { setMediaSrc(thumb, URL.createObjectURL(f)); } catch (_) { thumb = null; }
      }
      return h('span', { class: 'chip' }, thumb,
        h('span', { class: 'chip-name', text: f.name }),
        h('span', { class: 'muted', text: humanSize(f.size) }),
        h('button', {
          class: 'chip-x', attrs: { type: 'button', 'aria-label': `${t('remove')} ${f.name}` }, text: '×',
          on: { click: () => { o.files.splice(i, 1); drawChips(); if (o.onFilesChange) o.onFilesChange(); } },
        }));
    }));
  };
  drawChips();
  fileInput.addEventListener('change', () => { addFiles(fileInput.files || []); fileInput.value = ''; });
  ta.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) { e.preventDefault(); addFiles(files); }
  });

  const send = h('button', { class: 'btn primary', attrs: { type: 'submit' }, text: o.sendLabel || t('send') });
  const attachBtn = h('button', { class: 'btn ghost attach-btn', attrs: { type: 'button', title: t('attach') }, text: t('attach'), on: { click: () => fileInput.click() } });
  const form = h('form', {
    class: 'composer',
    on: {
      submit: async (e) => {
        e.preventDefault();
        if (send.disabled) return; // a send is already running (Enter pressed twice)
        const text = ta.value.trim();
        if (!text && !o.files.length) { ta.focus(); return; }
        err.textContent = '';
        send.disabled = true; attachBtn.disabled = true;
        const fill = bar.firstChild;
        if (o.files.length) { bar.removeAttribute('hidden'); fill.style.width = '0%'; }
        try {
          await o.onSend(text, [...o.files], (frac) => { fill.style.width = `${Math.round(frac * 100)}%`; });
          ta.value = '';
          if (o.drafts) o.drafts.delete(draftKey);
          o.files.length = 0;
          drawChips();
        } catch (ex) {
          err.textContent = `${t('error')}: ${(ex && ex.message) || ex}`;
        } finally {
          send.disabled = false; attachBtn.disabled = false;
          bar.setAttribute('hidden', '');
        }
      },
    },
  },
  o.to ? h('div', { class: 'composer-to' }, o.to) : null,
  chips,
  suggest,
  h('div', { class: 'composer-row' }, ta,
    h('div', { class: 'composer-btns' }, attachBtn, send)),
  isTouch() ? null : h('div', { class: 'composer-hint', attrs: { 'aria-hidden': 'true' }, text: t('enter_hint') }),
  bar, fileInput, err);
  // Desktop: Enter sends, Shift+Enter is a new line. Touch keyboards: Enter is a
  // new line (the send button sends). Never while an IME is composing (Chinese
  // input confirms a candidate with Enter) or the @/# list took the key.
  const submitNow = () => (form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true })));
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); submitNow(); return; }
    if (e.shiftKey || e.altKey || isTouch()) return;
    e.preventDefault();
    submitNow();
  });
  form.addFiles = addFiles;
  return form;
}
