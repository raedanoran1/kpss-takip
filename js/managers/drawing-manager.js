
let canvas, ctx;
let isDrawing = false;
let drawingEnabled = false; // Drawing disabled by default
let currentTool = 'pen'; // 'pen', 'eraser', 'hand'
let currentSettings = {
    color: '#ff0000', // PDF'deki gibi kırmızı başlangıç
    width: 2, // PDF'deki gibi 2px başlangıç
    eraserWidth: 20,
    isEraser: false
};

let isTemporaryEraser = false;
let previousEraserState = false;
let previousToolState = 'pen';
let lastX = 0;
let lastY = 0;

// El aracı (hand tool) için panning state
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panStartScrollLeft = 0;
let panStartScrollTop = 0;
let handScrollSpeed = 3; // El aracı kaydırma hızı


export function setupDrawingUI() {
    canvas = document.getElementById('drawing-canvas');
    if (!canvas) {
        console.warn('Drawing canvas not found yet.');
        return;
    }
    ctx = canvas.getContext('2d', { willReadFrequently: true });

    setupToolbar();
    setupCanvasEvents();
    updateCanvasCursor();

    // Resize observer
    const container = document.querySelector('.app-container');
    if (container) {
        const observer = new ResizeObserver(() => resizeCanvas());
        observer.observe(container);
    }

    resizeCanvas();
}

export function toggleDrawingMode(buttonId) {
    // Global çizim durumunu butonlar arası senkronize eden ortak toggle
    drawingEnabled = !drawingEnabled;

    // Üst global toggle butonu (mor şeritteki)
    const globalToggle = document.getElementById('global-drawing-toggle');
    if (globalToggle) {
        globalToggle.classList.toggle('active', drawingEnabled);
        const textEl = globalToggle.querySelector('.toggle-text');
        if (textEl) {
            textEl.textContent = drawingEnabled ? 'Çizim Aktif' : 'Çizim Kapalı';
        }
    }

    // Konu notları gibi bağlama özel toggle butonu
    if (buttonId) {
        const contextBtn = document.getElementById(buttonId);
        if (contextBtn) {
            contextBtn.classList.toggle('active', drawingEnabled);
        }
    }

    // Canvas etkileşimini gerçekten aç/kapat
    if (canvas) {
        canvas.style.pointerEvents = drawingEnabled ? 'auto' : 'none';
        updateCanvasCursor();
    }
}

export function hideDrawingLayer() {
    // Eski API'yi kullanan yerler için güvenli kapatma
    drawingEnabled = false;

    const globalToggle = document.getElementById('global-drawing-toggle');
    if (globalToggle) {
        globalToggle.classList.remove('active');
        const textEl = globalToggle.querySelector('.toggle-text');
        if (textEl) {
            textEl.textContent = 'Çizim Kapalı';
        }
    }

    if (canvas) {
        canvas.style.pointerEvents = 'none';
        updateCanvasCursor();
    }
}

export function destroyDrawingUI() {
    // Placeholder to satisfy import in pdf-viewer-manager
    console.log('destroyDrawingUI called');
}

