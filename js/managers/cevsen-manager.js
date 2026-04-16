import { appState, persistState } from '../state/app-state.js';

let cevsenData = null;
let currentBabIndex = 0;
let audioPlayer = null;
let isPlaying = false;
let isAutoMode = false;
let playbackSpeed = 1;
let displayLanguage = 'latin'; // 'latin' or 'turkish'

const STORAGE_KEY = 'cevsen_last_bab';
const STORAGE_KEY_LANG = 'cevsen_display_lang';

export async function loadCevsenData() {
    try {
        const response = await fetch(chrome.runtime.getURL('web_resources/data/cevsen_supply.json'));
        const text = await response.text();
        
        // Önce normal JSON parse dene
        try {
            cevsenData = JSON.parse(text);
        } catch (parseError) {
            console.warn('JSON parse hatası, temizleme yapılıyor:', parseError.message);
            
            // JSON'daki geçersiz karakterleri düzelt
            let cleanedText = text;
            
            // String içindeki gerçek newline karakterlerini \n escape'ine çevir
            // Daha güvenli yaklaşım: Tırnak içindeki içeriği işle
            let result = '';
            let inString = false;
            let escapeNext = false;
            
            for (let i = 0; i < cleanedText.length; i++) {
                const char = cleanedText[i];
                
                if (escapeNext) {
                    result += char;
                    escapeNext = false;
                    continue;
                }
                
                if (char === '\\') {
                    result += char;
                    escapeNext = true;
                    continue;
                }
                
                if (char === '"') {
                    inString = !inString;
                    result += char;
                    continue;
                }
                
                if (inString) {
                    // String içindeyiz - kontrol karakterlerini escape et
                    if (char === '\n') {
                        result += '\\n';
                    } else if (char === '\r') {
                        result += '\\r';
                    } else if (char === '\t') {
                        result += '\\t';
                    } else if (char >= '\x00' && char <= '\x1F') {
                        // Diğer kontrol karakterlerini atla
                        continue;
                    } else {
                        result += char;
                    }
                } else {
                    // String dışındayız - normal karakterler
                    result += char;
                }
            }
            
            cleanedText = result;
            
            // Tek tırnak escape'lerini düzelt
            cleanedText = cleanedText.replace(/\\'/g, "'");
            
            // Tekrar parse et
            cevsenData = JSON.parse(cleanedText);
        }
        
        // ID'ye göre sırala
        cevsenData.sort((a, b) => a.id - b.id);
        
        // Son kaldığı sayfayı yükle (ID'ye göre)
        const saved = await chrome.storage.local.get(STORAGE_KEY);
        if (saved[STORAGE_KEY] !== undefined) {
            const savedId = saved[STORAGE_KEY];
            const index = cevsenData.findIndex(bab => bab.id === savedId);
            if (index !== -1) {
                currentBabIndex = index;
            }
        }
        
        // Kaydedilmiş dili yükle
        const savedLang = await chrome.storage.local.get(STORAGE_KEY_LANG);
        if (savedLang[STORAGE_KEY_LANG]) {
            displayLanguage = savedLang[STORAGE_KEY_LANG];
        }
        
        if (!cevsenData || !Array.isArray(cevsenData) || cevsenData.length === 0) {
            console.error('Cevşen verisi geçersiz veya boş');
            return null;
        }
        
        return cevsenData;
    } catch (error) {
        console.error('Cevşen verisi yüklenemedi:', error);
        console.error('Hata detayı:', error.message);
        console.error('Stack:', error.stack);
        return null;
    }
}

export function setupCevsenUI() {
    const prevBtn = document.getElementById('cevsen-prev-btn');
    const nextBtn = document.getElementById('cevsen-next-btn');
    const playBtn = document.getElementById('cevsen-play-btn');
    const speedSelect = document.getElementById('cevsen-speed-select');
    const modeBtn = document.getElementById('cevsen-mode-btn');
    const langSelect = document.getElementById('cevsen-lang-select');

    // Dil seçeneğini yükle
    chrome.storage.local.get(STORAGE_KEY_LANG).then(saved => {
        if (saved[STORAGE_KEY_LANG]) {
            displayLanguage = saved[STORAGE_KEY_LANG];
            if (langSelect) langSelect.value = displayLanguage;
        }
    });

    // İlk yükleme
    loadCevsenData().then(() => {
        if (cevsenData) {
            renderCurrentBab();
            updateUI();
        }
    });

    // Klavye kısayolları
    document.addEventListener('keydown', (e) => {
        const cevsenContent = document.getElementById('cevsen-sub-content');
        if (!cevsenContent || !cevsenContent.classList.contains('active')) return;

        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            goToPreviousBab();
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            goToNextBab();
        } else if (e.key === ' ' || e.key === 'Space') {
            e.preventDefault();
            togglePlay();
        }
    });

    if (prevBtn) {
        prevBtn.addEventListener('click', goToPreviousBab);
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', goToNextBab);
    }

    if (playBtn) {
        playBtn.addEventListener('click', togglePlay);
    }

    if (speedSelect) {
        speedSelect.addEventListener('change', (e) => {
            playbackSpeed = parseFloat(e.target.value);
            if (audioPlayer) {
                audioPlayer.playbackRate = playbackSpeed;
            }
        });
    }

    if (modeBtn) {
        modeBtn.addEventListener('click', toggleAutoMode);
    }

    if (langSelect) {
        langSelect.addEventListener('change', (e) => {
            displayLanguage = e.target.value;
            chrome.storage.local.set({ [STORAGE_KEY_LANG]: displayLanguage });
            renderCurrentBab();
        });
    }
}

