const CACHE='gg-public-shell-v1';
const ASSETS=['/offline.html','/customer-shared.css','/shared-i18n.js','/customer-shop-context.js','/customer-theme.js','/merchant-contact-bar.js','/icons/gg-default.svg'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('gg-public-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => { const request=event.request; const url=new URL(request.url); if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || /\/(admin|staff|member)\.html$/.test(url.pathname)) return; event.respondWith(fetch(request).catch(() => caches.match(request).then(hit => hit || caches.match('/offline.html')))); });
