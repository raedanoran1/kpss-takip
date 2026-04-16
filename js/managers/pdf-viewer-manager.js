import { getResourcePDF, updateResourceLastPage, savePageAnnotation, getPageAnnotation, addStudyNote, addVoiceNote, addQuestion, saveStudySession, getResources, getAllQuestions, getResourceById, getTopicStudyStats } from '../db.js';
import { showToast } from '../utils/ui-utils.js';
import { appState, persistState } from '../state/app-state.js';
import { logger } from '../utils/logger.js';

let pdfDoc = null;
let currentResourceId = null;
let currentScale = 1.25; // Varsayılan yakınlaştırma %125
let renderedPages = [];
let currentPageNum = 1;
let renderTimeout = null;

// --- Last page quick-persist (for sidepanel close / crash safety) ---
let lastPagePersistTimer = null;
let lastPagePersistPending = null;

function lastPageCacheKey(resourceId) {
    return `pdf_last_page_${resourceId}`;
}

async function persistLastPageQuick(resourceId, pageNum) {
    if (!resourceId || !pageNum) return;
    try {
        await chrome.storage.local.set({ [lastPageCacheKey(resourceId)]: pageNum });
    } catch (err) {
        logger.warn('[PDF] persistLastPageQuick failed:', err);
    }
}

function schedulePersistLastPage(resourceId, pageNum) {
    // Debounce to avoid spamming storage on scroll
    lastPagePersistPending = { resourceId, pageNum };
    if (lastPagePersistTimer) return;
    lastPagePersistTimer = setTimeout(async () => {
        lastPagePersistTimer = null;
        const p = lastPagePersistPending;
        lastPagePersistPending = null;
        if (p) await persistLastPageQuick(p.resourceId, p.pageNum);
    }, 250);
}

async function getLastPageFromCache(resourceId) {
    if (!resourceId) return null;
    try {
        const k = lastPageCacheKey(resourceId);
        const stored = await chrome.storage.local.get(k);
        const v = stored[k];
        return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : null;
    } catch (err) {
        logger.warn('[PDF] getLastPageFromCache failed:', err);
        return null;
    }
}

// Drawing state
let isDrawing = false;
let lastX = 0;
let lastY = 0;

let currentTool = 'pen';
let currentColor = '#ff0000';
let currentSize = 2;
let eraserSize = 20;
let activeCanvas = null;

// Optik form sabitleri (gerçek piksel boyutları)
const OPTIC_WIDTH = 268;
const OPTIC_HEIGHT = 642;
// Sayfa numarası alanı içinde özel, gerçek sayfalarla çakışmayacak aralık
const OPTIC_PAGE_GY = 100001; // Genel Yetenek
const OPTIC_PAGE_GK = 100002; // Genel Kültür
const OPTIC_SPECIAL_MIN = 100000;

// Optik panel durumu
let opticPanelInitialized = false;
let opticPanelVisible = false;
let opticActiveTab = 'GY'; // 'GY' | 'GK'
let opticCanvases = {
    GY: null,
    GK: null
};
let opticHasChanges = {
    GY: false,
    GK: false
};
let opticLastSaveTime = {
    GY: 0,
    GK: 0
};

// Timer state
let studyTimerInterval = null;
let sessionSeconds = 0;
let sessionQCount = 0;
let currentResourceSubject = '';

// Kronometre state
let _kronoVisible = false;
let _kronoRunning = false;
let _kronoSeconds = 0;
let _kronoInterval = null;
let _kronoDragging = false;
let _kronoDragOffsetX = 0;
let _kronoDragOffsetY = 0;
let _kronoMoveHandler = null;
let _kronoUpHandler = null;
let _kronoTouchMoveHandler = null;
let _kronoTouchEndHandler = null;

// Recording state
let recordingTimer = null;
let recordingStartTime = 0;
let recordingPaused = false;
let totalPausedTime = 0;
let pausedAt = 0;
let activeRecordingResourceId = null;
// Make activeRecordingResourceId globally accessible for study session listener to check
Object.defineProperty(window, 'activeRecordingResourceId', {
    get: () => activeRecordingResourceId,
    enumerable: true,
    configurable: true
});

// Hand (pan) tool state
let isPanning = false;
let panStartY = 0;
let panStartScrollTop = 0;
let handScrollSpeed = 3; // El aracı dikey kaydırma hızı (varsayılan 3x)

// Screenshot state
let screenshotMode = null; // 'note' or 'question'
let isSelecting = false;
let selectionStart = { x: 0, y: 0 };
let selectionEnd = { x: 0, y: 0 };
let selectionOverlay = null;
let selectionPageNum = null;
let selectionCanvasRect = null; // Cache for screenshot selection canvas rect
let continuousMode = false; // Sürekli mod: açıkken not/soru ekleme modu kapanmaz (varsayılan: kapalı)

// PDF Hizalama durumu
let pdfAlignMode = 'left'; // 'left' | 'center' | 'right'

// Kağıt/Kitap modu durumu
let paperModeEnabled = false;

// İkinci PDF Popup durumu
let secondaryPopupVisible = false;
let secondaryCurrentPage = 1;
let secondaryDragging = false;
let secondaryResizing = false;
let secondaryDragOffsetX = 0;
let secondaryDragOffsetY = 0;
let secondaryResizeStartX = 0;
let secondaryResizeStartY = 0;
let secondaryResizeStartW = 0;
let secondaryResizeStartH = 0;
let secondaryPopupX = null;
let secondaryPopupY = null;
let secondaryPopupW = 580;
let secondaryPopupH = 700;
let secondaryPages = []; // { pageNum, container, canvas, isRendered }
let secondaryLazyObserver = null;
let secondaryScale = 0.9; // Varsayılan %90

// Event listener references for cleanup
let zoomListener = null;
let scrollListener = null;
let screenshotListeners = {
    pointerdown: null,
    pointermove: null,
    pointerup: null
};

// Secondary popup drag/resize handler refs (leak prevention)
let _secMousemoveHandler = null;
let _secMouseupHandler = null;
let _secMousedownHandler = null;
let _secResizeHandler = null;
let _secTouchmoveHandler = null;
let _secTouchendHandler = null;

// (Gemini popup durum değişkenleri aşağıdaki bölümde tanımlanır)

// Sık kullanılan DOM elementleri cache (her getElementById çağrısını önler)
let _domCache = {};
function _el(id) {
    if (!_domCache[id]) _domCache[id] = document.getElementById(id);
    return _domCache[id];
}

// --- Zoom Settings Persistence ---
// Her PDF için ayrı zoom seviyesi sakla
async function loadZoomSetting(resourceId) {
    if (!resourceId) {
        currentScale = 1.25; // Varsayılan %125
        return;
    }
    
    try {
        const key = `pdfZoomScale_${resourceId}`;
        const stored = await chrome.storage.local.get(key);
        const val = stored[key];
        if (typeof val === 'number' && !Number.isNaN(val)) {
            // Güvenli aralıkta tut
            currentScale = Math.min(5.0, Math.max(0.5, val));
        } else {
            currentScale = 1.25; // Varsayılan %125
        }
    } catch (err) {
        logger.warn('loadZoomSetting failed, using default zoom:', err);
        currentScale = 1.25; // Varsayılan %125
    }
}

function saveZoomSetting(resourceId) {
    if (!resourceId) return;
    
    try {
        const key = `pdfZoomScale_${resourceId}`;
        chrome.storage.local.set({ [key]: currentScale });
    } catch (err) {
        logger.warn('saveZoomSetting failed:', err);
    }
}

// --- PDF Hizalama Ayarları ---
async function loadAlignSetting(resourceId) {
    const key = `pdfAlign_${resourceId}`;
    try {
        const stored = await chrome.storage.local.get(key);
        const val = stored[key];
        pdfAlignMode = (val === 'left' || val === 'center' || val === 'right') ? val : 'left';
    } catch (e) {
        pdfAlignMode = 'left';
    }
}

function saveAlignSetting(resourceId) {
    if (!resourceId) return;
    try {
        chrome.storage.local.set({ [`pdfAlign_${resourceId}`]: pdfAlignMode });
    } catch (e) {}
}

function applyAlignMode(mode) {
    pdfAlignMode = mode;
    const container = document.getElementById('pdf-pages-container');
    if (container) {
        container.classList.remove('align-left', 'align-center', 'align-right');
        container.classList.add(`align-${mode}`);
    }
    document.querySelectorAll('.pdf-align-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.align === mode);
    });
}

// --- Kağıt/Kitap Modu ---
async function loadPaperModeSetting() {
    try {
        const stored = await chrome.storage.local.get('pdfPaperMode');
        paperModeEnabled = stored.pdfPaperMode === true;
    } catch (e) {
        paperModeEnabled = false;
    }
}

function savePaperModeSetting() {
    try {
        chrome.storage.local.set({ pdfPaperMode: paperModeEnabled });
    } catch (e) {}
}

function applyPaperMode(enabled) {
    paperModeEnabled = enabled;
    const overlay = document.getElementById('pdf-viewer-overlay');
    if (overlay) {
        overlay.classList.toggle('paper-mode', enabled);
    }
    const btn = document.getElementById('pdf-paper-mode-toggle');
    if (btn) {
        btn.classList.toggle('active', enabled);
        btn.title = enabled ? 'Kağıt Modu Kapat' : 'Kağıt/Kitap Modu Aç';
    }
}

// --- 2. PDF Popup Fonksiyonları ---

function secStateKey() { return 'pdfSecondaryState'; }

async function loadSecondaryState(resourceId) {
    try {
        const stored = await chrome.storage.local.get(secStateKey());
        const state = stored[secStateKey()] || {};
        // Sayfa (resource'a özel)
        const pg = state[`page_${resourceId}`];
        secondaryCurrentPage = (typeof pg === 'number' && pg > 0) ? pg : 1;
        // Konum
        if (typeof state.x === 'number' && typeof state.y === 'number') {
            secondaryPopupX = state.x;
            secondaryPopupY = state.y;
        } else {
            secondaryPopupX = null;
            secondaryPopupY = null;
        }
        // Boyut
        if (typeof state.w === 'number' && state.w >= 300) secondaryPopupW = state.w;
        if (typeof state.h === 'number' && state.h >= 200) secondaryPopupH = state.h;
        // Zoom — resource'a özel
        const scaleKey = `scale_${resourceId}`;
        if (typeof state[scaleKey] === 'number') {
            secondaryScale = state[scaleKey];
        } else {
            secondaryScale = 0.9;
        }
    } catch (e) {
        secondaryCurrentPage = 1;
        secondaryPopupX = null;
        secondaryPopupY = null;
        secondaryScale = 0.9;
    }
}

function saveSecondaryState(resourceId) {
    if (!resourceId) return;
    try {
        chrome.storage.local.get(secStateKey()).then(stored => {
            const state = stored[secStateKey()] || {};
            state[`page_${resourceId}`] = secondaryCurrentPage;
            state.x = secondaryPopupX;
            state.y = secondaryPopupY;
            state.w = secondaryPopupW;
            state.h = secondaryPopupH;
            state[`scale_${resourceId}`] = secondaryScale;
            chrome.storage.local.set({ [secStateKey()]: state });
        });
    } catch (e) {}
}

function applySecondaryPopupGeometry() {
    const popup = document.getElementById('pdf-secondary-popup');
    if (!popup) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Minimum Y: PDF overlay'inin gerçek üst pozisyonu (session/focus panel altında kalmak için)
    const overlay = document.getElementById('pdf-viewer-overlay');
    const safeMinY = overlay
        ? Math.max(overlay.getBoundingClientRect().top, 10)
        : 110;

    // Boyutu ekrana sığdır: genişlik max %95, yükseklik overlay altında kalan alana sığsın
    const maxW = Math.floor(vw * 0.95);
    const maxH = vh - safeMinY - 10;          // 10px alt boşluk
    const finalW = Math.min(Math.max(secondaryPopupW, 320), maxW);
    const finalH = Math.min(Math.max(secondaryPopupH, 200), maxH);

    popup.style.width = finalW + 'px';
    popup.style.height = finalH + 'px';

    // Konum
    if (secondaryPopupX !== null && secondaryPopupY !== null) {
        // Kaydedilmiş konum: ekran sınırlarına kliple
        const clampedX = Math.max(0, Math.min(secondaryPopupX, vw - 80));
        const clampedY = Math.max(safeMinY, Math.min(secondaryPopupY, vh - 40));
        popup.style.left = clampedX + 'px';
        popup.style.top = clampedY + 'px';
    } else {
        // İlk açılış: overlay'in hemen altından, yatayda ortalanmış
        const defaultX = Math.max(10, Math.round((vw - finalW) / 2));
        const defaultY = safeMinY + 5;
        popup.style.left = defaultX + 'px';
        popup.style.top = defaultY + 'px';
        secondaryPopupX = defaultX;
        secondaryPopupY = defaultY;
    }
    popup.style.right = 'auto';
    popup.style.bottom = 'auto';
}

// Tüm sayfaları dikey scroll ile render et (lazy loading ile)
async function renderSecondaryAllPages(scrollToPage) {
    if (!pdfDoc) return;
    const wrapper = document.getElementById('pdf-secondary-pages-wrapper');
    const body = document.getElementById('pdf-secondary-body');
    if (!wrapper || !body) return;

    // Önceki observer'ı temizle
    if (secondaryLazyObserver) {
        secondaryLazyObserver.disconnect();
        secondaryLazyObserver = null;
    }

    wrapper.innerHTML = '';
    secondaryPages = [];

    const total = pdfDoc.numPages;
    const totalEl = document.getElementById('pdf-secondary-total');
    const currentEl = document.getElementById('pdf-secondary-current');
    if (totalEl) totalEl.textContent = total;

    // Zoom input değerini güncelle
    const zoomInputEl = document.getElementById('pdf-secondary-zoom-input');
    if (zoomInputEl) zoomInputEl.value = Math.round(secondaryScale * 100);

    // İlk sayfanın boyutunu hesapla (placeholder için)
    const firstPage = await pdfDoc.getPage(1);
    const firstVp = firstPage.getViewport({ scale: secondaryScale });

    // Intersection Observer (lazy render)
    secondaryLazyObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const pageNum = parseInt(entry.target.dataset.pageNum);
            const pData = secondaryPages[pageNum - 1];
            if (pData && !pData.isRendered) {
                renderSecondaryOnePage(pData);
            }
        });
    }, {
        root: body,
        rootMargin: '150px',
        threshold: 0.05
    });

    for (let i = 1; i <= total; i++) {
        const container = document.createElement('div');
        container.className = 'pdf-secondary-page-container sec-placeholder';
        container.dataset.pageNum = i;
        container.style.width = firstVp.width + 'px';
        container.style.height = firstVp.height + 'px';
        wrapper.appendChild(container);

        const pData = { pageNum: i, container, canvas: null, isRendered: false };
        secondaryPages.push(pData);
        secondaryLazyObserver.observe(container);
    }

    // Kayıtlı sayfaya scroll yap
    const targetPage = Math.max(1, Math.min(scrollToPage || secondaryCurrentPage, total));
    setTimeout(() => {
        scrollSecondaryToPage(targetPage, false);
    }, 80);
}

async function renderSecondaryOnePage(pData) {
    if (!pdfDoc || pData.isRendered) return;
    pData.isRendered = true; // önce set et, çift render engelle

    try {
        const page = await pdfDoc.getPage(pData.pageNum);
        const viewport = page.getViewport({ scale: secondaryScale });

        pData.container.classList.remove('sec-placeholder');
        pData.container.style.width = viewport.width + 'px';
        pData.container.style.height = viewport.height + 'px';
        pData.container.innerHTML = '';

        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        pData.canvas = canvas;
        pData.container.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        const renderTask = page.render({ canvasContext: ctx, viewport });
        await renderTask.promise;
    } catch (err) {
        if (err && err.name !== 'RenderingCancelledException') {
            logger.warn(`[Secondary PDF] Render error page ${pData.pageNum}:`, err);
        }
        pData.isRendered = false; // başarısız olursa tekrar denensin
    }
}

function scrollSecondaryToPage(pageNum, smooth = true) {
    const body = document.getElementById('pdf-secondary-body');
    const pData = secondaryPages[pageNum - 1];
    if (!body || !pData) return;
    const offsetTop = pData.container.offsetTop;
    body.scrollTo({ top: Math.max(0, offsetTop - 12), behavior: smooth ? 'smooth' : 'instant' });
    secondaryCurrentPage = pageNum;
    const currentEl = document.getElementById('pdf-secondary-current');
    if (currentEl) currentEl.textContent = pageNum;
    updateSecondaryNavButtons();
}

function updateSecondaryCurrentPageFromScroll() {
    const body = document.getElementById('pdf-secondary-body');
    if (!body || secondaryPages.length === 0) return;
    const scrollTop = body.scrollTop;
    const bodyRect = body.getBoundingClientRect();

    let bestPage = secondaryCurrentPage;
    let bestOverlap = -1;

    for (const pData of secondaryPages) {
        const el = pData.container;
        const elTop = el.offsetTop - scrollTop;
        const elBottom = elTop + el.offsetHeight;
        const visTop = Math.max(0, elTop);
        const visBottom = Math.min(bodyRect.height, elBottom);
        const overlap = visBottom - visTop;
        if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestPage = pData.pageNum;
        }
    }

    if (bestPage !== secondaryCurrentPage) {
        secondaryCurrentPage = bestPage;
        const currentEl = document.getElementById('pdf-secondary-current');
        if (currentEl) currentEl.textContent = bestPage;
        updateSecondaryNavButtons();
        saveSecondaryState(currentResourceId);
    }
}

function updateSecondaryNavButtons() {
    if (!pdfDoc) return;
    const total = pdfDoc.numPages;
    const prevBtn = document.getElementById('pdf-secondary-prev');
    const nextBtn = document.getElementById('pdf-secondary-next');
    if (prevBtn) prevBtn.disabled = secondaryCurrentPage <= 1;
    if (nextBtn) nextBtn.disabled = secondaryCurrentPage >= total;
}

async function openSecondaryPopup() {
    const popup = document.getElementById('pdf-secondary-popup');
    if (!popup) return;
    await loadSecondaryState(currentResourceId);
    applySecondaryPopupGeometry();
    setupSecondaryPopupDrag();
    popup.classList.remove('hidden');
    secondaryPopupVisible = true;
    const toggleBtn = document.getElementById('pdf-secondary-toggle');
    if (toggleBtn) toggleBtn.classList.add('active');
    const toolbar2pBtn = document.getElementById('toolbar-2p-btn');
    if (toolbar2pBtn) toolbar2pBtn.classList.add('active');
    if (pdfDoc) {
        await renderSecondaryAllPages(secondaryCurrentPage);
        updateSecondaryNavButtons();
    }
}

function closeSecondaryPopup() {
    const popup = document.getElementById('pdf-secondary-popup');
    if (popup) popup.classList.add('hidden');
    secondaryPopupVisible = false;
    const toggleBtn = document.getElementById('pdf-secondary-toggle');
    if (toggleBtn) toggleBtn.classList.remove('active');
    const toolbar2pBtn = document.getElementById('toolbar-2p-btn');
    if (toolbar2pBtn) toolbar2pBtn.classList.remove('active');
    if (secondaryLazyObserver) {
        secondaryLazyObserver.disconnect();
        secondaryLazyObserver = null;
    }
    secondaryPages = [];
    // Bellek sızıntısını önle: tüm listener'ları temizle
    if (_secMousemoveHandler) {
        document.removeEventListener('mousemove', _secMousemoveHandler);
        _secMousemoveHandler = null;
    }
    if (_secMouseupHandler) {
        document.removeEventListener('mouseup', _secMouseupHandler);
        _secMouseupHandler = null;
    }
    if (_secMousedownHandler) {
        const header = document.getElementById('pdf-secondary-drag-handle');
        if (header) header.removeEventListener('mousedown', _secMousedownHandler);
        _secMousedownHandler = null;
    }
    if (_secResizeHandler) {
        const resizeHandle = document.getElementById('pdf-secondary-resize-handle');
        if (resizeHandle) resizeHandle.removeEventListener('mousedown', _secResizeHandler);
        _secResizeHandler = null;
    }
    if (_secTouchmoveHandler) {
        document.removeEventListener('touchmove', _secTouchmoveHandler);
        _secTouchmoveHandler = null;
    }
    if (_secTouchendHandler) {
        document.removeEventListener('touchend', _secTouchendHandler);
        document.removeEventListener('touchcancel', _secTouchendHandler);
        _secTouchendHandler = null;
    }
}

// === GEMİNİ POPUP FONKSİYONLARI ===

function _updateGeminiUI(isOpen) {
    const toggleBtn = document.getElementById('pdf-gemini-toggle');
    const refreshBtn = document.getElementById('pdf-gemini-refresh');
    if (toggleBtn) toggleBtn.classList.toggle('active', isOpen);
    if (refreshBtn) refreshBtn.disabled = !isOpen;
}

// === GEMİNİ İÇ POPUP DURUM DEĞİŞKENLERİ ===
const GEMINI_STATE_KEY = 'pdfGeminiState';
let geminiPopupVisible = false;
let geminiPopupX = null;
let geminiPopupY = null;
let geminiPopupW = 420;
let geminiPopupH = 680;
let geminiDragging = false;
let geminiResizing = false;
let geminiDragOffsetX = 0;
let geminiDragOffsetY = 0;
let geminiResizeStartX = 0;
let geminiResizeStartY = 0;
let geminiResizeStartW = 0;
let geminiResizeStartH = 0;
let _geminiMousemoveHandler = null;
let _geminiMouseupHandler = null;
let _geminiTouchmoveHandler = null;
let _geminiTouchendHandler = null;

async function _loadGeminiState() {
    try {
        const stored = await chrome.storage.local.get(GEMINI_STATE_KEY);
        const s = stored[GEMINI_STATE_KEY] || {};
        if (typeof s.x === 'number') geminiPopupX = s.x;
        if (typeof s.y === 'number') geminiPopupY = s.y;
        if (typeof s.w === 'number' && s.w >= 280) geminiPopupW = s.w;
        if (typeof s.h === 'number' && s.h >= 200) geminiPopupH = s.h;
    } catch (_) {}
}

function _saveGeminiState() {
    try {
        chrome.storage.local.set({
            [GEMINI_STATE_KEY]: { x: geminiPopupX, y: geminiPopupY, w: geminiPopupW, h: geminiPopupH }
        });
    } catch (_) {}
}

function _applyGeminiGeometry() {
    const popup = document.getElementById('pdf-gemini-popup');
    if (!popup) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // PDF header'ının altından başla — header üstüne çıkılmasın
    const pdfHeader = document.querySelector('.pdf-header');
    const safeMinY = pdfHeader
        ? Math.max(pdfHeader.getBoundingClientRect().bottom + 4, 60)
        : 165;
    const maxW = Math.floor(vw * 0.98);
    const maxH = vh - safeMinY - 10;
    const finalW = Math.min(Math.max(geminiPopupW, 280), maxW);
    const finalH = Math.min(Math.max(geminiPopupH, 200), maxH);
    popup.style.width = finalW + 'px';
    popup.style.height = finalH + 'px';
    if (geminiPopupX !== null && geminiPopupY !== null) {
        popup.style.left = Math.max(0, Math.min(geminiPopupX, vw - 80)) + 'px';
        popup.style.top = Math.max(safeMinY, Math.min(geminiPopupY, vh - 40)) + 'px';
    } else {
        const defaultX = Math.max(10, vw - finalW - 10);
        const defaultY = safeMinY + 5;
        popup.style.left = defaultX + 'px';
        popup.style.top = defaultY + 'px';
        geminiPopupX = defaultX;
        geminiPopupY = defaultY;
    }
    popup.style.right = 'auto';
    popup.style.bottom = 'auto';
}

