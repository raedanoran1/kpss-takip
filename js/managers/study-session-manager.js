import { saveStudySession, addStudyNote, addVoiceNote, getStudyNotes, getTodayTasks, removeFromToday, deleteNote, getTopicTodayStats } from '../db.js';
import { formatDuration } from '../utils/format-utils.js';
import { showToast, showConfirm } from '../utils/ui-utils.js';
import { appState, persistState } from '../state/app-state.js';
import { loadTodayTasks } from './today-manager.js';
import { recordFocusBreak, getTodayBreakCount } from './focus-tracker-manager.js';

// --- Session Global Variables ---
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = 0;
let recordingTimer = null;

const activeTimers = {};

let studySeconds = 0;
let currentStudyTopicId = null;
let currentStudyTaskId = null;
let sessionImages = [];
let sessionQCount = 0;
let studySubject = '';
let activeRecordingTopicId = null; // Tracks which topic owns the active recording

function updateFocusBreakBtnDisplay(btn, count = null) {
    const c = count !== null ? count : getTodayBreakCount();
    const countEl = btn.querySelector('.focus-break-count');
    if (countEl) countEl.textContent = c;
}

export function setupStudySessionUI() {
    const timerToggleBtn = document.getElementById('timer-toggle-btn');
    if (timerToggleBtn) {
        timerToggleBtn.addEventListener('click', toggleStudyTimer);
    }

    const timerStopBtn = document.getElementById('timer-stop-btn');
    if (timerStopBtn) {
        timerStopBtn.addEventListener('click', async () => {
            if (await showConfirm('Çalışmayı bitirmek istediğine emin misin?')) {
                stopStudySession();
                const sessionInterface = document.getElementById('study-session-interface');
                if (sessionInterface) sessionInterface.classList.add('hidden');
                loadTodayTasks();
            }
        });
    }

    const focusBreakBtn = document.getElementById('focus-break-btn');
    if (focusBreakBtn) {
        updateFocusBreakBtnDisplay(focusBreakBtn);
        focusBreakBtn.addEventListener('click', async () => {
            const count = await recordFocusBreak(currentStudyTopicId);
            updateFocusBreakBtnDisplay(focusBreakBtn, count);
            showToast(`Dikkat kırılması kaydedildi. Bugün: ${count}`, 'warning');
        });
    }

    const exitSessionBtn = document.getElementById('exit-session-btn');
    if (exitSessionBtn) {
        exitSessionBtn.addEventListener('click', () => {
            const sessionInterface = document.getElementById('study-session-interface');
            if (sessionInterface) sessionInterface.classList.add('hidden');
            if (typeof loadTodayTasks === 'function') loadTodayTasks();
        });
    }

    // Chat Logic
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send-btn');
    const imgBtn = document.getElementById('chat-img-btn');
    const fileInput = document.getElementById('chat-file-input');

    const sendMessage = async () => {
        const text = chatInput.value.trim();
        const imagesToUpload = [...sessionImages];

        if (text || imagesToUpload.length > 0) {
            chatInput.value = '';
            sessionImages = [];

            for (const imgBase64 of imagesToUpload) {
                await addStudyNote(studySubject, currentStudyTopicId, '', imgBase64);
            }

            if (text) {
                await addStudyNote(studySubject, currentStudyTopicId, text, null);
            }

            await loadChatHistory(currentStudyTopicId);
        }
    };

    if (sendBtn) sendBtn.addEventListener('click', sendMessage);
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        chatInput.addEventListener('paste', async (e) => {
            const items = (e.clipboardData || e.originalEvent.clipboardData).items;
            for (const item of items) {
                if (item.type.indexOf('image') !== -1) {
                    const blob = item.getAsFile();
                    const resized = await resizeBlob(blob);
                    sessionImages.push(resized);
                    await sendMessage();
                }
            }
        });
    }

    if (imgBtn) imgBtn.addEventListener('click', () => fileInput.click());
    if (fileInput) {
        fileInput.addEventListener('change', async () => {
            if (fileInput.files.length > 0) {
                for (const file of fileInput.files) {
                    const resized = await resizeBlob(file);
                    sessionImages.push(resized);
                }
                chatInput.focus();
                await sendMessage();
                fileInput.value = '';
            }
        });
    }

    // --- Voice Recording Listeners (Offscreen API) ---
    const micBtn = document.getElementById('chat-mic-btn');
    const recordingBar = document.getElementById('recording-bar');
    const recordingTimeDisplay = document.getElementById('recording-time');
    const stopRecordingBtn = document.getElementById('stop-recording-btn');
    const cancelRecordingBtn = document.getElementById('cancel-recording-btn');
    const pauseRecordBtn = document.getElementById('pause-record-btn');

    let recordingPaused = false;
    let totalPausedTime = 0;
    let pausedAt = 0;

    // Listener for messages from offscreen
    chrome.runtime.onMessage.addListener((message) => {
        if (message.target !== 'sidepanel') return;

        if (message.type === 'VOICE_NOTE_DATA') {
            // PDF kayıtları için değil, sadece study session kayıtları için işle
            // PDF kayıtları pdf-viewer-manager.js'de işleniyor
            // Eğer activeRecordingResourceId varsa (PDF kaydı), bu listener'ı atla
            if (window.activeRecordingResourceId) {
                return; // PDF kaydı, bu listener'ı atla
            }
            
            // Kayıt mutlaka bir konuya ait olmalı; ownership'i activeRecordingTopicId tutuyor
            // Eğer activeRecordingTopicId yoksa, currentStudyTopicId'yi kullan (fallback)
            const targetTopicId = activeRecordingTopicId || currentStudyTopicId;
            
            if (!targetTopicId) {
                console.warn('[VoiceRecord] VOICE_NOTE_DATA ignored because no active topic is available');
                return;
            }

            // Eğer activeRecordingTopicId yoksa, şimdi set et (geç kalmış olsa bile)
            if (!activeRecordingTopicId && currentStudyTopicId) {
                activeRecordingTopicId = currentStudyTopicId;
            }

            addVoiceNote(studySubject, targetTopicId, message.data).then(() => {
                // Eğer kullanıcı hâlâ aynı konunun chatindeyse, sohbeti yenile
                if (currentStudyTopicId === targetTopicId) {
                    loadChatHistory(currentStudyTopicId);
                }
                
                // Özet bölümünü de yenile (knowledge base)
                if (window.loadKnowledgeBase) {
                    window.loadKnowledgeBase();
                }
                
                // Ses kütüphanesini de yenile
                if (window.loadVoiceLibrary) {
                    window.loadVoiceLibrary();
                }
                
                // Clear recording ownership after successful save
                activeRecordingTopicId = null;
            }).catch(err => {
                console.error('[VoiceRecord] Save failed in study session:', err);
                showToast('Ses kaydı kaydedilemedi: ' + err.message, 'error');
                // Clear ownership on error too
                activeRecordingTopicId = null;
            });
        } else if (message.type === 'RECORDING_STARTED') {
            // Eğer PDF tarafında bir kayıt başlatıldıysa, study session UI'sini etkileme
            if (window.activeRecordingResourceId) {
                return;
            }

            // RECORDING_STARTED geldiğinde activeRecordingTopicId'yi set et (eğer henüz set edilmemişse)
            if (!activeRecordingTopicId && currentStudyTopicId) {
                activeRecordingTopicId = currentStudyTopicId;
            }
            
            recordingStartTime = Date.now();
            recordingPaused = false;
            totalPausedTime = 0;
            
            if (recordingBar) {
                recordingBar.classList.remove('hidden');
                recordingBar.classList.remove('paused');
            }
            
            if (pauseRecordBtn) {
                pauseRecordBtn.innerHTML = '⏸️';
            }

            recordingTimer = setInterval(() => {
                if (recordingPaused) return;
                const elapsed = Math.floor((Date.now() - recordingStartTime - totalPausedTime) / 1000);
                const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
                const s = (elapsed % 60).toString().padStart(2, '0');
                if (recordingTimeDisplay) {
                    recordingTimeDisplay.textContent = `${m}:${s}`;
                }
            }, 1000);
        } else if (message.type === 'RECORDING_ERROR') {
            console.error('Recording error:', message.error);
            if (recordingTimer) {
                clearInterval(recordingTimer);
                recordingTimer = null;
            }
            if (recordingBar) {
                recordingBar.classList.add('hidden');
            }
            // Clear ownership on error
            activeRecordingTopicId = null;
            
            if (message.error === 'NotAllowedError' || message.error === 'SecurityError') {
                showToast('Mikrofon izni gerekebilir. Ayarlar sayfası açılıyor...', 'warning');
                if (chrome.runtime && chrome.runtime.openOptionsPage) {
                    chrome.runtime.openOptionsPage();
                }
            } else {
                showToast('Kayıt başlatılamadı!', 'error');
            }
        }
    });

    const startRecording = async () => {
        // Prevent new recording if another topic has an active draft
        if (activeRecordingTopicId && activeRecordingTopicId !== currentStudyTopicId) {
            showToast('Başka bir konuda devam eden kaydınız var. Önce onu tamamlayın.', 'warning');
            return;
        }

        activeRecordingTopicId = currentStudyTopicId;

        // Create Offscreen if not exists
        const existingContexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT']
        });

        if (existingContexts.length === 0) {
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['AUDIO_PLAYBACK', 'USER_MEDIA'],
                justification: 'Recording voice notes for study track.'
            });
        }

        const stored = await chrome.storage.local.get('preferredMicId');
        chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'START_RECORDING',
            micId: stored.preferredMicId
        });
    };

    const stopRecordingAction = (save) => {
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_RECORDING', save });
        if (recordingTimer) {
            clearInterval(recordingTimer);
            recordingTimer = null;
        }
        if (recordingBar) {
            recordingBar.classList.add('hidden');
        }
        if (recordingTimeDisplay) {
            recordingTimeDisplay.textContent = '00:00';
        }
        // Clear ownership only if not saving (if saving, VOICE_NOTE_DATA will handle it)
        if (!save) {
            activeRecordingTopicId = null;
        }
    };

    const togglePauseRecording = () => {
        if (!recordingPaused) {
            // Pause
            chrome.runtime.sendMessage({ target: 'offscreen', type: 'PAUSE_RECORDING' });
            recordingPaused = true;
            pausedAt = Date.now();
            if (recordingBar) {
                recordingBar.classList.add('paused');
            }
            if (pauseRecordBtn) {
                pauseRecordBtn.innerHTML = '▶️';
            }
        } else {
            // Resume
            chrome.runtime.sendMessage({ target: 'offscreen', type: 'RESUME_RECORDING' });
            recordingPaused = false;
            totalPausedTime += (Date.now() - pausedAt);
            if (recordingBar) {
                recordingBar.classList.remove('paused');
            }
            if (pauseRecordBtn) {
                pauseRecordBtn.innerHTML = '⏸️';
            }
        }
    };

    if (micBtn) micBtn.addEventListener('click', startRecording);
    if (stopRecordingBtn) stopRecordingBtn.addEventListener('click', () => stopRecordingAction(true));
    if (cancelRecordingBtn) cancelRecordingBtn.addEventListener('click', () => stopRecordingAction(false));
    if (pauseRecordBtn) pauseRecordBtn.addEventListener('click', togglePauseRecording);

    // Question Tracker
    const qInput = document.getElementById('session-q-input');
    const qAddBtn = document.getElementById('session-q-add-btn');

    if (qAddBtn) {
        qAddBtn.addEventListener('click', async () => {
            const count = parseInt(qInput.value);
            if (count > 0) {
                saveStudySession(currentStudyTopicId, studySubject, 0, count);
                sessionQCount += count;
                updateSessionQDisplay();
                qInput.value = '';
                updateUncommitted(currentStudyTopicId, studySeconds);
                if (appState.currentTab === 'today-tab') loadTodayTasks();
            }
        });
    }
}

