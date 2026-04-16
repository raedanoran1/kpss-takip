import { getTopics, toggleTopicStatus, getProgress, addTopic, deleteTopic, updateTopicOrder, getTopicStudyStats, getSubjectTotalStats, addToToday, getResources, getStudyNotes, getAllQuestions, getTopicNoteStats } from '../db.js';
import { appState } from '../state/app-state.js';
import { formatDuration } from '../utils/format-utils.js';
import { showToast } from '../utils/ui-utils.js';
import { initStudySession } from './study-session-manager.js';
import { openPDFViewer } from './pdf-viewer-manager.js';
// Removed: import { uncommitedTimes, uncommitedQs } from './study-session-manager.js';

export function setupModals() {
    const addBtn = document.getElementById('add-topic-btn');
    const modal = document.getElementById('add-topic-modal');
    const cancelBtn = document.getElementById('cancel-add-topic');
    const saveBtn = document.getElementById('save-new-topic');
    const input = document.getElementById('new-topic-name');

    addBtn.addEventListener('click', () => {
        modal.classList.add('active');
        input.focus();
    });

    const closeModal = () => {
        modal.classList.remove('active');
        input.value = '';
    };

    cancelBtn.addEventListener('click', closeModal);

    saveBtn.addEventListener('click', () => {
        const name = input.value.trim();
        if (name) {
            addTopic(appState.currentSubject, name);
            loadTopics(appState.currentSubject);
            closeModal();
        }
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });
}

export function loadTopics(subject) {
    const listEl = document.getElementById('topic-list');
    listEl.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';

    const topics = getTopics(subject);
    const resources = getResources(subject);
    const progress = getProgress(subject);

    updateProgressUI(progress, subject);

    listEl.innerHTML = '';

    if (topics.length === 0 && resources.length === 0) {
        listEl.innerHTML = '<div class="empty-state"><p>Bu derste konu veya kaynak bulunamadı.</p></div>';
        return;
    }

    // Get note stats for audio counts
    const noteStats = getTopicNoteStats(subject);

    // Render topics
    topics.forEach(topic => {
        const audioCount = noteStats[topic.id] ? noteStats[topic.id].audio : 0;
        renderTopicRow(topic.id, topic.name, topic.description, topic.status === 2, listEl, false, audioCount);
    });

    // Render resources as topics
    resources.forEach(res => {
        const audioCount = noteStats[`res_${res.id}`] ? noteStats[`res_${res.id}`].audio : 0;
        renderTopicRow(`res_${res.id}`, `📄 ${res.name}`, res.type, false, listEl, true, audioCount);
    });
}

