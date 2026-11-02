// Channel pieces: sidebar channel rows, the channel
// stream (posts, and tasks as messages with one status line), the post thread
// pane, a person's or agent's DM-like stream, search results, the channels
// admin page, copy-link buttons and the @/# composer autocomplete. Pure DOM
// builders; app.js passes data and callbacks.

import { h, tag, mdNode, extLink, ago, taskHref, errText, TERMINAL, linkedText, parseDate, dayKey, dayLabel, when, agoSpan, plainSnippet } from './render.js';
import { attachmentList } from './media.js';
import { avatar, statusWord, sysText } from './thread.js';
import { t, tn } from './i18n.js';
import { promoteButton } from './wiki.js';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const AGENT_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function channelHref(name) { return NAME_RE.test(String(name || '')) ? `#/c/${name}` : '#/'; }
export function postHref(id) { return ID_RE.test(String(id || '')) ? `#/p/${id}` : '#/'; }
export function agentHref(name) { return AGENT_RE.test(String(name || '')) ? `#/a/${name}` : '#/'; }
export function userHref(id) { return ID_RE.test(String(id || '')) ? `#/u/${id}` : '#/'; }

/** "link" button (shown on hover): copies the absolute permalink of `hash` (e.g. "#/p/abc"). */
export function copyLink(hash, label) {
  const btn = h('button', {
    class: 'btn link copy-link', attrs: { type: 'button', title: t('copy_link') }, text: label || t('link'),
    on: {
      click: async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = `${window.location.origin}${window.location.pathname}${hash}`;
        try { await navigator.clipboard.writeText(url); btn.textContent = t('copied'); } catch (_) { window.prompt(t('copy_link'), url); }
      },
    },
  });
  return btn;
}

// ---------- sidebar ----------

/**
 * Sidebar channel groups: channels the viewer is a member of first ("my
 * channels"), the other visible ones under a collapsible "more channels".
 * When the viewer is a member of none (or the hub sends no membership), all
 * channels are listed as before. Returns {mine, more}.
 */
export function splitChannels(channels) {
  const list = Array.isArray(channels) ? channels : [];
  const mine = list.filter((c) => c && c.member === true);
  if (!mine.length) return { mine: list, more: [] };
  return { mine, more: list.filter((c) => c && c.member !== true) };
}

/** The sidebar's channel section: my channels, then <details> "more channels (N)". o: as channelRows + {moreOpen} */
export function channelSection(channels, o = {}) {
  const g = splitChannels(channels);
  const moreActive = g.more.some((c) => c.name === o.active);
  return [
    ...channelRows(g.mine, o),
    g.more.length ? h('details', {
      class: 'side-more', attrs: { 'data-key': 'side:more-channels', open: !!(o.moreOpen || moreActive) },
      on: o.onMoreToggle ? { toggle: (e) => o.onMoreToggle(!!e.currentTarget.open) } : undefined,
    },
      h('summary', { class: 'side-row side-more-head' }, h('span', { class: 'side-title muted', text: t('more_channels', { n: g.more.length }) })),
      channelRows(g.more, o)) : null,
  ];
}

/** Channel rows: "# name", bold with a dot when there are posts newer than the person last saw. */
export function channelRows(channels, o = {}) {
  return channels.map((c) => {
    const unread = !!(o.seen && c.last_post_at && String(c.last_post_at) > String(o.seen[c.id] || '') && o.active !== c.name);
    return h('a', {
      class: 'side-row ch-row' + (o.active === c.name ? ' active' : '') + (unread ? ' unread' : ''),
      href: channelHref(c.name), attrs: { title: channelDesc(c) },
    }, h('span', { class: 'hash', text: '#' }), h('span', { class: 'side-title', text: channelLabel(c) }),
    unread ? h('span', { class: 'dot on', attrs: { 'aria-hidden': 'true' } }) : null);
  });
}

// The hub seeds #general with this English description; show it in the reader's language.
const GENERAL_DEFAULT_DESC = 'Team-wide discussion and tasks';
/** A channel's description, the seeded #general one localized. */
export function channelDesc(c) {
  const d = c && typeof c.description === 'string' ? c.description.trim() : '';
  return d === GENERAL_DEFAULT_DESC ? t('general_desc') : d;
}

