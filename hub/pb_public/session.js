// Session and dialog pieces: a small modal, the typed-name
// confirm, the "log in on another device" QR, the WeChat in-app browser hint
// and the admin share message. DOM builders only; app.js does the network.

import qrcode from './vendor/qrcode.es.js';
import { h, when } from './render.js';
import { t, getLang } from './i18n.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------- modal ----------

/**
 * Show `content` (a node) in a modal over the page. Returns close(). Escape and
 * a click on the backdrop close it.
 */
export function openModal(content, o = {}) {
  const box = h('div', { class: 'modal', attrs: { role: 'dialog', 'aria-label': o.label || '' } }, content);
  const back = h('div', { class: 'modal-back' }, box);
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey);
    if (o.onClose) o.onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(back);
  const first = box.querySelector('input, select, textarea, button');
  if (first) { try { first.focus(); } catch (_) { /* ignore */ } }
  return close;
}

/**
 * F10: confirm a risky admin action by typing the person's name. Resolves to the
 * typed name (sent as `confirm_name`) or null when canceled.
 */
export function confirmTyped({ title, body, name }) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { attrs: { type: 'text', autocomplete: 'off', 'aria-label': t('type_name', { name }), placeholder: name } });
    const ok = h('button', { class: 'btn primary danger-fill', attrs: { type: 'submit', disabled: true }, text: t('confirm') });
    input.addEventListener('input', () => { ok.disabled = input.value.trim() !== String(name); });
    let close = null;
    const finish = (v) => { if (done) return; done = true; resolve(v); if (close) close(); };
    const form = h('form', {
      class: 'modal-form',
      on: { submit: (e) => { e.preventDefault(); if (input.value.trim() === String(name)) finish(input.value.trim()); } },
    },
    h('h2', { text: title }),
    body ? h('p', { class: 'muted', text: body }) : null,
    h('label', { class: 'field' }, h('span', { class: 'label', text: t('type_name', { name }) }), input),
    h('div', { class: 'btns' }, ok, h('button', { class: 'btn', attrs: { type: 'button' }, text: t('cancel'), on: { click: () => finish(null) } })));
    close = openModal(form, { label: title, onClose: () => finish(null) });
  });
}

// ---------- QR ----------

/** QR modules for `text` (byte mode, error correction M): {size, dark(r, c)}. */
export function qrMatrix(text) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text), 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  return { size, dark: (r, c) => qr.isDark(r, c) };
}

/** The QR code as an inline <svg> (one <path>, built with DOM APIs; CSP-safe, no data: URL). */
export function qrSvg(text, px = 200) {
  const m = qrMatrix(text);
  const quiet = 4;
  const n = m.size + quiet * 2;
  let d = '';
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) if (m.dark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'qr');
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
  svg.setAttribute('width', String(px));
  svg.setAttribute('height', String(px));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', String(n));
  bg.setAttribute('height', String(n));
  bg.setAttribute('fill', '#ffffff');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000000');
  svg.append(bg, path);
  return svg;
}

