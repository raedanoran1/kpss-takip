import { appState, persistState } from '../state/app-state.js';

const STORAGE_KEY = 'daily_focus_tracker';
const FOCUS_BREAKS_KEY = 'daily_focus_breaks';
const CATEGORIES = ['matematik', 'turkce', 'tarih', 'cografya', 'anayasa', 'mola', 'uyku'];
const CATEGORY_LABELS = {
    matematik: 'Mat',
    turkce: 'Turkce',
    tarih: 'Tarih',
    cografya: 'Cografya',
    anayasa: 'Anayasa',
    mola: 'Mola',
    uyku: 'Uyku'
};
const EXAM_DATES = {
    lisans: new Date('2026-09-06T10:00:00+03:00'),
    onlisans: new Date('2026-10-04T10:00:00+03:00')
};

let trackerState = { daily: {} };
let focusBreaksState = {}; // dateKey -> { breaks: number, avgFocusMins: number, sessions: [] }
let ticker = null;

function syncSafeArea() {
    const panel = document.getElementById('daily-focus-panel');
    const panelHeight = panel ? panel.offsetHeight : 0;
    document.documentElement.style.setProperty('--daily-focus-panel-height', `${panelHeight}px`);
}

function todayKey() {
    const d = new Date();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${month}-${day}`;
}

function ensureDay(dateKey = todayKey()) {
    if (!trackerState.daily[dateKey]) {
        trackerState.daily[dateKey] = {};
    }
    CATEGORIES.forEach((c) => {
        if (typeof trackerState.daily[dateKey][c] !== 'number') {
            trackerState.daily[dateKey][c] = 0;
        }
    });
}

function formatHMS(totalSeconds = 0) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function dateDiffDaysInclusive(start, end) {
    if (!(start instanceof Date) || !(end instanceof Date)) return 0;
    if (start > end) return 0;
    const startMid = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const endMid = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    return Math.floor((endMid - startMid) / 86400000) + 1;
}

function studySecondsOfDay(dayData) {
    return (dayData.matematik || 0) + (dayData.turkce || 0) + (dayData.tarih || 0) + (dayData.cografya || 0) + (dayData.anayasa || 0);
}

// ===== STREAK HESAPLAMA =====
function computeStreak() {
    const startDate = new Date(`${appState.statsStartDate || todayKey()}T00:00:00`);
    const goalHours = Number(appState.statsTargetHours) || 8;
    const minThreshold = goalHours * 3600 * 0.7; // %70 hedef yeterli

    let streak = 0;
    const today = new Date();
    const d = new Date(today);
    d.setDate(d.getDate() - 1); // dünden başla

    while (d >= startDate) {
        const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const dayData = trackerState.daily[key];
        if (!dayData) break;
        const secs = studySecondsOfDay(dayData);
        if (secs >= minThreshold) {
            streak++;
        } else {
            break;
        }
        d.setDate(d.getDate() - 1);
    }

    // Bugünü de kontrol et
    const todayStr = todayKey();
    ensureDay(todayStr);
    const todaySecs = studySecondsOfDay(trackerState.daily[todayStr]);
    if (todaySecs >= minThreshold) streak++;

    return streak;
}

// ===== İLK ÇALIŞMA SAATİ =====
function recordFirstStudyTime() {
    const key = todayKey();
    if (!appState.streakData) appState.streakData = {};
    if (!appState.streakData[key]) appState.streakData[key] = {};
    if (!appState.streakData[key].firstStudyTime) {
        const now = new Date();
        appState.streakData[key].firstStudyTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        persistState();
    }
}

function getFirstStudyTime(dateKey = todayKey()) {
    if (!appState.streakData || !appState.streakData[dateKey]) return null;
    return appState.streakData[dateKey].firstStudyTime || null;
}

// ===== PROGRESS BAR =====
function renderProgressBar(totalWork, targetSeconds) {
    const wrap = document.getElementById('daily-progress-bar-wrap');
    if (!wrap) return;

    const pct = targetSeconds > 0 ? Math.min(100, Math.round((totalWork / targetSeconds) * 100)) : 0;
    let colorClass = '';
    if (pct >= 90) colorClass = 'green';
    else if (pct >= 60) colorClass = 'yellow';

    wrap.innerHTML = `
        <div class="daily-progress-bar-bg">
            <div class="daily-progress-bar-fill ${colorClass}" style="width:${pct}%"></div>
        </div>
        <div class="daily-progress-pct">%${pct} tamamlandı</div>
    `;
}

// ===== FOCUS PANEL RENDER =====
function renderTodayPanel() {
    const totalEl = document.getElementById('daily-focus-total');
    const targetEl = document.getElementById('daily-focus-target');
    const buttonsWrap = document.getElementById('daily-focus-buttons');
    const breakdownEl = document.getElementById('daily-focus-breakdown');
    const enabledEl = document.getElementById('daily-focus-enabled');
    if (!totalEl || !targetEl || !buttonsWrap || !breakdownEl || !enabledEl) return;

    ensureDay();
    const dayData = trackerState.daily[todayKey()];
    const totalWork = studySecondsOfDay(dayData);
    const targetSeconds = getTodayTargetSeconds();

    // İlk çalışma saati takibi
    if (appState.focusPanelEnabled && appState.activeFocusCategory && appState.activeFocusCategory !== 'mola' && appState.activeFocusCategory !== 'uyku') {
        recordFirstStudyTime();
    }

    const streak = computeStreak();
    const firstTime = getFirstStudyTime();

    // Streak ve ilk saat rozetleri
    let badgesHtml = '';
    if (streak > 0) {
        badgesHtml += `<span class="streak-badge">🔥 ${streak} günlük seri</span>`;
    }
    if (firstTime) {
        const hour = parseInt(firstTime.split(':')[0]);
        const earlyIcon = hour < 9 ? '🌅' : '';
        badgesHtml += `<span class="first-study-badge">${earlyIcon} İlk çalışma: ${firstTime}</span>`;
    }

    totalEl.innerHTML = `Bugün toplam çalışma: ${formatHMS(totalWork)} ${badgesHtml}`;
    targetEl.textContent = `Hedef süre: ${formatHMS(targetSeconds)}`;
    enabledEl.checked = !!appState.focusPanelEnabled;

    // Progress bar
    renderProgressBar(totalWork, targetSeconds);

    buttonsWrap.innerHTML = '';
    CATEGORIES.forEach((category) => {
        const btn = document.createElement('button');
        btn.className = `focus-btn ${appState.activeFocusCategory === category ? 'active' : ''}`;
        btn.textContent = CATEGORY_LABELS[category];
        btn.addEventListener('click', async () => {
            appState.activeFocusCategory = category;
            // Kategoriye tıklayınca otomatik olarak takibi etkinleştir
            if (!appState.focusPanelEnabled) {
                appState.focusPanelEnabled = true;
            }
            await persistState();
            renderTodayPanel();
        });
        buttonsWrap.appendChild(btn);
    });

    breakdownEl.innerHTML = CATEGORIES
        .map((c) => {
            const activeClass = appState.activeFocusCategory === c ? 'active' : '';
            return `<span class="focus-break-item ${activeClass}">${CATEGORY_LABELS[c]}: ${formatHMS(dayData[c] || 0)}</span>`;
        })
        .join('<span class="focus-break-sep">|</span>');

    syncSafeArea();
}

function computeTodayDynamicTarget(startDate, goalHours, examType) {
    const examDate = EXAM_DATES[examType] || EXAM_DATES.lisans;
    const today = new Date();
    const totalDays = dateDiffDaysInclusive(startDate, examDate);
    if (totalDays <= 0) return 0;

    const plannedTotal = goalHours * 3600 * totalDays;
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    let actualUpToYesterday = 0;
    Object.entries(trackerState.daily).forEach(([key, value]) => {
        const d = new Date(`${key}T00:00:00`);
        if (d >= startDate && d <= yesterday) {
            actualUpToYesterday += studySecondsOfDay(value);
        }
    });

    const remainingDays = dateDiffDaysInclusive(today, examDate);
    if (remainingDays <= 0) return 0;
    const remainingNeed = plannedTotal - actualUpToYesterday;
    return Math.max(0, Math.floor(remainingNeed / remainingDays));
}

export function renderStatsTab() {
    const tbody = document.getElementById('study-stats-table-body');
    const startDateInput = document.getElementById('stats-start-date');
    const targetHoursSelect = document.getElementById('stats-target-hours');
    const targetTitle = document.getElementById('stats-today-target');
    if (!tbody || !startDateInput || !targetHoursSelect || !targetTitle) return;

    const startDateStr = appState.statsStartDate || todayKey();
    startDateInput.value = startDateStr;
    targetHoursSelect.value = String(appState.statsTargetHours || 8);

    const startDate = new Date(`${startDateInput.value}T00:00:00`);
    const goalHours = Number(targetHoursSelect.value) || 8;
    const examType = appState.examType || 'lisans';
    const examDate = EXAM_DATES[examType] || EXAM_DATES.lisans;
    const todayGoal = computeTodayDynamicTarget(startDate, goalHours, examType);
    targetTitle.textContent = `Bugünkü toplam çalışma süresi hedefi: ${formatHMS(todayGoal)}`;

    tbody.innerHTML = '';
    const days = dateDiffDaysInclusive(startDate, examDate);
    for (let i = 0; i < days; i += 1) {
        const d = new Date(startDate);
        d.setDate(d.getDate() + i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        ensureDay(key);
        const rowData = trackerState.daily[key];

        // İlk çalışma saati
        const firstTime = getFirstStudyTime(key);

        // Kırılma sayısı
        const breaksData = focusBreaksState[key];
        const breakCount = breaksData ? breaksData.count : 0;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${key}</td>
            <td>${formatHMS(rowData.matematik)}</td>
            <td>${formatHMS(rowData.turkce)}</td>
            <td>${formatHMS(rowData.tarih)}</td>
            <td>${formatHMS(rowData.cografya)}</td>
            <td>${formatHMS(rowData.anayasa)}</td>
            <td>${formatHMS(rowData.mola)}</td>
            <td>${formatHMS(rowData.uyku)}</td>
            <td class="stats-first-study">${firstTime || '-'}</td>
            <td>${breakCount > 0 ? `<span style="color:#f59e0b;font-weight:700">${breakCount}</span>` : '-'}</td>
        `;
        tbody.appendChild(tr);
    }
}

