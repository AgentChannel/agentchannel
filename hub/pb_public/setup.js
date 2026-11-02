// First-run setup (docs/deploy.md): the hub prints a one-time link
// "<url>/#/setup/<token>" in its log until the first admin exists. Opening it
// shows name + optional email; submitting creates the first admin and saves
// the session (the same PocketBase auth store app.js reads), then reloads.
// Self-contained: app.js only imports this module. It also loads the admin
// deployment check (deploycheck.js).
import PocketBase from './vendor/pocketbase.es.js';
import { h } from './render.js';
import { getLang } from './i18n.js';
import './deploycheck.js';
import './feishu.js'; // optional Feishu/Lark adapter section (Settings > People)

// any token the hub accepts: ach_su_… or a custom ACH_SETUP_TOKEN (32-128 of A-Za-z0-9_-)
const SETUP_RE = /^#\/setup\/(ach_su_[A-Za-z0-9]{40}|[A-Za-z0-9_-]{32,128})$/;

const TXT = {
  en: {
    title: 'Set up this hub',
    lead: 'You are the first person here. This creates the admin account; then invite your team with one-time links.',
    name: 'Your name', email: 'Email (optional)', go: 'Create admin and log in',
    done: 'This hub is already set up. Ask an admin for a link.',
    invalid: 'This setup link is not valid. Use the newest link from the hub log (a new one is printed on every start).',
    expired: 'This setup link expired — restart the hub to print a new one.',
    fail: 'Setup failed',
  },
  zh: {
    title: '初始化这个 hub',
    lead: '你是第一个使用者。这里会创建管理员账号，之后用一次性链接邀请团队成员。',
    name: '你的名字', email: '邮箱（可选）', go: '创建管理员并登录',
    done: '这个 hub 已经初始化过了，请向管理员要一个链接。',
    invalid: '这个初始化链接无效。请使用 hub 日志里最新的链接（每次启动都会打印新的）。',
    expired: '这个初始化链接已过期：重启 hub 会打印一个新的。',
    fail: '初始化失败',
  },
};
const tx = (k) => (TXT[getLang()] || TXT.en)[k];

function overlay(...children) {
  const el = h('div', { class: 'setup-overlay', attrs: { id: 'ach-setup' } }, ...children);
  const s = el.style;
  s.position = 'fixed'; s.inset = '0'; s.zIndex = '1000'; s.background = 'var(--bg)';
  s.display = 'flex'; s.justifyContent = 'center'; s.overflow = 'auto';
  return el;
}

async function showSetup(token) {
  const pb = new PocketBase(window.location.origin);
  const err = h('div', { class: 'error', attrs: { role: 'alert' } });
  const name = h('input', { attrs: { type: 'text', required: true, maxlength: '80', autocomplete: 'name', 'aria-label': tx('name'), placeholder: tx('name') } });
  const email = h('input', { attrs: { type: 'email', autocomplete: 'email', 'aria-label': tx('email'), placeholder: tx('email') } });
  const btn = h('button', { class: 'btn primary', attrs: { type: 'submit' }, text: tx('go') });
  const form = h('form', {
    class: 'login',
    on: {
      submit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        btn.disabled = true;
        try {
          const r = await pb.send('/api/ach/setup', { method: 'POST', body: { token, name: name.value.trim(), email: email.value.trim() } });
          pb.authStore.save(r.token, r.record);
          window.location.hash = '#/admin/people';
          window.location.reload();
        } catch (ex) {
          btn.disabled = false;
          const code = ex && ex.response && ex.response.code;
          err.textContent = code === 'setup_done' ? tx('done') : code === 'invalid_setup_link' ? tx('invalid') : code === 'setup_link_expired' ? tx('expired') : `${tx('fail')}: ${(ex && ex.response && ex.response.error) || ex}`;
        }
      },
    },
  },
  h('div', { class: 'brand big' }, h('span', { class: 'hash', text: '#' }), h('span', { text: tx('title') })),
  h('div', { class: 'muted', text: tx('lead') }),
  name, email, btn, err);

  // the token only travels in a POST body (never a URL path or query: request logs)
  let state = 'ok';
  try {
    const r = await pb.send('/api/ach/setup/check', { method: 'POST', body: { token } });
    // behind Cloudflare Access: prefill the verified Access identity
    if (r && r.email && !email.value) email.value = r.email;
  } catch (ex) {
    const code = ex && ex.response && ex.response.code;
    state = code === 'setup_link_expired' ? 'expired' : ex && ex.status === 410 ? 'done' : 'invalid';
  }
  const view = state === 'ok' ? form
    : h('div', { class: 'login' }, h('div', { class: 'brand big' }, h('span', { class: 'hash', text: '#' }), h('span', { text: tx('title') })),
      h('div', { class: 'muted', text: tx(state) }),
      h('a', { class: 'btn', href: '#/', text: 'OK', on: { click: () => document.getElementById('ach-setup')?.remove() } }));
  document.getElementById('ach-setup')?.remove();
  document.body.appendChild(overlay(view));
  if (state === 'ok') name.focus();
}

const m = typeof window !== 'undefined' && window.location ? (window.location.hash || '').match(SETUP_RE) : null;
if (m) {
  // keep the token out of the address bar and history (like login links)
  try { window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/`); } catch (_) { /* ignore */ }
  showSetup(m[1]);
}
