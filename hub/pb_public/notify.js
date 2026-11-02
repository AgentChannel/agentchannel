// Notifications in the panel: the Inbox's "Updates" list (FYI; "Needs me" stays
// inbox.js), the channel bell (all / important / off, plus the channel's hooks
// and incoming URL), follow toggles on items, notification settings (digest
// time, Web Push, personal hooks), and the realtime fallback (SSE -> long poll
// -> plain polling). Pure DOM builders plus small async helpers; the hub
// routes are in pb_hooks/ach_notify.js and ach_hooks.js.

import { h, agoSpan, parseDate } from './render.js';
import { t } from './i18n.js';

const LEVELS = ['all', 'important', 'off'];
const PRESETS = ['feishu', 'dingtalk', 'wecom', 'slack', 'discord', 'telegram', 'ntfy', 'bark', 'pushover', 'json'];
const SAFE_HASH = /^#\/[A-Za-z0-9_/@.%-]*$/;

function hashOfPath(path) {
  const s = `#/${String(path || '')}`;
  return SAFE_HASH.test(s) ? s : '#/inbox';
}

/** The two Inbox tabs: Needs me (reply-needed) and Updates (FYI). */
export function inboxTabs(tab, counts = {}) {
  const one = (key, href, n, on) => h('a', { class: 'tab ib-tab' + (on ? ' active' : ''), href, attrs: { 'aria-pressed': on ? 'true' : 'false' } },
    t(key), n ? h('span', { class: 'tab-count', text: String(n) }) : null);
  return h('nav', { class: 'tabs inbox-tabs', attrs: { 'aria-label': t('inbox') } },
    one('nt_needs_me', '#/inbox', counts.needs, tab !== 'updates'),
    one('nt_updates', '#/inbox/updates', counts.updates, tab === 'updates'));
}

/** Updates newer than `seen` (the tab's count). */
export function updatesUnread(items, seen) {
  return (items || []).filter((x) => x && String(x.at || '') > String(seen || '')).length;
}

function eventWord(x) {
  const k = `ne_${x.event}`;
  const s = t(k);
  return s === k ? String(x.text || x.event || '') : s;
}

/** One update row: what happened, where, the title (a link to the item), detail, when. */
export function updateRow(x, ctx, o = {}) {
  const href = hashOfPath(x.path);
  const unread = !!(o.unreadAfter && String(x.at || '') > String(o.unreadAfter));
  return h('div', { class: 'msg update-item' + (x.needs_me ? ' mine' : '') + (unread ? ' unread' : ''), attrs: { 'data-id': String(x.id || ''), 'data-type': String(x.event || '') } },
    h('div', { class: 'msg-main' },
      h('div', { class: 'msg-head' },
        h('span', { class: 'what ev-' + String(x.event || '').replace(/[^a-z_]/g, ''), text: eventWord(x) }),
        x.channel_name ? h('a', { class: 'ib-ctx', href: `#/c/${encodeURIComponent(x.channel_name)}`, text: `#${x.channel_name}` }) : null,
        x.needs_me ? h('span', { class: 'tag', text: t('nt_for_you') }) : null,
        agoSpan(x.at, ctx.now)),
      h('a', { class: 'update-title', href, text: String(x.title || '') }),
      x.detail ? h('div', { class: 'ib-text muted', text: String(x.detail) }) : null));
}

/** The Updates list (rows newest first, with the same "since yesterday" divider as Needs me). */
export function updatesList(items, ctx, o = {}) {
  const dayAgo = ctx.now - 24 * 3600 * 1000;
  const rows = [];
  let section = '';
  for (const x of items || []) {
    if (!x || typeof x !== 'object') continue;
    const d = parseDate(x.at);
    const s = d && d.getTime() >= dayAgo ? 'recent' : 'earlier';
    if (s !== section) {
      section = s;
      rows.push(h('div', { class: 'day-sep inbox-sep', attrs: { role: 'separator' } }, h('span', { text: s === 'recent' ? t('since_yesterday') : t('earlier') })));
    }
    rows.push(updateRow(x, ctx, o));
  }
  return rows.length ? rows : [h('div', { class: 'empty-state muted', text: t('nt_empty') })];
}

// ---------- settings: digest, Web Push, personal hooks ----------

function errText(e) { return (e && (e.response && e.response.error)) || (e && e.message) || String(e); }

/** The browser's UTC offset (minutes east) and zone name. */
export function localZone() {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { tz = ''; }
  return { tz: /^[A-Za-z0-9_+/-]{1,64}$/.test(tz) ? tz : '', tz_offset: -new Date().getTimezoneOffset() };
}

