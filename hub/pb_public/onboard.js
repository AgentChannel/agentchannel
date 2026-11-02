// Welcome view (team onboarding from GitHub). Self-contained: app.js only
// imports this module. It shows GET /api/ach/me/welcome as a dialog the first
// time a person opens the panel after an import (once per person and browser),
// and adds "Welcome" to the user menu so it can be opened again.
// Read-only: no writes, no hub state changes.

import PocketBase from './vendor/pocketbase.es.js';
import { h, extLink, tag } from './render.js';
import { wikiHref } from './wiki.js';
import { getLang } from './i18n.js';
import { openModal } from './session.js';

const SEEN_KEY = 'ach.welcome.seen.';

const TEXT = {
  en: {
    menu: 'Welcome',
    title: 'Welcome, {name}',
    intro: 'Your team imported its GitHub work here. This is where to start.',
    channels: 'Your channels',
    assigned: 'Assigned to you, still open',
    opened: 'You opened, still open',
    none: 'Nothing open for you right now.',
    who: 'Who does what',
    agents: 'Your agents',
    close: 'Got it',
    commits: '{n} commits',
    assigned_n: '{n} assigned',
    opened_n: '{n} opened',
    more: '+{n} more',
    wiki: 'Memory',
    role: 'role',
    hint_connected: 'Your agent is connected with `ach join <line>`. Lost the line? Ask an admin: ach admin invite <agent>.',
    hint_cli: 'Connect your coding agent: ach admin create-agent --name <you>-claude --owner <you> --runtime claude --description <d> --invite, then run the printed `ach join ...` line.',
    hint_ask_admin: 'Ask an admin to connect an agent for you (optional)',
  },
  zh: {
    menu: '欢迎页',
    title: '欢迎，{name}',
    intro: '团队已经把 GitHub 上的工作导入到这里。从这里开始。',
    channels: '你的频道',
    assigned: '分给你、还没关的',
    opened: '你提的、还没解决的',
    none: '目前没有你要处理的事。',
    who: '谁负责什么',
    agents: '你的智能体',
    close: '知道了',
    commits: '{n} 次提交',
    assigned_n: '分到 {n} 件',
    opened_n: '提了 {n} 件',
    more: '还有 {n} 件',
    wiki: '记忆',
    role: '角色',
    hint_connected: '你的智能体已通过 `ach join <line>` 接入。接入命令丢了？请管理员运行：ach admin invite <agent>。',
    hint_cli: '接入你的编码智能体：ach admin create-agent --name <you>-claude --owner <you> --runtime claude --description <d> --invite，然后运行打印出的 `ach join ...` 命令。',
    hint_ask_admin: '请让管理员为你接入智能体（可选）',
  },
};

function tr(key, vars) {
  const dict = TEXT[getLang() === 'zh' ? 'zh' : 'en'];
  let s = dict[key] || TEXT.en[key] || key;
  for (const [k, v] of Object.entries(vars || {})) s = s.replace(`{${k}}`, String(v));
  return s;
}

/** "+N more": a button that expands the rest of the list in place. */
function moreButton(n, onClick) {
  return h('li', { class: 'welcome-more' }, h('button', { class: 'btn link', attrs: { type: 'button' }, text: tr('more', { n }), on: { click: (e) => { e.preventDefault(); onClick(); } } }));
}

function itemRow(x, onNav) {
  return h('li', null,
    x.url ? extLink(x.url, x.ref) : x.ref, ' ',
    x.post_id ? h('a', { href: `#/p/${x.post_id}`, text: x.title, on: { click: () => onNav && onNav() } }) : x.title,
    x.channel ? h('span', { class: 'muted', text: ` #${x.channel}` }) : null);
}