function setupToolbar() {
    const drawingToggle = document.getElementById('global-drawing-toggle');
    if (drawingToggle) {
        drawingToggle.addEventListener('click', () => {
            drawingEnabled = !drawingEnabled;
            drawingToggle.classList.toggle('active', drawingEnabled);

            const textEl = drawingToggle.querySelector('.toggle-text');
            if (textEl) textEl.textContent = drawingEnabled ? 'Çizim Aktif' : 'Çizim Kapalı';

            if (canvas) {
                canvas.style.pointerEvents = drawingEnabled ? 'auto' : 'none';
                updateCanvasCursor();
            }
        });
    }

    // El Aracı (Hand Tool)
    const handBtn = document.getElementById('global-hand-btn');
    if (handBtn) {
        handBtn.addEventListener('click', () => {
            currentTool = 'hand';
            currentSettings.isEraser = false;
            updateToolButtons();
            updateCanvasCursor();
        });
    }

    // Pen Button
    const penBtn = document.getElementById('global-pen-btn');
    if (penBtn) {
        penBtn.addEventListener('click', () => {
            currentTool = 'pen';
            currentSettings.isEraser = false;
            updateToolButtons();
            updateCanvasCursor();
        });
    }

    // Color Dot (PDF'deki gibi)
    const colorDot = document.getElementById('global-color-dot');
    if (colorDot) {
        colorDot.addEventListener('click', () => {
            const color = colorDot.getAttribute('data-color');
            setColor(color);
        });
    }

    // Color Picker
    const colorPicker = document.getElementById('global-color-picker');
    const colorPickerBtn = document.getElementById('global-color-picker-btn');
    if (colorPicker && colorPickerBtn) {
        colorPickerBtn.addEventListener('click', () => {
            const rect = colorPickerBtn.getBoundingClientRect();
            colorPicker.style.position = 'fixed';
            colorPicker.style.left = `${rect.left}px`;
            colorPicker.style.top = `${rect.bottom}px`;
            colorPicker.click();
        });
        colorPicker.addEventListener('input', (e) => {
            const newColor = e.target.value;
            setColor(newColor);
            if (colorDot) {
                colorDot.style.backgroundColor = newColor;
                colorDot.setAttribute('data-color', newColor);
            }
        });
    }

    // Pen Size Slider
    const penSizeSlider = document.getElementById('global-pen-size');
    const penSizeDisplay = document.getElementById('global-pen-size-display');
    if (penSizeSlider) {
        penSizeSlider.addEventListener('input', (e) => {
            currentSettings.width = parseInt(e.target.value);
            if (penSizeDisplay) penSizeDisplay.textContent = `${currentSettings.width}px`;
        });
        if (penSizeDisplay) penSizeDisplay.textContent = `${currentSettings.width}px`;
    }

    // Eraser Size Slider
    const eraserSizeSlider = document.getElementById('global-eraser-size');
    const eraserSizeDisplay = document.getElementById('global-eraser-size-display');
    if (eraserSizeSlider) {
        eraserSizeSlider.addEventListener('input', (e) => {
            currentSettings.eraserWidth = parseInt(e.target.value);
            if (eraserSizeDisplay) eraserSizeDisplay.textContent = `${currentSettings.eraserWidth}px`;
        });
        if (eraserSizeDisplay) eraserSizeDisplay.textContent = `${currentSettings.eraserWidth}px`;
    }

    // Eraser
    const eraserBtn = document.getElementById('global-eraser-btn');
    if (eraserBtn) {
        eraserBtn.addEventListener('click', () => {
            currentTool = 'eraser';
            currentSettings.isEraser = true;
            updateToolButtons();
            updateCanvasCursor();
        });
    }

    // Clear
    const clearBtn = document.getElementById('global-clear-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        });
    }
    
    // Başlangıçta aktif butonu güncelle
    updateToolButtons();
    updateCanvasCursor();
}

function updateToolButtons() {
    const handBtn = document.getElementById('global-hand-btn');
    const penBtn = document.getElementById('global-pen-btn');
    const eraserBtn = document.getElementById('global-eraser-btn');
    
    [handBtn, penBtn, eraserBtn].forEach(btn => {
        if (btn) btn.classList.remove('active');
    });
    
    if (currentTool === 'hand' && handBtn) handBtn.classList.add('active');
    if (currentTool === 'pen' && penBtn) penBtn.classList.add('active');
    if (currentTool === 'eraser' && eraserBtn) eraserBtn.classList.add('active');
}

// Setup all toolbars
export function setupAllDrawingToolbars() {
    // This function is now deprecated as setupToolbar handles global toolbar directly.
    // Keeping it as a placeholder if other contexts are re-introduced later.
    console.warn('setupAllDrawingToolbars is deprecated. Use setupToolbar() for global context.');
    setupToolbar();
}

