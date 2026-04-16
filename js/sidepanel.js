import { initDB, clearTodayTasks } from './db.js';
import { appState, loadState, persistState } from './state/app-state.js';
import { setupTrialUI, loadTrialHistory } from './managers/trial-manager.js';
import { setupResourcesUI, loadResources } from './managers/resource-manager.js';
import { setupQuestionsUI, loadQuestionsDashboard } from './managers/questions-manager.js';
import { setupModals, loadTopics, setupDragAndDrop } from './managers/topic-manager.js';
import { loadTodayTasks } from './managers/today-manager.js';
import { setupStudySessionUI } from './managers/study-session-manager.js';
import { loadNotesDashboard } from './managers/notes-manager.js';
import { showConfirm } from './utils/ui-utils.js';
import { logger } from './utils/logger.js';
import { setupDrawingUI } from './managers/drawing-manager.js';
import { setupVoiceLibraryUI, loadVoiceLibrary } from './managers/voice-library-manager.js';
import { setupPDFDrawingListeners } from './managers/pdf-viewer-manager.js';
import { setupBackupUI, createFullBackup, restoreBackup } from './managers/backup-manager.js';
// import { setupDriveSyncUI } from './managers/drive-sync-manager.js'; // Drive özelliği pasif
import { loadKnowledgeBase } from './managers/knowledge-manager.js';
import { setupHabitsUI, loadHabits } from './managers/habits-manager.js';
import { setupCevsenUI, loadCevsen } from './managers/cevsen-manager.js';
import { loadYasin } from './managers/yasin-manager.js';
import { setupFocusTrackerUI, renderStatsTab, renderFocusPanel, getExamDateByType } from './managers/focus-tracker-manager.js';
import { setupSpeedReadingUI } from './managers/speed-reading-manager.js';

