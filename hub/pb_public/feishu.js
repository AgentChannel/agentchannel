// Settings > People > Feishu/Lark (optional adapter; API.md "Feishu adapter").
// Self-contained like deploycheck.js: on #/admin/people it adds a section with
// the adapter status, the callback URL, the person <-> Feishu mapping list
// (with unmap / block), a "map a person" form (Feishu email lookup) and "send a
// login link by Feishu DM". Never touches app.js state; renders from the API.
import PocketBase from './vendor/pocketbase.es.js';
import { h } from './render.js';
import { getLang } from './i18n.js';

const ID = 'ach-feishu';
const W = {
  en: {
    title: 'Feishu / Lark', off: 'Not configured (optional). See docs/feishu.md.', ready: 'Connected', notReady: 'Incomplete',
    needs: 'Missing: ', callback: 'Event + card callback URL', region: 'Region', mapped: 'Mapped people', pending: 'Wrote to the bot, not mapped',
    none: 'Nobody yet.', unmap: 'Unmap', block: 'Block', person: 'Person', email: 'Feishu email (optional)', map: 'Map', invite: 'Send login link by Feishu',
    sent: 'Sent.', how: { admin: 'admin', email: 'email match', import: 'import' }, check: 'Test credentials', ok: 'OK', mapTo: 'Map to…',
  },
  zh: {
    title: '飞书 / Lark', off: '未配置（可选）。见 docs/feishu.md。', ready: '已连接', notReady: '未完成',
    needs: '缺少：', callback: '事件与卡片回调地址', region: '区域', mapped: '已对应的人', pending: '给机器人发过消息、尚未对应',
    none: '暂无。', unmap: '取消对应', block: '屏蔽', person: '成员', email: '飞书邮箱（可选）', map: '对应', invite: '通过飞书发登录链接',
    sent: '已发送。', how: { admin: '管理员确认', email: '邮箱匹配', import: '导入' }, check: '测试凭据', ok: '正常', mapTo: '对应到…',
  },
};
let pb = null;
let doc = null;
let busy = false;
let skipUntil = 0; // after an "off" answer (or a refusal), look again at most once a minute

const L = () => (getLang() === 'zh' ? 'zh' : 'en');
function client() { if (!pb) pb = new PocketBase(window.location.origin); return pb; }
function live() { return !!doc && typeof document !== 'undefined' && document === doc && typeof window !== 'undefined'; }
const errOf = (ex) => String((ex && ex.response && (ex.response.error || ex.response.message)) || (ex && ex.message) || ex);

/**
 * The section (pure view). data: GET /api/ach/admin/feishu; people: [{id, name, email}];
 * act: {map(user, email, open_id), unmap(id, block), invite(user), check()} returning promises.
 */
export function feishuSection(data, people, act, lang = L()) {
  const w = W[lang] || W.en;
  const status = h('div', { class: 'small muted', attrs: { role: 'status' } });
  const run = (p, okText) => p.then(() => { status.textContent = okText || ''; }, (ex) => { status.textContent = errOf(ex); });
  const head = h('h2', { class: 'small', text: w.title });
  if (!data || (!data.configured && !(data.mappings || []).length)) {
    return h('section', { attrs: { id: ID, 'aria-label': w.title } }, head, h('div', { class: 'small muted', text: w.off }));
  }
  const missing = Object.keys(data.set || {}).filter((k) => !data.set[k]);
  const state = h('div', { class: 'small' },
    h('span', { class: data.ready ? 'muted' : 'error', text: `[${data.ready ? w.ready : w.notReady}] ` }),
    h('span', { text: `${w.region}: ${data.region === 'lark' ? 'Lark' : 'Feishu'}` }),
    missing.length ? h('span', { class: 'error', text: ` · ${w.needs}${missing.join(', ')}` }) : null);
  const cb = data.callback_url ? h('div', { class: 'small' }, h('span', { class: 'muted', text: `${w.callback}: ` }), h('code', { text: data.callback_url })) : null;
  const pname = (x) => x.user_name || x.user_email || x.user;
  const row = (x) => h('li', { class: 'small', attrs: { 'data-id': x.id } },
    h('span', { text: x.status === 'mapped' ? `${pname(x)} ↔ ${x.name || x.email || x.open_id}` : `${x.name || x.open_id}${x.email ? ` <${x.email}>` : ''}` }),
    x.how ? h('span', { class: 'muted', text: ` [${w.how[x.how] || x.how}]` }) : null,
    x.status === 'blocked' ? h('span', { class: 'error', text: ` [${w.block}]` }) : null,
    x.status === 'mapped' ? h('button', { class: 'btn', attrs: { type: 'button', 'data-key': 'unmap' }, text: w.unmap, on: { click: () => run(act.unmap(x.id, false)) } }) : null,
    x.status === 'pending' ? pendingMap(x) : null,
    x.status !== 'blocked' ? h('button', { class: 'btn', attrs: { type: 'button', 'data-key': 'block' }, text: w.block, on: { click: () => run(act.unmap(x.id, true)) } }) : null);
  const personSelect = (label) => h('select', { attrs: { 'aria-label': label } },
    h('option', { attrs: { value: '' }, text: label }),
    ...(people || []).map((p) => h('option', { attrs: { value: p.id }, text: p.email ? `${p.name} <${p.email}>` : p.name })));
  function pendingMap(x) {
    const sel = personSelect(w.mapTo);
    sel.addEventListener('change', () => { if (sel.value) run(act.map(sel.value, '', x.open_id)); });
    return sel;
  }
  const list = (items) => (items.length ? h('ul', { class: 'plain' }, ...items.map(row)) : h('div', { class: 'small muted', text: w.none }));
  const who = personSelect(w.person);
  const email = h('input', { attrs: { type: 'email', placeholder: w.email, 'aria-label': w.email, maxlength: 200 } });
  const form = h('div', { class: 'fields' }, who, email,
    h('button', { class: 'btn primary', attrs: { type: 'button', 'data-key': 'map' }, text: w.map, on: { click: () => { if (who.value) run(act.map(who.value, email.value.trim(), '')); } } }),
    h('button', { class: 'btn', attrs: { type: 'button', 'data-key': 'invite' }, text: w.invite, on: { click: () => { if (who.value) run(act.invite(who.value), w.sent); } } }),
    h('button', { class: 'btn', attrs: { type: 'button', 'data-key': 'check' }, text: w.check, on: { click: () => run(act.check(), w.ok) } }));
  const el = h('section', { attrs: { id: ID, 'aria-label': w.title } },
    head, state, cb,
    h('div', { class: 'small muted', text: w.mapped }), list(data.mappings || []),
    (data.pending || []).length ? h('div', { class: 'small muted', text: w.pending }) : null,
    (data.pending || []).length ? list(data.pending) : null,
    data.ready ? form : null, status);
  el.style.margin = '12px 0'; el.style.display = 'flex'; el.style.flexDirection = 'column'; el.style.gap = '6px';
  return el;
}

