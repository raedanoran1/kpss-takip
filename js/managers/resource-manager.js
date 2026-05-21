import { addResource, getResources, deleteResource, updateResourceOrder, updateResource, saveResourcePDF } from '../db.js';
import { appState } from '../state/app-state.js';
import { showConfirm, showToast } from '../utils/ui-utils.js';
import { openPDFViewer } from './pdf-viewer-manager.js';
import { loadNotesDashboard } from './notes-manager.js';
import { loadQuestionsDashboard } from './questions-manager.js';
import { loadTopics } from './topic-manager.js';
import { setupPointerDragSort } from '../utils/drag-sort.js';

const DUFS_BASE = 'http://192.168.1.36:5000';

let dufsSelectedFile = null;
let dufsAllFiles = [];
let dufsFilesLoaded = false;
let updateDufsSelectedFile = null;

function dufsProxyUrl(targetUrl) {
    return `/dufs-proxy?url=${encodeURIComponent(targetUrl)}`;
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function loadDufsFileList() {
    if (dufsFilesLoaded) return dufsAllFiles;
    try {
        const res = await fetch(dufsProxyUrl(`${DUFS_BASE}/?json`));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        dufsAllFiles = (data.paths || [])
            .filter(p => p.path_type === 'File' && p.name.toLowerCase().endsWith('.pdf'))
            .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
        dufsFilesLoaded = true;
    } catch(e) {
        console.warn('DUFS yüklenemedi:', e.message);
    }
    return dufsAllFiles;
}

async function downloadDufsFile(fileInfo) {
    const fileUrl = `${DUFS_BASE}/${encodeURIComponent(fileInfo.name)}`;
    const res = await fetch(dufsProxyUrl(fileUrl));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return new File([blob], fileInfo.name, { type: 'application/pdf' });
}

function bindDropdown(inputEl, dropdownEl, onSelect) {
    inputEl.addEventListener('focus', () => { if (!dufsFilesLoaded) loadDufsFileList(); });
    inputEl.addEventListener('input', async () => {
        const q = inputEl.value.trim().toLowerCase();
        if (!q) { dropdownEl.innerHTML = ''; dropdownEl.classList.add('hidden'); return; }
        const files = await loadDufsFileList();
        const filtered = files.filter(f => f.name.toLowerCase().includes(q)).slice(0, 30);
        if (!filtered.length) { dropdownEl.innerHTML = ''; dropdownEl.classList.add('hidden'); return; }
        dropdownEl.innerHTML = '';
        filtered.forEach(f => {
            const item = document.createElement('div');
            item.className = 'dufs-dd-item';
            item.innerHTML = `<span class="dufs-dd-name">${f.name.replace(/\.[^/.]+$/, '')}</span><span class="dufs-dd-size">${formatBytes(f.size)}</span>`;
            const doSelect = (e) => { e.preventDefault(); onSelect(f); };
            item.addEventListener('mousedown', doSelect);
            item.addEventListener('touchend', doSelect);
            dropdownEl.appendChild(item);
        });
        dropdownEl.classList.remove('hidden');
    });
    inputEl.addEventListener('blur', () => {
        setTimeout(() => dropdownEl.classList.add('hidden'), 200);
    });
}

function setupInlineDufsQuickAdd() {
    const searchInput = document.getElementById('dufs-quick-search');
    const dropdown = document.getElementById('dufs-quick-dropdown');
    const typeSelect = document.getElementById('dufs-quick-type');
    const addBtn = document.getElementById('dufs-quick-add-btn');
    if (!searchInput || !addBtn) return;

    let selectedFile = null;

    bindDropdown(searchInput, dropdown, (f) => {
        selectedFile = f;
        searchInput.value = f.name.replace(/\.[^/.]+$/, '');
        addBtn.disabled = false;
    });

    searchInput.addEventListener('input', () => {
        if (!selectedFile || searchInput.value.trim() !== selectedFile.name.replace(/\.[^/.]+$/, '')) {
            selectedFile = null;
            addBtn.disabled = true;
        }
    });

    addBtn.addEventListener('click', async () => {
        if (!selectedFile) return;
        const origText = addBtn.textContent;
        addBtn.disabled = true;
        addBtn.textContent = '⏳';
        try {
            const file = await downloadDufsFile(selectedFile);
            const name = selectedFile.name.replace(/\.[^/.]+$/, '');
            const type = typeSelect.value;
            const newId = addResource(appState.currentSubject, name, type, '', 0);
            if (newId && file) {
                const reader = new FileReader();
                reader.onload = async (e) => {
                    const success = await saveResourcePDF(newId, e.target.result);
                    showToast(success ? `"${name}" eklendi` : `"${name}" eklendi (PDF hatası)`, success ? '' : 'warning');
                    loadResources(); loadNotesDashboard(); loadQuestionsDashboard(); loadTopics(appState.currentSubject);
                };
                reader.readAsArrayBuffer(file);
            }
        } catch(e) {
            showToast(`İndirme hatası: ${e.message}`, 'error');
        }
        addBtn.disabled = false;
        addBtn.textContent = origText;
        searchInput.value = '';
        selectedFile = null;
        addBtn.disabled = true;
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

    setupInlineDufsQuickAdd();

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
                <label>PDF Değiştir (DUFS'dan Seç)</label>
                <div class="dufs-update-wrap">
                    <input type="text" id="update-dufs-search" class="modern-input" placeholder="☁️ PDF ara...">
                    <div id="update-dufs-dropdown" class="dufs-quick-dropdown hidden"></div>
                </div>
                <div id="update-dufs-selected" class="dufs-update-selected hidden"></div>
            </div>
            <div class="modal-footer">
                <button class="ghost-btn" id="cancel-update-res">İptal</button>
                <button class="primary-btn" id="save-update-res">Güncelle</button>
            </div>
        </div>
    `;
    document.body.appendChild(modalDiv);

    document.getElementById('cancel-update-res').addEventListener('click', () => {
        updateDufsSelectedFile = null;
        modalDiv.classList.remove('active');
    });

    bindDropdown(
        document.getElementById('update-dufs-search'),
        document.getElementById('update-dufs-dropdown'),
        (f) => {
            updateDufsSelectedFile = f;
            document.getElementById('update-dufs-search').value = f.name.replace(/\.[^/.]+$/, '');
            const sel = document.getElementById('update-dufs-selected');
            sel.textContent = `✅ ${f.name}`;
            sel.classList.remove('hidden');
        }
    );
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
    document.getElementById('update-res-status').value = resource.status || 0;

    updateDufsSelectedFile = null;
    const updateSearch = document.getElementById('update-dufs-search');
    if (updateSearch) updateSearch.value = '';
    const updateSelected = document.getElementById('update-dufs-selected');
    if (updateSelected) { updateSelected.textContent = ''; updateSelected.classList.add('hidden'); }

    const saveBtn = document.getElementById('save-update-res');
    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);

    newSaveBtn.addEventListener('click', async () => {
        const name = document.getElementById('update-res-name').value.trim();
        const type = document.getElementById('update-res-type').value;
        const note = document.getElementById('update-res-note').value.trim();
        const status = parseInt(document.getElementById('update-res-status').value);
        if (!name) return;

        updateResource(resource.id, name, type, note, status);

        if (updateDufsSelectedFile) {
            newSaveBtn.disabled = true;
            newSaveBtn.textContent = '⏳';
            try {
                const file = await downloadDufsFile(updateDufsSelectedFile);
                const reader = new FileReader();
                reader.onload = async (e) => {
                    const success = await saveResourcePDF(resource.id, e.target.result);
                    modal.classList.remove('active');
                    updateDufsSelectedFile = null;
                    showToast(success ? 'Kaynak ve PDF güncellendi' : 'Kaynak güncellendi (PDF hatası)', success ? '' : 'warning');
                    loadResources(); loadNotesDashboard(); loadQuestionsDashboard(); loadTopics(appState.currentSubject);
                };
                reader.readAsArrayBuffer(file);
            } catch(e) {
                newSaveBtn.disabled = false;
                newSaveBtn.textContent = 'Güncelle';
                showToast(`PDF indirilemedi: ${e.message}`, 'error');
            }
        } else {
            modal.classList.remove('active');
            showToast('Kaynak güncellendi');
            loadResources(); loadNotesDashboard(); loadQuestionsDashboard(); loadTopics(appState.currentSubject);
        }
    });

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