async function openGeminiPopup() {
    if (geminiPopupVisible) return;
    await _loadGeminiState();
    const popup = document.getElementById('pdf-gemini-popup');
    if (!popup) return;
    // Lazy-load iframe (eklenti ile aynı davranış - sayfa yüklendiğinde değil, açıldığında yükle)
    const frame = document.getElementById('gemini-frame');
    if (frame && !frame.src.includes('gemini.google.com')) {
        frame.src = 'https://gemini.google.com/app';
    }
    _applyGeminiGeometry();
    popup.classList.remove('hidden');
    geminiPopupVisible = true;
    _updateGeminiUI(true);
    _setupGeminiDrag();
}

function closeGeminiPopup() {
    const popup = document.getElementById('pdf-gemini-popup');
    if (popup) popup.classList.add('hidden');
    geminiPopupVisible = false;
    _updateGeminiUI(false);
    _cleanupGeminiDrag();
}

function refreshGeminiPopup() {
    const frame = document.getElementById('gemini-frame');
    const blocked = document.getElementById('gemini-iframe-blocked');
    if (frame) {
        frame.style.display = '';
        if (blocked) blocked.style.display = 'none';
        // Lazy-load: eğer src henüz set edilmediyse şimdi set et, aksi halde yenile
        if (!frame.src.includes('gemini.google.com')) {
            frame.src = 'https://gemini.google.com/app';
        } else {
            frame.src = frame.src; // Yenile
        }
    }
    showToast('Gemini yenileniyor...');
}

function _cleanupGeminiDrag() {
    if (_geminiMousemoveHandler) {
        document.removeEventListener('mousemove', _geminiMousemoveHandler);
        _geminiMousemoveHandler = null;
    }
    if (_geminiMouseupHandler) {
        document.removeEventListener('mouseup', _geminiMouseupHandler);
        _geminiMouseupHandler = null;
    }
    if (_geminiTouchmoveHandler) {
        document.removeEventListener('touchmove', _geminiTouchmoveHandler);
        _geminiTouchmoveHandler = null;
    }
    if (_geminiTouchendHandler) {
        document.removeEventListener('touchend', _geminiTouchendHandler);
        document.removeEventListener('touchcancel', _geminiTouchendHandler);
        _geminiTouchendHandler = null;
    }
}

function _setupGeminiDrag() {
    const popup = document.getElementById('pdf-gemini-popup');
    const header = document.getElementById('pdf-gemini-drag-handle');
    const resizeHandle = document.getElementById('pdf-gemini-resize-handle');
    const iframe = null;
    if (!popup) return;

    if (header) {
        header.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || e.target.closest('button')) return;
            geminiDragging = true;
            const rect = popup.getBoundingClientRect();
            geminiDragOffsetX = e.clientX - rect.left;
            geminiDragOffsetY = e.clientY - rect.top;
            if (iframe) iframe.style.pointerEvents = 'none';
            e.preventDefault();
        });
    }

    if (resizeHandle) {
        resizeHandle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            geminiResizing = true;
            geminiResizeStartX = e.clientX;
            geminiResizeStartY = e.clientY;
            geminiResizeStartW = popup.offsetWidth;
            geminiResizeStartH = popup.offsetHeight;
            if (iframe) iframe.style.pointerEvents = 'none';
            e.preventDefault();
            e.stopPropagation();
        });
        resizeHandle.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            geminiResizing = true;
            geminiResizeStartX = touch.clientX;
            geminiResizeStartY = touch.clientY;
            geminiResizeStartW = popup.offsetWidth;
            geminiResizeStartH = popup.offsetHeight;
            e.preventDefault();
            e.stopPropagation();
        }, { passive: false });
    }

    _cleanupGeminiDrag();

    _geminiMousemoveHandler = (e) => {
        if (geminiDragging) {
            const pdfHeader = document.querySelector('.pdf-header');
            const minY = pdfHeader ? Math.max(pdfHeader.getBoundingClientRect().bottom + 4, 60) : 165;
            let newX = Math.max(0, Math.min(e.clientX - geminiDragOffsetX, window.innerWidth - 80));
            let newY = Math.max(minY, Math.min(e.clientY - geminiDragOffsetY, window.innerHeight - 40));
            popup.style.left = newX + 'px';
            popup.style.top = newY + 'px';
            popup.style.right = 'auto';
            popup.style.bottom = 'auto';
            geminiPopupX = newX;
            geminiPopupY = newY;
        } else if (geminiResizing) {
            const dx = e.clientX - geminiResizeStartX;
            const dy = e.clientY - geminiResizeStartY;
            const currentTop = parseFloat(popup.style.top) || 0;
            const maxAllowedH = window.innerHeight - currentTop - 10;
            const newW = Math.min(Math.max(280, geminiResizeStartW + dx), Math.floor(window.innerWidth * 0.98));
            const newH = Math.min(Math.max(200, geminiResizeStartH + dy), maxAllowedH);
            popup.style.width = newW + 'px';
            popup.style.height = newH + 'px';
            geminiPopupW = newW;
            geminiPopupH = newH;
        }
    };
    document.addEventListener('mousemove', _geminiMousemoveHandler);

    _geminiMouseupHandler = () => {
        if (geminiDragging || geminiResizing) {
            geminiDragging = false;
            geminiResizing = false;
            if (iframe) iframe.style.pointerEvents = '';
            _saveGeminiState();
        }
    };
    document.addEventListener('mouseup', _geminiMouseupHandler);

    if (header) {
        header.addEventListener('touchstart', (e) => {
            if (e.target.closest('button') || e.target.closest('a')) return;
            const touch = e.touches[0];
            geminiDragging = true;
            const rect = popup.getBoundingClientRect();
            geminiDragOffsetX = touch.clientX - rect.left;
            geminiDragOffsetY = touch.clientY - rect.top;
            e.preventDefault();
        }, { passive: false });
    }

    _geminiTouchmoveHandler = (e) => {
        if (geminiDragging) {
            const touch = e.touches[0];
            const pdfHeader = document.querySelector('.pdf-header');
            const minY = pdfHeader ? Math.max(pdfHeader.getBoundingClientRect().bottom + 4, 60) : 165;
            let newX = Math.max(0, Math.min(touch.clientX - geminiDragOffsetX, window.innerWidth - 80));
            let newY = Math.max(minY, Math.min(touch.clientY - geminiDragOffsetY, window.innerHeight - 40));
            popup.style.left = newX + 'px';
            popup.style.top = newY + 'px';
            popup.style.right = 'auto';
            popup.style.bottom = 'auto';
            geminiPopupX = newX;
            geminiPopupY = newY;
            e.preventDefault();
        } else if (geminiResizing) {
            const touch = e.touches[0];
            const dx = touch.clientX - geminiResizeStartX;
            const dy = touch.clientY - geminiResizeStartY;
            const currentTop = parseFloat(popup.style.top) || 0;
            const maxAllowedH = window.innerHeight - currentTop - 10;
            const newW = Math.min(Math.max(280, geminiResizeStartW + dx), Math.floor(window.innerWidth * 0.98));
            const newH = Math.min(Math.max(200, geminiResizeStartH + dy), maxAllowedH);
            popup.style.width = newW + 'px';
            popup.style.height = newH + 'px';
            geminiPopupW = newW;
            geminiPopupH = newH;
            e.preventDefault();
        }
    };
    document.addEventListener('touchmove', _geminiTouchmoveHandler, { passive: false });

    _geminiTouchendHandler = () => {
        if (geminiDragging || geminiResizing) {
            geminiDragging = false;
            geminiResizing = false;
            _saveGeminiState();
        }
    };
    document.addEventListener('touchend', _geminiTouchendHandler);
    document.addEventListener('touchcancel', _geminiTouchendHandler);
}

// === GEMİNİ NATIVE CHAT ===

function setupGeminiListeners() {
    // Sol bar G butonu (hem header toggle hem de toolbar G butonu aynı işi yapar)
    const geminiToggle = () => {
        if (geminiPopupVisible) {
            closeGeminiPopup();
        } else {
            openGeminiPopup();
        }
    };
    document.getElementById('pdf-gemini-toggle')?.addEventListener('click', geminiToggle);

    // Toolbar G butonu: Gemini popup yerine pano kopyalama (görsel seçim) modunu aç/kapat
    document.getElementById('toolbar-gemini-btn')?.addEventListener('click', () => {
        screenshotMode = screenshotMode === 'gemini' ? null : 'gemini';
        updateToolsUI();
        if (screenshotMode === 'gemini') {
            showToast('Alan seçin — seçilen bölge panoya kopyalanacak');
        } else {
            showToast('Yakalama modu kapatıldı');
        }
    });

    document.getElementById('pdf-gemini-refresh')?.addEventListener('click', () => {
        refreshGeminiPopup();
    });

    document.getElementById('pdf-gemini-header-refresh')?.addEventListener('click', () => {
        refreshGeminiPopup();
    });

    document.getElementById('pdf-gemini-close')?.addEventListener('click', () => {
        closeGeminiPopup();
    });

    document.getElementById('pdf-gemini-capture')?.addEventListener('click', () => {
        screenshotMode = screenshotMode === 'gemini' ? null : 'gemini';
        updateToolsUI();
        if (screenshotMode === 'gemini') {
            showToast('Alan seçin — seçilen bölge panoya kopyalanacak');
        } else {
            showToast('Yakalama modu kapatıldı');
        }
    });

    // Gemini yeni pencere butonları
    const openGeminiWindow = () => {
        const sw = window.screen.width;
        const sh = window.screen.height;
        const w = Math.min(560, sw * 0.4);
        const h = Math.min(860, sh * 0.9);
        const left = Math.max(0, sw - w - 20);
        const top = Math.max(0, (sh - h) / 2);
        window.open('https://gemini.google.com/app', 'gemini_window', `width=${w},height=${h},left=${left},top=${top},noopener`);
    };
    document.getElementById('gemini-open-new-window')?.addEventListener('click', openGeminiWindow);
    document.getElementById('gemini-open-new-window-2')?.addEventListener('click', openGeminiWindow);

    // iframe yüklenip yüklenmediğini kontrol et
    const geminiFrame = document.getElementById('gemini-frame');
    const geminiBlocked = document.getElementById('gemini-iframe-blocked');
    if (geminiFrame && geminiBlocked) {
        geminiFrame.addEventListener('load', () => {
            try {
                // X-Frame-Options engellendiyse içerik boş gelir
                const doc = geminiFrame.contentDocument;
                if (!doc || !doc.body || doc.body.innerHTML === '') {
                    // PWA modunda: otomatik pencere aç, popup kapat
                    geminiFrame.style.display = 'none';
                    geminiBlocked.style.display = 'none';
                    closeGeminiPopup();
                    openGeminiWindow();
                    showToast('Gemini ayrı pencerede açılıyor — Chrome\'da tarayıcı güvenliği iframe\'i engelliyor');
                }
            } catch (e) {
                // cross-origin erişim engeli = iframe çalışmıyor, otomatik aç
                geminiFrame.style.display = 'none';
                geminiBlocked.style.display = 'none';
                closeGeminiPopup();
                openGeminiWindow();
                showToast('Gemini ayrı pencerede açılıyor — Chrome\'da tarayıcı güvenliği iframe\'i engelliyor');
            }
        });
        geminiFrame.addEventListener('error', () => {
            geminiFrame.style.display = 'none';
            geminiBlocked.style.display = 'none';
            closeGeminiPopup();
            openGeminiWindow();
        });
    }
}

// ============================================================
// === SOL BAR (TOOLBAR) SÜRÜKLENEBILIR + ARAÇ TOGGLE ===
// ============================================================

const TOOLBAR_POS_KEY = 'pdfToolbarPosition';
let _toolbarDragging = false;
let _toolbarDragOffsetX = 0;
let _toolbarDragOffsetY = 0;
let _toolbarMoveHandler = null;
let _toolbarUpHandler = null;
let _toolbarTouchMoveHandler = null;
let _toolbarTouchEndHandler = null;

function _loadToolbarPosition() {
    try {
        const saved = localStorage.getItem(TOOLBAR_POS_KEY);
        return saved ? JSON.parse(saved) : null;
    } catch (_) { return null; }
}

function _saveToolbarPosition(x, y) {
    try {
        localStorage.setItem(TOOLBAR_POS_KEY, JSON.stringify({ x, y }));
    } catch (_) {}
}

function _getBodyRect() {
    const body = document.querySelector('.pdf-body');
    return body ? body.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

function _applyToolbarDefaultPosition(toolbar) {
    const saved = _loadToolbarPosition();
    const body = document.querySelector('.pdf-body');
    const bodyH = body ? body.clientHeight : window.innerHeight;
    const bodyW = body ? body.clientWidth : window.innerWidth;
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
        // Ekran sınırları içinde tut
        toolbar.style.left = Math.max(0, Math.min(saved.x, bodyW - toolbar.offsetWidth)) + 'px';
        toolbar.style.top = Math.max(0, Math.min(saved.y, bodyH - toolbar.offsetHeight)) + 'px';
    } else {
        // Varsayılan: sol kenar, dikeyde ortada
        toolbar.style.left = '8px';
        const tbH = toolbar.offsetHeight || 350;
        toolbar.style.top = Math.max(8, Math.round((bodyH - tbH) / 2)) + 'px';
    }
    toolbar.style.right = 'auto';
    toolbar.style.bottom = 'auto';
}

function setupToolbarDrag() {
    const toolbar = document.getElementById('pdf-vertical-toolbar');
    const handle = document.getElementById('toolbar-drag-handle');
    if (!toolbar || !handle) return;

    // Konumu uygula (kısa gecikme - DOM boyutları hesaplanabilsin)
    setTimeout(() => _applyToolbarDefaultPosition(toolbar), 50);

    // Mouse drag
    handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        _toolbarDragging = true;
        const rect = toolbar.getBoundingClientRect();
        _toolbarDragOffsetX = e.clientX - rect.left;
        _toolbarDragOffsetY = e.clientY - rect.top;
        e.preventDefault();
    });

    // Touch drag
    handle.addEventListener('touchstart', (e) => {
        const touch = e.touches[0];
        _toolbarDragging = true;
        const rect = toolbar.getBoundingClientRect();
        _toolbarDragOffsetX = touch.clientX - rect.left;
        _toolbarDragOffsetY = touch.clientY - rect.top;
        e.preventDefault();
    }, { passive: false });

    // Cleanup previous
    if (_toolbarMoveHandler) document.removeEventListener('mousemove', _toolbarMoveHandler);
    if (_toolbarUpHandler) document.removeEventListener('mouseup', _toolbarUpHandler);
    if (_toolbarTouchMoveHandler) document.removeEventListener('touchmove', _toolbarTouchMoveHandler);
    if (_toolbarTouchEndHandler) document.removeEventListener('touchend', _toolbarTouchEndHandler);

    const _moveToolbar = (clientX, clientY) => {
        if (!_toolbarDragging) return;
        const bodyRect = _getBodyRect();
        const tbW = toolbar.offsetWidth;
        const tbH = toolbar.offsetHeight;
        // Viewport koordinatını body-relative koordinata çevir
        let newX = Math.max(0, Math.min(clientX - _toolbarDragOffsetX - bodyRect.left, bodyRect.width - tbW));
        let newY = Math.max(0, Math.min(clientY - _toolbarDragOffsetY - bodyRect.top, bodyRect.height - tbH));
        toolbar.style.left = newX + 'px';
        toolbar.style.top = newY + 'px';
        toolbar.style.right = 'auto';
        toolbar.style.bottom = 'auto';
        _saveToolbarPosition(newX, newY);
    };

    _toolbarMoveHandler = (e) => _moveToolbar(e.clientX, e.clientY);
    document.addEventListener('mousemove', _toolbarMoveHandler);

    _toolbarUpHandler = () => { _toolbarDragging = false; };
    document.addEventListener('mouseup', _toolbarUpHandler);

    _toolbarTouchMoveHandler = (e) => {
        if (!_toolbarDragging) return;
        const touch = e.touches[0];
        _moveToolbar(touch.clientX, touch.clientY);
        e.preventDefault();
    };
    document.addEventListener('touchmove', _toolbarTouchMoveHandler, { passive: false });

    _toolbarTouchEndHandler = () => { _toolbarDragging = false; };
    document.addEventListener('touchend', _toolbarTouchEndHandler);
    document.addEventListener('touchcancel', _toolbarTouchEndHandler);
}

function setupToolbarToolsToggle() {
    const toggleBtn = document.getElementById('toolbar-tools-toggle');
    const collapsible = document.getElementById('toolbar-collapsible');
    if (!toggleBtn || !collapsible) return;

    let isOpen = false;
    toggleBtn.addEventListener('click', () => {
        isOpen = !isOpen;
        collapsible.classList.toggle('open', isOpen);
        toggleBtn.classList.toggle('open', isOpen);
        // Konum yeniden hesapla (toolbar yüksekliği değişti)
        const toolbar = document.getElementById('pdf-vertical-toolbar');
        if (toolbar) {
            const rect = toolbar.getBoundingClientRect();
            if (rect.bottom > window.innerHeight) {
                const newY = Math.max(0, window.innerHeight - toolbar.offsetHeight - 8);
                toolbar.style.top = newY + 'px';
                _saveToolbarPosition(rect.left, newY);
            }
        }
    });
}

// ============================================================
// === KRONOMETRE ===
// ============================================================

function _kronoFormatTime(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function _kronoUpdateDisplay() {
    const display = document.getElementById('kronometer-display');
    if (display) display.textContent = _kronoFormatTime(_kronoSeconds);
}

function _kronoStart() {
    if (_kronoRunning) return;
    _kronoRunning = true;
    _kronoInterval = setInterval(() => {
        _kronoSeconds++;
        _kronoUpdateDisplay();
    }, 1000);
    const playBtn = document.getElementById('kronometer-play-btn');
    if (playBtn) { playBtn.textContent = '⏸'; playBtn.classList.add('running'); }
}

function _kronoPause() {
    if (!_kronoRunning) return;
    _kronoRunning = false;
    clearInterval(_kronoInterval);
    _kronoInterval = null;
    const playBtn = document.getElementById('kronometer-play-btn');
    if (playBtn) { playBtn.textContent = '▶'; playBtn.classList.remove('running'); }
}

function _kronoReset() {
    _kronoPause();
    _kronoSeconds = 0;
    _kronoUpdateDisplay();
}

function _kronoHide() {
    _kronoReset();
    _kronoVisible = false;
    const widget = document.getElementById('pdf-kronometer-widget');
    if (widget) widget.classList.add('hidden');
    const kBtn = document.getElementById('toolbar-kronometer-btn');
    if (kBtn) kBtn.classList.remove('active');
}

function _kronoShow() {
    _kronoVisible = true;
    const widget = document.getElementById('pdf-kronometer-widget');
    if (!widget) return;
    widget.classList.remove('hidden');

    // Varsayılan konum: pdf-body'nin ortası
    const body = document.querySelector('.pdf-body');
    const bW = body ? body.clientWidth : window.innerWidth;
    const bH = body ? body.clientHeight : window.innerHeight;
    const wW = widget.offsetWidth || 260;
    const wH = widget.offsetHeight || 56;
    widget.style.left = Math.round((bW - wW) / 2) + 'px';
    widget.style.top = Math.round((bH - wH) / 2) + 'px';
    widget.style.right = 'auto';
    widget.style.bottom = 'auto';

    const kBtn = document.getElementById('toolbar-kronometer-btn');
    if (kBtn) kBtn.classList.add('active');
}

function setupKronometer() {
    const kBtn = document.getElementById('toolbar-kronometer-btn');
    const widget = document.getElementById('pdf-kronometer-widget');
    const playBtn = document.getElementById('kronometer-play-btn');
    const resetBtn = document.getElementById('kronometer-reset-btn');
    const dragHandle = document.getElementById('kronometer-drag-handle');
    if (!kBtn || !widget) return;

    // K butonu: göster / gizle+sıfırla
    kBtn.addEventListener('click', () => {
        if (_kronoVisible) {
            _kronoHide();
        } else {
            _kronoShow();
        }
    });

    // Play/Pause
    if (playBtn) {
        playBtn.addEventListener('click', () => {
            if (_kronoRunning) _kronoPause(); else _kronoStart();
        });
    }

    // Sıfırla
    if (resetBtn) {
        resetBtn.addEventListener('click', () => _kronoReset());
    }

    // Sürükleme
    if (dragHandle) {
        if (_kronoMoveHandler) document.removeEventListener('mousemove', _kronoMoveHandler);
        if (_kronoUpHandler) document.removeEventListener('mouseup', _kronoUpHandler);
        if (_kronoTouchMoveHandler) document.removeEventListener('touchmove', _kronoTouchMoveHandler);
        if (_kronoTouchEndHandler) document.removeEventListener('touchend', _kronoTouchEndHandler);

        dragHandle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            _kronoDragging = true;
            const rect = widget.getBoundingClientRect();
            _kronoDragOffsetX = e.clientX - rect.left;
            _kronoDragOffsetY = e.clientY - rect.top;
            e.preventDefault();
        });

        dragHandle.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            _kronoDragging = true;
            const rect = widget.getBoundingClientRect();
            _kronoDragOffsetX = touch.clientX - rect.left;
            _kronoDragOffsetY = touch.clientY - rect.top;
            e.preventDefault();
        }, { passive: false });

        const _moveKrono = (clientX, clientY) => {
            if (!_kronoDragging) return;
            const body = document.querySelector('.pdf-body');
            const bodyRect = body ? body.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
            const wW = widget.offsetWidth;
            const wH = widget.offsetHeight;
            let newX = Math.max(0, Math.min(clientX - _kronoDragOffsetX - bodyRect.left, bodyRect.width - wW));
            let newY = Math.max(0, Math.min(clientY - _kronoDragOffsetY - bodyRect.top, bodyRect.height - wH));
            widget.style.left = newX + 'px';
            widget.style.top = newY + 'px';
            widget.style.right = 'auto';
            widget.style.bottom = 'auto';
        };

        _kronoMoveHandler = (e) => _moveKrono(e.clientX, e.clientY);
        document.addEventListener('mousemove', _kronoMoveHandler);

        _kronoUpHandler = () => { _kronoDragging = false; };
        document.addEventListener('mouseup', _kronoUpHandler);

        _kronoTouchMoveHandler = (e) => {
            if (!_kronoDragging) return;
            const touch = e.touches[0];
            _moveKrono(touch.clientX, touch.clientY);
            e.preventDefault();
        };
        document.addEventListener('touchmove', _kronoTouchMoveHandler, { passive: false });

        _kronoTouchEndHandler = () => { _kronoDragging = false; };
        document.addEventListener('touchend', _kronoTouchEndHandler);
        document.addEventListener('touchcancel', _kronoTouchEndHandler);
    }
}

// ============================================================
// === NOT PANELİ (DRAGGABLE/RESIZABLE NOTES POPUP) ===
// ============================================================

