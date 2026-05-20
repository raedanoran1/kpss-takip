import { addResource, getResources, deleteResource, updateResourceOrder, updateResource, saveResourcePDF } from '../db.js';
import { appState } from '../state/app-state.js';
import { showConfirm, showToast } from '../utils/ui-utils.js';
import { openPDFViewer } from './pdf-viewer-manager.js';
import { loadNotesDashboard } from './notes-manager.js';
import { loadQuestionsDashboard } from './questions-manager.js';
import { loadTopics } from './topic-manager.js';
import { setupPointerDragSort } from '../utils/drag-sort.js';

// --- DUFS Browser State ---
let _dufsAllFiles = [];
let _dufsSelectedFile = null;
let _dufsPendingBuffer = null;
let _dufsPendingName = null;

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function dufsProxyFetch(dufsBase, remotePath, timeoutMs = 15000) {
    const params = new URLSearchParams({ url: dufsBase, path: remotePath });
    const proxyResp = await fetch('/api/dufs-proxy?' + params.toString(), { signal: AbortSignal.timeout(timeoutMs) });
    if (proxyResp.ok) return proxyResp;
    throw new Error('proxy_failed');
}

async function dufsDirectFetch(dufsBase, remotePath, timeoutMs = 15000) {
    const url = dufsBase.replace(/\/$/, '') + remotePath;
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (resp.ok) return resp;
    throw new Error('direct_failed');
}

async function fetchDufsJson(dufsBase) {
    const remotePath = '/?json';
    let resp;
    try {
        resp = await dufsProxyFetch(dufsBase, remotePath);
    } catch (_) {
        resp = await dufsDirectFetch(dufsBase, remotePath);
    }
    return resp.json();
}

async function fetchDufsFile(dufsBase, filename, onProgress) {
    const remotePath = '/' + encodeURIComponent(filename);
    const FILE_TIMEOUT = 10 * 60 * 1000; // 10 dakika (büyük dosyalar için)
    let resp;
    try {
        resp = await dufsProxyFetch(dufsBase, remotePath, FILE_TIMEOUT);
    } catch (_) {
        resp = await dufsDirectFetch(dufsBase, remotePath, FILE_TIMEOUT);
    }

    const contentLength = parseInt(resp.headers.get('Content-Length') || '0');
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (onProgress && contentLength > 0) {
            onProgress(received, contentLength);
        }
    }

    const total = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        total.set(chunk, offset);
        offset += chunk.length;
    }
    return total.buffer;
}

function renderDufsFileList(files, searchTerm) {
    const listEl = document.getElementById('dufs-file-list');
    const confirmBtn = document.getElementById('confirm-dufs-select');
    const filtered = files.filter(f =>
        f.path_type === 'File' &&
        f.name.toLowerCase().endsWith('.pdf') &&
        (!searchTerm || f.name.toLowerCase().includes(searchTerm.toLowerCase()))
    );

    if (filtered.length === 0) {
        listEl.innerHTML = `<div class="dufs-empty-state">${searchTerm ? 'Sonuç bulunamadı' : 'PDF dosyası yok'}</div>`;
        return;
    }

    listEl.innerHTML = '';
    filtered.forEach(file => {
        const item = document.createElement('div');
        item.className = 'dufs-file-item' + (_dufsSelectedFile === file.name ? ' selected' : '');
        item.innerHTML = `
            <span class="dufs-file-icon">📄</span>
            <div class="dufs-file-info">
                <div class="dufs-file-name" title="${file.name}">${file.name}</div>
                <div class="dufs-file-size">${formatBytes(file.size)}</div>
            </div>`;
        item.addEventListener('click', () => {
            _dufsSelectedFile = file.name;
            document.querySelectorAll('.dufs-file-item').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');
            confirmBtn.disabled = false;
        });
        listEl.appendChild(item);
    });
}