// Setup PDF.js Worker
if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        // Initialize DB + load App State (in parallel for faster startup)
        await Promise.all([initDB(), loadState()]);

    // UI Event Listeners
    setupTabs();
    setupSubjectChips();
    setupThemeToggle();
    setupCountdownTimer();  // Countdown Timer
    setupFocusTrackerUI();  // Daily Focus Tracker + Study Stats
    setupModals();          // Topic Modals
    setupQuestionsUI();     // Question Bank Logic
    setupStudySessionUI();  // Timer & Chat Logic
    setupDragAndDrop();     // Topic Sorting
    setupTrialUI();         // Trial Logic
    setupResourcesUI();     // Resource Logic
    setupDrawingUI();       // Drawing Canvas & Toolbars
    setupVoiceLibraryUI();  // Voice Library Global Player
    setupPDFDrawingListeners(); // PDF Viewer Interaction
    setupHabitsUI(); // Habits Manager (içinde zaten resetDailyHabits çağrılıyor)
    setupCevsenUI(); // Cevşen Manager
    setupHabitsSubTabs(); // Alışkanlıklar alt sekmeleri
    setupSpeedReadingUI(); // Hızlı Okuma Egzersizi

    // iPad/mobil: ekran döndürmede tarayıcı otomatik zoom'unu sıfırla
    window.addEventListener('orientationchange', () => {
        const viewport = document.querySelector('meta[name=viewport]');
        if (viewport) {
            const base = 'width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no';
            viewport.content = base + ', maximum-scale=1.0';
            setTimeout(() => { viewport.content = base; }, 400);
        }
        // Yüksekliği yeniden hesapla (sekme çubuğu mavı header altında kalmasın)
        setTimeout(() => { window.dispatchEvent(new Event('resize')); }, 300);
        setTimeout(() => { window.dispatchEvent(new Event('resize')); }, 700);
    });

    // Backup UI Setup
    setupBackupUI(); // Optional hook
    // setupDriveSyncUI(); // Google Drive Sync Setup - Drive özelliği pasif
    const backupBtn = document.getElementById('create-backup-btn');
    const restoreInput = document.getElementById('restore-backup-input');
    const restoreBtn = document.getElementById('restore-backup-btn');

    if (backupBtn) {
        backupBtn.addEventListener('click', async () => {
            backupBtn.disabled = true;
            const progressContainer = document.getElementById('backup-progress-container');
            const progressFill     = document.getElementById('backup-progress-fill');
            const progressText     = document.getElementById('backup-progress-text');
            const progressPct      = document.getElementById('backup-progress-pct');

            if (progressContainer) progressContainer.style.display = 'block';

            try {
                await createFullBackup((percent, message) => {
                    if (progressFill) progressFill.style.width = percent + '%';
                    if (progressText) progressText.textContent = message;
                    if (progressPct)  progressPct.textContent  = '%' + Math.round(percent);
                    if (percent >= 100) {
                        setTimeout(() => {
                            if (progressContainer) progressContainer.style.display = 'none';
                            if (progressFill) progressFill.style.width = '0%';
                        }, 2500);
                    }
                });
            } catch (_) {
                if (progressContainer) progressContainer.style.display = 'none';
            } finally {
                backupBtn.disabled = false;
            }
        });
    }

    if (restoreBtn && restoreInput) {
        restoreBtn.addEventListener('click', () => restoreInput.click());
        restoreInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                restoreBackup(e.target.files[0]);
            }
        });
    }

    // Initial Tab Activation
    const initialTabId = appState.currentTab || 'today-tab';

    // Deactivate all first
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    // Activate current
    const activeBtn = document.querySelector(`.nav-btn[data-tab="${initialTabId}"]`);
    const activeContent = document.getElementById(initialTabId);

    if (activeBtn) activeBtn.classList.add('active');
    if (activeContent) activeContent.classList.add('active');

    // Handle Sub-Nav Visibility
    const subjectSubNav = document.getElementById('subject-sub-nav');
    const habitsSubNav = document.getElementById('habits-sub-nav');
    
    if (initialTabId === 'today-tab' || initialTabId === 'trials-tab' || initialTabId === 'backup-tab' || initialTabId === 'study-stats-tab' || initialTabId === 'speed-reading-tab') {
        if (subjectSubNav) subjectSubNav.classList.add('hidden');
        if (habitsSubNav) habitsSubNav.classList.add('hidden');
    } else if (initialTabId === 'habits-tab') {
        if (subjectSubNav) subjectSubNav.classList.add('hidden');
        if (habitsSubNav) habitsSubNav.classList.remove('hidden');
    } else {
        if (subjectSubNav) subjectSubNav.classList.remove('hidden');
        if (habitsSubNav) habitsSubNav.classList.add('hidden');
    }

    // Load Data
    if (initialTabId === 'today-tab') loadTodayTasks();
    else if (initialTabId === 'subjects-tab') loadTopics(appState.currentSubject);
    else if (initialTabId === 'questions-tab') loadQuestionsDashboard(appState.currentSubject);
    else if (initialTabId === 'notes-tab') loadNotesDashboard(appState.currentSubject);
    else if (initialTabId === 'trials-tab') loadTrialHistory();
    else if (initialTabId === 'resources-tab') loadResources();
    else if (initialTabId === 'study-stats-tab') renderStatsTab();
    else if (initialTabId === 'voice-library-tab') loadVoiceLibrary();
    // speed-reading-tab content is initialized by setupSpeedReadingUI above
    else if (initialTabId === 'habits-tab') {
        const currentHabitsSub = appState.currentHabitsSub || 'habits';
        switchHabitsSubTab(currentHabitsSub);
    }
    // backup-tab needs no data load, it's static
    
    // Make functions globally accessible for PDF viewer and other managers
    window.loadKnowledgeBase = loadKnowledgeBase;
    window.loadVoiceLibrary = loadVoiceLibrary;
    } catch (error) {
        logger.error('Error initializing application:', error);
        alert('Uygulama başlatılırken bir hata oluştu. Lütfen sayfayı yenileyin.');
    }
});

