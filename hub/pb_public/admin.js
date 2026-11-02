// Admin settings screens: People (invite links, re-login links,
// deactivate / reactivate, admin role) and the shared settings tabs and
// copy-once box. Rendering only; app.js passes the data and the API callbacks.

import { h, tag, errText } from './render.js';
import { t, tn } from './i18n.js';
import { openModal, confirmTyped, shareSheet, deliveryButtons, importCommand } from './session.js';

/** Settings tabs (Slack-style): People, Channels (with embeds and storage) and Import are admin-only; Agents is for everyone. */
export function settingsTabs(active, admin) {
  return h('nav', { class: 'tabs', attrs: { 'aria-label': t('settings') } },
    admin ? h('a', { class: 'tab' + (active === 'people' ? ' active' : ''), href: '#/admin/people', text: t('people') }) : null,
    h('a', { class: 'tab' + (active === 'agents' ? ' active' : ''), href: '#/agents', text: t('agents_tab') }),
    admin ? h('a', { class: 'tab' + (active === 'channels' ? ' active' : ''), href: '#/admin/channels', text: t('channels_tab') }) : null,
    admin ? h('a', { class: 'tab' + (active === 'import' ? ' active' : ''), href: '#/admin/import', text: t('import_tab') }) : null);
}

/**
 * Settings → Import: the hub holds no GitHub token, so the import runs
 * in the admin's own terminal with their gh login. The panel mints a one-time
 * 15-minute CLI link for this admin (POST /auth/device-link {purpose: "cli"})
 * and shows ONE line to paste. onMakeLink() resolves to the link URL.
 */
export function importView({ onMakeLink }) {
  const err = h('div', { class: 'error' });
  const org = h('input', { attrs: { type: 'text', required: true, placeholder: 'my-org', 'aria-label': t('import_org'), maxlength: 100, pattern: '[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', name: 'org' } });
  const out = h('div', { class: 'import-out' });
  const form = h('form', {
    class: 'create import-form',
    on: {
      submit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const o = org.value.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(o)) { err.textContent = t('import_org'); org.focus(); return; }
        try {
          const url = await onMakeLink();
          out.replaceChildren(
            copyBox({ note: t('import_cmd_head'), value: importCommand(o, url), bare: true }),
            h('p', { class: 'muted small', text: t('import_preview') }));
        } catch (ex) { err.textContent = `${t('error')}: ${errText(ex)}`; }
      },
    },
  },
  h('h2', { text: t('import_title') }),
  h('p', { class: 'muted', text: t('import_lead') }),
  h('div', { class: 'fields' }, org, h('button', { class: 'btn primary', attrs: { type: 'submit' }, text: t('import_make') })),
  err);
  return h('div', { class: 'pane admin import' },
    h('div', { class: 'pane-head' }, h('h1', { text: t('settings') })),
    h('div', { class: 'pane-body' }, settingsTabs('import', true), form, out));
}

/** A value shown once (join line, login link) with copy and dismiss. */
export function copyBox({ note, value, onDismiss, extra, bare }) {
  const code = h('code', { class: 'key', text: value });
  const status = h('span', { class: 'muted' });
  return h('div', { class: bare ? 'copybox' : 'keybox' },
    h('div', { text: note }),
    code,
    extra ? h('div', { class: 'muted small', text: extra }) : null,
    h('div', { class: 'btns' },
      h('button', {
        class: 'btn primary', attrs: { type: 'button' }, text: t('copy'),
        on: {
          click: async () => {
            try {
              await navigator.clipboard.writeText(value);
              status.textContent = t('copied');
            } catch (_) {
              const r = document.createRange(); r.selectNodeContents(code);
              const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
            }
          },
        },
      }),
      onDismiss ? h('button', { class: 'btn', attrs: { type: 'button' }, text: t('dismiss'), on: { click: onDismiss } }) : null,
      status));
}

