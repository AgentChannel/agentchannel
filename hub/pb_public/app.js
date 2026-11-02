// AgentChannel panel. Static ES module, no build step.
// An ultra-light Slack: there is only one thing, a message. The sidebar has
// exactly three sections (Inbox, # channels, people & agents); the middle is
// always a stream (a channel, the Inbox, or one agent's/person's messages and
// tasks); any message opens its thread in a right pane (a slide-over on narrow
// screens) without replacing the middle. A task is a message with a ▣ marker
// and one plain status line. Settings sit behind the user menu.
// Every object has a permalink: #/c/<name>, #/p/<id>, #/t/T-<seq>[@v<n>][/m/<id>],
// #/a/<name>, #/u/<id>, #/f/<collection>/<record>/<file>; opening one scrolls to
// the item and highlights it. Reads collections through the PocketBase SDK as a
// logged-in user; all writes go through /api/ach/* custom routes.

import PocketBase from './vendor/pocketbase.es.js';
import { t, getLang, setLang, adoptLang } from './i18n.js';
import {
  h, money, ago, errText, errCode, linkErrText, TERMINAL, taskHref, setEmbedHosts, setAvatars,
  setLinkContext, withIssueBase, issueBaseOf, tag, tickTimes, optionReply,
} from './render.js';
import {
  channelRows, channelSection, channelView, threadView, postItem, searchView, dmView, taskAsPost,
  channelsAdminView, attachAutocomplete, copyLink, channelHref, channelLabel, footer,
} from './channels.js';
import { personRow, isOnline, taskHead, handoffCard, timeline, composer, initials } from './thread.js';
import { inboxView, inboxUnread } from './inbox.js';
import { inboxTabs, updatesList, updatesUnread, notifySettings, channelBell, followToggle, announceToggle, startRealtime, localZone } from './notify.js';
import { grantsView } from './grants.js';
import { wikiIndexView, wikiPageView, wikiHistoryView, decisionLogView, zipStore, memoryMetricsView } from './wiki.js';
import { firstLanding, replaceableHash } from './onboard.js';
import { DEFAULT_LIMITS, fileUrl, openLightbox } from './media.js';
import { setStorageConfig, effectiveLimits, directUploads, storageDetailView } from './storage.js';
import { settingsTabs, copyBox, peopleView, loginUrl, loginTokenOf, deactivateDialog, importView } from './admin.js';
import { openModal, deviceLinkView, isWeChat, wechatHint, shareSheet as shareSheetEl, agentInviteSheet } from './session.js';
import './setup.js'; // first-run setup link + admin deployment check (deploy/)

const pb = new PocketBase(window.location.origin);
pb.autoCancellation(false);

const POLL_MS = 5000;
const SAFETY_POLL_MS = 30000; // with SSE or long poll working, polling is only a safety net
const UPD_SEEN_KEY = 'ach.updseen'; // newest Updates item seen
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const CH_SEEN_KEY = 'ach.chseen';
const INBOX_SEEN_KEY = 'ach.inboxseen';
const LAST_KEY = 'ach.last'; // the last middle stream visited (a hash)
const SEEN_DR_KEY = 'ach.seendr'; // decision request ids already seen in the Inbox
const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const THEME_KEY = 'ach.theme';
const FILE_TOKEN_MS = 60 * 1000;
const LOGIN_HASH_RE = /^#\/login\/(ach_lt_[A-Za-z0-9]{40})$/;
const ONBOARD_KEY = 'ach.onboard.dismissed';
const WECHAT_KEY = 'ach.wechat.dismissed';
const OLDER_PAGE = 50;
const TICK_MS = 60 * 1000; // relative times ("5 min ago") refresh once a minute
const DAY_MS = 24 * 3600 * 1000;
// Inbox items that stay pending until acted on and send the landing to the Inbox while unseen.
const LANDING_TYPES = new Set(['decision', 'assigned']);

const state = {
  pick: null, // {id, option}: a notification link's preselected option
  agents: new Map(), // id -> agent record
  users: new Map(), // id -> user record
  drafts: new Map(), // textarea drafts survive re-render
  files: new Map(), // composer key -> pending File[]
  openKeys: new Map(), // <details data-key> open state survives re-render
  limits: { ...DEFAULT_LIMITS },
  fileToken: { value: '', at: 0 },
  sideSig: '',
  topSig: '',
  mainSig: '',
  threadSig: '',
  busy: false, // an upload is running: don't rebuild the panes
  oneTimeKey: null, // {name, key, invite}; kept in memory only until dismissed
  oneTimeLink: null, // {name, url}: a person's one-time login link, until dismissed
  people: [], // admin: GET /admin/users
  authConfig: null, // {cf, otp}
  shell: null,
  composerForm: null, // the middle pane's composer (drag & drop target)
  threadComposer: null, // the thread pane's composer
  pollTimer: null,
  unsub: [],
  channels: [], // GET /channels (not archived)
  chSeen: null, // {channelId: last_post_at seen}
  inbox: { items: [] }, // GET /me/inbox
  inboxSeen: null, // newest inbox item time seen (ISO-ish string)
  inboxDivider: null, // inboxSeen when this visit to the Inbox started
  embedHosts: [],
  focused: '', // the permalink whose item was scrolled to and highlighted
  adminChannels: null, // {channels, embedHosts, storage} on the admin page
  meInfo: null, // GET /me (user): {has_agents, is_admin, limits, ...}
  workspace: '', // hub setting workspace_name (F13)
  notice: null, // {key, text}: "notified X" after a send (F5)
  older: new Map(), // channel name -> older posts loaded with "Load older" (oldest first)
  noMore: new Set(), // channels with nothing older
  divider: new Map(), // channel name -> last_post_at seen before this visit (unread divider)
  hideBots: false, // F2: Search excludes quiet agents (exclude_bots=1)
  postAuthors: new Map(), // post id -> author name, for in-app link chips
  sessionMsg: '', // shown on the login screen after a bounce
  middle: null, // {route, hash}: the stream in the middle (kept while a thread is open)
  threadChannel: '', // the open thread's channel (the middle when nothing else was open)
  rcMode: new Set(), // finished tasks whose composer is in "request changes" mode
  costWeek: null, // GET /panel cost (settings only)
  seenDr: null, // Set of decision request ids seen in the Inbox
  toMode: new Map(), // task id -> 'worker' | 'requester': who the worker owner's composer reaches
  scrollPos: new Map(), // middle hash -> {top, atBottom}: scroll position kept per stream
  tickTimer: null,
  notify: { items: [], prefs: null }, // GET /me/notifications (the Inbox "Updates" tab)
  hooks: null, // GET /hooks while the Updates tab is open
  updSeen: null, // newest Updates item seen
  announceNext: false, // the channel composer's "Announce" toggle
  rtStop: null, // stops the realtime fallback loop
  rtMode: '', // sse | longpoll | poll
  tzSent: false,
};

const root = document.getElementById('app');
// index.html shows a neutral placeholder; say "loading" in the reader's language
if (root && !root.querySelector('.shell, .login-wrap')) root.replaceChildren(h('p', { class: 'muted pad', text: t('loading') }));

// ---------- small storage helpers (storage may be blocked) ----------

// this page's own storage (bound once: a late async step never writes into another page's)
const store = (() => { try { return globalThis.localStorage || null; } catch (_) { return null; } })();
function load(key) { try { return store && store.getItem(key); } catch (_) { return null; } }
function save(key, v) { try { if (store) store.setItem(key, v); } catch (_) { /* ignore */ } }

/** Dark follows the system (prefers-color-scheme) until the person picks a theme. */
function systemDark() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (_) { return false; }
}
function isDark() {
  const v = load(THEME_KEY);
  return v === 'dark' || v === 'light' ? v === 'dark' : systemDark();
}
function applyTheme() {
  const dark = isDark();
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.classList.toggle('light', !dark);
}

function loadChSeen() {
  if (state.chSeen) return state.chSeen;
  try { const v = JSON.parse(load(CH_SEEN_KEY) || 'null'); state.chSeen = v && typeof v === 'object' ? v : null; } catch (_) { state.chSeen = null; }
  return state.chSeen;
}
function markChannelSeen(c) {
  loadChSeen();
  if (!state.chSeen) state.chSeen = {};
  const at = String(c.last_post_at || '');
  if (at && state.chSeen[c.id] !== at) { state.chSeen[c.id] = at; save(CH_SEEN_KEY, JSON.stringify(state.chSeen)); state.sideSig = ''; }
}

// ---------- API ----------

function api(path, method = 'GET', body) {
  const opts = { method };
  if (body !== undefined) opts.body = body;
  return pb.send(`/api/ach${path}`, opts);
}

