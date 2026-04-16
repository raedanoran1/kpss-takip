import { getTopics, getTopicNoteStats, getDueNotes, updateNoteSRS, deleteNote, getStudyNotes, getResources } from '../db.js';
import { appState } from '../state/app-state.js';
import { showToast, showConfirm, showAlert } from '../utils/ui-utils.js';
import { initStudySession } from './study-session-manager.js';
import { toggleDrawingMode } from './drawing-manager.js';

let notesReviewQueue = [];
let currentNoteIndex = 0;
let ratedNoteIds = new Set(); // Rating verilen notların ID'lerini tutar

export function loadNotesDashboard(subject = null) {
    const dashboard = document.getElementById('notes-dashboard');
    const topicList = document.getElementById('topic-notes-list');
    const emptyState = document.getElementById('notes-empty-state');
    const reviewInterface = document.getElementById('notes-review-interface');

    // Ensure correct view visibility
    reviewInterface.classList.add('hidden');
    dashboard.classList.remove('hidden');

    topicList.innerHTML = '';

    // Subject parametresi verilmişse onu kullan, yoksa appState'ten al
    const currentSubject = subject !== null ? subject : appState.currentSubject;

    const topics = getTopics(currentSubject);
    const resources = getResources(currentSubject);

    const stats = getTopicNoteStats(currentSubject);

    let totalDue = 0;
    Object.values(stats).forEach(s => totalDue += s.due);

    const studyAllBtn = document.getElementById('start-all-notes-review-btn');
    if (studyAllBtn) {
        studyAllBtn.textContent = `🧠 Karışık Not Tekrarı (${totalDue})`;
        studyAllBtn.disabled = totalDue === 0;

        // Remove old listeners to prevent duplicates if called multiple times (cloning trick)
        const newBtn = studyAllBtn.cloneNode(true);
        studyAllBtn.parentNode.replaceChild(newBtn, studyAllBtn);
        newBtn.addEventListener('click', () => startNotesReview());
    }

    if (topics.length === 0 && resources.length === 0 && totalDue === 0) {
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');

    // Display regular topics
    topics.forEach(topic => {
        renderTopicItem(topic.id, topic.name, stats[topic.id] || { due: 0, total: 0 }, topicList);
    });

    // Display resources as topics
    resources.forEach(res => {
        const id = `res_${res.id}`;
        renderTopicItem(id, `📄 ${res.name}`, stats[id] || { due: 0, total: 0 }, topicList);
    });
}

function renderTopicItem(id, name, s, container) {
    // Always show resources (even with 0 notes), but skip regular topics with 0 notes
    const isResource = id.toString().startsWith('res_');
    if (s.total === 0 && !isResource) return;

    const item = document.createElement('div');
    item.className = 'topic-q-item';
    item.innerHTML = `
        <div class="topic-q-info">
            <span class="topic-q-name">${name}</span>
        </div>
        <div class="topic-q-right">
            <button class="topic-chat-btn-sm" title="Konu Notları">💬</button>
            <span class="due-badge ${s.due === 0 ? 'zero' : ''}">tekrar=${s.due}, toplam=${s.total}</span>
        </div>
    `;

    item.addEventListener('click', (e) => {
        if (e.target.closest('.topic-chat-btn-sm')) {
            initStudySession(id, name, appState.currentSubject, null);
        } else {
            if (s.due > 0) startNotesReview(id);
            else showAlert('Bu konu için şu an tekrar edilecek not yok.');
        }
    });

    container.appendChild(item);
}

export function startNotesReview(topicId = null) {
    const dueNotes = getDueNotes(appState.currentSubject, topicId);
    if (dueNotes.length === 0) {
        showAlert('Tekrar edilecek not kalmadı!');
        return;
    }

    notesReviewQueue = dueNotes;
    currentNoteIndex = 0;
    ratedNoteIds.clear(); // Yeni review başladığında rating verilen kartları temizle

    document.getElementById('notes-dashboard').classList.add('hidden');
    document.getElementById('notes-review-interface').classList.remove('hidden');

    setupNotesReviewControls();
    showNextNoteCard();
}

async function showNextNoteCard() {
    if (currentNoteIndex >= notesReviewQueue.length) {
        await showAlert('Not tekrarını tamamladın!');
        exitNotesReview();
        return;
    }

    const note = notesReviewQueue[currentNoteIndex];
    const container = document.getElementById('note-card-content');
    const currentSpan = document.getElementById('note-review-current');
    const totalSpan = document.getElementById('note-review-total');

    currentSpan.textContent = currentNoteIndex + 1;
    totalSpan.textContent = notesReviewQueue.length;

    container.innerHTML = '';

    // Ses kayıtlarını atla (sadece metin ve görsel notlar göster)
    if (note.audio_storage_key) {
        // Ses kaydı, bir sonraki notu göster
        currentNoteIndex++;
        showNextNoteCard();
        return;
    }

    if (note.image_storage_key) {
        // Assume key is data or actual storage key. 
        // Based on monolithic analysis, it retrieves from storage.
        const img = document.createElement('img');
        const data = await chrome.storage.local.get(note.image_storage_key);
        img.src = data[note.image_storage_key] || '';
        img.style.maxWidth = '100%';
        img.style.borderRadius = '8px';
        container.appendChild(img);
    }

    if (note.content) {
        const text = document.createElement('div');
        text.className = 'note-card-text';
        text.textContent = note.content;
        text.style.padding = '1.5rem';
        text.style.fontSize = '1.2rem';
        text.style.textAlign = 'center';
        container.appendChild(text);
    }

    // Eğer ne görsel ne de metin varsa, bir sonraki notu göster
    if (!note.image_storage_key && !note.content) {
        currentNoteIndex++;
        showNextNoteCard();
        return;
    }

    updateNoteNavState();
}

function setupNotesReviewControls() {
    const exitBtn = document.getElementById('exit-notes-review-btn');
    const deleteBtn = document.getElementById('delete-current-note-btn');
    const rateBtns = document.querySelectorAll('#notes-review-interface .rate-btn');

    // Clean listeners
    const newExit = exitBtn.cloneNode(true);
    exitBtn.parentNode.replaceChild(newExit, exitBtn);
    newExit.addEventListener('click', () => exitNotesReview());

    const newDelete = deleteBtn.cloneNode(true);
    deleteBtn.parentNode.replaceChild(newDelete, deleteBtn);
    newDelete.addEventListener('click', async () => {
        const note = notesReviewQueue[currentNoteIndex];
        if (await showConfirm('Bu notu silmek istiyor musunuz?')) {
            await deleteNote(note.id, note.image_storage_key);
            showToast('Not silindi', 'error');
            notesReviewQueue.splice(currentNoteIndex, 1);

            if (notesReviewQueue.length === 0 || currentNoteIndex >= notesReviewQueue.length) {
                exitNotesReview();
            } else {
                showNextNoteCard();
            }
        }
    });

    rateBtns.forEach(btn => {
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', () => {
            const rating = parseInt(newBtn.getAttribute('data-rating'));
            handleNoteRating(rating);
        });
    });

    // Drawing Tool
    const drawingBtn = document.getElementById('toggle-drawing-notes-btn');
    if (drawingBtn) {
        drawingBtn.onclick = () => toggleDrawingMode('toggle-drawing-notes-btn');
    }

    // Navigation Arrows
    const prevBtn = document.getElementById('note-nav-prev');
    const nextBtn = document.getElementById('note-nav-next');

    if (prevBtn) {
        const newPrev = prevBtn.cloneNode(true);
        prevBtn.parentNode.replaceChild(newPrev, prevBtn);
        newPrev.addEventListener('click', (e) => {
            e.stopPropagation();
            showPreviousNote();
        });
    }

    if (nextBtn) {
        const newNext = nextBtn.cloneNode(true);
        nextBtn.parentNode.replaceChild(newNext, nextBtn);
        newNext.addEventListener('click', (e) => {
            e.stopPropagation();
            showNextNoteNoRate();
        });
    }
}

