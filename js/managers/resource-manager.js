import { addResource, getResources, deleteResource, updateResourceOrder, updateResource, saveResourcePDF } from '../db.js';
import { appState } from '../state/app-state.js';
import { showConfirm, showToast } from '../utils/ui-utils.js';
import { openPDFViewer } from './pdf-viewer-manager.js';
import { loadNotesDashboard } from './notes-manager.js';
import { loadQuestionsDashboard } from './questions-manager.js';
import { loadTopics } from './topic-manager.js';
import { setupPointerDragSort } from '../utils/drag-sort.js';

const DUFS_URL_KEY = 'dufs_base_url';
const DUFS_DEFAULT = 'http://192.168.1.36:5000';

let dufsSelectedFile = null;
let dufsAllFiles = [];

function getDufsUrl() {
    return localStorage.getItem(DUFS_URL_KEY) || DUFS_DEFAULT;
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderDufsList(files, listEl) {
    if (!files.length) {
        listEl.innerHTML = '<div class="dufs-state-msg">PDF bulunamadı.</div>';
        return;
    }
    listEl.innerHTML = '';
    files.forEach(f => {
        const item = document.createElement('div');
        item.className = 'dufs-file-item';
        item.innerHTML = `
            <div class="dufs-file-icon">📄</div>
            <div class="dufs-file-info">
                <div class="dufs-file-name">${f.name}</div>
                <div class="dufs-file-size">${formatBytes(f.size)}</div>
            </div>
        `;
        item.addEventListener('click', () => selectDufsFile(f, listEl));
        listEl.appendChild(item);
    });
}

function dufsProxyUrl(targetUrl) {
    return `/dufs-proxy?url=${encodeURIComponent(targetUrl)}`;
}

async function fetchDufsFiles(baseUrl, listEl) {
    listEl.innerHTML = '<div class="dufs-state-msg">⏳ Yükleniyor...</div>';
    try {
        const res = await fetch(dufsProxyUrl(`${baseUrl}/?json`));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        dufsAllFiles = (data.paths || [])
            .filter(p => p.path_type === 'File' && p.name.toLowerCase().endsWith('.pdf'))
            .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
        renderDufsList(dufsAllFiles, listEl);
    } catch (e) {
        const isHttps = window.location.protocol === 'https:';
        const hint = isHttps
            ? '<br><small>💡 Bu özellik yalnızca yerel sunucu üzerinden (http://) çalışır.</small>'
            : '';
        listEl.innerHTML = `<div class="dufs-state-msg">❌ Bağlanamadı: ${e.message}${hint}</div>`;
    }
}

async function selectDufsFile(fileInfo, listEl) {
    const baseUrl = getDufsUrl();
    const fileUrl = `${baseUrl}/${encodeURIComponent(fileInfo.name)}`;
    listEl.innerHTML = `<div class="dufs-downloading"><div class="dufs-spinner"></div> İndiriliyor: ${fileInfo.name}</div>`;
    try {
        const res = await fetch(dufsProxyUrl(fileUrl));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        dufsSelectedFile = new File([blob], fileInfo.name, { type: 'application/pdf' });

        const pdfLabel = document.getElementById('resource-pdf-label');
        if (pdfLabel) {
            pdfLabel.textContent = `Seçilen Dosya: ${fileInfo.name}`;
            pdfLabel.style.color = 'var(--primary-color)';
        }
        const nameInput = document.getElementById('resource-name-input');
        if (nameInput && !nameInput.value.trim()) {
            nameInput.value = fileInfo.name.replace(/\.[^/.]+$/, '');
        }

        document.getElementById('dufs-picker-modal').classList.remove('active');
        showToast(`"${fileInfo.name}" seçildi`);
    } catch (e) {
        listEl.innerHTML = `<div class="dufs-state-msg">❌ İndirme hatası: ${e.message}</div>`;
    }
}

function setupDufsPicker() {
    const pickerModal = document.getElementById('dufs-picker-modal');
    const openBtn = document.getElementById('dufs-pick-btn');
    const closeBtn = document.getElementById('dufs-picker-close');
    const urlInput = document.getElementById('dufs-url-input');
    const refreshBtn = document.getElementById('dufs-refresh-btn');
    const searchInput = document.getElementById('dufs-search-input');
    const listEl = document.getElementById('dufs-file-list');

    if (!pickerModal || !openBtn) return;

    urlInput.value = getDufsUrl();

    openBtn.addEventListener('click', () => {
        dufsAllFiles = [];
        searchInput.value = '';
        urlInput.value = getDufsUrl();
        pickerModal.classList.add('active');
        fetchDufsFiles(getDufsUrl(), listEl);
    });

    closeBtn.addEventListener('click', () => pickerModal.classList.remove('active'));
    pickerModal.addEventListener('click', e => {
        if (e.target === pickerModal) pickerModal.classList.remove('active');
    });

    refreshBtn.addEventListener('click', () => {
        const url = urlInput.value.trim().replace(/\/$/, '');
        localStorage.setItem(DUFS_URL_KEY, url);
        searchInput.value = '';
        fetchDufsFiles(url, listEl);
    });

    urlInput.addEventListener('change', () => {
        const url = urlInput.value.trim().replace(/\/$/, '');
        localStorage.setItem(DUFS_URL_KEY, url);
    });

    searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim().toLowerCase();
        const filtered = q ? dufsAllFiles.filter(f => f.name.toLowerCase().includes(q)) : dufsAllFiles;
        renderDufsList(filtered, listEl);
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

    addBtn.addEventListener('click', () => {
        // Reset Inputs
        document.getElementById('resource-name-input').value = '';
        document.getElementById('resource-note-input').value = '';
        document.getElementById('resource-type-select').value = 'Konu Anlatımı';
        document.getElementById('resource-status-select').value = '0';
        const pdfLbl = document.getElementById('resource-pdf-label');
        if (pdfLbl) { pdfLbl.textContent = '📄 PDF Dosyası Seç'; pdfLbl.style.color = ''; }
        const pdfInp = document.getElementById('resource-pdf-input');
        if (pdfInp) pdfInp.value = '';
        dufsSelectedFile = null;
        modal.classList.add('active');
    });

    cancelBtn.addEventListener('click', () => {
        dufsSelectedFile = null;
        modal.classList.remove('active');
    });

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
        const pdfFile = dufsSelectedFile || pdfInput.files[0];

        if (!name) {
            showToast('Lütfen kaynak adı girin', 'warning');
            return;
        }

        const newId = addResource(appState.currentSubject, name, type, note, status);

        if (pdfFile && newId) {
            const reader = new FileReader();
            reader.onload = async (e) => {
                const success = await saveResourcePDF(newId, e.target.result);

                // Clear inputs immediately
                pdfInput.value = '';
                pdfLabel.textContent = 'PDF Dosyası Seç (Opsiyonel)';
                pdfLabel.style.color = 'var(--text-secondary)';
                dufsSelectedFile = null;

                modal.classList.remove('active');
                if (success) {
                    showToast('Kaynak ve PDF eklendi');
                } else {
                    const errType = saveResourcePDF._lastError || '';
                    if (errType === 'quota') {
                        showToast('PDF kaydedilemedi: Depolama alanı dolu. Küçük bir PDF deneyin.', 'error');
                    } else {
                        showToast(`PDF kaydedilemedi: ${errType || 'bilinmeyen hata'}`, 'error');
                    }
                }

                loadResources();
                // Refresh other tabs to show the new resource
                loadNotesDashboard();
                loadQuestionsDashboard();
                loadTopics(appState.currentSubject);
            };
            reader.onerror = () => {
                pdfInput.value = '';
                pdfLabel.textContent = 'PDF Dosyası Seç (Opsiyonel)';
                pdfLabel.style.color = 'var(--text-secondary)';
                dufsSelectedFile = null;
                modal.classList.remove('active');
                showToast('PDF okunamadı: Dosya erişim hatası', 'error');
                loadResources();
            };
            reader.readAsArrayBuffer(pdfFile);
        } else {
            modal.classList.remove('active');
            showToast('Kaynak eklendi');
            loadResources();
            // Refresh other tabs to show the new resource
            loadNotesDashboard();
            loadQuestionsDashboard();
            loadTopics(appState.currentSubject);
        }
    });

    const pdfInput = document.getElementById('resource-pdf-input');
    const pdfLabel = document.getElementById('resource-pdf-label');
    if (pdfInput && pdfLabel) {
        pdfInput.addEventListener('change', () => {
            if (pdfInput.files.length > 0) {
                const fileName = pdfInput.files[0].name;
                pdfLabel.textContent = `Seçilen Dosya: ${fileName}`;
                pdfLabel.style.color = 'var(--primary-color)';
                dufsSelectedFile = null;
                const nameInput = document.getElementById('resource-name-input');
                if (nameInput && !nameInput.value.trim()) {
                    nameInput.value = fileName.replace(/\.[^/.]+$/, '');
                }
            } else {
                pdfLabel.textContent = 'PDF Dosyası Seç (Opsiyonel)';
                pdfLabel.style.color = 'var(--text-secondary)';
            }
        });
    }

    setupDufsPicker();

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