const NOTES_STATE_KEY = 'pdfNotesState';
let notesPopupVisible = false;
let notesPopupX = null;
let notesPopupY = null;
let notesPopupW = 340;
let notesPopupH = 480;
let notesDragging = false;
let notesResizing = false;
let notesDragOffsetX = 0;
let notesDragOffsetY = 0;
let notesResizeStartX = 0;
let notesResizeStartY = 0;
let notesResizeStartW = 0;
let notesResizeStartH = 0;
let notesTextColor = '#1a1a2e';
let notesBgColor = '#fffde7';
let _notesMousemoveHandler = null;
let _notesMouseupHandler = null;
let _notesMousedownHandler = null;
let _notesResizeHandler = null;
let _notesTouchstartHandler = null;
let _notesTouchmoveHandler = null;
let _notesTouchendHandler = null;
let _notesSaveTimer = null;

async function _loadNotesState() {
    try {
        const stored = await chrome.storage.local.get(NOTES_STATE_KEY);
        const s = stored[NOTES_STATE_KEY] || {};
        if (typeof s.x === 'number') notesPopupX = s.x;
        if (typeof s.y === 'number') notesPopupY = s.y;
        if (typeof s.w === 'number' && s.w >= 200) notesPopupW = s.w;
        if (typeof s.h === 'number' && s.h >= 120) notesPopupH = s.h;
        if (typeof s.textColor === 'string') notesTextColor = s.textColor;
        if (typeof s.bgColor === 'string') notesBgColor = s.bgColor;
    } catch (_) {}
}

function _saveNotesState() {
    try {
        chrome.storage.local.set({
            [NOTES_STATE_KEY]: {
                x: notesPopupX, y: notesPopupY,
                w: notesPopupW, h: notesPopupH,
                textColor: notesTextColor, bgColor: notesBgColor
            }
        });
    } catch (_) {}
}

function _applyNotesGeometry() {
    const popup = document.getElementById('pdf-notes-popup');
    if (!popup) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pdfHeader = document.querySelector('.pdf-header');
    const safeMinY = pdfHeader
        ? Math.max(pdfHeader.getBoundingClientRect().bottom + 4, 60)
        : 165;
    const maxW = Math.floor(vw * 0.95);
    const maxH = vh - safeMinY - 10;
    const finalW = Math.min(Math.max(notesPopupW, 200), maxW);
    const finalH = Math.min(Math.max(notesPopupH, 120), maxH);
    popup.style.width = finalW + 'px';
    popup.style.height = finalH + 'px';
    if (notesPopupX !== null && notesPopupY !== null) {
        popup.style.left = Math.max(0, Math.min(notesPopupX, vw - 80)) + 'px';
        popup.style.top = Math.max(safeMinY, Math.min(notesPopupY, vh - 40)) + 'px';
    } else {
        const defaultX = 20;
        const defaultY = safeMinY + 5;
        popup.style.left = defaultX + 'px';
        popup.style.top = defaultY + 'px';
        notesPopupX = defaultX;
        notesPopupY = defaultY;
    }
    popup.style.right = 'auto';
    popup.style.bottom = 'auto';
}

function _applyNotesColors() {
    const textarea = document.getElementById('pdf-notes-textarea');
    const popup = document.getElementById('pdf-notes-popup');
    const textInput = document.getElementById('pdf-notes-text-color');
    const bgInput = document.getElementById('pdf-notes-bg-color');
    if (textarea) {
        textarea.style.color = notesTextColor;
        textarea.style.background = notesBgColor;
    }
    if (popup) popup.style.background = notesBgColor;
    if (textInput) textInput.value = notesTextColor;
    if (bgInput) bgInput.value = notesBgColor;
}

async function _loadNotesContent(resourceId) {
    const textarea = document.getElementById('pdf-notes-textarea');
    if (!textarea || !resourceId) return;
    try {
        const key = `pdfNotes_${resourceId}`;
        const stored = await chrome.storage.local.get(key);
        textarea.value = stored[key] || '';
    } catch (_) {
        if (textarea) textarea.value = '';
    }
}

function _saveNotesContent(resourceId) {
    const textarea = document.getElementById('pdf-notes-textarea');
    if (!textarea || !resourceId) return;
    try {
        chrome.storage.local.set({ [`pdfNotes_${resourceId}`]: textarea.value });
    } catch (_) {}
}

async function openNotesPopup() {
    if (notesPopupVisible) return;
    await _loadNotesState();
    const popup = document.getElementById('pdf-notes-popup');
    if (!popup) return;
    _applyNotesGeometry();
    _applyNotesColors();
    await _loadNotesContent(currentResourceId);
    popup.classList.remove('hidden');
    notesPopupVisible = true;
    const btn = document.getElementById('pdf-notes-toggle');
    if (btn) btn.classList.add('active');
    _setupNotesDrag();
}

function closeNotesPopup() {
    _saveNotesContent(currentResourceId);
    const popup = document.getElementById('pdf-notes-popup');
    if (popup) popup.classList.add('hidden');
    notesPopupVisible = false;
    const btn = document.getElementById('pdf-notes-toggle');
    if (btn) btn.classList.remove('active');
    _cleanupNotesDrag();
}

function _cleanupNotesDrag() {
    if (_notesMousemoveHandler) {
        document.removeEventListener('mousemove', _notesMousemoveHandler);
        _notesMousemoveHandler = null;
    }
    if (_notesMouseupHandler) {
        document.removeEventListener('mouseup', _notesMouseupHandler);
        _notesMouseupHandler = null;
    }
    if (_notesMousedownHandler) {
        const header = document.getElementById('pdf-notes-drag-handle');
        if (header) header.removeEventListener('mousedown', _notesMousedownHandler);
        _notesMousedownHandler = null;
    }
    if (_notesResizeHandler) {
        const rh = document.getElementById('pdf-notes-resize-handle');
        if (rh) rh.removeEventListener('mousedown', _notesResizeHandler);
        _notesResizeHandler = null;
    }
    if (_notesTouchmoveHandler) {
        document.removeEventListener('touchmove', _notesTouchmoveHandler);
        _notesTouchmoveHandler = null;
    }
    if (_notesTouchendHandler) {
        document.removeEventListener('touchend', _notesTouchendHandler);
        document.removeEventListener('touchcancel', _notesTouchendHandler);
        _notesTouchendHandler = null;
    }
}

function _setupNotesDrag() {
    const popup = document.getElementById('pdf-notes-popup');
    const header = document.getElementById('pdf-notes-drag-handle');
    const resizeHandle = document.getElementById('pdf-notes-resize-handle');
    if (!popup) return;

    // Temizle
    _cleanupNotesDrag();

    if (header) {
        _notesMousedownHandler = (e) => {
            if (e.button !== 0 || e.target.closest('button') || e.target.closest('input') || e.target.closest('label')) return;
            notesDragging = true;
            const rect = popup.getBoundingClientRect();
            notesDragOffsetX = e.clientX - rect.left;
            notesDragOffsetY = e.clientY - rect.top;
            e.preventDefault();
        };
        header.addEventListener('mousedown', _notesMousedownHandler);
    }

    if (resizeHandle) {
        _notesResizeHandler = (e) => {
            if (e.button !== 0) return;
            notesResizing = true;
            notesResizeStartX = e.clientX;
            notesResizeStartY = e.clientY;
            notesResizeStartW = popup.offsetWidth;
            notesResizeStartH = popup.offsetHeight;
            e.preventDefault();
            e.stopPropagation();
        };
        resizeHandle.addEventListener('mousedown', _notesResizeHandler);
        resizeHandle.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            notesResizing = true;
            notesResizeStartX = touch.clientX;
            notesResizeStartY = touch.clientY;
            notesResizeStartW = popup.offsetWidth;
            notesResizeStartH = popup.offsetHeight;
            e.preventDefault();
            e.stopPropagation();
        }, { passive: false });
    }

    _notesMousemoveHandler = (e) => {
        if (notesDragging) {
            const pdfHeader = document.querySelector('.pdf-header');
            const minY = pdfHeader ? Math.max(pdfHeader.getBoundingClientRect().bottom + 4, 60) : 165;
            let newX = Math.max(0, Math.min(e.clientX - notesDragOffsetX, window.innerWidth - 80));
            let newY = Math.max(minY, Math.min(e.clientY - notesDragOffsetY, window.innerHeight - 40));
            popup.style.left = newX + 'px';
            popup.style.top = newY + 'px';
            popup.style.right = 'auto';
            popup.style.bottom = 'auto';
            notesPopupX = newX;
            notesPopupY = newY;
        } else if (notesResizing) {
            const dx = e.clientX - notesResizeStartX;
            const dy = e.clientY - notesResizeStartY;
            const currentTop = parseFloat(popup.style.top) || 0;
            const maxAllowedH = window.innerHeight - currentTop - 10;
            const newW = Math.min(Math.max(200, notesResizeStartW + dx), Math.floor(window.innerWidth * 0.95));
            const newH = Math.min(Math.max(120, notesResizeStartH + dy), maxAllowedH);
            popup.style.width = newW + 'px';
            popup.style.height = newH + 'px';
            notesPopupW = newW;
            notesPopupH = newH;
        }
    };
    document.addEventListener('mousemove', _notesMousemoveHandler);

    _notesMouseupHandler = () => {
        if (notesDragging || notesResizing) {
            notesDragging = false;
            notesResizing = false;
            _saveNotesState();
        }
    };
    document.addEventListener('mouseup', _notesMouseupHandler);

    if (header) {
        header.addEventListener('touchstart', (e) => {
            if (e.target.closest('button') || e.target.closest('input') || e.target.closest('label') || e.target.closest('a')) return;
            const touch = e.touches[0];
            notesDragging = true;
            const rect = popup.getBoundingClientRect();
            notesDragOffsetX = touch.clientX - rect.left;
            notesDragOffsetY = touch.clientY - rect.top;
            e.preventDefault();
        }, { passive: false });
    }

    _notesTouchmoveHandler = (e) => {
        if (notesDragging) {
            const touch = e.touches[0];
            const pdfHeader = document.querySelector('.pdf-header');
            const minY = pdfHeader ? Math.max(pdfHeader.getBoundingClientRect().bottom + 4, 60) : 165;
            let newX = Math.max(0, Math.min(touch.clientX - notesDragOffsetX, window.innerWidth - 80));
            let newY = Math.max(minY, Math.min(touch.clientY - notesDragOffsetY, window.innerHeight - 40));
            popup.style.left = newX + 'px';
            popup.style.top = newY + 'px';
            popup.style.right = 'auto';
            popup.style.bottom = 'auto';
            notesPopupX = newX;
            notesPopupY = newY;
            e.preventDefault();
        } else if (notesResizing) {
            const touch = e.touches[0];
            const dx = touch.clientX - notesResizeStartX;
            const dy = touch.clientY - notesResizeStartY;
            const currentTop = parseFloat(popup.style.top) || 0;
            const maxAllowedH = window.innerHeight - currentTop - 10;
            const newW = Math.min(Math.max(200, notesResizeStartW + dx), Math.floor(window.innerWidth * 0.95));
            const newH = Math.min(Math.max(120, notesResizeStartH + dy), maxAllowedH);
            popup.style.width = newW + 'px';
            popup.style.height = newH + 'px';
            notesPopupW = newW;
            notesPopupH = newH;
            e.preventDefault();
        }
    };
    document.addEventListener('touchmove', _notesTouchmoveHandler, { passive: false });

    _notesTouchendHandler = () => {
        if (notesDragging || notesResizing) {
            notesDragging = false;
            notesResizing = false;
            _saveNotesState();
        }
    };
    document.addEventListener('touchend', _notesTouchendHandler);
    document.addEventListener('touchcancel', _notesTouchendHandler);
}

function setupNotesListeners() {
    document.getElementById('pdf-notes-toggle')?.addEventListener('click', () => {
        if (notesPopupVisible) {
            closeNotesPopup();
        } else {
            openNotesPopup();
        }
    });

    document.getElementById('pdf-notes-close')?.addEventListener('click', () => {
        closeNotesPopup();
    });

    document.getElementById('pdf-notes-text-color')?.addEventListener('input', (e) => {
        notesTextColor = e.target.value;
        const textarea = document.getElementById('pdf-notes-textarea');
        if (textarea) textarea.style.color = notesTextColor;
        _saveNotesState();
    });

    document.getElementById('pdf-notes-bg-color')?.addEventListener('input', (e) => {
        notesBgColor = e.target.value;
        const textarea = document.getElementById('pdf-notes-textarea');
        const popup = document.getElementById('pdf-notes-popup');
        if (textarea) textarea.style.background = notesBgColor;
        if (popup) popup.style.background = notesBgColor;
        _saveNotesState();
    });

    document.getElementById('pdf-notes-textarea')?.addEventListener('input', () => {
        if (_notesSaveTimer) clearTimeout(_notesSaveTimer);
        _notesSaveTimer = setTimeout(() => {
            _saveNotesContent(currentResourceId);
            _notesSaveTimer = null;
        }, 800);
    });
}

// ============================================================

function setupSecondaryPopupDrag() {
    const popup = document.getElementById('pdf-secondary-popup');
    const header = document.getElementById('pdf-secondary-drag-handle');
    const resizeHandle = document.getElementById('pdf-secondary-resize-handle');
    if (!popup) return;

    // Sürükleme: tüm başlık çubuğundan (butonlar hariç)
    if (header) {
        // Önceki mousedown handler varsa temizle (çift kayıt önle)
        if (_secMousedownHandler) {
            header.removeEventListener('mousedown', _secMousedownHandler);
            _secMousedownHandler = null;
        }
        _secMousedownHandler = (e) => {
            if (e.button !== 0) return;
            // Buton tıklamalarını yoksay
            if (e.target.closest('button')) return;
            secondaryDragging = true;
            const rect = popup.getBoundingClientRect();
            secondaryDragOffsetX = e.clientX - rect.left;
            secondaryDragOffsetY = e.clientY - rect.top;
            e.preventDefault();
        };
        header.addEventListener('mousedown', _secMousedownHandler);
    }

    // Yeniden boyutlandırma: sağ alt köşe
    if (resizeHandle) {
        // Önceki resize handler varsa temizle
        if (_secResizeHandler) {
            resizeHandle.removeEventListener('mousedown', _secResizeHandler);
            _secResizeHandler = null;
        }
        _secResizeHandler = (e) => {
            if (e.button !== 0) return;
            secondaryResizing = true;
            secondaryResizeStartX = e.clientX;
            secondaryResizeStartY = e.clientY;
            secondaryResizeStartW = popup.offsetWidth;
            secondaryResizeStartH = popup.offsetHeight;
            e.preventDefault();
            e.stopPropagation();
        };
        resizeHandle.addEventListener('mousedown', _secResizeHandler);
    }

    // İkinci PDF zoom input + butonlar (her seferinde yeniden bağla — öncekini temizle)
    const zoomInput = document.getElementById('pdf-secondary-zoom-input');
    const zoomInBtn = document.getElementById('pdf-secondary-zoom-in');
    const zoomOutBtn = document.getElementById('pdf-secondary-zoom-out');

    const applySecondaryZoom = async (newVal) => {
        let val;
        if (newVal !== undefined) {
            val = newVal;
        } else {
            const raw = zoomInput ? zoomInput.value.replace(/[^0-9]/g, '') : '';
            val = parseInt(raw, 10);
        }
        if (isNaN(val) || val <= 0) return;
        val = Math.max(30, Math.min(400, val));
        if (zoomInput) zoomInput.value = val;
        secondaryScale = parseFloat((val / 100).toFixed(2));
        if (secondaryPopupVisible && pdfDoc) await renderSecondaryAllPages(secondaryCurrentPage);
        saveSecondaryState(currentResourceId);
    };

    if (zoomInput) {
        // Önceki listener referanslarını temizle
        if (zoomInput._blurHandler) zoomInput.removeEventListener('blur', zoomInput._blurHandler);
        if (zoomInput._keydownHandler) zoomInput.removeEventListener('keydown', zoomInput._keydownHandler);

        zoomInput.value = Math.round(secondaryScale * 100);

        zoomInput._blurHandler = () => applySecondaryZoom();
        zoomInput._keydownHandler = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); zoomInput.blur(); }
        };

        zoomInput.addEventListener('blur', zoomInput._blurHandler);
        zoomInput.addEventListener('keydown', zoomInput._keydownHandler);
    }

    if (zoomInBtn) {
        zoomInBtn.onclick = () => {
            const cur = Math.round(secondaryScale * 100);
            applySecondaryZoom(Math.min(400, cur + 10));
        };
    }
    if (zoomOutBtn) {
        zoomOutBtn.onclick = () => {
            const cur = Math.round(secondaryScale * 100);
            applySecondaryZoom(Math.max(30, cur - 10));
        };
    }

    // Scroll takibi: secondary body scroll olduğunda mevcut sayfayı güncelle (bir kere ekle)
    const secBody = document.getElementById('pdf-secondary-body');
    if (secBody) {
        secBody.addEventListener('scroll', () => {
            updateSecondaryCurrentPageFromScroll();
        }, { passive: true });
    }

    // Önceki listener varsa temizle (tekrar kurulumu önle)
    if (_secMousemoveHandler) {
        document.removeEventListener('mousemove', _secMousemoveHandler);
        _secMousemoveHandler = null;
    }
    if (_secMouseupHandler) {
        document.removeEventListener('mouseup', _secMouseupHandler);
        _secMouseupHandler = null;
    }

    // Ortak mousemove: sürükleme veya boyutlandırma (isimli referans — temizlenebilir)
    _secMousemoveHandler = (e) => {
        if (secondaryDragging) {
            let newX = e.clientX - secondaryDragOffsetX;
            let newY = e.clientY - secondaryDragOffsetY;
            const overlayEl = document.getElementById('pdf-viewer-overlay');
            const minY = overlayEl ? Math.max(overlayEl.getBoundingClientRect().top, 0) : 0;
            newX = Math.max(0, Math.min(newX, window.innerWidth - 80));
            newY = Math.max(minY, Math.min(newY, window.innerHeight - 40));
            popup.style.left = newX + 'px';
            popup.style.top = newY + 'px';
            popup.style.right = 'auto';
            popup.style.bottom = 'auto';
            secondaryPopupX = newX;
            secondaryPopupY = newY;
        } else if (secondaryResizing) {
            const dx = e.clientX - secondaryResizeStartX;
            const dy = e.clientY - secondaryResizeStartY;
            const currentTop = parseFloat(popup.style.top) || 0;
            const maxAllowedH = window.innerHeight - currentTop - 10;
            const newW = Math.min(Math.max(320, secondaryResizeStartW + dx), Math.floor(window.innerWidth * 0.98));
            const newH = Math.min(Math.max(200, secondaryResizeStartH + dy), maxAllowedH);
            popup.style.width = newW + 'px';
            popup.style.height = newH + 'px';
            secondaryPopupW = newW;
            secondaryPopupH = newH;
        }
    };
    document.addEventListener('mousemove', _secMousemoveHandler);

    // Ortak mouseup: kaydet (isimli referans — temizlenebilir)
    _secMouseupHandler = () => {
        if (secondaryDragging) {
            secondaryDragging = false;
            saveSecondaryState(currentResourceId);
        }
        if (secondaryResizing) {
            secondaryResizing = false;
            saveSecondaryState(currentResourceId);
        }
    };
    document.addEventListener('mouseup', _secMouseupHandler);

    if (header) {
        header.addEventListener('touchstart', (e) => {
            if (e.target.closest('button') || e.target.closest('a') || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
            const touch = e.touches[0];
            secondaryDragging = true;
            const rect = popup.getBoundingClientRect();
            secondaryDragOffsetX = touch.clientX - rect.left;
            secondaryDragOffsetY = touch.clientY - rect.top;
            e.preventDefault();
        }, { passive: false });
    }

    if (resizeHandle) {
        resizeHandle.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            secondaryResizing = true;
            secondaryResizeStartX = touch.clientX;
            secondaryResizeStartY = touch.clientY;
            secondaryResizeStartW = popup.offsetWidth;
            secondaryResizeStartH = popup.offsetHeight;
            e.preventDefault();
            e.stopPropagation();
        }, { passive: false });
    }

    _secTouchmoveHandler = (e) => {
        if (secondaryDragging) {
            const touch = e.touches[0];
            const overlayEl = document.getElementById('pdf-viewer-overlay');
            const minY = overlayEl ? Math.max(overlayEl.getBoundingClientRect().top, 0) : 0;
            let newX = Math.max(0, Math.min(touch.clientX - secondaryDragOffsetX, window.innerWidth - 80));
            let newY = Math.max(minY, Math.min(touch.clientY - secondaryDragOffsetY, window.innerHeight - 40));
            popup.style.left = newX + 'px';
            popup.style.top = newY + 'px';
            popup.style.right = 'auto';
            popup.style.bottom = 'auto';
            secondaryPopupX = newX;
            secondaryPopupY = newY;
            e.preventDefault();
        } else if (secondaryResizing) {
            const touch = e.touches[0];
            const dx = touch.clientX - secondaryResizeStartX;
            const dy = touch.clientY - secondaryResizeStartY;
            const currentTop = parseFloat(popup.style.top) || 0;
            const maxAllowedH = window.innerHeight - currentTop - 10;
            const newW = Math.min(Math.max(320, secondaryResizeStartW + dx), Math.floor(window.innerWidth * 0.98));
            const newH = Math.min(Math.max(200, secondaryResizeStartH + dy), maxAllowedH);
            popup.style.width = newW + 'px';
            popup.style.height = newH + 'px';
            secondaryPopupW = newW;
            secondaryPopupH = newH;
            e.preventDefault();
        }
    };
    document.addEventListener('touchmove', _secTouchmoveHandler, { passive: false });

    _secTouchendHandler = () => {
        if (secondaryDragging) {
            secondaryDragging = false;
            saveSecondaryState(currentResourceId);
        }
        if (secondaryResizing) {
            secondaryResizing = false;
            saveSecondaryState(currentResourceId);
        }
    };
    document.addEventListener('touchend', _secTouchendHandler);
    document.addEventListener('touchcancel', _secTouchendHandler);
}

