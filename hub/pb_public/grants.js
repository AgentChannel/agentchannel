// "My authorizations": grants I gave (to agents and people) and
// grants given to me, each with grantee, scope, used / remaining money, time
// left and one-click revoke, plus a daily digest of the decisions made under it.
// Any decision made under a grant can be overridden by replying to it (the
// task thread). Pure DOM builders.

import { h, tag, linkedText } from './render.js';
import { t } from './i18n.js';

function money(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** One grant row. o: {onRevoke(id) -> Promise} (grants I gave). */
export function grantRow(g, o = {}) {
  const err = h('div', { class: 'error' });
  const status = String(g.status || 'active');
  const revoke = o.onRevoke && status === 'active'
    ? h('button', {
      class: 'btn grant-revoke', attrs: { type: 'button', 'data-id': String(g.id) }, text: t('grant_revoke'),
      on: { click: async (e) => { e.target.disabled = true; try { await o.onRevoke(String(g.id)); } catch (x) { err.textContent = `${t('error')}: ${String(x && x.message || x)}`; e.target.disabled = false; } } },
    })
    : null;
  const digest = Array.isArray(g.digest) ? g.digest : [];
  return h('li', { class: `grant grant-${status}`, attrs: { 'data-id': String(g.id) } },
    h('div', { class: 'grant-head' },
      h('strong', { text: o.given ? String(g.grantee_name || '?') : String(g.grantor_name || '?') }),
      ' ', tag(t(`grant_status_${status}`)),
      ' ', h('span', { class: 'muted', text: t('grant_scope', { scope: String(g.scope_name || '') }) }),
      revoke),
    h('div', { class: 'grant-meta muted' },
      h('span', { class: 'grant-money', text: t('grant_used', { used: money(g.used), cap: money(g.money_cap) }) }),
      g.hours_left !== null && g.hours_left !== undefined && status === 'active' ? [' · ', h('span', { class: 'grant-left', text: t('grant_left', { h: String(g.hours_left) }) })] : null,
      g.requester_name ? [' · ', h('span', { text: t('grant_only_from', { who: String(g.requester_name) }) })] : null),
    g.guidance ? h('div', { class: 'grant-guidance', text: String(g.guidance) }) : null,
    digest.length ? h('details', { class: 'grant-digest' },
      h('summary', { text: `${t('grant_digest')} (${digest.reduce((n, d) => n + (Number(d.count) || 0), 0)})` }),
      h('ul', null, digest.map((d) => h('li', null, h('span', { class: 'muted', text: `${d.day} · ${d.count} ` }),
        (Array.isArray(d.lines) ? d.lines : []).map((l) => h('div', { class: 'grant-line' }, l.url ? h('a', { href: l.url.slice(l.url.indexOf('#/')), text: String(l.text || '') }) : linkedText(String(l.text || '')))))))) : null,
    err);
}

/** The "My authorizations" pane. data: {given, received}. o: {onRevoke} */
export function grantsView(data, ctx, o = {}) {
  const given = Array.isArray(data && data.given) ? data.given : [];
  const received = Array.isArray(data && data.received) ? data.received : [];
  const section = (title, list, opts) => h('section', { class: 'grants-section' },
    h('h2', { text: `${title} (${list.length})` }),
    list.length ? h('ul', { class: 'grants-list' }, list.map((g) => grantRow(g, opts))) : null);
  return h('div', { class: 'pane grants' },
    h('div', { class: 'pane-head' }, h('h1', { class: 'pane-title', text: t('grants') })),
    h('div', { class: 'thread-scroll' }, h('div', { class: 'thread-inner' },
      !given.length && !received.length ? h('div', { class: 'empty-state muted', text: t('grants_none') }) : null,
      given.length ? section(t('grants_given'), given, { given: true, onRevoke: o.onRevoke }) : null,
      received.length ? section(t('grants_received'), received, { given: false }) : null)));
}
