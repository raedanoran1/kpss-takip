const CACHE_NAME = 'kpss-takip-v5';

const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/js/chrome-polyfill.js',
    '/js/sidepanel.js',
    '/js/db.js',
    '/js/state/app-state.js',
    '/js/utils/format-utils.js',
    '/js/utils/logger.js',
    '/js/utils/ui-utils.js',
    '/js/managers/backup-manager.js',
    '/js/managers/cevsen-manager.js',
    '/js/managers/drawing-manager.js',
    '/js/managers/focus-tracker-manager.js',
    '/js/managers/habits-manager.js',
    '/js/managers/knowledge-manager.js',
    '/js/managers/notes-manager.js',
    '/js/managers/pdf-viewer-manager.js',
    '/js/managers/questions-manager.js',
    '/js/managers/resource-manager.js',
    '/js/managers/speed-reading-manager.js',
    '/js/managers/study-session-manager.js',
    '/js/managers/today-manager.js',
    '/js/managers/topic-manager.js',
    '/js/managers/trial-manager.js',
    '/js/managers/voice-library-manager.js',
    '/js/managers/yasin-manager.js',
    '/lib/sql-wasm.js',
    '/lib/sql-wasm.wasm',
    '/lib/pdf.min.js',
    '/lib/pdf.worker.min.js',
    '/css/styles.css',
    '/css/modules/base.css',
    '/css/modules/cevsen.css',
    '/css/modules/chat.css',
    '/css/modules/components.css',
    '/css/modules/custom-modals.css',
    '/css/modules/dashboard.css',
    '/css/modules/drawing-canvas.css',
    '/css/modules/global-header.css',
    '/css/modules/habits.css',
    '/css/modules/inline-drawing.css',
    '/css/modules/knowledge-base.css',
    '/css/modules/layout.css',
    '/css/modules/pdf-viewer.css',
    '/css/modules/questions.css',
    '/css/modules/resources.css',
    '/css/modules/resource-viewer.css',
    '/css/modules/session.css',
    '/css/modules/session-drawing.css',
    '/css/modules/session-header.css',
    '/css/modules/speed-reading.css',
    '/css/modules/trials.css',
    '/css/modules/voice-library.css',
    '/css/modules/yasin.css',
    '/pwa-manifest.json',
    '/icons/icon48.png',
    '/icons/icon128.png',
    '/images/eraser.png',
    '/images/kalem.png',
    '/images/optik.png',
    '/fonts/Inter-Variable.woff2',
    '/web_resources/data/cevsen_supply.json',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS).catch((err) => {
                console.warn('[SW] Some assets failed to cache:', err);
            });
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    if (url.origin !== location.origin) {
        return;
    }

    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;

            return fetch(event.request).then((response) => {
                if (!response || response.status !== 200 || response.type === 'opaque') {
                    return response;
                }
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                return response;
            }).catch(() => {
                if (event.request.headers.get('accept').includes('text/html')) {
                    return caches.match('/index.html');
                }
            });
        })
    );
});
