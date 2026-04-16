import { getSubjectVoiceNotes, addVoiceNote } from '../db.js';
import { appState } from '../state/app-state.js';
import { formatDuration } from '../utils/format-utils.js';

class GlobalVoicePlayer {
    constructor() {
        this.audio = new Audio();
        this.queue = [];
        this.currentIndex = -1;
        this.isPlaying = false;
        this.sleepTimerId = null;

        // UI Elements
        this.trackName = document.getElementById('player-track-name');
        this.topicName = document.getElementById('player-topic-name');
        this.seek = document.getElementById('player-seek-bar');
        this.timeCurrent = document.getElementById('player-time-current');
        this.timeTotal = document.getElementById('player-time-total');
        this.toggleBtn = document.getElementById('player-toggle');
        this.prevBtn = document.getElementById('player-prev');
        this.nextBtn = document.getElementById('player-next');
        this.rewindBtn = document.getElementById('player-rewind');
        this.forwardBtn = document.getElementById('player-forward');
        this.speedSelect = document.getElementById('player-speed-select');
        this.sleepSelect = document.getElementById('player-sleep-timer');

        this.initEventListeners();
    }

    initEventListeners() {
        this.toggleBtn.addEventListener('click', () => this.togglePlayback());
        this.prevBtn.addEventListener('click', () => this.playPrevious());
        this.nextBtn.addEventListener('click', () => this.playNext());
        this.rewindBtn.addEventListener('click', () => this.seekBy(-10));
        this.forwardBtn.addEventListener('click', () => this.seekBy(10));

        this.seek.addEventListener('input', (e) => {
            if (this.audio.duration) {
                this.audio.currentTime = this.seek.value;
            }
        });

        this.speedSelect.addEventListener('change', () => {
            this.audio.playbackRate = parseFloat(this.speedSelect.value);
        });

        this.sleepSelect.addEventListener('change', () => {
            this.setSleepTimer(parseInt(this.sleepSelect.value));
        });

        this.audio.addEventListener('timeupdate', () => this.updateProgress());
        this.audio.addEventListener('ended', () => this.playNext());
        this.audio.addEventListener('loadedmetadata', () => {
            this.seek.max = this.audio.duration;
            this.timeTotal.textContent = this.formatTime(this.audio.duration);
        });

        this.audio.addEventListener('play', () => {
            this.isPlaying = true;
            this.toggleBtn.textContent = '⏸️';
            this.updateLibraryHighlight();
        });

        this.audio.addEventListener('pause', () => {
            this.isPlaying = false;
            this.toggleBtn.textContent = '▶️';
        });
    }

    async setQueue(notes, startIndex = 0) {
        this.queue = notes;
        this.currentIndex = startIndex;
        await this.loadTrack(this.currentIndex);
    }

    async loadTrack(index) {
        if (index < 0 || index >= this.queue.length) return;

        // Pause existing before setting new src
        this.audio.pause();

        const track = this.queue[index];
        const storedNote = await chrome.storage.local.get(track.audioStorageKey);

        if (storedNote[track.audioStorageKey]) {
            this.audio.src = storedNote[track.audioStorageKey];
            this.audio.load();
            this.audio.playbackRate = parseFloat(this.speedSelect.value);

            this.trackName.textContent = track.content || `Ses Kaydı #${track.id}`;
            this.topicName.textContent = track.topicName;

            this.safePlay();
        }
    }

    async safePlay() {
        try {
            const playPromise = this.audio.play();
            if (playPromise !== undefined) {
                await playPromise;
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('Playback interrupted (expected on rapid switch)');
            } else {
                console.error('Audio playback error:', error);
            }
        }
    }

    togglePlayback() {
        if (this.currentIndex === -1 && this.queue.length > 0) {
            this.loadTrack(0);
            return;
        }
        if (this.audio.paused) this.safePlay();
        else this.audio.pause();
    }

    playNext() {
        if (this.currentIndex < this.queue.length - 1) {
            this.currentIndex++;
            this.loadTrack(this.currentIndex);
        }
    }

    playPrevious() {
        if (this.currentIndex > 0) {
            this.currentIndex--;
            this.loadTrack(this.currentIndex);
        }
    }

