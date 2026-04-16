import { db, IDB_CONFIG } from '../db.js';
import { showToast, showConfirm } from '../utils/ui-utils.js';
import { logger } from '../utils/logger.js';

// ─── Sabitler ────────────────────────────────────────────────────────────────

const DB_STORAGE_KEY = 'kpss_db';

const STATIC_SETTINGS_KEYS = [
    'app_state', 'preferredMicId', 'daily_focus_tracker',
    'cevsen_last_bab', 'cevsen_display_lang', 'yasin_font_size',
    'driveSyncToken', 'driveSyncEnabled', 'lastSyncTime',
    'pdfDrawingSettings',
];

export function setupBackupUI() {}

// ─── IndexedDB — Sadece anahtarlar (veri yüklemeden) ────────────────────────

function getIDBKeys(storeName) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_CONFIG.name, IDB_CONFIG.version);
        req.onupgradeneeded = e => {
            if (!e.target.result.objectStoreNames.contains(storeName))
                e.target.result.createObjectStore(storeName);
        };
        req.onsuccess = e => {
            const dbRef = e.target.result;
            if (!dbRef.objectStoreNames.contains(storeName)) { resolve([]); return; }
            const keysReq = dbRef.transaction(storeName, 'readonly').objectStore(storeName).getAllKeys();
            keysReq.onsuccess = () => resolve(keysReq.result);
            keysReq.onerror  = () => reject(keysReq.error);
        };
        req.onerror = () => reject(req.error);
    });
}

// IndexedDB — TEK bir değer getir
function getOneFromIDB(storeName, key) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_CONFIG.name, IDB_CONFIG.version);
        req.onsuccess = e => {
            const dbRef = e.target.result;
            if (!dbRef.objectStoreNames.contains(storeName)) { resolve(undefined); return; }
            const getReq = dbRef.transaction(storeName, 'readonly').objectStore(storeName).get(key);
            getReq.onsuccess = () => resolve(getReq.result);
            getReq.onerror  = () => reject(getReq.error);
        };
        req.onerror = () => reject(req.error);
    });
}

// IndexedDB — Geri yükleme
function restoreToIDB(storeName, data) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_CONFIG.name, IDB_CONFIG.version);
        req.onupgradeneeded = e => {
            if (!e.target.result.objectStoreNames.contains(storeName))
                e.target.result.createObjectStore(storeName);
        };
        req.onsuccess = e => {
            const dbRef = e.target.result;
            if (!dbRef.objectStoreNames.contains(storeName)) {
                reject(new Error(`IDB Store "${storeName}" bulunamadı`)); return;
            }
            const tx    = dbRef.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            store.clear();
            Object.entries(data).forEach(([k, v]) => store.put(v, k));
            tx.oncomplete = () => resolve();
            tx.onerror    = evt => reject(tx.error || evt.target.error);
        };
        req.onerror = () => reject(req.error);
    });
}

// ─── Yardımcı Fonksiyonlar ───────────────────────────────────────────────────

const yieldToMain = () => new Promise(r => setTimeout(r, 0));

function uint8ToBase64(u8Arr) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            if (typeof reader.result === 'string') resolve(reader.result.split(',')[1] || '');
            else reject(new Error('uint8ToBase64 başarısız'));
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(new Blob([u8Arr], { type: 'application/octet-stream' }));
    });
}

function base64ToUint8(b64) {
    const raw = atob(b64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; ++i) arr[i] = raw.charCodeAt(i);
    return arr;
}

async function fetchOneKey(key) {
    try { const d = await chrome.storage.local.get(key); return d[key]; }
    catch (e) { logger.warn(`fetchOneKey(${key}) başarısız:`, e); return undefined; }
}

function getAssetKeysFromDB(type) {
    try {
        const sql = type === 'images'
            ? `SELECT image_storage_key FROM questions WHERE image_storage_key IS NOT NULL
               UNION SELECT image_storage_key FROM notes WHERE image_storage_key IS NOT NULL`
            : `SELECT audio_storage_key FROM notes WHERE audio_storage_key IS NOT NULL`;
        return db.exec(sql)[0]?.values?.flat() ?? [];
    } catch (e) { logger.error('getAssetKeysFromDB:', e); return []; }
}

function getResourceIds() {
    try { return db.exec('SELECT id FROM resources')[0]?.values?.flat() ?? []; }
    catch (e) { return []; }
}

// ─── BÜYÜK DEĞER YAZMA ───────────────────────────────────────────────────────
//
// PROBLEM: JSON.stringify(largStr) tüm string'i kopyalar → 2× bellek baskısı.
//          100MB PDF → 133MB base64 → JSON.stringify → +133MB kopya = 266MB peak.
//
// ÇÖZÜM:   Base64 karakterleri (A-Z a-z 0-9 + / =) JSON-safe'dir, kaçış
//          gerektirmez. Bu yüzden büyük base64'leri tırnak içinde chunk'larla
//          yazabiliriz → anlık bellek = sadece 1 chunk (~512KB).