/** Display name: the free-text title (any language) when set, else the slug. */
export function channelLabel(c) {
  const title = c && typeof c.title === 'string' ? c.title.trim() : '';
  return title || (c && c.name) || '?';
}

// ---------- posts ----------

const EXT_KIND = { github_issue: 'issue', github_pr: 'PR' };

function dateOnly(s) { return String(s || '').slice(0, 10); }

/**
 * An imported GitHub issue/PR (author_type "external"): a compact card with
 * [issue]/[PR], repo#n + title linking to GitHub, the state, author → assignees,
 * the update date, and the excerpt collapsed (rendered markdown, sanitized).
 */
export function externalCard(p, ctx, o = {}) {
  const x = p.external && typeof p.external === 'object' ? p.external : {};
  const ref = `${x.repo || ''}#${x.number || ''}`;
  const state = ['open', 'closed', 'merged'].includes(x.state) ? x.state : String(x.state || '');
  const assignees = (Array.isArray(x.assignee_names) && x.assignee_names.length ? x.assignee_names : Array.isArray(x.assignees) ? x.assignees : []).map(String);
  const who = String(p.author_name || x.author_name || x.author || '?');
  const whoNode = p.author_user ? h('a', { class: 'author', href: userHref(p.author_user), text: who }) : h('span', { class: 'author', text: who });
  const excerpt = typeof x.excerpt === 'string' ? x.excerpt.trim() : '';
  return h('div', { class: 'msg post ext-card' + (o.focus === p.id ? ' hl' : ''), attrs: { 'data-id': p.id, 'data-type': 'external' } },
    h('div', { class: 'gutter ext-gutter' }, h('a', { class: 'time', href: postHref(p.id), attrs: { title: when(p.created, ctx.now) }, text: hhmm(p.created) })),
    h('div', { class: 'msg-main' },
      h('div', { class: 'ext-head' },
        tag(EXT_KIND[x.kind] || 'issue'), ' ',
        extLink(x.url, ref), ' ',
        extLink(x.url, x.title || p.body || '?'), ' ',
        state ? tag(t(`ext_${state}`) || state, state === 'open' ? 'strong' : '') : null,
        o.showChannel && p.channel_name ? h('a', { class: 'ch-link', href: channelHref(p.channel_name), text: ` #${p.channel_name}` }) : null),
      h('div', { class: 'ext-meta muted' },
        whoNode,
        assignees.length ? h('span', { text: ` → ${assignees.join(', ')}` }) : null,
        x.updated_at ? h('span', { text: ` · ${t('ext_updated', { date: dateOnly(x.updated_at) })}` }) : null),
      excerpt ? h('details', { class: 'ext-excerpt', attrs: { 'data-key': `ext:${p.id}` } }, h('summary', { text: t('ext_excerpt') }), mdNode(excerpt)) : null,
      repliesLink(p, o)),
    copyLink(postHref(p.id)));
}

function authorOf(p, ctx) {
  if (p.author_type === 'human') return { kind: 'human', name: p.author_name || ctx.userName(p.author_user) || 'human', href: p.author_user ? userHref(p.author_user) : '' };
  if (p.author_type === 'agent') return { kind: 'agent', name: p.author_name || ctx.agentName(p.author_agent), href: agentHref(p.author_name || ctx.agentName(p.author_agent)) };
  return { kind: 'system', name: 'system', href: '' };
}

function hhmm(s) {
  const d = parseDate(s);
  return d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
}

function postBody(p, o) {
  return [
    mdNode(p.body),
    p.evidence ? h('details', { class: 'evidence', attrs: { 'data-key': `pev:${p.id}` } }, h('summary', { text: t('evidence') }), mdNode(p.evidence)) : null,
    o.media ? attachmentList(p, { ...o.media, collection: 'posts' }) : null,
  ];
}

function repliesLink(p, o) {
  if (o.inThread) return null;
  const n = Number(p.reply_count) || 0;
  return h('a', { class: 'replies-link' + (n ? '' : ' hover-only'), href: postHref(p.id), text: n ? tn('n_replies_short', n) : t('reply') });
}

