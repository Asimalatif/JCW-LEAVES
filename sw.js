/* JCW Approved Leaves - service worker
   - keeps the app working with no internet
   - sends saved leaves in the background when internet returns */
importScripts('sync.js');

const CACHE = 'jcw-leaves-v7';          // change the number when you upload new files
const SHELL = ['./', './index.html', './sync.js', './manifest.json', './icon-192.png', './icon-512.png',
               './jspdf.umd.min.js', './jspdf.plugin.autotable.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Serve from the phone first (works offline), refresh the copy in the background.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (url.origin !== self.location.origin && !isFont) return;   // server calls go straight to the network

  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then(cached => {
        const net = fetch(req).then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put('./index.html', res.clone()));
          return res;
        }).catch(() => cached);
        return cached || net;
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req, { ignoreSearch: !isFont }).then(cached => {
      const net = fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) caches.open(CACHE).then(c => c.put(req, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});

// Background sync: Android Chrome wakes this up when internet returns,
// even if the app is closed.
self.addEventListener('sync', e => {
  if (e.tag === 'leave-sync') e.waitUntil(backgroundSend());
});

async function backgroundSend() {
  const r = await syncQueue();          // a network error here makes the phone retry later
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  wins.forEach(c => c.postMessage({ type: 'synced', sent: r.sent || 0, failed: r.failed || 0 }));
  const visible = wins.some(c => c.visibilityState === 'visible');
  let allowed = false;
  try { allowed = Notification.permission === 'granted'; } catch (e) {}
  if (!visible && allowed && (r.sent || r.failed || r.authError)) {
    let body;
    if (r.authError) body = 'Leaves are waiting. Open the app and sign in again to send them.';
    else {
      body = r.sent ? `${r.sent} leave change${r.sent > 1 ? 's' : ''} saved to the sheets.` : '';
      if (r.failed) body += ` ${r.failed} could not be saved. Open the app to see why.`;
    }
    await self.registration.showNotification('JCW Approved Leaves', {
      body: body.trim(), icon: 'icon-192.png', badge: 'icon-192.png', tag: 'leave-sync'
    });
  }
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(list => {
    if (list.length) return list[0].focus();
    return self.clients.openWindow('./');
  }));
});