export async function openPDFViewer(resourceId, resourceName, initialPage = 1) {
    if (!window.pdfjsLib) {
        logger.error("PDF.js library not loaded!");
        alert("PDF görüntüleyici kütüphanesi yüklenemedi.");
        return;
    }

    const pdfData = await getResourcePDF(resourceId);
    if (!pdfData) {
        alert("PDF dosyası bulunamadı.");
        return;
    }

    currentResourceId = resourceId;

    // Get resource details for subject (independent from current subject chip)
    const resource = getResourceById(resourceId);
    currentResourceSubject = resource ? resource.subject : appState.currentSubject;
    
    // DB'den gelen last_page, cache'den gelen ve initialPage'i kontrol et
    // En güncel sayfa bilgisini al (DB > Cache > InitialPage)
    const dbLastPage = resource ? (resource.last_page || null) : null;
    const cachedLast = await getLastPageFromCache(resourceId);
    const parsedInitial = parseInt(initialPage) || 1;
    
    // En güncel sayfayı seç: DB varsa onu, yoksa cache'i, yoksa initialPage'i kullan
    const finalPage = dbLastPage || cachedLast || parsedInitial || 1;
    currentPageNum = finalPage;
    
    logger.log('[PDF] Opening with page:', finalPage, '(DB:', dbLastPage, 'Cache:', cachedLast, 'Initial:', parsedInitial, ')');

    // Load persistent drawing settings
    await loadDrawingSettings();

    // Get uncommitted time if any
    sessionSeconds = appState.uncommitedTimes[`res_${resourceId}`] || 0;
    sessionQCount = 0;
    updateTimerDisplay();
    // Update question total display after a short delay to ensure DB is ready
    setTimeout(() => updateQuestionTotalDisplay(), 100);

    // Update start button text based on timer state
    const startBtn = document.getElementById('pdf-timer-start');
    if (startBtn) {
        startBtn.textContent = studyTimerInterval ? 'Duraklat' : 'Başlat';
    }

    // Hide global drawing palette
    const globalHeader = document.querySelector('.global-header');
    if (globalHeader) {
        globalHeader.style.visibility = 'hidden';
        globalHeader.style.pointerEvents = 'none';
    }

    document.getElementById('pdf-title-text').textContent = resourceName;
    document.getElementById('pdf-viewer-overlay').classList.remove('hidden');

    // PDF açılışında üst alanı otomatik gizle (tam ekran okuma deneyimi)
    const focusPanelAuto = document.getElementById('daily-focus-panel');
    const pdfOverlayAuto = document.getElementById('pdf-viewer-overlay');
    const headerToggleBtnAuto = document.getElementById('pdf-header-toggle-btn');
    if (focusPanelAuto) focusPanelAuto.style.display = 'none';
    if (pdfOverlayAuto) { pdfOverlayAuto.style.top = '0'; pdfOverlayAuto.style.height = '100%'; }
    if (headerToggleBtnAuto) {
        headerToggleBtnAuto.title = 'Üst Menüyü Göster';
        headerToggleBtnAuto.classList.add('active');
    }

    // Optik paneli bu PDF için hazırlayın
    initializeOpticPanel();

    // Her PDF için ayrı zoom seviyesini yükle
    await loadZoomSetting(resourceId);
    updateZoomDisplay();

    // PDF hizalama ayarını yükle ve uygula
    await loadAlignSetting(resourceId);
    applyAlignMode(pdfAlignMode);
    await loadPaperModeSetting();
    applyPaperMode(paperModeEnabled);

    // Decode PDF Data (Handle string Base64 or Blob/Buffer)
    let buffer;
    try {
        if (typeof pdfData === 'string') {
            // pdfData bir dataURL veya ham base64 ise
            const base64Content = pdfData.includes(',') ? pdfData.split(',')[1] : pdfData;
            const binary = atob(base64Content);
            const len = binary.length;
            buffer = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                buffer[i] = binary.charCodeAt(i);
            }
        } else if (pdfData instanceof Blob) {
            logger.log('[PDF] Processing Blob, size:', pdfData.size);
            buffer = await pdfData.arrayBuffer();
            buffer = new Uint8Array(buffer);
        } else if (pdfData instanceof ArrayBuffer) {
            logger.log('[PDF] Processing ArrayBuffer, length:', pdfData.byteLength);
            buffer = new Uint8Array(pdfData);
        } else if (pdfData && pdfData.buffer instanceof ArrayBuffer) {
            logger.log('[PDF] Processing TypedArray');
            // If it's already a Uint8Array, just use it, or clone it to be safe.
            // Using .buffer might be unsafe if there's an offset.
            // .slice() creates a copy.
            if (pdfData instanceof Uint8Array) {
                buffer = new Uint8Array(pdfData);
            } else {
                buffer = new Uint8Array(pdfData.buffer, pdfData.byteOffset, pdfData.byteLength);
            }
        } else if (pdfData && typeof pdfData === 'object') {
            // TypedArray gibi nesneler (örn. backup/restore sonrası Uint8Array)
            if (pdfData instanceof Uint8Array) {
                buffer = new Uint8Array(pdfData);
            } else if (pdfData.buffer instanceof ArrayBuffer) {
                buffer = new Uint8Array(pdfData.buffer, pdfData.byteOffset || 0, pdfData.byteLength || pdfData.length);
            } else {
                alert("PDF verisi formatı tanımsız. Tip: " + pdfData.constructor?.name);
                return;
            }
        } else {
            alert("PDF verisi okunamadı. Veri bozuk olabilir.");
            return;
        }

        // Header kontrolü – önce doğrudan PDF beklenir
        let headerBytes = buffer.subarray(0, 20);
        let headerStr = Array.from(headerBytes).map(b => String.fromCharCode(b)).join('');

        if (!headerStr.startsWith('%PDF-')) {
            // Eski/bozuk yedeklerden gelen base64-byte dizilerini kurtarmaya çalış
            const asciiSample = headerStr.trim();
            const asciiLooksLikeBase64 = /^[A-Za-z0-9+/=]+$/.test(asciiSample);
            if (asciiLooksLikeBase64) {
                // Tüm buffer'ı stringe çevir ve base64 olarak decode et
                const base64Text = Array.from(buffer).map(b => String.fromCharCode(b)).join('');
                const binary = atob(base64Text);
                const len = binary.length;
                const fixed = new Uint8Array(len);
                for (let i = 0; i < len; i++) fixed[i] = binary.charCodeAt(i);
                buffer = fixed;

                headerBytes = buffer.subarray(0, 20);
                headerStr = Array.from(headerBytes).map(b => String.fromCharCode(b)).join('');
            }

            // Hâlâ %PDF- ile başlamıyorsa kullanıcıya uyarı ver
            if (!headerStr.startsWith('%PDF-')) {
                logger.error('[PDF] Invalid Header! Expected %PDF-');
                alert("PDF dosyası bozuk görünüyor veya yedekten hatalı yüklenmiş. Kaynağı yeniden ekleyin.");
                return;
            }
        }

    } catch (conversionError) {
        logger.error('[PDF] Data conversion failed:', conversionError);
        alert('PDF dönüştürme hatası: ' + conversionError.message);
        return;
    }

    // Init PDF
    try {
        pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;

        // initialPage değerini gerçek sayfa sayısına göre clamp et
        const safeInitialPage = Math.min(Math.max(currentPageNum, 1), pdfDoc.numPages);
        currentPageNum = safeInitialPage;

        document.getElementById('page-count').textContent = pdfDoc.numPages;
        // Set initial page indicator - don't let scroll listener override it immediately
        const indicator = document.getElementById('current-page-indicator');
        if (indicator) {
            indicator.textContent = safeInitialPage;
            indicator.dataset.initialPage = safeInitialPage;
        }

        // Render all pages
        await renderAllPages();

        // İlk açılışta son kalınan sayfaya güvenli kaydırma
        logger.log(`[PDF] Scrolling to page ${safeInitialPage} (type: ${typeof safeInitialPage})`);
        
        // Önce sayfaların render edilmesini bekle, sonra scroll yap
        // İlk sayfayı hemen render et (görünür olması için)
        await renderPage(1);
        
        // Sonra hedef sayfayı render et
        if (safeInitialPage > 1) {
            await renderPage(safeInitialPage);
            // Önceki ve sonraki sayfaları da render et (smooth scroll için)
            if (safeInitialPage > 2) await renderPage(safeInitialPage - 1);
            if (safeInitialPage < pdfDoc.numPages) await renderPage(safeInitialPage + 1);
        }
        
        // Scroll yap (sayfalar render edildikten sonra)
            setTimeout(() => {
            logger.log(`[PDF] Executing scrollToPage for page ${safeInitialPage}`);
            scrollToPage(safeInitialPage);
            
            // Scroll sonrası bir süre daha scroll listener'ı ignore et
            if (initialScrollTimeout) clearTimeout(initialScrollTimeout);
            isInitialScroll = true;
            initialScrollTimeout = setTimeout(() => {
                isInitialScroll = false;
            }, 1500); // Scroll sonrası 1.5 saniye daha ignore et
        }, 600); // Render için daha fazla bekle

        // Açılışta da hızlı cache’e yaz (bazı cihazlarda scroll listener tetiklenmeden kapanabiliyor)
        schedulePersistLastPage(currentResourceId, safeInitialPage);

        // Setup scroll listener for page indicator (with delay to prevent immediate override)
        setTimeout(() => {
            setupScrollListener();
            setupZoomListener();
        }, 2000); // Increased delay to ensure rendering and scrolling settles completely

        // Sayfa görünürlüğü değiştiğinde boş sayfaları tekrar render et
        setupVisibilityHandler();
        
        // Auto-save başlat (çizimlerin kaybolmasını önlemek için)
        startAutoSave();

    } catch (err) {
        logger.error("Error rendering PDF:", err);
        alert("PDF açılırken hata oluştu.");
    }
}

async function renderAllPages() {
    const wrapper = document.getElementById('pdf-pages-wrapper');
    
    // KRİTİK: Çizimleri önce kaydet (scale değişikliğinde kaybolmasınlar)
    // Mevcut çizimleri geçici olarak sakla
    const savedDrawings = {};
    for (let i = 0; i < renderedPages.length; i++) {
        const page = renderedPages[i];
        if (page && page.drawingCanvas && page.isRendered) {
            // Tüm render edilmiş sayfaların çizimlerini kaydet
            try {
                // Canvas boş değilse kaydet - basit kontrol
                const ctx = page.drawingCanvas.getContext('2d', { willReadFrequently: true });
                const imageData = ctx.getImageData(0, 0, Math.min(100, page.drawingCanvas.width), Math.min(100, page.drawingCanvas.height));
                const hasContent = imageData.data.some((pixel, index) => index % 4 === 3 && pixel > 0); // Alpha channel kontrolü
                if (hasContent) {
                    savedDrawings[page.pageNum] = page.drawingCanvas.toDataURL('image/png', 0.9);
                }
            } catch (err) {
                // getImageData hata verirse direkt kaydet (daha güvenli)
                try {
                    savedDrawings[page.pageNum] = page.drawingCanvas.toDataURL('image/png', 0.9);
                } catch (e) {
                    logger.warn(`[renderAllPages] Failed to save drawing for page ${page.pageNum}:`, e);
                }
            }
        }
    }
    
    // Geçici çizimleri global değişkene kaydet (renderPage içinde kullanılacak)
    window._tempSavedDrawings = savedDrawings;

    // Eski bitmap önbelleklerini temizle (GPU belleğini serbest bırak)
    for (const pData of renderedPages) {
        if (pData && pData.renderedBitmap) {
            try { pData.renderedBitmap.close(); } catch (e) {}
            pData.renderedBitmap = null;
        }
    }

    wrapper.innerHTML = ''; // Clear existing
    renderedPages = [];

    // Intersection Observer for Lazy Loading - Sayfalar görünür hale geldiğinde render et
    const lazyObserver = new IntersectionObserver((entries) => {
        // PERFORMANS: for loop kullan (forEach'den daha hızlı)
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.isIntersecting) {
                const pageNum = parseInt(entry.target.dataset.pageNum);
                // PERFORMANS: find() yerine direkt index kullan
                const pData = renderedPages[pageNum - 1];
                // Eğer sayfa render edilmiş ama canvas boşsa (uzun süre durduktan sonra), tekrar render et
                // getImageData kullanmıyoruz - performans için gereksiz ve Canvas2D uyarısına neden oluyor
                if (pData && pData.pageNum === pageNum && pData.isRendered) {
                    const renderCanvas = pData.renderCanvas;
                    if (renderCanvas && (!renderCanvas.width || !renderCanvas.height)) {
                        // Canvas boyutu yok, tekrar render et
                        pData.isRendered = false;
                    }
                }
                // Sadece render edilmemişse render et
                if (!pData || !pData.isRendered) {
                renderPage(pageNum);
            }
            }
        }
    }, {
        root: document.getElementById('pdf-pages-container'),
        rootMargin: '200px', // PERFORMANS: 500px'den 200px'e düşürüldü (daha az sayfa render edilir)
        threshold: 0.1
    });

    // İlk sayfanın boyutunu bir kez hesapla ve tüm placeholder'larda kullan
    const firstPage = await pdfDoc.getPage(1);
    const firstViewport = firstPage.getViewport({ scale: currentScale });

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        // Create page container (lightweight placeholder)
        const pageContainer = document.createElement('div');
        pageContainer.className = 'pdf-page-container placeholder';
        pageContainer.dataset.pageNum = pageNum;

        // Sabit boyutlar: her turda tekrar getPage(1) çağırmak yerine önceden hesaplanan viewport kullan
        pageContainer.style.width = firstViewport.width + 'px';
        pageContainer.style.height = firstViewport.height + 'px';

        wrapper.appendChild(pageContainer);

        renderedPages.push({
            pageNum,
            pageContainer,
            isRendered: false
        });

        lazyObserver.observe(pageContainer);
    }
    
    // Geçici çizimleri temizle (render tamamlandıktan sonra)
    setTimeout(() => {
        window._tempSavedDrawings = null;
    }, 5000); // 5 saniye sonra temizle
}

async function renderPage(pageNum) {
    const pData = renderedPages.find(p => p.pageNum === pageNum);
    if (!pData || pData.isRendered) return;

    try {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: currentScale });
        const container = pData.pageContainer;

        container.classList.remove('placeholder');
        container.innerHTML = ''; // Clear spinner if any

        // Create render canvas
        const renderCanvas = document.createElement('canvas');
        renderCanvas.className = 'pdf-render-canvas';
        renderCanvas.width = viewport.width;
        renderCanvas.height = viewport.height;

        // Create drawing canvas
        const drawingCanvas = document.createElement('canvas');
        drawingCanvas.className = 'pdf-drawing-layer';
        drawingCanvas.width = viewport.width;
        drawingCanvas.height = viewport.height;

        container.appendChild(renderCanvas);
        container.appendChild(drawingCanvas);

        // Render PDF page
        const renderContext = {
            canvasContext: renderCanvas.getContext('2d', { desynchronized: true }),
            viewport: viewport
        };
        await page.render(renderContext).promise;

        // Load saved annotations
        // KRİTİK: Önce DB'den yükle, sonra geçici kaydedilmiş çizimleri yükle (scale değişikliğinde)
        loadPageDrawing(pageNum, drawingCanvas);
        
        // Eğer scale değişikliği sırasında geçici olarak kaydedilmiş çizim varsa, onu da yükle
        // (Bu, renderAllPages içinde savedDrawings'den gelir)
        if (window._tempSavedDrawings && window._tempSavedDrawings[pageNum]) {
            const ctx = drawingCanvas.getContext('2d', { willReadFrequently: true });
            const img = new Image();
            img.src = window._tempSavedDrawings[pageNum];
            img.onload = () => {
                ctx.globalCompositeOperation = 'source-over';
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                // Scale'e göre yeniden boyutlandır (kayma önleme)
                ctx.drawImage(img, 0, 0, drawingCanvas.width, drawingCanvas.height);
                pData.hasChanges = true; // Çizim var, değişiklik olarak işaretle
            };
        }

        // Store references in state
        pData.renderCanvas = renderCanvas;
        pData.drawingCanvas = drawingCanvas;
        pData.isRendered = true;
        pData.hasChanges = false; // Track if page has been drawn on

        // Setup drawing listeners for this canvas
        setupCanvasDrawing(drawingCanvas, pageNum);

        // KRİTİK: Sekme değiştiğinde GPU canvas içeriği silinebilir.
        // ImageBitmap ile anlık geri yükleme için bitmap önbelleği oluştur.
        try {
            if (typeof createImageBitmap === 'function') {
                // Eski bitmap varsa belleği serbest bırak
                if (pData.renderedBitmap) {
                    pData.renderedBitmap.close();
                    pData.renderedBitmap = null;
                }
                pData.renderedBitmap = await createImageBitmap(renderCanvas);
            }
        } catch (bitmapErr) {
            logger.warn(`[PDF] ImageBitmap cache failed for page ${pageNum}:`, bitmapErr);
        }

    } catch (err) {
        logger.error(`Error rendering page ${pageNum}:`, err);
    }
}

// Ultra-low latency drawing: Direct drawing without requestAnimationFrame delay
// Canvas context cache for instant access
const canvasContextCache = new WeakMap();
// ESKİ PROJE GİBİ: Cache canvas bounding rect to avoid DOM reads on every pointermove
const canvasRectCache = new WeakMap();
// Path açık tutma için flag (her canvas için ayrı takip edilmeli)
let canvasPathOpenMap = new WeakMap();

function setupCanvasDrawing(canvas, pageNum) {
    // Ensure canvas has proper pointer events
    canvas.style.pointerEvents = 'auto';
    
    // Cache canvas context immediately for zero-latency drawing
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // Optimize context for fast drawing
    ctx.imageSmoothingEnabled = false; // Faster rendering
    ctx.imageSmoothingQuality = 'low'; // Further optimize
    canvasContextCache.set(canvas, ctx);
    canvasPathOpenMap.set(canvas, false); // Path kapalı başlat
    
    // ESKİ PROJE GİBİ: Cache initial bounding rect
    const rect = canvas.getBoundingClientRect();
    canvasRectCache.set(canvas, { left: rect.left, top: rect.top });

    // ESKİ PROJE GİBİ: pointerdown kullan (daha hızlı)
    canvas.addEventListener('pointerdown', (e) => {
        if (screenshotMode) return; // Disable drawing in screenshot mode

        const container = document.getElementById('pdf-pages-container');

        // Optik özel sayfalarında el aracı ile sayfayı kaydırma devre dışı
        if (currentTool === 'hand' && container && pageNum < OPTIC_SPECIAL_MIN) {
            // El aracı: çizim yerine sayfayı sürükleyerek kaydır
            isPanning = true;
            activeCanvas = canvas;
            panStartY = e.clientY;
            panStartScrollTop = container.scrollTop;
            return;
        }

        isDrawing = true;
        activeCanvas = canvas;
        
        // ESKİ PROJE GİBİ: Cache kullan (daha hızlı)
        const rect = canvas.getBoundingClientRect();
        canvasRectCache.set(canvas, { left: rect.left, top: rect.top });
        
        const cachedRect = canvasRectCache.get(canvas);
        lastX = e.clientX - cachedRect.left;
        lastY = e.clientY - cachedRect.top;
        
        // ESKİ PROJE GİBİ: İlk noktayı HEMEN çiz ve context ayarlarını BİR KEZ burada set et
        const cachedCtx = canvasContextCache.get(canvas);
        if (cachedCtx) {
            // Context ayarlarını BİR KEZ burada yap (pointermove'da yapma - performans için)
            if (currentTool === 'eraser') {
                cachedCtx.globalCompositeOperation = 'destination-out';
                cachedCtx.lineWidth = eraserSize;
                cachedCtx.strokeStyle = 'rgba(0,0,0,1)';
            } else {
                cachedCtx.globalCompositeOperation = 'source-over';
                cachedCtx.strokeStyle = currentColor;
                cachedCtx.lineWidth = currentSize;
            }
            cachedCtx.lineCap = 'round';
            cachedCtx.lineJoin = 'round';
            cachedCtx.imageSmoothingEnabled = false;
            cachedCtx.imageSmoothingQuality = 'low';
            
            // Path'i başlat - sürekli açık tutacağız (daha hızlı, lag yok)
            // PERFORMANS: İlk noktayı çizmek için path kullan - arc+fill'den çok daha hızlı
            // İlk noktayı görünür yapmak için çok küçük bir çizgi çiz (0 gecikme)
            cachedCtx.beginPath();
            cachedCtx.moveTo(lastX, lastY);
            // Çok küçük bir çizgi - nokta gibi görünecek ama path ile (çok daha hızlı)
            cachedCtx.lineTo(lastX + 0.05, lastY + 0.05); // Daha küçük = daha hızlı
            cachedCtx.stroke();
            // Path'i başlat (bir sonraki move için)
            cachedCtx.beginPath();
            cachedCtx.moveTo(lastX, lastY);
            canvasPathOpenMap.set(canvas, true); // Path açık
        }
    });

    // Draw using coalesced events for smoother lines
    canvas.addEventListener('pointermove', (e) => {
        if (screenshotMode || activeCanvas !== canvas) return;

        const container = document.getElementById('pdf-pages-container');
        if (isPanning && currentTool === 'hand' && container) {
            const deltaY = e.clientY - panStartY;
            container.scrollTop = panStartScrollTop - deltaY * handScrollSpeed;
            // Update rect cache when panning (canvas position might change)
            const rect = canvas.getBoundingClientRect();
            canvasRectCache.set(canvas, { left: rect.left, top: rect.top });
            return;
        }

        if (!isDrawing) return;
        
        // ESKİ PROJE GİBİ: Cache kullan (daha hızlı)
        let cachedRect = canvasRectCache.get(canvas);
        if (!cachedRect) {
            // Fallback if cache missing
            const rect = canvas.getBoundingClientRect();
            cachedRect = { left: rect.left, top: rect.top };
            canvasRectCache.set(canvas, cachedRect);
        }
        
        // getCoalescedEvents kullanma - direkt çiz (daha hızlı ve lag yok)
        // Coalesced events bazen lag yaratabiliyor, direkt event kullan
        const x = e.clientX - cachedRect.left;
        const y = e.clientY - cachedRect.top;
        
        // Validate coordinates - optimize: sadece gerçekten dışarı çıktığında rect güncelle
        const isOutOfBounds = x < -50 || x > canvas.width + 50 || y < -50 || y > canvas.height + 50;
        if (isOutOfBounds) {
            // Canvas dışına çıktı, rect'i güncelle (nadir durum)
            const rect = canvas.getBoundingClientRect();
            cachedRect = { left: rect.left, top: rect.top };
            canvasRectCache.set(canvas, cachedRect);
            const newX = e.clientX - cachedRect.left;
            const newY = e.clientY - cachedRect.top;
            drawDirect(canvas, lastX, lastY, newX, newY);
            lastX = newX;
            lastY = newY;
        } else {
            // DIRECT DRAWING - Zero latency, no requestAnimationFrame delay, no batching
            // Path açık tutuluyor, sadece lineTo ve stroke (en hızlı yöntem)
            drawDirect(canvas, lastX, lastY, x, y);
            lastX = x;
            lastY = y;
        }
    });

    // ESKİ PROJE GİBİ: pointerup ve pointerout kullan
    canvas.addEventListener('pointerup', () => {
        const container = document.getElementById('pdf-pages-container');
        if (isPanning && activeCanvas === canvas) {
            isPanning = false;
        }

        if (isDrawing && activeCanvas === canvas && currentTool !== 'hand') {
            isDrawing = false;
            const cachedCtx = canvasContextCache.get(canvas);
            if (cachedCtx) {
                cachedCtx.beginPath(); // Reset path for next stroke
            }
            canvasPathOpenMap.set(canvas, false); // Path'i kapat
            // PERFORMANS: Sadece değişiklik flag'ini set et - idle save ve kapatırken kaydedilecek
            const pData = renderedPages.find(p => p.pageNum === pageNum);
            if (pData) {
                pData.hasChanges = true; // Bu sayfa değişti, idle save ve kapatırken kaydedilecek
                // Kullanıcı aktivitesini kaydet (çizim yapıldı)
                recordUserActivity();
            }

            // Optik sayfaları için sadece değişiklik flag'i set et
            if (pageNum >= OPTIC_SPECIAL_MIN) {
                markOpticChanged(pageNum);
            }
        }
    });

    canvas.addEventListener('pointerout', () => {
        const container = document.getElementById('pdf-pages-container');
        if (isPanning && activeCanvas === canvas) {
            isPanning = false;
        }

        if (isDrawing && activeCanvas === canvas && currentTool !== 'hand') {
            isDrawing = false;
            const cachedCtx = canvasContextCache.get(canvas);
            if (cachedCtx) {
                cachedCtx.beginPath(); // Reset path for next stroke
            }
            canvasPathOpenMap.set(canvas, false); // Path'i kapat
            // PERFORMANS: Sadece değişiklik flag'ini set et - idle save ve kapatırken kaydedilecek
            const pData = renderedPages.find(p => p.pageNum === pageNum);
            if (pData) {
                pData.hasChanges = true; // Bu sayfa değişti, idle save ve kapatırken kaydedilecek
                // Kullanıcı aktivitesini kaydet (çizim yapıldı)
                recordUserActivity();
            }

            // Optik sayfaları için sadece değişiklik flag'i set et
            if (pageNum >= OPTIC_SPECIAL_MIN) {
                markOpticChanged(pageNum);
            }
        }
    });

    // --- Touch Support for stylus/touchscreen (Global çizim paleti gibi) ---
    canvas.addEventListener('touchstart', (e) => {
        if (screenshotMode) return;
        const container = document.getElementById('pdf-pages-container');
        if (currentTool === 'hand' && container) {
            isPanning = true;
            activeCanvas = canvas;
            const touch = e.touches[0];
            panStartY = touch.clientY;
            panStartScrollTop = container.scrollTop;
            return;
        }
        isDrawing = true;
        activeCanvas = canvas;
        const rect = canvas.getBoundingClientRect();
        const touch = e.touches[0];
        lastX = touch.clientX - rect.left;
        lastY = touch.clientY - rect.top;
        // No path start needed for segment drawing
        e.preventDefault();
    });

    canvas.addEventListener('touchmove', (e) => {
        if (screenshotMode || activeCanvas !== canvas) return;
        const container = document.getElementById('pdf-pages-container');
        if (isPanning && currentTool === 'hand' && container) {
            const touch = e.touches[0];
            const deltaY = touch.clientY - panStartY;
            container.scrollTop = panStartScrollTop - deltaY * handScrollSpeed;
            return;
        }
        if (!isDrawing) return;
        const rect = canvas.getBoundingClientRect();

        // Handle multiple touches if needed, but usually just one for drawing
        const touch = e.touches[0];
        const x = touch.clientX - rect.left;
        const y = touch.clientY - rect.top;

        drawDirect(canvas, lastX, lastY, x, y);

        lastX = x;
        lastY = y;
        e.preventDefault();
    });

    canvas.addEventListener('touchend', () => {
        if (isDrawing && activeCanvas === canvas) {
            isDrawing = false;
            const cachedCtx = canvasContextCache.get(canvas);
            if (cachedCtx) {
                cachedCtx.beginPath(); // Reset path for next stroke
            }
            canvasPathOpenMap.set(canvas, false); // Path'i kapat
            // PERFORMANS: Sadece değişiklik flag'ini set et - idle save ve kapatırken kaydedilecek
            const pData = renderedPages.find(p => p.pageNum === pageNum);
            if (pData) {
                pData.hasChanges = true; // Bu sayfa değişti, idle save ve kapatırken kaydedilecek
                // Kullanıcı aktivitesini kaydet (çizim yapıldı)
                recordUserActivity();
            }

            // Optik sayfaları için sadece değişiklik flag'i set et
            if (pageNum >= OPTIC_SPECIAL_MIN) {
                markOpticChanged(pageNum);
            }
        }
    });
}