/** Multipart POST with upload progress (fetch has none). */
function upload(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/ach${path}`);
    x.setRequestHeader('Authorization', pb.authStore.token);
    if (x.upload && onProgress) x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let data = null;
      try { data = JSON.parse(x.responseText || 'null'); } catch (_) { /* not json */ }
      if (x.status >= 200 && x.status < 300) resolve(data);
      else {
        const err = new Error((data && (data.error || data.message)) || `HTTP ${x.status}`);
        err.status = x.status;
        err.response = data && typeof data === 'object' ? data : {};
        reject(err);
      }
    };
    x.onerror = () => { const err = new Error('network error'); err.status = 0; reject(err); };
    x.send(form);
  });
}

async function fileToken(force) {
  const now = Date.now();
  if (!force && state.fileToken.value && now - state.fileToken.at < FILE_TOKEN_MS) return state.fileToken.value;
  try {
    state.fileToken = { value: await pb.files.getToken(), at: now };
  } catch (_) { /* media falls back to failing loads; text still shows */ }
  return state.fileToken.value;
}

function me() { return pb.authStore.record || pb.authStore.model || null; }
function isAdmin() { const u = me(); return !!(u && u.is_admin); }
/** F11: [manage agents] only for people who own an agent or are admins. */
function ownsAgents() {
  const u = me();
  if (!u) return false;
  if (state.meInfo && typeof state.meInfo.has_agents === 'boolean' && state.meInfo.has_agents) return true;
  return [...state.agents.values()].some((a) => a.owner === u.id);
}
/** JSON with sorted object keys: the hub's map order varies between responses. */
function stableJson(v) {
  return JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
}
function invalidate() { state.sideSig = ''; state.mainSig = ''; state.threadSig = ''; }

const ctx = {
  now: Date.now(),
  agentName: (id) => (id && state.agents.get(id)?.name) || (id ? String(id).slice(0, 8) : '?'),
  agentRuntime: (id) => (id && state.agents.get(id)?.runtime) || '',
  userName: (id) => {
    const u = id && state.users.get(id);
    return (u && (u.name || u.email)) || (id ? String(id).slice(0, 8) : '');
  },
};

async function loadDirectory() {
  try {
    const agents = await pb.collection('agents').getFullList({ batch: 500 });
    state.agents = new Map(agents.map((a) => [a.id, a]));
  } catch (_) { /* keep previous */ }
  try {
    const users = await pb.collection('users').getFullList({ batch: 500, fields: 'id,name,email,is_admin' });
    state.users = new Map(users.map((u) => [u.id, u]));
  } catch (_) { /* keep previous */ }
}

async function loadChannels() {
  try {
    const list = await api('/channels');
    if (Array.isArray(list)) state.channels = list;
  } catch (_) { /* keep previous */ }
  if (!loadChSeen()) {
    state.chSeen = {};
    for (const c of state.channels) state.chSeen[c.id] = String(c.last_post_at || '');
    save(CH_SEEN_KEY, JSON.stringify(state.chSeen));
  }
}

async function loadSettings() {
  // avatars: hub-cached pictures (fetched alongside the settings)
  const av = api('/avatars').catch(() => null);
  try {
    const s = await api('/settings');
    state.embedHosts = Array.isArray(s && s.embed_hosts) ? s.embed_hosts : [];
    setEmbedHosts(state.embedHosts);
    const ws = s && (s.workspace_name || s.workspace);
    state.workspace = typeof ws === 'string' ? ws.slice(0, 80) : '';
    const pub = s && (s.public_url || s.ach_public_url);
    setLinkContext({ origins: typeof pub === 'string' && pub ? [pub] : [], label: chipLabel });
  } catch (_) { setLinkContext({ origins: [], label: chipLabel }); }
  setAvatars(await av);
}

/** In-app chip text for links pasted into posts ("post by alice-agent", a person's name). */
function chipLabel(hash) {
  let m = /^#\/p\/([A-Za-z0-9_-]{1,64})$/.exec(hash);
  if (m && state.postAuthors.has(m[1])) return t('chip_post_by', { name: state.postAuthors.get(m[1]) });
  m = /^#\/u\/([A-Za-z0-9_-]{1,64})$/.exec(hash);
  if (m && state.users.has(m[1])) return ctx.userName(m[1]);
  return '';
}
/** Flag posts by quiet agents (agents.quiet, set by the owner) for the stream's collapse. */
function markQuiet(posts) {
  for (const p of posts || []) {
    if (p && p.author_type === 'agent' && p.author_quiet === undefined) {
      const a = state.agents.get(p.author_agent);
      p.author_quiet = !!(a && a.quiet);
    }
  }
}

function rememberAuthors(posts) {
  for (const p of posts || []) if (p && p.id && p.author_name && state.postAuthors.size < 5000) state.postAuthors.set(p.id, p.author_name);
}

async function loadLimits() {
  try {
    const r = await api('/me');
    if (r && typeof r === 'object') state.meInfo = r;
    // the account's language (users.lang) wins when the person set one
    if (r && r.lang_set && adoptLang(r.lang, true)) {
      document.documentElement.lang = getLang() === 'zh' ? 'zh-CN' : 'en';
      if (state.shell) buildShell();
    }
    if (r && r.limits && typeof r.limits === 'object') state.limits = { ...DEFAULT_LIMITS, ...r.limits };
  } catch (_) { /* defaults */ }
  // direct upload to the bucket and link-preview hosts
  try { setStorageConfig(await api('/storage/config')); } catch (_) { /* older hub: off */ }
}


async function loadInbox() {
  try {
    const r = await api('/me/inbox');
    if (r && Array.isArray(r.items)) state.inbox = { items: r.items.filter((x) => x && typeof x === 'object') };
  } catch (e) {
    if (e && (e.status === 401 || (e.status === 403 && errCode(e) === 'deactivated'))) throw e;
  }
  if (state.inboxSeen === null) {
    const stored = load(INBOX_SEEN_KEY);
    if (stored !== null && stored !== undefined) state.inboxSeen = String(stored);
    else {
      // first visit: the last 24 hours count as new (pending items always count)
      state.inboxSeen = new Date(Date.now() - DAY_MS).toISOString().replace('T', ' ');
      save(INBOX_SEEN_KEY, state.inboxSeen);
    }
  }
}
async function loadNotifications() {
  try {
    const r = await api('/me/notifications');
    if (r && Array.isArray(r.items)) state.notify = { items: r.items.filter((x) => x && typeof x === 'object'), prefs: r.prefs || null };
  } catch (_) { /* keep the last list */ }
  if (state.updSeen === null) state.updSeen = String(load(UPD_SEEN_KEY) || new Date(Date.now() - DAY_MS).toISOString().replace('T', ' '));
  // the digest goes out at the person's local time: tell the hub this browser's zone once
  const p = state.notify.prefs;
  if (p && !p.tz && !state.tzSent) { state.tzSent = true; api('/me/notify-prefs', 'PUT', localZone()).catch(() => {}); }
}
function newestAt(items) {
  return (items || []).reduce((m, x) => (String(x.at || '') > m ? String(x.at || '') : m), '');
}
/** Decisions seen in the Inbox (landing goes to the Inbox while one is unseen). */
function seenDecisions() {
  if (!state.seenDr) {
    try { const v = JSON.parse(load(SEEN_DR_KEY) || '[]'); state.seenDr = new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []); } catch (_) { state.seenDr = new Set(); }
  }
  return state.seenDr;
}
function markInboxSeen() {
  const dr = seenDecisions();
  const pending = state.inbox.items.filter((x) => LANDING_TYPES.has(x.type) && x.pending).map((x) => String(x.id));
  if (pending.some((id) => !dr.has(id))) {
    state.seenDr = new Set(pending); // only open ones are worth remembering
    save(SEEN_DR_KEY, JSON.stringify([...state.seenDr].slice(0, 200)));
  }
  const at = newestAt(state.inbox.items);
  if (at > String(state.inboxSeen || '')) { state.inboxSeen = at; save(INBOX_SEEN_KEY, at); state.sideSig = ''; }
}

// ---------- shell ----------

function dropTarget(el, get) {
  el.addEventListener('dragover', (e) => {
    if (!get()) return;
    e.preventDefault();
    el.classList.add('dragging');
  });
  el.addEventListener('dragleave', (e) => { if (e.target === el) el.classList.remove('dragging'); });
  el.addEventListener('drop', (e) => {
    el.classList.remove('dragging');
    const form = get();
    if (!form || !e.dataTransfer) return;
    e.preventDefault();
    form.addFiles(e.dataTransfer.files || []);
  });
}

function buildShell() {
  const top = h('header', { class: 'topbar' });
  const side = h('aside', { class: 'sidebar', attrs: { 'aria-label': t('channels') } });
  const scrim = h('div', { class: 'scrim', on: { click: () => setDrawer(false) } });
  const main = h('main', { class: 'main' });
  const thread = h('aside', { class: 'threadpane', attrs: { 'aria-label': t('thread_title') } });
  // drag & drop anywhere on a pane attaches to that pane's composer
  dropTarget(main, () => state.composerForm);
  dropTarget(thread, () => state.threadComposer);
  const banner = isWeChat() && load(WECHAT_KEY) !== '1'
    ? wechatHint(() => { save(WECHAT_KEY, '1'); banner.remove(); }) : null;
  const shell = h('div', { class: 'shell' }, top, banner, h('div', { class: 'layout' }, side, scrim, main, thread));
  state.shell = { el: shell, top, side, scrim, main, thread };
  state.sideSig = ''; state.mainSig = ''; state.threadSig = ''; state.topSig = '';
  root.replaceChildren(shell);
}

/**
 * F1 mobile drawer. The panel itself and the scrim each get an `open` class
 * (the shell keeps `drawer-open` for styling hooks), so the sidebar's
 * visibility never depends on a descendant selector plus transform alone.
 */
function setDrawer(open) {
  if (!state.shell) return;
  const on = !!open;
  state.shell.el.classList.toggle('drawer-open', on);
  state.shell.side.classList.toggle('open', on);
  state.shell.scrim.classList.toggle('open', on);
  const btn = state.shell.top.querySelector('.menu-btn');
  if (btn) btn.setAttribute('aria-expanded', on ? 'true' : 'false');
}
function drawerOpen() { return !!(state.shell && state.shell.side.classList.contains('open')); }

/** The thread pane: beside the stream on wide screens, a slide-over on narrow ones. */
function setThreadOpen(open) {
  if (!state.shell) return;
  state.shell.thread.classList.toggle('open', !!open);
  state.shell.el.classList.toggle('thread-open', !!open);
  if (!open) {
    if (state.shell.thread.childNodes.length) state.shell.thread.replaceChildren();
    state.threadSig = '';
    state.threadComposer = null;
  }
}
function closeThread() {
  window.location.hash = (state.middle && state.middle.hash) || '#/inbox';
}
function closeBtn() {
  return h('button', { class: 'icon-btn th-close', attrs: { type: 'button', 'aria-label': t('close_thread'), title: t('close_thread') }, text: '×', on: { click: closeThread } });
}

/** Top bar: the drawer button (narrow screens), search, and the gear / user menu. Nothing else. */
function topBar() {
  const u = me();
  const settingsHref = isAdmin() ? '#/admin/people' : '#/agents';
  return [
    h('button', { class: 'icon-btn menu-btn', attrs: { type: 'button', 'aria-label': t('menu'), 'aria-expanded': drawerOpen() ? 'true' : 'false' }, text: '≡', on: { click: () => setDrawer(!drawerOpen()) } }),
    searchBox(),
    h('span', { class: 'spacer' }),
    u ? h('details', { class: 'usermenu' },
      h('summary', { attrs: { 'aria-label': t('settings'), title: t('settings') } },
        h('span', { class: 'avatar human sm', text: initials(u.name || u.email || '?') }),
        h('span', { class: 'gear', attrs: { 'aria-hidden': 'true' }, text: '⚙' })),
      h('div', { class: 'menu' },
        h('div', { class: 'menu-who', text: (u.name || u.email || '') + (u.is_admin ? ` · ${t('admin')}` : '') }),
        ownsAgents() || u.is_admin ? h('a', { class: 'menu-item', href: settingsHref, text: t('settings') }) : null,
        h('button', { class: 'menu-item', attrs: { type: 'button' }, text: t('device_login'), on: { click: showDeviceLink } }),
        h('button', { class: 'menu-item menu-lang', attrs: { type: 'button' }, text: t('lang_toggle'), on: { click: toggleLang } }),
        h('button', { class: 'menu-item', attrs: { type: 'button' }, text: isDark() ? t('theme_light') : t('theme_dark'), on: { click: toggleTheme } }),
        h('div', { class: 'menu-sep' }),
        h('button', { class: 'menu-item', attrs: { type: 'button' }, text: t('logout'), on: { click: () => logout() } }),
        h('button', { class: 'menu-item', attrs: { type: 'button' }, text: t('logout_everywhere'), on: { click: () => { if (window.confirm(t('logout_everywhere_confirm'))) logout({ everywhere: true }); } } }))) : null,
  ];
}

/** Global search (top bar). Searches posts, tasks, handoffs, messages and file names. */
function searchBox() {
  const r = currentRoute();
  const input = h('input', { class: 'search-input', attrs: { type: 'search', placeholder: t('search_placeholder'), 'aria-label': t('search'), value: r.name === 'search' ? r.q : '', maxlength: 200 } });
  return h('form', {
    class: 'search-form', attrs: { role: 'search' },
    on: { submit: (e) => { e.preventDefault(); const q = input.value.trim(); if (q) window.location.hash = `#/search/${encodeURIComponent(q)}`; } },
  }, input);
}

