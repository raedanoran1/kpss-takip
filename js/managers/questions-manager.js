import { addQuestion, getDueQuestions, updateQuestionSRS, getTopicStats, deleteQuestion, getAllQuestions, addTopic, getTopics, getResources } from '../db.js';
import { appState } from '../state/app-state.js';
import { showConfirm, showAlert, showToast } from '../utils/ui-utils.js';
import { toggleDrawingMode } from './drawing-manager.js';

let reviewQueue = [];
let currentReviewIndex = 0;
let ratedQuestionIds = new Set(); // Rating verilen soruların ID'lerini tutar

export function setupQuestionsUI() {
    const openBtn = document.getElementById('open-add-question-btn');
    const modal = document.getElementById('add-question-modal');
    const cancelBtn = document.getElementById('cancel-add-question');
    const saveBtn = document.getElementById('save-new-question');
    const dropZone = document.getElementById('question-drop-zone');
    const fileInput = document.getElementById('question-file-input');
    const multiPreview = document.getElementById('multi-preview-container');
    const topicSelect = document.getElementById('question-topic-select');

    let currentImages = [];

    if (openBtn) {
        openBtn.addEventListener('click', () => {
            modal.classList.add('active');
            currentImages = [];
            multiPreview.innerHTML = '';
            dropZone.classList.remove('has-image');

            const topics = getTopics(appState.currentSubject);
            const resources = getResources(appState.currentSubject);
            topicSelect.innerHTML = '<option value="">Konu Seçin...</option>';

            // Add "New Topic" option
            const newTopicOpt = document.createElement('option');
            newTopicOpt.value = 'NEW_TOPIC';
            newTopicOpt.textContent = '➕ Yeni Konu Oluştur';
            newTopicOpt.style.fontWeight = '600';
            newTopicOpt.style.color = 'var(--primary-color)';
            topicSelect.appendChild(newTopicOpt);

            topics.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t.id;
                opt.textContent = t.name;
                topicSelect.appendChild(opt);
            });

            if (resources.length > 0) {
                const divider = document.createElement('option');
                divider.disabled = true;
                divider.textContent = '────────── Kaynaklar ──────────';
                topicSelect.appendChild(divider);

                resources.forEach(r => {
                    const opt = document.createElement('option');
                    opt.value = `res_${r.id}`;
                    opt.textContent = `📄 ${r.name}`;
                    topicSelect.appendChild(opt);
                });
            }

            // Reset new topic fields
            document.getElementById('q-new-topic-fields').classList.add('hidden');
            document.getElementById('q-new-topic-name').value = '';
            document.getElementById('q-new-topic-desc').value = '';
        });
    }

    const closeModal = () => modal.classList.remove('active');
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

    // Toggle new topic fields based on selection
    if (topicSelect) {
        topicSelect.addEventListener('change', () => {
            const newTopicFields = document.getElementById('q-new-topic-fields');
            if (topicSelect.value === 'NEW_TOPIC') {
                newTopicFields.classList.remove('hidden');
            } else {
                newTopicFields.classList.add('hidden');
            }
        });
    }

    setupReviewListeners();

    dropZone.addEventListener('click', (e) => {
        if (e.target === dropZone || dropZone.contains(e.target)) fileInput.click();
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) handleFiles(fileInput.files);
    });

    async function handleFiles(files) {
        for (const file of files) {
            if (!file.type.startsWith('image/')) continue;

            const resizedBase64 = await new Promise(resolve => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(resizeImage(e.target.result, 1200, 0.7));
                reader.readAsDataURL(file);
            });

            const id = Date.now() + Math.random();
            currentImages.push({ id, data: resizedBase64 });

            const item = document.createElement('div');
            item.className = 'preview-item';
            item.innerHTML = `
                <img src="${resizedBase64}" class="preview-thumb">
                <button class="remove-img-btn" data-id="${id}">✕</button>
            `;

            item.querySelector('.remove-img-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                currentImages = currentImages.filter(img => img.id !== id);
                item.remove();
                if (currentImages.length === 0) dropZone.classList.remove('has-image');
            });

            multiPreview.appendChild(item);
            dropZone.classList.add('has-image');
        }
    }

    document.addEventListener('paste', (e) => {
        if (!modal.classList.contains('active')) return;
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        for (const item of items) {
            if (item.type.indexOf('image') !== -1) {
                const blob = item.getAsFile();
                handleFiles([blob]);
            }
        }
    });

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            let topicId = topicSelect.value;

            // Handle new topic creation
            if (topicId === 'NEW_TOPIC') {
                const newTopicName = document.getElementById('q-new-topic-name').value.trim();
                const newTopicDesc = document.getElementById('q-new-topic-desc').value.trim();

                if (!newTopicName) {
                    await showAlert('Lütfen yeni konu başlığını girin.');
                    return;
                }

                // Create the topic and get its ID
                topicId = addTopic(appState.currentSubject, newTopicName, newTopicDesc);
                showToast('Yeni konu oluşturuldu: ' + newTopicName);
            }

            if (!topicId) {
                await showAlert('Lütfen bir konu başlığı seçin.');
                return;
            }
            if (currentImages.length === 0) {
                await showAlert('Lütfen en az bir görsel ekleyin.');
                return;
            }

            saveBtn.textContent = 'Kaydediliyor...';
            saveBtn.disabled = true;

            try {
                const total = currentImages.length;
                let done = 0;
                for (const imgObj of currentImages) {
                    await addQuestion(appState.currentSubject, topicId, imgObj.data);
                    done++;
                    saveBtn.textContent = `Kaydediliyor (${done}/${total})...`;
                }
                currentImages = []; // Reset locally
                closeModal();
                loadQuestionsDashboard();
            } catch (err) {
                console.error(err);
                await showAlert('Hata oluştu!');
            } finally {
                saveBtn.textContent = 'Kaydet';
                saveBtn.disabled = false;
            }
        });
    }

    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
}

