import { getTopics, getStudyNotes, getResources } from '../db.js';
import { appState } from '../state/app-state.js';

class KnowledgeManager {
    constructor() {
        this.synth = window.speechSynthesis;
        this.currentUtterance = null;
        this.isPaused = false;
        this.allNotes = []; // Flattened notes for linear reading
        this.currentNoteIndex = -1;
        this.wordSpans = [];

        // UI Elements
        this.container = document.getElementById('knowledge-document');
        this.pdfBtn = document.getElementById('knowledge-pdf-btn');
        this.ttsBtn = document.getElementById('knowledge-tts-btn');
        this.ttsControls = document.getElementById('knowledge-tts-controls');
        this.ttsStatus = document.getElementById('tts-status');
        this.ttsPauseBtn = document.getElementById('tts-pause-btn');
        this.ttsStopBtn = document.getElementById('tts-stop-btn');
        this.ttsSpeedSelect = null;

        this.initEventListeners();
    }

    initEventListeners() {
        if (this.pdfBtn) this.pdfBtn.addEventListener('click', () => this.exportPDF());
        if (this.ttsBtn) this.ttsBtn.addEventListener('click', () => this.startReadingFromServer(0));

        if (this.ttsPauseBtn) {
            this.ttsPauseBtn.addEventListener('click', () => {
                if (this.synth.speaking) {
                    if (this.synth.paused) {
                        this.synth.resume();
                        this.ttsPauseBtn.textContent = '⏸️';
                    } else {
                        this.synth.pause();
                        this.ttsPauseBtn.textContent = '▶️';
                    }
                }
            });
        }

        if (this.ttsStopBtn) {
            this.ttsStopBtn.addEventListener('click', () => this.stopReading());
        }

        // Add Speed Select if not exists
        if (this.ttsControls && !document.getElementById('tts-speed-select')) {
            const select = document.createElement('select');
            select.id = 'tts-speed-select';
            // Default 3x, Max 5x
            select.innerHTML = `
                <option value="1">1x</option>
                <option value="1.5">1.5x</option>
                <option value="2">2x</option>
                <option value="2.5">2.5x</option>
                <option value="3" selected>3x (Varsayılan)</option>
                <option value="3.5">3.5x</option>
                <option value="4">4x</option>
                <option value="5">5x (Max)</option>
            `;
            // CSS is handled in CSS file now, but we can add class
            // Insert before pause button
            this.ttsControls.insertBefore(select, this.ttsPauseBtn);
            this.ttsSpeedSelect = select;

            // Initial UI State
            this.updateTTSUIState(false);

            select.addEventListener('change', () => {
                if (this.synth.speaking && !this.synth.paused) {
                    this.stopReading();
                    this.readNextNote();
                }
            });
        }
    }

    async loadSubjectSummary() {
        // Container henüz DOM'da yoksa sessizce çık (knowledge sekmesi devre dışı)
        if (!this.container) return;

        this.container.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Özet hazırlanıyor...</span></div>';
        this.allNotes = [];
        this.stopReading();

        const topics = getTopics(appState.currentSubject);
        const resources = getResources(appState.currentSubject);
        const docFragment = document.createDocumentFragment();

        if (topics.length === 0 && resources.length === 0) {
            this.container.innerHTML = '<div class="empty-state">Henüz konu veya kaynak eklenmemiş.</div>';
            return;
        }

        // Add PDF Resource Cards Section at the top
        if (resources.length > 0) {
            const resourcesSection = document.createElement('div');
            resourcesSection.className = 'knowledge-resources-section';

            const resourcesTitle = document.createElement('h3');
            resourcesTitle.className = 'resources-section-title';
            resourcesTitle.textContent = '📚 PDF Kaynaklar';
            resourcesSection.appendChild(resourcesTitle);

            const resourcesGrid = document.createElement('div');
            resourcesGrid.className = 'resources-grid';

            resources.forEach(resource => {
                const card = document.createElement('div');
                card.className = 'resource-card';

                // Get voice notes for this resource
                const resourceVoiceNotes = getStudyNotes(`res_${resource.id}`).filter(note => note.audio_storage_key);

                card.innerHTML = `
                    <div class="resource-card-icon">📄</div>
                    <div class="resource-card-info">
                        <div class="resource-card-name">${resource.name}</div>
                        <div class="resource-card-meta">${resource.type || 'PDF'}</div>
                        ${resourceVoiceNotes.length > 0 ? `<div class="resource-voice-count">🎤 ${resourceVoiceNotes.length} ses kaydı</div>` : ''}
                    </div>
                `;

                card.addEventListener('click', async (e) => {
                    // Don't open PDF if clicking on voice notes
                    if (e.target.closest('.resource-voice-item')) return;

                    const { openPDFViewer } = await import('./pdf-viewer-manager.js');
                    openPDFViewer(resource.id, resource.name, resource.last_page || 1);
                });

                // Add voice notes section if exists
                if (resourceVoiceNotes.length > 0) {
                    const voiceSection = document.createElement('div');
                    voiceSection.className = 'resource-voice-section';
                    voiceSection.style.cssText = 'margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.1);';

                    resourceVoiceNotes.forEach(note => {
                        const voiceItem = document.createElement('div');
                        voiceItem.className = 'resource-voice-item';
                        voiceItem.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 4px; cursor: pointer; border-radius: 4px; transition: background 0.2s;';
                        voiceItem.onmouseenter = () => voiceItem.style.background = 'rgba(255,255,255,0.1)';
                        voiceItem.onmouseleave = () => voiceItem.style.background = 'transparent';

                        const playBtn = document.createElement('button');
                        playBtn.textContent = '🔊';
                        playBtn.style.cssText = 'background: none; border: none; font-size: 16px; cursor: pointer; padding: 0;';
                        playBtn.onclick = async (e) => {
                            e.stopPropagation();
                            const audioData = await chrome.storage.local.get(note.audio_storage_key);
                            if (audioData[note.audio_storage_key]) {
                                const audio = new Audio(audioData[note.audio_storage_key]);
                                audio.play();
                            }
                        };

                        const timeSpan = document.createElement('span');
                        timeSpan.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.6);';
                        const noteDate = new Date(note.created_at);
                        timeSpan.textContent = noteDate.toLocaleString('tr-TR', {
                            day: '2-digit',
                            month: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit'
                        });

                        voiceItem.appendChild(playBtn);
                        voiceItem.appendChild(timeSpan);
                        voiceSection.appendChild(voiceItem);
                    });

                    card.appendChild(voiceSection);
                }

                resourcesGrid.appendChild(card);
            });

            resourcesSection.appendChild(resourcesGrid);
            docFragment.appendChild(resourcesSection);
        }

