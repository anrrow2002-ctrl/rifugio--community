const CACHE_NAME = 'rifugio-shell-v20260630-proactive-poke-bark-layout-v6';
const DEFAULT_ICON = '/icon.svg';

let proactiveTimer = null;
let proactiveConfig = null;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).catch(() => null));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name)));
    } catch (_) {}
  })());
});

// No fetch handler on purpose: this worker is only for push/proactive events.
// Normal app resources should use the browser's own HTTP cache directly.

const postToWindows = async (payload) => {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) client.postMessage(payload);
};

const showNotification = async (payload = {}) => {
  const title = String(payload.title || 'Rifugio').slice(0, 80);
  const body = String(payload.body || '有新消息').slice(0, 180);
  if (!self.registration?.showNotification) return;
  await self.registration.showNotification(title, {
    body,
    icon: payload.icon || DEFAULT_ICON,
    badge: payload.badge || DEFAULT_ICON,
    tag: payload.tag || 'rifugio-talk',
    renotify: true,
    data: payload.data || {},
  });
};

const stopProactive = () => {
  if (proactiveTimer) clearInterval(proactiveTimer);
  proactiveTimer = null;
  proactiveConfig = null;
};

const syncProactive = (config = {}) => {
  stopProactive();
  if (!config.enabled) return;
  const base = Math.max(1, Number(config.minMinutes || 120) || 120);
  const jitter = Math.max(0, Number(config.randomMinutes || 0) || 0);
  const intervalMs = Math.max(60 * 1000, (base + (jitter ? Math.random() * jitter : 0)) * 60 * 1000);
  proactiveConfig = { ...config, intervalMs };
  proactiveTimer = setInterval(() => {
    postToWindows({ type: 'rifugio-talk-proactive-trigger', source: 'service-worker', config: proactiveConfig });
  }, intervalMs);
};

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'RIFUGIO_SHOW_NOTIFICATION') {
    event.waitUntil(showNotification(data.payload || {}));
  } else if (data.type === 'RIFUGIO_SYNC_TALK_PROACTIVE') {
    syncProactive(data.config || {});
  } else if (data.type === 'RIFUGIO_STOP_TALK_PROACTIVE') {
    stopProactive();
  } else if (data.type === 'RIFUGIO_CLEAR_RUNTIME_CACHE') {
    event.waitUntil(caches.keys().then(names => Promise.all(names.map(name => caches.delete(name)))).then(() => postToWindows({ type:'rifugio-cache-cleared' })).catch(() => null));
  }
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { body: event.data ? event.data.text() : '有新消息' };
  }
  event.waitUntil(Promise.all([
    showNotification(payload),
    postToWindows({ type: 'rifugio-push', payload }),
  ]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const first = clients[0];
    if (first) {
      first.postMessage({ type: 'rifugio-notification-click', data: event.notification.data || {} });
      return first.focus();
    }
    return self.clients.openWindow('/?v=proactive-poke-bark-layout-v6');
  })());
});