/** Only links into this panel's login route are drawn or copied. */
export function validLoginUrl(url) {
  return /^https?:\/\/[^\s"'<>`#]+\/?#\/login\/ach_lt_[A-Za-z0-9]{40}$/.test(String(url || ''));
}

/** F9: "Log in on another device": QR + copyable link + expiry. link: {url, expires_at} */
export function deviceLinkView(link, now = Date.now()) {
  const url = link && link.url;
  if (!validLoginUrl(url)) return h('div', { class: 'error', text: t('err_invalid_link') });
  const status = h('span', { class: 'muted small' });
  const code = h('code', { class: 'key', text: url });
  return h('div', { class: 'device-link' },
    h('h2', { text: t('device_login') }),
    h('p', { class: 'muted small', text: t('device_login_hint') }),
    h('div', { class: 'qr-wrap' }, qrSvg(url)),
    code,
    h('div', { class: 'btns' },
      h('button', {
        class: 'btn primary', attrs: { type: 'button' }, text: t('copy'),
        on: { click: async () => { try { await navigator.clipboard.writeText(url); status.textContent = t('copied'); } catch (_) { selectNode(code); } } },
      }),
      link.expires_at ? h('span', { class: 'muted small', text: t('device_expires', { when: when(link.expires_at, now) }) }) : null,
      status));
}

function selectNode(node) {
  try {
    const r = document.createRange(); r.selectNodeContents(node);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  } catch (_) { /* ignore */ }
}

// ---------- WeChat ----------

export function isWeChat(ua) {
  const nav = (globalThis.window && globalThis.window.navigator) || globalThis.navigator;
  const s = ua ?? ((nav && nav.userAgent) || '');
  return /MicroMessenger/i.test(String(s));
}

/** F9: the in-app browser forgets sessions; tell people to open the system browser. */
export function wechatHint(onDismiss) {
  return h('div', { class: 'banner wechat', attrs: { role: 'note' } },
    h('span', { text: t('wechat_hint') }),
    onDismiss ? h('button', { class: 'btn link', attrs: { type: 'button', 'aria-label': t('dismiss') }, text: '×', on: { click: onDismiss } }) : null);
}

// ---------- share sheet (admin) ----------

/** The MCP registration command printed by `ach join` for a runtime. */
export function mcpCommand(runtime) {
  if (runtime === 'codex') return 'codex mcp add ach -- ach mcp';
  if (runtime === 'claude') return 'claude mcp add --scope user ach -- ach mcp';
  return '';
}

/**
 * The paragraph a person pastes into their own Claude Code / Codex (same words
 * as `ach admin invite <agent>`): join, ask before installing the background
 * helper with notifications, a test notification, report the inbox; on any
 * failure, ach doctor. line: the plain join line.
 */
export function agentInviteParagraph(line, lang = 'en') {
  if (lang === 'zh') {
    return `请帮我接入团队的 AgentChannel：1. 运行 \`${line}\`，按默认选项接入 Claude Code（或 Codex）；`
      + '2. 安装后台小助手并打开系统通知（`ach run --install-service --notify`），装之前先问我一声；'
      + '3. 发一条测试通知给我（`ach notify --test`），确认能弹出来；4. 告诉我收件箱里现在有什么。'
      + '任何一步失败，运行 `ach doctor`，按提示修好再继续。';
  }
  return `Please connect me to my team's AgentChannel: 1. Run \`${line}\` and take the default options to add it to Claude Code (or Codex); `
    + '2. Install the background helper with desktop notifications (`ach run --install-service --notify`), and ask me before you install it; '
    + '3. Send me a test notification (`ach notify --test`) and check that it pops up; 4. Tell me what is in my inbox now. '
    + 'If any step fails, run `ach doctor`, fix what it says, and continue.';
}

/**
 * The CLI release the panel tells people to run (packages/agentchannel
 * package.json "version"; a test keeps them in sync). A prerelease is pinned
 * exactly; a release uses its major tag (agentchannel@2).
 */
export const CLI_VERSION = '2.0.0-rc.1';
export function cliSpec(v = CLI_VERSION) {
  const s = String(v);
  return /-/.test(s) ? `agentchannel@${s}` : `agentchannel@${s.split('.')[0]}`;
}

/** The one-line join for a one-time "ach2." invite: works without `ach` installed. */
export function joinLineOf(invite) {
  return `npx -y ${cliSpec()} join ${String(invite || '')}`;
}

/** The one paste that imports a GitHub org with the admin's own session (a one-time CLI link). */
export function importCommand(org, link) {
  return `npx -y ${cliSpec()} admin import github --org ${String(org || '<org>')} --link ${String(link || '<link>')}`;
}

/**
 * Invite an agent: (a) the paragraph for the owner's Claude/Codex, (b) the plain
 * join line, each with its own copy button, zh/en switch. o: {name, invite, lang?}
 */
export function agentInviteSheet(o) {
  let lang = o.lang || getLang();
  const line = joinLineOf(o.invite);
  const para = h('textarea', { class: 'share-text invite-paragraph', attrs: { rows: 5, readonly: true, 'aria-label': t('invite_paragraph') } });
  const draw = () => { para.value = agentInviteParagraph(line, lang); };
  draw();
  const copyBtn = (get, status) => h('button', {
    class: 'btn primary', attrs: { type: 'button' }, text: t('copy'),
    on: { click: async () => { try { await navigator.clipboard.writeText(get()); status.textContent = t('copied'); } catch (_) { /* select by hand */ } } },
  });
  const s1 = h('span', { class: 'muted small' });
  const s2 = h('span', { class: 'muted small' });
  const langBtn = h('button', {
    class: 'btn link', attrs: { type: 'button' }, text: lang === 'zh' ? 'English' : '中文',
    on: { click: () => { lang = lang === 'zh' ? 'en' : 'zh'; langBtn.textContent = lang === 'zh' ? 'English' : '中文'; draw(); } },
  });
  return h('div', { class: 'invite-sheet' },
    h('div', { class: 'share-head' }, h('span', { class: 'label', text: t('invite_paragraph') }), langBtn),
    h('p', { class: 'muted small', text: t('invite_paragraph_hint', { name: o.name || '' }) }),
    para,
    h('div', { class: 'btns' }, copyBtn(() => para.value, s1), s1),
    h('div', { class: 'share-head' }, h('span', { class: 'label', text: t('invite_line') })),
    h('code', { class: 'key invite-line', text: line }),
    h('div', { class: 'btns' }, copyBtn(() => line, s2), s2),
    h('p', { class: 'muted small invite-note', text: o.cf ? t('invite_once_note_cf') : t('invite_once_note') }));
}

/**
 * Deliver a person's login link: copy always; email (opens the mail app with
 * the message, nothing is sent by the hub) when they have an address; the
 * Feishu command when the admin's CLI can send it. o: {name, email, url, lang}
 */
export function deliveryButtons(o) {
  const text = shareText({ name: o.name, url: o.url, lang: o.lang, agent: o.agent || null });
  const status = h('span', { class: 'muted small' });
  const btns = [h('button', {
    class: 'btn primary deliver-copy', attrs: { type: 'button' }, text: t('copy'),
    on: { click: async () => { try { await navigator.clipboard.writeText(text); status.textContent = t('copied'); } catch (_) { /* select by hand */ } } },
  })];
  // the email button only when the hub has SMTP; Feishu only when configured
  if (o.email && o.smtp) {
    const mail = `mailto:${encodeURIComponent(o.email)}?subject=${encodeURIComponent('AgentChannel')}&body=${encodeURIComponent(text)}`;
    const b = h('button', { class: 'btn deliver-email', attrs: { type: 'button' }, text: t('deliver_email'), on: { click: () => { window.location.href = mail; } } });
    b.mailto = mail;
    btns.push(b);
  }
  if (o.email && o.feishu) {
    btns.push(h('button', {
      class: 'btn deliver-feishu', attrs: { type: 'button' }, text: t('deliver_feishu'),
      on: { click: async () => { try { await navigator.clipboard.writeText(`ach admin invite ${o.email} --feishu`); status.textContent = t('deliver_feishu_copied'); } catch (_) { /* ignore */ } } },
    }));
  }
  return h('div', { class: 'btns deliver' }, btns, status);
}

/**
 * F10: one message with the person's login link and (when known) their agent's
 * join line, in zh or en. o: {lang, name, url, agent: {name, runtime, invite}}
 */
export function shareText(o) {
  const lang = o.lang || getLang();
  const tr = (key, vars) => {
    // render in the requested template language, whatever the UI language is
    const cur = getLang();
    if (cur === lang) return t(key, vars);
    return SHARE_TPL[lang][key].replace(/\{(\w+)\}/g, (_, k) => String((vars || {})[k] ?? ''));
  };
  const parts = [];
  if (o.url) parts.push(tr('share_tpl_login', { name: o.name || '', url: o.url }));
  if (o.agent && o.agent.invite) {
    // one message: the login link, then the paragraph for their own Claude/Codex
    parts.push(tr('share_tpl_agent', { agent: o.agent.name, para: agentInviteParagraph(joinLineOf(o.agent.invite), lang) }));
  }
  return parts.join('\n\n');
}

const SHARE_TPL = {
  en: {
    share_tpl_login: 'Hi {name}, here is your AgentChannel login link (one use, 24 h):\n{url}',
    share_tpl_agent: 'Then paste this into your Claude Code or Codex (it sets up your agent "{agent}"):\n{para}',
  },
  zh: {
    share_tpl_login: '{name}，你好！这是你的 AgentChannel 登录链接（只能用一次，24 小时内有效）：\n{url}',
    share_tpl_agent: '然后把下面这段话贴进你的 Claude Code 或 Codex（它会配置你的智能体「{agent}」）：\n{para}',
  },
};

/** The share sheet: message preview (zh/en switch) and one copy button. */
export function shareSheet(o) {
  let lang = getLang();
  const ta = h('textarea', { class: 'share-text', attrs: { rows: 6, readonly: true, 'aria-label': t('share') } });
  const status = h('span', { class: 'muted small' });
  const draw = () => { ta.value = shareText({ ...o, lang }); };
  draw();
  const langBtn = h('button', {
    class: 'btn link', attrs: { type: 'button' }, text: lang === 'zh' ? 'English' : '中文',
    on: { click: () => { lang = lang === 'zh' ? 'en' : 'zh'; langBtn.textContent = lang === 'zh' ? 'English' : '中文'; draw(); } },
  });
  return h('div', { class: 'share-sheet' },
    h('div', { class: 'share-head' }, h('span', { class: 'label', text: t('share') }), langBtn),
    h('p', { class: 'muted small', text: t('share_hint') }),
    ta,
    h('div', { class: 'btns' },
      h('button', {
        class: 'btn primary', attrs: { type: 'button' }, text: t('copy'),
        on: { click: async () => { try { await navigator.clipboard.writeText(ta.value); status.textContent = t('copied'); } catch (_) { ta.select(); } } },
      }),
      status));
}
