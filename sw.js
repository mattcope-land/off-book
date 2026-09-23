// Serves from cache first so the app opens offline, then refreshes the cache
// in the background. After a deploy, the new version shows on the next open.
// Bump CACHE when the list of app files changes.
const CACHE = 'learn-lines-v1';
const APP_FILES = [
    './',
    'guide/',
    'manifest.webmanifest',
    'icons/icon.svg',
    'icons/icon-180.png',
    'icons/icon-192.png',
    'icons/icon-512.png'
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET' || !request.url.startsWith('http')) return;

    const fromNetwork = caches.open(CACHE).then(cache =>
        fetch(request).then(response => {
            if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
            return response;
        })
    );
    event.waitUntil(fromNetwork.catch(() => {}));
    event.respondWith(
        caches.match(request, { ignoreSearch: true }).then(cached => cached || fromNetwork)
    );
});
