const CACHE_NAME = 'kpss-takip-v9';

const SKIP_PATHS = ['/dufs-proxy', '/install-cert'];

// Install: sadece index.html'i önceden al — geri kalanı ilk ziyarette cache'lenir
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.add('/'))
            .catch(() => {})
            .then(() => self.skipWaiting())
    );
});

// Activate: eski cache'leri temizle, hemen devral
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

    // Farklı origin veya API endpoint'leri: SW'yi atla
    if (url.origin !== location.origin) return;
    if (SKIP_PATHS.some(p => url.pathname.startsWith(p))) return;

    event.respondWith(
        caches.open(CACHE_NAME).then(cache =>
            // Önce ağdan dene, başarılıysa cache'e kaydet
            fetch(event.request)
                .then(response => {
                    if (response && response.status === 200) {
                        cache.put(event.request, response.clone());
                    }
                    return response;
                })
                .catch(() =>
                    // Ağ yoksa cache'ten sun
                    cache.match(event.request).then(cached => {
                        if (cached) return cached;
                        // Navigation isteğiyse index.html'i dön
                        if (event.request.mode === 'navigate') {
                            return cache.match('/') || cache.match('/index.html');
                        }
                    })
                )
        )
    );
});