/** A default agent name from a person's name: "Carol Smith" + claude -> "carol-smith-claude". */
export function agentNameFor(person, runtime) {
  const base = String(person || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'agent';
  const n = `${base}-${runtime || 'claude'}`.replace(/^[^a-z0-9]+/, '');
  return /^[a-z0-9]/.test(n) ? n.slice(0, 41) : `a-${n}`.slice(0, 41);
}

function inviteForm(onInvite, { inviteCf } = {}) {
  const err = h('div', { class: 'error' });
  const name = h('input', { attrs: { placeholder: t('name'), required: true, maxlength: 200, 'aria-label': t('name'), name: 'name' } });
  const email = h('input', { attrs: { type: 'email', placeholder: t('email_optional'), maxlength: 200, 'aria-label': t('email_optional'), name: 'email' } });
  const admin = h('input', { attrs: { type: 'checkbox', 'aria-label': t('admin_flag'), name: 'is_admin' } });
  // "Engineer (with agent)" makes the person and their agent in one go
  const kind = h('select', { attrs: { 'aria-label': t('invite_kind'), name: 'kind' } },
    h('option', { attrs: { value: 'person' }, text: t('kind_person') }),
    h('option', { attrs: { value: 'engineer' }, text: t('kind_engineer') }));
  const runtime = h('select', { attrs: { 'aria-label': t('runtime_label'), name: 'runtime' } }, ['claude', 'codex'].map((r) => h('option', { attrs: { value: r }, text: r })));
  const agentName = h('input', { attrs: { placeholder: t('agent_name_label'), 'aria-label': t('agent_name_label'), maxlength: 41, autocomplete: 'off', name: 'agent_name' } });
  const cfBox = inviteCf ? h('input', { attrs: { type: 'checkbox', 'aria-label': t('cf_opt_in'), name: 'cf_token' } }) : null;
  let touched = false;
  agentName.addEventListener('input', () => { touched = true; });
  const suggest = () => { if (!touched) agentName.value = agentNameFor(name.value, runtime.value); };
  name.addEventListener('input', suggest);
  runtime.addEventListener('change', suggest);
  const engineerRow = h('div', { class: 'fields engineer-fields' }, runtime, agentName,
    cfBox ? h('label', { class: 'check cf-opt-in' }, cfBox, h('span', { text: t('cf_opt_in') })) : null);
  const engineerHint = h('p', { class: 'muted small engineer-hint' }, t('engineer_hint'), cfBox ? h('span', { text: ` ${t('cf_opt_in_warn')}` }) : null);
  const sync = () => { const on = kind.value === 'engineer'; engineerRow.hidden = !on; engineerHint.hidden = !on; if (on) suggest(); };
  kind.addEventListener('change', sync);
  sync();
  return h('form', {
    class: 'create invite',
    on: {
      submit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const body = { name: name.value.trim() };
        if (email.value.trim()) body.email = email.value.trim();
        if (admin.checked) body.is_admin = true;
        let agent = null;
        if (kind.value === 'engineer') {
          agent = { name: (agentName.value.trim() || agentNameFor(body.name, runtime.value)), runtime: runtime.value, description: `${body.name}'s ${runtime.value}` };
          if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(agent.name)) { err.textContent = t('err_invalid_agent_name'); agentName.focus(); return; }
          if (cfBox && cfBox.checked) agent.cf_token = true;
        }
        try {
          await onInvite(body, agent);
        } catch (ex) { err.textContent = `${t('error')}: ${errText(ex)}`; }
      },
    },
  },
  h('h2', { text: t('invite_person') }),
  h('div', { class: 'fields' }, kind, name, email,
    h('label', { class: 'check' }, admin, h('span', { text: t('admin_flag') })),
    h('button', { class: 'btn primary', attrs: { type: 'submit' }, text: t('invite') })),
  engineerRow,
  engineerHint,
  err);
}

/**
 * F10 deactivate dialog: reassign the person's agents to another active owner,
 * or deactivate them. No "keep running" option. Resolves to the PATCH plan or null.
 * Admins also type the name (admin safety).
 */