// Base64 string'i JSON string literal olarak chunk'larla yaz
async function writeB64AsJsonStr(writer, b64) {
    const CHUNK = 512 * 1024; // 512 KB
    await writer.write('"');
    for (let i = 0; i < b64.length; i += CHUNK) {
        await writer.write(b64.slice(i, i + CHUNK));
        await yieldToMain();
    }
    await writer.write('"');
}

// Blob'u base64'e chunk'larla dönüştür ve yaz (hiç tam Blob belleğe alınmaz)
async function writeBlobAsB64JsonStr(writer, blob) {
    // chunk boyutu 3'ün katı OLMALI → base64 sınırında padding olmaz
    const CHUNK  = 3 * 256 * 1024; // 768 KB
    const BATCH  = 4096;            // String.fromCharCode için güvenli batch
    await writer.write('"');
    let offset = 0;
    while (offset < blob.size) {
        const slice  = blob.slice(offset, offset + CHUNK);
        const buffer = await slice.arrayBuffer();
        const bytes  = new Uint8Array(buffer);
        let binary = '';
        // String.fromCharCode(...largeArray) → stack overflow; BATCH kullan
        for (let i = 0; i < bytes.length; i += BATCH) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + BATCH));
        }
        await writer.write(btoa(binary));
        offset += CHUNK;
        await yieldToMain();
    }
    await writer.write('"');
}

// Herhangi bir PDF değerini JSON string olarak güvenle yaz
async function writePDFValue(writer, value) {
    if (typeof value === 'string') {
        // Zaten string (data URL veya saf base64)
        const b64 = value.startsWith('data:') ? (value.split(',')[1] ?? '') : value;
        await writeB64AsJsonStr(writer, b64);
    } else if (value instanceof Blob) {
        await writeBlobAsB64JsonStr(writer, value);
    } else if (value instanceof Uint8Array) {
        await writeBlobAsB64JsonStr(writer, new Blob([value]));
    } else if (value instanceof ArrayBuffer) {
        await writeBlobAsB64JsonStr(writer, new Blob([value]));
    } else {
        // Bilinmeyen tip — Blob'a sar
        try { await writeBlobAsB64JsonStr(writer, new Blob([value])); }
        catch (e) { await writer.write('"[hatalı veri]"'); logger.error('writePDFValue:', e); }
    }
}

// ─── TÜM VERİYİ WRITER'A YAZ ─────────────────────────────────────────────────
// writer: { write(str: string): Promise<void> }
//   → StreamWriter  : File System Access API — diske doğrudan yazar
//   → BlobWriter    : parts[] biriktiren fallback