function setupDufsBrowser() {
    const openBtn = document.getElementById('open-dufs-browser-btn');
    const modal = document.getElementById('dufs-browser-modal');
    const closeBtn = document.getElementById('close-dufs-modal');
    const cancelBtn = document.getElementById('cancel-dufs-browser');
    const connectBtn = document.getElementById('dufs-connect-btn');
    const urlInput = document.getElementById('dufs-url-input');
    const searchInput = document.getElementById('dufs-search-input');
    const confirmBtn = document.getElementById('confirm-dufs-select');
    const listEl = document.getElementById('dufs-file-list');

    // Restore saved URL
    const savedUrl = localStorage.getItem('dufs_url') || 'http://192.168.1.36:5000';
    urlInput.value = savedUrl;

    const closeModal = () => {
        modal.classList.remove('active');
        _dufsSelectedFile = null;
        confirmBtn.disabled = true;
    };

    openBtn.addEventListener('click', async () => {
        _dufsSelectedFile = null;
        _dufsAllFiles = [];
        confirmBtn.disabled = true;
        listEl.innerHTML = '<div class="dufs-loading"><div class="spinner"></div>ngrok kontrol ediliyor...</div>';
        searchInput.value = '';
        modal.classList.add('active');

        // Önce ngrok URL'sini otomatik algılamayı dene
        try {
            const resp = await fetch('/api/ngrok-url', { signal: AbortSignal.timeout(4000) });
            if (resp.ok) {
                const data = await resp.json();
                if (data.url) {
                    urlInput.value = data.url;
                    localStorage.setItem('dufs_url', data.url);
                }
            }
        } catch (_) {
            // ngrok yoksa veya Replit'teyiz — kaydedilmiş URL'yi kullan
        }

        listEl.innerHTML = '<div class="dufs-empty-state">DUFS sunucu adresini girin ve "Bağlan"a basın</div>';

        // URL varsa otomatik bağlan
        if (urlInput.value.trim()) {
            connectBtn.click();
        }
    });

    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);

    connectBtn.addEventListener('click', async () => {
        const dufsBase = urlInput.value.trim().replace(/\/$/, '');
        if (!dufsBase) { showToast('DUFS URL girin', 'warning'); return; }
        localStorage.setItem('dufs_url', dufsBase);

        listEl.innerHTML = `<div class="dufs-loading"><div class="spinner"></div>Bağlanıyor...</div>`;
        connectBtn.disabled = true;

        try {
            const data = await fetchDufsJson(dufsBase);
            _dufsAllFiles = (data.paths || []);
            renderDufsFileList(_dufsAllFiles, searchInput.value);
        } catch (err) {
            const isHttps = location.protocol === 'https:';
            const dufsIsHttp = dufsBase.startsWith('http://');
            if (isHttps && dufsIsHttp) {
                listEl.innerHTML = `
                <div class="dufs-setup-guide">
                    <div class="dufs-setup-title">🔒 HTTPS sayfadan HTTP DUFS'a erişim engellendi</div>
                    <div class="dufs-setup-desc">Replit, Vercel ve benzeri tüm HTTPS uygulamalar bu kısıtlamaya tabidir. İki çözüm yolu var:</div>

                    <div class="dufs-solution-tab">
                        <div class="dufs-solution-header">⭐ Çözüm 1 — ngrok (Önerilen, her yerden çalışır)</div>
                        <div class="dufs-setup-steps">
                            <div class="dufs-step"><span class="dufs-step-num">1</span>
                                <div><a href="https://ngrok.com/download" target="_blank" style="color:var(--primary-color)">ngrok.com/download</a>'dan ngrok'u indir ve kur</div>
                            </div>
                            <div class="dufs-step"><span class="dufs-step-num">2</span>
                                <div>Windows CMD'de çalıştır:<br>
                                <code class="dufs-code">ngrok http 5000</code></div>
                            </div>
                            <div class="dufs-step"><span class="dufs-step-num">3</span>
                                <div>Çıkan <b>https://xxxx.ngrok-free.app</b> adresini kopyala</div>
                            </div>
                            <div class="dufs-step"><span class="dufs-step-num">4</span>
                                <div>Yukarıdaki URL kutusuna yapıştır ve "Bağlan"a bas ✓</div>
                            </div>
                        </div>
                    </div>

                    <div class="dufs-solution-tab" style="margin-top:0.75rem">
                        <div class="dufs-solution-header">🏠 Çözüm 2 — Yerel çalıştırma (Sadece aynı WiFi)</div>
                        <div class="dufs-setup-steps">
                            <div class="dufs-step"><span class="dufs-step-num">1</span>
                                <div>Windows CMD'de KPSS klasöründe çalıştır:<br>
                                <code class="dufs-code">set PORT=3000 &amp;&amp; node server.js</code></div>
                            </div>
                            <div class="dufs-step"><span class="dufs-step-num">2</span>
                                <div>iPad'de Safari'de aç:<br>
                                <code class="dufs-code">http://192.168.1.36:3000</code></div>
                            </div>
                            <div class="dufs-step"><span class="dufs-step-num">3</span>
                                <div>DUFS URL olarak <code class="dufs-code">http://192.168.1.36:5000</code> gir ve "Bağlan" ✓</div>
                            </div>
                        </div>
                    </div>
                </div>`;
            } else {
                listEl.innerHTML = `<div class="dufs-empty-state">⚠️ Bağlanamadı: ${err.message}</div>`;
            }
        } finally {
            connectBtn.disabled = false;
        }
    });

    searchInput.addEventListener('input', () => {
        renderDufsFileList(_dufsAllFiles, searchInput.value);
    });

    confirmBtn.addEventListener('click', async () => {
        if (!_dufsSelectedFile) return;
        const dufsBase = urlInput.value.trim().replace(/\/$/, '');
        const filename = _dufsSelectedFile;

        confirmBtn.disabled = true;
        confirmBtn.textContent = 'İndiriliyor...';

        // Show progress below list
        let progressEl = document.getElementById('dufs-progress-bar');
        if (!progressEl) {
            progressEl = document.createElement('div');
            progressEl.id = 'dufs-progress-bar';
            progressEl.className = 'dufs-fetch-progress';
            listEl.insertAdjacentElement('afterend', progressEl);
        }
        progressEl.textContent = 'Hazırlanıyor...';

        try {
            const buffer = await fetchDufsFile(dufsBase, filename, (received, total) => {
                const pct = Math.round((received / total) * 100);
                progressEl.textContent = `İndiriliyor... ${pct}% (${formatBytes(received)} / ${formatBytes(total)})`;
            });

            _dufsPendingBuffer = buffer;
            _dufsPendingName = filename.replace(/\.pdf$/i, '');

            // Update label in main modal
            const pdfLabel = document.getElementById('resource-pdf-label');
            pdfLabel.textContent = `📡 ${filename}`;
            pdfLabel.style.color = 'var(--primary-color)';

            // Auto-fill name if empty
            const nameInput = document.getElementById('resource-name-input');
            if (!nameInput.value.trim()) {
                nameInput.value = _dufsPendingName;
            }

            progressEl.remove();
            closeModal();
            showToast('PDF hazır — Kaydet\'e basın');
        } catch (err) {
            progressEl.textContent = '⚠️ İndirme başarısız: ' + err.message;
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Seç ve Ekle';
        }
    });
}