    seekBy(seconds) {
        this.audio.currentTime = Math.max(0, Math.min(this.audio.duration, this.audio.currentTime + seconds));
    }

    updateProgress() {
        if (!this.audio.duration) return;
        this.seek.value = this.audio.currentTime;
        this.timeCurrent.textContent = this.formatTime(this.audio.currentTime);
    }

    formatTime(seconds) {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    setSleepTimer(minutes) {
        if (this.sleepTimerId) clearTimeout(this.sleepTimerId);
        if (minutes === 0) return;

        this.sleepTimerId = setTimeout(() => {
            this.audio.pause();
            this.sleepSelect.value = '0';
        }, minutes * 60 * 1000);
    }

    updateLibraryHighlight() {
        document.querySelectorAll('.voice-item-card').forEach(el => el.classList.remove('playing'));
        if (this.currentIndex !== -1) {
            const currentTrackId = this.queue[this.currentIndex].id;
            const card = document.querySelector(`.voice-item-card[data-id="${currentTrackId}"]`);
            if (card) card.classList.add('playing');
        }
    }
}

let playerInstance = null;

export function setupVoiceLibraryUI() {
    if (!playerInstance) playerInstance = new GlobalVoicePlayer();
}

export function loadVoiceLibrary() {
    const listEl = document.getElementById('voice-library-list');
    listEl.innerHTML = '';

    const notes = getSubjectVoiceNotes(appState.currentSubject);

    if (notes.length === 0) {
        listEl.innerHTML = '<p class="empty-state">Bu derste henüz sesli not bulunmuyor.</p>';
        return;
    }

    // Group by topics
    const grouped = {};
    notes.forEach(n => {
        if (!grouped[n.topicName]) grouped[n.topicName] = [];
        grouped[n.topicName].push(n);
    });

    for (const [topicName, topicNotes] of Object.entries(grouped)) {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'voice-topic-group';

        groupDiv.innerHTML = `
            <h4>${topicName}</h4>
            <div class="voice-items-grid"></div>
        `;

        const grid = groupDiv.querySelector('.voice-items-grid');

        topicNotes.forEach(note => {
            const card = document.createElement('div');
            card.className = 'voice-item-card';
            card.dataset.id = note.id;

            const dateStr = new Date(note.createdAt).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

            card.innerHTML = `
                <div class="voice-card-icon">🎙️</div>
                <div class="voice-card-info">
                    <span class="voice-card-name">${note.content || `Ses Kaydı #${note.id}`}</span>
                    <span class="voice-card-date">${dateStr}</span>
                </div>
            `;

            card.addEventListener('click', () => {
                const index = notes.findIndex(n => n.id === note.id);
                playerInstance.setQueue(notes, index);
            });

            grid.appendChild(card);
        });

        listEl.appendChild(groupDiv);
    }

    // Update highlight if something is playing
    playerInstance.updateLibraryHighlight();
}

// --- Debug / Test Helpers ---
// Ses kaydı akışını uçtan uca test etmek için yardımcı fonksiyon.
// Tarayıcı konsolundan window.runVoicePipelineTest() ile çağrılabilir.
window.runVoicePipelineTest = async function () {
    try {
        const subject = appState.currentSubject || 'matematik';
        const topicId = 'res_999999'; // Test amaçlı sanal bir resource id
        const dummyAudio = 'data:audio/webm;base64,TEST';

        console.log('[VoiceTest] Adding dummy voice note...', { subject, topicId });
        await addVoiceNote(subject, topicId, dummyAudio);

        const notes = getSubjectVoiceNotes(subject);
        const last = notes[notes.length - 1];

        console.log('[VoiceTest] getSubjectVoiceNotes result:', { count: notes.length, last });
        if (!last || !last.audioStorageKey) {
            console.warn('[VoiceTest] Son kayıt bulunamadı veya audioStorageKey yok.');
        } else {
            const stored = await chrome.storage.local.get(last.audioStorageKey);
            console.log('[VoiceTest] chrome.storage.local check:', {
                hasAudio: !!stored[last.audioStorageKey],
                key: last.audioStorageKey
            });
        }

        // UI'yi yenile
        loadVoiceLibrary();
        console.log('[VoiceTest] Voice library reloaded.');
    } catch (err) {
        console.error('[VoiceTest] Error during pipeline test:', err);
    }
};
