// The Inbox: the one place for everything that needs me (GET /api/ach/me/inbox):
// new tasks for my agents (until claimed), decisions (decided inline), escalations, mentions of my agents, replies in my
// threads, change requests and finished tasks. Newest first, with a thin
// "since yesterday" divider instead of a summary card. Pure DOM builders.

import { h, parseDate, decideForm, choiceForm, linkedText, agoSpan, plainSnippet, tag, extLink } from './render.js';
import { avatar } from './thread.js';
import { t } from './i18n.js';

// Replies only: the Inbox holds what needs me: decision requests,
// mentions and replies (agent escalations and Memory questions are messages to
// me), tasks for me, and one daily "Memory updated" line.
const TYPES = new Set(['assigned', 'assigned_external', 'decision', 'escalation', 'mention', 'reply', 'memory_digest']);

/** The in-panel part of a permalink ("https://hub/#/t/T-1" -> "#/t/T-1"); anything else -> "". */
export function hashOf(url) {
  const s = String(url || '');
  const i = s.indexOf('#/');
  const hsh = i >= 0 ? s.slice(i) : '';
  return /^#\/[A-Za-z0-9_/@.%-]*$/.test(hsh) ? hsh : '';
}

/** Inbox items that need attention: every pending one, plus anything newer than `seen`. */
export function inboxUnread(items, seen) {
  return (items || []).filter((x) => x && (x.pending || !seen || String(x.at || '') > String(seen))).length;
}

function phrase(x) {
  if (x.type === 'assigned') return t('ib_assigned', { agent: x.to_agent_name || '?' });
  return t(`ib_${x.type}`);
}

/** One inbox row, Slack-style. o: {decide, unreadAfter} */
export function inboxItem(x, ctx, o = {}) {
  const type = TYPES.has(x.type) ? x.type : 'mention';
  const href = hashOf(x.url);
  const ext = type === 'assigned_external';
  const where = [x.channel_name ? `#${x.channel_name}` : '', x.task_ref ? `${x.task_ref} ${x.title || ''}`.trim() : ext ? String(x.title || '') : ''].filter(Boolean).join(' · ');
  const unread = !!(o.unreadAfter && String(x.at || '') > String(o.unreadAfter));
  const row = h('div', {
    class: `msg inbox-item ib-${type}` + (x.pending ? ' pending' : '') + (unread ? ' unread' : ''),
    attrs: { 'data-id': String(x.id || ''), 'data-type': type },
  },
  avatar(x.author_type === 'human' || x.author_type === 'external' ? 'human' : 'agent', x.author_name || '?'),
  h('div', { class: 'msg-main' },
    h('div', { class: 'msg-head' },
      h('span', { class: 'author', text: x.author_name || '?' }),
      h('span', { class: 'what', text: phrase({ ...x, type }) }),
      agoSpan(x.at, ctx.now)),
    ext ? h('div', { class: 'ib-ext' }, tag(x.kind === 'github_pr' ? 'PR' : 'issue'), ' ', extLink(x.ext_url, String(x.ref || '')), x.state ? [' ', tag(t(`ext_${x.state}`))] : null) : null,
    where ? h('a', { class: 'ib-ctx', href: href || '#/inbox', text: where }) : null,
    plainSnippet(x.text) && !(x.choices && x.pending) ? h('div', { class: 'ib-text' }, linkedText(plainSnippet(x.text))) : null,
    type === 'decision' && x.pending && x.task_id && x.message_id && o.decide ? decideForm(x.task_id, x.message_id, o.decide, x.choices) : null,
    // a question addressed to me in a channel (a Memory question, a decision to record): reply with a button or words
    type === 'escalation' && x.pending && x.choices && o.decide && o.decide.onReplyPost ? choiceForm(x.choices, (v) => o.decide.onReplyPost(x.post_id || x.id, v), { key: `reply:${x.id}`, drafts: o.decide.drafts }) : null));
  // the whole row opens the thread, except its own controls and links
  if (href) {
    row.classList.add('clickable');
    row.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('a, button, form, textarea, input, select, details')) return;
      window.location.hash = href;
    });
  }
  return row;
}

/**
 * Inbox pane. data: {items}. o: {decide, unreadAfter, top (an onboarding card or null)}
 */
export function inboxView(data, ctx, o = {}) {
  const items = (data && Array.isArray(data.items) ? data.items : []).filter((x) => x && typeof x === 'object');
  const dayAgo = ctx.now - 24 * 3600 * 1000;
  const rows = [];
  let section = '';
  for (const x of items) {
    const d = parseDate(x.at);
    const s = d && d.getTime() >= dayAgo ? 'recent' : 'earlier';
    if (s !== section) {
      section = s;
      rows.push(h('div', { class: 'day-sep inbox-sep', attrs: { role: 'separator' } }, h('span', { text: s === 'recent' ? t('since_yesterday') : t('earlier') })));
    }
    rows.push(inboxItem(x, ctx, o));
  }
  return h('div', { class: 'pane inbox' },
    h('div', { class: 'pane-head' }, h('h1', { class: 'pane-title', text: t('inbox') })),
    h('div', { class: 'thread-scroll' },
      h('div', { class: 'thread-inner stream' },
        o.top || null,
        rows.length ? rows : h('div', { class: 'empty-state muted', text: t('inbox_empty') }))));
}