/** A post or reply, Slack-style: avatar, name, time, body. o: { media, inThread, focus, cont, showChannel } */
export function postItem(p, ctx, o = {}) {
  if (p.kind === 'task') return taskPostItem(p, ctx, o);
  // an inbound-hook post (CI, deploy scripts): a plain post marked external (notify.js)
  if (p.inbound) p = { ...p, author_type: 'human', author_user: '', external: null, untrusted_from: String(p.inbound.name || '') };
  if (p.author_type === 'external' || (p.external && typeof p.external === 'object' && p.external.kind)) return externalCard(p, ctx, o);
  const a = authorOf(p, ctx);
  if (p.kind === 'system' || p.author_type === 'system') {
    return h('div', { class: 'sys-line post-sys', attrs: { 'data-id': p.id } }, linkedText(sysText(p)), agoSpan(p.created, ctx.now, { prefix: ' · ' }));
  }
  // F2: a follow-up by the same author within 10 minutes drops the avatar and header
  if (o.cont && !p.escalated) {
    return h('div', { class: 'msg post cont by-' + a.kind + (o.focus === p.id ? ' hl' : ''), attrs: { 'data-id': p.id } },
      h('a', { class: 'gutter time', href: postHref(p.id), attrs: { title: when(p.created, ctx.now) }, text: hhmm(p.created) }),
      h('div', { class: 'msg-main' }, postBody(p, o), repliesLink(p, o)),
      copyLink(postHref(p.id)));
  }
  return h('div', { class: 'msg post by-' + a.kind + (o.focus === p.id ? ' hl' : '') + (p.escalated ? ' escalated' : ''), attrs: { 'data-id': p.id } },
    avatar(a.kind, a.name),
    h('div', { class: 'msg-main' },
      h('div', { class: 'msg-head' },
        a.href ? h('a', { class: 'author', href: a.href, text: a.name }) : h('span', { class: 'author', text: a.name }),
        h('a', { class: 'time', href: postHref(p.id), attrs: { title: when(p.created, ctx.now), 'data-ago': o.inThread ? String(p.created || '') : null }, text: o.inThread ? ago(p.created, ctx.now) : hhmm(p.created) || ago(p.created, ctx.now) }),
        o.showChannel && p.channel_name ? h('a', { class: 'ch-link', href: channelHref(p.channel_name), text: `#${p.channel_name}` }) : null,
        p.escalated ? h('span', { class: 'flag', text: p.to_user_name ? `${t('escalated')} → ${p.to_user_name}` : t('escalated') }) : null,
        p.untrusted_from ? tag(t('nt_external')) : null,
        p.announce ? tag(t('nt_announce_tag')) : null,
        copyLink(postHref(p.id)),
        // members of a private channel: make one statement from this post team-visible (the post stays private)
        o.privateChannel && o.promote && p.id ? promoteButton(`#/p/${p.id}`, String(p.body || '').split('\n')[0], o.promote) : null),
      postBody(p, o),
      repliesLink(p, o)));
}

/**
 * A task in the stream: just a message by the sender with a small ▣ marker and
 * ONE status line ("→ bob-worker · waiting to be claimed · 3 replies"). Only
 * P0 shows a small red dot; no version or priority tags.
 */
export function taskPostItem(p, ctx, o = {}) {
  const ti = p.task_info || {};
  const ref = ti.ref && /^T-\d+$/.test(ti.ref) ? ti.ref : '';
  const href = taskHref(ti.id || p.task, ref ? ref.slice(2) : undefined);
  const from = ti.from_agent_name || p.author_name || ctx.agentName(ti.from_agent) || '?';
  const replies = (Number(ti.reply_count) || 0) + (Number(p.reply_count) || 0);
  const bits = [`→ ${ti.to_agent_name || ctx.agentName(ti.to_agent) || '?'}`, statusWord(ti.status)];
  if (replies) bits.push(tn('n_replies_short', replies));
  return h('div', { class: 'msg post task-post' + (o.focus === p.id ? ' hl' : '') + (TERMINAL.has(ti.status) ? ' done' : '') + (ti.status === 'input-required' ? ' needs' : ''), attrs: { 'data-id': p.id, 'data-task': ti.id || p.task || '' } },
    avatar('agent', from),
    h('div', { class: 'msg-main' },
      h('div', { class: 'msg-head' },
        h('span', { class: 'author', text: from }),
        h('span', { class: 'time', attrs: { title: when(p.created, ctx.now) }, text: hhmm(p.created) }),
        o.showChannel && (p.channel_name || ti.channel_name) ? h('a', { class: 'ch-link', href: channelHref(p.channel_name || ti.channel_name), text: `#${p.channel_name || ti.channel_name}` }) : null,
        copyLink(href)),
      h('a', { class: 'task-title', href },
        ti.priority === 'P0' ? h('span', { class: 'p0-dot', attrs: { title: t('p0'), 'aria-label': t('p0') } }) : null,
        h('span', { class: 'mark', attrs: { 'aria-hidden': 'true' }, text: '▣' }), ' ',
        ref ? h('span', { class: 'task-ref', text: `${ref} ` }) : null,
        h('span', { class: 'title', text: ti.title || p.body || '?' })),
      h('a', { class: 'task-status', href, text: bits.join(' · ') })));
}