export function getTodayTargetSeconds() {
    const startDate = new Date(`${appState.statsStartDate || todayKey()}T00:00:00`);
    const goalHours = Number(appState.statsTargetHours) || 8;
    const examType = appState.examType || 'lisans';
    return computeTodayDynamicTarget(startDate, goalHours, examType);
}

export function renderFocusPanel() {
    renderTodayPanel();
}

// ===== ODAK KIRILMA KAYDET =====
export async function recordFocusBreak(topicId) {
    const key = todayKey();
    if (!focusBreaksState[key]) focusBreaksState[key] = { count: 0 };
    focusBreaksState[key].count++;
    await chrome.storage.local.set({ [FOCUS_BREAKS_KEY]: focusBreaksState });

    // UI güncelle
    const breakBtn = document.getElementById('focus-break-btn');
    if (breakBtn) {
        const countEl = breakBtn.querySelector('.focus-break-count');
        if (countEl) countEl.textContent = focusBreaksState[key].count;
    }

    return focusBreaksState[key].count;
}

export function getTodayBreakCount() {
    const key = todayKey();
    return focusBreaksState[key] ? focusBreaksState[key].count : 0;
}

function tick() {
    if (!appState.focusPanelEnabled || !appState.activeFocusCategory) return;
    ensureDay();
    trackerState.daily[todayKey()][appState.activeFocusCategory] += 1;
    chrome.storage.local.set({ [STORAGE_KEY]: trackerState });
    renderTodayPanel();
    renderStatsTab();
}