/** People and agents, DM-like: agents and people mixed, by name. */
function peopleList() {
  const u = me();
  const list = [
    ...[...state.agents.values()].map((a) => ({ kind: 'agent', id: a.id, name: a.name, online: isOnline(a, ctx.now), inactive: a.active === false, description: a.description || '' })),
    ...[...state.users.values()].filter((x) => !u || x.id !== u.id).map((x) => ({ kind: 'human', id: x.id, name: x.name || x.email || x.id })),
  ];
  return list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Sidebar: exactly three sections: Inbox, # channels, people & agents. */
function sidebar(mid) {
  const n = inboxUnread(state.inbox.items, state.inboxSeen);
  const chSeen = loadChSeen();
  const people = peopleList();
  const activePerson = mid && mid.name === 'agent' ? `agent:${mid.id}` : mid && mid.name === 'user' ? `human:${mid.id}` : '';
  return [
    h('div', { class: 'side-brand' }, h('span', { class: 'hash', text: '#' }), h('span', { class: 'ws', text: state.workspace || t('app') })),
    h('a', { class: 'side-row inbox-row' + (mid && mid.name === 'inbox' ? ' active' : '') + (n ? ' unread' : ''), href: '#/inbox' },
      h('span', { class: 'side-title', text: t('inbox') }),
      n ? h('span', { class: 'side-count', text: String(n) }) : null,
      n ? h('span', { class: 'dot on', attrs: { 'aria-hidden': 'true' } }) : null),
    h('a', { class: 'side-row grants-row' + (mid && mid.name === 'grants' ? ' active' : ''), href: '#/grants' }, h('span', { class: 'side-title', text: t('grants') })),
    h('div', { class: 'side-head' }, h('span', { text: t('channels') }),
      isAdmin() ? h('a', { class: 'side-add', href: '#/admin/channels', attrs: { title: t('create_channel'), 'aria-label': t('create_channel') }, text: '+' }) : null),
    h('div', { class: 'side-section channels' }, channelSection(state.channels, {
      seen: chSeen, active: mid && mid.name === 'channel' ? mid.channel : '',
      moreOpen: load('ach.side.more') === '1', onMoreToggle: (open) => save('ach.side.more', open ? '1' : '0'),
    })),
    people.length ? h('div', { class: 'side-head' }, h('span', { text: t('people_agents') })) : null,
    people.length ? h('div', { class: 'side-section people' },
      people.map((p) => personRow(p, { active: activePerson === `${p.kind}:${p.kind === 'agent' ? p.name : p.id}` }))) : null,
  ];
}

function toggleLang() {
  setLang(getLang() === 'zh' ? 'en' : 'zh');
  document.documentElement.lang = getLang() === 'zh' ? 'zh-CN' : 'en';
  // B12: notifications follow the person's language (users.lang)
  api('/me', 'PATCH', { lang: getLang() }).catch(() => {});
  buildShell();
  refresh();
}

/** F9: a 5-minute single-use login link for myself, as a QR code + copyable link. */
async function showDeviceLink() {
  const menu = state.shell && state.shell.top.querySelector('details.usermenu');
  if (menu) menu.open = false;
  let content;
  try {
    const r = await api('/auth/device-link', 'POST', {});
    content = deviceLinkView(r || {});
  } catch (e) {
    content = h('div', { class: 'device-link' }, h('h2', { text: t('device_login') }), h('div', { class: 'error', text: `${t('error')}: ${errText(e)}` }));
  }
  let close = null;
  close = openModal(h('div', null, content, h('div', { class: 'btns' }, h('button', { class: 'btn', attrs: { type: 'button' }, text: t('close'), on: { click: () => close && close() } }))), { label: t('device_login') });
}

function toggleTheme() {
  save(THEME_KEY, isDark() ? 'light' : 'dark');
  applyTheme();
  state.topSig = '';
  refresh();
}

/** Replace a pane's content, keeping focus/caret in drafts, <details> state and scroll. */
function swapInto(el, nodes, opts = {}) {
  for (const d of el.querySelectorAll('details[data-key]')) state.openKeys.set(d.getAttribute('data-key'), d.open);
  for (const k of opts.resetKeys || []) state.openKeys.delete(k);
  const active = document.activeElement;
  const key = active && el.contains(active) && active.getAttribute && active.getAttribute('data-draft');
  const sel = key ? [active.selectionStart, active.selectionEnd] : null;
  const oldScroll = el.querySelector('.thread-scroll');
  const nearBottom = oldScroll ? oldScroll.scrollHeight - oldScroll.scrollTop - oldScroll.clientHeight < 80 : true;
  const top = oldScroll ? oldScroll.scrollTop : 0;
  el.replaceChildren(...[].concat(nodes).filter(Boolean));
  for (const d of el.querySelectorAll('details[data-key]')) {
    const k = d.getAttribute('data-key');
    if (state.openKeys.has(k)) d.open = state.openKeys.get(k);
  }
  if (key) {
    const again = [...el.querySelectorAll('[data-draft]')].find((x) => x.getAttribute('data-draft') === key);
    if (again) { again.focus(); try { again.setSelectionRange(sel[0], sel[1]); } catch (_) { /* ignore */ } }
  }
  const sc = el.querySelector('.thread-scroll');
  if (!sc) return;
  // back to a stream visited before: where the person left it (unless they were at the bottom)
  if (opts.restore && !opts.restore.atBottom && !opts.keepTop) { sc.scrollTop = opts.restore.top; return; }
  sc.scrollTop = opts.keepTop || opts.top ? 0 : opts.sameThread && !nearBottom ? top : sc.scrollHeight;
}
function swapMain(nodes, opts) { swapInto(state.shell.main, nodes, opts); }
function swapThread(nodes, opts) { swapInto(state.shell.thread, nodes, opts); }

// ---------- login (no passwords for people) ----------

const LAST_USER_KEY = 'ach.lastuser';

/**
 * Exchange a one-time login link token for a session (POST, never a GET with the
 * token). The link is only peeked at first (POST /auth/link/peek, not
 * used), so declining never burns it. F9: when someone is already logged in
 * here and the link is another person's, ask "Switch to X?". Login CSRF: when
 * nobody is logged in and the link is for another identity than the last one
 * used in this browser, ask "Log in as X?". On "no" nothing changes.
 * Returns false when the person declined.
 */
async function exchangeLink(token) {
  const prev = pb.authStore.isValid ? { token: pb.authStore.token, record: me() } : null;
  const nameOf = (u) => (u && (u.name || u.email)) || '?';
  let next = null;
  try {
    const p = await pb.send('/api/ach/auth/link/peek', { method: 'POST', body: { token } });
    next = p && p.user;
  } catch (e) {
    if (!e || e.status !== 404) throw e; // an older hub without peek: exchange directly
  }
  if (next && prev && prev.record && next.id !== prev.record.id) {
    if (!window.confirm(t('switch_account', { me: nameOf(prev.record), name: nameOf(next) }))) return false;
  } else if (next && !prev) {
    const last = load(LAST_USER_KEY);
    if (last && last !== next.id && !window.confirm(t('login_as', { name: nameOf(next) }))) return false;
  }
  const r = await pb.send('/api/ach/auth/link', { method: 'POST', body: { token } });
  pb.authStore.save(r.token, r.record);
  return true;
}

async function loadAuthConfig() {
  if (state.authConfig) return state.authConfig;
  try {
    const c = await pb.send('/api/ach/auth/config', { method: 'GET' });
    state.authConfig = { cf: !!(c && c.cf), otp: !!(c && c.otp), feishu_bot: !!(c && c.feishu_bot) };
    // a first visit (no language picked on this device) follows the hub's default
    if (c && adoptLang(c.default_lang, false)) document.documentElement.lang = getLang() === 'zh' ? 'zh-CN' : 'en';
  } catch (_) { state.authConfig = { cf: false, otp: false }; }
  return state.authConfig;
}

function showLogin(errMsg) {
  stop();
  state.shell = null;
  root.replaceChildren(loginView(errMsg || state.sessionMsg));
}

function loginView(errMsg) {
  const cfg = state.authConfig || { cf: false, otp: false };
  const err = h('div', { class: 'error', attrs: { role: 'alert' }, text: errMsg || '' });
  const info = h('div', { class: 'muted' });
  const fail = (ex) => { info.textContent = ''; err.textContent = `${t('login_failed')}: ${errText(ex)}`; };

  const pasted = h('input', { attrs: { type: 'text', autocomplete: 'off', 'aria-label': t('login_paste'), placeholder: t('login_paste'), name: 'link' } });
  const linkForm = h('form', {
    class: 'login',
    on: {
      submit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const tok = loginTokenOf(pasted.value);
        if (!tok) { err.textContent = t('link_invalid'); return; }
        try {
          await exchangeLink(tok);
          pasted.value = '';
          state.sessionMsg = '';
          start();
        } catch (ex) { err.textContent = loginErrText(ex); }
      },
    },
  },
  h('div', { class: 'brand big' }, h('span', { class: 'hash', text: '#' }), h('span', { text: t('app') })),
  h('h1', { class: 'login-title', text: t('login_title') }),
  h('p', { class: 'muted', text: t('login_hint') }),
  pasted,
  h('button', { class: 'btn primary', attrs: { type: 'submit' }, text: t('login_paste_btn') }));

  let otpForm = null;
  if (cfg.otp) {
    const email = h('input', { attrs: { type: 'email', autocomplete: 'username', 'aria-label': t('email'), placeholder: t('email'), name: 'email' } });
    const code = h('input', { attrs: { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', 'aria-label': t('login_code'), placeholder: t('login_code'), name: 'code', hidden: true } });
    const send = h('button', { class: 'btn', attrs: { type: 'submit' }, text: t('login_send_code') });
    let otpId = '';
    otpForm = h('form', {
      class: 'login otp',
      on: {
        submit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          try {
            if (!otpId) {
              const r = await pb.collection('users').requestOTP(email.value.trim());
              otpId = r.otpId;
              code.hidden = false;
              send.textContent = t('login_verify');
              info.textContent = t('login_code_sent');
              code.focus();
            } else {
              await pb.collection('users').authWithOTP(otpId, code.value.trim());
              start();
            }
          } catch (ex) { fail(ex); }
        },
      },
    }, h('p', { class: 'muted', text: t('login_otp_hint') }), email, code, send);
  }

  return h('div', { class: 'login-wrap' },
    h('div', { class: 'login-card' },
      isWeChat() ? wechatHint() : null,
      linkForm,
      otpForm,
      cfg.feishu_bot ? h('p', { class: 'login-feishu', text: t('login_feishu') }) : null,
      h('p', { class: 'muted small', text: t('login_ask_admin') }),
      info, err,
      h('button', { class: 'btn ghost', attrs: { type: 'button' }, text: t('lang_toggle'), on: { click: () => { setLang(getLang() === 'zh' ? 'en' : 'zh'); root.replaceChildren(loginView(errMsg)); } } })));
}

/** Bootstrap only (the first admin, created by the superuser): hidden, at #/password-login. */
function passwordLoginView() {
  const email = h('input', { attrs: { type: 'email', autocomplete: 'username', required: true, 'aria-label': t('email'), placeholder: t('email') } });
  const pass = h('input', { attrs: { type: 'password', autocomplete: 'current-password', required: true, 'aria-label': t('password'), placeholder: t('password') } });
  const err = h('div', { class: 'error' });
  return h('div', { class: 'login-wrap' }, h('form', {
    class: 'login password',
    on: {
      submit: async (e) => {
        e.preventDefault();
        try {
          await pb.collection('users').authWithPassword(email.value.trim(), pass.value);
          pass.value = '';
          window.location.hash = '#/';
          start();
        } catch (ex) { err.textContent = `${t('login_failed')}: ${errText(ex)}`; }
      },
    },
  }, h('div', { class: 'brand big' }, h('span', { class: 'hash', text: '#' }), h('span', { text: t('app') })),
  email, pass, h('button', { class: 'btn primary', attrs: { type: 'submit' }, text: t('login') }), err));
}

/** Login failures: link kinds (F8), not-invited with the email, deactivated, rate limits. */
function loginErrText(e) {
  const code = errCode(e);
  if (!code || code === 'unauthorized' || /^(link_|invalid_link)/.test(code)) return linkErrText(e);
  return errText(e);
}

const decideHandlers = {
  drafts: state.drafts,
  // a notification's "?pick=<n>" link: that option is preselected in the reply box (the person still sends it)
  get pick() { return state.pick; },
  onDecide: async (taskId, messageId, decision) => {
    await api(`/tasks/${encodeURIComponent(taskId)}/decide`, 'POST', { message_id: messageId, decision });
    invalidate();
    await refresh();
  },
  // a question addressed to me in a channel thread: my reply is the answer
  onReplyPost: async (postId, text) => {
    await api(`/posts/${encodeURIComponent(postId)}/replies`, 'POST', { body: text });
    invalidate();
    await refresh();
  },
};

/** Promote to team: one statement becomes team-visible; its source stays private. */
const memoryPromote = {
  onPromote: async (body) => {
    await api('/memory/promote', 'POST', body);
    invalidate();
    await refresh();
  },
  onImportant: async (id) => {
    await api(`/memory/decisions/${encodeURIComponent(id)}/team-important`, 'POST', {});
    invalidate();
    await refresh();
  },
};

/** Text/code/HTML attachments: fetched with the session (served as text/plain by the hub). */
async function fetchText(collection, recordId, name) {
  const ok = /^(messages|handoff_versions|posts)$/.test(collection) && ID_RE.test(String(recordId)) && /^[A-Za-z0-9._-]{1,255}$/.test(String(name));
  if (!ok) throw new Error('bad file reference');
  const r = await fetch(new URL(`/api/ach/files/${collection}/${recordId}/${name}`, window.location.origin).href, { headers: { Authorization: pb.authStore.token } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

function mediaOpts() {
  return {
    fetchText,
    token: () => state.fileToken.value,
    freshToken: () => fileToken(true),
    onOpen: async ({ rec, a, collection }) => {
      const url = fileUrl(collection, rec.id, a.name, await fileToken(true));
      if (url) openLightbox(url, a.original);
    },
  };
}

/**
 * F11: a dismissible "Next: create your agent" line at the top of the Inbox,
 * only for admins who have no agent yet (people who own agents already have
 * one; everyone else only reads and decides, and never needs it).
 */
function onboardCard() {
  const info = state.meInfo;
  if (!info || info.has_agents !== false || !(info.is_admin || isAdmin()) || load(ONBOARD_KEY) === '1') return null;
  return h('div', { class: 'onboard' },
    h('div', { class: 'onboard-head' }, h('strong', { text: t('onboard_title') }),
      h('button', { class: 'btn link', attrs: { type: 'button', 'aria-label': t('dismiss') }, text: '×', on: { click: () => { save(ONBOARD_KEY, '1'); state.mainSig = ''; refresh(); } } })),
    h('p', { class: 'muted', text: t('onboard_body') }),
    h('a', { class: 'btn primary', href: '#/agents', text: t('onboard_go') }));
}

function canPost(task) {
  if (isAdmin()) return true;
  const u = me();
  if (!u) return false;
  const owner = (id) => state.agents.get(id)?.owner;
  return owner(task.from_agent) === u.id || owner(task.to_agent) === u.id;
}

/** Scroll to and highlight a permalinked item once per navigation. */
function focusItem(el, key, id) {
  if (!id || state.focused === key) return;
  const x = [...el.querySelectorAll('[data-id]')].find((n) => n.getAttribute('data-id') === id);
  if (!x) return;
  state.focused = key;
  x.classList.add('hl');
  try { x.scrollIntoView({ block: 'center' }); } catch (_) { /* jsdom */ }
}

function autocomplete(ta) {
  return attachAutocomplete(ta, () => ({
    agents: [...state.agents.values()].filter((a) => a.active !== false).map((a) => a.name).sort(),
    channels: state.channels.map((c) => c.name),
  }));
}

/** F5: "notified X" after a send, shown under the composer until the next one (or 30 s). */
function noticeFor(key) {
  const n = state.notice;
  return n && n.key === key && Date.now() - n.at < 30000 ? n.text : '';
}
function setNotice(key, res) {
  const names = res && Array.isArray(res.notified) ? res.notified.filter((x) => typeof x === 'string').slice(0, 20) : null;
  if (!names) { state.notice = null; return; }
  state.notice = { key, at: Date.now(), text: names.length ? t('notified', { names: names.map((x) => `@${x}`).join(', ') }) : t('notified_none') };
}

function postComposer(key, placeholder, send, o = {}) {
  if (!state.files.has(key)) state.files.set(key, []);
  const u = me();
  return composer({
    taskId: o.taskId || key,
    draftKey: key,
    placeholder,
    label: o.label,
    to: o.to,
    sendLabel: o.sendLabel,
    meName: (u && (u.name || u.email)) || '',
    drafts: state.drafts,
    files: state.files.get(key),
    limits: effectiveLimits(state.limits),
    autocomplete,
    onSend: async (text, files, onProgress) => {
      state.busy = true;
      let res;
      try {
        res = await send(text, files, onProgress);
      } catch (e) {
        throw new Error(errText(e));
      } finally {
        state.busy = false;
      }
      setNotice(o.noticeKey || key, o.notified ? { ...(res || {}), notified: (res && Array.isArray(res.notified)) ? res.notified : o.notified } : res);
      state.mainSig = ''; state.threadSig = '';
      setTimeout(refresh, 0);
    },
  });
}

/** JSON or multipart (field `field` + attachments) POST, the shape of /tasks/{id}/note. */
async function sendForm(path, text, files, onProgress, field) {
  // big images/videos go straight to the bucket; the hub gets references
  const d = await directUploads(path, files, onProgress, api);
  if (d.refs.length) { files = d.files; onProgress = d.onProgress; }
  if (files.length) {
    const fd = new FormData();
    fd.append(field, text);
    if (d.refs.length) fd.append('attachment_refs', JSON.stringify(d.refs));
    for (const f of files) fd.append('attachments', f, f.name);
    return upload(path, fd, onProgress);
  }
  return api(path, 'POST', { [field]: text, ...(d.refs.length ? { attachment_refs: d.refs } : {}) });
}

async function sendPost(path, text, files, onProgress, extra) {
  const d = await directUploads(path, files, onProgress, api);
  if (d.refs.length) { files = d.files; onProgress = d.onProgress; extra = { ...(extra || {}), attachment_refs: d.refs }; }
  if (files.length) {
    const fd = new FormData();
    fd.append('json', JSON.stringify({ body: text, ...(extra || {}) }));
    for (const f of files) fd.append('attachments', f, f.name);
    return upload(path, fd, onProgress);
  }
  return api(path, 'POST', { body: text, ...(extra || {}) });
}

function notFoundIn(which, sig, key = 'not_found') {
  const isThread = which === 'thread';
  if ((isThread ? state.threadSig : state.mainSig) === sig) return;
  const node = h('div', { class: 'pane' },
    isThread ? h('div', { class: 'thread-head' }, h('div', { class: 'th-top' }, h('span', { class: 'spacer' }), closeBtn())) : null,
    h('p', { class: 'error pad', text: t(key) }));
  if (isThread) { state.threadSig = sig; swapThread(node); } else { state.mainSig = sig; swapMain(node); }
}

// ---------- middle: Inbox ----------

async function inboxMain(tab = '') {
  if (state.inboxDivider === null) state.inboxDivider = String(state.inboxSeen || '');
  const upd = tab === 'updates';
  if (upd && !state.hooks) {
    try { state.hooks = (await api('/hooks')).hooks || []; } catch (_) { state.hooks = []; }
  }
  const counts = { needs: inboxUnread(state.inbox.items, state.inboxSeen), updates: upd ? 0 : updatesUnread(state.notify.items, state.updSeen) };
  const sig = stableJson(['inbox', tab, getLang(), state.inbox, state.inboxDivider, state.meInfo && state.meInfo.has_agents, load(ONBOARD_KEY), state.agents.size, upd ? [state.notify, state.hooks] : counts.updates]);
  if (upd) {
    const at = newestAt(state.notify.items);
    if (at > String(state.updSeen || '')) { state.updDivider = state.updDivider ?? state.updSeen; state.updSeen = at; save(UPD_SEEN_KEY, at); }
  } else markInboxSeen();
  if (sig === state.mainSig || state.busy) return;
  // typing in the settings form: do not rebuild under the cursor
  const active = document.activeElement;
  if (upd && active && state.shell.main.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return;
  const first = !state.mainSig.startsWith(`["inbox","${tab}"`);
  state.mainSig = sig;
  state.composerForm = null;
  ctx.now = Date.now();
  const pane = inboxView(upd ? { items: [] } : state.inbox, ctx, { decide: decideHandlers, unreadAfter: state.inboxDivider, top: upd ? null : onboardCard() });
  const head = pane.querySelector('.pane-head');
  if (head) head.append(inboxTabs(upd ? 'updates' : '', counts));
  if (upd) {
    const changed = () => { state.hooks = null; state.mainSig = ''; refresh(); };
    pane.querySelector('.thread-inner').replaceChildren(
      notifySettings({ prefs: state.notify.prefs, hooks: state.hooks }, { api, changed }),
      ...updatesList(state.notify.items, ctx, { unreadAfter: state.updDivider || '' }));
  }
  swapMain(pane, { top: first, sameThread: !first });
}

// ---------- middle: My authorizations ----------

async function grantsMain() {
  let data;
  try { data = await api('/grants'); } catch (_) { data = { given: [], received: [] }; }
  const sig = stableJson(['grants', getLang(), data]);
  if (sig === state.mainSig || state.busy) return;
  state.mainSig = sig;
  state.composerForm = null;
  ctx.now = Date.now();
  swapMain(grantsView(data, ctx, {
    onRevoke: async (id) => {
      await api(`/grants/${encodeURIComponent(id)}/revoke`, 'POST', {});
      invalidate();
      await refresh();
    },
  }), { top: true });
}

// ---------- middle: channel ----------

async function channelMain(name) {
  let data;
  try { data = await api(`/channels/${encodeURIComponent(name)}/posts?limit=100`); } catch (_) { notFoundIn('main', `missing:c:${name}`, 'nf_channel'); return; }
  // F2: the unread divider sits where this visit started
  if (data && data.channel && !state.divider.has(name)) state.divider.set(name, String((loadChSeen() || {})[data.channel.id] || ''));
  if (data && data.channel) markChannelSeen(data.channel);
  const older = state.older.get(name) || [];
  const ids = new Set((data.posts || []).map((p) => p.id));
  const posts = [...older.filter((p) => !ids.has(p.id)), ...(data.posts || [])];
  rememberAuthors(posts);
  markQuiet(posts);
  const hasMore = !state.noMore.has(name) && posts.length >= 100;
  const noticeKey = `channel:${name}`;
  const sig = JSON.stringify(['channel', getLang(), data, older.length, hasMore, state.agents.size, state.embedHosts, noticeFor(noticeKey), state.divider.get(name), state.notify.prefs && state.notify.prefs.channels]);
  if (sig === state.mainSig || state.busy) return;
  const same = state.mainSig.startsWith('["channel"') && state.lastChannel === name;
  if ((data.posts || []).some((p) => Array.isArray(p.attachments) && p.attachments.length)) await fileToken();
  state.mainSig = sig;
  state.lastChannel = name;
  ctx.now = Date.now();
  const key = `post:${name}`;
  const label = data.channel ? channelLabel(data.channel) : name;
  const bottom = data.channel && data.channel.archived
    ? h('div', { class: 'composer-note muted', text: t('channel_archived') })
    : postComposer(key, t('message_ph', { name: label }), (text, files, p) => {
      const announce = state.announceNext;
      state.announceNext = false;
      return sendPost(`/channels/${encodeURIComponent(name)}/posts`, text, files, p, announce ? { announce: true } : null);
    }, { noticeKey });
  state.composerForm = bottom && bottom.addFiles ? bottom : null;
  const view = channelView({ ...data, posts }, ctx, {
    media: mediaOpts(), composer: bottom, notice: noticeFor(noticeKey),
    actions: data.channel && !data.channel.archived ? announceToggle(() => state.announceNext, (v) => { state.announceNext = v; }) : null,
    unreadAfter: state.divider.get(name) || '',
    hasMore, onOlder: () => loadOlder(name, posts[0]), promote: memoryPromote,
  });
  // notifications: the channel bell (all / important / off; members and admins manage its hooks)
  const vhead = view.querySelector('.pane-head');
  if (vhead && data.channel) {
    const ch = data.channel;
    const levels = (state.notify.prefs && state.notify.prefs.channels) || {};
    vhead.append(channelBell(ch, levels[ch.id] || 'important', { api, manage: isAdmin() || !!ch.member, changed: () => { state.mainSig = ''; loadNotifications().then(refresh); } }));
  }
  swapMain(view, { sameThread: same, keepTop: !!state.keepTop, restore: same ? null : state.scrollPos.get(`#/c/${name}`) });
  state.keepTop = false;
}

/** F2 "Load older": the page before the oldest post shown. */
async function loadOlder(name, oldest) {
  if (!oldest) return;
  try {
    const r = await api(`/channels/${encodeURIComponent(name)}/posts?before=${encodeURIComponent(oldest.created)}&limit=${OLDER_PAGE}`);
    const got = Array.isArray(r && r.posts) ? r.posts : [];
    if (got.length < OLDER_PAGE) state.noMore.add(name);
    const prev = state.older.get(name) || [];
    const seen = new Set(prev.map((p) => p.id));
    state.older.set(name, [...got.filter((p) => !seen.has(p.id) && String(p.created) < String(oldest.created)), ...prev]);
    if (!got.length) state.noMore.add(name);
  } catch (_) { state.noMore.add(name); }
  state.mainSig = '';
  state.keepTop = true;
  refresh();
}

// ---------- middle: one agent's or person's messages and tasks (DM-like) ----------

function flatPosts(groups) {
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) for (const p of g.posts || []) out.push({ ...p, channel_name: p.channel_name || g.channel_name });
  return out;
}
function dedupeTasks(lists) {
  const m = new Map();
  for (const l of lists) for (const x of Array.isArray(l) ? l : []) if (x && x.id && !m.has(x.id)) m.set(x.id, x);
  return [...m.values()];
}

async function agentMain(ref) {
  const a = state.agents.get(ref) || [...state.agents.values()].find((x) => x.name === ref);
  const name = a ? a.name : ref;
  let prof;
  try { prof = await api(`/profiles/agents/${encodeURIComponent(name)}`); } catch (_) { notFoundIn('main', `missing:a:${ref}`, 'nf_agent'); return; }
  const agentName = prof.name || name;
  const noticeKey = `dm:${agentName}`;
  const sig = stableJson(['agentp', getLang(), prof, state.embedHosts, noticeFor(noticeKey), state.channels.some((c) => c.name === 'general')]);
  if (sig === state.mainSig || state.busy) return;
  state.mainSig = sig;
  ctx.now = Date.now();
  // there are no private DMs: talking to an agent is a #general post that @mentions it
  const canTalk = prof.active !== false && AGENT_NAME_RE.test(agentName) && state.channels.some((c) => c.name === 'general');
  const at = (text) => (new RegExp(`(^|[^A-Za-z0-9_-])@${agentName}(?![A-Za-z0-9_-])`).test(text) ? text : `@${agentName} ${text}`);
  const bottom = canTalk ? postComposer(`dm:${agentName}`, t('dm_ph', { name: agentName }), (text, files, p) => sendPost('/channels/general/posts', at(text), files, p), {
    noticeKey, to: h('span', { class: 'to-label', text: t('dm_to', { name: agentName }) }),
  }) : null;
  state.composerForm = bottom;
  const posts = flatPosts(prof.posts_by_channel);
  rememberAuthors(posts);
  markQuiet(posts);
  if (posts.some((p) => Array.isArray(p.attachments) && p.attachments.length)) await fileToken();
  const sub = [t('kind_agent'), prof.owner_name ? t('owned_by', { name: prof.owner_name }) : '', prof.last_seen ? t('seen_ago', { when: ago(prof.last_seen, ctx.now) }) : '', prof.active === false ? t('inactive') : '', prof.description || '']
    .filter(Boolean).join(' · ');
  swapMain(dmView({
    kind: 'agent', name: prof.name || name, sub, href: `#/a/${prof.name || name}`,
    items: [...dedupeTasks([prof.tasks_held, prof.tasks_sent]).map(taskAsPost), ...posts],
  }, ctx, { media: mediaOpts(), composer: bottom, notice: noticeFor(noticeKey) }));
}

async function userMain(id) {
  let prof;
  try { prof = await api(`/profiles/users/${encodeURIComponent(id)}`); } catch (_) { notFoundIn('main', `missing:u:${id}`, 'nf_user'); return; }
  const sig = stableJson(['userp', getLang(), prof, state.embedHosts]);
  if (sig === state.mainSig) return;
  state.mainSig = sig;
  state.composerForm = null;
  ctx.now = Date.now();
  const posts = flatPosts(prof.posts_by_channel);
  rememberAuthors(posts);
  if (posts.some((p) => Array.isArray(p.attachments) && p.attachments.length)) await fileToken();
  const agents = (prof.agents || []).map((a) => `@${a.name}`).join(', ');
  // a person's page is a profile (people are reached by @mentioning their agents in a channel)
  const role = typeof prof.role === 'string' ? prof.role.trim() : '';
  const sub = [`${t('kind_person')} ${t('profile')}`, role ? `${t('role')}: ${role}` : '', prof.github_login ? `GitHub @${prof.github_login}` : '', agents].filter(Boolean).join(' · ');
  swapMain(dmView({
    kind: 'human', name: prof.name || id, sub, href: `#/u/${prof.id || id}`,
    items: [...dedupeTasks([prof.tasks]).map(taskAsPost), ...posts],
  }, ctx, { media: mediaOpts() }));
}

// ---------- middle: search ----------

function setHideBots(v) {
  state.hideBots = !!v;
  save('ach.hidebots', state.hideBots ? '1' : '0');
  state.mainSig = '';
  refresh();
}

async function searchMain(q) {
  let res;
  const extra = state.hideBots ? '&exclude_bots=1' : '';
  try { res = await api(`/search?q=${encodeURIComponent(q)}&limit=50${extra}`); } catch (e) { res = { results: [], error: errText(e) }; }
  const sig = stableJson(['search', getLang(), q, res, state.hideBots]);
  if (sig === state.mainSig) return;
  state.mainSig = sig;
  state.composerForm = null;
  ctx.now = Date.now();
  swapMain(searchView(q, res, ctx, { hideBots: state.hideBots, onHideBots: setHideBots }), { top: true });
}

// ---------- middle: team wiki ----------

/** "Export as Markdown": every page of the index as <slug>.md in a zip (read-only). */
async function exportWiki(channel) {
  const r = await api(`/memory/export${channel ? `?channel=${encodeURIComponent(channel)}` : ''}`);
  const bytes = zipStore((r && r.files) || []);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `memory-${channel || 'all'}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function wikiMain(r) {
  let data;
  let node;
  try {
    if (r.view === 'index') {
      data = await api(`/memory${r.channel ? `?channel=${encodeURIComponent(r.channel)}` : ''}`);
      node = () => wikiIndexView(data, ctx, { channel: r.channel, onExport: () => exportWiki(r.channel).catch(() => {}) });
    } else if (r.view === 'decisions') {
      data = await api('/memory/decisions');
      node = () => decisionLogView(data, ctx, { focus: r.focus, promote: memoryPromote });
    } else if (r.view === 'history') {
      const hist = await api(`/memory/pages/${encodeURIComponent(r.slug)}/versions`);
      const sel = r.version ? await api(`/memory/pages/${encodeURIComponent(r.slug)}/versions/${r.version}`) : null;
      data = [hist, sel];
      node = () => wikiHistoryView(hist, sel, ctx);
    } else {
      let page;
      try { page = await api(`/memory/pages/${encodeURIComponent(r.slug)}`); } catch (e) {
        // the team overview before its first upkeep: the hub's map of who owns what and the promoted statements
        if (r.slug !== 'team-overview') throw e;
        const ov = await api('/memory/overview');
        page = { slug: 'team-overview', title: t('wiki_overview'), body: '', version: 0, channel_name: 'general', team_map: ov.team_map, promotions: ov.promotions, missing: true };
      }
      const old = r.version && r.version !== page.version ? await api(`/memory/pages/${encodeURIComponent(r.slug)}/versions/${r.version}`) : null;
      data = [page, old];
      node = () => wikiPageView(page, ctx, { version: old, promote: memoryPromote });
    }
  } catch (_) { notFoundIn('main', `missing:w:${JSON.stringify(r)}`, r.view === 'index' && r.channel ? 'nf_channel' : r.view === 'decisions' ? 'nf_decision' : 'nf_memory'); return; }
  const sig = stableJson(['wiki', getLang(), r, data]);
  if (sig === state.mainSig) return;
  state.mainSig = sig;
  state.composerForm = null;
  ctx.now = Date.now();
  swapMain(node(), { top: true });
  if (r.focus) {
    const el = state.shell.main.querySelector(`[data-id="${r.focus}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
  }
}

// ---------- thread pane: a task ----------

/** A task by "T-128" or record id. */
async function findTask(ref) {
  const m = /^T-([0-9]{1,9})$/.exec(ref);
  if (m) return pb.collection('tasks').getFirstListItem(pb.filter('seq = {:n}', { n: Number(m[1]) }));
  return pb.collection('tasks').getOne(ref);
}

async function taskThread(ref, focus = {}) {
  let task;
  try { task = await findTask(ref); } catch (e) { notFoundIn('thread', `missing:${ref}`); return; }
  const id = task.id;
  state.threadChannel = (state.channels.find((c) => c.id === task.channel) || {}).name || '';
  const filter = pb.filter('task = {:id}', { id });
  const [versions, msgs, anchors] = await Promise.all([
    pb.collection('handoff_versions').getFullList({ filter, batch: 500 }).catch(() => []),
    pb.collection('messages').getFullList({ filter, batch: 1000 }).catch(() => []),
    pb.collection('posts').getFullList({ filter: pb.filter("task = {:id} && kind = 'task'", { id }), batch: 5 }).catch(() => []),
  ]);
  let replies = [];
  if (anchors[0]) {
    try { replies = (await api(`/posts/${encodeURIComponent(anchors[0].id)}`)).replies || []; } catch (_) { replies = []; }
  }
  msgs.sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')));
  const post = canPost(task);
  const focusKey = `task:${id}:${focus.msg || ''}:${focus.version || ''}`;
  const rc = state.rcMode.has(id);
  const sig = JSON.stringify(['task', getLang(), task, versions, msgs, replies, state.agents.size, state.users.size, post, focusKey, state.channels.length, noticeFor(`task:${id}`), !!anchors[0], rc, state.toMode.get(id) || '']);
  if (sig === state.threadSig || state.busy) return;
  const sameThread = state.threadSig.startsWith(`["task","${getLang()}",{`) && state.lastTaskId === id;
  const hasMedia = [...msgs, ...versions, ...replies].some((r) => Array.isArray(r.attachments) && r.attachments.length);
  if (hasMedia) await fileToken();
  state.threadSig = sig;
  state.lastTaskId = id;
  ctx.now = Date.now();
  const href = taskHref(id, task.seq);
  rememberAuthors(replies);

  const terminal = TERMINAL.has(task.status);
  const u = me();
  const cancelErr = h('span', { class: 'error' });
  // F7: only the task's owner (owner_user) or an admin may cancel
  const mayCancel = !terminal && (isAdmin() || !!(u && task.owner_user && task.owner_user === u.id));
  const cancelBtn = !mayCancel ? null : h('span', { class: 'th-actions' }, h('button', {
    class: 'btn link cancel-task',
    attrs: { type: 'button' },
    text: t('cancel_task'),
    on: {
      click: async () => {
        if (!window.confirm(t('cancel_confirm'))) return;
        const reason = window.prompt(t('cancel_reason'), '') ?? '';
        try {
          await api(`/tasks/${encodeURIComponent(id)}/cancel`, 'POST', { reason: reason || 'canceled from panel' });
          invalidate();
          await refresh();
        } catch (e) { cancelErr.textContent = `${t('error')}: ${errText(e)}`; }
      },
    },
  }), cancelErr);

  const media = mediaOpts();
  const anchor = anchors[0] || null;
  const finished = task.status === 'completed' || task.status === 'failed';
  // Who the composer reaches (the composer always says who it reaches):
  // - the sender's owner (or an admin): a note to the worker ("Note to bob-worker…")
  // - the worker's owner: the requester by default, as a reply in the task's
  //   thread that @mentions the sending agent ("Reply to alice-agent…"), with a
  //   toggle to note their own agent instead
  // - anyone else: a reply in the task's thread; @mention someone to notify them
  // - a finished task: "Request changes" (reopens it) is the primary action; a
  //   plain reply says it does not reopen the task
  const ownerOfAgent = (aid) => (aid && state.agents.get(aid)?.owner) || '';
  const fromName = ctx.agentName(task.from_agent);
  const toName = ctx.agentName(task.to_agent);
  const iSend = !!(u && ownerOfAgent(task.from_agent) === u.id);
  const iWork = !!(u && ownerOfAgent(task.to_agent) === u.id);
  const replyHere = (key, ph, extra = {}) => postComposer(key, ph, (text, files, prog) => sendPost(`/posts/${encodeURIComponent(anchor.id)}/replies`, (extra.prefix ? extra.prefix(text) : text), files, prog), { noticeKey: `task:${id}`, ...extra });
  const noteHere = (extra = {}) => postComposer(`note:${id}`, t('ph_note_to', { name: toName }), (text, files, prog) => sendForm(`/tasks/${encodeURIComponent(id)}/note`, text, files, prog, 'body'), { taskId: id, noticeKey: `task:${id}`, notified: [toName], ...extra });
  const mention = (text) => (new RegExp(`(^|[^A-Za-z0-9_-])@${fromName.replace(/[-]/g, '\\-')}(?![A-Za-z0-9_-])`).test(text) ? text : `@${fromName} ${text}`);
  let bottom;
  let actions = null;
  if (finished) {
    if (rc || !anchor) {
      bottom = postComposer(`changes:${id}`, t('request_changes_placeholder'), (text, files, prog) => sendForm(`/tasks/${encodeURIComponent(id)}/request-changes`, text, files, prog, 'body'), { sendLabel: t('request_changes'), noticeKey: `task:${id}` });
    } else bottom = replyHere(`reply:${anchor.id}`, t('ph_done_reply'));
    if (anchor) {
      actions = h('div', { class: 'foot-actions' }, h('button', {
        class: rc ? 'btn link rc-toggle' : 'btn primary rc-toggle', attrs: { type: 'button' }, text: rc ? t('reply_instead') : t('request_changes'),
        on: { click: () => { if (rc) state.rcMode.delete(id); else state.rcMode.add(id); state.threadSig = ''; refresh(); } },
      }));
    }
  } else if (!terminal && post && iWork && !iSend && anchor) {
    const mode = state.toMode.get(id) === 'worker' ? 'worker' : 'requester';
    const pick = (m) => () => { state.toMode.set(id, m); state.threadSig = ''; refresh(); };
    const to = h('span', { class: 'to-pick', attrs: { role: 'group', 'aria-label': t('to_label') } },
      h('span', { class: 'to-label', text: `${t('to_label')}:` }),
      h('button', { class: 'btn link to-opt' + (mode === 'requester' ? ' on' : ''), attrs: { type: 'button', 'aria-pressed': mode === 'requester' ? 'true' : 'false' }, text: t('to_requester', { name: fromName }), on: { click: pick('requester') } }),
      h('button', { class: 'btn link to-opt' + (mode === 'worker' ? ' on' : ''), attrs: { type: 'button', 'aria-pressed': mode === 'worker' ? 'true' : 'false' }, text: t('to_worker', { name: toName }), on: { click: pick('worker') } }));
    bottom = mode === 'worker'
      ? noteHere({ to })
      : replyHere(`reply:${anchor.id}`, t('ph_reply_to', { name: fromName }), { to, prefix: mention });
  } else if (!terminal && post) {
    bottom = noteHere();
  } else if (anchor) {
    // F5: not an owner (or a canceled task): reply in the task's anchor thread (the channel conversation)
    bottom = replyHere(`reply:${anchor.id}`, t('ph_thread'));
  } else bottom = h('div', { class: 'composer-note muted', text: terminal ? t('thread_closed') : t('read_only_thread') });
  state.threadComposer = bottom && bottom.addFiles ? bottom : null;
  const chName = state.threadChannel;
  // a version permalink opens the handoff, its history and that version (not the remembered state)
  const resetKeys = focus.version && state.focused !== focusKey ? [`handoff:${id}`, `history:${id}`, `hv:${id}:${focus.version}`] : [];

  const issueBase = issueBaseOf(task.links);
  swapThread(withIssueBase(issueBase, () => h('div', { class: 'pane thread task-thread', attrs: { 'data-task': id } },
    taskHead(task, ctx, {
      me: u && u.id,
      cancel: cancelBtn,
      copy: copyLink(href),
      close: closeBtn(),
      channel: chName ? h('a', { class: 'ch-link', href: channelHref(chName), text: `#${chName}` }) : null,
    }),
    h('div', { class: 'thread-scroll' },
      h('div', { class: 'thread-inner' },
        handoffCard(task, versions, ctx, { media, focusVersion: focus.version || 0, open: !!focus.version }),
        timeline(task, versions, msgs, ctx, {
          me: u && u.id, isAdmin: isAdmin(), taskId: id, decide: decideHandlers, media,
          focus: focus.msg, linkOf: (m) => copyLink(`${href}/m/${m.id}`),
          replies, renderPost: (p) => postItem(p, ctx, { media, inThread: true }),
        }))),
    footer({ composer: bottom, actions, notice: noticeFor(`task:${id}`) }))), { sameThread: sameThread && !focus.msg && !focus.version, resetKeys });
  const tTop = state.shell.thread.querySelector('.thread-head .th-top');
  if (tTop) tTop.insertBefore(followToggle('task', id, { api }), tTop.querySelector(':scope > .th-close'));
  if (focus.msg) focusItem(state.shell.thread, focusKey, focus.msg);
  else if (focus.version) focusItem(state.shell.thread, focusKey, `v${focus.version}`);
}

// ---------- thread pane: a post ----------

async function postThread(id, fileName) {
  let data;
  try { data = await api(`/posts/${encodeURIComponent(id)}`); } catch (_) { notFoundIn('thread', `missing:p:${id}`, 'nf_post'); return; }
  const rootPost = data.post || {};
  state.threadChannel = rootPost.channel_name || '';
  // a task's anchor thread is the task's thread
  if (rootPost.kind === 'task' && rootPost.task) {
    const ti = rootPost.task_info || {};
    await taskThread(ti.ref && /^T-\d+$/.test(ti.ref) ? ti.ref : rootPost.task, {});
    if (id !== rootPost.id) focusItem(state.shell.thread, `post:${id}`, id);
    return;
  }
  const sig = JSON.stringify(['post', getLang(), data, state.agents.size, state.embedHosts, noticeFor(`reply:${rootPost.id}`)]);
  if (sig === state.threadSig || state.busy) return;
  const same = state.threadSig.startsWith('["post"') && state.lastPost === rootPost.id;
  if ([rootPost, ...(data.replies || [])].some((p) => Array.isArray(p.attachments) && p.attachments.length)) await fileToken();
  state.threadSig = sig;
  state.lastPost = rootPost.id;
  ctx.now = Date.now();
  const key = `reply:${rootPost.id}`;
  const bottom = postComposer(key, t('reply_ph'), (text, files, p) => sendPost(`/posts/${encodeURIComponent(rootPost.id)}/replies`, text, files, p), { noticeKey: key });
  state.threadComposer = bottom && bottom.addFiles ? bottom : null;
  rememberAuthors([rootPost, ...(data.replies || [])]);
  swapThread(threadView({ ...data, focus: id !== rootPost.id ? id : '' }, ctx, { media: mediaOpts(), composer: bottom, notice: noticeFor(key), close: closeBtn() }), { sameThread: same });
  const pTop = state.shell.thread.querySelector('.thread-head .th-top');
  if (pTop) pTop.insertBefore(followToggle('post', rootPost.id, { api }), pTop.querySelector(':scope > .th-close'));
  // "?pick=<n>" on a question addressed to me: prefill my reply with that option (not sent)
  if (state.pick && state.pick.id === id && bottom && bottom.querySelector) {
    const q = [rootPost, ...(data.replies || [])].find((p) => p.id === id);
    const opt = q && q.choices && Array.isArray(q.choices.options) ? q.choices.options[state.pick.option] : null;
    const ta = bottom.querySelector('textarea');
    if (opt && ta && !ta.value) { ta.value = optionReply(opt); ta.dispatchEvent(new Event('input')); }
  }
  const focusKey = `post:${id}:${fileName || ''}`;
  if (fileName) focusItem(state.shell.thread, focusKey, fileName);
  else if (id !== rootPost.id) focusItem(state.shell.thread, focusKey, id);
}

/** #/f/<collection>/<record>/<file>: open the item that carries the file and highlight it. */
async function fileThread(r) {
  try {
    if (r.coll === 'posts') { await postThread(r.rid, r.file); return; }
    const rec = await pb.collection(r.coll).getOne(r.rid);
    if (r.coll === 'messages') await taskThread(rec.task, { msg: rec.id });
    else await taskThread(rec.task, { version: Number(rec.version) || 0 });
  } catch (_) { notFoundIn('thread', `missing:f:${r.rid}`, 'nf_file'); }
}

// ---------- settings (behind the user menu) ----------

async function channelsAdminMain() {
  if (!isAdmin()) { notFoundIn('main', 'admin:forbidden'); return; }
  try {
    const [all, settings, storage, memory, storageDetail] = await Promise.all([api('/channels?all=1'), api('/admin/settings'), api('/admin/storage'), api('/admin/memory/metrics').catch(() => null), api('/admin/storage/detail').catch(() => null)]);
    state.adminChannels = { channels: all, embedHosts: settings.embed_hosts, storage, memoryMetrics: memory, storageDetailData: storageDetail };
  } catch (e) { notFoundIn('main', `err:adminch:${errText(e)}`); return; }
  const sig = stableJson(['adminch', getLang(), state.adminChannels]);
  if (sig === state.mainSig) return;
  const main = state.shell.main;
  const typing = document.activeElement && main.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (typing && state.mainSig.startsWith('["adminch"')) return;
  state.mainSig = sig;
  state.composerForm = null;
  const after = async () => { invalidate(); await loadChannels(); await loadSettings(); await refresh(); };
  swapMain(channelsAdminView({
    ...state.adminChannels,
    memory: memoryMetricsView(state.adminChannels.memoryMetrics),
    storageDetail: storageDetailView({
      detail: state.adminChannels.storageDetailData,
      onRetention: async (name, days) => { await api(`/channels/${encodeURIComponent(name)}/retention`, 'PUT', { days }); await after(); },
    }),
    tabs: settingsTabs('channels', true),
    onCreate: async (body) => { await api('/channels', 'POST', body); await after(); },
    onPatch: async (c, body) => { await api(`/channels/${encodeURIComponent(c.id)}`, 'PATCH', body); await after(); },
    onEmbeds: async (list) => { await api('/admin/settings', 'PUT', { embed_hosts: list }); await after(); },
  }), { top: true });
}

/** Cost moved out of the daily view: the 7-day rolling cost, shown in settings. */
async function loadCost() {
  try {
    const p = await api('/panel');
    state.costWeek = { usd: Number(p && p.cost_week) || 0, est: !!(p && p.cost_week_estimated) };
  } catch (_) { /* keep previous */ }
}
function field(label, control, cls) {
  return h('label', { class: 'field' + (cls ? ` ${cls}` : '') }, h('span', { class: 'label', text: label }), control);
}

function keyBox() {
  const k = state.oneTimeKey;
  if (!k) return null;
  const dismiss = () => { state.oneTimeKey = null; invalidate(); refresh(); };
  if (k.inviteOnce || k.invite) {
    // Invite an agent: (a) the paragraph for the owner's Claude/Codex, (b) the
    // plain join line. The one-time invite (works once, expires); the legacy
    // key-carrying ach1 line only when the hub still hands one out.
    const invite = k.inviteOnce || k.invite;
    const box = h('div', { class: 'keybox' },
      h('div', { text: t('invite_agent_head', { name: k.name }) }),
      agentInviteSheet({ name: k.name, invite, once: !!k.inviteOnce, cf: !!k.cf }),
      k.inviteOnce ? null : h('div', { class: 'muted small', text: t('key_once') }),
      h('div', { class: 'btns' }, h('button', { class: 'btn', attrs: { type: 'button' }, text: t('dismiss'), on: { click: dismiss } })));
    const u = me();
    if (isAdmin() && k.owner && (!u || k.owner !== u.id) && state.oneTimeLink && state.oneTimeLink.userId === k.owner) {
      box.appendChild(shareSheetFor(state.oneTimeLink, { ...k, invite }));
    }
    return box;
  }
  return copyBox({ note: `${k.name}: ${t('key_once')}`, value: k.key, onDismiss: dismiss });
}

function shareSheetFor(link, k) {
  return shareSheetEl({ name: link.name, url: link.url, agent: k ? { name: k.name, runtime: k.runtime, invite: k.invite, cf: !!k.cf } : null });
}

function pickKey(res) {
  return res && (res.key || res.api_key || res.token || (res.agent && res.agent.key)) || '';
}

const listOf = (v) => String(v || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

function createAgentForm() {
  const admin = isAdmin();
  const u = me();
  const err = h('div', { class: 'error' });
  const name = h('input', { attrs: { placeholder: 'alice-agent', required: true, 'aria-label': t('name_label'), maxlength: 41, autocomplete: 'off' } });
  const owner = admin
    ? h('select', { attrs: { 'aria-label': t('owner_label') } },
      [...state.users.values()].map((x) => h('option', { attrs: { value: x.id, selected: u && x.id === u.id }, text: x.name || x.email || x.id })))
    : null;
  const runtime = h('select', { attrs: { 'aria-label': t('runtime_label') } }, ['claude', 'codex', 'other'].map((r) => h('option', { attrs: { value: r }, text: r })));
  const perm = h('select', { attrs: { 'aria-label': t('perm_label') } },
    ['read', 'workdir', ...(admin ? ['full'] : [])].map((r) => h('option', { attrs: { value: r, selected: r === 'workdir' }, text: r })));
  const budget = h('input', { class: 'num', attrs: { type: 'number', min: 0, step: '0.01', value: 0, 'aria-label': t('budget_label') } });
  const desc = h('input', { attrs: { placeholder: t('description'), 'aria-label': t('desc_label') } });
  const netAllow = h('input', { attrs: { type: 'text', placeholder: t('net_allow_hint'), 'aria-label': t('net_allow_label') } });
  const acceptFrom = h('input', { attrs: { type: 'text', placeholder: t('accept_from_hint'), 'aria-label': t('accept_from_label') } });
  // the shared Cloudflare service token is opt-in per agent, with a warning
  const cfBox = state.meInfo && state.meInfo.invite_cf_available ? h('input', { attrs: { type: 'checkbox', 'aria-label': t('cf_opt_in'), name: 'cf_token' } }) : null;
  return h('form', {
    class: 'create agent-create',
    on: {
      submit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const nm = name.value.trim();
        // F10: a sentence, not the regex
        if (!AGENT_NAME_RE.test(nm)) { err.textContent = t('err_invalid_agent_name'); name.focus(); return; }
        const body = { name: nm, runtime: runtime.value, description: desc.value.trim(), perm_level: perm.value };
        if (admin) body.budget_usd = Number(budget.value) || 0;
        if (owner) body.owner = owner.value;
        if (netAllow.value.trim()) body.net_allow = listOf(netAllow.value);
        if (acceptFrom.value.trim()) body.accept_from = listOf(acceptFrom.value);
        if (cfBox && cfBox.checked) body.cf_token = true;
        try {
          const res = await api('/admin/agents', 'POST', body);
          const ag = (res && res.agent) || {};
          state.oneTimeKey = { name: ag.name || body.name, key: pickKey(res), invite: (res && res.invite) || '', inviteOnce: (res && res.invite_once) || '', owner: ag.owner || body.owner || (u && u.id), runtime: ag.runtime || body.runtime, cf: !!(res && res.cf_token_included) };
          invalidate();
          await loadDirectory();
          await loadLimits();
          await refresh();
        } catch (ex) { err.textContent = `${t('error')}: ${errText(ex)}`; }
      },
    },
  },
  h('h2', { text: t('create_agent') }),
  h('div', { class: 'form-grid' },
    field(t('name_label'), name),
    owner ? field(t('owner_label'), owner) : null,
    field(t('runtime_label'), runtime),
    field(t('perm_label'), perm),
    admin ? field(t('budget_label'), budget) : null,
    field(t('desc_label'), desc, 'wide'),
    field(t('net_allow_label'), netAllow, 'wide'),
    field(t('accept_from_label'), acceptFrom, 'wide'),
    cfBox ? h('label', { class: 'check wide-check cf-opt-in' }, cfBox, h('span', { text: t('cf_opt_in') }), h('span', { class: 'muted small', text: ` ${t('cf_opt_in_warn')}` })) : null),
  h('div', { class: 'btns' }, h('button', { class: 'btn primary', attrs: { type: 'submit' }, text: t('create') })),
  err);
}

function agentAdminRow(a) {
  const admin = isAdmin();
  const mine = !!(me() && a.owner === me().id);
  const owner = a.expand?.owner?.name || a.owner_name || ctx.userName(a.owner);
  const err = h('span', { class: 'error' });
  const ok = h('span', { class: 'muted small' });
  const patch = async (body) => {
    err.textContent = ''; ok.textContent = '';
    try {
      await api(`/admin/agents/${encodeURIComponent(a.id)}`, 'PATCH', body);
      ok.textContent = t('saved');
      invalidate();
      await loadDirectory();
      await refresh();
    } catch (ex) { err.textContent = `${t('error')}: ${errText(ex)}`; }
  };
  let controls = null;
  if (admin || mine) {
    // B8: an owner cannot undo an admin's lock
    const lockedOff = !!a.disabled_by_admin && !admin;
    const acceptLocked = !!(a.accept_from_locked || a.accept_from_by_admin) && !admin;
    const perm = h('select', { attrs: { 'aria-label': t('perm_label') } },
      ['read', 'workdir', ...(admin || a.perm_level === 'full' ? ['full'] : [])].map((r) => h('option', { attrs: { value: r, selected: r === a.perm_level }, text: r })));
    // P2: sandbox network allowlist; "*" is admin-only (the hub enforces it)
    const netAllow = h('input', { attrs: { type: 'text', value: (a.net_allow || []).join(', '), placeholder: t('net_allow_hint'), 'aria-label': t('net_allow_label') } });
    const budget = h('input', { class: 'num', attrs: { type: 'number', min: 0, step: '0.01', value: a.budget_usd ?? 0, 'aria-label': t('budget_label') } });
    const acceptFrom = h('input', { attrs: { type: 'text', value: Array.isArray(a.accept_from) ? a.accept_from.join(', ') : '', placeholder: t('accept_from_hint'), 'aria-label': t('accept_from_label'), disabled: acceptLocked } });
    const quiet = h('input', { attrs: { type: 'checkbox', checked: !!a.quiet, 'aria-label': t('quiet_label') } });
    // F10: one Save per agent: only changed fields are sent
    const save = () => {
      const body = {};
      if (quiet.checked !== !!a.quiet) body.quiet = quiet.checked;
      if (perm.value !== a.perm_level) body.perm_level = perm.value;
      if (listOf(netAllow.value).join(',') !== (a.net_allow || []).join(',')) body.net_allow = listOf(netAllow.value);
      if (!acceptLocked && listOf(acceptFrom.value).join(',') !== (Array.isArray(a.accept_from) ? a.accept_from : []).join(',')) body.accept_from = listOf(acceptFrom.value);
      if (admin && (Number(budget.value) || 0) !== (Number(a.budget_usd) || 0)) body.budget_usd = Number(budget.value) || 0;
      if (!Object.keys(body).length) { ok.textContent = t('saved'); return; }
      patch(body);
    };
    controls = h('form', { class: 'agent-edit', on: { submit: (e) => { e.preventDefault(); save(); } } },
      h('div', { class: 'form-grid' },
        field(t('perm_label'), perm),
        admin ? field(t('budget_label'), budget) : null,
        field(t('net_allow_label'), netAllow, 'wide'),
        field(acceptLocked ? `${t('accept_from_label')} [${t('locked_by_admin')}]` : t('accept_from_label'), acceptFrom, 'wide'),
        h('label', { class: 'check wide-check' }, quiet, h('span', { text: t('quiet_label') }))),
      h('div', { class: 'btns' },
        h('button', { class: 'btn primary', attrs: { type: 'submit' }, text: t('save_agent') }),
        h('button', {
          class: 'btn' + (a.active ? ' danger' : ''), attrs: { type: 'button', disabled: !a.active && lockedOff, title: lockedOff ? t('agent_locked') : '' }, text: a.active ? t('deactivate') : t('activate'),
          on: { click: () => { if (a.active && !window.confirm(t('deactivate_agent_confirm', { name: a.name }))) return; patch({ active: !a.active }); } },
        }),
        h('button', {
          class: 'btn', attrs: { type: 'button' }, text: t('rotate_key'),
          on: {
            click: async () => {
              if (!window.confirm(t('rotate_confirm'))) return;
              err.textContent = '';
              try {
                const withCf = !!(state.meInfo && state.meInfo.invite_cf_available) && window.confirm(t('rotate_cf_confirm'));
                const res = await api(`/admin/agents/${encodeURIComponent(a.id)}/rotate-key`, 'POST', withCf ? { cf_token: true } : {});
                state.oneTimeKey = { name: a.name, key: pickKey(res), invite: (res && res.invite) || '', inviteOnce: (res && res.invite_once) || '', owner: a.owner, runtime: a.runtime, cf: !!(res && res.cf_token_included) };
                invalidate();
                await loadDirectory();
                await refresh();
              } catch (ex) { err.textContent = `${t('error')}: ${errText(ex)}`; }
            },
          },
        }),
        ok, err));
  }
  const budgetTxt = Number(a.budget_usd) > 0 ? money(a.budget_usd) : t('unlimited');
  return h('div', { class: 'row agent-row-admin' + (a.active ? '' : ' dim'), attrs: { 'data-id': a.id } },
    h('div', { class: 'row-main' },
      h('span', { class: 'title', text: a.name }), ' ',
      tag(a.runtime || '?'), ' ',
      tag(a.active ? t('active') : t('inactive'), a.active ? '' : 'strong'), ' ',
      a.disabled_by_admin ? [tag(t('agent_locked'), 'strong'), ' '] : null,
      tag(`${t('perm')}:${a.perm_level || '?'}`)),
    h('div', { class: 'row-meta' },
      h('span', { text: `${t('owner')}: ${owner}` }),
      h('span', { text: `${t('spent')} ${money(a.spent_usd, a.runtime === 'codex')} / ${budgetTxt}` }),
      h('span', { class: 'muted', text: `${t('last_seen')}: ${a.last_seen ? ago(a.last_seen, ctx.now) : t('never')}` }),
      a.key_prefix ? h('code', { text: `${a.key_prefix}…` }) : null),
    a.description ? h('div', { class: 'desc', text: a.description }) : null,
    controls,
  );
}

async function agentsMain() {
  const agents = [...state.agents.values()].sort((x, y) => String(x.name).localeCompare(String(y.name)));
  if (!state.costWeek || !state.mainSig.startsWith('["agents"')) await loadCost();
  const sig = JSON.stringify(['agents', getLang(), agents, [...state.users.keys()], !!state.oneTimeKey, isAdmin(), state.costWeek]);
  if (sig === state.mainSig) return;
  // Don't wipe a half-filled create form on background refresh.
  const main = state.shell.main;
  const typing = document.activeElement && main.contains(document.activeElement)
    && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (typing && state.mainSig.startsWith('["agents"')) return;
  state.mainSig = sig;
  state.composerForm = null;
  ctx.now = Date.now();
  const cost = state.costWeek;
  swapMain(h('div', { class: 'pane agents-admin' },
    h('div', { class: 'pane-head' }, h('h1', { class: 'pane-title', text: t('settings') }),
      cost ? h('span', { class: 'pane-sub muted cost', text: t('cost_week_line', { cost: money(cost.usd, cost.est) }) }) : null),
    h('div', { class: 'pane-body' },
      settingsTabs('agents', isAdmin()),
      keyBox(),
      createAgentForm(),
      agents.length ? agents.map(agentAdminRow) : h('div', { class: 'empty-state muted', text: t('empty') }))));
}

async function loadPeople() {
  try { state.people = await api('/admin/users'); } catch (_) { /* keep previous */ }
}

async function peopleMain() {
  if (!isAdmin()) {
    const sig = 'people:forbidden';
    if (state.mainSig !== sig) { state.mainSig = sig; swapMain(h('div', { class: 'pane' }, h('p', { class: 'error pad', text: t('not_found') }))); }
    return;
  }
  await loadPeople();
  await loadAuthConfig();
  const sig = stableJson(['people', getLang(), state.people, state.oneTimeLink, state.oneTimeKey && state.oneTimeKey.owner]);
  if (sig === state.mainSig) return;
  const main = state.shell.main;
  const typing = document.activeElement && main.contains(document.activeElement)
    && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (typing && state.mainSig.startsWith('["people"')) return;
  state.mainSig = sig;
  state.composerForm = null;
  const showLink = (u, res) => {
    // prefer the hub's absolute url (ACH_PUBLIC_URL) when it is a login link
    const url = typeof res.url === 'string' && /^https?:\/\/[^\s"'<>`]+\/?#\/login\/ach_lt_[A-Za-z0-9]{40}$/.test(res.url) ? res.url : loginUrl(window.location.origin, res.path);
    state.oneTimeLink = { name: u.name || u.email, url, userId: u.id, email: u.email || '' };
  };
  const after = async () => { invalidate(); await loadPeople(); await loadDirectory(); await refresh(); };
  const k = state.oneTimeKey;
  const link = state.oneTimeLink;
  swapMain(peopleView({
    users: state.people,
    meId: me() && me().id,
    link,
    cf: !!(state.authConfig && state.authConfig.cf),
    share: k && link && k.owner === link.userId && (k.inviteOnce || k.invite) ? { name: k.name, runtime: k.runtime, invite: k.inviteOnce || k.invite, cf: !!k.cf } : null,
    delivery: { smtp: !!(state.authConfig && state.authConfig.smtp), feishu: !!(state.authConfig && state.authConfig.feishu) },
    inviteCf: !!(state.meInfo && state.meInfo.invite_cf_available),
    // "Engineer (with agent)" creates the person and their agent together
    onInvite: async (body, agent) => {
      const res = await api('/admin/users', 'POST', body);
      const user = res.user || body;
      showLink(user, res);
      state.oneTimeKey = null;
      if (agent && user.id) {
        const ar = await api('/admin/agents', 'POST', { ...agent, owner: user.id });
        const ag = (ar && ar.agent) || {};
        state.oneTimeKey = { name: ag.name || agent.name, key: pickKey(ar), invite: (ar && ar.invite) || '', inviteOnce: (ar && ar.invite_once) || '', owner: user.id, runtime: ag.runtime || agent.runtime, cf: !!(ar && ar.cf_token_included) };
      }
      await after();
    },
    onLink: async (u) => {
      const res = await api(`/admin/users/${encodeURIComponent(u.id)}/login-link`, 'POST', {});
      showLink(u, res);
      await after();
    },
    onPatch: async (u, body) => {
      await api(`/admin/users/${encodeURIComponent(u.id)}`, 'PATCH', body);
      await after();
    },
    // F10: reassign the person's agents (or deactivate them), then deactivate the person
    onDeactivate: async (u) => {
      const agents = [...state.agents.values()].filter((a) => a.owner === u.id);
      const owners = state.people.filter((x) => x.id !== u.id && !x.deactivated);
      const plan = await deactivateDialog(u, { agents, owners });
      if (!plan) return;
      // B6: the hub moves the agents (reassign_agents_to) or stops them, in the same change
      await api(`/admin/users/${encodeURIComponent(u.id)}`, 'PATCH', plan.body);
      await after();
    },
    onDismiss: () => { state.oneTimeLink = null; invalidate(); refresh(); },
  }));
}


// ---------- routing & refresh ----------

const THREAD_ROUTES = new Set(['task', 'post', 'file']);

function parseHash(hash) {
  // a notification's per-option link: "?pick=<n>" preselects that option (never sends it)
  let pick = -1;
  const q = /^(#\/(?:t|p)\/[^?]+)\?pick=([0-9])$/.exec(hash);
  if (q) { hash = q[1]; pick = Number(q[2]); }
  const r = parseHashBase(hash);
  if (pick >= 0 && (r.name === 'task' || r.name === 'post')) r.pick = pick;
  return r;
}
function parseHashBase(hash) {
  let m = hash.match(/^#\/task\/([^/?#]+)$/);
  if (m && ID_RE.test(m[1])) return { name: 'task', id: m[1] };
  // permalinks
  m = hash.match(/^#\/t\/(T-[0-9]{1,9}|[A-Za-z0-9_-]{1,64})(?:@v([0-9]{1,6}))?(?:\/m\/([A-Za-z0-9_-]{1,64}))?$/);
  if (m) return { name: 'task', id: m[1], version: m[2] ? Number(m[2]) : 0, msg: m[3] || '' };
  // Memory: #/c/<name>/memory, #/m, #/m/<slug>[@v<n>], #/m/<slug>/history[@v<n>], #/d[/<id>]
  // (#/c/<name>/wiki and #/w/... are the older links, kept as aliases)
  m = hash.match(/^#\/c\/([a-z0-9][a-z0-9_-]{0,39})\/(?:memory|wiki)$/);
  if (m) return { name: 'wiki', view: 'index', channel: m[1] };
  if (hash === '#/m' || hash === '#/m/' || hash === '#/w' || hash === '#/w/') return { name: 'wiki', view: 'index', channel: '' };
  m = hash.match(/^#\/d(?:\/([A-Za-z0-9_-]{1,64}))?$/);
  if (m) return { name: 'wiki', view: 'decisions', focus: m[1] || '' };
  m = hash.match(/^#\/[mw]\/([a-z0-9][a-z0-9-]{0,79})(\/history)?(?:@v([0-9]{1,6}))?$/);
  if (m) return { name: 'wiki', view: m[2] ? 'history' : 'page', slug: m[1], version: m[3] ? Number(m[3]) : 0 };
  m = hash.match(/^#\/[mw]\/([a-z0-9][a-z0-9-]{0,79})@v([0-9]{1,6})\/history$/);
  if (m) return { name: 'wiki', view: 'history', slug: m[1], version: Number(m[2]) };
  m = hash.match(/^#\/c\/([^/?#]+)$/);
  if (m && CHANNEL_RE.test(m[1])) return { name: 'channel', channel: m[1] };
  m = hash.match(/^#\/p\/([A-Za-z0-9_-]{1,64})$/);
  if (m) return { name: 'post', id: m[1] };
  m = hash.match(/^#\/f\/(messages|handoff_versions|posts)\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9._-]{1,255})$/);
  if (m) return { name: 'file', coll: m[1], rid: m[2], file: m[3] };
  m = hash.match(/^#\/a\/([a-z0-9][a-z0-9-]{1,40})$/);
  if (m) return { name: 'agent', id: m[1] };
  m = hash.match(/^#\/agent\/([^/?#]+)$/);
  if (m && ID_RE.test(m[1])) return { name: 'agent', id: m[1] };
  m = hash.match(/^#\/u\/([A-Za-z0-9_-]{1,64})$/);
  if (m) return { name: 'user', id: m[1] };
  m = hash.match(/^#\/search\/(.{1,600})$/);
  if (m) {
    let q = '';
    try { q = decodeURIComponent(m[1]).slice(0, 200); } catch (_) { q = ''; }
    if (q.trim()) return { name: 'search', q: q.trim() };
  }
  // the Activity page is gone: everything that needs me is in the Inbox
  if (hash === '#/inbox' || hash === '#/activity') return { name: 'inbox' };
  if (hash === '#/inbox/updates') return { name: 'inbox', tab: 'updates' };
  if (hash === '#/grants') return { name: 'grants' };
  if (hash === '#/agents' || hash === '#/settings') return { name: 'agents' };
  if (hash === '#/admin/people') return { name: 'people' };
  if (hash === '#/admin/channels') return { name: 'admin-channels' };
  if (hash === '#/admin/import') return { name: 'admin-import' };
  return { name: 'home' };
}
function currentRoute() { return parseHash(window.location.hash || '#/'); }

/**
 * Landing (#/): the Inbox when a decision waits on me that I have not seen,
 * else the last stream visited, else #general (else the Inbox). Never a dashboard.
 */
function landingHash() {
  const dr = seenDecisions();
  const unseenDecision = state.inbox.items.some((x) => LANDING_TYPES.has(x.type) && x.pending && !dr.has(String(x.id)));
  if (unseenDecision) return '#/inbox';
  const last = load(LAST_KEY) || '';
  const r = parseHash(last);
  if (r.name === 'channel' && state.channels.some((c) => c.name === r.channel)) return last;
  if (r.name === 'inbox' || r.name === 'agent' || r.name === 'user') return last;
  if (state.channels.some((c) => c.name === 'general')) return '#/c/general';
  return state.channels[0] ? `#/c/${state.channels[0].name}` : '#/inbox';
}

/** True until the first-visit landing question was answered once in this page. */
let landingAsked = false;
function firstVisitPending() {
  if (landingAsked) return false;
  landingAsked = true;
  return true;
}

async function middleMain(r) {
  if (r.name === 'inbox') await inboxMain(r.tab || '');
  else if (r.name === 'grants') await grantsMain();
  else if (r.name === 'channel') await channelMain(r.channel);
  else if (r.name === 'agent') await agentMain(r.id);
  else if (r.name === 'user') await userMain(r.id);
  else if (r.name === 'search') await searchMain(r.q);
  else if (r.name === 'wiki') await wikiMain(r);
  else if (r.name === 'agents') await agentsMain();
  else if (r.name === 'people') await peopleMain();
  else if (r.name === 'admin-channels') await channelsAdminMain();
  else if (r.name === 'admin-import') await importMain();
}

/** Settings → Import: one CLI line with a one-time admin link; the hub never fetches GitHub. */
async function importMain() {
  const sig = stableJson(['import', getLang(), isAdmin()]);
  if (sig === state.mainSig) return;
  state.mainSig = sig;
  state.composerForm = null;
  if (!isAdmin()) { swapMain(h('div', { class: 'pane' }, h('p', { class: 'error pad', text: t('not_found') }))); return; }
  swapMain(importView({
    onMakeLink: async () => {
      const r = await api('/auth/device-link', 'POST', { purpose: 'cli' });
      return r && r.url;
    },
  }), { top: true });
}

let inflight = false;
let again = false;
async function refresh() {
  // this page's document was replaced (jsdom test harnesses swap globals): stop polling
  if (root.ownerDocument !== document) { stop(); return; }
  if (!pb.authStore.isValid) { showLogin(); return; }
  if (inflight) { again = true; return; }
  inflight = true;
  try {
    if (!state.shell || !root.contains(state.shell.el)) buildShell();
    await Promise.all([loadChannels(), loadInbox(), loadNotifications()]);
    let r = currentRoute();
    const ask = firstVisitPending();
    if (r.name === 'home' || (ask && replaceableHash(window.location.hash))) {
      // a first visit after an import lands on the welcome's main channel; the
      // default landing applies only after that question is answered
      const first = ask || r.name === 'home' ? await firstLanding() : '';
      const target = first || (r.name === 'home' ? landingHash() : '');
      if (target) {
        try { window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${target}`); } catch (_) { /* jsdom */ }
        r = parseHash(target);
        if (r.name === 'home') r = { name: 'inbox' };
        noteMiddle(r, target);
      }
    }
    ctx.now = Date.now();
    const thread = THREAD_ROUTES.has(r.name) ? r : null;
    if (!thread) state.lastTaskId = null;
    state.pick = thread && thread.pick >= 0 ? { id: thread.name === 'task' ? thread.msg : thread.id, option: thread.pick } : null;
    if (thread) {
      if (thread.name === 'task') await taskThread(thread.id, { msg: thread.msg, version: thread.version });
      else if (thread.name === 'post') await postThread(thread.id);
      else await fileThread(thread);
      // opened from a permalink: the item's channel is the stream behind it
      if (!state.middle) {
        const ch = state.threadChannel && CHANNEL_RE.test(state.threadChannel) ? state.threadChannel : '';
        state.middle = ch ? { route: { name: 'channel', channel: ch }, hash: `#/c/${ch}` } : { route: { name: 'inbox' }, hash: '#/inbox' };
      }
    }
    setThreadOpen(!!thread);
    const mid = thread ? state.middle.route : r;
    await middleMain(mid);
    const sideSig = stableJson([mid, getLang(), state.workspace, state.inbox, state.inboxSeen, state.chSeen, state.channels, isAdmin(),
      [...state.agents.values()].map((a) => [a.id, a.name, a.active, isOnline(a, ctx.now)]), [...state.users.values()].map((u) => [u.id, u.name])]);
    if (sideSig !== state.sideSig) {
      state.sideSig = sideSig;
      const scroll = state.shell.side.scrollTop;
      state.shell.side.replaceChildren(...sidebar(mid).filter(Boolean));
      state.shell.side.scrollTop = scroll;
    }
    const topSig = stableJson([r.name === 'search' ? r.q : '', getLang(), load(THEME_KEY), me() && me().id, isAdmin(), ownsAgents()]);
    if (topSig !== state.topSig) {
      state.topSig = topSig;
      state.shell.top.replaceChildren(...topBar().filter(Boolean));
    }
  } catch (e) {
    if (e && e.status === 401) {
      // F9: bounced: say why on the login screen
      state.sessionMsg = errCode(e) === 'deactivated' ? t('session_deactivated') : t('session_ended');
      logout({ server: false });
      return;
    }
    if (e && e.status === 403 && errCode(e) === 'deactivated') { state.sessionMsg = t('session_deactivated'); logout({ server: false }); return; }
    const sig = `err:${errText(e)}`;
    if (state.mainSig !== sig && state.shell) { state.mainSig = sig; swapMain(h('p', { class: 'error pad', text: `${t('error')}: ${errText(e)}` })); }
  } finally {
    inflight = false;
    if (again) { again = false; setTimeout(refresh, 0); }
  }
}

/** Keep the middle stream's scroll position, per stream, for the way back. */
function rememberScroll(hash) {
  const sc = state.shell && state.shell.main.querySelector('.thread-scroll');
  if (!sc || !hash) return;
  state.scrollPos.set(hash, { top: sc.scrollTop, atBottom: sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80 });
  if (state.scrollPos.size > 50) state.scrollPos.delete(state.scrollPos.keys().next().value);
}

/** Remember the stream in the middle (kept while a thread is open; the landing next time). */
function noteMiddle(r, hash) {
  state.middle = { route: r, hash };
  if (['channel', 'inbox', 'agent', 'user'].includes(r.name)) save(LAST_KEY, hash);
}

function route() {
  const m = (window.location.hash || '').match(LOGIN_HASH_RE);
  if (m) { boot(); return; }
  if (!pb.authStore.isValid) {
    if (window.location.hash === '#/password-login') { root.replaceChildren(passwordLoginView()); return; }
  }
  const hash = window.location.hash || '#/';
  const r = parseHash(hash);
  if (r.name !== 'home' && !THREAD_ROUTES.has(r.name)) {
    const changed = !state.middle || state.middle.hash !== hash;
    if (changed && state.middle && state.shell) rememberScroll(state.middle.hash);
    noteMiddle(r, hash);
    if (changed) { state.mainSig = ''; state.divider.clear(); state.inboxDivider = null; }
  } else if (r.name === 'home') {
    state.mainSig = '';
  }
  state.threadSig = ''; state.sideSig = ''; state.topSig = ''; state.focused = '';
  setDrawer(false);
  refresh();
}

let debounce = null;
function soon() { clearTimeout(debounce); debounce = setTimeout(refresh, 300); }

async function start() {
  stop();
  if (me() && me().id) save(LAST_USER_KEY, me().id);
  state.hideBots = load('ach.hidebots') === '1';
  buildShell();
  await loadDirectory();
  await loadLimits();
  await loadSettings();
  const r = currentRoute();
  if (r.name !== 'home' && !THREAD_ROUTES.has(r.name)) noteMiddle(r, window.location.hash);
  await refresh();
  setPoll(POLL_MS);
  // relative times refresh in place every minute (no pane rebuild: playing media keeps playing)
  state.tickTimer = setInterval(() => { ctx.now = Date.now(); if (state.shell) tickTimes(state.shell.el, ctx.now); }, TICK_MS);
  // realtime: SSE when it connects within 3 s, else long poll, else plain polling (a
  // proxy such as a Cloudflare quick tunnel can buffer SSE so events never arrive)
  state.rtStop = startRealtime({
    pb, api, onChange: () => { loadDirectory().then(soon); },
    onMode: (m) => { state.rtMode = m; setPoll(m === 'poll' ? POLL_MS : SAFETY_POLL_MS); },
  });
  for (const c of ['tasks', 'messages', 'handoff_versions', 'posts', 'channels']) {
    try { state.unsub.push(await pb.collection(c).subscribe('*', soon)); } catch (_) { /* polling covers it */ }
  }
}

function setPoll(ms) {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => { if (!document.hidden) { loadDirectory().then(refresh); } }, ms);
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !state.shell || !state.shell.thread.classList.contains('open')) return;
  if (document.querySelector('.modal, .lightbox')) return;
  closeThread();
});
function stop() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
  clearInterval(state.tickTimer);
  state.tickTimer = null;
  for (const u of state.unsub) { try { u(); } catch (_) { /* ignore */ } }
  state.unsub = [];
  if (state.rtStop) { state.rtStop(); state.rtStop = null; }
}

/**
 * Log out here, or everywhere (B4: POST /auth/logout {everywhere}). The server
 * call is best effort; behind Cloudflare Access the response names the Access
 * logout URL, which ends that session too.
 */
async function logout(o = {}) {
  let cfUrl = '';
  if (o.server !== false && pb.authStore.isValid) {
    try {
      const r = await api('/auth/logout', 'POST', { everywhere: !!o.everywhere });
      const u = r && r.cf_logout_url;
      if (typeof u === 'string' && /^https:\/\/[^\s"'<>`]+$/.test(u)) cfUrl = u;
    } catch (_) { /* local logout still happens */ }
  }
  stop();
  pb.authStore.clear();
  state.meInfo = null;
  invalidate();
  state.oneTimeKey = null;
  state.oneTimeLink = null;
  state.people = [];
  state.files.clear();
  if (cfUrl) { window.location.href = cfUrl; return; }
  showLogin();
}

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
document.documentElement.lang = getLang() === 'zh' ? 'zh-CN' : 'en';
applyTheme();
try {
  // follow the system theme live until the person picks one
  const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  if (mq && mq.addEventListener) mq.addEventListener('change', () => { applyTheme(); state.sideSig = ''; });
} catch (_) { /* old browsers */ }

/**
 * Startup: a #/login/<token> link is exchanged (and removed from the
 * address bar and history first); else a stored session is refreshed; else,
 * behind Cloudflare Access, the Access identity logs in silently; else the
 * login screen.
 */
async function boot() {
  const m = (window.location.hash || '').match(LOGIN_HASH_RE);
  if (m) {
    try { window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/`); } catch (_) { window.location.hash = '#/'; }
    try {
      await exchangeLink(m[1]);
      state.sessionMsg = '';
      start();
    } catch (e) {
      await loadAuthConfig();
      if (pb.authStore.isValid) { start(); return; } // a bad link never logs out the current session
      showLogin(loginErrText(e));
    }
    return;
  }
  if (pb.authStore.isValid) {
    try {
      await pb.collection('users').authRefresh();
      start();
      return;
    } catch (e) {
      // F9: a stored session that no longer works was ended (or the account deactivated)
      if (e && (e.status === 401 || e.status === 403)) state.sessionMsg = errCode(e) === 'deactivated' ? t('session_deactivated') : t('session_ended');
      pb.authStore.clear();
    }
  }
  const cfg = await loadAuthConfig();
  let cfErr = '';
  if (cfg.cf) {
    try {
      const r = await pb.send('/api/ach/auth/cf', { method: 'POST' });
      pb.authStore.save(r.token, r.record);
      state.sessionMsg = '';
      start();
      return;
    } catch (e) { cfErr = cfErrText(e); }
  }
  if (window.location.hash === '#/password-login') { root.replaceChildren(passwordLoginView()); return; }
  showLogin(cfErr);
}

/**
 * F8: "Cloudflare login did not work" only when Access actually said something
 * (not invited, deactivated, a bad token); a missing header (opened outside
 * Access, 401) shows nothing.
 */
function cfErrText(e) {
  const code = errCode(e);
  if (!e || e.status === 401 || e.status === 404 || code === 'unauthorized' || code === 'not_configured' || code === 'no_header' || code === 'cf_missing') return '';
  return `${t('cf_refused')}: ${errText(e)}`;
}

boot();

// The onboarding welcome view (onboard.js) adds itself to the user menu; it is
// imported at the top for firstLanding().