export function deactivateDialog(u, { agents, owners }) {
  const label = u.name || u.email || u.id;
  return new Promise((resolve) => {
    let done = false;
    let close = null;
    const finish = (v) => { if (done) return; done = true; resolve(v); if (close) close(); };
    const n = agents.length;
    const reassign = h('input', { attrs: { type: 'radio', name: 'agents-plan', value: 'reassign', checked: n > 0 && owners.length > 0, disabled: !owners.length } });
    const off = h('input', { attrs: { type: 'radio', name: 'agents-plan', value: 'off', checked: !owners.length } });
    const owner = h('select', { attrs: { 'aria-label': t('owner_label'), disabled: !owners.length } },
      h('option', { attrs: { value: '' }, text: t('pick_owner') }),
      owners.map((x) => h('option', { attrs: { value: x.id }, text: x.name || x.email || x.id })));
    owner.addEventListener('change', () => { reassign.checked = true; });
    const typed = u.is_admin ? h('input', { attrs: { type: 'text', autocomplete: 'off', placeholder: label, 'aria-label': t('type_name', { name: label }) } }) : null;
    const err = h('div', { class: 'error' });
    const form = h('form', {
      class: 'modal-form deactivate',
      on: {
        submit: (e) => {
          e.preventDefault();
          err.textContent = '';
          if (typed && typed.value.trim() !== label) { err.textContent = t('err_confirm_name'); return; }
          const plan = { deactivated: true };
          if (typed) plan.confirm_name = typed.value.trim();
          if (n > 0 && reassign.checked) {
            if (!owner.value) { err.textContent = t('pick_owner'); return; }
            finish({ body: { ...plan, reassign_agents_to: owner.value }, agents });
            return;
          }
          finish({ body: { ...plan, deactivate_agents: true }, agents });
        },
      },
    },
    h('h2', { text: t('deactivate_title', { name: label }) }),
    h('p', { class: 'muted', text: t('deactivate_body') }),
    n > 0 ? h('div', { class: 'choices' },
      h('label', { class: 'check' }, reassign, h('span', { text: t('agents_reassign', { n }) }), owner),
      h('label', { class: 'check' }, off, h('span', { text: t('agents_off', { n }) })),
      h('div', { class: 'muted small', text: agents.map((a) => a.name).join(', ') })) : null,
    typed ? h('label', { class: 'field' }, h('span', { class: 'label', text: t('type_name', { name: label }) }), typed) : null,
    err,
    h('div', { class: 'btns' },
      h('button', { class: 'btn primary', attrs: { type: 'submit' }, text: t('deactivate') }),
      h('button', { class: 'btn', attrs: { type: 'button' }, text: t('cancel'), on: { click: () => finish(null) } })));
    close = openModal(form, { label: t('deactivate_title', { name: label }), onClose: () => finish(null) });
  });
}

