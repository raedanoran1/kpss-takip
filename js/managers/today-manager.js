import { getTodayTasks, getDailyTotals, getTopicTodayStats, removeFromToday, getResources, getTodaySubjectStats, getGlobalTotals } from '../db.js';
import { formatDuration } from '../utils/format-utils.js';
import { showToast, showConfirm } from '../utils/ui-utils.js';
import { appState, persistState } from '../state/app-state.js';
import { initStudySession } from './study-session-manager.js';
import { openPDFViewer } from './pdf-viewer-manager.js';
import { setupPointerDragSort } from '../utils/drag-sort.js';

const DIFFICULTY_LABELS = { easy: 'Kolay', medium: 'Orta', hard: 'Zor' };
const DIFFICULTY_CYCLE = ['easy', 'medium', 'hard'];

function getDifficulty(topicId) {
    if (!appState.topicDifficulty) appState.topicDifficulty = {};
    return appState.topicDifficulty[topicId] || null;
}

async function cycleDifficulty(topicId, currentEl) {
    if (!appState.topicDifficulty) appState.topicDifficulty = {};
    const cur = appState.topicDifficulty[topicId];
    const idx = DIFFICULTY_CYCLE.indexOf(cur);
    const next = idx >= 0 ? (idx < 2 ? DIFFICULTY_CYCLE[idx + 1] : null) : DIFFICULTY_CYCLE[0];
    if (next) {
        appState.topicDifficulty[topicId] = next;
        currentEl.className = `difficulty-badge ${next}`;
        currentEl.textContent = DIFFICULTY_LABELS[next];
    } else {
        delete appState.topicDifficulty[topicId];
        currentEl.className = 'difficulty-badge';
        currentEl.textContent = '• Zorluk';
    }
    await persistState();
}