async function writeBackupData(writer, onProgress) {
    // 1. Veritabanı
    onProgress(3, 'Veritabanı aktarılıyor...');
    const dbArray  = db.export();
    await yieldToMain();
    const dbBase64 = await uint8ToBase64(dbArray);
    await yieldToMain();
    onProgress(8, 'Veritabanı hazır.');

    // 2. Anahtarları SQLite'tan derle (storage'a dokunmadan)
    const imageKeys       = getAssetKeysFromDB('images');
    const audioKeys       = getAssetKeysFromDB('audio');
    const resourceIds     = getResourceIds();
    const settingsKeys    = [
        ...STATIC_SETTINGS_KEYS,
        ...resourceIds.map(id => `pdf_last_page_${id}`),
        ...resourceIds.map(id => `pdfZoomScale_${id}`),
        ...resourceIds.flatMap(id => {
            // Sayfa bazlı annotasyon anahtarları için patterns oluşturulabilir
            // ama bunları DB'den tam olarak bilmiyoruz — settings grubunda genel
            return [];
        }),
    ];
    const pdfFallbackKeys = resourceIds.map(id => `res_pdf_${id}`);
    const idbPDFKeys      = await getIDBKeys(IDB_CONFIG.store);

    logger.log(`Yedek: ${imageKeys.length} resim, ${audioKeys.length} ses, ${idbPDFKeys.length} IDB PDF`);

    // JSON başlangıcı
    await writer.write('{"version":3,"timestamp":' + Date.now() + ',"database":');
    await writeB64AsJsonStr(writer, dbBase64);
    await yieldToMain();

    // 3. Ayarlar (küçük JSON — güvenli)
    onProgress(9, 'Ayarlar okunuyor...');
    const rawSettings = await chrome.storage.local.get(settingsKeys);
    const settings = {};
    settingsKeys.forEach(k => { if (rawSettings[k] !== undefined) settings[k] = rawSettings[k]; });
    await writer.write(',"settings":');
    await writer.write(JSON.stringify(settings));
    await yieldToMain();
    onProgress(12, 'Ayarlar hazır.');

    // 4. Resimler — her biri ayrı ayrı (12-52%)
    await writer.write(',"images":{');
    let imgFirst = true;
    for (let i = 0; i < imageKeys.length; i++) {
        onProgress(12 + Math.round(i / Math.max(imageKeys.length, 1) * 40),
            `Resimler: ${i + 1} / ${imageKeys.length}`);
        const val = await fetchOneKey(imageKeys[i]);
        if (val !== undefined) {
            if (!imgFirst) await writer.write(',');
            imgFirst = false;
            // Resimler zaten base64 string — yine de chunk'larla yaz
            await writer.write(JSON.stringify(imageKeys[i]) + ':');
            await writeB64AsJsonStr(writer, typeof val === 'string' && val.startsWith('data:')
                ? (val.split(',')[1] ?? val) : val);
        }
        await yieldToMain();
    }
    await writer.write('}');

    // 5. Ses kayıtları — her biri ayrı ayrı (52-72%)
    await writer.write(',"audio":{');
    let audioFirst = true;
    for (let i = 0; i < audioKeys.length; i++) {
        onProgress(52 + Math.round(i / Math.max(audioKeys.length, 1) * 20),
            `Ses kayıtları: ${i + 1} / ${audioKeys.length}`);
        const val = await fetchOneKey(audioKeys[i]);
        if (val !== undefined) {
            if (!audioFirst) await writer.write(',');
            audioFirst = false;
            await writer.write(JSON.stringify(audioKeys[i]) + ':');
            await writeB64AsJsonStr(writer, typeof val === 'string' && val.startsWith('data:')
                ? (val.split(',')[1] ?? val) : val);
        }
        await yieldToMain();
    }
    await writer.write('}');

    // 6. PDF fallback (chrome.storage) (72-80%)
    await writer.write(',"pdfFallbacks":{');
    let pdfFallFirst = true;
    for (let i = 0; i < pdfFallbackKeys.length; i++) {
        const val = await fetchOneKey(pdfFallbackKeys[i]);
        if (val !== undefined) {
            onProgress(72 + Math.round(i / Math.max(pdfFallbackKeys.length, 1) * 8),
                `PDF fallback: ${i + 1} / ${pdfFallbackKeys.length}`);
            if (!pdfFallFirst) await writer.write(',');
            pdfFallFirst = false;
            await writer.write(JSON.stringify(pdfFallbackKeys[i]) + ':');
            await writePDFValue(writer, val);
        }
        await yieldToMain();
    }
    await writer.write('}');

    // 7. IndexedDB PDF'leri — her biri AYRI AYRI çekilir ve CHUNK'larla yazılır (80-96%)
    //    JSON.stringify(largePdfBase64) KULLANILMAZ → writePDFValue kullanılır
    onProgress(80, 'PDF dosyaları işleniyor...');
    await writer.write(',"indexedDB":{"pdfs":{');
    let idbFirst = true;
    for (let i = 0; i < idbPDFKeys.length; i++) {
        onProgress(80 + Math.round(i / Math.max(idbPDFKeys.length, 1) * 16),
            `PDF: ${i + 1} / ${idbPDFKeys.length}`);

        // TEK bir PDF çek — işle — referansı bırak (GC)
        const value = await getOneFromIDB(IDB_CONFIG.store, idbPDFKeys[i]);
        if (value !== undefined) {
            if (!idbFirst) await writer.write(',');
            idbFirst = false;
            await writer.write(JSON.stringify(idbPDFKeys[i]) + ':');
            // writePDFValue → chunk'larla yazar, hiç büyük string oluşmaz
            await writePDFValue(writer, value);
        }
        await yieldToMain();
    }
    await writer.write('}}}');
    await yieldToMain();
}

// ─── YEDEK OLUŞTUR ───────────────────────────────────────────────────────────
//
// Strateji 1 (birincil): File System Access API
//   → showSaveFilePicker → FileSystemWritableFileStream.write()
//   → Veriler doğrudan diske yazılır, belleğe hiç birikmez
//   → Sonsuz boyut desteği
//
// Strateji 2 (yedek): Blob indirme
//   → Veriler blobParts[] içinde birikirken her anahtar ayrı ayrı çekilir
//   → Büyük PDF setlerinde yetersiz olabilir ama küçük/orta veriler için çalışır