        // Combine regular topics and resources
        const allItems = [
            ...topics.map(t => ({ id: t.id, name: t.name, isResource: false })),
            ...resources.map(r => ({ id: `res_${r.id}`, name: `📄 ${r.name}`, isResource: true }))
        ];

        for (const item of allItems) {
            const topicNotes = getStudyNotes(item.id);
            if (topicNotes.length === 0) continue;

            const block = document.createElement('div');
            block.className = 'summary-topic-block' + (item.isResource ? ' resource-block' : '');

            const title = document.createElement('h4');
            title.className = 'summary-topic-title';
            title.textContent = `📌 ${item.name}`;
            block.appendChild(title);

            const notesList = document.createElement('div');
            notesList.className = 'summary-notes-list';

            topicNotes.forEach(note => {
                const noteItem = document.createElement('div');
                noteItem.className = 'summary-note-item';
                noteItem.dataset.id = note.id;

                // Handle different note types
                if (note.image_storage_key) {
                    // Görsel notları burada sadece metin olarak işaretliyoruz;
                    // detaylı görüntüleme Notlar / PDF sekmelerinden yapılabilir.
                    noteItem.classList.add('image-note');
                    const caption = document.createElement('p');
                    caption.textContent = note.content && note.content.trim()
                        ? `🖼 Görsel not: ${note.content}`
                        : '🖼 Görsel not (detay için Notlar sekmesini kullanın)';
                    noteItem.appendChild(caption);
                } else if (note.audio_storage_key) {
                    // Audio note
                    noteItem.classList.add('audio-note');
                    noteItem.innerHTML = `
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <button class="play-audio-btn" style="font-size: 24px; background: none; border: none; cursor: pointer;">🔊</button>
                            <span>Ses Kaydı</span>
                        </div>
                    `;
                    const playBtn = noteItem.querySelector('.play-audio-btn');
                    playBtn.addEventListener('click', async () => {
                        // Play audio
                        const audioData = await chrome.storage.local.get(note.audio_storage_key);
                        if (audioData[note.audio_storage_key]) {
                            const audio = new Audio(audioData[note.audio_storage_key]);
                            audio.play();
                        }
                    });
                } else if (note.content && note.content.trim()) {
                    // Text note - only these are voice-readable
                    noteItem.dataset.globalIndex = this.allNotes.length;
                    const words = note.content.split(' ');
                    noteItem.innerHTML = words.map(w => `<span class="tts-word">${w}</span>`).join(' ');
                    noteItem.addEventListener('click', () => {
                        this.startReadingFromServer(parseInt(noteItem.dataset.globalIndex));
                    });
                    this.allNotes.push({
                        text: note.content,
                        el: noteItem,
                        words: words
                    });
                }

                notesList.appendChild(noteItem);
            });

            block.appendChild(notesList);
            docFragment.appendChild(block);
        }