function setColor(color) {
    currentSettings.color = color;
    currentSettings.isEraser = false;
    currentTool = 'pen';
    
    // Update color dot
    const colorDot = document.getElementById('global-color-dot');
    if (colorDot) {
        colorDot.style.backgroundColor = color;
        colorDot.setAttribute('data-color', color);
        colorDot.classList.add('active');
    }
    
    updateToolButtons();
    updateCanvasCursor();
}

function toggleEraser() {
    if (currentSettings.isEraser) {
        currentTool = 'pen';
        currentSettings.isEraser = false;
    } else {
        currentTool = 'eraser';
        currentSettings.isEraser = true;
    }
    updateToolButtons();
    updateCanvasCursor();
}

// Silgi modunda cursor'u güncelle
export function setEraserMode(isEraser) {
    currentSettings.isEraser = isEraser;
    if (isEraser) {
        currentTool = 'eraser';
    } else {
        currentTool = 'pen';
    }
    updateToolButtons();
    updateCanvasCursor();
}

function updateCanvasCursor() {
    if (!canvas) return;
    if (currentTool === 'hand') {
        canvas.className = 'hand-mode';
        canvas.style.cursor = 'grab';
    } else if (currentTool === 'eraser') {
        canvas.className = 'eraser-mode';
        canvas.style.cursor = 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'black\' stroke-width=\'2\'><path d=\'M20 20H7L3 16l10-10 7 7-4 4\'/><path d=\'M7 20l-4-4\'/></svg>") 12 12, cell';
    } else {
        canvas.className = 'pen-mode';
        // PDF'deki gibi kalem cursor'u
        canvas.style.cursor = 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'32\' height=\'32\' viewBox=\'0 0 32 32\'><path d=\'M0 32l10-2.5L25 14.5l-7.5-7.5L2.5 22 0 32zm4.3-8.2l12.2-12.2 3.7 3.7L8 27.5 4.3 23.8z\' fill=\'%23000\' stroke=\'%23fff\' stroke-width=\'1\'/></svg>") 0 32, crosshair';
    }
}

function getUnderlyingElement(clientX, clientY) {
    if (!canvas) return null;
    const prevPointerEvents = canvas.style.pointerEvents;
    // Temporarily disable pointer-events so we can detect what's underneath the canvas.
    canvas.style.pointerEvents = 'none';
    const el = document.elementFromPoint(clientX, clientY);
    canvas.style.pointerEvents = prevPointerEvents;
    return el;
}

function findScrollableContainer(el) {
    if (!el) return null;
    let current = el;
    while (current && current !== document.body) {
        const style = window.getComputedStyle(current);
        const overflowY = style.overflowY;
        const overflow = style.overflow;
        
        if (overflowY === 'auto' || overflowY === 'scroll' || overflow === 'auto' || overflow === 'scroll') {
            return current;
        }
        current = current.parentElement;
    }
    return null;
}