function resizeImage(base64Str, maxWidth = 800, quality = 0.7) {
    return new Promise((resolve) => {
        const img = new Image();
        img.src = base64Str;
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;
            if (width > maxWidth) {
                height = Math.round((height * maxWidth) / width);
                width = maxWidth;
            }
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
    });
}

// --- REVIEW FUNCTIONS ---

export async function loadQuestionsDashboard(subject = null) {
    const dashboard = document.getElementById('questions-dashboard');
    const emptyState = document.getElementById('questions-empty-state');
    const topicList = document.getElementById('topic-questions-list');
    const reviewInterface = document.getElementById('review-interface');

    reviewInterface.classList.add('hidden');
    dashboard.classList.remove('hidden');
    topicList.innerHTML = '';

    // Subject parametresi verilmişse onu kullan, yoksa appState'ten al
    const currentSubject = subject !== null ? subject : appState.currentSubject;
    
    const topics = getTopics(currentSubject);
    // Assuming getResources is already available in sidepanel context from db.js
    const resources = typeof getResources === 'function' ? getResources(currentSubject) : [];

    const stats = getTopicStats(currentSubject);

    let totalDue = 0;
    let grandTotal = 0;

    Object.values(stats).forEach(s => {
        totalDue += s.due;
        grandTotal += s.total;
    });

    if (topics.length === 0 && resources.length === 0 && grandTotal === 0) {
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');

    // Render topics
    topics.forEach(topic => {
        renderQuestionTopicItem(topic.id, topic.name, stats[topic.id] || { due: 0, total: 0 }, topicList);
    });

    // Render resources
    resources.forEach(res => {
        const id = `res_${res.id}`;
        renderQuestionTopicItem(id, `📄 ${res.name}`, stats[id] || { due: 0, total: 0 }, topicList);
    });

    const studyAllBtn = document.getElementById('start-all-review-btn');
    studyAllBtn.textContent = `🧠 Karışık Tekrar (${totalDue}/${grandTotal})`;
    studyAllBtn.disabled = totalDue === 0;
}

function renderQuestionTopicItem(id, name, s, container) {
    const item = document.createElement('div');
    item.className = 'topic-q-item';
    item.innerHTML = `
        <div class="topic-q-info">
            <span class="topic-q-name">${name}</span>
        </div>
        <div class="topic-q-right">
            <button class="list-btn-sm" data-id="${id}" title="Kart Listesi">📋</button>
            <span class="due-badge ${s.due === 0 ? 'zero' : ''}">çalışılacak=${s.due}, toplamkart=${s.total}</span>
        </div>
    `;

    item.addEventListener('click', (e) => {
        if (e.target.closest('.list-btn-sm')) {
            openManageCardsModal(id);
        } else {
            if (s.due > 0) startReview(id);
            else showAlert('Bu konu için şu an tekrar edilecek soru yok.');
        }
    });

    container.appendChild(item);
}

function startReview(topicId = null) {
    const dashboard = document.getElementById('questions-dashboard');
    const reviewInterface = document.getElementById('review-interface');

    const dueQuestions = getDueQuestions(appState.currentSubject, topicId);
    if (dueQuestions.length === 0) {
        showAlert('Tekrar edilecek soru kalmadı!');
        return;
    }

    reviewQueue = dueQuestions;
    currentReviewIndex = 0;
    ratedQuestionIds.clear(); // Yeni review başladığında rating verilen kartları temizle

    dashboard.classList.remove('hidden');
    reviewInterface.classList.remove('hidden');

    showNextCard();
}

async function showNextCard() {
    if (currentReviewIndex >= reviewQueue.length) {
        await showAlert('Tebrikler! Seçili bölümün tekrarını tamamladın.');
        loadQuestionsDashboard();
        return;
    }

    const q = reviewQueue[currentReviewIndex];
    const img = document.getElementById('review-image');
    const totalSpan = document.getElementById('review-total');
    const currentSpan = document.getElementById('review-current');

    totalSpan.textContent = reviewQueue.length;
    currentSpan.textContent = currentReviewIndex + 1;

    img.src = '';
    const stored = await chrome.storage.local.get(q.image_storage_key);
    if (stored[q.image_storage_key]) {
        img.src = stored[q.image_storage_key];
    } else {
        img.alt = 'Görsel yüklenemedi.';
    }

    // Update navigation arrows state
    updateNavButtonsState();
}

function setupReviewListeners() {
    const studyAllBtn = document.getElementById('start-all-review-btn');
    const ratingBtns = document.querySelectorAll('.rate-btn');
    const exitBtn = document.getElementById('exit-review-btn');
    const openAddBtn = document.getElementById('open-add-question-btn');
    const deleteQBtn = document.getElementById('delete-current-q-btn');

    if (studyAllBtn) studyAllBtn.addEventListener('click', () => startReview());

    if (exitBtn) exitBtn.addEventListener('click', () => loadQuestionsDashboard());

    if (deleteQBtn) {
        deleteQBtn.addEventListener('click', async () => {
            if (await showConfirm('Bu soruyu kalıcı olarak silmek istediğine emin misin?')) {
                const q = reviewQueue[currentReviewIndex];
                await deleteQuestion(q.id, q.image_storage_key);
                reviewQueue.splice(currentReviewIndex, 1);
                if (reviewQueue.length === 0 || currentReviewIndex >= reviewQueue.length) {
                    await showAlert('Soru silindi. Tekrar edilecek soru kalmadı.');
                    loadQuestionsDashboard();
                } else {
                    showNextCard();
                }
            }
        });
    }

    if (openAddBtn) {
        openAddBtn.addEventListener('click', () => {
            document.getElementById('add-question-modal').classList.add('active');
        });
    }

    ratingBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const rating = parseInt(btn.getAttribute('data-rating'));
            handleRating(rating);
        });
    });

    // Drawing Tool
    const drawingBtn = document.getElementById('toggle-drawing-q-btn');
    if (drawingBtn) {
        drawingBtn.onclick = () => toggleDrawingMode('toggle-drawing-q-btn');
    }

    // Navigation Arrows
    const prevBtn = document.getElementById('q-nav-prev');
    const nextBtn = document.getElementById('q-nav-next');

    if (prevBtn) {
        // Remove old listeners (clone trick)
        const newPrev = prevBtn.cloneNode(true);
        prevBtn.parentNode.replaceChild(newPrev, prevBtn);
        newPrev.addEventListener('click', (e) => {
            e.stopPropagation();
            showPreviousCard();
        });
    }

    if (nextBtn) {
        const newNext = nextBtn.cloneNode(true);
        nextBtn.parentNode.replaceChild(newNext, nextBtn);
        newNext.addEventListener('click', (e) => {
            e.stopPropagation();
            showNextCardNoRate();
        });
    }

    // Klavye kısayolları: Sol/Sağ ok tuşları ile gezinme
    document.addEventListener('keydown', (e) => {
        const reviewInterface = document.getElementById('review-interface');
        // Sadece review interface aktifken çalışsın
        if (!reviewInterface || reviewInterface.classList.contains('hidden')) return;
        
        // Input alanlarında yazı yazarken çalışmasın
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            showPreviousCard();
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            showNextCardNoRate();
        }
    });
}