export async function setupFocusTrackerUI() {
    const stored = await chrome.storage.local.get([STORAGE_KEY, FOCUS_BREAKS_KEY]);
    trackerState = stored[STORAGE_KEY] || { daily: {} };
    focusBreaksState = stored[FOCUS_BREAKS_KEY] || {};
    if (!appState.activeFocusCategory) appState.activeFocusCategory = 'mola';
    if (typeof appState.focusPanelEnabled !== 'boolean') appState.focusPanelEnabled = false;
    if (!appState.statsStartDate) appState.statsStartDate = todayKey();
    if (!appState.statsTargetHours) appState.statsTargetHours = 8;
    if (!appState.streakData) appState.streakData = {};
    await persistState();

    const enabledEl = document.getElementById('daily-focus-enabled');
    const startDateInput = document.getElementById('stats-start-date');
    const targetHoursSelect = document.getElementById('stats-target-hours');

    if (enabledEl) {
        enabledEl.addEventListener('change', async (e) => {
            appState.focusPanelEnabled = e.target.checked;
            if (appState.focusPanelEnabled && !appState.activeFocusCategory) {
                appState.activeFocusCategory = 'mola';
            }
            await persistState();
            renderTodayPanel();
        });
    }

    if (startDateInput) {
        startDateInput.addEventListener('change', async () => {
            appState.statsStartDate = startDateInput.value || todayKey();
            await persistState();
            renderStatsTab();
        });
    }

    if (targetHoursSelect) {
        targetHoursSelect.addEventListener('change', async () => {
            appState.statsTargetHours = Number(targetHoursSelect.value) || 8;
            await persistState();
            renderStatsTab();
        });
    }

    if (ticker) clearInterval(ticker);
    ticker = setInterval(tick, 1000);
    window.addEventListener('resize', syncSafeArea);
    renderTodayPanel();
    renderStatsTab();
}

export function getExamDateByType(examType) {
    return EXAM_DATES[examType] || EXAM_DATES.lisans;
}