function renderTopicRow(id, nameText, descText, isCompleted, listEl, isResource = false, audioCount = 0) {
    const item = document.createElement('li');
    item.className = `topic-item ${isCompleted ? 'completed' : ''} ${isResource ? 'resource-topic' : ''}`;
    item.draggable = !isResource;
    item.setAttribute('data-id', id);

    const info = document.createElement('div');
    info.className = 'topic-info';

    const titleRow = document.createElement('div');
    titleRow.className = 'topic-title-row';

    if (!isResource) {
        const handle = document.createElement('div');
        handle.className = 'drag-handle';
        handle.innerHTML = '⠿';
        titleRow.appendChild(handle);
    }

    const name = document.createElement('span');
    name.className = 'topic-name';
    name.textContent = nameText;
    titleRow.appendChild(name);

    const desc = document.createElement('div');
    desc.className = 'topic-description';
    desc.textContent = descText || '';

    info.appendChild(titleRow);
    info.appendChild(desc);
    item.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'topic-actions';

    const dbStats = getTopicStudyStats(id);
    const liveTime = (dbStats ? dbStats.time : 0) + (appState.uncommitedTimes[id] || 0);
    const liveQs = dbStats ? dbStats.questions : 0;
    const timeStr = formatDuration(liveTime);

    // Using passed audioCount instead of fetching inside loop
    const statsBadge = document.createElement('div');
    statsBadge.className = 'topic-stats-badge list-view';
    statsBadge.innerHTML = `
        <span class="topic-stat-chip">⏱️ ${timeStr}</span>
        <span class="topic-stat-chip">✍️ ${liveQs}</span>
        ${audioCount > 0 ? `<span class="topic-stat-chip" title="${audioCount} ses kaydı">🎤 ${audioCount}</span>` : ''}
    `;

    const chatBtn = document.createElement('button');
    chatBtn.className = 'topic-chat-btn';
    chatBtn.innerHTML = '💬';
    chatBtn.title = 'Notlar / Chat';
    chatBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        initStudySession(id, nameText, appState.currentSubject, null);
    });

    actions.appendChild(statsBadge);
    actions.appendChild(chatBtn);

    if (!isResource) {
        const studyBtn = document.createElement('button');
        studyBtn.className = 'study-topic-btn';
        studyBtn.textContent = ' Çalış';
        studyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            addToToday(id, appState.currentSubject);
            showToast('Bugün çalışılacaklara eklendi');
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'topic-delete-btn';
        deleteBtn.innerHTML = '✕';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            item.style.opacity = '0';
            item.style.transform = 'translateX(20px)';
            setTimeout(() => {
                deleteTopic(id);
                loadTopics(appState.currentSubject);
            }, 200);
        });
        actions.appendChild(studyBtn);
        actions.appendChild(deleteBtn);
    } else {
        // Resource-specific buttons
        const studyBtn = document.createElement('button');
        studyBtn.className = 'study-topic-btn';
        studyBtn.textContent = ' Çalış';
        studyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            addToToday(id, appState.currentSubject);
            showToast('Bugün çalışılacaklara eklendi');
        });

        const pdfBtn = document.createElement('button');
        pdfBtn.className = 'topic-chat-btn'; // Reuse similar styling
        pdfBtn.innerHTML = '📖';
        pdfBtn.title = 'PDF Aç';
        pdfBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const resourceId = parseInt(id.replace('res_', ''));
            // Get resource details to find last page
            const resources = getResources(appState.currentSubject);
            const resource = resources.find(r => r.id === resourceId);
            if (resource && resource.pdf_storage_key) {
                openPDFViewer(resourceId, resource.name, resource.last_page || 1);
            } else {
                showToast('PDF bulunamadı', 'error');
            }
        });

        actions.appendChild(studyBtn);
        actions.appendChild(pdfBtn);

        // Add click handler to show resource content
        item.addEventListener('click', (e) => {
            // Don't trigger if clicking buttons
            if (e.target.closest('button')) return;
            const resourceId = parseInt(id.replace('res_', ''));
            showResourceContentViewer(resourceId, nameText);
        });
    }

    item.appendChild(actions);
    listEl.appendChild(item);
}