/** Posts from agents the owner marked `quiet` (data bots): collapsed in streams, hidden by "hide bots". */
export function isQuietPost(p) {
  return !!(p && (p.author_quiet === true || p.quiet === true) && p.kind !== 'task');
}

const GROUP_MS = 10 * 60 * 1000;
function authorKey(p) {
  if (!p || p.kind === 'task' || p.kind === 'system' || p.author_type === 'system' || p.author_type === 'external') return '';
  return `${p.author_type}:${p.author_agent || p.author_user || p.author_name || ''}`;
}

/**
 * F2: the stream as DOM rows: day separators, an unread divider before the
 * first post newer than `o.unreadAfter`, follow-ups by the same author within
 * 10 minutes grouped, and runs of posts by one quiet agent collapsed into
 * "data-bot posted N updates ▸". posts: oldest first.
 */
export function streamItems(posts, ctx, o = {}) {
  const out = [];
  let day = '';
  let prev = null;
  let divided = !o.unreadAfter;
  const list = posts || [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const k = dayKey(p.created);
    if (k && k !== day) { day = k; prev = null; out.push(h('div', { class: 'day-sep', attrs: { role: 'separator' } }, h('span', { text: dayLabel(p.created, ctx.now) }))); }
    if (!divided && String(p.created || '') > String(o.unreadAfter)) {
      divided = true; prev = null;
      out.push(h('div', { class: 'unread-sep', attrs: { role: 'separator' } }, h('span', { text: t('new_since') })));
    }
    if (isQuietPost(p)) {
      const key = authorKey(p);
      const run = [p];
      while (i + 1 < list.length && isQuietPost(list[i + 1]) && authorKey(list[i + 1]) === key && dayKey(list[i + 1].created) === day
        && (divided || String(list[i + 1].created || '') <= String(o.unreadAfter))) run.push(list[++i]);
      if (run.length > 1) {
        const name = run[0].author_name || ctx.agentName(run[0].author_agent);
        out.push(h('details', { class: 'quiet-run', attrs: { 'data-key': `quiet:${run[0].id}`, open: !!(o.focus && run.some((x) => x.id === o.focus)) } },
          h('summary', null, h('span', { class: 'mini-dot', attrs: { 'aria-hidden': 'true' } }), ' ', h('span', { text: t('quiet_run', { name, n: run.length }) }), ' ',
            h('span', { class: 'time', text: `${hhmm(run[0].created)}–${hhmm(run[run.length - 1].created)}` }), h('span', { class: 'caret', text: ' ▸' })),
          run.map((x, j) => postItem(x, ctx, { ...o, cont: j > 0 }))));
      } else out.push(postItem(p, ctx, o));
      prev = null;
      continue;
    }
    const key = authorKey(p);
    const pd = prev && parseDate(prev.created);
    const cd = parseDate(p.created);
    const cont = !!(key && prev && authorKey(prev) === key && pd && cd && cd - pd <= GROUP_MS && !p.escalated && !(Number(prev.reply_count) > 0)
      && (!o.showChannel || prev.channel_name === p.channel_name));
    out.push(postItem(p, ctx, { ...o, cont }));
    prev = key ? p : null;
  }
  return out;
}