function updateSessionQDisplay() {
    const totalEl = document.getElementById('session-q-total');
    if (totalEl) totalEl.innerHTML = `✍️ ${sessionQCount}`;
}

// Export study session manager instance for global access
export const studySessionManager = {
    get currentStudyTopicId() { return currentStudyTopicId; },
    get studySubject() { return studySubject; },
    loadChatHistory: loadChatHistory
};

// Make it globally accessible
window.studySessionManager = studySessionManager;
// Make activeRecordingTopicId globally accessible for PDF listener to check
Object.defineProperty(window, 'activeRecordingTopicId', {
    get: () => activeRecordingTopicId,
    enumerable: true,
    configurable: true
});

export function initStudySession(topicId, topicName, subject, taskId) {
    if (currentStudyTopicId && activeTimers[currentStudyTopicId]) {
        updateUncommitted(currentStudyTopicId, studySeconds);
    }

    currentStudyTopicId = topicId;
    currentStudyTaskId = taskId;
    studySubject = subject;

    const stats = getTopicTodayStats(topicId);
    sessionQCount = stats.questions;
    studySeconds = appState.uncommitedTimes[topicId] || 0;

    document.getElementById('session-topic-title').textContent = topicName;
    updateTimerDisplay();
    updateSessionQDisplay();

    // Clear previous chat history from UI before loading new ones
    const chatList = document.getElementById('chat-history');
    if (chatList) chatList.innerHTML = '';

    // Recording Persistence Logic
    const recordingBar = document.getElementById('recording-bar');

    if (activeRecordingTopicId === currentStudyTopicId) {
        // We returned to the topic with the active recording -> Restore UI
        if (recordingBar) {
            recordingBar.classList.remove('hidden');
            // Timer is already running globally, so it updates automatically
        }
    } else {
        // Switching to a different topic -> Hide UI but keep state
        if (recordingBar) recordingBar.classList.add('hidden');
    }

    const interfaceEl = document.getElementById('study-session-interface');
    if (interfaceEl) interfaceEl.classList.remove('hidden');

    const focusBreakBtn = document.getElementById('focus-break-btn');
    if (focusBreakBtn) updateFocusBreakBtnDisplay(focusBreakBtn);

    const btn = document.getElementById('timer-toggle-btn');
    if (btn) {
        if (activeTimers[topicId]) {
            btn.textContent = 'Duraklat';
            btn.className = 'timer-btn active';
        } else {
            btn.textContent = studySeconds > 0 ? 'Çalışmaya Devam Et' : 'Başlat';
            btn.className = 'timer-btn stopped';
        }
    }

    loadChatHistory(topicId);
}