// Show resource content viewer (similar to knowledge base but for single resource)
async function showResourceContentViewer(resourceId, resourceName) {
    const viewer = document.getElementById('resource-content-viewer');
    const content = document.getElementById('resource-viewer-content');
    const title = document.getElementById('resource-viewer-title');

    if (!viewer || !content || !title) return;

    title.textContent = resourceName;
    content.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>İçerik yükleniyor...</span></div>';
    viewer.classList.remove('hidden');

    // Get all notes and questions for this resource
    const notes = getStudyNotes(`res_${resourceId}`);
    const questions = getAllQuestions(appState.currentSubject, `res_${resourceId}`);

    // Merge and Sort Content
    let allItems = [];

    // Process Notes
    notes.forEach(n => {
        allItems.push({
            type: 'note',
            data: n,
            date: new Date(n.created_at || Date.now())
        });
    });

    // Process Questions
    questions.forEach(q => {
        allItems.push({
            type: 'question',
            data: q,
            date: new Date(q.created_at || Date.now())
        });
    });

    // Sort Logic Variables
    let currentSortMode = 'time'; // 'time' or 'group'

    // Helper to generate string HTML for a single item object
    async function renderItemHTML(item) {
        const dateStr = item.date.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        let h = '';
        if (item.type === 'note') {
            const note = item.data;
            if (note.image_storage_key) {
                const d = await chrome.storage.local.get(note.image_storage_key);
                const s = d[note.image_storage_key] || '';
                h = `<div class="resource-item image-item">
                    <div class="item-meta" style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:5px;">📝 Not • ${dateStr}</div>
                    <img src="${s}" class="clickable-img" alt="Note" style="max-width: 100%; border-radius: 8px; margin-bottom: 0.5rem; cursor: pointer;">
                    ${note.content ? `<p>${note.content}</p>` : ''}
                </div>`;
            } else if (note.audio_storage_key) {
                h = `<div class="resource-item audio-item" style="display: flex; flex-direction:column; gap: 5px;">
                    <div class="item-meta" style="font-size:0.75rem; color:var(--text-secondary);">🎤 Ses Kaydı • ${dateStr}</div>
                    <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                        <button class="play-audio-btn" data-key="${note.audio_storage_key}">🔊 Oynat</button>
                        <select class="audio-speed-select" style="padding: 5px; border-radius: 4px; border: 1px solid var(--border-color);">
                            <option value="1">1x</option>
                            <option value="1.5">1.5x</option>
                            <option value="2">2x</option>
                        </select>
                    </div>
                </div>`;
            } else if (note.content) {
                h = `<div class="resource-item text-item">
                    <div class="item-meta" style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:5px;">📝 Not • ${dateStr}</div>
                    <p>${note.content}</p>
                </div>`;
            }
        } else if (item.type === 'question') {
            const q = item.data;
            if (q.image_storage_key) {
                const d = await chrome.storage.local.get(q.image_storage_key);
                const s = d[q.image_storage_key] || '';
                h = `<div class="resource-item question-item" style="border-left: 4px solid var(--warning-color, #f59e0b);">
                    <div class="item-meta" style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:5px;">❓ Soru • ${dateStr}</div>
                    <img src="${s}" class="clickable-img" alt="Question" style="max-width: 100%; border-radius: 8px; cursor: pointer;">
                </div>`;
            }
        }
        return h;
    }

    // Function to render items based on sort mode
    const renderItems = async () => {
        let htmlInner = '';

        if (currentSortMode === 'time') {
            const sortedItems = [...allItems].sort((a, b) => a.date - b.date);

            if (sortedItems.length === 0) {
                htmlInner = '<div class="empty-state">Bu kaynak için henüz içerik eklenmemiş.</div>';
            } else {
                htmlInner += '<div class="resource-section"><div class="resource-items">';
                for (const item of sortedItems) {
                    htmlInner += await renderItemHTML(item);
                }
                htmlInner += '</div></div>';
            }
        } else if (currentSortMode === 'group') {
            // Rerender logic for Group Mode
            let groupHtml = '';

            // Notes Group
            const curNotes = allItems.filter(i => i.type === 'note').sort((a, b) => a.date - b.date);
            if (curNotes.length > 0) {
                groupHtml += '<div class="resource-section"><h4>📝 Notlar</h4><div class="resource-items">';
                for (const item of curNotes) { groupHtml += await renderItemHTML(item); }
                groupHtml += '</div></div>';
            }

            // Questions Group
            const curQuestions = allItems.filter(i => i.type === 'question').sort((a, b) => a.date - b.date);
            if (curQuestions.length > 0) {
                groupHtml += '<div class="resource-section"><h4>❓ Sorular</h4><div class="resource-items">';
                for (const item of curQuestions) { groupHtml += await renderItemHTML(item); }
                groupHtml += '</div></div>';
            }
            htmlInner = groupHtml;
        }

        // Inject content
        const contentContainer = document.getElementById('resource-viewer-items-container');
        if (contentContainer) contentContainer.innerHTML = htmlInner;

        // Re-attach listeners for new content
        attachDynamicListeners();
    };

    // Helper to attach listeners
    const attachDynamicListeners = () => {
        // Image click için artık yeni sekme açılmıyor; sadece görüntüleme alanında kalır

        // Audio players
        content.querySelectorAll('.play-audio-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const key = btn.dataset.key;
                const speedSelect = btn.nextElementSibling;
                const speed = speedSelect ? parseFloat(speedSelect.value) : 1.0;
                const audioData = await chrome.storage.local.get(key);
                if (audioData[key]) {
                    try {
                        const audio = new Audio(audioData[key]);
                        audio.playbackRate = speed;
                        const playPromise = audio.play();
                        if (playPromise !== undefined) {
                            await playPromise;
                        }
                        const originalText = btn.textContent;
                        btn.textContent = '⏸️ Çalıyor...';
                        audio.onended = () => btn.textContent = originalText;
                        audio.onpause = () => btn.textContent = originalText;
                    } catch (err) {
                        console.error('Audio playback error (topic manager):', err);
                    }
                }
            });
        });
    };

    // Build initial skeleton HTML
    let html = `
        <div class="resource-params-controls" style="display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; align-items: center;">
            <select id="resource-sort-select" class="modern-input" style="width: auto;">
                <option value="time">📅 Oluşturulma Tarihine Göre (Varsayılan)</option>
                <option value="group">📑 Türüne Göre Grupla (Not/Soru)</option>
            </select>
            <button id="toggle-audio-visibility-btn" class="secondary-btn" data-visible="true">🔊 Ses Kayıtlarını Gizle</button>
            <button id="resource-sort-export-btn" class="secondary-btn">📄 Tüm Not & Soruları PDF İndir</button>
        </div>
        <div id="resource-viewer-items-container"></div>
    `;

    content.innerHTML = html;

    // Initial Render
    currentSortMode = 'time'; // Enforce default state
    await renderItems();

    // Sort Change Listener
    const sortSelect = document.getElementById('resource-sort-select');
    if (sortSelect) {
        sortSelect.value = 'time'; // Enforce UI sync
        sortSelect.addEventListener('change', async (e) => {
            currentSortMode = e.target.value;
            await renderItems();
        });
    }

    // --- Event Listeners ---

    // 1. Audio Visibility Toggle
    const toggleAudioBtn = content.querySelector('#toggle-audio-visibility-btn');
    if (toggleAudioBtn) {
        toggleAudioBtn.addEventListener('click', () => {
            const isVisible = toggleAudioBtn.dataset.visible === 'true';
            const audioItems = content.querySelectorAll('.audio-item');

            audioItems.forEach(item => {
                item.style.display = isVisible ? 'none' : 'flex';
            });

            if (isVisible) {
                toggleAudioBtn.textContent = '🔊 Ses Kayıtlarını Göster';
                toggleAudioBtn.dataset.visible = 'false';
            } else {
                toggleAudioBtn.textContent = '🔊 Ses Kayıtlarını Gizle';
                toggleAudioBtn.dataset.visible = 'true';
            }
        });
    }

    // Setup close button
    const closeBtn = document.getElementById('close-resource-viewer-btn');
    if (closeBtn) {
        closeBtn.onclick = () => viewer.classList.add('hidden');
    }

    // Ortak PDF export handler
    const handleExportPdf = async () => {
            const toggleAudioBtn = content.querySelector('#toggle-audio-visibility-btn');
            const areAudioNotesHidden = toggleAudioBtn ? toggleAudioBtn.dataset.visible === 'false' : false;

            showToast('PDF hazırlanıyor...');

            // 1. Merge and Sort Content
            let allItems = [];

            // Add Notes
            notes.forEach(n => {
                allItems.push({
                    type: 'note',
                    data: n,
                    date: new Date(n.created_at || Date.now())
                });
            });

            // Add Questions
            questions.forEach(q => {
                allItems.push({
                    type: 'question',
                    data: q,
                    date: new Date(q.created_at || Date.now())
                });
            });

            // Sort Chronologically
            allItems.sort((a, b) => a.date - b.date);

            // 2. Fetch Images Asynchronously
            const itemsWithContent = [];

            for (const item of allItems) {
                if (item.type === 'note') {
                    const n = item.data;
                    // Skip audio if hidden
                    if (n.audio_storage_key && areAudioNotesHidden) continue;

                    let imgSrc = null;
                    if (n.image_storage_key) {
                        try {
                            const d = await chrome.storage.local.get(n.image_storage_key);
                            imgSrc = d[n.image_storage_key];
                        } catch (e) { console.error(e); }
                    }
                    itemsWithContent.push({ ...item, imgSrc });
                } else if (item.type === 'question') {
                    const q = item.data;
                    let imgSrc = null;
                    if (q.image_storage_key) {
                        try {
                            const d = await chrome.storage.local.get(q.image_storage_key);
                            imgSrc = d[q.image_storage_key];
                        } catch (e) { console.error(e); }
                    }
                    itemsWithContent.push({ ...item, imgSrc });
                }
            }

            // 3. Generate HTML
            const subjectName = appState.currentSubject.toUpperCase();
            const printWindow = window.open('', '_blank');

            let htmlContent = `
                 <html>
                 <head>
                     <title>${resourceName} - Çalışma Notları</title>
                     <style>
                         body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 40px; color: #333; line-height: 1.6; max-width: 800px; margin: 0 auto; }
                         h1 { color: #4f46e5; border-bottom: 2px solid #4f46e5; padding-bottom: 15px; margin-bottom: 30px; }
                         .meta { color: #6b7280; margin-bottom: 40px; font-size: 0.95rem; }
                         .item { margin-bottom: 25px; page-break-inside: avoid; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; background: #fff; }
                         .item.question { border-left: 4px solid #f59e0b; }
                         .item.note { border-left: 4px solid #3b82f6; }
                         .item.audio { border-left: 4px solid #10b981; background: #f0fdf4; }
                         .item-header { display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 0.85rem; color: #9ca3af; }
                         .item-content p { margin: 0 0 10px 0; white-space: pre-wrap; }
                         img { max-width: 100%; height: auto; border-radius: 6px; margin-top: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
                         .audio-placeholder { font-style: italic; color: #059669; }
                         @media print { 
                            .no-print { display: none; } 
                            body { padding: 0; }
                            .item { break-inside: avoid; }
                         }
                     </style>
                 </head>
                 <body>
                     <h1>${resourceName}</h1>
                     <div class="meta">
                        <div><strong>Ders:</strong> ${subjectName}</div>
                        <div><strong>Oluşturulma Tarihi:</strong> ${new Date().toLocaleDateString('tr-TR')}</div>
                        <div><strong>Toplam İçerik:</strong> ${itemsWithContent.length}</div>
                     </div>
             `;

            if (itemsWithContent.length === 0) {
                htmlContent += `<p>Görüntülenecek içerik bulunamadı.</p>`;
            } else {
                itemsWithContent.forEach(item => {
                    const dateStr = item.date.toLocaleString('tr-TR');

                    if (item.type === 'note') {
                        const n = item.data;
                        if (n.audio_storage_key) {
                            htmlContent += `
                                <div class="item audio">
                                    <div class="item-header">
                                        <span>SESLİ NOT</span>
                                        <span>${dateStr}</span>
                                    </div>
                                    <div class="item-content">
                                        <div class="audio-placeholder">🎤 Ses Kaydı (PDF'te oynatılamaz)</div>
                                    </div>
                                </div>`;
                        } else {
                            htmlContent += `
                                <div class="item note">
                                    <div class="item-header">
                                        <span>NOT</span>
                                        <span>${dateStr}</span>
                                    </div>
                                    <div class="item-content">
                                        ${n.content ? `<p>${n.content}</p>` : ''}
                                        ${item.imgSrc ? `<img src="${item.imgSrc}" />` : ''}
                                    </div>
                                </div>`;
                        }
                    } else if (item.type === 'question') {
                        htmlContent += `
                            <div class="item question">
                                <div class="item-header">
                                    <span>SORU</span>
                                    <span>${dateStr}</span>
                                </div>
                                <div class="item-content">
                                    ${item.imgSrc ? `<img src="${item.imgSrc}" />` : ''}
                                </div>
                            </div>`;
                    }
                });
            }

            htmlContent += `
                    <div class="no-print" style="position: fixed; top: 20px; right: 20px; background: white; padding: 10px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                        <button id="resource-print-btn" style="padding: 10px 20px; background: #4f46e5; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold;">Yazdır / PDF Kaydet</button>
                    </div>
                </body></html>`;

            printWindow.document.write(htmlContent);
            printWindow.document.close();

            // Yeni pencerede inline onclick yerine programatik listener kullan
            printWindow.addEventListener('load', () => {
                const btn = printWindow.document.getElementById('resource-print-btn');
                if (btn) {
                    btn.addEventListener('click', () => {
                        try {
                printWindow.focus();
                            printWindow.print();
                        } catch (err) {
                            console.error('Print window error:', err);
                        }
                    });
                }
            });
    };

    // Setup PDF export (header button)
    const pdfBtn = document.getElementById('resource-viewer-pdf-btn');
    if (pdfBtn) {
        pdfBtn.onclick = handleExportPdf;
    }

    // Setup PDF export (filter satırındaki yeni buton)
    const sortExportBtn = document.getElementById('resource-sort-export-btn');
    if (sortExportBtn) {
        sortExportBtn.onclick = handleExportPdf;
    }

    // Setup TTS (No changes needed)
    const ttsBtn = document.getElementById('resource-viewer-tts-btn');
    if (ttsBtn) {
        ttsBtn.onclick = () => {
            const textNotes = notes.filter(n => n.content && !n.image_storage_key && !n.audio_storage_key);
            if (textNotes.length === 0) {
                showToast('Seslendirilecek metin notu bulunamadı');
                return;
            }
            const allText = textNotes.map(n => n.content).join(' . ');

            // Cancel any previous
            window.speechSynthesis.cancel();

            const utterance = new SpeechSynthesisUtterance(allText);
            utterance.lang = 'tr-TR';
            utterance.rate = 1.0;
            window.speechSynthesis.speak(utterance);

            showToast('Seslendirme başladı...');
        };
    }
}