function handleRating(rating) {
    const q = reviewQueue[currentReviewIndex];
    
    // UI'ı hemen güncelle (kullanıcı deneyimi için)
    ratedQuestionIds.add(q.id);
    reviewQueue.splice(currentReviewIndex, 1);

    if (reviewQueue.length === 0) {
        // DB işlemini arka planda yap, sonra alert göster
        setTimeout(() => updateQuestionSRS(q.id, rating), 0);
        showAlert('Tebrikler! Seçili bölümün tekrarını tamamladın.');
        loadQuestionsDashboard();
        return;
    }

    // Eğer son kart silindiyse index'i başa sar
    if (currentReviewIndex >= reviewQueue.length) {
        currentReviewIndex = 0;
    }

    // UI'ı hemen güncelle
    showNextCard();
    
    // DB işlemini arka planda yap (asenkron, UI'ı bloklamaz)
    setTimeout(() => updateQuestionSRS(q.id, rating), 0);
}

function showPreviousCard() {
    if (reviewQueue.length === 0) return;
    // Döngüsel gezinme: 1. karttayken geri -> son karta git
    if (currentReviewIndex === 0) {
        currentReviewIndex = reviewQueue.length - 1;
    } else {
        currentReviewIndex--;
    }
    showNextCard();
}

function showNextCardNoRate() {
    // KRİTİK: Son sorudayken sağ oka basılırsa 1. soruya (döngüsel) geçiş
    if (currentReviewIndex >= reviewQueue.length - 1) {
        // Son sorudayız, 1. soruya git
        currentReviewIndex = 0;
    } else {
        // Normal şekilde sonraki soruya git
        currentReviewIndex++;
    }
    showNextCard();
}