export function toggleStudyTimer() {
    const btn = document.getElementById('timer-toggle-btn');
    if (activeTimers[currentStudyTopicId]) {
        clearInterval(activeTimers[currentStudyTopicId].intervalId);
        delete activeTimers[currentStudyTopicId];
        updateUncommitted(currentStudyTopicId, studySeconds);
        btn.textContent = 'Çalışmaya Devam Et';
        btn.className = 'timer-btn stopped';
    } else {
        btn.textContent = 'Duraklat';
        btn.className = 'timer-btn active';
        const topicId = currentStudyTopicId;

        const intervalId = setInterval(() => {
            if (!appState.uncommitedTimes[topicId]) appState.uncommitedTimes[topicId] = 0;
            appState.uncommitedTimes[topicId]++;

            if (currentStudyTopicId === topicId) {
                studySeconds = appState.uncommitedTimes[topicId];
                updateTimerDisplay();
            }

            if (appState.uncommitedTimes[topicId] % 5 === 0) {
                updateUncommitted(topicId, appState.uncommitedTimes[topicId]);
            }
        }, 1000);

        activeTimers[topicId] = { intervalId: intervalId };
    }
}

export function updateTimerDisplay() {
    const h = Math.floor(studySeconds / 3600);
    const m = Math.floor((studySeconds % 3600) / 60);
    const s = studySeconds % 60;
    const formatted = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    const el = document.getElementById('session-timer');
    if (el) el.textContent = formatted;
}

