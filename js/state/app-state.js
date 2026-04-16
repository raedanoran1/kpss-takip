export const appState = {
    currentSubject: 'matematik',
    currentTab: 'today-tab',
    currentHabitsSub: 'habits', // 'habits' or 'cevsen'
    examType: 'lisans',
    focusPanelEnabled: false,
    activeFocusCategory: 'mola',
    statsStartDate: '',
    statsTargetHours: 8,

    // Volatile Study Session State (Shared across managers)
    uncommitedTimes: {}, // topicId -> seconds

    // Streak & First Study Time Tracking
    streakData: {}, // dateKey -> { completed: bool, firstStudyTime: 'HH:MM' }

    // Topic difficulty levels (topicId -> 'easy'|'medium'|'hard')
    topicDifficulty: {},

    // Today list custom drag-sort order (array of taskIds)
    todayTaskOrder: []
};

export async function persistState() {
    await chrome.storage.local.set({ 'app_state': appState });
}

export async function loadState() {
    const data = await chrome.storage.local.get('app_state');
    if (data.app_state) {
        Object.assign(appState, data.app_state);

        // Ensure sub-nav visibility matches loaded tab
        const subNav = document.querySelector('.sub-nav-scroll');
        if (subNav) {
            if (
                appState.currentTab === 'today-tab' ||
                appState.currentTab === 'trials-tab' ||
                appState.currentTab === 'backup-tab' ||
                appState.currentTab === 'study-stats-tab' ||
                appState.currentTab === 'speed-reading-tab'
            ) {
                subNav.classList.add('hidden');
            } else {
                subNav.classList.remove('hidden');
            }
        }
    }
}