function updateNavButtonsState() {
    const prevBtn = document.getElementById('q-nav-prev');
    const nextBtn = document.getElementById('q-nav-next');

    if (prevBtn) {
        // KRİTİK: Döngüsel gezinme için buton hiçbir zaman disabled olmamalı
        // 1. sorudayken de tıklanabilir olmalı (son soruya gidecek)
        prevBtn.disabled = false;
        prevBtn.classList.remove('disabled');
    }

    if (nextBtn) {
        // Son sorudayken de tıklanabilir olmalı (1. soruya gidecek - döngüsel)
        nextBtn.disabled = false;
        nextBtn.classList.remove('disabled');
    }
}

// --- MANAGEMENT MODAL ---

async function openManageCardsModal(topicId) {
    const modal = document.getElementById('manage-cards-modal');
    const listContainer = document.getElementById('manage-cards-list');
    const closeBtn = document.getElementById('close-manage-cards');

    modal.classList.add('active');
    listContainer.innerHTML = '<p class="loading-state">Yükleniyor...</p>';

    const questions = getAllQuestions(appState.currentSubject, topicId);
    renderManageList(questions, topicId);

    const closeModal = () => modal.classList.remove('active');
    closeBtn.onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
}

async function renderManageList(questions, topicId) {
    const listContainer = document.getElementById('manage-cards-list');
    listContainer.innerHTML = '';

    if (questions.length === 0) {
        listContainer.innerHTML = '<p class="empty-state">Bu konuda kayıtlı soru bulunamadı.</p>';
        return;
    }

    for (const q of questions) {
        const item = document.createElement('div');
        item.className = 'manage-card-item';
        const dateStr = new Date(q.created_at).toLocaleDateString('tr-TR');

        item.innerHTML = `
            <img class="manage-card-preview" src="">
            <div class="manage-card-info">
                <div class="manage-card-date">Eklenme: ${dateStr}</div>
            </div>
            <button class="manage-card-delete" title="Sili">✕</button>
        `;

        // Load preview
        chrome.storage.local.get(q.image_storage_key).then(data => {
            if (data[q.image_storage_key]) {
                item.querySelector('img').src = data[q.image_storage_key];
            }
        });

        item.querySelector('.manage-card-delete').addEventListener('click', async () => {
            await deleteQuestion(q.id, q.image_storage_key);
            item.remove();
            loadQuestionsDashboard(); // background refresh
        });

        listContainer.appendChild(item);
    }
}