/** Channel stream pane. data: {channel, posts}. o: {media, composer, focus, unreadAfter, hasMore, onOlder, notice} */
export function channelView(data, ctx, o = {}) {
  const c = data.channel || {};
  const label = channelLabel(c);
  const posts = data.posts || [];
  const older = o.onOlder && o.hasMore ? h('button', {
    class: 'btn link load-older', attrs: { type: 'button' }, text: t('load_older'),
    on: { click: (e) => { e.currentTarget.disabled = true; o.onOlder(); } },
  }) : null;
  return h('div', { class: 'pane channel' },
    h('div', { class: 'pane-head' },
      h('h1', { class: 'pane-title' }, h('span', { class: 'hash', text: '# ' }), h('span', { text: label })),
      c.archived ? h('span', { class: 'muted', text: t('archived') }) : null,
      channelDesc(c) ? h('span', { class: 'pane-sub muted', text: channelDesc(c) }) : null,
      NAME_RE.test(String(c.name || '')) ? h('a', { class: 'btn link wiki-link', href: `#/c/${c.name}/memory`, text: t('wiki') }) : null,
      copyLink(channelHref(c.name))),
    h('div', { class: 'thread-scroll' },
      h('div', { class: 'thread-inner stream' },
        older,
        posts.length ? streamItems(posts, ctx, c.visibility === 'private' && o.promote ? { ...o, privateChannel: true } : o) : h('div', { class: 'empty-state muted', text: t('channel_empty') }))),
    footer(o));
}

/** Composer area; the drop hint only when there is a composer (F5). */
export function footer(o) {
  return h('div', { class: 'thread-foot' },
    o.notice ? h('div', { class: 'notice small', attrs: { role: 'status' }, text: o.notice }) : null,
    o.actions || null,
    o.composer && o.composer.addFiles ? h('div', { class: 'drop-hint', text: t('drop_here') }) : null,
    o.composer || null);
}

/** Post thread (right pane): root post + replies + composer. data: {post, replies, focus}. o: {close, media, composer, notice} */
export function threadView(data, ctx, o = {}) {
  const root = data.post || {};
  return h('div', { class: 'pane thread post-thread' },
    h('div', { class: 'thread-head' },
      h('div', { class: 'th-top' },
        h('h2', { class: 'th-title' }, h('span', { text: t('thread_title') }), ' ',
          h('a', { class: 'ch-link', href: channelHref(root.channel_name), text: `#${root.channel_title || root.channel_name || '?'}` })),
        copyLink(postHref(root.id)),
        o.close || null)),
    h('div', { class: 'thread-scroll' },
      h('div', { class: 'thread-inner' },
        postItem(root, ctx, { ...o, inThread: true, focus: data.focus }),
        h('div', { class: 'replies' }, (data.replies || []).map((r) => postItem(r, ctx, { ...o, inThread: true, focus: data.focus }))))),
    footer(o));
}

// ---------- people & agents (DM-like) ----------

/** A task as a stream item (the shape of an anchor post) for the DM view. */
export function taskAsPost(task) {
  return {
    id: `task-${task.id}`, kind: 'task', task: task.id, created: task.created, channel_name: task.channel_name || '',
    author_type: 'agent', author_agent: task.from_agent, author_name: task.from_agent_name || '',
    task_info: {
      id: task.id, ref: task.ref || (Number(task.seq) > 0 ? `T-${Number(task.seq)}` : ''), title: task.title, status: task.status, priority: task.priority,
      from_agent: task.from_agent, from_agent_name: task.from_agent_name, to_agent: task.to_agent, to_agent_name: task.to_agent_name, reply_count: task.reply_count || 0,
    },
  };
}

/**
 * An agent's or a person's messages and tasks, one stream (oldest first).
 * p: {kind: 'agent'|'human', name, sub, href, items: [post | taskAsPost]}.
 * o: {media, composer, notice}: an agent's page has a composer that posts to
 * #general with @name (there are no private DMs); a person's page is a profile.
 */
export function dmView(p, ctx, o = {}) {
  const items = [...(p.items || [])].sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')));
  return h('div', { class: 'pane dm' + (o.composer ? '' : ' profile') },
    h('div', { class: 'pane-head' },
      avatar(p.kind, p.name),
      h('h1', { class: 'pane-title', text: p.name || '?' }),
      p.sub ? h('span', { class: 'pane-sub muted', text: p.sub }) : null,
      p.href ? copyLink(p.href) : null),
    h('div', { class: 'thread-scroll' },
      h('div', { class: 'thread-inner stream' },
        items.length ? streamItems(items, ctx, { ...o, showChannel: true }) : h('div', { class: 'empty-state muted', text: t('dm_empty') }))),
    o.composer ? footer(o) : null);
}

