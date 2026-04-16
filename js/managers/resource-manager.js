import { addResource, getResources, deleteResource, updateResourceOrder, updateResource, saveResourcePDF } from '../db.js';
import { appState } from '../state/app-state.js';
import { showConfirm, showToast } from '../utils/ui-utils.js';
import { openPDFViewer } from './pdf-viewer-manager.js';
import { loadNotesDashboard } from './notes-manager.js';
import { loadQuestionsDashboard } from './questions-manager.js';
import { loadTopics } from './topic-manager.js';
import { setupPointerDragSort } from '../utils/drag-sort.js';

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
        modal.classList.add('active');
    });

    cancelBtn.addEventListener('click', () => modal.classList.remove('active'));

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

        // PDF boyut kontrolü (iOS/iPad için kritik)
        if (pdfFile) {
            const sizeMB = pdfFile.size / (1024 * 1024);
            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
            const limitMB = isIOS ? 50 : 200;

            if (sizeMB > limitMB) {
                const device = isIOS ? 'iPad/iPhone' : 'bu cihaz';
                showToast(
                    `PDF çok büyük (${sizeMB.toFixed(0)} MB). ${device} için maksimum ${limitMB} MB. PDF'i sıkıştırın veya bölerek yükleyin.`,
                    'error'
                );
                return;
            }
            if (sizeMB > 20) {
                showToast(`Büyük PDF (${sizeMB.toFixed(0)} MB) yükleniyor, lütfen bekleyin...`, 'warning');
            }
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
                pdfLabel.textContent = `Seçilen Dosya: ${pdfInput.files[0].name}`;
                pdfLabel.style.color = 'var(--primary-color)';
            } else {
                pdfLabel.textContent = 'PDF Dosyası Seç (Opsiyonel)';
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
            // PDF boyut kontrolü
            if (pdfFile) {
                const sizeMB = pdfFile.size / (1024 * 1024);
                const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
                const limitMB = isIOS ? 50 : 200;
                if (sizeMB > limitMB) {
                    const device = isIOS ? 'iPad/iPhone' : 'bu cihaz';
                    showToast(
                        `PDF çok büyük (${sizeMB.toFixed(0)} MB). ${device} için maksimum ${limitMB} MB.`,
                        'error'
                    );
                    return;
                }
            }

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