        this.container.innerHTML = '';
        if (docFragment.childNodes.length === 0) {
            this.container.innerHTML = '<div class="empty-state">Henüz not bulunmuyor.</div>';
        } else {
            this.container.appendChild(docFragment);
        }
    }

    startReadingFromServer(index) {
        this.stopReading();
        this.currentNoteIndex = index;
        this.updateTTSUIState(true);
        this.readNextNote();
    }

    readNextNote() {
        if (this.currentNoteIndex < 0 || this.currentNoteIndex >= this.allNotes.length) {
            this.stopReading();
            return;
        }

        const note = this.allNotes[this.currentNoteIndex];

        // UI Feedback
        document.querySelectorAll('.summary-note-item').forEach(el => el.classList.remove('currently-reading'));
        note.el.classList.add('currently-reading');
        note.el.scrollIntoView({ behavior: 'smooth', block: 'center' });

        this.currentUtterance = new SpeechSynthesisUtterance(note.text);
        this.currentUtterance.lang = 'tr-TR';
        this.currentUtterance.rate = this.ttsSpeedSelect ? parseFloat(this.ttsSpeedSelect.value) : 3.0; // Default 3.0 if select missing

        const words = note.el.querySelectorAll('.tts-word');

        this.currentUtterance.onboundary = (event) => {
            if (event.name === 'word') {
                const wordIndex = this.getWordIndex(note.text, event.charIndex);
                words.forEach((span, i) => {
                    if (i === wordIndex) span.classList.add('active');
                    else span.classList.remove('active');
                });
            }
        };

        this.currentUtterance.onend = () => {
            words.forEach(span => span.classList.remove('active'));
            this.currentNoteIndex++;
            this.readNextNote();
        };

        this.synth.speak(this.currentUtterance);
    }

    getWordIndex(text, charIndex) {
        const sub = text.substring(0, charIndex);
        return sub.split(' ').length - 1;
    }

    stopReading() {
        this.synth.cancel();
        this.updateTTSUIState(false);
        document.querySelectorAll('.currently-reading').forEach(el => el.classList.remove('currently-reading'));
        document.querySelectorAll('.tts-word.active').forEach(el => el.classList.remove('active'));
    }

    updateTTSUIState(isActive) {
        if (!this.ttsControls) return;

        if (isActive) {
            this.ttsControls.classList.remove('hidden'); // Ensure base class logic works
            this.ttsControls.classList.add('active-mode');
            if (this.ttsStatus) this.ttsStatus.textContent = "Seslendiriliyor...";
            if (this.ttsPauseBtn) this.ttsPauseBtn.textContent = "⏸️";
        } else {
            // "Always visible" but dimmed state
            this.ttsControls.classList.remove('active-mode');
            // We don't add 'hidden' anymore based on CSS change, but just in case
            this.ttsControls.classList.add('hidden'); // CSS overrides this to show dimmed
            if (this.ttsStatus) this.ttsStatus.textContent = "Hazır";
            if (this.ttsPauseBtn) this.ttsPauseBtn.textContent = "▶️";
        }
    }

    exportPDF() {
        // Since we don't have jspdf explicitly loaded, we'll use a sophisticated window.print approach
        // or offer a clean HTML view for specific printing.
        // For this extension, we'll open a new window with just the content and trigger print.
        const printWindow = window.open('', '_blank');
        const subjectName = appState.currentSubject.toUpperCase();

        let html = `
            <html>
            <head>
                <title>KPSS Takip - ${subjectName} Özet</title>
                <style>
                    body { font-family: 'Inter', sans-serif; padding: 40px; color: #333; line-height: 1.6; }
                    h1 { color: #6366f1; border-bottom: 2px solid #6366f1; padding-bottom: 10px; }
                    .topic { margin-top: 30px; }
                    .topic-title { font-weight: bold; font-size: 1.2rem; margin-bottom: 10px; color: #4338ca; }
                    .note { margin-bottom: 15px; padding-left: 15px; border-left: 3px solid #e5e7eb; }
                    @media print { .no-print { display: none; } }
                </style>
            </head>
            <body>
        `;

        const topics = getTopics(appState.currentSubject);
        topics.forEach(t => {
            const notes = getStudyNotes(t.id).filter(n => n.content);
            if (notes.length > 0) {
                html += `<div class="topic">`;
                html += `<div class="topic-title">${t.name}</div>`;
                notes.forEach(n => {
                    html += `<div class="note">${n.content}</div>`;
                });
                html += `</div>`;
            }
        });

        html += `</body></html>`;

        printWindow.document.write(html);
        printWindow.document.close();

        // Inject Print Button Script
        const printBtn = printWindow.document.createElement('button');
        printBtn.className = 'no-print';
        printBtn.innerText = 'PDF Olarak Kaydet / Yazdır';
        printBtn.style.cssText = "padding: 10px 20px; background: #6366f1; color: white; border: none; border-radius: 5px; cursor: pointer; margin-bottom: 20px;";
        printBtn.onclick = () => {
            printWindow.print();
        };

        // Ensure body is available
        if (printWindow.document.body) {
            printWindow.document.body.prepend(printBtn);
        } else {
            printWindow.onload = () => {
                printWindow.document.body.prepend(printBtn);
            }
        }
    }
}

export const knowledgeManager = new KnowledgeManager();
export function setupKnowledgeUI() { /* Singleton is auto-init on import for element refs */ }
export function loadKnowledgeBase() { knowledgeManager.loadSubjectSummary(); }
