const CACHE_NAME = 'kpss-takip-v7';

// Büyük, nadiren değişen dosyalar — bunlar cache-first
const CACHE_FIRST_PATTERNS = [
    /\/lib\/sql-wasm\.wasm/,
    /\/lib\/pdf\.worker\.min\.js/,
    /\/lib\/pdf\.min\.js/,
    /\/lib\/sql-wasm\.js/,
    /\/fonts\//,
    /\/icons\//,
    /\/images\//,
];

// Önceden cache'lenecek kritik offline dosyalar
const PRECACHE_ASSETS = [
    '/index.html',
    '/css/styles.css',
    '/lib/sql-wasm.wasm',
    '/lib/pdf.min.js',
    '/lib/pdf.worker.min.js',
    '/lib/sql-wasm.js',
    '/fonts/Inter-Variable.woff2',
    '/icons/icon48.png',
    '/icons/icon128.png',
    '/images/eraser.png',
    '/images/kalem.png',
    '/images/optik.png',
    '/web_resources/data/cevsen_supply.json',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(PRECACHE_ASSETS).catch((err) => {
                console.warn('[SW] Bazı dosyalar önbelleğe alınamadı:', err);
            }))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    if (url.origin !== location.origin) return;

    // Cache-first: büyük/nadiren değişen dosyalar
    const isCacheFirst = CACHE_FIRST_PATTERNS.some(p => p.test(url.pathname));

    if (isCacheFirst) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                if (cached) return cached;
                return fetch(event.request).then((response) => {
                    if (response && response.status === 200) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
                    }
                    return response;
                });
            })
        );
        return;
    }

    // Network-first: HTML, JS, CSS, JSON — her zaman güncel versiyon
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
                }
                return response;
            })
            .catch(() => {
                // Ağ yoksa cache'ten sun
                return caches.match(event.request).then((cached) => {
                    if (cached) return cached;
                    // HTML isteğiyse ana sayfayı dön (offline fallback)
                    if (event.request.headers.get('accept')?.includes('text/html')) {
                        return caches.match('/index.html');
                    }
                });
            })
    );
});
