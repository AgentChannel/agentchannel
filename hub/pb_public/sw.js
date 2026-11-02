// AgentChannel panel service worker: Web Push only (no offline cache).
// Pushes carry no payload; the worker reads the newest item (event, title,
// deep link) with its own read key, sent by the panel after subscribing.
const KEY_CACHE = 'ach-push';
const KEY_URL = '/__ach_push_key';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'ach-push-key' && typeof d.key === 'string' && /^achp_[A-Za-z0-9]{40}$/.test(d.key)) {
    e.waitUntil(caches.open(KEY_CACHE).then((c) => c.put(KEY_URL, new Response(d.key))));
  }
});

// A decision request carries up to two actions (browsers show at most two): the
// recommended option, answered with a single-use action token (POST
// /api/ach/push/act; the reply is recorded as the person's own), and "Open".
function actionsOf(d) {
  const list = Array.isArray(d.actions) ? d.actions.slice(0, 2) : [];
  return list.filter((a) => a && (a.action === 'pick' || a.action === 'open') && typeof a.title === 'string');
}

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let d = { title: 'AgentChannel', body: '', url: '/#/inbox', id: 'ach' };
    try {
      const c = await caches.open(KEY_CACHE);
      const r = await c.match(KEY_URL);
      const key = r ? await r.text() : '';
      if (key) {
        const res = await fetch('/api/ach/push/latest', { headers: { 'X-ACH-Push-Key': key } });
        if (res.ok) d = { ...d, ...(await res.json()) };
      }
    } catch (_) { /* show the generic one */ }
    const acts = actionsOf(d);
    const pick = acts.find((a) => a.action === 'pick' && typeof a.token === 'string');
    await self.registration.showNotification(String(d.title || 'AgentChannel'), {
      body: String(d.body || ''), tag: String(d.id || 'ach'),
      actions: acts.map((a) => ({ action: a.action, title: a.title })),
      data: { url: String(d.url || '/#/inbox'), token: pick ? pick.token : '' },
    });
  })());
});

async function openUrl(url) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of wins) {
    if (new URL(w.url).origin === self.location.origin && 'focus' in w) { await w.navigate(url).catch(() => {}); return w.focus(); }
  }
  return self.clients.openWindow(url);
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = data.url || '/#/inbox';
  if (e.action === 'pick' && data.token) {
    // the tap is the person's reply: send the token, then say what happened
    e.waitUntil((async () => {
      let out = null;
      try {
        const res = await fetch('/api/ach/push/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: data.token }) });
        out = await res.json().catch(() => null);
      } catch (_) { out = null; }
      if (out && out.ok) {
        return self.registration.showNotification('AgentChannel', { body: `✓ ${String(out.reply || '')}`, tag: `act-${String(e.notification.tag || '')}`, data: { url: String(out.url || url) } });
      }
      // already answered, expired, deactivated or offline: open the request instead
      return openUrl((out && out.url) || url);
    })());
    return;
  }
  e.waitUntil(openUrl(url));
});