// Ultra-fast direct drawing function - uses cached context
// Path açık tutuluyor - her segment için yeni path oluşturulmuyor (ÇOK DAHA HIZLI, LAG YOK)
// ZERO LATENCY - No requestAnimationFrame, direct drawing
function drawDirect(canvas, x1, y1, x2, y2) {
    let ctx = canvasContextCache.get(canvas);
    if (!ctx) {
        ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        canvasContextCache.set(canvas, ctx);
        ctx.imageSmoothingEnabled = false;
        ctx.imageSmoothingQuality = 'low';
        canvasPathOpenMap.set(canvas, false);
    }

    let isPathOpen = canvasPathOpenMap.get(canvas) || false;

    // Context ayarları sadece path kapalıysa set et (performans için - lag önleme)
    if (!isPathOpen) {
        if (currentTool === 'eraser') {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.lineWidth = eraserSize;
            ctx.strokeStyle = 'rgba(0,0,0,1)';
        } else {
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = currentColor;
            ctx.lineWidth = currentSize;
        }
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        // Path'i başlat
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        canvasPathOpenMap.set(canvas, true);
        isPathOpen = true;
    }

    // Path açık, sadece lineTo ve stroke (ÇOK DAHA HIZLI, LAG YOK)
    // Direct drawing - no delays, no batching, immediate render
    ctx.lineTo(x2, y2);
    ctx.stroke();
    // Path açık kalıyor, bir sonraki lineTo ile devam edecek
}

function markOpticChanged(pageNum) {
    if (pageNum === OPTIC_PAGE_GY) {
        opticHasChanges.GY = true;
    } else if (pageNum === OPTIC_PAGE_GK) {
        opticHasChanges.GK = true;
    }
}

// === OPTİK FORM PANELİ ===
function initializeOpticPanel() {
    const panel = document.getElementById('pdf-optic-panel');
    const gyCanvas = document.getElementById('pdf-optic-canvas-GY');
    const gkCanvas = document.getElementById('pdf-optic-canvas-GK');

    if (!panel || !gyCanvas || !gkCanvas) return;

    // Panel her PDF açılışında görünmez başlasın
    panel.classList.add('hidden');
    opticPanelVisible = false;

    // Canvas boyutlarını fiziksel piksel olarak ayarla
    [gyCanvas, gkCanvas].forEach((cv) => {
        cv.width = OPTIC_WIDTH;
        cv.height = OPTIC_HEIGHT;
    });

    opticCanvases.GY = gyCanvas;
    opticCanvases.GK = gkCanvas;

    // Çizim dinleyicilerini PDF ile aynı algoritma ile kur
    setupCanvasDrawing(gyCanvas, OPTIC_PAGE_GY);
    setupCanvasDrawing(gkCanvas, OPTIC_PAGE_GK);

    // Mevcut kaydedilmiş çizimleri yükle
    loadPageDrawing(OPTIC_PAGE_GY, gyCanvas);
    loadPageDrawing(OPTIC_PAGE_GK, gkCanvas);

    // Varsayılan sekme
    switchOpticTab('GY');

    // Varsayılan konum: pdf-body içinde dikeyde ortala
    centerOpticPanelVertically();

    // Sürüklenebilir tutamac
    setupOpticHandleDrag(panel);

    // Sekme butonları
    const tabButtons = panel.querySelectorAll('.pdf-optic-tab');
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.opticTab;
            if (!tab) return;
            switchOpticTab(tab);
        });
    });

    opticPanelInitialized = true;
}

function toggleOpticPanel() {
    const panel = document.getElementById('pdf-optic-panel');
    if (!panel) return;
    if (!opticPanelInitialized) {
        initializeOpticPanel();
    }
    opticPanelVisible = !opticPanelVisible;
    panel.classList.toggle('hidden', !opticPanelVisible);
}

function switchOpticTab(tabKey) {
    if (tabKey !== 'GY' && tabKey !== 'GK') return;
    opticActiveTab = tabKey;

    const panel = document.getElementById('pdf-optic-panel');
    if (!panel) return;

    const gyCanvas = opticCanvases.GY;
    const gkCanvas = opticCanvases.GK;
    if (gyCanvas && gkCanvas) {
        if (tabKey === 'GY') {
            gyCanvas.classList.remove('hidden');
            gkCanvas.classList.add('hidden');
        } else {
            gyCanvas.classList.add('hidden');
            gkCanvas.classList.remove('hidden');
        }
    }

    const tabs = panel.querySelectorAll('.pdf-optic-tab');
    tabs.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.opticTab === tabKey);
    });
}

function centerOpticPanelVertically() {
    const panel = document.getElementById('pdf-optic-panel');
    const body = document.querySelector('.pdf-body');
    if (!panel || !body) return;

    const bodyRect = body.getBoundingClientRect();
    const panelHeight = OPTIC_HEIGHT;
    const top = Math.max(0, (bodyRect.height - panelHeight) / 2);
    panel.style.top = `${top}px`;
}

function setupOpticHandleDrag(panel) {
    const handle = document.getElementById('pdf-optic-handle');
    const body = document.querySelector('.pdf-body');
    if (!handle || !body) return;

    let dragging = false;
    let startY = 0;
    let startTop = 0;

    const onPointerDown = (e) => {
        dragging = true;
        startY = e.clientY;
        const panelRect = panel.getBoundingClientRect();
        startTop = panelRect.top - body.getBoundingClientRect().top;
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        e.preventDefault();
    };

    const onPointerMove = (e) => {
        if (!dragging) return;
        const deltaY = e.clientY - startY;
        const bodyRect = body.getBoundingClientRect();
        let newTop = startTop + deltaY;
        // Sadece dikey eksende ve sınırlar içinde
        const minTop = 0;
        const maxTop = Math.max(0, bodyRect.height - OPTIC_HEIGHT);
        if (newTop < minTop) newTop = minTop;
        if (newTop > maxTop) newTop = maxTop;
        panel.style.top = `${newTop}px`;
    };

    const onPointerUp = () => {
        dragging = false;
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
    };

    handle.addEventListener('pointerdown', onPointerDown);
}

// Legacy draw function for compatibility
function draw(canvas, x1, y1, x2, y2) {
    drawDirect(canvas, x1, y1, x2, y2);
}

// Auto-save mechanism: Sadece kullanıcı hareketsiz kaldığında (idle) kaydet
let autoSaveTimeout = null;
let lastUserActivity = Date.now();
let lastSaveTime = {};
const IDLE_SAVE_DELAY = 120000; // 2 dakika (120000 ms) hareketsiz kalırsa kaydet

// Kullanıcı aktivitesini kaydet (çizim, scroll, zoom, sayfa değişikliği)
function recordUserActivity() {
    lastUserActivity = Date.now();
    // Eğer bir idle save zamanlanmışsa, iptal et (kullanıcı aktif)
    if (autoSaveTimeout) {
        clearTimeout(autoSaveTimeout);
        autoSaveTimeout = null;
    }
    // Yeni idle save zamanla
    scheduleIdleSave();
}

// Idle save zamanla (kullanıcı 2 dakika hareketsiz kalırsa kaydet)
function scheduleIdleSave() {
    if (autoSaveTimeout) {
        clearTimeout(autoSaveTimeout);
    }
    
    autoSaveTimeout = setTimeout(() => {
        // 2 dakika geçti, kullanıcı hala hareketsiz mi kontrol et
        const idleTime = Date.now() - lastUserActivity;
        if (idleTime >= IDLE_SAVE_DELAY) {
            // Kullanıcı 2 dakika hareketsiz, kaydet
            autoSaveDrawings();
            logger.log('[AutoSave] Idle save triggered after 2 minutes');
        }
        autoSaveTimeout = null;
    }, IDLE_SAVE_DELAY);
}

// Auto-save function: Sadece idle olduğunda çalışır
async function autoSaveDrawings() {
    if (!currentResourceId) return;
    
    // Sadece değişen sayfaları kaydet
    for (let i = 0; i < renderedPages.length; i++) {
        const page = renderedPages[i];
        if (page && page.drawingCanvas && page.isRendered && page.hasChanges) {
            const pageNum = page.pageNum;
            const now = Date.now();
            
            // Son kayıttan en az 10 saniye geçmişse kaydet (spam önleme)
            if (!lastSaveTime[pageNum] || (now - lastSaveTime[pageNum]) > 10000) {
                try {
                    const data = page.drawingCanvas.toDataURL('image/png', 0.9);
                    savePageAnnotation(currentResourceId, pageNum, data);
                    lastSaveTime[pageNum] = now;
                    logger.log(`[AutoSave] Saved page ${pageNum} drawing (idle)`);
                } catch (err) {
                    logger.warn(`[AutoSave] Failed to save page ${pageNum}:`, err);
                }
            }
        }
    }

    // Optik form çizimlerini de idle durumda, seyrek aralıklarla kaydet
    const now = Date.now();
    if (opticCanvases.GY && opticHasChanges.GY && (!opticLastSaveTime.GY || (now - opticLastSaveTime.GY) > 10000)) {
        try {
            savePageDrawing(OPTIC_PAGE_GY, opticCanvases.GY);
            opticLastSaveTime.GY = now;
            opticHasChanges.GY = false;
            logger.log('[AutoSave] Saved optic GY drawing (idle)');
        } catch (err) {
            logger.warn('[AutoSave] Failed to save optic GY:', err);
        }
    }
    if (opticCanvases.GK && opticHasChanges.GK && (!opticLastSaveTime.GK || (now - opticLastSaveTime.GK) > 10000)) {
        try {
            savePageDrawing(OPTIC_PAGE_GK, opticCanvases.GK);
            opticLastSaveTime.GK = now;
            opticHasChanges.GK = false;
            logger.log('[AutoSave] Saved optic GK drawing (idle)');
        } catch (err) {
            logger.warn('[AutoSave] Failed to save optic GK:', err);
        }
    }
}

// Start auto-save tracking when PDF is opened
function startAutoSave() {
    lastUserActivity = Date.now();
    scheduleIdleSave();
    logger.log('[AutoSave] Started idle save tracking');
}

// Stop auto-save when PDF is closed
function stopAutoSave() {
    if (autoSaveTimeout) {
        clearTimeout(autoSaveTimeout);
        autoSaveTimeout = null;
    }
    lastSaveTime = {};
    opticLastSaveTime = { GY: 0, GK: 0 };
    logger.log('[AutoSave] Stopped idle save tracking');
}

// PERFORMANS: toDataURL() çok yavaş, main thread'i blokluyor
// Sadece gerektiğinde çağır - requestIdleCallback kullan
function savePageDrawing(pageNum, canvas) {
    if (!currentResourceId || !canvas) return;
    
    // requestIdleCallback kullan - browser boşta olduğunda çalışsın (lag önleme)
    if (window.requestIdleCallback) {
        requestIdleCallback(() => {
            try {
                const data = canvas.toDataURL('image/png', 0.9); // 0.9 quality - daha hızlı
    savePageAnnotation(currentResourceId, pageNum, data);
            } catch (err) {
                logger.warn('[PDF] Failed to save page drawing:', err);
            }
        }, { timeout: 2000 }); // Max 2 saniye bekle
    } else {
        // Fallback: setTimeout kullan
        setTimeout(() => {
            try {
                const data = canvas.toDataURL('image/png', 0.9);
                savePageAnnotation(currentResourceId, pageNum, data);
            } catch (err) {
                logger.warn('[PDF] Failed to save page drawing:', err);
            }
        }, 100);
    }
}

function loadPageDrawing(pageNum, canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    // Optimize image rendering for performance
    ctx.imageSmoothingEnabled = true; // Scale değiştiğinde düzgün görünsün
    ctx.imageSmoothingQuality = 'high'; // Yüksek kalite - çizimler kaymasın

    const savedData = getPageAnnotation(currentResourceId, pageNum);
    if (savedData) {
        const img = new Image();
        img.src = savedData;
        img.onload = () => {
            ctx.globalCompositeOperation = 'source-over';
            // KRİTİK: Çizimleri canvas boyutuna göre scale et (kayma önleme)
            // Eski scale'de kaydedilmiş çizimleri yeni scale'e göre yeniden boyutlandır
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        };
    }
}

// Scroll listener için debounce timer
let scrollUpdateTimer = null;
let scrollObserver = null;
let isInitialScroll = true; // Açılışta scroll listener'ı ignore et
let initialScrollTimeout = null;
let isManualPageChange = false; // Manuel sayfa değişikliği flag'i (scroll listener'ı ignore etmek için)
let manualPageChangeTimeout = null;

function setupScrollListener() {
    const container = document.getElementById('pdf-pages-container');
    
    // Eski observer'ı temizle (yeniden açılışta çakışma olmasın)
    if (scrollObserver) {
        scrollObserver.disconnect();
        scrollObserver = null;
    }
    
    // Scroll aktivitesini kaydet (kullanıcı scroll yaptığında)
    if (container) {
        let scrollActivityTimeout = null;
        container.addEventListener('scroll', () => {
            // Debounce scroll aktivitesi (her scroll event'inde değil, scroll durduğunda)
            if (scrollActivityTimeout) {
                clearTimeout(scrollActivityTimeout);
            }
            scrollActivityTimeout = setTimeout(() => {
                recordUserActivity();
            }, 500); // Scroll durduktan 500ms sonra aktivite kaydet
        }, { passive: true });
    }

    // Açılışta scroll listener'ı ignore et (2 saniye)
    isInitialScroll = true;
    if (initialScrollTimeout) clearTimeout(initialScrollTimeout);
    initialScrollTimeout = setTimeout(() => {
        isInitialScroll = false;
    }, 2000); // 2 saniye boyunca ignore et

    // Use a simpler observer that tracks all visible pages
    // and determines which one is "primary" (most visible).
    scrollObserver = new IntersectionObserver((entries) => {
        // Açılışta veya manuel sayfa değişikliğinde scroll listener'ı ignore et
        if (isInitialScroll || isManualPageChange) return;

        entries.forEach(entry => {
            const pageNum = parseInt(entry.target.dataset.pageNum);
            const pData = renderedPages.find(p => p.pageNum === pageNum);
            if (pData) {
                pData.intersectionRatio = entry.intersectionRatio;
            }
        });

        // Debounce page updates for better performance
        if (scrollUpdateTimer) {
            clearTimeout(scrollUpdateTimer);
        }

        scrollUpdateTimer = setTimeout(() => {
            // Açılışta veya manuel sayfa değişikliğinde scroll listener'ı ignore et
            if (isInitialScroll || isManualPageChange) return;

        // Find page with max intersection ratio
            // Optimize: for loop kullan (forEach'den daha hızlı, lag azaltmak için)
        let maxRatio = 0;
        let mostVisiblePage = currentPageNum;

            for (let i = 0; i < renderedPages.length; i++) {
                const p = renderedPages[i];
            if (p.intersectionRatio > maxRatio) {
                maxRatio = p.intersectionRatio;
                mostVisiblePage = p.pageNum;
            }
            }

            // Sadece gerçekten farklı bir sayfaya geçildiyse güncelle
            // Ve minimum %30 görünürlük olsun (yanlış algılamayı önlemek için)
            if (maxRatio > 0.3 && mostVisiblePage !== currentPageNum && mostVisiblePage > 0) {
            const indicator = document.getElementById('current-page-indicator');
                currentPageNum = mostVisiblePage;
                if (indicator) indicator.textContent = currentPageNum;
                // PERFORMANS: DB yazma işlemini scroll sırasında yapma - sadece cache'e yaz
                // DB yazma işlemi çok yavaş, scroll'u blokluyor
                // Sadece cache'e yaz, DB'ye kapatırken yazılacak
                schedulePersistLastPage(currentResourceId, currentPageNum);
                // updateResourceLastPage çağrısını kaldırdık - sadece kapatırken yazılacak
                // Kullanıcı aktivitesini kaydet (scroll yapıldı)
                recordUserActivity();
            }
        }, 500); // 500ms debounce - scroll durduğunda çalışsın (lag azaltmak için)

    }, {
        root: container,
        threshold: [0.3, 0.5, 1.0], // Daha az threshold = daha hızlı (lag azaltmak için)
        // 0 threshold'u kaldırdık - sadece görünür sayfaları kontrol et
        rootMargin: '0px' // No margin for better performance
    });

    // Observe all pages
    renderedPages.forEach(page => {
        scrollObserver.observe(page.pageContainer);
    });
}

async function scrollToPage(pageNum, isManual = false) {
    const page = renderedPages.find(p => p.pageNum === pageNum);
    logger.log(`[scrollToPage] Looking for page ${pageNum}, found:`, !!page, `renderedPages count: ${renderedPages.length}`, `isManual: ${isManual}`);
    
    // Manuel sayfa değişikliği ise scroll listener'ı ignore et
    if (isManual) {
        isManualPageChange = true;
        if (manualPageChangeTimeout) clearTimeout(manualPageChangeTimeout);
        // Manuel değişiklikte daha uzun süre ignore et (scroll tamamlanana kadar)
        manualPageChangeTimeout = setTimeout(() => {
            isManualPageChange = false;
        }, 2000); // 2 saniye ignore et
        // Kullanıcı aktivitesini kaydet (manuel sayfa değişikliği)
        recordUserActivity();
    }
    
    if (!page) {
        logger.warn(`[scrollToPage] Page ${pageNum} not found in renderedPages, rendering now...`);
        // Sayfa henüz render edilmemişse render et
        await renderPage(pageNum);
        const pageAfterRender = renderedPages.find(p => p.pageNum === pageNum);
        if (pageAfterRender) {
            pageAfterRender.pageContainer.scrollIntoView({ behavior: 'auto', block: 'start' });
            // Scroll sonrası bir süre scroll listener'ı ignore et
            if (initialScrollTimeout) clearTimeout(initialScrollTimeout);
            isInitialScroll = true;
            initialScrollTimeout = setTimeout(() => {
                isInitialScroll = false;
            }, 1500);
        }
        return;
    }
    
    // Sayfa render edilmişse direkt scroll yap
        logger.log(`[scrollToPage] Scrolling to page ${pageNum}`);
        page.pageContainer.scrollIntoView({ behavior: 'auto', block: 'start' });
    
    // Scroll sonrası bir süre scroll listener'ı ignore et (yanlış algılamayı önlemek için)
    if (initialScrollTimeout) clearTimeout(initialScrollTimeout);
    isInitialScroll = true;
    initialScrollTimeout = setTimeout(() => {
        isInitialScroll = false;
    }, isManual ? 2000 : 1000); // Manuel değişiklikte daha uzun ignore et
}

function setupZoomListener() {
    const container = document.getElementById('pdf-pages-container');
    if (!container) return;

    container.addEventListener('wheel', (e) => {
            if (e.ctrlKey) {
            e.preventDefault();
            if (e.deltaY < 0) {
                currentScale = Math.min(currentScale + 0.1, 5.0);
            } else {
                currentScale = Math.max(currentScale - 0.1, 0.5);
            }
            updateZoomDisplay();
            showToast(`Zoom: ${Math.round(currentScale * 100)}%`, 'info');

                // Yakınlaştırmayı kalıcı hale getir (her PDF için ayrı)
                saveZoomSetting(currentResourceId);
                
                // Kullanıcı aktivitesini kaydet (zoom yapıldı)
                recordUserActivity();

            // KRİTİK: Yakınlaştırma sonrası sayfa pozisyonunu koru
            if (renderTimeout) clearTimeout(renderTimeout);
            renderTimeout = setTimeout(async () => {
                const savedPage = currentPageNum;
                const container = document.getElementById('pdf-pages-container');
                const scrollTopBefore = container ? container.scrollTop : 0;
                
                // Tüm sayfaları yeniden render et
                await renderAllPages();
                
                // Sayfa pozisyonunu koru - scroll pozisyonunu hesapla
                // Scale değiştiği için scroll pozisyonunu da scale'e göre ayarla
                if (container) {
                    // Önce hedef sayfaya scroll yap
                    await scrollToPage(savedPage, true);
                    // Sonra scroll pozisyonunu scale değişikliğine göre ayarla
                    // Scale artarsa scroll da artmalı, azalırsa azalmalı
                    const scaleRatio = currentScale / (savedPage ? 1 : 1); // Önceki scale'i bilmiyoruz, bu yüzden direkt scroll yapıyoruz
                    setTimeout(() => {
                        scrollToPage(savedPage, true);
                    }, 200);
                }
            }, 100);
        }
    }, { passive: false });
}