function hookRow(x, o) {
  const status = h('span', { class: 'muted small' });
  const act = (label, fn) => h('button', { class: 'btn link', attrs: { type: 'button' }, text: label, on: { click: async () => { status.textContent = '…'; try { status.textContent = (await fn()) || t('done'); } catch (e) { status.textContent = `${t('error')}: ${errText(e)}`; } } } });
  return h('div', { class: 'hook-row' + (x.status === 'broken' ? ' broken' : ''), attrs: { 'data-id': String(x.id) } },
    h('span', { class: 'hook-name', text: `${x.name || x.preset}` }),
    h('span', { class: 'tag', text: x.preset }),
    x.channel_name ? h('span', { class: 'muted small', text: `#${x.channel_name}` }) : null,
    h('span', { class: 'muted small', text: x.url_hint || '' }),
    x.status !== 'active' ? h('span', { class: 'hook-status error', text: t(`nt_hook_${x.status}`) }) : null,
    x.status === 'broken' && x.last_error ? h('span', { class: 'muted small', text: x.last_error }) : null,
    act(t('nt_test'), async () => { const r = await o.api(`/hooks/${encodeURIComponent(x.id)}/test`, 'POST', {}); o.changed && o.changed(); return r.ok ? t('nt_test_ok') : `${t('nt_test_failed')}: ${r.error}`; }),
    act(t('nt_remove'), async () => { await o.api(`/hooks/${encodeURIComponent(x.id)}`, 'DELETE'); o.changed && o.changed(); return t('done'); }),
    status);
}

/** Add-a-hook form. o: {api, scope, channel, changed} */
export function hookForm(o) {
  const preset = h('select', { class: 'input', attrs: { 'aria-label': t('nt_preset') } }, PRESETS.map((p) => h('option', { attrs: { value: p }, text: t(`np_${p}`) })));
  const url = h('input', { class: 'input', attrs: { type: 'url', placeholder: t('nt_hook_url'), 'aria-label': t('nt_hook_url'), autocomplete: 'off', maxlength: 1000 } });
  const extra = h('input', { class: 'input', attrs: { type: 'text', placeholder: '', 'aria-label': t('nt_hook_extra'), autocomplete: 'off', hidden: true, maxlength: 200 } });
  const extra2 = h('input', { class: 'input', attrs: { type: 'text', placeholder: t('np_pushover_user'), 'aria-label': t('np_pushover_user'), autocomplete: 'off', hidden: true, maxlength: 200 } });
  const status = h('div', { class: 'muted small', attrs: { 'aria-live': 'polite' } });
  const sync = () => {
    const p = preset.value;
    extra.hidden = p !== 'telegram' && p !== 'pushover';
    extra2.hidden = p !== 'pushover';
    extra.setAttribute('placeholder', p === 'telegram' ? t('np_telegram_chat') : t('np_pushover_token'));
  };
  preset.addEventListener('change', sync);
  return h('form', {
    class: 'hook-form',
    on: {
      submit: async (e) => {
        e.preventDefault();
        const p = preset.value;
        const config = p === 'telegram' ? { chat_id: extra.value.trim() } : p === 'pushover' ? { token: extra.value.trim(), user: extra2.value.trim() } : undefined;
        status.textContent = '…';
        try {
          const r = await o.api('/hooks', 'POST', { scope: o.scope || 'personal', channel: o.channel, preset: p, url: url.value.trim(), name: t(`np_${p}`), config });
          status.textContent = t('nt_hook_added', { secret: (r && r.hook && r.hook.secret) || '' });
          url.value = '';
          o.changed && o.changed();
        } catch (err) { status.textContent = `${t('error')}: ${errText(err)}`; }
      },
    },
  }, preset, url, extra, extra2, h('button', { class: 'btn', attrs: { type: 'submit' }, text: t('nt_add_hook') }), status);
}

/** Web Push on this device: service worker + subscription; the read key goes to the worker. */
export async function enablePush(api) {
  const nav = globalThis.navigator;
  if (!nav || !nav.serviceWorker || !globalThis.PushManager || !globalThis.Notification) throw new Error(t('nt_push_unsupported'));
  const perm = await globalThis.Notification.requestPermission();
  if (perm !== 'granted') throw new Error(t('nt_push_denied'));
  const reg = await nav.serviceWorker.register('sw.js');
  await nav.serviceWorker.ready;
  const { public_key: key } = await api('/push/vapid');
  const raw = atob(String(key).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(key).length % 4)) % 4));
  const appKey = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey }));
  const r = await api('/push/subscribe', 'POST', { endpoint: sub.endpoint });
  const worker = reg.active || (await nav.serviceWorker.ready).active;
  if (worker) worker.postMessage({ type: 'ach-push-key', key: r.read_key });
  return true;
}

/**
 * Notification settings (inside the Updates tab, collapsed). data: {prefs, hooks}.
 * o: {api, changed, openKey}
 */