export function setupResourcesUI() {
    // Add Modal Elements
    const addBtn = document.getElementById('add-resource-btn');
    const modal = document.getElementById('add-resource-modal');
    const cancelBtn = document.getElementById('cancel-add-resource');
    const saveBtn = document.getElementById('save-new-resource');

    // Update Modal Elements (Dynamic creation or reuse)
    let updateModal = document.getElementById('update-resource-modal');
    if (!updateModal) {
        createUpdateModal();
        updateModal = document.getElementById('update-resource-modal');
    }

    // Setup DUFS browser
    setupDufsBrowser();

    const resetAddModal = () => {
        document.getElementById('resource-name-input').value = '';
        document.getElementById('resource-note-input').value = '';
        document.getElementById('resource-type-select').value = 'Konu Anlatımı';
        document.getElementById('resource-status-select').value = '0';
        const pdfInput = document.getElementById('resource-pdf-input');
        const pdfLabel = document.getElementById('resource-pdf-label');
        pdfInput.value = '';
        pdfLabel.textContent = '📄 PDF Dosyası Seç';
        pdfLabel.style.color = 'var(--text-secondary)';
        _dufsPendingBuffer = null;
        _dufsPendingName = null;
    };

    addBtn.addEventListener('click', () => {
        resetAddModal();
        modal.classList.add('active');
    });

    cancelBtn.addEventListener('click', () => {
        modal.classList.remove('active');
        _dufsPendingBuffer = null;
        _dufsPendingName = null;
    });

    const finishSave = (newId, pdfLabel, pdfInput) => {
        pdfInput.value = '';
        pdfLabel.textContent = '📄 PDF Dosyası Seç';
        pdfLabel.style.color = 'var(--text-secondary)';
        _dufsPendingBuffer = null;
        _dufsPendingName = null;
        modal.classList.remove('active');
        loadResources();
        loadNotesDashboard();
        loadQuestionsDashboard();
        loadTopics(appState.currentSubject);
    };

    saveBtn.addEventListener('click', async () => {
        const nameInput = document.getElementById('resource-name-input');
        const noteInput = document.getElementById('resource-note-input');
        const typeSelect = document.getElementById('resource-type-select');
        const statusSelect = document.getElementById('resource-status-select');
        const pdfInput = document.getElementById('resource-pdf-input');
        const pdfLabel = document.getElementById('resource-pdf-label');

        const name = nameInput.value.trim();
        const type = typeSelect.value;
        const note = noteInput.value.trim();
        const status = parseInt(statusSelect.value);
        const pdfFile = pdfInput.files[0];

        if (!name) {
            showToast('Lütfen kaynak adı girin', 'warning');
            return;
        }

        const newId = addResource(appState.currentSubject, name, type, note, status);

        // DUFS'tan seçilen PDF buffer varsa kullan
        if (_dufsPendingBuffer && newId) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Kaydediliyor...';
            const success = await saveResourcePDF(newId, _dufsPendingBuffer);
            saveBtn.disabled = false;
            saveBtn.textContent = 'Kaydet';
            finishSave(newId, pdfLabel, pdfInput);
            if (success) {
                showToast('Kaynak ve PDF eklendi (DUFS)');
            } else {
                const errType = saveResourcePDF._lastError || '';
                showToast(errType === 'quota'
                    ? 'PDF kaydedilemedi: Depolama alanı dolu'
                    : `PDF kaydedilemedi: ${errType || 'bilinmeyen hata'}`, 'error');
            }
        } else if (pdfFile && newId) {
            const reader = new FileReader();
            reader.onload = async (e) => {
                const success = await saveResourcePDF(newId, e.target.result);
                finishSave(newId, pdfLabel, pdfInput);
                if (success) {
                    showToast('Kaynak ve PDF eklendi');
                } else {
                    const errType = saveResourcePDF._lastError || '';
                    showToast(errType === 'quota'
                        ? 'PDF kaydedilemedi: Depolama alanı dolu. Küçük bir PDF deneyin.'
                        : `PDF kaydedilemedi: ${errType || 'bilinmeyen hata'}`, 'error');
                }
            };
            reader.onerror = () => {
                finishSave(newId, pdfLabel, pdfInput);
                showToast('PDF okunamadı: Dosya erişim hatası', 'error');
            };
            reader.readAsArrayBuffer(pdfFile);
        } else {
            modal.classList.remove('active');
            showToast('Kaynak eklendi');
            loadResources();
            loadNotesDashboard();
            loadQuestionsDashboard();
            loadTopics(appState.currentSubject);
        }
    });

    const pdfInput = document.getElementById('resource-pdf-input');
    const pdfLabel = document.getElementById('resource-pdf-label');
    if (pdfInput && pdfLabel) {
        pdfInput.addEventListener('change', () => {
            // Clearing DUFS selection if user picks a local file
            _dufsPendingBuffer = null;
            _dufsPendingName = null;
            if (pdfInput.files.length > 0) {
                pdfLabel.textContent = `Seçilen Dosya: ${pdfInput.files[0].name}`;
                pdfLabel.style.color = 'var(--primary-color)';
            } else {
                pdfLabel.textContent = '📄 PDF Dosyası Seç';
                pdfLabel.style.color = 'var(--text-secondary)';
            }
        });
    }

    // Reordering – pointer-based (iOS safe, prevents text selection)
    const listEl = document.getElementById('resource-list');
    setupPointerDragSort(listEl, '.resource-item', '.drag-handle', (newOrderIds) => {
        updateResourceOrder(appState.currentSubject, newOrderIds.map(id => parseInt(id)));
    });
}