function setupTabs() {
    const tabBtns = document.querySelectorAll('.nav-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-tab');

            // Switch active button
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Switch content
            tabContents.forEach(c => {
                c.classList.remove('active');
                c.style.display = ''; // Reset inline style
            });
            const activeContent = document.getElementById(targetId);
            activeContent.classList.add('active');

            // Force display for backup tab to ensure visibility
            if (targetId === 'backup-tab') {
                activeContent.style.display = 'block';
            }

            appState.currentTab = targetId;
            persistState();

            // Show/Hide subject chips based on tab
            const subjectSubNav = document.getElementById('subject-sub-nav');
            const habitsSubNav = document.getElementById('habits-sub-nav');

            if (appState.currentTab === 'today-tab' || appState.currentTab === 'trials-tab' || appState.currentTab === 'backup-tab' || appState.currentTab === 'study-stats-tab' || appState.currentTab === 'speed-reading-tab') {
                if (subjectSubNav) subjectSubNav.classList.add('hidden');
                if (habitsSubNav) habitsSubNav.classList.add('hidden');

                if (appState.currentTab === 'today-tab') loadTodayTasks();
                else if (appState.currentTab === 'trials-tab') loadTrialHistory();
                else if (appState.currentTab === 'study-stats-tab') renderStatsTab();
            } else if (appState.currentTab === 'habits-tab') {
                if (subjectSubNav) subjectSubNav.classList.add('hidden');
                if (habitsSubNav) habitsSubNav.classList.remove('hidden');
                
                // İlk alt sekmeyi yükle
                const currentHabitsSub = appState.currentHabitsSub || 'habits';
                switchHabitsSubTab(currentHabitsSub);
            } else {
                if (subjectSubNav) subjectSubNav.classList.remove('hidden');
                if (habitsSubNav) habitsSubNav.classList.add('hidden');

                // Load specific tab data
                // appState.currentSubject kullan (zaten güncel)
                if (appState.currentTab === 'questions-tab') {
                    loadQuestionsDashboard(appState.currentSubject);
                } else if (appState.currentTab === 'notes-tab') {
                    loadNotesDashboard(appState.currentSubject);
                } else if (appState.currentTab === 'subjects-tab') {
                    loadTopics(appState.currentSubject);
                } else if (appState.currentTab === 'voice-library-tab') {
                    loadVoiceLibrary();
                } else if (appState.currentTab === 'resources-tab') {
                    loadResources();
                }
            }
        });
    });

    // Clear All button in Today tab
    document.querySelector('#today-tab .small-btn')?.addEventListener('click', async () => {
        if (await showConfirm('Bugünkü tüm çalışmaları temizlemek istediğine emin misin?')) {
            clearTodayTasks(appState.currentSubject); // Actually cleans all if logic handles it
            loadTodayTasks();
        }
    });
}

function setupSubjectChips() {
    const chips = document.querySelectorAll('.chip');

    chips.forEach(chip => {
        chip.addEventListener('click', () => {
            // Switch active chip
            chips.forEach(c => c.classList.remove('active'));
            chip.classList.add('active');

            const subject = chip.getAttribute('data-subject');
            appState.currentSubject = subject;
            persistState();

            // Update UI Title
            const titleEl = document.getElementById('current-subject-title');
            if (titleEl) titleEl.textContent = chip.textContent;

            // Reload Data based on current tab
            // Subject'i direkt parametre olarak geçir (her zaman doğru değeri kullan)
            if (appState.currentTab === 'questions-tab') {
                loadQuestionsDashboard(subject);
            } else if (appState.currentTab === 'today-tab') {
                // Technically chips are hidden here, but if logic changes...
                loadTodayTasks();
            } else if (appState.currentTab === 'notes-tab') {
                loadNotesDashboard(subject);
            } else if (appState.currentTab === 'subjects-tab') {
                loadTopics(subject);
            } else if (appState.currentTab === 'voice-library-tab') {
                loadVoiceLibrary();
            } else if (appState.currentTab === 'knowledge-tab') {
                loadKnowledgeBase();
            } else if (appState.currentTab === 'resources-tab') {
                loadResources();
            }
        });
    });
}

function setupHabitsSubTabs() {
    const chips = document.querySelectorAll('[data-habits-sub]');
    
    chips.forEach(chip => {
        chip.addEventListener('click', () => {
            const subTab = chip.getAttribute('data-habits-sub');
            switchHabitsSubTab(subTab);
        });
    });
}