function updateZoomDisplay() {
    const input = document.getElementById('pdf-zoom-input');
    if (input) {
        input.value = Math.round(currentScale * 100);
    }
}

// PERFORMANS: Sadece değişen sayfaların çizimlerini kaydet (kapatırken - Save and Exit)
// Çok daha hızlı - sadece değişen sayfalar kaydediliyor, paralel işlem
async function saveAllPageDrawings() {
    if (!currentResourceId) return;
    
    const savePromises = [];

    // Optik form canvas'larını ÖNCE kaydet — erken çıkıştan önce (sadece optik form değiştiyse de kaydet)
    if (opticCanvases.GY) {
        savePromises.push(new Promise((resolve) => {
            try {
                const data = opticCanvases.GY.toDataURL('image/png', 0.85);
                savePageAnnotation(currentResourceId, OPTIC_PAGE_GY, data);
                resolve();
            } catch (err) {
                logger.warn('[saveAllPageDrawings] Failed to save optic GY:', err);
                resolve();
            }
        }));
    }
    if (opticCanvases.GK) {
        savePromises.push(new Promise((resolve) => {
            try {
                const data = opticCanvases.GK.toDataURL('image/png', 0.85);
                savePageAnnotation(currentResourceId, OPTIC_PAGE_GK, data);
                resolve();
            } catch (err) {
                logger.warn('[saveAllPageDrawings] Failed to save optic GK:', err);
                resolve();
            }
        }));
    }

    // Sadece değişen PDF sayfalarını kaydet
    const changedPages = [];
    for (let i = 0; i < renderedPages.length; i++) {
        const page = renderedPages[i];
        if (page && page.drawingCanvas && page.isRendered && page.hasChanges) {
            changedPages.push(page);
        }
    }

    if (changedPages.length === 0 && savePromises.length === 0) {
        logger.log('[saveAllPageDrawings] No changes to save');
        return;
    }

    logger.log(`[saveAllPageDrawings] Saving ${changedPages.length} changed pages + optic for resource:`, currentResourceId);

    changedPages.forEach(page => {
        savePromises.push(new Promise((resolve) => {
            try {
                const data = page.drawingCanvas.toDataURL('image/png', 0.85);
                savePageAnnotation(currentResourceId, page.pageNum, data);
                resolve();
            } catch (err) {
                logger.warn(`[saveAllPageDrawings] Failed to save page ${page.pageNum}:`, err);
                resolve();
            }
        }));
    });
    
    // Tüm sayfaları paralel kaydet
    await Promise.all(savePromises);
    
    logger.log('[saveAllPageDrawings] All changed pages saved');
}

export async function closePDFViewer() {
    // ÖNCE: Auto-save'i durdur
    stopAutoSave();
    
    // ÖNCE: Değişkenleri sakla (state temizlenmeden önce)
    const resourceId = currentResourceId;
    const pageNum = currentPageNum;
    const pagesToSave = [...renderedPages]; // Copy array before clearing
    
    logger.log('[closePDFViewer] Save and Exit - Saving changed drawings and page:', pageNum, 'for resource:', resourceId);
    
    // PERFORMANS: Save işlemini paralel yap - kullanıcıyı bekletme
    // Önce UI'ı kapat (kullanıcı hemen çıkabilsin), sonra background'da kaydet
    const savePromise = resourceId ? (async () => {
        // Save işlemini geçici olarak renderedPages'i kullan
        const originalPages = renderedPages;
        renderedPages = pagesToSave; // Geçici olarak set et
        await saveAllPageDrawings();
        renderedPages = originalPages; // Geri al
    })() : Promise.resolve();
    
    const pageSavePromise = resourceId && pageNum ? persistLastPageQuick(resourceId, pageNum) : Promise.resolve();
    
    // UI'ı hemen kapat (kullanıcıyı bekletme)
    const header = document.querySelector('.global-header');
    if (header) {
        header.style.visibility = '';
        header.style.pointerEvents = '';
    }
    const focusPanel = document.getElementById('daily-focus-panel');
    if (focusPanel && focusPanel.style.display === 'none') {
        focusPanel.style.display = '';
    }
    // CSS değişkenini yeniden hesapla (PDF açıkken resize olursa 0'a düşüyor)
    requestAnimationFrame(() => {
        const panel = document.getElementById('daily-focus-panel');
        if (panel) {
            document.documentElement.style.setProperty(
                '--daily-focus-panel-height',
                `${panel.offsetHeight}px`
            );
        }
    });
    const pdfOverlay = document.getElementById('pdf-viewer-overlay');
    pdfOverlay.style.top = '';
    pdfOverlay.style.height = '';
    const headerToggleBtn = document.getElementById('pdf-header-toggle-btn');
    if (headerToggleBtn) {
        headerToggleBtn.title = 'Üst Menüyü Gizle';
        headerToggleBtn.classList.remove('active');
    }
    pdfOverlay.classList.add('hidden');
    
    // İkinci PDF popup'ı kapat
    closeSecondaryPopup();

    // Gemini ve Not panelini kapat
    if (geminiPopupVisible) closeGeminiPopup();
    if (notesPopupVisible) closeNotesPopup();
    
    // Scroll observer'ı temizle
    if (scrollObserver) {
        scrollObserver.disconnect();
        scrollObserver = null;
    }
    if (scrollUpdateTimer) {
        clearTimeout(scrollUpdateTimer);
        scrollUpdateTimer = null;
    }
    if (initialScrollTimeout) {
        clearTimeout(initialScrollTimeout);
        initialScrollTimeout = null;
    }
    if (manualPageChangeTimeout) {
        clearTimeout(manualPageChangeTimeout);
        manualPageChangeTimeout = null;
    }
    isInitialScroll = false;
    isManualPageChange = false;
    
    // State'i temizle
    pdfDoc = null;
    currentResourceId = null;
    // Bitmap önbelleklerini serbest bırak (GPU belleği)
    for (const pData of renderedPages) {
        if (pData && pData.renderedBitmap) {
            try { pData.renderedBitmap.close(); } catch (e) {}
        }
    }
    renderedPages = [];
    canvasPathOpenMap = new WeakMap();

    const wrapper = document.getElementById('pdf-pages-wrapper');
    if (wrapper) wrapper.innerHTML = '';
    
    // Background'da kaydet (non-blocking)
    try {
        await Promise.all([savePromise, pageSavePromise]);
        
        // DB'ye yaz (non-blocking)
        if (resourceId && pageNum) {
            try {
                updateResourceLastPage(resourceId, pageNum);
            } catch (err) {
                logger.warn('[closePDFViewer] Failed to update last page in DB:', err);
            }
        }
    } catch (err) {
        logger.warn('[closePDFViewer] Error during save:', err);
    }
}

// Sidepanel kapatılırken / görünmez olurken son sayfayı ve çizimleri kaydet
// PERFORMANS: toDataURL() senkron çağrısı main thread'i bloke eder.
// Sekme sadece gizleniyor (kapanmıyor), bu yüzden async save yeterli.
document.addEventListener('visibilitychange', () => {
    try {
        if (document.hidden && currentResourceId && currentPageNum) {
            // Son sayfa bilgisini hemen kaydet (zaten async, hafif)
            persistLastPageQuick(currentResourceId, currentPageNum);

            if (renderedPages.length > 0) {
                // PERFORMANS: toDataURL() çağrısını main thread'den ayır.
                // requestIdleCallback ile tarayıcı boşta olduğunda çalıştır,
                // fallback olarak setTimeout kullan.
                const pagesToSave = renderedPages.filter(
                    p => p && p.drawingCanvas && p.isRendered && p.hasChanges
                );
                if (pagesToSave.length === 0) return;

                const saveDeferred = () => {
                    pagesToSave.forEach(page => {
                        try {
                            const data = page.drawingCanvas.toDataURL('image/png', 0.9);
                            savePageAnnotation(currentResourceId, page.pageNum, data);
                            logger.log(`[Visibility] Saved page ${page.pageNum} drawing (deferred)`);
                        } catch (err) {
                            logger.warn(`[Visibility] Failed to save page ${page.pageNum}:`, err);
                        }
                    });
                };

                if (window.requestIdleCallback) {
                    requestIdleCallback(saveDeferred, { timeout: 1500 });
                } else {
                    setTimeout(saveDeferred, 0);
                }
            }
        }
    } catch (_) { /* ignore */ }
});

window.addEventListener('pagehide', () => {
    try {
        if (currentResourceId && currentPageNum) {
            persistLastPageQuick(currentResourceId, currentPageNum);
            // Panel kapanıyor: değişen sayfaları kaydet.
            // PERFORMANS: JPEG formatı PNG'den çok daha hızlı encode edilir.
            // Çizim verileri için kalite kaybı kabul edilebilir düzeyde.
            if (renderedPages.length > 0) {
                renderedPages.forEach(page => {
                    if (page && page.drawingCanvas && page.isRendered && page.hasChanges) {
                        try {
                            // JPEG ile hızlı encode: PNG ~300ms, JPEG ~50ms
                            const data = page.drawingCanvas.toDataURL('image/jpeg', 0.85);
                            savePageAnnotation(currentResourceId, page.pageNum, data);
                            logger.log(`[PageHide] Saved page ${page.pageNum} drawing (jpeg)`);
                        } catch (err) {
                            logger.warn(`[PageHide] Failed to save page ${page.pageNum}:`, err);
                        }
                    }
                });
            }
        }
    } catch (_) { /* ignore */ }
});

// beforeunload event - tarayıcı kapanmadan önce kaydet
window.addEventListener('beforeunload', () => {
    try {
        if (currentResourceId && renderedPages.length > 0) {
            // Synchronous save attempt (beforeunload'da async çalışmayabilir)
            renderedPages.forEach(page => {
                if (page && page.drawingCanvas && page.isRendered && page.hasChanges) {
                    try {
                        const data = page.drawingCanvas.toDataURL('image/png', 0.9);
                        // Synchronous storage write (beforeunload'da)
                        chrome.storage.local.set({
                            [`pdf_annotation_${currentResourceId}_${page.pageNum}`]: data
                        }).catch(() => {
                            // Fallback: try async save
                            savePageAnnotation(currentResourceId, page.pageNum, data);
                        });
                    } catch (err) {
                        logger.warn(`[BeforeUnload] Failed to save page ${page.pageNum}:`, err);
                    }
                }
            });
        }
    } catch (_) { /* ignore */ }
});

// --- Timer Logic ---
function startStudyTimer() {
    if (studyTimerInterval) return;
    const startBtn = document.getElementById('pdf-timer-start');
    if (startBtn) startBtn.textContent = 'Duraklat';

    studyTimerInterval = setInterval(() => {
        sessionSeconds++;
        updateTimerDisplay();
        if (sessionSeconds % 5 === 0) {
            appState.uncommitedTimes[`res_${currentResourceId}`] = sessionSeconds;
            persistState();
        }
    }, 1000);
}

function stopStudyTimer() {
    if (studyTimerInterval) {
        clearInterval(studyTimerInterval);
        studyTimerInterval = null;
    }
    document.getElementById('pdf-timer-start').textContent = 'Başlat';
}

function updateTimerDisplay() {
    const h = Math.floor(sessionSeconds / 3600);
    const m = Math.floor((sessionSeconds % 3600) / 60);
    const s = sessionSeconds % 60;
    const formatted = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    const el = document.getElementById('pdf-timer-display');
    if (el) el.textContent = formatted;
}

function commitSession() {
    if (!currentResourceId) return;
    if (sessionSeconds > 0 || sessionQCount > 0) {
        saveStudySession(`res_${currentResourceId}`, currentResourceSubject, sessionSeconds, sessionQCount);
        showToast(`${Math.floor(sessionSeconds / 60)} dk çalışma ve ${sessionQCount} soru kaydedildi.`);
        appState.uncommitedTimes[`res_${currentResourceId}`] = 0;
        persistState();
    }
    updateTimerDisplay();
    updateQuestionTotalDisplay();
}

function updateQuestionTotalDisplay() {
    const el = document.getElementById('pdf-question-total');
    if (!el || !currentResourceId) return;

    // PDF başlığındaki sayaç, bu kaynağa ait toplam ÇÖZÜLEN soru sayısını gösterir
    const stats = getTopicStudyStats(`res_${currentResourceId}`);
    const totalQuestions = stats.questions || 0;
    el.textContent = `✍️ ${totalQuestions}`;
}

// Global olarak erişilebilir yap (questions-manager'dan çağrılabilmesi için)
window.updateQuestionTotalDisplay = updateQuestionTotalDisplay;

let voiceRecordingSetupDone = false;

// --- Voice Recording Logic ---
const setupVoiceRecording = () => {
    if (voiceRecordingSetupDone) return;
    voiceRecordingSetupDone = true;

    // PDF kayıt çubuğundaki mikrofon listesini doldur
    populatePdfMicSelect();

    chrome.runtime.onMessage.addListener((message) => {
        if (message.target !== 'sidepanel') return;

        if (message.type === 'VOICE_NOTE_DATA') {
            // Study session kayıtları için değil, sadece PDF kayıtları için işle
            // Study session kayıtları study-session-manager.js'de işleniyor
            // Eğer activeRecordingTopicId varsa (study session kaydı), bu listener'ı atla
            if (window.activeRecordingTopicId) {
                return; // Study session kaydı, bu listener'ı atla
            }
            
            // Hedef kaynağı, kaydın başladığı resource'a göre belirle
            const targetResourceId = activeRecordingResourceId || currentResourceId;
            if (!targetResourceId) {
                logger.warn('[VoiceRecord][PDF] VOICE_NOTE_DATA but no active resource id.');
                showToast('Ses kaydı kaydedilemedi: Kaynak bilgisi bulunamadı.', 'error');
                return;
            }

            if (!message.data) {
                showToast('Hata: Ses verisi boş geldi.', 'error');
                return;
            }

            const resourceTopicId = `res_${targetResourceId}`;
            addVoiceNote(currentResourceSubject, resourceTopicId, message.data)
                .then(() => {
                    showToast(`Sesli not kaydedildi. (${currentResourceSubject})`);
                    
                    // Özet bölümünü yenile (knowledge base)
                    if (window.loadKnowledgeBase) {
                        window.loadKnowledgeBase();
                    }
                    
                    // Eğer bu kaynak için açık bir konu chat'i varsa, onu da yenile
                    if (window.studySessionManager && window.studySessionManager.currentStudyTopicId === resourceTopicId) {
                        if (window.studySessionManager.loadChatHistory) {
                            window.studySessionManager.loadChatHistory(resourceTopicId);
                        }
                    }
                    
                    // Ses kütüphanesini de yenile
                    if (window.loadVoiceLibrary) {
                        window.loadVoiceLibrary();
                    }
                    
                    // Clear recording ownership after successful save
                    activeRecordingResourceId = null;
                })
                .catch(err => {
                    logger.error('[VoiceRecord] Save failed:', err);
                    showToast('Ses kaydı hatası: ' + err.message, 'error');
                    // Clear ownership on error too
                    activeRecordingResourceId = null;
                });
        }
        else if (message.type === 'RECORDING_STARTED') {
            // RECORDING_STARTED geldiğinde activeRecordingResourceId'yi set et (eğer henüz set edilmemişse)
            if (!activeRecordingResourceId && currentResourceId) {
                activeRecordingResourceId = currentResourceId;
            }
            
            // Sadece aktif kaynağa ait mesajları işle
            if (activeRecordingResourceId !== currentResourceId) {
                return;
            }
            
            recordingStartTime = Date.now();
            recordingPaused = false;
            totalPausedTime = 0;
            
            const bar = document.getElementById('pdf-recording-bar');
            if (bar) {
                bar.classList.remove('hidden');
            }
            
            const pauseBtn = document.getElementById('pdf-pause-record');
            if (pauseBtn) {
                pauseBtn.innerHTML = '⏸️';
            }

            recordingTimer = setInterval(() => {
                if (recordingPaused) return;
                const elapsed = Math.floor((Date.now() - recordingStartTime - totalPausedTime) / 1000);
                const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
                const s = (elapsed % 60).toString().padStart(2, '0');
                const timeEl = document.getElementById('pdf-recording-time');
                if (timeEl) {
                    timeEl.textContent = `${m}:${s}`;
                }
            }, 1000);
        }
    });
};

async function startRecording() {
    // Eğer şu anda bir konu chat'inde (study session) aktif kayıt varsa, PDF tarafında yeni kayıt başlatma
    if (window.activeRecordingTopicId) {
        showToast('Konu notlarında devam eden bir ses kaydın var. Önce onu tamamla veya iptal et.', 'warning');
        return;
    }

    if (activeRecordingResourceId && activeRecordingResourceId !== currentResourceId) {
        showToast('Başka bir kaynakta devam eden kaydınız var.', 'warning');
        return;
    }

    activeRecordingResourceId = currentResourceId;

    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (existingContexts.length === 0) {
        await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['AUDIO_PLAYBACK', 'USER_MEDIA'],
            justification: 'Recording voice notes for study track.'
        });
    }

    const stored = await chrome.storage.local.get('preferredMicId');
    chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'START_RECORDING',
        micId: stored.preferredMicId
    });

    const micBtn = document.getElementById('pdf-mic-btn');
    if (micBtn) {
        micBtn.classList.add('recording');
    }
}

function stopRecordingAction(save) {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_RECORDING', save });
    if (recordingTimer) {
        clearInterval(recordingTimer);
        recordingTimer = null;
    }
    
    // Çubuk her zaman görünür kalsın; sadece süreyi ve buton durumlarını sıfırla
    const timeEl = document.getElementById('pdf-recording-time');
    if (timeEl) {
        timeEl.textContent = '00:00';
    }
    
    const micBtn = document.getElementById('pdf-mic-btn');
    if (micBtn) {
        micBtn.classList.remove('recording');
    }
    
    // Clear ownership only if not saving (if saving, VOICE_NOTE_DATA will handle it)
    if (!save) {
        activeRecordingResourceId = null;
    }
}

function togglePauseRecording() {
    const pauseBtn = document.getElementById('pdf-pause-record');
    if (!pauseBtn) return;
    
    if (!recordingPaused) {
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'PAUSE_RECORDING' });
        recordingPaused = true;
        pausedAt = Date.now();
        pauseBtn.innerHTML = '▶️';
    } else {
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'RESUME_RECORDING' });
        recordingPaused = false;
        totalPausedTime += (Date.now() - pausedAt);
        pauseBtn.innerHTML = '⏸️';
    }
}

// PDF kayıt barındaki mikrofon combobox'ını doldurur
async function populatePdfMicSelect() {
    const select = document.getElementById('pdf-mic-select');
    if (!select || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const allMics = devices.filter(d => d.kind === 'audioinput');

        // Aynı fiziksel cihaz için birden fazla giriş (iletişim / normal) gelebiliyor.
        // groupId varsa ona göre, yoksa deviceId'ye göre gruplayıp tek kayıt gösteriyoruz.
        const seen = new Set();
        const mics = [];
        allMics.forEach((mic) => {
            const key = mic.groupId || mic.deviceId;
            if (seen.has(key)) return;
            seen.add(key);
            mics.push(mic);
        });

        select.innerHTML = '<option value="">Varsayılan Mikrofon</option>';

        const stored = await chrome.storage.local.get('preferredMicId');
        const savedId = stored.preferredMicId || '';

        mics.forEach((mic, index) => {
            const opt = document.createElement('option');
            opt.value = mic.deviceId;
            opt.textContent = mic.label || `Mikrofon ${index + 1}`;
            if (mic.deviceId === savedId) opt.selected = true;
            select.appendChild(opt);
        });

        select.onchange = () => {
            chrome.storage.local.set({ preferredMicId: select.value });
        };
    } catch (err) {
        logger.error('Mikrofon listesi alınamadı:', err);
    }
}

// --- Screenshot Logic ---