export function notifySettings(data, o) {
  const prefs = (data && data.prefs) || {};
  const hooks = ((data && data.hooks) || []).filter((x) => x.scope === 'personal');
  const time = h('input', { class: 'input', attrs: { type: 'time', value: prefs.digest_time || '', 'aria-label': t('nt_digest_time') } });
  const saved = h('span', { class: 'muted small', attrs: { 'aria-live': 'polite' } });
  const pushStatus = h('span', { class: 'muted small', attrs: { 'aria-live': 'polite' } });
  const zone = localZone();
  return h('details', { class: 'notify-settings', attrs: { 'data-key': 'notify-settings' } },
    h('summary', { text: t('nt_settings') }),
    h('div', { class: 'ns-row' },
      h('label', { text: t('nt_digest_time') }), time,
      h('span', { class: 'muted small', text: zone.tz || `UTC${zone.tz_offset >= 0 ? '+' : ''}${zone.tz_offset / 60}` }),
      h('button', {
        class: 'btn', attrs: { type: 'button' }, text: t('save'),
        on: { click: async () => { try { await o.api('/me/notify-prefs', 'PUT', { digest_time: time.value, ...zone }); saved.textContent = t('done'); o.changed && o.changed(); } catch (e) { saved.textContent = `${t('error')}: ${errText(e)}`; } } },
      }), saved),
    h('div', { class: 'muted small', text: prefs.digest_time ? t('nt_digest_hint', { time: prefs.digest_time }) : t('nt_digest_off') }),
    h('div', { class: 'ns-row' },
      h('button', {
        class: 'btn', attrs: { type: 'button' }, text: t('nt_push_enable'),
        on: { click: async () => { pushStatus.textContent = '…'; try { await enablePush(o.api); pushStatus.textContent = t('nt_push_on'); } catch (e) { pushStatus.textContent = errText(e); } } },
      }), pushStatus),
    h('div', { class: 'ns-head', text: t('nt_my_hooks') }),
    prefs.webhook_set ? h('div', { class: 'muted small', text: t('nt_profile_webhook') }) : null,
    hooks.map((x) => hookRow(x, o)),
    hookForm({ api: o.api, scope: 'personal', changed: o.changed }));
}

// ---------- channel bell ----------

/** The channel header bell: notification level, and (members/admins) the channel's hooks and incoming URL. */
export function channelBell(channel, level, o) {
  const cur = LEVELS.includes(level) ? level : 'important';
  const extra = h('div', { class: 'bell-extra' });
  const loadExtra = async () => {
    if (!o.manage) return;
    let hooks = [];
    let inbound = [];
    try { hooks = ((await o.api('/hooks')).hooks || []).filter((x) => x.scope === 'channel' && x.channel === channel.id); } catch (_) { hooks = []; }
    try { inbound = (await o.api(`/channels/${encodeURIComponent(channel.name)}/inbound`)).inbound || []; } catch (_) { inbound = []; }
    const shown = h('div', { class: 'inbound-new' });
    extra.replaceChildren(...[
      h('div', { class: 'ns-head', text: t('nt_channel_hooks') }),
      hooks.map((x) => hookRow(x, { api: o.api, changed: loadExtra })),
      hookForm({ api: o.api, scope: 'channel', channel: channel.name, changed: loadExtra }),
      h('div', { class: 'ns-head', text: t('nt_inbound') }),
      h('div', { class: 'muted small', text: t('nt_inbound_hint') }),
      inbound.map((x) => h('div', { class: 'hook-row', attrs: { 'data-id': x.id } },
        h('span', { class: 'hook-name', text: x.name }), h('code', { text: `${x.token_prefix}…` }),
        h('button', { class: 'btn link', attrs: { type: 'button' }, text: t('nt_rotate'), on: { click: async () => { const r = await o.api(`/inbound-hooks/${encodeURIComponent(x.id)}/rotate`, 'POST', {}); shown.replaceChildren(h('code', { class: 'key', text: r.inbound.url })); } } }),
        h('button', { class: 'btn link', attrs: { type: 'button' }, text: t('nt_remove'), on: { click: async () => { await o.api(`/inbound-hooks/${encodeURIComponent(x.id)}`, 'DELETE'); loadExtra(); } } }))),
      h('button', {
        class: 'btn', attrs: { type: 'button' }, text: t('nt_inbound_new'),
        on: { click: async () => { const r = await o.api(`/channels/${encodeURIComponent(channel.name)}/inbound`, 'POST', { name: 'incoming' }); shown.replaceChildren(h('div', { class: 'muted small', text: t('nt_inbound_once') }), h('code', { class: 'key', text: r.inbound.url })); } },
      }),
      shown].flat());
  };
  const det = h('details', { class: 'bell', attrs: { 'data-key': `bell:${channel.id}` } },
    h('summary', { class: 'btn link bell-btn', attrs: { 'aria-label': t('nt_bell'), title: t('nt_bell') }, text: `${t('nt_bell')}: ${t(`nl_${cur}`)}` }),
    h('div', { class: 'menu bell-menu' },
      LEVELS.map((l) => h('button', {
        class: 'menu-item level' + (l === cur ? ' on' : ''), attrs: { type: 'button', 'aria-pressed': l === cur ? 'true' : 'false', 'data-key': l },
        on: { click: async () => { await o.api('/me/notify-prefs', 'PUT', { channel: channel.name, level: l }); o.changed && o.changed(); } },
      }, h('span', { text: t(`nl_${l}`) }), h('span', { class: 'muted small', text: t(`nl_${l}_hint`) }))),
      extra));
  let loaded = false;
  det.addEventListener('toggle', () => { if (det.open && !loaded) { loaded = true; loadExtra(); } });
  return det;
}