function createUpdateModal() {
    const modalDiv = document.createElement('div');
    modalDiv.className = 'modal-overlay';
    modalDiv.id = 'update-resource-modal';
    modalDiv.innerHTML = `
        <div class="modal">
            <h3>Kaynağı Güncelle</h3>
            <div class="input-group">
                <label>Kaynak Adı</label>
                <input type="text" id="update-res-name" class="modern-input">
            </div>
            <div class="input-group">
                <label>Tür</label>
                <select id="update-res-type" class="modern-input">
                    <option value="Konu Anlatımı">Konu Anlatımı</option>
                    <option value="Soru Bankası">Soru Bankası</option>
                    <option value="Branş Deneme">Branş Deneme</option>
                    <option value="Genel Deneme">Genel Deneme</option>
                    <option value="Video Ders">Video Ders</option>
                </select>
            </div>
            <div class="input-group">
                <label>Not (Opsiyonel)</label>
                <input type="text" id="update-res-note" class="modern-input">
            </div>
            <div class="input-group">
                <label>Durum</label>
                <select id="update-res-status" class="modern-input">
                    <option value="0">Devam Ediyor</option>
                    <option value="1">Bitti</option>
                </select>
            </div>
            <div class="input-group">
                <label>PDF Güncelle (Opsiyonel)</label>
                <div class="file-input-wrapper">
                    <input type="file" id="update-res-pdf-input" accept=".pdf,application/pdf" hidden>
                    <label for="update-res-pdf-input" id="update-res-pdf-label" class="file-input-label">
                        📄 Yeni PDF Seç (Değiştir)
                    </label>
                </div>
            </div>
            <div class="modal-footer">
                <button class="ghost-btn" id="cancel-update-res">İptal</button>
                <button class="primary-btn" id="save-update-res">Güncelle</button>
            </div>
        </div>
    `;
    document.body.appendChild(modalDiv);

    // Bind Close
    document.getElementById('cancel-update-res').addEventListener('click', () => {
        modalDiv.classList.remove('active');
    });
}