// Optimized HTML escaping - uses regex instead of DOM manipulation for better performance
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function renderCurrentBab() {
    if (!cevsenData) {
        console.error('Cevşen verisi yüklenmemiş');
        return;
    }
    
    if (currentBabIndex < 0 || currentBabIndex >= cevsenData.length) {
        console.error('Cevşen verisi yok veya geçersiz index:', currentBabIndex, 'Toplam bab:', cevsenData ? cevsenData.length : 0);
        // Index'i düzelt
        if (currentBabIndex < 0) currentBabIndex = 0;
        if (currentBabIndex >= cevsenData.length && cevsenData.length > 0) {
            currentBabIndex = cevsenData.length - 1;
        }
        if (currentBabIndex < 0 || currentBabIndex >= cevsenData.length) {
            return; // Hala geçersizse çık
        }
    }

    const bab = cevsenData[currentBabIndex];
    const contentEl = document.getElementById('cevsen-content');
    if (!contentEl) {
        console.error('Cevşen content elementi bulunamadı');
        return;
    }

    let html = '';

    // Sadece seçilen dile göre metin göster (Arapça kaldırıldı)
    if (displayLanguage === 'latin' && bab.latin) {
        const latinText = bab.latin || '';
        // \n karakterlerine göre satırları ayır (JSON parse edildiğinde \n gerçek newline olur)
        const lines = latinText.split('\n').map(line => line.trim()).filter(line => line);
        
        // Numaralı satırları düzenli göster
        lines.forEach((line) => {
            // Satır numarasını kontrol et (1., 2., 3. gibi veya 10. gibi)
            const lineMatch = line.match(/^(\d+)\.\s*(.+)$/);
            if (lineMatch) {
                const num = lineMatch[1];
                const text = lineMatch[2].trim();
                html += `<div class="latin-line numbered" data-num="${num}">${num}. ${escapeHtml(text)}</div>`;
            } else {
                // Numarasız satır (başlık veya açıklama)
                html += `<div class="latin-line">${escapeHtml(line)}</div>`;
            }
        });
    } else if (displayLanguage === 'turkish' && bab.turkish) {
        const turkishText = bab.turkish || '';
        // \n karakterlerine göre satırları ayır (JSON parse edildiğinde \n gerçek newline olur)
        const lines = turkishText.split('\n').map(line => line.trim()).filter(line => line);
        
        // Numaralı satırları düzenli göster
        lines.forEach((line) => {
            // Satır numarasını kontrol et (1., 2., 3. gibi veya 10. gibi)
            const lineMatch = line.match(/^(\d+)\.\s*(.+)$/);
            if (lineMatch) {
                const num = lineMatch[1];
                const text = lineMatch[2].trim();
                html += `<div class="turkish-line numbered" data-num="${num}">${num}. ${escapeHtml(text)}</div>`;
            } else {
                // Numarasız satır (başlık veya açıklama)
                html += `<div class="turkish-line">${escapeHtml(line)}</div>`;
            }
        });
    }

    // Dua bölümü - ana metnin devamı olarak göster (ayrı section değil)
    if (displayLanguage === 'latin' && bab.latin_dua) {
        const latinDuaText = (bab.latin_dua || '').replace(/\n/g, '<br>');
        html += `<div class="latin-dua">${escapeHtml(latinDuaText)}</div>`;
    } else if (displayLanguage === 'turkish' && bab.turkish_dua) {
        const turkishDuaText = (bab.turkish_dua || '').replace(/\n/g, '<br>');
        html += `<div class="turkish-dua">${escapeHtml(turkishDuaText)}</div>`;
    }

    contentEl.innerHTML = html;
    
    // Metni otomatik olarak küçülterek alana sığdır
    adjustTextToFit(contentEl);
    
    console.log('Bab render edildi:', bab.id, 'Dil:', displayLanguage);
}