function isInteractiveElement(el) {
    if (!el) return false;
    
    // Check if we're inside a flashcard or resource viewer (but not on a button)
    // If so, allow drawing on content (images, text areas, empty spaces)
    const isInsideFlashcard = el.closest('.flashcard');
    const isInsideResourceViewer = el.closest('#resource-content-viewer');
    const isButtonInsideFlashcard = isInsideFlashcard && el.closest('button');
    const isButtonInsideResourceViewer = isInsideResourceViewer && el.closest('button');
    
    // Check if element or any parent has cursor: pointer style (indicates clickability)
    // BUT skip this check for flashcard and resource viewer content areas to allow drawing on them
    if ((!isInsideFlashcard || isButtonInsideFlashcard) && (!isInsideResourceViewer || isButtonInsideResourceViewer)) {
        let current = el;
        while (current && current !== document.body) {
            // Skip cursor check for images inside resource viewer
            if (isInsideResourceViewer && current.tagName === 'IMG') {
                break;
            }
            const style = window.getComputedStyle(current);
            if (style.cursor === 'pointer' && current.tagName !== 'BODY' && current.tagName !== 'HTML') {
                return true;
            }
            current = current.parentElement;
        }
    }
    
    // If inside resource viewer and not a button, allow drawing
    if (isInsideResourceViewer && !isButtonInsideResourceViewer) {
        // Only block actual interactive elements (buttons, inputs, etc.)
        return Boolean(
            el.closest(
                [
                    'button',
                    'a[href]',
                    'input',
                    'textarea',
                    'select',
                    'label',
                    '[role="button"]',
                    '[contenteditable="true"]',
                    '[onclick]',
                    '.icon-btn',
                    '.primary-btn',
                    '.secondary-btn',
                    '.session-close-btn'
                ].join(',')
            )
        );
    }
    
    // Treat anything clickable/form-related as interactive (so drawing should not start on it).
    return Boolean(
        el.closest(
            [
                'button',
                'a[href]',
                'input',
                'textarea',
                'select',
                'label',
                '[role="button"]',
                '[contenteditable="true"]',
                '[onclick]',
                // App-specific clickable classes
                '.icon-btn',
                '.nav-arrow',
                '.rate-btn',
                '.primary-btn',
                '.secondary-btn',
                '.small-btn',
                '.ghost-btn',
                '.chat-icon-btn',
                '.chat-send-btn',
                '.timer-btn',
                '.timer-control-btn',
                '.tool-btn-mini',
                '.drawing-toggle-btn',
                '.topic-chat-btn-sm',
                '.topic-chat-btn',
                '.manage-card-delete',
                '.delete-q-btn',
                '.session-close-btn',
                '.close-modal-btn',
                '.pdf-btn',
                '.player-btn',
                // Navigation and subject chips
                '.nav-btn',
                '.chip',
                '.sub-nav',
                // Topic and question items
                '.topic-q-item',
                '.topic-item',
                '.topic-list-item',
                // Resource items (but not inside resource viewer - allow drawing there)
                '.resource-item',
                '.resource-list-item',
                // Other clickable containers
                '.topic-q-info',
                '.topic-q-right',
                '.topic-actions',
                '.study-topic-btn',
                '.topic-delete-btn',
                '.list-btn-sm',
                '.due-badge',
                // Habit items
                '.habit-item',
                // Voice library items
                '.voice-item',
                '.voice-list-item',
                // Trial items
                '.trial-item',
                // Today tasks
                '.today-work-item',
                '.today-stat',
                // Review header (but not flashcard itself - allow drawing on flashcard content)
                '.review-header',
                // Modal buttons (but not modal itself to allow drawing inside modals)
                '.modal-footer button',
                '.modal-header button'
            ].join(',')
        )
    );
}

function forwardInteractionAndTemporarilyDisableCanvas(underlyingEl) {
    if (!canvas || !underlyingEl) return;

    // Disable canvas so follow-up mouseup/mousemove go to the real control (important for sliders etc).
    canvas.style.pointerEvents = 'none';

    // Best-effort: focus + click for buttons/links. This avoids needing to toggle drawing off.
    try {
        if (typeof underlyingEl.focus === 'function') underlyingEl.focus();
        if (typeof underlyingEl.click === 'function') underlyingEl.click();
    } catch (_) {
        // ignore
    }

    const restore = () => {
        document.removeEventListener('mouseup', restore, true);
        document.removeEventListener('touchend', restore, true);
        document.removeEventListener('touchcancel', restore, true);
        // Restore only if drawing is still enabled
        if (canvas && drawingEnabled) {
            canvas.style.pointerEvents = 'auto';
        }
    };

    document.addEventListener('mouseup', restore, true);
    document.addEventListener('touchend', restore, true);
    document.addEventListener('touchcancel', restore, true);
}

// PERFORMANS: rAF throttle state - mousemove'u ekran yenileme hızıyla sınırla
let rafPending = false;
let pendingMoveX = 0;
let pendingMoveY = 0;
let strokeGeneration = 0; // Çizgi nesli: endStroke sonrası stale rAF'ları engeller

