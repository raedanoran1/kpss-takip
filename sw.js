const CACHE_NAME = 'kpss-takip-v10';

const SKIP_PATHS = ['/dufs-proxy', '/install-cert'];

// App shell: ilk offline açılışı garanti altına alır
const APP_SHELL = [
    '/',
    '/index.html',
    '/css/styles.css',
    '/js/chrome-polyfill.js',
    '/js/db.js',
    '/js/sidepanel.js',
    '/js/state/app-state.js',
    '/js/utils/ui-utils.js',
    '/js/utils/format-utils.js',
    '/js/utils/drag-sort.js',
    '/js/utils/logger.js',
    '/lib/sql-wasm.js',
    '/lib/sql-wasm.wasm',
    '/lib/pdf.min.js',
    '/lib/pdf.worker.min.js',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                // Her dosyayı ayrı ayrı dene — biri başarısız olursa diğerleri devam etsin
                return Promise.allSettled(
                    APP_SHELL.map(url => cache.add(url).catch(e => console.warn('[SW] precache skip:', url, e.message)))
                );
            })
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    let url;
    try { url = new URL(event.request.url); } catch { return; }

    if (url.origin !== location.origin) return;
    if (SKIP_PATHS.some(p => url.pathname.startsWith(p))) return;

    // Navigation (sayfa yükleme): cache-first — iOS'ta offline'da ağ isteği askıda kalabilir
    if (event.request.mode === 'navigate') {
        event.respondWith(
            caches.open(CACHE_NAME).then(async cache => {
                const cached = await cache.match('/') || await cache.match('/index.html');
                if (cached) {
                    // Arka planda güncelle (stale-while-revalidate)
                    fetch(event.request).then(r => { if (r?.status === 200) cache.put(event.request, r); }).catch(() => {});
                    return cached;
                }
                // Cache'te yoksa ağdan dene
                try {
                    const response = await fetch(event.request);
                    if (response?.status === 200) cache.put(event.request, response.clone());
                    return response;
                } catch {
                    return new Response('<h2>Uygulama cache\'lenmemiş</h2><p>Lütfen bir kez çevrimiçiyken açın.</p>', {
                        headers: { 'Content-Type': 'text/html; charset=utf-8' }
                    });
                }
            })
        );
        return;
    }

    // Diğer tüm kaynaklar (JS, CSS, wasm, font): network-first, cache'e kaydet
    event.respondWith(
        caches.open(CACHE_NAME).then(cache =>
            fetch(event.request)
                .then(response => {
                    if (response?.status === 200) cache.put(event.request, response.clone());
                    return response;
                })
                .catch(() => cache.match(event.request))
        )
    );
});