export function loadTodayTasks() {
    const listEl = document.getElementById('today-work-list');
    listEl.innerHTML = '';

    const allTasks = getTodayTasks(null); // Fetch all subjects
    const dailyTotals = getDailyTotals();
    const subjectTodayStats = getTodaySubjectStats();
    const globalTotals = getGlobalTotals();

    // Include uncommitted work in daily totals
    let extraTime = 0;
    Object.values(appState.uncommitedTimes).forEach(t => extraTime += t);

    const totalSecs = dailyTotals.time + extraTime;
    const totalQs = dailyTotals.questions; // Questions are committed immediately now

    // Update Today's Global Totals
    const dailyTimeMins = Math.floor(totalSecs / 60);
    const todayTotalTimeEl = document.getElementById('today-total-time');
    const todayTotalQuestionsEl = document.getElementById('today-total-questions');
    if (todayTotalTimeEl) todayTotalTimeEl.textContent = `${dailyTimeMins} dk`;
    if (todayTotalQuestionsEl) todayTotalQuestionsEl.textContent = totalQs;

    // Update per-subject stats for today
    const subjectStatsEl = document.getElementById('today-subject-stats');
    if (subjectStatsEl) {
        subjectStatsEl.innerHTML = '';
        const subjectNames = {
            'matematik': 'Matematik',
            'turkce': 'Türkçe',
            'tarih': 'Tarih',
            'cografya': 'Coğrafya',
            'anayasa': 'Anayasa'
        };
        Object.entries(subjectTodayStats).forEach(([subject, s]) => {
            const mins = Math.floor((s.time || 0) / 60);
            const div = document.createElement('div');
            div.className = 'today-subject-chip';
            div.textContent = `${subjectNames[subject] || subject.toUpperCase()}: ${mins} dk, ${s.questions || 0} soru`;
            subjectStatsEl.appendChild(div);
        });
        if (subjectStatsEl.innerHTML === '') {
            subjectStatsEl.textContent = 'Bugün için henüz kayıtlı çalışma yok.';
        }
    }

    // Update global totals (all time)
    const globalEl = document.getElementById('today-global-totals');
    if (globalEl) {
        const totalMins = Math.floor((globalTotals.time || 0) / 60);
        globalEl.textContent = `Genel Toplam: ${totalMins} dk, ${globalTotals.questions || 0} soru`;
    }

    const emptyState = document.getElementById('today-empty-state');
    const clearBtn = document.getElementById('today-clear-btn');

    if (allTasks.length === 0) {
        emptyState.classList.remove('hidden');
        if (clearBtn) clearBtn.classList.add('hidden');
        listEl.innerHTML = '';
        return;
    }
    emptyState.classList.add('hidden');
    if (clearBtn) clearBtn.classList.remove('hidden');

    const subjectNames = {
        'matematik': 'Matematik',
        'turkce': 'Türkçe',
        'tarih': 'Tarih',
        'cografya': 'Coğrafya',
        'anayasa': 'Anayasa'
    };

    // Apply stored drag order if available
    if (!appState.todayTaskOrder) appState.todayTaskOrder = [];
    if (appState.todayTaskOrder.length > 0) {
        const orderMap = {};
        appState.todayTaskOrder.forEach((id, i) => { orderMap[id] = i; });
        allTasks.sort((a, b) => {
            const ia = orderMap[a.taskId] !== undefined ? orderMap[a.taskId] : 9999;
            const ib = orderMap[b.taskId] !== undefined ? orderMap[b.taskId] : 9999;
            return ia - ib;
        });
    }

    allTasks.forEach(task => {
        const item = document.createElement('li');
        item.className = `topic-item ${task.status === 2 ? 'completed' : ''}`;
        item.dataset.id = task.taskId;

        // Fetch Topic Stats for TODAY only
        const dbStats = getTopicTodayStats(task.topicId);
        const liveTime = dbStats.time + (appState.uncommitedTimes[task.topicId] || 0);
        const liveQs = dbStats.questions;

        const timeStr = formatDuration(liveTime);

        // Check if this is a resource with PDF
        const isResource = task.topicId.toString().startsWith('res_');
        let hasPDF = false;
        if (isResource) {
            const resourceId = parseInt(task.topicId.replace('res_', ''));
            const resources = getResources(task.subject);
            const resource = resources.find(r => r.id === resourceId);
            hasPDF = resource && resource.pdf_storage_key;
        }

        const diff = getDifficulty(task.topicId);
        const diffLabel = diff ? DIFFICULTY_LABELS[diff] : '• Zorluk';
        const diffClass = diff ? `difficulty-badge ${diff}` : 'difficulty-badge';
        const subjectLabel = subjectNames[task.subject] || task.subject.toUpperCase();

        item.innerHTML = `
            <div class="today-drag-handle">⠿</div>
            <div class="topic-info">
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                    <span class="topic-name">${task.name}</span>
                    <span class="today-subject-pill">${subjectLabel}</span>
                    <span class="${diffClass}" data-difficulty-toggle="${task.topicId}">${diffLabel}</span>
                </div>
                <div class="topic-stats-badge">
                    <span class="topic-stat-chip">⏱️ ${timeStr}</span>
                    <span class="topic-stat-chip">✍️ ${liveQs}</span>
                </div>
            </div>
            <div class="topic-actions">
                <button class="topic-chat-btn" title="Notlar / Chat">💬</button>
                ${hasPDF ? '<button class="topic-chat-btn pdf-open-btn" title="PDF Aç">📖</button>' : ''}
                <button class="topic-delete-btn">🗑️</button>
            </div>
        `;

        const diffBadge = item.querySelector(`[data-difficulty-toggle="${task.topicId}"]`);
        if (diffBadge) {
            diffBadge.addEventListener('click', (e) => {
                e.stopPropagation();
                cycleDifficulty(task.topicId, diffBadge);
            });
        }

        item.addEventListener('click', (e) => {
            if (e.target.closest('.topic-delete-btn')) return;
            if (e.target.closest('.pdf-open-btn')) return;
            if (e.target.closest('.topic-chat-btn')) return;
            if (e.target.closest('.today-drag-handle')) return;
            initStudySession(task.topicId, task.name, task.subject, task.taskId);
        });

        // Chat button handler
        const chatBtn = item.querySelector('.topic-chat-btn:not(.pdf-open-btn)');
        if (chatBtn) {
            chatBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                initStudySession(task.topicId, task.name, task.subject, task.taskId);
            });
        }

        // PDF open button handler
        const pdfBtn = item.querySelector('.pdf-open-btn');
        if (pdfBtn) {
            pdfBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const resourceId = parseInt(task.topicId.replace('res_', ''));
                const resources = getResources(task.subject) || [];
                const resource = resources.find(r => r.id === resourceId);
                if (resource) {
                    openPDFViewer(resourceId, resource.name, resource.last_page || 1);
                } else {
                    showToast('Kaynak bulunamadı', 'error');
                }
            });
        }

        item.querySelector('.topic-delete-btn').addEventListener('click', async () => {
            if (await showConfirm('Bu görevi bugünkü listenizden kaldırmak istiyor musunuz?')) {
                removeFromToday(task.taskId);
                loadTodayTasks();
            }
        });

        listEl.appendChild(item);
    });

    // Set up pointer drag sort (once per list lifetime)
    if (!listEl.dataset.dragSortReady) {
        listEl.dataset.dragSortReady = '1';
        setupPointerDragSort(listEl, 'li.topic-item', '.today-drag-handle', async (newOrderIds) => {
            appState.todayTaskOrder = newOrderIds;
            await persistState();
        });
    }
}