function updateProgressUI(progress, subject) {
    const fill = document.getElementById('current-progress-fill');
    const text = document.getElementById('current-progress-text');
    const timeEl = document.getElementById('global-total-duration');
    const qEl = document.getElementById('global-total-questions');

    fill.style.width = `${progress.percentage}%`;
    text.textContent = `%${progress.percentage}`;

    if (subject) {
        const stats = getSubjectTotalStats(subject);
        let liveTime = stats.time;
        let liveQs = stats.questions;

        const subjectTopics = getTopics(subject);
        const topicIds = subjectTopics.map(t => t.id);

        topicIds.forEach(id => {
            liveTime += (appState.uncommitedTimes[id] || 0);
        });

        const h = Math.floor(liveTime / 3600);
        const m = Math.floor((liveTime % 3600) / 60);
        timeEl.textContent = `${h} sa ${m} dk`;
        qEl.textContent = `${liveQs} soru`;
    }
}

export function setupDragAndDrop() {
    const list = document.getElementById('topic-list');

    list.addEventListener('dragstart', (e) => {
        if (e.target.classList.contains('topic-item')) {
            e.target.classList.add('dragging');
        }
    });

    list.addEventListener('dragend', (e) => {
        if (e.target.classList.contains('topic-item')) {
            e.target.classList.remove('dragging');
            const orderedIds = Array.from(list.querySelectorAll('.topic-item'))
                .map(item => parseInt(item.getAttribute('data-id')));
            updateTopicOrder(appState.currentSubject, orderedIds);
        }
    });

    list.addEventListener('dragover', (e) => {
        e.preventDefault();
        const draggingItem = list.querySelector('.dragging');
        const shortcuts = Array.from(list.querySelectorAll('.topic-item:not(.dragging)'));

        const nextItem = shortcuts.find(item => {
            const box = item.getBoundingClientRect();
            return e.clientY <= box.top + box.height / 2;
        });

        if (nextItem) {
            list.insertBefore(draggingItem, nextItem);
        } else {
            list.appendChild(draggingItem);
        }
    });
}