function handleNoteRating(rating) {
    const note = notesReviewQueue[currentNoteIndex];
    
    // UI'ı hemen güncelle (kullanıcı deneyimi için)
    ratedNoteIds.add(note.id);
    notesReviewQueue.splice(currentNoteIndex, 1);

    if (notesReviewQueue.length === 0) {
        // DB işlemini arka planda yap, sonra alert göster
        setTimeout(() => updateNoteSRS(note.id, rating), 0);
        showAlert('Not tekrarını tamamladın!');
        exitNotesReview();
        return;
    }

    // Eğer son kart silindiyse index'i başa sar
    if (currentNoteIndex >= notesReviewQueue.length) {
        currentNoteIndex = 0;
    }

    // UI'ı hemen güncelle
    showNextNoteCard();
    
    // DB işlemini arka planda yap (asenkron, UI'ı bloklamaz)
    setTimeout(() => updateNoteSRS(note.id, rating), 0);
}



function showPreviousNote() {
    // Döngüsel gezinme: 1. nottayken geri -> son nota git
    if (notesReviewQueue.length <= 1) return;
    if (currentNoteIndex === 0) {
        currentNoteIndex = notesReviewQueue.length - 1;
    } else {
        currentNoteIndex--;
    }
    showNextNoteCard();
}

function showNextNoteNoRate() {
    // Döngüsel gezinme: son nottayken ileri -> 1. nota git
    if (notesReviewQueue.length <= 1) return;
    if (currentNoteIndex >= notesReviewQueue.length - 1) {
        currentNoteIndex = 0;
    } else {
        currentNoteIndex++;
    }
    showNextNoteCard();
}

function updateNoteNavState() {
    const prevBtn = document.getElementById('note-nav-prev');
    const nextBtn = document.getElementById('note-nav-next');

    const hasMultiple = notesReviewQueue.length > 1;

    if (prevBtn) {
        prevBtn.disabled = !hasMultiple;
        prevBtn.classList.toggle('disabled', !hasMultiple);
    }

    if (nextBtn) {
        nextBtn.disabled = !hasMultiple;
        nextBtn.classList.toggle('disabled', !hasMultiple);
    }
}

function exitNotesReview() {
    document.getElementById('notes-review-interface').classList.add('hidden');
    document.getElementById('notes-dashboard').classList.remove('hidden');
    loadNotesDashboard();
}