function switchHabitsSubTab(subTab) {
    // Switch active chip
    document.querySelectorAll('[data-habits-sub]').forEach(c => c.classList.remove('active'));
    const activeChip = document.querySelector(`[data-habits-sub="${subTab}"]`);
    if (activeChip) activeChip.classList.add('active');

    // Switch content
    document.querySelectorAll('.habits-sub-content').forEach(c => c.classList.remove('active'));
    const activeContent = document.getElementById(`${subTab}-sub-content`);
    if (activeContent) activeContent.classList.add('active');

    // Save state
    appState.currentHabitsSub = subTab;
    persistState();

    // Load data
    if (subTab === 'habits') {
        loadHabits();
    } else if (subTab === 'cevsen') {
        loadCevsen();
    } else if (subTab === 'yasin') {
        loadYasin();
    }
}

function setupThemeToggle() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;

    // Check system preference
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.documentElement.setAttribute('data-theme', 'dark');
        btn.textContent = '☀️';
    }

    btn.addEventListener('click', () => {
        const doc = document.documentElement;
        if (doc.getAttribute('data-theme') === 'dark') {
            doc.removeAttribute('data-theme');
            btn.textContent = '🌙';
        } else {
            doc.setAttribute('data-theme', 'dark');
            btn.textContent = '☀️';
        }
    });
}

function setupCountdownTimer() {
    const examTypeSelect = document.getElementById('exam-type-select');
    
    const daysValue = document.getElementById('days-value');
    const hoursValue = document.getElementById('hours-value');
    const minutesValue = document.getElementById('minutes-value');
    const secondsValue = document.getElementById('seconds-value');
    
    const daysProgress = document.getElementById('days-progress');
    const hoursProgress = document.getElementById('hours-progress');
    const minutesProgress = document.getElementById('minutes-progress');
    const secondsProgress = document.getElementById('seconds-progress');
    
    if (!daysValue || !hoursValue || !minutesValue || !secondsValue) return;
    
    const circumference = 2 * Math.PI * 45; // radius = 45
    
    // Calculate max days for progress calculation (based on initial difference)
    if (examTypeSelect) {
        examTypeSelect.value = appState.examType || 'lisans';
        examTypeSelect.addEventListener('change', () => {
            appState.examType = examTypeSelect.value;
            persistState();
            updateCountdown();
            renderStatsTab();
            renderFocusPanel();
        });
    }
    
    function updateCountdown() {
        const targetDate = getExamDateByType(appState.examType || 'lisans');
        const now = new Date();
        const diff = targetDate - now;
        const initialTotalDays = Math.max(1, Math.ceil(diff / (1000 * 60 * 60 * 24)));
        const maxDays = Math.max(initialTotalDays, 365);
        
        if (diff <= 0) {
            // Countdown finished
            daysValue.textContent = '0';
            hoursValue.textContent = '0';
            minutesValue.textContent = '0';
            secondsValue.textContent = '0';
            
            daysProgress.style.strokeDashoffset = circumference;
            hoursProgress.style.strokeDashoffset = circumference;
            minutesProgress.style.strokeDashoffset = circumference;
            secondsProgress.style.strokeDashoffset = circumference;
            return;
        }
        
        const totalDays = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);
        
        // Update values
        daysValue.textContent = totalDays.toString();
        hoursValue.textContent = hours.toString();
        minutesValue.textContent = minutes.toString();
        secondsValue.textContent = seconds.toString();
        
        // Calculate progress percentages
        // Days: progress based on remaining days vs max days
        const daysPercent = Math.min(totalDays / maxDays, 1);
        daysProgress.style.strokeDashoffset = circumference * (1 - daysPercent);
        
        // Hours: 0-23 (24 hours)
        const hoursPercent = hours / 24;
        hoursProgress.style.strokeDashoffset = circumference * (1 - hoursPercent);
        
        // Minutes: 0-59 (60 minutes)
        const minutesPercent = minutes / 60;
        minutesProgress.style.strokeDashoffset = circumference * (1 - minutesPercent);
        
        // Seconds: 0-59 (60 seconds)
        const secondsPercent = seconds / 60;
        secondsProgress.style.strokeDashoffset = circumference * (1 - secondsPercent);
    }
    
    // Update immediately
    updateCountdown();
    
    // Update every second
    setInterval(updateCountdown, 1000);
}