function showCapturedImageModal(pngUrl, clipboardOk) {
    // Varsa eski modal kaldır
    const old = document.getElementById('pdf-capture-modal');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'pdf-capture-modal';
    overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(0,0,0,0.82);
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        padding: 16px; box-sizing: border-box;
    `;

    const msg = clipboardOk
        ? '✅ Görsel panoya kopyalandı! Gemini\'ye yapıştırabilirsiniz.<br><small style="opacity:.7">Veya aşağıdaki görsele uzun basarak kopyalayın</small>'
        : '📋 Görsele <b>uzun basın → Kopyala</b> seçin, ardından Gemini\'ye yapıştırın.';

    overlay.innerHTML = `
        <div style="max-width:90vw;max-height:80vh;display:flex;flex-direction:column;align-items:center;gap:12px;">
            <p style="color:#fff;font-size:0.95rem;text-align:center;margin:0;line-height:1.5;">${msg}</p>
            <img id="pdf-capture-img" src="${pngUrl}"
                style="max-width:88vw;max-height:64vh;object-fit:contain;border-radius:8px;border:2px solid rgba(255,255,255,0.25);background:#fff;touch-action:manipulation;">
            <button id="pdf-capture-close" style="
                margin-top:4px;padding:10px 32px;background:#6366f1;color:#fff;
                border:none;border-radius:8px;font-size:1rem;cursor:pointer;font-weight:600;">Kapat</button>
        </div>
    `;

    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.id === 'pdf-capture-close') overlay.remove();
    });
}

/**
 * Kopyalama kartı gösterir.
 *
 * Mimari kararlar:
 *  1. Buton handler'ı ASYNC DEĞİL — clipboard.write() kullanıcı gesturını
 *     kaybetmemek için senkron olarak başlatılır, .then()/.catch() ile yönetilir.
 *  2. Mobilde (Web Share destekleniyorsa) ÖNCE share API denenir —
 *     iOS'ta clipboard.write() ile image kopyalama güvenilir değil.
 *  3. Abort (share menüsü kapatma) = sessiz dismiss, hata gösterilmez.
 *  4. Her şey başarısız olursa görsel tam ekran gösterilir (uzun basarak kopyalama),
 *     Kapat butonu yok — dışarıya dokunmak kapatır.
 */
function showCopyCard(pngBlob, pngDataUrl) {
    const old = document.getElementById('pdf-copy-card');
    if (old) old.remove();

    // Animasyon (bir kez eklenir)
    if (!document.getElementById('pdf-copy-card-style')) {
        const style = document.createElement('style');
        style.id = 'pdf-copy-card-style';
        style.textContent = `
            @keyframes pdf-card-in {
                from { opacity:0; transform:translateX(-50%) translateY(14px); }
                to   { opacity:1; transform:translateX(-50%) translateY(0); }
            }
        `;
        document.head.appendChild(style);
    }

    const card = document.createElement('div');
    card.id = 'pdf-copy-card';
    card.style.cssText = `
        position:fixed; bottom:28px; left:50%;
        transform:translateX(-50%);
        background:#1e293b; border-radius:14px;
        padding:10px 14px; display:flex; align-items:center; gap:12px;
        z-index:99999; box-shadow:0 8px 32px rgba(0,0,0,0.5);
        max-width:88vw; animation:pdf-card-in 0.18s ease;
    `;

    const thumb = document.createElement('img');
    thumb.src = pngDataUrl;
    thumb.style.cssText = 'width:72px;height:52px;object-fit:contain;border-radius:6px;background:#fff;flex-shrink:0;';

    const btn = document.createElement('button');
    btn.textContent = '📋 Kopyala';
    btn.style.cssText = `
        background:#6366f1; color:#fff; border:none; border-radius:10px;
        padding:10px 22px; font-size:1rem; font-weight:700;
        cursor:pointer; white-space:nowrap; flex-shrink:0;
        -webkit-tap-highlight-color:transparent;
    `;

    const dismiss = () => {
        const c = document.getElementById('pdf-copy-card');
        if (c) c.remove();
    };

    // Son çare: görsel tam ekran göster, kullanıcı uzun basarak kopyalayabilir
    const showImageFallback = () => {
        dismiss();
        const ov = document.createElement('div');
        ov.id = 'pdf-copy-fallback';
        ov.style.cssText = `
            position:fixed; inset:0; z-index:99999;
            background:rgba(0,0,0,0.88);
            display:flex; flex-direction:column;
            align-items:center; justify-content:center; gap:14px;
            padding:20px; box-sizing:border-box;
        `;
        ov.innerHTML = `
            <p style="color:#fff;font-size:0.9rem;margin:0;text-align:center;opacity:.85;">
                Görsele <b>uzun basın → Kopyala</b> seçin
            </p>
            <img src="${pngDataUrl}"
                style="max-width:88vw;max-height:72vh;object-fit:contain;
                       border-radius:8px;background:#fff;touch-action:manipulation;">
            <p style="color:#aaa;font-size:0.75rem;margin:0;">Dışarıya dokunarak kapatın</p>
        `;
        document.body.appendChild(ov);
        setTimeout(() => {
            document.addEventListener('pointerdown', function closeOv(e) {
                const img = ov.querySelector('img');
                if (e.target === ov || (img && !img.contains(e.target))) {
                    ov.remove();
                    document.removeEventListener('pointerdown', closeOv);
                }
            });
        }, 300);
    };

    // ─── BUTON HANDLER (sync başlangıç — gesture bağlamı korunur) ───
    btn.addEventListener('click', () => {
        btn.style.opacity = '0.7';

        // Önce Clipboard API dene (iOS 16.4+, Chrome, Firefox, Edge)
        // Web Share ÖNCE denenmez — iOS share sheet "Kopyala" tıklandığında
        // görsel yerine title metnini panoya kopyalar.
        if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
            navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })])
                .then(() => {
                    dismiss();
                    showToast('Görsel panoya kopyalandı ✅');
                })
                .catch((err) => {
                    logger.warn('[PDF] Clipboard failed:', err.name, err.message);
                    // Clipboard başarısız → görsel tam ekran göster, uzun basarak kopyalansın
                    showImageFallback();
                });
            return;
        }

        // Clipboard API yoksa görsel tam ekran fallback
        showImageFallback();
    });

    card.appendChild(thumb);
    card.appendChild(btn);
    document.body.appendChild(card);

    // Kart dışına dokunulunca kapat
    let outListener;
    outListener = (e) => {
        if (!card.contains(e.target)) {
            dismiss();
            document.removeEventListener('pointerdown', outListener);
        }
    };
    setTimeout(() => document.addEventListener('pointerdown', outListener), 250);
}

async function captureScreenshot() {
    const x = Math.min(selectionStart.x, selectionEnd.x);
    const y = Math.min(selectionStart.y, selectionEnd.y);
    const w = Math.abs(selectionEnd.x - selectionStart.x);
    const h = Math.abs(selectionEnd.y - selectionStart.y);

    if (w < 10 || h < 10) return;

    const pageData = renderedPages.find(p => p.pageNum === selectionPageNum);
    if (!pageData) return;

    // We need to capture both the PDF and the drawing.
    // Easiest is to create a temp canvas
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });

    // Draw PDF page portion
    tempCtx.drawImage(pageData.renderCanvas, x, y, w, h, 0, 0, w, h);
    // Draw drawing layer portion
    tempCtx.drawImage(pageData.drawingCanvas, x, y, w, h, 0, 0, w, h);

    const base64 = tempCanvas.toDataURL('image/jpeg', 0.8);

    if (screenshotMode === 'note') {
        await addStudyNote(currentResourceSubject, `res_${currentResourceId}`, "", base64);
        showToast("Not olarak kaydedildi.");
    } else if (screenshotMode === 'question') {
        await addQuestion(currentResourceSubject, `res_${currentResourceId}`, base64);
        showToast("Soru olarak kaydedildi.");
        // Update question total display after adding question
        updateQuestionTotalDisplay();

        // Also add to chat if study session is active
        if (window.studySessionManager && window.studySessionManager.isActive) {
            window.studySessionManager.addMessageToChat('assistant', '', base64);
        }
    } else if (screenshotMode === 'gemini') {
        const pngBase64 = tempCanvas.toDataURL('image/png').split(',')[1];
        const bytes = Uint8Array.from(atob(pngBase64), c => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'image/png' });

        // Önce standart Clipboard API dene
        let copied = false;
        if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
            try {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                copied = true;
            } catch (err) {
                logger.warn('[PDF] Clipboard write failed:', err);
            }
        }

        // Clipboard başarısız olduysa (iOS/iPad gibi) → Web Share API dene
        if (!copied && navigator.share) {
            try {
                const file = new File([blob], 'gorsel.png', { type: 'image/png' });
                if (navigator.canShare && navigator.canShare({ files: [file] })) {
                    await navigator.share({ files: [file] });
                    showToast('Görsel paylaşım menüsü açıldı');
                    copied = true;
                }
            } catch (err) {
                if (err.name !== 'AbortError') logger.warn('[PDF] Share failed:', err);
            }
        }

        // Her iki yöntem de başarısız olduysa → resmi yeni sekmede aç
        if (!copied) {
            const dataUrl = tempCanvas.toDataURL('image/png');
            const win = window.open();
            if (win) {
                win.document.write(`<html><body style="margin:0;background:#000"><img src="${dataUrl}" style="max-width:100%;display:block"><p style="color:#fff;font-family:sans-serif;padding:8px">Görsele uzun basarak kaydet veya kopyala</p></body></html>`);
            } else {
                showToast('Panoya kopyalanamadı — tarayıcı izni gerekebilir', 'error');
            }
        }
    }
}

// Setup toolbar listeners
export function setupPDFDrawingListeners() {
    // Prevent duplicate listeners
    const overlay = document.getElementById('pdf-viewer-overlay');
    if (overlay.dataset.listenersAttached) return;
    overlay.dataset.listenersAttached = "true";

    // Color selection
    document.querySelectorAll('.pdf-color-dot').forEach(btn => {
        btn.addEventListener('click', (e) => {
            currentTool = 'pen';
            currentColor = e.target.dataset.color;
            updateToolsUI();
        });
    });

    // Color Picker - Position it near the button
    const colorPickerBtn = document.getElementById('pdf-color-picker-btn');
    const colorPickerInput = document.getElementById('pdf-color-picker-input');

    if (colorPickerBtn && colorPickerInput) {
        // Create a wrapper div for positioning
        const colorPickerWrapper = colorPickerBtn.closest('.color-picker-wrapper');
        if (colorPickerWrapper) {
            colorPickerWrapper.style.position = 'relative';
        }

        colorPickerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Position input near the button (left side)
            const btnRect = colorPickerBtn.getBoundingClientRect();
            const wrapperRect = colorPickerWrapper ? colorPickerWrapper.getBoundingClientRect() : btnRect;

            // Create a positioned container for the color picker
            let pickerContainer = document.getElementById('pdf-color-picker-container');
            if (!pickerContainer) {
                pickerContainer = document.createElement('div');
                pickerContainer.id = 'pdf-color-picker-container';
                pickerContainer.style.cssText = `
                    position: fixed;
                    z-index: 10020;
                    left: ${wrapperRect.left - 250}px;
                    top: ${wrapperRect.top}px;
                    background: #2d2d2d;
                    padding: 1rem;
                    border-radius: 8px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
                    border: 1px solid #3e3e3e;
                `;
                document.body.appendChild(pickerContainer);
            } else {
                pickerContainer.style.left = `${wrapperRect.left - 250}px`;
                pickerContainer.style.top = `${wrapperRect.top}px`;
            }

            // Move input to container or show it
            if (colorPickerInput.parentElement !== pickerContainer) {
                pickerContainer.innerHTML = '';
                const label = document.createElement('label');
                label.textContent = 'Renk Seç:';
                label.style.cssText = 'color: #e0e0e0; display: block; margin-bottom: 0.5rem; font-size: 0.85rem;';
                pickerContainer.appendChild(label);
                colorPickerInput.style.cssText = 'width: 100%; height: 40px; cursor: pointer;';
                pickerContainer.appendChild(colorPickerInput);
            }

            pickerContainer.style.display = 'block';

            // Close on outside click
            setTimeout(() => {
                const closePicker = (e) => {
                    if (!pickerContainer.contains(e.target) && e.target !== colorPickerBtn) {
                        pickerContainer.style.display = 'none';
                        document.removeEventListener('click', closePicker);
                    }
                };
                document.addEventListener('click', closePicker);
            }, 100);
        });

        colorPickerInput.addEventListener('change', (e) => {
            currentColor = e.target.value;
            currentTool = 'pen';
            updateToolsUI();
            const container = document.getElementById('pdf-color-picker-container');
            if (container) container.style.display = 'none';
        });
    }

    // Eraser
    document.getElementById('pdf-eraser')?.addEventListener('click', () => {
        currentTool = 'eraser';
        screenshotMode = null;
        updateToolsUI();
    });

    // Clipboard'dan görseli alıp soru olarak ekle
    async function pasteImageFromClipboard() {
        if (!currentResourceId) {
            showToast('PDF kaynağı bulunamadı.', 'error');
            return;
        }
        
        try {
            // Clipboard'dan görseli al
            const clipboardItems = await navigator.clipboard.read();
            
            let imageFound = false;
            for (const item of clipboardItems) {
                // Görsel tiplerini kontrol et
                const imageType = item.types.find(type => type.startsWith('image/'));
                if (imageType) {
                    const imageBlob = await item.getType(imageType);
                    
                    // Blob'u base64'e çevir
                    const reader = new FileReader();
                    reader.onloadend = async () => {
                        const base64 = reader.result;
                        
                        // Mevcut PDF kaynağına soru olarak ekle
                        await addQuestion(currentResourceSubject, `res_${currentResourceId}`, base64);
                        showToast('Görsel soru olarak eklendi!', 'success');
                        
                        // Soru sayacını güncelle
                        updateQuestionTotalDisplay();
                    };
                    reader.readAsDataURL(imageBlob);
                    imageFound = true;
                    break;
                }
            }
            
            if (!imageFound) {
                showToast('Kopyala hafızasında görsel bulunamadı. Lütfen önce bir görsel kopyalayın.', 'warning');
            }
        } catch (err) {
            // Clipboard API erişim hatası veya görsel yok
            if (err.name === 'NotAllowedError') {
                showToast('Kopyala hafızasına erişim izni verilmedi. Lütfen izin verin.', 'error');
            } else {
                showToast('Kopyala hafızasında görsel bulunamadı veya erişilemedi.', 'warning');
            }
            logger.warn('[PDF] Clipboard read error:', err);
        }
    }
    
    // Manual Question Add Button - Clipboard'dan görseli otomatik ekle
    document.getElementById('pdf-manual-question')?.addEventListener('click', pasteImageFromClipboard);

    // Hand tool
    document.getElementById('pdf-hand')?.addEventListener('click', () => {
        currentTool = 'hand';
        screenshotMode = null;
        updateToolsUI();
    });

    // Pen
    document.getElementById('pdf-pen')?.addEventListener('click', () => {
        currentTool = 'pen';
        screenshotMode = null;
        updateToolsUI();
    });

    // Optik form paneli aç/kapat
    const opticToggleBtn = document.getElementById('pdf-optic-toggle');
    if (opticToggleBtn) {
        opticToggleBtn.addEventListener('click', () => {
            toggleOpticPanel();
        });
    }

    // Screenshots


    // Timer
    document.getElementById('pdf-timer-start')?.addEventListener('click', () => {
        if (studyTimerInterval) stopStudyTimer();
        else startStudyTimer();
    });
    document.getElementById('pdf-timer-stop')?.addEventListener('click', async () => {
        try {
            // Commit session but don't reset timer - just save and close
            if (currentResourceId) {
                commitSession();
            }
            await closePDFViewer();
            // Switch to today tab
            const todayTabBtn = document.querySelector('.nav-btn[data-tab="today-tab"]');
            if (todayTabBtn) {
                todayTabBtn.click();
            }
        } catch (error) {
            logger.error('Error in PDF stop button:', error);
            // Still close the viewer even if commit fails
            await closePDFViewer();
            const todayTabBtn = document.querySelector('.nav-btn[data-tab="today-tab"]');
            if (todayTabBtn) {
                todayTabBtn.click();
            }
        }
    });

    document.getElementById('pdf-question-add')?.addEventListener('click', () => {
        const input = document.getElementById('pdf-question-input');
        const val = parseInt(input.value);
        if (val > 0 && currentResourceId) {
            // Just track the count - questions are added via screenshot, not here
            // This is just a counter for manual entry
            sessionQCount += val;
            // Save to study session immediately
            saveStudySession(`res_${currentResourceId}`, currentResourceSubject, 0, val);
            // Update display - this will show total from DB
            updateQuestionTotalDisplay();
            input.value = '';
            showToast(`${val} soru sayısı eklendi`);
        }
    });

    // Mic (üstteki ikon – artık opsiyonel, sadece fallback)
    document.getElementById('pdf-mic-btn')?.addEventListener('click', () => {
        startRecording();
    });

    // Kayıt kontrol butonları (alttaki bar)
    document.getElementById('pdf-start-record')?.addEventListener('click', () => {
        startRecording();
    });
    document.getElementById('pdf-pause-record')?.addEventListener('click', togglePauseRecording);

    // El aracı kaydırma hızı slider'ı (soru panelindeki kontrol)
    const handSpeedSlider = document.getElementById('hand-scroll-speed');
    const handSpeedValue = document.getElementById('hand-scroll-speed-value');
    if (handSpeedSlider) {
        // İlk değer
        const initial = parseFloat(handSpeedSlider.value);
        if (!Number.isNaN(initial)) {
            handScrollSpeed = initial;
            if (handSpeedValue) handSpeedValue.textContent = `${handScrollSpeed.toFixed(1)}x`;
        }

        handSpeedSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            if (Number.isNaN(val)) return;
            handScrollSpeed = val;
            if (handSpeedValue) handSpeedValue.textContent = `${handScrollSpeed.toFixed(1)}x`;
            // Kaydırma hızını kalıcı yap
            saveDrawingSettings();
        });
    }

    // --- Klavye Kısayolları ---
    // E: kalem <-> silgi, H: kalem <-> el (toggle), Ctrl+V: Clipboard'dan görsel yapıştır
    window.addEventListener('keydown', (e) => {
        const overlayEl = document.getElementById('pdf-viewer-overlay');
        if (!overlayEl || overlayEl.classList.contains('hidden')) return;
        if (screenshotMode) return;
        if (e.repeat) return; // basılı tutma tekrarlarını yok say

        // Ctrl+V veya Cmd+V: Clipboard'dan görsel yapıştır
        if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
            // Input alanında değilse (modal, textarea, input vb.)
            const activeElement = document.activeElement;
            if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable)) {
                return; // Normal yapıştırma davranışına izin ver
            }
            e.preventDefault();
            pasteImageFromClipboard();
            return;
        }

        if (e.key === 'e' || e.key === 'E') {
            // Eğer şu an silgiyse kaleme, değilse silgiye geç
            currentTool = (currentTool === 'eraser') ? 'pen' : 'eraser';
            screenshotMode = null;
            updateToolsUI();
        } else if (e.key === 'h' || e.key === 'H') {
            // Eğer şu an el modundaysa kaleme, değilse el moduna geç
            currentTool = (currentTool === 'hand') ? 'pen' : 'hand';
            screenshotMode = null;
            updateToolsUI();
        }
    });

    document.getElementById('pdf-cancel-record')?.addEventListener('click', () => stopRecordingAction(false));
    document.getElementById('pdf-send-record')?.addEventListener('click', () => stopRecordingAction(true));

    // PDF Notes Panel
    const pdfNoteInput = document.getElementById('pdf-note-input');
    const pdfNoteSendBtn = document.getElementById('pdf-note-send');

    const sendPDFNote = async () => {
        const text = pdfNoteInput?.value.trim();
        if (text && currentResourceId) {
            await addStudyNote(currentResourceSubject, `res_${currentResourceId}`, text, null);
            showToast('Not eklendi');
            if (pdfNoteInput) pdfNoteInput.value = '';
        }
    };

    if (pdfNoteSendBtn) {
        pdfNoteSendBtn.addEventListener('click', sendPDFNote);
    }

    if (pdfNoteInput) {
        pdfNoteInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendPDFNote();
            }
        });
    }

    // Size Sliders
    const penSizeSlider = document.getElementById('pdf-pen-size');
    const penSizeDisplay = document.getElementById('pdf-pen-size-display');
    const eraserSizeSlider = document.getElementById('pdf-eraser-size');
    const eraserSizeDisplay = document.getElementById('pdf-eraser-size-display');
    const zoomInput = document.getElementById('pdf-zoom-input');

    if (penSizeSlider && penSizeDisplay) {
        penSizeSlider.addEventListener('input', (e) => {
            currentSize = parseInt(e.target.value);
            penSizeDisplay.textContent = `${currentSize}px`;
            saveDrawingSettings();
        });
    }

    if (eraserSizeSlider && eraserSizeDisplay) {
        eraserSizeSlider.addEventListener('input', (e) => {
            eraserSize = parseInt(e.target.value);
            eraserSizeDisplay.textContent = `${eraserSize}px`;
            saveDrawingSettings();
        });
    }

    if (zoomInput) {
        const applyMainZoom = () => {
            let val = parseInt(zoomInput.value);
            if (isNaN(val)) return;
            if (val < 50) val = 50;
            if (val > 300) val = 300;
            zoomInput.value = val;
            currentScale = val / 100;
            updateZoomDisplay();

            // Yakınlaştırmayı kalıcı hale getir (her PDF için ayrı)
            saveZoomSetting(currentResourceId);

            // KRİTİK: Yakınlaştırma sonrası sayfa pozisyonunu koru
            const savedPage = currentPageNum;
            if (renderTimeout) clearTimeout(renderTimeout);
            renderTimeout = setTimeout(async () => {
                const container = document.getElementById('pdf-pages-container');
                
                // Tüm sayfaları yeniden render et
                await renderAllPages();
                
                // Sayfa pozisyonunu koru
                if (container) {
                    // Önce hedef sayfaya scroll yap
                    await scrollToPage(savedPage, true);
                    // Scroll listener'ı ignore et (manuel sayfa değişikliği gibi)
                    setTimeout(() => {
                        scrollToPage(savedPage, true);
                    }, 200);
                }
            }, 100);
        };
        zoomInput.addEventListener('change', applyMainZoom);
        zoomInput.addEventListener('blur', applyMainZoom);
        zoomInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); zoomInput.blur(); }
        });
    }

    // Close button
    document.getElementById('close-pdf-btn')?.addEventListener('click', async () => {
        await closePDFViewer();
    });

    // Üst menü göster/gizle butonu
    const headerToggleBtn = document.getElementById('pdf-header-toggle-btn');
    if (headerToggleBtn) {
        headerToggleBtn.addEventListener('click', () => {
            const focusPanel = document.getElementById('daily-focus-panel');
            const overlay = document.getElementById('pdf-viewer-overlay');
            if (!focusPanel || !overlay) return;
            const isHidden = focusPanel.style.display === 'none';
            if (isHidden) {
                focusPanel.style.display = '';
                overlay.style.top = '';
                overlay.style.height = '';
                headerToggleBtn.title = 'Üst Menüyü Gizle';
                headerToggleBtn.classList.remove('active');
            } else {
                focusPanel.style.display = 'none';
                overlay.style.top = '0';
                overlay.style.height = '100%';
                headerToggleBtn.title = 'Üst Menüyü Göster';
                headerToggleBtn.classList.add('active');
            }
        });
    }

    // Sayfa numarası girişi - tıklanabilir sayfa göstergesi
    const pageIndicator = document.getElementById('current-page-indicator');
    if (pageIndicator) {
        let isEditing = false;
        let originalValue = '';

        pageIndicator.addEventListener('click', () => {
            if (isEditing || !pdfDoc) return;
            
            isEditing = true;
            originalValue = pageIndicator.textContent;
            pageIndicator.contentEditable = 'true';
            pageIndicator.style.background = 'rgba(255, 255, 255, 0.2)';
            pageIndicator.style.padding = '2px 6px';
            pageIndicator.style.borderRadius = '4px';
            pageIndicator.style.outline = '2px solid #3b82f6';
            pageIndicator.focus();
            
            // Tüm metni seç
            const range = document.createRange();
            range.selectNodeContents(pageIndicator);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        });

        pageIndicator.addEventListener('blur', () => {
            if (!isEditing) return;
            
            isEditing = false;
            pageIndicator.contentEditable = 'false';
            pageIndicator.style.background = '';
            pageIndicator.style.padding = '';
            pageIndicator.style.borderRadius = '';
            pageIndicator.style.outline = '';

            const newPageNum = parseInt(pageIndicator.textContent.trim());
            const totalPages = pdfDoc ? pdfDoc.numPages : 0;

            if (newPageNum && !isNaN(newPageNum) && newPageNum >= 1 && newPageNum <= totalPages) {
                if (newPageNum !== currentPageNum) {
                    currentPageNum = newPageNum;
                    // Manuel sayfa değişikliği - scroll listener'ı ignore et
                    scrollToPage(newPageNum, true);
                    try {
                        updateResourceLastPage(currentResourceId, newPageNum);
                    } catch (err) {
                        logger.warn('[PDF] Failed to update last page:', err);
                    }
                    schedulePersistLastPage(currentResourceId, newPageNum);
                    // Kullanıcı aktivitesini kaydet (sayfa numarası değişikliği)
                    recordUserActivity();
                }
            } else {
                // Geçersiz sayfa numarası, eski değere geri dön
                pageIndicator.textContent = originalValue;
                showToast('Geçersiz sayfa numarası!', 'error');
            }
        });

        pageIndicator.addEventListener('keydown', (e) => {
            if (!isEditing) return;
            
            if (e.key === 'Enter') {
                e.preventDefault();
                pageIndicator.blur();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                pageIndicator.textContent = originalValue;
                pageIndicator.blur();
            }
        });
    }

    setupVoiceRecording();
    setupScreenshotListeners();

    // Stylus / orta tıklama ile Kalem <-> El geçişi
    const pagesContainer = document.getElementById('pdf-pages-container');
    if (pagesContainer) {
        pagesContainer.addEventListener('mousedown', (e) => {
            // Orta tuş (button === 1) ile araç değiştir
            if (e.button === 1) {
                currentTool = (currentTool === 'hand') ? 'pen' : 'hand';
                updateToolsUI();
                e.preventDefault();
            }
        });
    }

    // PDF Hizalama butonları
    document.querySelectorAll('.pdf-align-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.align;
            if (mode) {
                applyAlignMode(mode);
                saveAlignSetting(currentResourceId);
            }
        });
    });

    // Kağıt/Kitap Modu toggle
    document.getElementById('pdf-paper-mode-toggle')?.addEventListener('click', () => {
        applyPaperMode(!paperModeEnabled);
        savePaperModeSetting();
    });

    // 2. PDF Popup toggle
    const secondaryToggleFn = async () => {
        if (secondaryPopupVisible) {
            closeSecondaryPopup();
        } else {
            await openSecondaryPopup();
        }
    };
    document.getElementById('pdf-secondary-toggle')?.addEventListener('click', secondaryToggleFn);
    document.getElementById('toolbar-2p-btn')?.addEventListener('click', secondaryToggleFn);

    // 2. PDF Popup - sayfa navigasyonu
    document.getElementById('pdf-secondary-prev')?.addEventListener('click', () => {
        if (secondaryCurrentPage > 1) {
            scrollSecondaryToPage(secondaryCurrentPage - 1);
            saveSecondaryState(currentResourceId);
        }
    });

    document.getElementById('pdf-secondary-next')?.addEventListener('click', () => {
        if (pdfDoc && secondaryCurrentPage < pdfDoc.numPages) {
            scrollSecondaryToPage(secondaryCurrentPage + 1);
            saveSecondaryState(currentResourceId);
        }
    });

    // 2. PDF Popup - kapat butonu
    document.getElementById('pdf-secondary-close')?.addEventListener('click', () => {
        closeSecondaryPopup();
    });

    // 2. PDF Popup sürükleme kurulumu
    setupSecondaryPopupDrag();

    // Gemini Chat popup kurulumu
    setupGeminiListeners();

    // Sol bar sürükleme ve araç toggle kurulumu
    setupToolbarDrag();
    setupToolbarToolsToggle();
    setupKronometer();

    // Not paneli kurulumu
    setupNotesListeners();
}

function setupScreenshotListeners() {
    const btnNote = document.getElementById('pdf-screenshot-note');
    const btnQuestion = document.getElementById('pdf-screenshot-question');
    const btnContinuous = document.getElementById('pdf-continuous-mode');

    if (btnNote) {
        btnNote.addEventListener('click', () => {
            screenshotMode = screenshotMode === 'note' ? null : 'note';
            updateToolsUI();
            showToast(screenshotMode ? 'Not alma modu: Alan seçin' : 'Mod kapatıldı');
        });
    }

    if (btnQuestion) {
        btnQuestion.addEventListener('click', () => {
            screenshotMode = screenshotMode === 'question' ? null : 'question';
            updateToolsUI();
            showToast(screenshotMode ? 'Soru ekleme modu: Alan seçin' : 'Mod kapatıldı');
        });
    }

    if (btnContinuous) {
        btnContinuous.addEventListener('click', () => {
            continuousMode = !continuousMode;
            updateToolsUI();
            showToast(continuousMode ? 'Sürekli mod: Açık' : 'Sürekli mod: Kapalı');
        });
    }

    // Selection overlay logic
    document.addEventListener('pointerdown', (e) => {
        if (!screenshotMode) return;
        const target = e.target;
        if (!target.classList.contains('pdf-drawing-layer')) return;

        isSelecting = true;
        selectionPageNum = parseInt(target.closest('.pdf-page-container').dataset.pageNum);
        // Cache canvas rect for performance
        const rect = target.getBoundingClientRect();
        selectionCanvasRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        selectionStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };

        // Use active canvas for overlay drawing
        activeCanvas = target;
        selectionOverlay = document.createElement('div');
        selectionOverlay.className = 'selection-overlay';
        selectionOverlay.style.position = 'absolute';
        selectionOverlay.style.border = '2px dashed #2196F3';
        selectionOverlay.style.backgroundColor = 'rgba(33, 150, 243, 0.2)';
        selectionOverlay.style.left = selectionStart.x + 'px';
        selectionOverlay.style.top = selectionStart.y + 'px';
        selectionOverlay.style.width = '0px';
        selectionOverlay.style.height = '0px';
        selectionOverlay.style.pointerEvents = 'none';
        target.parentElement.appendChild(selectionOverlay);
    });

    document.addEventListener('pointermove', (e) => {
        if (!isSelecting || !selectionOverlay || !activeCanvas || !selectionCanvasRect) return;
        // Use cached rect for better performance
        const currentX = e.clientX - selectionCanvasRect.left;
        const currentY = e.clientY - selectionCanvasRect.top;

        const width = Math.abs(currentX - selectionStart.x);
        const height = Math.abs(currentY - selectionStart.y);
        const left = Math.min(currentX, selectionStart.x);
        const top = Math.min(currentY, selectionStart.y);

        selectionOverlay.style.width = width + 'px';
        selectionOverlay.style.height = height + 'px';
        selectionOverlay.style.left = left + 'px';
        selectionOverlay.style.top = top + 'px';

        selectionEnd = { x: currentX, y: currentY };
    });

    document.addEventListener('pointerup', async (e) => {
        if (!isSelecting) return;
        isSelecting = false;

        if (!selectionOverlay) return;

        // Remove overlay
        const parent = selectionOverlay.parentElement;
        if (parent) parent.removeChild(selectionOverlay);
        selectionOverlay = null;

        // Verify min size
        const width = Math.abs(selectionEnd.x - selectionStart.x);
        const height = Math.abs(selectionEnd.y - selectionStart.y);

        if (width < 10 || height < 10) {
            return;
        }

        // Capture logic
        if (activeCanvas && selectionPageNum) {
            const renderCanvas = activeCanvas.previousElementSibling; // render canvas is before drawing canvas
            if (renderCanvas && renderCanvas.tagName === 'CANVAS') {
                // Use cached rect if available, otherwise fallback to getBoundingClientRect
                const canvasDisplayW = selectionCanvasRect ? selectionCanvasRect.width : activeCanvas.getBoundingClientRect().width;
                const canvasDisplayH = selectionCanvasRect ? selectionCanvasRect.height : activeCanvas.getBoundingClientRect().height;
                // Scale factor: internal canvas pixels vs display CSS pixels (Retina/HiDPI = 2x or 3x)
                const scaleX = renderCanvas.width / canvasDisplayW;
                const scaleY = renderCanvas.height / (canvasDisplayH || canvasDisplayW);

                // Convert display-space selection to canvas internal pixel space
                const sourceX = Math.round(Math.min(selectionStart.x, selectionEnd.x) * scaleX);
                const sourceY = Math.round(Math.min(selectionStart.y, selectionEnd.y) * scaleY);
                const srcW = Math.round(width * scaleX);
                const srcH = Math.round(height * scaleY);

                // Create temp canvas to crop (full internal resolution)
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = srcW;
                tempCanvas.height = srcH;
                const ctx = tempCanvas.getContext('2d', { willReadFrequently: true });

                ctx.drawImage(renderCanvas, sourceX, sourceY, srcW, srcH, 0, 0, srcW, srcH);
                // Also draw drawings layer
                ctx.drawImage(activeCanvas, sourceX, sourceY, srcW, srcH, 0, 0, srcW, srcH);

                const dataUrl = tempCanvas.toDataURL('image/jpeg', 0.8);

                if (screenshotMode === 'gemini') {
                    // PNG blob'unu SENKRON oluştur
                    const pngDataUrl = tempCanvas.toDataURL('image/png');
                    const arr2 = pngDataUrl.split(',');
                    const bstr2 = atob(arr2[1]);
                    const u8arr2 = new Uint8Array(bstr2.length);
                    for (let i = 0; i < bstr2.length; i++) u8arr2[i] = bstr2.charCodeAt(i);
                    const pngBlob = new Blob([u8arr2], { type: 'image/png' });

                    // Küçük kopyala kartı göster — kullanıcı butona basınca kopyalar ve kapanır
                    showCopyCard(pngBlob, pngDataUrl);
                } else if (screenshotMode === 'question') {
                    // Sadece soru kaydı ekle; toplam soru sayacı kullanıcı tarafından manuel giriliyor
                    await addQuestion(currentResourceSubject, `res_${currentResourceId}`, dataUrl);
                    showToast('Soru eklendi!', 'success');
                } else {
                    // Add Note
                    await addStudyNote(currentResourceSubject, `res_${currentResourceId}`, '', dataUrl);
                    showToast('Görüntülü not eklendi!', 'success');
                }

                // Reset mode - sürekli mod açık değilse
                if (!continuousMode) {
                    screenshotMode = null;
                }
                selectionCanvasRect = null; // Clear cache
                updateToolsUI();
            }
        }
        // Clear cache when selection ends
        selectionCanvasRect = null;
    });
}

// Load drawing settings from storage
async function loadDrawingSettings() {
    const stored = await chrome.storage.local.get('pdfDrawingSettings');
    if (stored.pdfDrawingSettings) {
        const settings = stored.pdfDrawingSettings;
        currentTool = settings.lastTool || 'pen';
        currentColor = settings.lastColor || '#ff0000';
        currentSize = settings.penSize || 2;
        eraserSize = settings.eraserSize || 20;
        handScrollSpeed = settings.handScrollSpeed || 1;

        // Update UI elements
        const penSizeSlider = document.getElementById('pdf-pen-size');
        const penSizeDisplay = document.getElementById('pdf-pen-size-display');
        const eraserSizeSlider = document.getElementById('pdf-eraser-size');
        const eraserSizeDisplay = document.getElementById('pdf-eraser-size-display');
        const handSpeedSlider = document.getElementById('hand-scroll-speed');
        const handSpeedValue = document.getElementById('hand-scroll-speed-value');

        if (penSizeSlider) penSizeSlider.value = currentSize;
        if (penSizeDisplay) penSizeDisplay.textContent = `${currentSize}px`;
        if (eraserSizeSlider) eraserSizeSlider.value = eraserSize;
        if (eraserSizeDisplay) eraserSizeDisplay.textContent = `${eraserSize}px`;

        if (handSpeedSlider) {
            // El aracı varsayılan 3x, max 5x olacak şekilde clamp et
            const clamped = Math.min(5, Math.max(0.5, handScrollSpeed || 3));
            handScrollSpeed = clamped;
            handSpeedSlider.min = "0.5";
            handSpeedSlider.max = "5";
            handSpeedSlider.step = "0.1";
            handSpeedSlider.value = clamped;
        }
        if (handSpeedValue) {
            handSpeedValue.textContent = `${handScrollSpeed.toFixed(1)}x`;
        }

        // Color picker sync
        const colorPickerInput = document.getElementById('pdf-color-picker-input');
        if (colorPickerInput) colorPickerInput.value = currentColor;
    }
    
    // İlk açılışta cursor'u güncelle
    updateToolsUI();
}

// Save drawing settings to storage
async function saveDrawingSettings() {
    await chrome.storage.local.set({
        pdfDrawingSettings: {
            penSize: currentSize,
            eraserSize: eraserSize,
            lastTool: currentTool,
            lastColor: currentColor,
            handScrollSpeed: handScrollSpeed
        }
    });
}

function updateToolsUI() {
    document.querySelectorAll('.pdf-color-dot').forEach(el => {
        el.classList.toggle('active', el.dataset.color === currentColor && currentTool === 'pen' && !screenshotMode);
    });

    const eraser = document.getElementById('pdf-eraser');
    if (eraser) eraser.classList.toggle('active', currentTool === 'eraser');

    const pen = document.getElementById('pdf-pen');
    if (pen) pen.classList.toggle('active', currentTool === 'pen');

    const hand = document.getElementById('pdf-hand');
    if (hand) hand.classList.toggle('active', currentTool === 'hand');

    document.getElementById('pdf-screenshot-note')?.classList.toggle('active', screenshotMode === 'note');
    document.getElementById('pdf-screenshot-question')?.classList.toggle('active', screenshotMode === 'question');
    document.getElementById('pdf-gemini-capture')?.classList.toggle('active', screenshotMode === 'gemini');
    document.getElementById('toolbar-gemini-btn')?.classList.toggle('active', screenshotMode === 'gemini');

    const continuousBtn = document.getElementById('pdf-continuous-mode');
    if (continuousBtn) {
        continuousBtn.classList.toggle('active', continuousMode);
        continuousBtn.setAttribute('data-text', continuousMode ? 'Açık' : 'Kapalı');
    }

    document.getElementById('pdf-color-picker-btn')?.classList.toggle('active', currentTool === 'pen' && !screenshotMode);

    // Save settings when tool/color changes
    saveDrawingSettings();

    // Update cursor classes on all page containers
    const pageContainers = document.querySelectorAll('.pdf-page-container');
    pageContainers.forEach(container => {
        container.classList.toggle('pen-active', currentTool === 'pen' && !screenshotMode);
        container.classList.toggle('eraser-active', currentTool === 'eraser');
        container.classList.toggle('hand-active', currentTool === 'hand');
    });
}

// Sayfa görünürlüğü değiştiğinde boş sayfaları tekrar render et
function setupVisibilityHandler() {
    let wasHidden = false;
    let visibilityCheckInterval = null;

    // Anlık geri yükleme: ImageBitmap önbellekten tüm render canvas'larını yenile
    // Bu senkron ve µs cinsinden hızlıdır — PDF.js'i tekrar çalıştırmaya gerek yok
    function restoreAllCanvasesFromBitmap() {
        let restored = 0;
        let needsRerender = 0;
        for (const pData of renderedPages) {
            if (!pData || !pData.isRendered || !pData.renderCanvas) continue;
            if (pData.renderedBitmap) {
                try {
                    const ctx = pData.renderCanvas.getContext('2d');
                    ctx.drawImage(pData.renderedBitmap, 0, 0);
                    restored++;
                } catch (e) {
                    // Canvas erişilemiyorsa lazy loading'e bırak
                    pData.isRendered = false;
                    needsRerender++;
                }
            } else {
                // Bitmap önbelleği yoksa lazy loading'in yeniden render etmesini sağla
                pData.isRendered = false;
                needsRerender++;
            }
        }
        logger.log(`[Visibility] Bitmap restore: ${restored} restored, ${needsRerender} need re-render`);
        return restored;
    }

    // PDF render canvas'ının boş olup olmadığını kontrol et
    // KRİTİK: Sadece görünür sayfaları değil, TÜM render edilmiş sayfaları kontrol et
    // Çünkü tarayıcı arka planda tüm canvas'ları temizleyebilir
    async function checkAndRestorePDFCanvas() {
        if (!pdfDoc || renderedPages.length === 0) return;
        
        const container = document.getElementById('pdf-pages-container');
        if (!container) return;
        
        // TÜM render edilmiş sayfaları kontrol et (sadece görünür olanları değil)
        // Çünkü kullanıcı scroll yapabilir ve görünür olmayan sayfalar da kaybolmuş olabilir
        const pagesToCheck = [];
        renderedPages.forEach(pData => {
            if (pData.isRendered && pData.renderCanvas) {
                const rect = pData.pageContainer.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();
                const isVisible = rect.top < containerRect.bottom && rect.bottom > containerRect.top;
                
                // Görünür sayfaları öncelikli kontrol et, ama görünür olmayanları da kontrol et
                pagesToCheck.push({ pData, isVisible, priority: isVisible ? 1 : 2 });
            }
        });
        
        // Önce görünür sayfaları kontrol et, sonra diğerlerini
        pagesToCheck.sort((a, b) => a.priority - b.priority);
        
        // Async işlemler için for...of kullan
        for (const { pData, isVisible } of pagesToCheck) {
            const renderCanvas = pData.renderCanvas;
            
            // Canvas boyutu kontrolü
            if (!renderCanvas.width || !renderCanvas.height) {
                logger.warn(`[Visibility] Canvas ${pData.pageNum} has no size, re-rendering...`);
                pData.isRendered = false;
                renderPage(pData.pageNum);
                return;
            }
            
            // Canvas'ın DOM'da olup olmadığını kontrol et
            if (!renderCanvas.parentElement) {
                logger.warn(`[Visibility] Canvas ${pData.pageNum} lost from DOM, re-rendering...`);
                pData.isRendered = false;
                renderPage(pData.pageNum);
                return;
            }
            
            // PDF render canvas'ının içeriğini kontrol et (beyaz sayfa sorunu)
            // PERFORMANS: Sadece görünür sayfalar için detaylı kontrol yap
            if (isVisible) {
                try {
                    const ctx = renderCanvas.getContext('2d', { willReadFrequently: true });
                    // Daha büyük bir örnek al (200x200) - daha güvenilir kontrol
                    const sampleSize = Math.min(200, Math.min(renderCanvas.width, renderCanvas.height));
                    const imageData = ctx.getImageData(0, 0, sampleSize, sampleSize);
                    
                    // Canvas'ın tamamen beyaz olup olmadığını kontrol et
                    // (PDF render edilmişse bazı piksel renkli olmalı)
                    let hasNonWhitePixels = false;
                    let checkedPixels = 0;
                    const maxCheck = Math.min(imageData.data.length / 4, 10000); // Max 10000 piksel kontrol et
                    
                    for (let i = 0; i < imageData.data.length && checkedPixels < maxCheck; i += 4) {
                        const r = imageData.data[i];
                        const g = imageData.data[i + 1];
                        const b = imageData.data[i + 2];
                        const a = imageData.data[i + 3];
                        
                        // Alpha > 0 ve tamamen beyaz değilse (biraz tolerans)
                        if (a > 0 && !(r > 250 && g > 250 && b > 250)) {
                            hasNonWhitePixels = true;
                            break;
                        }
                        checkedPixels++;
                    }
                    
                    // Eğer canvas tamamen boşsa ve PDF render edilmiş olmalıysa, geri yükle
                    if (!hasNonWhitePixels && pData.isRendered) {
                        logger.warn(`[Visibility] Canvas ${pData.pageNum} appears empty, restoring...`);

                        // ÖNCE: ImageBitmap önbelleğinden anlık geri yükle (ms cinsinden hızlı)
                        if (pData.renderedBitmap) {
                            try {
                                const ctx = renderCanvas.getContext('2d');
                                ctx.drawImage(pData.renderedBitmap, 0, 0);
                                logger.log(`[Visibility] Page ${pData.pageNum} restored from bitmap cache instantly`);
                                continue; // Bitmap restore başarılı, PDF.js'e gerek yok
                            } catch (bitmapErr) {
                                logger.warn(`[Visibility] Bitmap restore failed for page ${pData.pageNum}:`, bitmapErr);
                            }
                        }

                        // FALLBACK: PDF.js ile tam yeniden render (bitmap yoksa)
                        // KRİTİK: Çizim canvas'ını koru - önce kaydet
                        let savedDrawing = null;
                        if (pData.drawingCanvas && pData.drawingCanvas.parentElement) {
                            try {
                                savedDrawing = pData.drawingCanvas.toDataURL('image/png', 0.9);
                            } catch (err) {
                                logger.warn(`[Visibility] Failed to save drawing for page ${pData.pageNum}:`, err);
                            }
                        }
                        pData.isRendered = false;
                        await renderPage(pData.pageNum);
                        // Çizim canvas'ını geri yükle
                        if (savedDrawing && pData.drawingCanvas) {
                            const ctx = pData.drawingCanvas.getContext('2d', { willReadFrequently: true });
                            const img = new Image();
                            img.src = savedDrawing;
                            img.onload = () => {
                                ctx.globalCompositeOperation = 'source-over';
                                ctx.imageSmoothingEnabled = true;
                                ctx.imageSmoothingQuality = 'high';
                                ctx.drawImage(img, 0, 0, pData.drawingCanvas.width, pData.drawingCanvas.height);
                                pData.hasChanges = true;
                                logger.log(`[Visibility] Restored drawing for page ${pData.pageNum} after PDF.js re-render`);
                            };
                        }
                    }
                } catch (err) {
                    // getImageData hata verirse (CORS, vb.), canvas boyutuna göre karar ver
                    logger.warn(`[Visibility] Canvas ${pData.pageNum} check failed:`, err);
                    // ÖNCE: Bitmap önbelleğinden geri yükle
                    if (pData.renderedBitmap) {
                        try {
                            const ctx = pData.renderCanvas.getContext('2d');
                            ctx.drawImage(pData.renderedBitmap, 0, 0);
                            continue; // Bitmap restore başarılı
                        } catch (bitmapErr) { /* fall through to PDF.js re-render */ }
                    }
                    // FALLBACK: PDF.js ile yeniden render
                    let savedDrawing = null;
                    if (pData.drawingCanvas && pData.drawingCanvas.parentElement) {
                        try {
                            savedDrawing = pData.drawingCanvas.toDataURL('image/png', 0.9);
                        } catch (e) {
                            logger.warn(`[Visibility] Failed to save drawing for page ${pData.pageNum}:`, e);
                        }
                    }
                    pData.isRendered = false;
                    await renderPage(pData.pageNum);
                    if (savedDrawing && pData.drawingCanvas) {
                        const ctx = pData.drawingCanvas.getContext('2d', { willReadFrequently: true });
                        const img = new Image();
                        img.src = savedDrawing;
                        img.onload = () => {
                            ctx.globalCompositeOperation = 'source-over';
                            ctx.imageSmoothingEnabled = true;
                            ctx.imageSmoothingQuality = 'high';
                            ctx.drawImage(img, 0, 0, pData.drawingCanvas.width, pData.drawingCanvas.height);
                            pData.hasChanges = true;
                        };
                    }
                }
            } else {
                // Görünür olmayan sayfalar için sadece temel kontroller
                // Canvas DOM'da değilse veya boyutu yoksa yeniden render et
                if (!renderCanvas.parentElement || !renderCanvas.width || !renderCanvas.height) {
                    logger.warn(`[Visibility] Canvas ${pData.pageNum} (not visible) needs re-render`);
                    pData.isRendered = false;
                    // Görünür olmayan sayfaları hemen render etme, lazy loading'e bırak
                    // Ama flag'i false yap ki görünür olduğunda render edilsin
                }
            }
        }
    }
    
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            wasHidden = true;
            // Gizlendiğinde aktif interval varsa durdur
            if (visibilityCheckInterval) {
                clearInterval(visibilityCheckInterval);
                visibilityCheckInterval = null;
            }
        } else if (wasHidden && pdfDoc && renderedPages.length > 0) {
            wasHidden = false;
            logger.log('[Visibility] Page became visible, restoring PDF canvases...');

            // ADIM 1: Anlık geri yükleme — ImageBitmap önbellekten senkron restore
            // Bu µs cinsinden hızlıdır, kullanıcı beyaz sayfa görmez
            restoreAllCanvasesFromBitmap();

            // ADIM 2: Yedek kontrol — bitmap önbelleği olmayan veya restore edilemeyen
            // sayfalar için PDF.js ile yeniden render et (async fallback)
            requestAnimationFrame(async () => {
                await checkAndRestorePDFCanvas();
            });

            // ADIM 3: Geç kontrol — bazı durumlarda GPU context geç temizlenebilir
            setTimeout(async () => {
                if (!document.hidden) await checkAndRestorePDFCanvas();
            }, 500);

            setTimeout(async () => {
                if (!document.hidden) await checkAndRestorePDFCanvas();
            }, 1500);
        }
    });

    // Focus event: pencere odaklandığında da kontrol et
    window.addEventListener('focus', () => {
        if (wasHidden && pdfDoc && renderedPages.length > 0 && !document.hidden) {
            logger.log('[Focus] Window focused, restoring PDF canvases...');
            restoreAllCanvasesFromBitmap();
            setTimeout(async () => {
                await checkAndRestorePDFCanvas();
            }, 150);
        }
    });
}

// Deprecated functions for compatibility
export function onPrevPage() { }
export function onNextPage() { }