// ---------- search ----------

function hashOf(url) {
  const s = String(url || '');
  const i = s.indexOf('#/');
  return i >= 0 ? s.slice(i) : '#/';
}

/** A "hide bots" toggle (F2): a checkbox with a visible label. */
export function botsToggle(on, onChange) {
  const box = h('input', { attrs: { type: 'checkbox', checked: !!on, 'aria-label': t('hide_bots') }, on: { change: (e) => onChange(!!e.target.checked) } });
  return h('label', { class: 'check bots-toggle' }, box, h('span', { text: t('hide_bots') }));
}

// ---------- search ----------

const RESULT_LABEL = { post: 'res_post', task: 'res_task', message: 'res_message', handoff: 'res_handoff', wiki: 'res_wiki' };

/** Snippet with the query terms marked (text only). */
function snippet(text, q) {
  const s = String(text || '');
  const terms = String(q || '').split(/\s+/).filter(Boolean).map((x) => x.toLowerCase());
  const out = [];
  let i = 0;
  const low = s.toLowerCase();
  while (i < s.length) {
    let best = -1; let len = 0;
    for (const term of terms) {
      const j = low.indexOf(term, i);
      if (j >= 0 && (best < 0 || j < best)) { best = j; len = term.length; }
    }
    if (best < 0) { out.push(s.slice(i)); break; }
    if (best > i) out.push(s.slice(i, best));
    out.push(h('mark', { text: s.slice(best, best + len) }));
    i = best + len;
  }
  return out;
}

// What people wrote (posts, task results and messages) before handoffs (the
// spec an agent wrote) at about the same relevance.
const TYPE_RANK = { post: 0, task: 0, message: 0, handoff: 1 };
/**
 * The hub's order is relevance (bm25) for full-text queries and newest-first
 * for short (LIKE) ones. Full-text: a handoff sinks 3.5 places, so it only
 * leads when it is clearly more relevant than what people wrote.
 * Newest-first: types in rank order, newest first within each.
 */
export function orderResults(results, mode) {
  const all = (results || []).filter((r) => r && typeof r === 'object');
  // wiki pages (the maintained layer) always come first, in the hub's order
  const wiki = all.filter((r) => r.type === 'wiki');
  const list = all.filter((r) => r.type !== 'wiki');
  const rank = (r) => TYPE_RANK[r.type] ?? 1;
  const score = mode === 'fts' || mode === 'fts+like'
    ? (r, i) => i + 3.5 * rank(r)
    : (r, i) => rank(r) * 1e6 + i;
  return [...wiki, ...list.map((r, i) => ({ r, s: score(r, i), i })).sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.r)];
}

/** Search results. o: {hideBots, onHideBots(bool)} */
export function searchView(q, res, ctx, o = {}) {
  const results = orderResults((res && res.results) || [], res && res.mode);
  return h('div', { class: 'pane search' },
    h('div', { class: 'pane-head' }, h('h1', { text: t('search_results', { q }) }), h('span', { class: 'n muted', text: String(results.length) }),
      o.onHideBots ? h('div', { class: 'filters' }, botsToggle(o.hideBots, o.onHideBots)) : null),
    h('div', { class: 'pane-body' },
      res && res.error ? h('div', { class: 'error', text: res.error }) : null,
      results.length ? results.map((r) => h('a', { class: 'result', href: hashOf(r.url) },
        h('div', { class: 'result-head' },
          // F12: "[handoff v1]"
          tag(r.type === 'handoff' && Number(r.version) > 0 ? `${t('res_handoff')} v${Number(r.version)}` : t(RESULT_LABEL[r.type] || 'res_post')),
          r.task_ref ? h('span', { class: 'task-ref', text: r.task_ref }) : null,
          r.task_title ? h('span', { class: 'title', text: r.task_title }) : null,
          r.type === 'wiki' && r.title ? h('span', { class: 'title', text: r.title }) : null,
          r.channel_name ? h('span', { class: 'ch', text: `#${r.channel_name}` }) : null,
          h('span', { class: 'who', text: r.author_name || '' }),
          h('span', { class: 'time', attrs: { title: ago(r.created, ctx.now) }, text: when(r.created, ctx.now) })),
        h('div', { class: 'snippet' }, snippet(plainSnippet(r.snippet), q))))
        : h('div', { class: 'empty-state muted', text: t('no_results') })));
}