// Optimized text fitting with requestAnimationFrame for better performance
let adjustTextTimeout = null;
function adjustTextToFit(container) {
    // Debounce: Önceki timeout'u iptal et
    if (adjustTextTimeout) {
        clearTimeout(adjustTextTimeout);
    }
    
    // requestAnimationFrame ile bir sonraki frame'de çalıştır
    adjustTextTimeout = setTimeout(() => {
        requestAnimationFrame(() => {
            const maxHeight = container.clientHeight;
            if (maxHeight === 0) {
                setTimeout(() => adjustTextToFit(container), 100);
                return;
            }
            
            // Cache DOM queries
            const lines = container.querySelectorAll('.latin-line, .turkish-line');
            const duas = container.querySelectorAll('.latin-dua, .turkish-dua');
            
            // Binary search for optimal font size (daha hızlı)
            let minSize = 0.5;
            let maxSize = 0.95;
            let bestSize = maxSize;
            
            // Test fonksiyonu
            const testSize = (size) => {
                container.style.fontSize = size + 'rem';
                container.style.lineHeight = (size / 0.95 * 1.4) + '';
                container.style.padding = Math.max(0.5, size / 0.95) + 'rem';
                
                lines.forEach(line => {
                    line.style.fontSize = size + 'rem';
                    line.style.lineHeight = (size / 0.95 * 1.4) + '';
                    const isNumbered = line.classList.contains('numbered');
                    line.style.padding = (isNumbered ? 0.2 : 0.3) * (size / 0.95) + 'rem 0';
                });
                
                duas.forEach(dua => {
                    dua.style.fontSize = (size * 0.9) + 'rem';
                    dua.style.lineHeight = (size / 0.95 * 1.4) + '';
                    dua.style.padding = 0.5 * (size / 0.95) + 'rem';
                    dua.style.marginTop = 0.5 * (size / 0.95) + 'rem';
                });
                
                return container.scrollHeight <= maxHeight;
            };
            
            // Binary search (max 10 iterations instead of potentially hundreds)
            for (let i = 0; i < 10; i++) {
                const midSize = (minSize + maxSize) / 2;
                if (testSize(midSize)) {
                    bestSize = midSize;
                    minSize = midSize;
                } else {
                    maxSize = midSize;
                }
                if (maxSize - minSize < 0.01) break;
            }
            
            // Final apply
            testSize(bestSize);
        });
    }, 10);
}

