// Admin "Deployment check" (GET /api/ach/admin/deploy-check, docs/deploy.md).
// Adds a small section under the settings tabs on admin settings pages
// (#/admin/...). Self-contained: watches the DOM, renders from a cached result
// (refreshed at most once a minute), never touches app.js state.
import PocketBase from './vendor/pocketbase.es.js';
import { h } from './render.js';
import { getLang } from './i18n.js';

const ID = 'ach-deploycheck';
const TTL_MS = 60 * 1000;
const SECTIONS = [
  ['public_url', { en: 'Public URL (required)', zh: '公开地址（必需）' }],
  ['delivery', { en: 'Link delivery (optional adapters)', zh: '链接发送（可选适配器）' }],
  ['front_door', { en: 'Front door (optional)', zh: '前门（可选）' }],
  ['hygiene', { en: 'Backup, storage, test hooks', zh: '备份、存储、测试接口' }],
];
let pb = null; // created on first use, for the page's own origin
let doc = null; // the document this module watches
let cache = null; // { at, data } | { at, denied: true }
let loading = false;

const L = () => (getLang() === 'zh' ? 'zh' : 'en');

function client() {
  if (!pb) pb = new PocketBase(window.location.origin);
  return pb;
}

async function load() {
  if (loading || (cache && Date.now() - cache.at < TTL_MS)) return;
  loading = true;
  try {
    const data = await client().send('/api/ach/admin/deploy-check', { method: 'GET' });
    cache = { at: Date.now(), data };
  } catch (_) {
    cache = { at: Date.now(), denied: true };
  } finally {
    loading = false;
  }
  if (!live()) return;
  doc.getElementById(ID)?.remove();
  mount();
}

/** Still the page we were loaded into (tests load the panel into several documents). */
function live() {
  return !!doc && typeof document !== 'undefined' && document === doc && typeof window !== 'undefined';
}

function view(data) {
  const lang = L();
  const groups = SECTIONS.map(([sec, label]) => {
    const items = data.items.filter((i) => i.section === sec);
    if (!items.length) return null;
    return h('div', { class: 'deploycheck-group' },
      h('div', { class: 'small muted', text: label[lang] }),
      ...items.map((i) => h('div', { class: 'small' },
        h('span', { class: i.status === 'fail' ? 'error' : 'muted', text: `[${i.status}] ` }),
        h('span', { text: (i.impact && i.impact[lang]) || '' }))));
  });
  const el = h('section', { attrs: { id: ID, 'aria-label': 'Deployment check' } },
    h('h2', { class: 'small', text: lang === 'zh' ? '部署检查' : 'Deployment check' }),
    ...groups,
    h('div', { class: 'small muted', text: `${lang === 'zh' ? '版本' : 'version'} ${data.version}` }));
  el.style.margin = '12px 0'; el.style.display = 'flex'; el.style.flexDirection = 'column'; el.style.gap = '6px';
  return el;
}

function mount() {
  if (!live()) return;
  if (!/^#\/admin\//.test(window.location.hash || '')) return;
  if (doc.getElementById(ID)) return;
  const tabs = doc.querySelector('nav.tabs');
  if (!tabs || !client().authStore.isValid) return;
  if (!cache || Date.now() - cache.at >= TTL_MS) { load(); if (!cache) return; }
  if (cache.denied) return;
  tabs.insertAdjacentElement('afterend', view(cache.data));
}

function init() {
  const MO = (typeof window !== 'undefined' && window.MutationObserver) || globalThis.MutationObserver;
  if (!MO || typeof document === 'undefined' || !document.documentElement) return;
  doc = document;
  new MO(() => mount()).observe(doc.documentElement, { childList: true, subtree: true });
  window.addEventListener('hashchange', () => setTimeout(mount, 0));
}

if (typeof document !== 'undefined') init();
