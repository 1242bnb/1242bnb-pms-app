/* 1242BNB PMS — service worker: cachea el shell; la API y las Functions siempre van a la red. */
const CACHE = 'pms-1242bnb-v57';
// SIN './index.html': Cloudflare Pages lo redirige (308) a './' y iOS rechaza respuestas
// redirigidas servidas por el SW ("response served by service worker has redirections").
const SHELL = ['./', './styles.css', './app.js', './manifest.json',
  './icons/apple-touch-icon.png', './icons/icon-512.png', './icons/favicon-32.png'];
// /datos y /sync (cerebro de lectura D1) JAMÁS se cachean acá: D1 ya es el caché.
const FUNCS = ['/subscribe', '/send', '/vapidPublic', '/datos', '/sync'];

// Re-empaqueta una respuesta quitándole el flag redirected (iOS la rechaza tal cual en navegación).
async function limpiar(r) {
  if (!r.redirected) return r;
  const cuerpo = await r.blob();
  return new Response(cuerpo, { status: 200, statusText: 'OK', headers: r.headers });
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(
    SHELL.map(u => fetch(u).then(async (r) => { if (r.ok) await c.put(u, await limpiar(r)); }))
  )).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.hostname.indexOf('script.google') !== -1 || url.hostname.indexOf('googleusercontent') !== -1) return; // API: red directa
  if (FUNCS.indexOf(url.pathname) !== -1) return;  // Pages Functions (push): siempre a la red
  if (e.request.method !== 'GET') return;
  // Navegación (abrir/recargar la app): SIEMPRE el shell limpio del caché — nunca una respuesta
  // redirigida, que es lo que rompía Safari.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      caches.match('./').then(hit => hit || fetch('./').then(async (r) => {
        const limpia = await limpiar(r);
        if (limpia.ok) caches.open(CACHE).then(c => c.put('./', limpia.clone()));
        return limpia;
      }))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      if (r.ok && !r.redirected && url.origin === location.origin) {
        const copia = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copia));
      }
      return r;
    }))
  );
});

// Notificación push: el emisor manda un JSON {title, body, url, tag}. iOS exige mostrar SIEMPRE
// una notificación visible, si no revoca la suscripción.
self.addEventListener('push', (e) => {
  let d = { title: '1242BNB', body: 'Tienes una novedad', url: '/', tag: '' };
  try { if (e.data) d = Object.assign(d, e.data.json()); } catch (err) { try { d.body = e.data.text(); } catch (e2) {} }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: './icons/icon-512.png',
    badge: './icons/favicon-32.png',
    tag: d.tag || undefined,
    data: { url: d.url || '/' },
    vibrate: [80, 40, 80]
  }));
});

// Al tocar la notificación: enfoca la app si ya está abierta, o la abre en la ruta indicada.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const destino = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) { if ('focus' in w) { w.navigate && w.navigate(destino); return w.focus(); } }
    return self.clients.openWindow(destino);
  }));
});