// ---------- admin: channels, embeds, storage ----------

function humanBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Slug from a free-text title: lowercase ASCII letters/digits, other runs -> "-".
 * A title with no ASCII letters (e.g. Chinese) gives "" and the hub generates one.
 */
export function slugify(title) {
  return String(title || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 40).replace(/-+$/, '');
}
export function validChannelName(s) { return NAME_RE.test(String(s || '')); }

/**
 * o: { channels, embedHosts, storage, onCreate({title, name?, description}), onPatch(channel, body), onEmbeds(list), tabs }
 */
export function channelsAdminView(o) {
  const err = h('div', { class: 'error' });
  const run = (fn) => async (...a) => { err.textContent = ''; try { await fn(...a); } catch (ex) { err.textContent = `${t('error')}: ${errText(ex)}`; } };
  // F10: a free-text title (Chinese welcome); the slug follows it until edited by hand
  const title = h('input', { attrs: { placeholder: t('channel_title'), maxlength: 80, 'aria-label': t('channel_title'), name: 'title' } });
  const name = h('input', { class: 'slug', attrs: { placeholder: t('channel_slug'), maxlength: 40, 'aria-label': t('channel_name'), name: 'name', autocomplete: 'off' } });
  let slugEdited = false;
  title.addEventListener('input', () => { if (!slugEdited) name.value = slugify(title.value); });
  name.addEventListener('input', () => { slugEdited = name.value.trim() !== ''; });
  const desc = h('input', { attrs: { placeholder: t('description'), maxlength: 2000, 'aria-label': t('description'), name: 'description' } });
  const create = h('form', {
    class: 'create',
    on: {
      submit: (e) => {
        e.preventDefault();
        const slug = name.value.trim();
        const tt = title.value.trim();
        err.textContent = '';
        if (!slug && !tt) { title.focus(); return; }
        if (slug && !validChannelName(slug)) { err.textContent = t('err_invalid_name'); name.focus(); return; }
        const body = { description: desc.value.trim() };
        if (tt) body.title = tt;
        if (slug) body.name = slug;
        run(o.onCreate)(body);
      },
    },
  },
  h('h2', { text: t('create_channel') }),
  h('div', { class: 'fields' }, title, name, desc, h('button', { class: 'btn primary', attrs: { type: 'submit' }, text: t('create') })),
  h('p', { class: 'muted small', text: t('channel_slug_hint') }));
  const rows = (o.channels || []).map((c) => {
    const rn = h('input', { attrs: { value: c.name, maxlength: 40, 'aria-label': t('rename') } });
    const general = c.name === 'general';
    const rename = run(async () => {
      const v = rn.value.trim();
      if (!validChannelName(v)) throw new Error(t('err_invalid_name'));
      await o.onPatch(c, { name: v });
    });
    const archive = run(async () => {
      // F10: archiving asks first
      if (!c.archived && !window.confirm(t('archive_confirm', { name: c.name }))) return;
      await o.onPatch(c, { archived: !c.archived });
    });
    return h('div', { class: 'row' + (c.archived ? ' dim' : ''), attrs: { 'data-id': c.id } },
      h('div', { class: 'row-main' }, h('a', { class: 'title', href: channelHref(c.name), text: `#${channelLabel(c)}` }), ' ',
        channelLabel(c) !== c.name ? h('span', { class: 'muted', text: c.name }) : null, ' ',
        c.archived ? tag(t('archived'), 'strong') : null, h('span', { class: 'muted', text: ` ${tn('n_posts', c.post_count || 0)}` })),
      c.description ? h('div', { class: 'desc', text: c.description }) : null,
      h('div', { class: 'row-meta controls' },
        general ? null : [rn, h('button', { class: 'btn', attrs: { type: 'button' }, text: t('rename'), on: { click: rename } })],
        general ? h('span', { class: 'muted', text: t('general_fixed') })
          : h('button', { class: 'btn' + (c.archived ? '' : ' danger'), attrs: { type: 'button' }, text: c.archived ? t('unarchive') : t('archive'), on: { click: archive } })));
  });
  const hosts = h('textarea', { attrs: { rows: 3, 'aria-label': t('embed_hosts') } });
  hosts.value = (o.embedHosts || []).join('\n');
  const st = o.storage || null;
  return h('div', { class: 'pane admin channels-admin' },
    h('div', { class: 'pane-head' }, h('h1', { text: t('settings') })),
    h('div', { class: 'pane-body' },
      o.tabs || null,
      err,
      create,
      rows,
      h('h2', { text: t('embed_hosts') }),
      h('p', { class: 'muted small', text: t('embed_hosts_hint') }),
      h('form', { class: 'create embeds', on: { submit: (e) => { e.preventDefault(); run(o.onEmbeds)(hosts.value.split(/[\s,]+/).filter(Boolean)); } } },
        hosts, h('div', { class: 'btns' }, h('button', { class: 'btn primary', attrs: { type: 'submit' }, text: t('save') }))),
      h('h2', { text: t('storage') }),
      st ? h('div', { class: 'storage' },
        h('div', { text: `${t('storage_files', { n: st.attachments_files || 0 })}: ${humanBytes(st.attachments_bytes)}` }),
        h('div', { class: 'muted small', text: `${t('storage_db')}: ${humanBytes(st.db_bytes)} · ${t('storage_backend')}: ${st.storage}` }),
        h('div', { class: 'muted small', text: Object.entries(st.by_collection || {}).map(([k, v]) => `${k} ${v.files} / ${humanBytes(v.bytes)}`).join(' · ') }))
        : h('div', { class: 'muted', text: '…' }),
      o.storageDetail || null, // per channel, direct uploads, retention (storage.js)
      o.memory || null));
}