function updateUI() {
    if (!cevsenData) return;

    const currentEl = document.getElementById('cevsen-current-bab');
    const totalEl = document.getElementById('cevsen-total-babs');
    const prevBtn = document.getElementById('cevsen-prev-btn');
    const nextBtn = document.getElementById('cevsen-next-btn');
    const playBtn = document.getElementById('cevsen-play-btn');
    const modeBtn = document.getElementById('cevsen-mode-btn');
    const langSelect = document.getElementById('cevsen-lang-select');

    if (currentEl && cevsenData[currentBabIndex]) {
        currentEl.textContent = cevsenData[currentBabIndex].id;
    }
    if (totalEl) {
        totalEl.textContent = cevsenData.length;
    }
    // Döngüsel navigasyon olduğu için butonlar her zaman aktif
    if (prevBtn) {
        prevBtn.disabled = false;
    }
    if (nextBtn) {
        nextBtn.disabled = false;
    }
    if (playBtn) {
        playBtn.textContent = isPlaying ? '⏸️' : '▶️';
        playBtn.classList.toggle('playing', isPlaying);
    }
    if (modeBtn) {
        modeBtn.textContent = isAutoMode ? 'Otomatik' : 'Manuel';
        modeBtn.classList.toggle('auto', isAutoMode);
    }
    if (langSelect) {
        langSelect.value = displayLanguage;
    }
}

function goToPreviousBab() {
    if (!cevsenData) return;
    
    stopAudio();
    
    // Döngüsel navigasyon: İlk babdaysa son baba git
    if (currentBabIndex <= 0) {
        currentBabIndex = cevsenData.length - 1;
    } else {
        currentBabIndex--;
    }
    
    saveCurrentBab();
    renderCurrentBab();
    updateUI();
    
    // Otomatik modda önceki babın sesini oynat
    if (isAutoMode) {
        setTimeout(() => {
            playCurrentBab();
        }, 300);
    }
}

function goToNextBab() {
    if (!cevsenData) return;
    
    stopAudio();
    
    // Döngüsel navigasyon: Son babdaysa 1. baba git
    if (currentBabIndex >= cevsenData.length - 1) {
        currentBabIndex = 0;
    } else {
        currentBabIndex++;
    }
    
    saveCurrentBab();
    renderCurrentBab();
    updateUI();
    
    // Otomatik modda sonraki babın sesini oynat
    if (isAutoMode) {
        setTimeout(() => {
            playCurrentBab();
        }, 300);
    }
}

function togglePlay() {
    if (isPlaying) {
        pauseAudio();
    } else {
        playCurrentBab();
    }
}