export function stopStudySession() {
    if (studySeconds > 0) {
        saveStudySession(currentStudyTopicId, studySubject, studySeconds, 0);
        showToast(`${Math.floor(studySeconds / 60)} dk çalışma kaydedildi.`);
        appState.uncommitedTimes[currentStudyTopicId] = 0;
        persistState();
    }
    if (activeTimers[currentStudyTopicId]) {
        clearInterval(activeTimers[currentStudyTopicId].intervalId);
        delete activeTimers[currentStudyTopicId];
    }
    studySeconds = 0;
    sessionQCount = 0;
}

function updateUncommitted(topicId, currentTotalSeconds) {
    if (!appState.uncommitedTimes[topicId]) appState.uncommitedTimes[topicId] = 0;
    appState.uncommitedTimes[topicId] = currentTotalSeconds;
    persistState();
}

export async function loadChatHistory(topicId) {
    const list = document.getElementById('chat-history');
    if (!list) return;

    const notes = getStudyNotes(topicId);
    const wasAtBottom = (list.parentElement.scrollHeight - list.parentElement.scrollTop - list.parentElement.clientHeight) < 150;

    const existingIds = new Set();
    list.querySelectorAll('.chat-bubble').forEach(el => existingIds.add(parseInt(el.dataset.id)));

    for (const note of notes) {
        if (existingIds.has(note.id)) continue;

        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';
        bubble.dataset.id = note.id;

        const del = document.createElement('button');
        del.className = 'chat-bubble-delete';
        del.innerHTML = '✕';
        del.onclick = async (e) => {
            e.stopPropagation();
            await deleteNote(note.id, note.image_storage_key || note.audio_storage_key);
            bubble.remove();
        };
        bubble.appendChild(del);

        if (note.image_storage_key && typeof note.image_storage_key === 'string') {
            const data = await chrome.storage.local.get(note.image_storage_key);
            const base64 = data[note.image_storage_key];
            if (base64) {
                const img = document.createElement('img');
                img.src = base64;
                img.className = 'chat-img';
                img.onload = () => { if (wasAtBottom) list.parentElement.scrollTop = list.parentElement.scrollHeight; };
                bubble.appendChild(img);
            }
        }

        if (note.audio_storage_key && typeof note.audio_storage_key === 'string') {
            const data = await chrome.storage.local.get(note.audio_storage_key);
            const base64 = data[note.audio_storage_key];
            if (base64) {
                bubble.appendChild(createAudioPlayer(base64));
            }
        }

        if (note.content) {
            const text = document.createElement('div');
            text.className = 'chat-text';
            text.innerText = note.content;
            bubble.appendChild(text);
        }

        const date = new Date(note.created_at);
        const time = document.createElement('div');
        time.className = 'chat-time';
        time.textContent = date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
        bubble.appendChild(time);

        list.appendChild(bubble);
    }

    if (wasAtBottom || list.children.length < 5) {
        setTimeout(() => { list.parentElement.scrollTop = list.parentElement.scrollHeight; }, 100);
    }
}