// ---------- composer autocomplete ----------

/**
 * @agent / #channel suggestions under a textarea. sources(): {agents: [names], channels: [names]}.
 * Inserts "@name " / "#name " at the caret. Tab / Enter pick the highlighted one.
 */
export function attachAutocomplete(ta, sources) {
  const list = h('div', { class: 'ac-list', attrs: { role: 'listbox', hidden: true } });
  let items = [];
  let idx = 0;
  let span = null;
  const close = () => { list.hidden = true; items = []; span = null; };
  const pick = (name) => {
    if (!span) return;
    const v = ta.value;
    ta.value = v.slice(0, span.start) + span.sigil + name + ' ' + v.slice(span.end);
    const pos = span.start + span.sigil.length + name.length + 1;
    try { ta.setSelectionRange(pos, pos); } catch (_) { /* ignore */ }
    ta.dispatchEvent(new Event('input'));
    close();
    ta.focus();
  };
  const draw = () => {
    list.replaceChildren(...items.map((n, i) => h('button', {
      class: 'ac-item' + (i === idx ? ' on' : ''), attrs: { type: 'button', role: 'option' }, text: `${span.sigil}${n}`,
      on: { mousedown: (e) => { e.preventDefault(); pick(n); } },
    })));
    list.hidden = !items.length;
  };
  ta.addEventListener('input', () => {
    const caret = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, caret);
    const m = /(^|[\s(])([@#])([a-z0-9_-]{0,40})$/.exec(before);
    if (!m) { close(); return; }
    const src = sources() || {};
    const pool = m[2] === '@' ? src.agents || [] : src.channels || [];
    items = pool.filter((n) => n.startsWith(m[3]) && n !== m[3]).slice(0, 6);
    span = { start: caret - m[3].length - 1, end: caret, sigil: m[2] };
    idx = 0;
    draw();
  });
  ta.addEventListener('keydown', (e) => {
    if (list.hidden || !items.length) return;
    if (e.key === 'ArrowDown') { idx = (idx + 1) % items.length; draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { idx = (idx + items.length - 1) % items.length; draw(); e.preventDefault(); }
    else if ((e.key === 'Tab' || e.key === 'Enter') && !e.metaKey && !e.ctrlKey) { e.preventDefault(); pick(items[idx]); }
    else if (e.key === 'Escape') close();
  });
  ta.addEventListener('blur', () => setTimeout(close, 150));
  return list;
}
