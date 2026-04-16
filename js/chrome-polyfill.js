/**
 * Chrome Extension API Polyfill
 * chrome.storage.local → IndexedDB
 * chrome.runtime.getURL → relative paths
 * Audio recording → direct MediaRecorder API
 */
(function () {
    'use strict';

    const STORAGE_DB_NAME = 'chrome_storage_polyfill';
    const STORAGE_STORE = 'kv';
    let _db = null;

    function openDB() {
        if (_db) return Promise.resolve(_db);
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(STORAGE_DB_NAME, 1);
            req.onupgradeneeded = (e) => {
                e.target.result.createObjectStore(STORAGE_STORE);
            };
            req.onsuccess = (e) => {
                _db = e.target.result;
                resolve(_db);
            };
            req.onerror = () => reject(req.error);
        });
    }

    // Message bus (replaces chrome.runtime messaging)
    const _messageListeners = [];

    function _dispatch(msg) {
        _messageListeners.forEach(fn => {
            try { fn(msg, {}, () => {}); } catch (e) { console.error('[polyfill] listener error', e); }
        });
    }

    // ── Audio Recording (replaces offscreen document) ───────────────────────
    let _recorder = null;
    let _chunks = [];
    let _shouldSave = true;

    async function _startRecording(micId) {
        try {
            let stream;
            try {
                stream = await navigator.mediaDevices.getUserMedia(
                    { audio: micId ? { deviceId: { exact: micId } } : true }
                );
            } catch (_) {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }

            _recorder = new MediaRecorder(stream);
            _chunks = [];
            _recorder.ondataavailable = (e) => { if (e.data.size > 0) _chunks.push(e.data); };
            _recorder.onstop = () => {
                stream.getTracks().forEach(t => t.stop());
                if (!_shouldSave) { _chunks = []; return; }
                const blob = new Blob(_chunks, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.onloadend = () => _dispatch({ target: 'sidepanel', type: 'VOICE_NOTE_DATA', data: reader.result });
                reader.readAsDataURL(blob);
            };
            _shouldSave = true;
            _recorder.start();
            _dispatch({ target: 'sidepanel', type: 'RECORDING_STARTED' });
        } catch (err) {
            console.error('[polyfill] recording error', err);
            _dispatch({ target: 'sidepanel', type: 'RECORDING_ERROR', error: err.name || 'UnknownError' });
        }
    }

    function _stopRecording(save) {
        _shouldSave = save !== false;
        if (_recorder && _recorder.state !== 'inactive') _recorder.stop();
    }

    function _pauseRecording() {
        if (_recorder && _recorder.state === 'recording') _recorder.pause();
    }

    function _resumeRecording() {
        if (_recorder && _recorder.state === 'paused') _recorder.resume();
    }

    // ── Chrome API ──────────────────────────────────────────────────────────
    window.chrome = {
        runtime: {
            getURL: (path) => {
                if (!path) return './';
                if (path.startsWith('http') || path.startsWith('data:')) return path;
                const clean = path.startsWith('/') ? path.slice(1) : path;
                return './' + clean;
            },
            lastError: null,
            sendMessage: (msg, cb) => {
                if (msg && msg.target === 'offscreen') {
                    setTimeout(() => {
                        if (msg.type === 'START_RECORDING') _startRecording(msg.micId);
                        else if (msg.type === 'STOP_RECORDING') _stopRecording(msg.save);
                        else if (msg.type === 'PAUSE_RECORDING') _pauseRecording();
                        else if (msg.type === 'RESUME_RECORDING') _resumeRecording();
                    }, 0);
                }
                if (typeof cb === 'function') cb();
                return Promise.resolve();
            },
            onMessage: { addListener: (fn) => _messageListeners.push(fn) },
            onInstalled: { addListener: () => {} },
            openOptionsPage: () => {},
            getContexts: () => Promise.resolve([]),
        },

        storage: {
            local: {
                get: async (keys) => {
                    const db = await openDB();
                    return new Promise((resolve) => {
                        if (keys === null || keys === undefined) {
                            const tx = db.transaction(STORAGE_STORE, 'readonly');
                            const store = tx.objectStore(STORAGE_STORE);
                            const kr = store.getAllKeys();
                            const vr = store.getAll();
                            let k, v;
                            kr.onsuccess = () => { k = kr.result; if (v !== undefined) done(); };
                            vr.onsuccess = () => { v = vr.result; if (k !== undefined) done(); };
                            kr.onerror = () => resolve({});
                            function done() {
                                const r = {};
                                k.forEach((key, i) => { r[key] = v[i]; });
                                resolve(r);
                            }
                            return;
                        }
                        if (typeof keys === 'string') keys = [keys];
                        if (!Array.isArray(keys)) keys = Object.keys(keys);
                        if (keys.length === 0) { resolve({}); return; }
                        const result = {};
                        let pending = keys.length;
                        const tx = db.transaction(STORAGE_STORE, 'readonly');
                        const store = tx.objectStore(STORAGE_STORE);
                        keys.forEach(key => {
                            const req = store.get(key);
                            req.onsuccess = () => {
                                if (req.result !== undefined) result[key] = req.result;
                                if (--pending === 0) resolve(result);
                            };
                            req.onerror = () => { if (--pending === 0) resolve(result); };
                        });
                    });
                },

                set: async (items) => {
                    const db = await openDB();
                    return new Promise((resolve, reject) => {
                        const tx = db.transaction(STORAGE_STORE, 'readwrite');
                        const store = tx.objectStore(STORAGE_STORE);
                        Object.entries(items).forEach(([k, v]) => store.put(v, k));
                        tx.oncomplete = () => resolve();
                        tx.onerror = () => reject(tx.error);
                    });
                },

                clear: async () => {
                    const db = await openDB();
                    return new Promise((resolve, reject) => {
                        const tx = db.transaction(STORAGE_STORE, 'readwrite');
                        tx.objectStore(STORAGE_STORE).clear();
                        tx.oncomplete = () => resolve();
                        tx.onerror = () => reject(tx.error);
                    });
                },

                remove: async (keys) => {
                    if (typeof keys === 'string') keys = [keys];
                    const db = await openDB();
                    return new Promise((resolve, reject) => {
                        const tx = db.transaction(STORAGE_STORE, 'readwrite');
                        const store = tx.objectStore(STORAGE_STORE);
                        keys.forEach(k => store.delete(k));
                        tx.oncomplete = () => resolve();
                        tx.onerror = () => reject(tx.error);
                    });
                }
            }
        },

        identity: {
            getAuthToken: (opts, cb) => { if (typeof cb === 'function') cb(null); },
            removeCachedAuthToken: (opts, cb) => { if (typeof cb === 'function') cb(); }
        },

        tabs: {
            onUpdated: { addListener: () => {} },
            remove: () => Promise.resolve()
        },

        sidePanel: {
            setPanelBehavior: () => Promise.resolve()
        },

        offscreen: {
            createDocument: () => Promise.resolve()
        }
    };
})();