function itemList(items, total, onNav, limit = 8) {
  if (!items.length) return h('p', { class: 'muted', text: tr('none') });
  const ul = h('ul', { class: 'welcome-list' });
  const shown = items.slice(0, limit);
  for (const x of shown) ul.appendChild(itemRow(x, onNav));
  // the hub may send fewer than the total (it caps the list): count the rest
  const rest = Math.max(items.length, Number(total) || 0) - shown.length;
  if (rest > 0) {
    const more = moreButton(rest, () => {
      more.remove();
      for (const x of items.slice(limit)) ul.appendChild(itemRow(x, onNav));
    });
    ul.appendChild(more);
  }
  return ul;
}

function joinHint(d) {
  const a = d.agents || {};
  if (a.hint === 'connected' || a.hint === 'cli' || a.hint === 'ask_admin') return tr(`hint_${a.hint}`);
  return a.join_hint || '';
}

function whoPerson(p, i, onNav) {
  const counts = [p.commits ? tr('commits', { n: p.commits }) : '', p.assigned ? tr('assigned_n', { n: p.assigned }) : '', p.opened ? tr('opened_n', { n: p.opened }) : ''].filter(Boolean).join(', ');
  const role = typeof p.role === 'string' ? p.role.trim() : '';
  return [i ? ', ' : '', h('a', { href: `#/u/${p.user_id}`, text: p.name, on: { click: () => onNav && onNav() } }),
    role ? h('span', { class: 'welcome-role', text: ` · ${role}` }) : null,
    counts ? h('span', { class: 'muted', text: ` (${counts})` }) : null];
}

function channelRow(c, onClose) {
  const pages = (Array.isArray(c.wiki) ? c.wiki : []).filter((w) => w && wikiHref(w.slug) !== '#/');
  return h('li', null,
    h('a', { href: `#/c/${c.name}`, text: `#${c.name}`, on: { click: () => onClose && onClose() } }),
    c.visibility === 'private' ? [' ', tag('private')] : null,
    c.description ? h('span', { class: 'muted', text: ` ${c.description}` }) : null,
    c.my_items ? ' ' : null, c.my_items ? tag(String(c.my_items)) : null,
    pages.length ? h('div', { class: 'welcome-wiki' }, h('span', { class: 'muted', text: `${tr('wiki')}: ` }),
      pages.map((w, i) => [i ? ', ' : '', h('a', { href: wikiHref(w.slug), text: w.title || w.slug, on: { click: () => onClose && onClose() } })])) : null);
}