export async function createFullBackup(onProgress = () => {}) {
    try {
        onProgress(0, 'Başlatılıyor...');

        // ── Strateji 1: File System Access API ───────────────────────────────
        if (typeof window.showSaveFilePicker === 'function') {
            let fileHandle;
            try {
                fileHandle = await window.showSaveFilePicker({
                    suggestedName: `kpss_takip_backup_${new Date().toISOString().slice(0, 10)}.json`,
                    types: [{ description: 'KPSS Yedek Dosyası', accept: { 'application/json': ['.json'] } }],
                });
            } catch (e) {
                if (e.name === 'AbortError') return; // Kullanıcı iptal etti
                logger.warn('showSaveFilePicker başarısız:', e.message, '— Blob moduna geçiliyor.');
                await _backupAsBlob(onProgress);
                return;
            }

            const writable = await fileHandle.createWritable();
            const streamWriter = { write: str => writable.write(str) };
            try {
                await writeBackupData(streamWriter, onProgress);
                await writable.close();
                onProgress(100, 'Yedek tamamlandı!');
                showToast('Yedek dosyası başarıyla kaydedildi.');
            } catch (err) {
                try { await writable.abort(); } catch (_) {}
                throw err;
            }
            return;
        }

        // ── Strateji 2: Blob indirme ──────────────────────────────────────────
        await _backupAsBlob(onProgress);

    } catch (err) {
        logger.error('Backup failed:', err);
        onProgress(0, 'Hata: ' + err.message);
        showToast('Yedekleme başarısız: ' + err.message, 'error');
        throw err;
    }
}

async function _backupAsBlob(onProgress) {
    const parts = [];
    const blobWriter = { write: str => { parts.push(str); return Promise.resolve(); } };
    await writeBackupData(blobWriter, onProgress);

    onProgress(97, 'Dosya oluşturuluyor...');
    await yieldToMain();

    const blob = new Blob(parts, { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `kpss_takip_backup_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    onProgress(100, 'Yedek tamamlandı!');
    showToast('Yedek dosyası başarıyla indirildi.');
}

// ─── GERİ YÜKLE ──────────────────────────────────────────────────────────────

export async function restoreBackup(file) {
    if (!file) return;
    try {
        const text       = await file.text();
        const backupData = JSON.parse(text);

        if (!backupData.database)
            throw new Error('Geçersiz yedek dosyası: database alanı eksik.');

        const version = backupData.version || 1;

        if (!await showConfirm(
            'Mevcut tüm veriler silinecek ve yedekten geri yüklenecek. Onaylıyor musun?'
        )) return;

        showToast('Geri yükleme başladı...', 'info');
        await chrome.storage.local.clear();

        if (version >= 3) {
            const toRestore = {};
            if (backupData.settings) Object.assign(toRestore, backupData.settings);
            if (backupData.images) {
                Object.entries(backupData.images).forEach(([k, v]) => {
                    toRestore[k] = (typeof v === 'string' && !v.startsWith('data:'))
                        ? 'data:image/png;base64,' + v : v;
                });
            }
            if (backupData.audio) {
                Object.entries(backupData.audio).forEach(([k, v]) => {
                    toRestore[k] = (typeof v === 'string' && !v.startsWith('data:'))
                        ? 'data:audio/webm;base64,' + v : v;
                });
            }
            if (backupData.pdfFallbacks) Object.assign(toRestore, backupData.pdfFallbacks);
            if (Object.keys(toRestore).length) await chrome.storage.local.set(toRestore);
        } else {
            // v1/v2 uyumluluğu
            const filtered = {};
            Object.entries(backupData.localStorage || {}).forEach(([k, v]) => {
                if (k !== DB_STORAGE_KEY) filtered[k] = v;
            });
            if (Object.keys(filtered).length) await chrome.storage.local.set(filtered);
        }

        // Veritabanını base64'ten decode edip yaz
        const dbUint8 = base64ToUint8(backupData.database);
        await chrome.storage.local.set({ [DB_STORAGE_KEY]: Array.from(dbUint8) });

        // IndexedDB PDF'lerini geri yükle
        if (backupData.indexedDB?.pdfs) {
            const restoredPDFs = {};
            for (const [key, stored] of Object.entries(backupData.indexedDB.pdfs)) {
                restoredPDFs[key] = (typeof stored === 'string' && stored.startsWith('data:'))
                    ? stored
                    : base64ToUint8(stored);
            }
            await restoreToIDB(IDB_CONFIG.store, restoredPDFs);
        }

        showToast('Geri yükleme tamamlandı. Uygulama yenileniyor...');
        setTimeout(() => window.location.reload(), 1500);

    } catch (err) {
        logger.error('Restore failed:', err);
        showToast('Geri yükleme hatası: ' + err.message, 'error');
        throw err;
    }
}
