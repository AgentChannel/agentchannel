import type { Client, FetchLike } from './client.js';
import { UsageError } from './args.js';
import { makeExec, inviteMessage, type Exec } from './import.js';
import { syncFeishuAvatars } from './avatars.js';

/**
 * `ach admin invite <person>`: one copyable one-time login link (24 h; a new
 * one replaces the older one). Send options appear only for delivery that is
 * set up on this machine (Feishu through lark-cli). A reminder about the hub's
 * sign-in gate appears only when the hub has one and its allowed list (as the
 * hub knows it) does not include the person's email.
 */
export async function invitePerson(
  ref: string,
  values: Record<string, unknown>,
  io: { env: NodeJS.ProcessEnv; out: (s: string) => void; err: (s: string) => void; fetch?: FetchLike; exec?: Exec },
  a: Client,
): Promise<number> {
  const want = ref.trim().toLowerCase().replace(/^@/, '');
  const users: any[] = await a.adminListUsers();
  const u = users.find((x) => x.id === ref) ?? users.find((x) => String(x.email ?? '').toLowerCase() === want) ?? users.find((x) => String(x.name ?? '').toLowerCase() === want);
  if (!u) throw new UsageError(`admin invite: no person or agent named ${ref} (add a person with \`ach admin create-user --name <n> --email <e>\`)`);
  if (u.deactivated) throw new UsageError(`admin invite: ${u.name || u.email} is deactivated (reactivate with \`ach admin user ${u.email || u.id} --reactivate\`)`);
  const link = await a.adminUserLoginLink(u.id);
  const url = link.url && /^https?:/.test(link.url) ? link.url : `${a.hub}${link.path}`;
  const exec = io.exec ?? makeExec(io.env);
  const lark = (await exec('lark-cli', ['--version'])).code === 0;
  const settings = await a.request<any>('GET', '/api/ach/settings').catch(() => null);
  const workspace: string | undefined = settings?.workspace_name || undefined;
  const result: Record<string, unknown> = { person: u.name, email: u.email ?? '', url, expires_at: link.expires_at };

  if (values.feishu) {
    if (!lark) io.err('Feishu is not set up on this machine (lark-cli not found): send the link yourself.');
    else {
      const r = await sendFeishu(exec, u, inviteMessage(u.name || u.email, url, workspace));
      if (r.ok) {
        result.sent = 'feishu';
        io.err(`sent a Feishu message to ${u.name || u.email}`);
        await syncFeishuAvatars(a, [{ id: u.id, name: u.name, email: u.email }], { exec, fetch: io.fetch, log: io.err });
      } else io.err(`Feishu message to ${u.name || u.email} failed (${r.why}): send the link yourself.`);
    }
  }

  if (values.json) io.out(JSON.stringify(result, null, 2));
  else io.out(url);
  io.err(`One-time login link for ${u.name || u.email}: works once, expires in 24 h.`);
  if (!values.feishu && lark && u.email) io.err(`Send it on Feishu: ach admin invite ${u.email} --feishu`);

  if (u.email) {
    const gate = await a.request<any>('GET', `/api/ach/admin/access-check?email=${encodeURIComponent(u.email)}`).catch(() => null);
    if (gate?.cf && gate.covered === false) {
      io.err(`Note: ${u.email} is not on the hub's list of people allowed through its sign-in page yet. Add the email there, or the link will not open for them.`);
    }
  }
  return 0;
}

async function sendFeishu(exec: Exec, u: any, text: string): Promise<{ ok: boolean; why: string }> {
  let openId = typeof u.feishu_open_id === 'string' && /^ou_/.test(u.feishu_open_id) ? u.feishu_open_id : '';
  if (!openId && u.email) {
    const r = await exec('lark-cli', ['contact', '+search-user', '--query', u.email, '--as', 'user', '--exclude-external-users', '--format', 'json']);
    if (r.code !== 0) return { ok: false, why: (r.stderr.trim() || r.stdout.trim()).split('\n')[0] || `exit ${r.code}` };
    try {
      const j = JSON.parse(r.stdout);
      const list: any[] = j?.data?.users ?? j?.users ?? [];
      const hit = list.find((x) => [x.email, x.enterprise_email].some((e) => String(e ?? '').toLowerCase() === String(u.email).toLowerCase()));
      openId = hit?.open_id ?? '';
    } catch {
      /* unexpected output */
    }
  }
  if (!openId) return { ok: false, why: 'not found in Feishu by email' };
  const r = await exec('lark-cli', ['im', '+messages-send', '--user-id', openId, '--text', text, '--idempotency-key', `ach-inv-${u.id}-${Date.now().toString(36)}`.slice(0, 50)]);
  return r.code === 0 ? { ok: true, why: '' } : { ok: false, why: r.stderr.trim().split('\n')[0] || `exit ${r.code}` };
}