/** The welcome content for a /me/welcome payload (exported for tests). */
export function welcomeView(d, onClose) {
  const mine = (d.channels || []).filter((c) => c.mine || c.member);
  const who = d.who || [];
  const role = d.user && typeof d.user.role === 'string' ? d.user.role.trim() : '';
  return h('div', { class: 'welcome' },
    h('h2', { text: tr('title', { name: (d.user && d.user.name) || '' }) }),
    role ? h('p', { class: 'welcome-myrole', text: `${tr('role')}: ${role}` }) : null,
    h('p', { class: 'muted', text: tr('intro') }),
    h('h3', { text: tr('channels') }),
    h('ul', { class: 'welcome-list' }, mine.map((c) => channelRow(c, onClose))),
    h('h3', { text: tr('assigned') }),
    itemList(d.assigned_open || [], d.assigned_total, onClose),
    (d.opened_open || []).length ? h('h3', { text: tr('opened') }) : null,
    (d.opened_open || []).length ? itemList(d.opened_open, d.opened_total, onClose) : null,
    who.length ? h('h3', { text: tr('who') }) : null,
    who.length ? h('ul', { class: 'welcome-list' }, who.map((w) => h('li', null,
      h('span', { text: `#${w.channel}: ` }),
      (w.people || []).map((p, i) => whoPerson(p, i, onClose))))) : null,
    h('h3', { text: tr('agents') }),
    d.agents && d.agents.count ? h('p', { text: d.agents.list.map((a) => a.name).join(', ') }) : null,
    h('p', { class: 'muted welcome-hint', text: joinHint(d) }),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn primary', attrs: { type: 'button' }, text: tr('close'), on: { click: () => onClose && onClose() } })));
}

/** Where a first visit lands: the person's main channel (only a well-formed name). */
export function landingHash(d) {
  const n = d && typeof d.main_channel === 'string' ? d.main_channel : '';
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(n) ? `#/c/${n}` : '';
}

let pb = null;
function client() {
  if (!pb) pb = new PocketBase(window.location.origin);
  return pb;
}

async function fetchWelcome() {
  const c = client();
  return c.send('/api/ach/me/welcome', { method: 'GET', requestKey: null });
}

export async function showWelcome() {
  let d;
  try {
    d = await fetchWelcome();
  } catch (_) {
    return false;
  }
  let close = null;
  close = openModal(welcomeView(d, () => close && close()), { label: tr('menu') });
  return true;
}

// The first visit after an import lands on the person's main channel. app.js
// asks firstLanding() BEFORE it applies its default route (#/ -> #/c/general),
// so the router never overwrites the welcome's choice. A specific link the
// person opened (anything but #/, #/inbox or a login link) always wins.
let landing = null; // { uid, promise }
let welcomeCache = null; // { uid, d }
function uidOf(c) { return c.authStore.isValid && c.authStore.record ? c.authStore.record.id : ''; }
function seen(uid) {
  try { return !!localStorage.getItem(SEEN_KEY + uid); } catch (_) { return true; }
}

/** '#/c/<main>' for a first visit (welcome not seen yet, show: true), else ''. */
export function firstLanding() {
  const c = client();
  const uid = uidOf(c);
  if (!uid || seen(uid)) return Promise.resolve('');
  if (!landing || landing.uid !== uid) {
    landing = {
      uid,
      promise: fetchWelcome().then((d) => {
        welcomeCache = { uid, d };
        return d && d.show ? landingHash(d) : '';
      }).catch(() => ''),
    };
  }
  return landing.promise;
}

/** Only these hashes may be replaced by the first-visit landing. */
export function replaceableHash(h) {
  const cur = String(h || '');
  return cur === '' || cur === '#' || cur === '#/' || cur === '#/inbox' || cur.startsWith('#/login');
}

let checkedFor = '';
async function firstVisit() {
  const c = client();
  const uid = uidOf(c);
  if (!uid || checkedFor === uid) return;
  checkedFor = uid;
  if (seen(uid)) return;
  let d;
  try {
    if (welcomeCache && welcomeCache.uid === uid) d = welcomeCache.d;
    else { await firstLanding(); d = welcomeCache && welcomeCache.uid === uid ? welcomeCache.d : await fetchWelcome(); }
  } catch (_) {
    return;
  }
  if (!d || !d.show) return;
  try { localStorage.setItem(SEEN_KEY + uid, '1'); } catch (_) { /* ignore */ }
  // normally app.js already landed there (firstLanding); this covers a panel
  // that routed before the welcome answered
  const land = landingHash(d);
  if (land && replaceableHash(window.location.hash)) window.location.hash = land;
  let close = null;
  close = openModal(welcomeView(d, () => close && close()), { label: tr('menu') });
}

function addMenuItem() {
  const menu = document.querySelector('details.usermenu .menu');
  if (!menu || menu.querySelector('.menu-welcome')) return;
  const item = h('button', { class: 'menu-item menu-welcome', attrs: { type: 'button' }, text: tr('menu'), on: { click: () => { const d = menu.closest('details'); if (d) d.open = false; showWelcome(); } } });
  const sep = menu.querySelector('.menu-sep');
  menu.insertBefore(item, sep || null);
  firstVisit();
}

function init() {
  const MO = (typeof window !== 'undefined' && window.MutationObserver) || globalThis.MutationObserver;
  if (!MO || !document.body) return;
  new MO(addMenuItem).observe(document.body, { childList: true, subtree: true });
  addMenuItem();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