function setupCanvasEvents() {
    canvas.addEventListener('mousedown', (e) => {
        if (!drawingEnabled) return;

        // If the user is trying to click a UI control under the canvas, don't start drawing.
        const underlyingEl = getUnderlyingElement(e.clientX, e.clientY);
        if (isInteractiveElement(underlyingEl)) {
            forwardInteractionAndTemporarilyDisableCanvas(underlyingEl);
            return;
        }

        // El aracı (hand tool) - kaydırma
        if (currentTool === 'hand') {
            isPanning = true;
            panStartX = e.clientX;
            panStartY = e.clientY;
            
            // Scrollable container'ı bul
            const scrollableContainer = findScrollableContainer(underlyingEl);
            if (scrollableContainer) {
                panStartScrollLeft = scrollableContainer.scrollLeft;
                panStartScrollTop = scrollableContainer.scrollTop;
            } else {
                panStartScrollLeft = window.scrollX;
                panStartScrollTop = window.scrollY;
            }
            canvas.style.cursor = 'grabbing';
            e.preventDefault();
            return;
        }

        // Sağ tık / kalem yan tuşu ile geçici silgi
        if (e.button === 2) {
            isTemporaryEraser = true;
            previousEraserState = currentSettings.isEraser;
            previousToolState = currentTool;
            currentTool = 'eraser';
            currentSettings.isEraser = true;
            updateToolButtons();
            updateCanvasCursor();
            e.preventDefault();
            return;
        }

        isDrawing = true;
        strokeGeneration++; // Her yeni çizgide nesli artır - stale rAF'ları geçersiz kıl
        rafPending = false;  // Önceki çizgiye ait bekleyen rAF'ı iptal et
        const rect = canvas.getBoundingClientRect();
        lastX = e.clientX - rect.left;
        lastY = e.clientY - rect.top;

        // Context ayarlarını YALNIZCA mousedown'da bir kez set et (mousemove'da tekrar etme)
        ctx.lineWidth = currentSettings.isEraser ? currentSettings.eraserWidth : currentSettings.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        if (currentSettings.isEraser) {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.strokeStyle = 'rgba(0,0,0,1)';
        } else {
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = currentSettings.color;
        }

        // Path'i başlat - sürekli açık tutacağız
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
    });

    canvas.addEventListener('mousemove', (e) => {
        if (!drawingEnabled) return;
        
        // El aracı kaydırma - rAF throttle yok (scroll için anındalık önemli)
        if (isPanning && currentTool === 'hand') {
            const deltaX = e.clientX - panStartX;
            const deltaY = e.clientY - panStartY;
            
            const underlyingEl = getUnderlyingElement(e.clientX, e.clientY);
            const scrollableContainer = findScrollableContainer(underlyingEl);
            
            if (scrollableContainer) {
                scrollableContainer.scrollLeft = panStartScrollLeft - deltaX * handScrollSpeed;
                scrollableContainer.scrollTop = panStartScrollTop - deltaY * handScrollSpeed;
            } else {
                window.scrollTo({
                    left: panStartScrollLeft - deltaX * handScrollSpeed,
                    top: panStartScrollTop - deltaY * handScrollSpeed,
                    behavior: 'auto'
                });
            }
            e.preventDefault();
            return;
        }
        
        if (!isDrawing) return;

        // PERFORMANS: rAF throttle - her mousemove'u çizme, sadece her frame'de bir çiz.
        // 60fps'de mousemove 200-300 event/sn üretebilir. rAF bunu 60/sn'ye düşürür.
        // Bu sayede context state değişikliği gereksiz yere tekrarlanmaz.
        const rect = canvas.getBoundingClientRect();
        pendingMoveX = e.clientX - rect.left;
        pendingMoveY = e.clientY - rect.top;

        if (!rafPending) {
            rafPending = true;
            const capturedGeneration = strokeGeneration; // Hangi çizgiye ait olduğunu yakala
            requestAnimationFrame(() => {
                rafPending = false;
                // Bu rAF eski bir çizgiye ait mi? Nesil değiştiyse iptal et
                if (!isDrawing || capturedGeneration !== strokeGeneration) return;
                // Context özellikleri mousedown'da zaten set edildi, burada TEKRAR SET ETME
                ctx.lineTo(pendingMoveX, pendingMoveY);
                ctx.stroke();
                lastX = pendingMoveX;
                lastY = pendingMoveY;
            });
        }
    });

    const endStroke = () => {
        if (isPanning && currentTool === 'hand') {
            isPanning = false;
            canvas.style.cursor = 'grab';
            return;
        }
        
        isDrawing = false;
        ctx.beginPath(); // Reset path for next stroke

        // Geçici silgiden çık
        if (isTemporaryEraser) {
            currentSettings.isEraser = previousEraserState;
            currentTool = previousToolState;
            isTemporaryEraser = false;
            updateToolButtons();
            updateCanvasCursor();
        }
    };

    canvas.addEventListener('mouseup', endStroke);
    canvas.addEventListener('mouseout', endStroke);

    // --- Touch Support for stylus/touchscreen ---
    canvas.addEventListener('touchstart', (e) => {
        if (!drawingEnabled) return;
        const touch = e.touches[0];
        if (!touch) return;

        const underlyingEl = getUnderlyingElement(touch.clientX, touch.clientY);
        if (isInteractiveElement(underlyingEl)) {
            forwardInteractionAndTemporarilyDisableCanvas(underlyingEl);
            return;
        }
        
        // El aracı (hand tool) - kaydırma
        if (currentTool === 'hand') {
            isPanning = true;
            panStartX = touch.clientX;
            panStartY = touch.clientY;
            
            const scrollableContainer = findScrollableContainer(underlyingEl);
            if (scrollableContainer) {
                panStartScrollLeft = scrollableContainer.scrollLeft;
                panStartScrollTop = scrollableContainer.scrollTop;
            } else {
                panStartScrollLeft = window.scrollX;
                panStartScrollTop = window.scrollY;
            }
            e.preventDefault();
            return;
        }
        
        isDrawing = true;
        strokeGeneration++; // Her yeni dokunuşta nesli artır
        rafPending = false;  // Önceki çizgiye ait bekleyen rAF'ı iptal et
        const rect = canvas.getBoundingClientRect();
        lastX = touch.clientX - rect.left;
        lastY = touch.clientY - rect.top;

        // Context ayarlarını YALNIZCA touchstart'ta bir kez set et
        ctx.lineWidth = currentSettings.isEraser ? currentSettings.eraserWidth : currentSettings.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        if (currentSettings.isEraser) {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.strokeStyle = 'rgba(0,0,0,1)';
        } else {
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = currentSettings.color;
        }

        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        e.preventDefault();
    });

    canvas.addEventListener('touchmove', (e) => {
        if (!drawingEnabled) return;
        
        // El aracı kaydırma - rAF throttle yok (scroll için anındalık önemli)
        if (isPanning && currentTool === 'hand') {
            const touch = e.touches[0];
            if (!touch) return;
            const deltaX = touch.clientX - panStartX;
            const deltaY = touch.clientY - panStartY;
            
            const underlyingEl = getUnderlyingElement(touch.clientX, touch.clientY);
            const scrollableContainer = findScrollableContainer(underlyingEl);
            
            if (scrollableContainer) {
                scrollableContainer.scrollLeft = panStartScrollLeft - deltaX * handScrollSpeed;
                scrollableContainer.scrollTop = panStartScrollTop - deltaY * handScrollSpeed;
            } else {
                window.scrollTo({
                    left: panStartScrollLeft - deltaX * handScrollSpeed,
                    top: panStartScrollTop - deltaY * handScrollSpeed,
                    behavior: 'auto'
                });
            }
            e.preventDefault();
            return;
        }
        
        if (!isDrawing) return;
        const rect = canvas.getBoundingClientRect();
        const touch = e.touches[0];
        if (!touch) return;

        // PERFORMANS: rAF throttle - context özelliklerini touchstart'ta set ettik, burada tekrar etme
        pendingMoveX = touch.clientX - rect.left;
        pendingMoveY = touch.clientY - rect.top;

        if (!rafPending) {
            rafPending = true;
            const capturedGeneration = strokeGeneration;
            requestAnimationFrame(() => {
                rafPending = false;
                if (!isDrawing || capturedGeneration !== strokeGeneration) return;
                ctx.lineTo(pendingMoveX, pendingMoveY);
                ctx.stroke();
                lastX = pendingMoveX;
                lastY = pendingMoveY;
            });
        }

        e.preventDefault();
    });

    canvas.addEventListener('touchend', () => {
        if (isPanning && currentTool === 'hand') {
            isPanning = false;
            return;
        }
        isDrawing = false;
        ctx.beginPath();
    });

    // Mouse wheel: çizim açıkken de normal scroll davranışı devam etsin
    canvas.addEventListener('wheel', (e) => {
        if (!drawingEnabled) return;

        // Canvas'ın pointer-events'ini geçici olarak kapat ve alttaki scrollable elementi bul
        const prevPointerEvents = canvas.style.pointerEvents;
        canvas.style.pointerEvents = 'none';
        
        const elementUnder = document.elementFromPoint(e.clientX, e.clientY);
        canvas.style.pointerEvents = prevPointerEvents;

        if (!elementUnder) {
            // Element bulunamadıysa window'a scroll yap
            window.scrollBy({
                top: e.deltaY,
                left: e.deltaX,
                behavior: 'auto'
            });
            e.preventDefault();
            return;
        }

        // Scrollable container'ı bul (overflow-y: auto veya scroll olan element)
        let scrollableContainer = elementUnder;
        while (scrollableContainer && scrollableContainer !== document.body) {
            const style = window.getComputedStyle(scrollableContainer);
            const overflowY = style.overflowY;
            const overflow = style.overflow;
            
            if (overflowY === 'auto' || overflowY === 'scroll' || overflow === 'auto' || overflow === 'scroll') {
                // Scrollable container bulundu, buna scroll yap
                scrollableContainer.scrollBy({
                    top: e.deltaY,
                    left: e.deltaX,
                    behavior: 'auto'
                });
                e.preventDefault();
                return;
            }
            
            scrollableContainer = scrollableContainer.parentElement;
        }

        // Scrollable container bulunamadıysa window'a scroll yap
        window.scrollBy({
            top: e.deltaY,
            left: e.deltaX,
            behavior: 'auto'
        });

        e.preventDefault();
    }, { passive: false });

    // Disable drawing by default (ama scroll engellenmesin diye pointerEvents kapalı)
    canvas.style.pointerEvents = 'none';
}

// --- Klavye Kısayolları (Global) ---
// E tuşuna bir kez bas: kalem <-> silgi arasında geçiş (toggle)
window.addEventListener('keydown', (e) => {
    // Tekrarlayan olayları (tuş basılı tutma) yok say
    if (e.repeat) return;
    if (e.key === 'e' || e.key === 'E') {
        // Silgi/kalem arasında geçiş
        if (currentTool === 'eraser') {
            currentTool = 'pen';
            currentSettings.isEraser = false;
        } else {
            currentTool = 'eraser';
            currentSettings.isEraser = true;
        }
        updateToolButtons();
        updateCanvasCursor();
    } else if (e.key === 'h' || e.key === 'H') {
        // El aracı/kalem arasında geçiş
        if (currentTool === 'hand') {
            currentTool = 'pen';
        } else {
            currentTool = 'hand';
        }
        currentSettings.isEraser = false;
        updateToolButtons();
        updateCanvasCursor();
    }
});

function resizeCanvas() {
    if (!canvas) return;
    // Set canvas to full window size since it's a fixed global overlay
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // Re-apply settings after resize (resizing often resets context state)
    if (ctx) {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
    }
}

// Global resize listener
window.addEventListener('resize', resizeCanvas);