function createAudioPlayer(base64) {
    const container = document.createElement('div');
    container.className = 'audio-note-container';

    const ctrl = document.createElement('div');
    ctrl.className = 'audio-controls';

    const pBtn = document.createElement('button');
    pBtn.className = 'audio-play-btn';
    pBtn.innerHTML = '▶️';

    const prog = document.createElement('div');
    prog.className = 'audio-progress-container';
    const bar = document.createElement('div');
    bar.className = 'audio-progress-bar';
    prog.appendChild(bar);

    const time = document.createElement('span');
    time.className = 'audio-time';
    time.textContent = '0:00';

    const speed = document.createElement('button');
    speed.className = 'audio-speed-btn';
    speed.textContent = '1x';

    ctrl.appendChild(pBtn);
    ctrl.appendChild(prog);
    ctrl.appendChild(speed);
    ctrl.appendChild(time);
    container.appendChild(ctrl);

    const formatTime = (seconds) => {
        if (isNaN(seconds)) return '0:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60).toString().padStart(2, '0');
        return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
    };

    const updateDisplay = () => {
        if (!audio.paused || audio.currentTime > 0) {
            time.textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`;
        } else {
            time.textContent = formatTime(audio.duration);
        }
    };

    const audio = new Audio(base64);
    let sIdx = 0;
    const speeds = [1, 1.5, 2, 3];

    audio.onloadedmetadata = updateDisplay;

    pBtn.onclick = async () => {
        try {
            if (audio.paused) {
                const playPromise = audio.play();
                if (playPromise !== undefined) {
                    await playPromise;
                }
                pBtn.innerHTML = '⏸️';
            } else {
                audio.pause();
                pBtn.innerHTML = '▶️';
            }
            updateDisplay();
        } catch (err) {
            console.error('Audio playback error (chat player):', err);
        }
    };

    speed.onclick = () => {
        sIdx = (sIdx + 1) % speeds.length;
        audio.playbackRate = speeds[sIdx];
        speed.textContent = speeds[sIdx] + 'x';
    };

    audio.ontimeupdate = () => {
        bar.style.width = (audio.currentTime / audio.duration) * 100 + '%';
        updateDisplay();
    };

    audio.onended = () => {
        pBtn.innerHTML = '▶️';
        bar.style.width = '0%';
        updateDisplay();
    };

    prog.onclick = (e) => {
        const rect = prog.getBoundingClientRect();
        audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
    };

    return container;
}

async function resizeBlob(blob) {
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.src = e.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let w = img.width;
                let h = img.height;
                if (w > 800) { h = (h * 800) / w; w = 800; }
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', 0.7));
            };
        };
        reader.readAsDataURL(blob);
    });
}