function playCurrentBab() {
    if (!cevsenData || currentBabIndex < 0 || currentBabIndex >= cevsenData.length) {
        console.error('Cevşen verisi yok veya geçersiz index:', currentBabIndex);
        return;
    }

    const bab = cevsenData[currentBabIndex];
    const babId = bab.id;
    
    // İlk 100 bab için ses dosyası var, 101+ için yok (normal durum)
    // 101. bab ve sonrası için ses çalmayacak, sessizce atla
    if (babId > 100) {
        console.log(`Bab ${babId} için ses dosyası yok (normal), otomatik modda sonraki baba geçiliyor`);
        isPlaying = false;
        updateUI();
        
        // Otomatik modda ses dosyası yoksa sonraki baba geç
        if (isAutoMode) {
            // Döngüsel: Son babdaysa 1. baba git
            if (currentBabIndex < cevsenData.length - 1) {
                currentBabIndex++;
            } else {
                // Son babdayız, 1. baba dön
                currentBabIndex = 0;
            }
            
            saveCurrentBab();
            renderCurrentBab();
            updateUI();
            
            // Kısa bir bekleme sonrası sonraki babın sesini oynat
            setTimeout(() => {
                playCurrentBab();
            }, 300);
        }
        return;
    }
    
    const audioPath = chrome.runtime.getURL(`web_resources/audio/bab${babId}.mp3`);
    
    console.log('Ses dosyası yükleniyor:', audioPath, 'Bab ID:', babId);

    // Eğer mevcut player varsa durdur
    stopAudio();

    // Yeni audio player oluştur
    audioPlayer = new Audio(audioPath);
    audioPlayer.playbackRate = playbackSpeed;
    isPlaying = true;

    audioPlayer.addEventListener('loadedmetadata', () => {
        console.log('Ses dosyası yüklendi, süre:', audioPlayer.duration);
        updateUI();
    });

    audioPlayer.addEventListener('canplay', () => {
        console.log('Ses dosyası oynatılmaya hazır');
    });

    audioPlayer.addEventListener('ended', () => {
        console.log('Ses dosyası bitti');
        isPlaying = false;
        updateUI();

        // Otomatik modda sonraki baba geç ve oynatmaya devam et
        if (isAutoMode) {
            // Döngüsel: Son babdaysa 1. baba git
            if (currentBabIndex < cevsenData.length - 1) {
                currentBabIndex++;
            } else {
                // Son babdayız, 1. baba dön
                currentBabIndex = 0;
            }
            
            saveCurrentBab();
            renderCurrentBab();
            updateUI();
            
            // Kısa bir bekleme sonrası sonraki babın sesini oynat
            setTimeout(() => {
                playCurrentBab();
            }, 300);
        }
    });

    audioPlayer.addEventListener('error', (e) => {
        // Hata mesajı gösterme, sadece log
        console.log(`Bab ${babId} için ses dosyası bulunamadı (normal durum olabilir)`);
        isPlaying = false;
        updateUI();
        
        // Otomatik modda ses dosyası yoksa sonraki baba geç
        if (isAutoMode) {
            // Döngüsel: Son babdaysa 1. baba git
            if (currentBabIndex < cevsenData.length - 1) {
                currentBabIndex++;
            } else {
                // Son babdayız, 1. baba dön
                currentBabIndex = 0;
            }
            
            saveCurrentBab();
            renderCurrentBab();
            updateUI();
            
            // Kısa bir bekleme sonrası sonraki babın sesini oynat
            setTimeout(() => {
                playCurrentBab();
            }, 300);
        }
    });

    audioPlayer.play().catch(error => {
        // Hata mesajı gösterme, sadece log
        console.log(`Bab ${babId} için ses oynatılamadı (normal durum olabilir)`);
        isPlaying = false;
        updateUI();
        
        // Otomatik modda ses dosyası yoksa sonraki baba geç
        if (isAutoMode) {
            // Döngüsel: Son babdaysa 1. baba git
            if (currentBabIndex < cevsenData.length - 1) {
                currentBabIndex++;
            } else {
                // Son babdayız, 1. baba dön
                currentBabIndex = 0;
            }
            
            saveCurrentBab();
            renderCurrentBab();
            updateUI();
            
            // Kısa bir bekleme sonrası sonraki babın sesini oynat
            setTimeout(() => {
                playCurrentBab();
            }, 300);
        }
    });

    updateUI();
}

function pauseAudio() {
    if (audioPlayer && isPlaying) {
        audioPlayer.pause();
        isPlaying = false;
        updateUI();
    }
}

function stopAudio() {
    if (audioPlayer) {
        audioPlayer.pause();
        audioPlayer.currentTime = 0;
        audioPlayer = null;
    }
    isPlaying = false;
    updateUI();
}

function toggleAutoMode() {
    isAutoMode = !isAutoMode;
    updateUI();

    if (isAutoMode && !isPlaying) {
        // Otomatik moda geçildi, oynatmaya başla
        playCurrentBab();
    } else if (!isAutoMode && isPlaying) {
        // Manuel moda geçildi, sadece mevcut sesi oynatmaya devam et
        // (zaten oynatılıyor, bir şey yapmaya gerek yok)
    }
}

function saveCurrentBab() {
    if (cevsenData && cevsenData[currentBabIndex]) {
        chrome.storage.local.set({ [STORAGE_KEY]: cevsenData[currentBabIndex].id });
    }
}

export function loadCevsen() {
    if (!cevsenData) {
        loadCevsenData().then(() => {
            if (cevsenData) {
                renderCurrentBab();
                updateUI();
            }
        });
    } else {
        renderCurrentBab();
        updateUI();
    }
}