// ---------- follow ----------

const followCache = new Map();

/** Follow / unfollow an item (post or task). o: {api} */
export function followToggle(kind, id, o) {
  const key = `${kind}:${id}`;
  const btn = h('button', { class: 'btn link follow-btn', attrs: { type: 'button', 'aria-pressed': 'false' }, text: t('nt_follow') });
  const paint = (st) => {
    if (!st) return;
    followCache.set(key, st);
    btn.textContent = st.following ? t('nt_following') : t('nt_follow');
    btn.setAttribute('aria-pressed', st.following ? 'true' : 'false');
    btn.classList.toggle('on', !!st.following);
  };
  paint(followCache.get(key));
  o.api(`/follows/${kind}/${encodeURIComponent(id)}`).then(paint).catch(() => { btn.hidden = true; });
  btn.addEventListener('click', async () => {
    const st = followCache.get(key) || { following: false };
    try { paint(await o.api(`/follows/${kind}/${encodeURIComponent(id)}`, 'PUT', { on: !st.following })); } catch (_) { /* unchanged */ }
  });
  return btn;
}

/** An "Announce" toggle for a channel composer (notifies every reader of the channel). */
export function announceToggle(get, set) {
  const box = h('input', { attrs: { type: 'checkbox', id: 'announce-next', checked: !!get() } });
  box.addEventListener('change', () => set(box.checked));
  return h('label', { class: 'announce-toggle small', attrs: { for: 'announce-next', title: t('nt_announce_hint') } }, box, ' ', t('nt_announce'));
}

// ---------- realtime fallback ----------

/**
 * Realtime with fallbacks: PocketBase SSE when it connects within `sseMs`;
 * otherwise long-poll GET /api/ach/changes (returns as soon as something changed,
 * or after 25 s); when that fails too, plain polling (the caller's timer).
 * o: {pb, api, onChange, onMode(mode), sseMs = 3000, wait = 25}. Returns stop().
 */
export function startRealtime(o) {
  let stopped = false;
  let mode = '';
  let lpRunning = false;
  let unsub = null;
  const set = (m) => { if (m === mode || stopped) return; mode = m; try { document.documentElement.setAttribute('data-realtime', m); } catch (_) { /* no document */ } o.onMode && o.onMode(m); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const longPoll = async () => {
    if (lpRunning) return;
    lpRunning = true;
    set('longpoll');
    let cursor = '';
    let fails = 0;
    while (!stopped && mode === 'longpoll') {
      try {
        const q = cursor ? `?since=${encodeURIComponent(cursor)}&wait=${o.wait || 25}` : '';
        const r = await o.api(`/changes${q}`);
        fails = 0;
        if (cursor && r && r.changed) o.onChange();
        if (r && typeof r.cursor === 'string') cursor = r.cursor;
      } catch (e) {
        fails++;
        if ((e && (e.status === 404 || e.status === 401 || e.status === 403)) || fails >= 3) { set('poll'); break; }
        await sleep(2000);
      }
    }
    lpRunning = false;
  };
  const timer = setTimeout(() => { if (!stopped && mode !== 'sse') longPoll(); }, o.sseMs ?? 3000);
  try {
    Promise.resolve(o.pb.realtime.subscribe('PB_CONNECT', () => { clearTimeout(timer); set('sse'); }))
      .then((u) => { if (stopped) { try { u(); } catch (_) { /* ignore */ } } else unsub = u; })
      .catch(() => { clearTimeout(timer); longPoll(); });
  } catch (_) { clearTimeout(timer); longPoll(); }
  return () => {
    stopped = true;
    clearTimeout(timer);
    if (unsub) { try { unsub(); } catch (_) { /* ignore */ } }
  };
}