function personRow(u, { meId, onLink, onPatch, onDeactivate, cf }) {
  const err = h('span', { class: 'error' });
  const self = u.id === meId;
  const label = u.name || u.email || u.id;
  const run = (fn) => async () => {
    err.textContent = '';
    try { await fn(); } catch (ex) { err.textContent = `${t('error')}: ${errText(ex)}`; }
  };
  const btn = (text, fn, cls) => h('button', { class: 'btn' + (cls ? ` ${cls}` : ''), attrs: { type: 'button' }, text, on: { click: run(fn) } });
  const controls = [];
  if (!u.deactivated) controls.push(btn(t('login_link'), () => onLink(u)));
  if (u.is_admin) {
    // F10 admin safety: removing an admin (yourself included) is typed-name confirmed
    controls.push(btn(t('remove_admin'), async () => {
      const typed = await confirmTyped({ title: t('unadmin_title', { name: label }), body: t('unadmin_confirm', { name: label }), name: label });
      if (typed != null) await onPatch(u, { is_admin: false, confirm_name: typed });
    }));
  } else if (!u.deactivated && !self) {
    controls.push(btn(t('make_admin'), async () => { if (window.confirm(t('admin_confirm', { name: label }))) await onPatch(u, { is_admin: true }); }));
  }
  if (!self) {
    if (u.deactivated) {
      controls.push(btn(t('reactivate'), async () => { if (window.confirm(t('reactivate_confirm', { name: label }))) await onPatch(u, { deactivated: false }); }));
    } else {
      controls.push(btn(t('deactivate'), () => onDeactivate(u), 'danger'));
    }
  }
  return h('div', { class: 'row person' + (u.deactivated ? ' dim' : ''), attrs: { 'data-id': u.id } },
    h('div', { class: 'row-main' },
      h('span', { class: 'title', text: label }), ' ',
      u.is_admin ? [tag(t('admin_flag')), ' '] : null,
      u.deactivated ? [tag(t('deactivated'), 'strong'), ' '] : null,
      self ? tag(t('you')) : null),
    h('div', { class: 'row-meta' },
      h('span', { class: u.email ? '' : 'muted', text: u.email || t('no_email') }),
      h('span', { class: 'muted', text: tn('n_agents', u.agents || 0) })),
    h('div', { class: 'row-meta controls' }, controls, err));
}

/**
 * The People pane. users: [{id, name, email, is_admin, deactivated, agents}].
 * link: {name, url, userId, email} to show once, or null. share: {name, runtime, invite}
 * (a join line for that person's agent, when one was just made). cf: Cloudflare Access on.
 */
export function peopleView({ users, meId, link, share, cf, delivery, inviteCf, onInvite, onLink, onPatch, onDeactivate, onDismiss }) {
  const sorted = [...users].sort((a, b) => Number(!!a.deactivated) - Number(!!b.deactivated)
    || String(a.name || a.email).localeCompare(String(b.name || b.email)));
  const dv = delivery || {};
  const deliver = (agent) => h('div', { class: 'deliver-row' }, h('span', { class: 'label', text: t('deliver_via') }),
    deliveryButtons({ name: link.name, email: link.email, url: link.url, agent, smtp: !!dv.smtp, feishu: !!dv.feishu }));
  // with an agent (Engineer), ONE message: the login link + the agent paragraph
  const linkBox = !link ? null : share ? h('div', { class: 'keybox one-message' },
    h('div', { text: t('one_message_head', { name: link.name }) }),
    shareSheet({ name: link.name, url: link.url, agent: share }),
    h('p', { class: 'muted small invite-note', text: share.cf ? t('invite_once_note_cf') : t('invite_once_note') }),
    deliver(share),
    h('div', { class: 'btns' }, h('button', { class: 'btn', attrs: { type: 'button' }, text: t('dismiss'), on: { click: onDismiss } })))
    : h('div', { class: 'keybox' },
      copyBox({ note: t('link_once', { name: link.name }), value: link.url, extra: t('link_new_device'), onDismiss, bare: true }),
      deliver(null),
      shareSheet({ name: link.name, url: link.url, agent: null }));
  return h('div', { class: 'pane admin people' },
    h('div', { class: 'pane-head' }, h('h1', { text: t('settings') }), h('span', { class: 'n muted', text: String(users.length) })),
    h('div', { class: 'pane-body' },
      settingsTabs('people', true),
      linkBox,
      inviteForm(onInvite, { inviteCf }),
      sorted.map((u) => personRow(u, { meId, onLink, onPatch, onDeactivate, cf }))));
}

/** The login link URL for this panel (token in the fragment, never a query). */
export function loginUrl(origin, path) {
  return String(origin).replace(/\/+$/, '') + (String(path).startsWith('/#/login/') ? path : '/');
}

/** Extract a login token from a pasted link or a bare token. */
export function loginTokenOf(s) {
  const m = /(ach_lt_[A-Za-z0-9]{40})/.exec(String(s || ''));
  return m ? m[1] : '';
}