export function loadResources() {
    const listEl = document.getElementById('resource-list');
    const resources = getResources(appState.currentSubject);
    listEl.innerHTML = '';

    if (resources.length === 0) {
        listEl.innerHTML = '<p class="empty-state">Bu derste henüz kaynak bulunmuyor.</p>';
        return;
    }

    resources.forEach(r => {
        const item = document.createElement('div');
        item.className = 'resource-item' + (r.status === 1 ? ' finished' : '');
        item.dataset.id = r.id;

        item.innerHTML = `
            <div class="drag-handle">⠿</div>
            <div class="resource-content ${r.pdf_storage_key ? 'clickable-card' : ''}" title="${r.pdf_storage_key ? 'Kitabı açmak için tıklayın' : ''}">
                <div class="res-top-row">
                    <span class="resource-name">${r.name}</span>
                    <span class="resource-type">${r.type}</span>
                    <span class="status-badge ${r.status === 1 ? 'finished' : 'in-progress'}">
                        ${r.status === 1 ? 'Bitti' : 'Devam Ediyor'}
                    </span>
                </div>
                ${r.note ? `<div class="resource-note">${r.note}</div>` : ''}
                ${r.pdf_storage_key ? `<div class="pdf-indicator">📄 PDF Mevcut (Tıkla ve Aç)</div>` : ''}
            </div>
            <div class="resource-actions">
                ${r.pdf_storage_key ? `<button class="action-btn open-book-btn" title="Kitabı Aç">📖 Aç</button>` : ''}
                <button class="icon-btn update-resource-btn" title="Güncelle">✏️</button>
                <button class="icon-btn delete-resource-btn" title="Sil">✕</button>
            </div>
        `;

        const openBookBtn = item.querySelector('.open-book-btn');
        if (openBookBtn) {
            openBookBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openPDFViewer(r.id, r.name, r.last_page || 1);
            });
        }

        // Make entire content clickable for PDF
        if (r.pdf_storage_key) {
            item.querySelector('.resource-content').addEventListener('click', () => {
                openPDFViewer(r.id, r.name, r.last_page || 1);
            });
        }

        // Delete
        item.querySelector('.delete-resource-btn').addEventListener('click', async () => {
            if (await showConfirm('Bu kaynağı silmek istediğine emin misin?')) {
                deleteResource(r.id);
                loadResources();
                // Refresh other tabs
                loadNotesDashboard();
                loadQuestionsDashboard();
                loadQuestionsDashboard();
                loadTopics(appState.currentSubject);
                showToast('Kaynak silindi');
            }
        });

        // Update
        item.querySelector('.update-resource-btn').addEventListener('click', () => {
            openUpdateModal(r);
        });

        listEl.appendChild(item);
    });
}