async function load() {
  const c = client();
  const data = await c.send('/api/ach/admin/feishu', { method: 'GET' });
  let people = [];
  try {
    const r = await c.send('/api/ach/admin/users', { method: 'GET' });
    people = (Array.isArray(r) ? r : r.users || r.items || []).filter((u) => !u.deactivated).map((u) => ({ id: u.id, name: u.name || u.email, email: u.email || '' }));
  } catch (_) { /* the list is optional */ }
  return { data, people };
}

function actions() {
  const c = client();
  const after = async (p) => { const r = await p; refresh(); return r; };
  return {
    map: (user, email, open_id) => after(c.send('/api/ach/admin/feishu/mappings', { method: 'POST', body: { user, ...(email ? { email } : {}), ...(open_id ? { open_id } : {}) } })),
    unmap: (id, block) => after(c.send(`/api/ach/admin/feishu/mappings/${encodeURIComponent(id)}${block ? '?block=1' : ''}`, { method: 'DELETE' })),
    invite: (user) => c.send('/api/ach/admin/feishu/invite', { method: 'POST', body: { user } }),
    check: () => c.send('/api/ach/admin/feishu/check', { method: 'POST' }),
  };
}

async function refresh() {
  if (!live()) return;
  try {
    const { data, people } = await load();
    if (!live() || !/^#\/admin\/people/.test(window.location.hash || '')) return;
    // an unused optional adapter adds nothing to the page (the deployment check already says so)
    if (!data.configured && !(data.mappings || []).length && !(data.pending || []).length) { skipUntil = Date.now() + 60000; return; }
    const old = doc.getElementById(ID);
    const next = feishuSection(data, people, actions());
    if (old) old.replaceWith(next);
    else {
      const anchor = doc.getElementById('ach-deploycheck') || doc.querySelector('nav.tabs');
      if (anchor) anchor.insertAdjacentElement('afterend', next);
    }
  } catch (_) { skipUntil = Date.now() + 60000; /* not an admin, or the hub is older: no section */ }
}

function mount() {
  if (!live() || busy || Date.now() < skipUntil) return;
  if (!/^#\/admin\/people/.test(window.location.hash || '')) return;
  if (doc.getElementById(ID) || !doc.querySelector('nav.tabs') || !client().authStore.isValid) return;
  busy = true;
  refresh().finally(() => { busy = false; });
}

function init() {
  const MO = (typeof window !== 'undefined' && window.MutationObserver) || globalThis.MutationObserver;
  if (!MO || typeof document === 'undefined' || !document.documentElement) return;
  doc = document;
  new MO(() => mount()).observe(doc.documentElement, { childList: true, subtree: true });
  window.addEventListener('hashchange', () => setTimeout(mount, 0));
}

if (typeof document !== 'undefined') init();