function openUpdateModal(resource) {
    const modal = document.getElementById('update-resource-modal');
    document.getElementById('update-res-name').value = resource.name;
    document.getElementById('update-res-type').value = resource.type;
    document.getElementById('update-res-note').value = resource.note || '';
    document.getElementById('update-res-note').value = resource.note || '';
    document.getElementById('update-res-status').value = resource.status || 0;

    // Reset PDF input label
    const pdfLabel = document.getElementById('update-res-pdf-label');
    const pdfInput = document.getElementById('update-res-pdf-input');
    if (pdfInput) {
        pdfInput.value = ''; // Reset file selection
        pdfInput.addEventListener('change', () => {
            if (pdfInput.files.length > 0) {
                pdfLabel.textContent = `Seçilen: ${pdfInput.files[0].name}`;
                pdfLabel.style.color = 'var(--primary-color)';
            } else {
                pdfLabel.textContent = '📄 Yeni PDF Seç (Değiştir)';
                pdfLabel.style.color = 'var(--text-secondary)';
            }
        });
    }
    if (pdfLabel) {
        pdfLabel.textContent = resource.pdf_storage_key ? '📄 Mevcut PDF (Değiştirmek için tıkla)' : '📄 Yeni PDF Seç (Değiştir)';
    }

    // Unbind old listeners to avoid multiple triggers (simplified cloning)
    const saveBtn = document.getElementById('save-update-res');
    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);

    newSaveBtn.addEventListener('click', () => {
        const name = document.getElementById('update-res-name').value.trim();
        const type = document.getElementById('update-res-type').value;
        const note = document.getElementById('update-res-note').value.trim();
        const status = parseInt(document.getElementById('update-res-status').value);
        const pdfFile = document.getElementById('update-res-pdf-input').files[0];

        if (name) {
            updateResource(resource.id, name, type, note, status);

            if (pdfFile) {
                const reader = new FileReader();
                reader.onload = async (e) => {
                    const success = await saveResourcePDF(resource.id, e.target.result);
                    modal.classList.remove('active');
                    if (success) {
                        showToast('Kaynak ve PDF güncellendi');
                    } else {
                        const errType = saveResourcePDF._lastError || '';
                        if (errType === 'quota') {
                            showToast('PDF kaydedilemedi: Depolama alanı dolu. Küçük bir PDF deneyin.', 'error');
                        } else {
                            showToast(`PDF kaydedilemedi: ${errType || 'bilinmeyen hata'}`, 'error');
                        }
                    }
                    loadResources();
                    // Refresh other tabs
                    loadNotesDashboard();
                    loadQuestionsDashboard();
                    loadTopics(appState.currentSubject);
                };
                reader.onerror = () => {
                    modal.classList.remove('active');
                    showToast('PDF okunamadı: Dosya erişim hatası', 'error');
                };
                reader.readAsArrayBuffer(pdfFile);
            } else {
                modal.classList.remove('active');
                showToast('Kaynak güncellendi');
                loadResources();
                // Refresh other tabs
                loadNotesDashboard();
                loadQuestionsDashboard();
                loadTopics(appState.currentSubject);
            }
        }
    });

    // Add PDF Logic for Update Layout
    // Note: Updating PDF is not fully implemented in UI to keep it simple, but can be added if requested.
    // For now we just update metadata.

    modal.classList.add('active');
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.resource-item:not(.dragging)')];
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}
