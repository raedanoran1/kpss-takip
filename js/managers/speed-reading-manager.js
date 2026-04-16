/* Speed Reading Manager - Kanıtlanmış Hızlı Okuma Egzersizi
   Aşamalar:
   1. Schulte Tablosu (2 dk) - Periferik görüş genişletme
   2. RSVP Okuyucu (3 dk) - Kelime hızı artırma
   3. Kelime Grubu Okuma (3 dk) - Parçalar halinde okuma
   4. WPM Testi (2 dk) - Hız + anlama ölçümü
*/

const SR_STORAGE_KEY = 'speed_reading_history';
const TOTAL_DURATION = 10 * 60; // 10 dakika saniye cinsinden

const PHASES = [
    { id: 'schulte', label: '1. Schulte Tablosu', desc: 'Periferik görüşünü genişlet', badge: 'AŞAMA 1/4', duration: 2 * 60 },
    { id: 'rsvp', label: '2. Hızlı Kelime Okuma', desc: 'Kelimeleri tek tek, hızla algıla', badge: 'AŞAMA 2/4', duration: 3 * 60 },
    { id: 'chunk', label: '3. Kelime Grubu Okuma', desc: 'Kelime öbeklerini bir bakışta kavra', badge: 'AŞAMA 3/4', duration: 3 * 60 },
    { id: 'wpm', label: '4. Hız Testi', desc: 'Oku ve anlama seviyeni ölç', badge: 'AŞAMA 4/4', duration: 2 * 60 }
];

// Türkçe okuma metinleri (KPSS odaklı)
const READING_TEXTS = [
    {
        text: `Atatürk, 19 Mayıs 1919'da Samsun'a çıkarak Kurtuluş Savaşı'nı fiilen başlattı. Anadolu'da halkı örgütleyerek işgal kuvvetlerine karşı direniş ateşini tutuşturdu. Mustafa Kemal, 23 Nisan 1920'de Türkiye Büyük Millet Meclisi'ni açarak egemenliğin kayıtsız şartsız millete ait olduğunu ilan etti. Sakarya, İnönü ve Büyük Taarruz zaferleriyle Türk milletini bağımsızlığına kavuşturdu. 29 Ekim 1923'te Cumhuriyet ilan edildi ve Atatürk ilk cumhurbaşkanı seçildi.`,
        words: 73,
        question: 'Atatürk hangi tarihte Samsun\'a çıktı?',
        options: ['15 Mayıs 1919', '19 Mayıs 1919', '23 Nisan 1920', '29 Ekim 1923'],
        answer: 1
    },
    {
        text: `Türkiye Cumhuriyeti Anayasası, devletin temel hukuk belgesidir. 1982 Anayasası'na göre Türkiye demokratik, laik ve sosyal bir hukuk devletidir. Yasama yetkisi TBMM'ye, yürütme yetkisi Cumhurbaşkanı'na, yargı yetkisi ise bağımsız mahkemelere aittir. Temel hak ve özgürlükler anayasayla güvence altına alınmıştır. Anayasanın değiştirilmesi için nitelikli çoğunluk gerekmektedir.`,
        words: 62,
        question: '1982 Anayasası\'na göre Türkiye nasıl tanımlanır?',
        options: ['Federal ve laik devlet', 'Demokratik, laik ve sosyal hukuk devleti', 'Üniter ve dinî devlet', 'Monarşik ve laik devlet'],
        answer: 1
    },
    {
        text: `Osmanlı İmparatorluğu, on dört yüzyılda Anadolu, Balkanlar, Orta Doğu ve Kuzey Afrika'yı kapsayan geniş bir coğrafyaya hükmetmiştir. Fatih Sultan Mehmet 1453'te İstanbul'u fethederek Bizans İmparatorluğu'na son vermiş ve Osmanlı'yı dünya gücü haline getirmiştir. Kanunî Sultan Süleyman döneminde imparatorluk en geniş sınırlarına ulaşmış, hukuk ve kültür alanında büyük gelişmeler yaşanmıştır.`,
        words: 65,
        question: 'İstanbul\'un fethi hangi yılda gerçekleşti?',
        options: ['1299', '1389', '1453', '1521'],
        answer: 2
    },
    {
        text: `Türkiye'nin iklimi bölgeden bölgeye farklılık göstermektedir. Karadeniz kıyıları ılıman ve yağışlı, İç Anadolu karasal, Güneydoğu Anadolu yarı kurak, Ege ve Akdeniz kıyıları ise sıcak ve kuru yazlara sahip Akdeniz iklimiyle karakterizedir. Bu iklim çeşitliliği tarım ürünleri açısından büyük avantaj sağlamaktadır. Türkiye tarım ürünleri üretiminde dünyada önemli sıralarda yer almaktadır.`,
        words: 60,
        question: 'Karadeniz kıyılarının iklimi nasıldır?',
        options: ['Karasal ve kurak', 'Ilıman ve yağışlı', 'Akdeniz iklimi', 'Yarı kurak'],
        answer: 1
    },
    {
        text: `Türkçe, Türk-Altay dil ailesinin Oğuz grubuna ait bir dildir. Türkiye'de yaklaşık 75 milyon kişi tarafından ana dil olarak konuşulmaktadır. 1928 yılında Latin alfabesine geçilmesiyle okur-yazarlık hızla artmış ve modernleşme süreci hız kazanmıştır. Türk Dil Kurumu, dilin gelişimi ve korunması için çalışmalar yürütmektedir. Türkçe eklemeli bir dil yapısına sahiptir ve zengin bir söz varlığına sahiptir.`,
        words: 64,
        question: 'Türkiye hangi yılda Latin alfabesine geçti?',
        options: ['1923', '1925', '1928', '1932'],
        answer: 2
    }
];

const RSVP_TEXTS = [
    'Başarı sabır ve azmin meyvesidir. Her gün küçük adımlar atmak sizi büyük hedeflere taşır. Odaklanın ve pes etmeyin. Bugünkü çalışmanız yarının kazanımıdır.',
    'KPSS sınavında başarılı olmak için sistematik çalışma şarttır. Her konuyu planlı biçimde işleyin. Tekrar ve pratik yapmak bilgileri kalıcı kılar.',
    'Hızlı okuma gözün doğru kullanımıyla gelişir. Parmakla takip etmek göz hareketlerini hızlandırır. İç sesle okumaktan kaçının. Kelime gruplarını bir bakışta kavramaya çalışın.',
    'Türkiye Büyük Millet Meclisi 23 Nisan 1920 tarihinde Ankara\'da açıldı. Bu tarih ulusal egemenliğin simgesi olarak kutlanmaktadır. Millet adına söz söyleyecek temsilciler ilk kez toplandı.',
    'Matematik problemleri dikkat ve konsantrasyon gerektirir. Formülleri ezberlemek yerine mantığını anlamak uzun vadede daha etkilidir. Pratik yaparak hataları azaltın.'
];

const CHUNK_TEXTS = [
    [
        ['Başarı için'], ['önce plan yap,'], ['sonra çalış.'],
        ['Her gün biraz'], ['daha iyi olmak'], ['seni zirveye taşır.'],
        ['Sabır ve azim'], ['en büyük silahlarındır.'], ['Pes etme, devam et.'],
        ['Küçük adımlar'], ['büyük hedeflere'], ['götürür seni.']
    ],
    [
        ['KPSS sınavı'], ['için her gün'], ['düzenli çalış.'],
        ['Tekrar yapmak'], ['bilgileri pekiştirir'], ['ve kalıcı kılar.'],
        ['Sorular üzerinde'], ['pratik yap ve'], ['hataları analiz et.'],
        ['Başarı sistematik'], ['çalışmayla gelir'], ['bugün başla.']
    ],
    [
        ['Hızlı okuma'], ['gözü ve zihni'], ['birlikte eğitir.'],
        ['Kelime grupları'], ['tek bakışta'], ['algılanabilir.'],
        ['İç sesi susturmak'], ['okuma hızını'], ['üç katına çıkarır.'],
        ['Her gün pratik'], ['yaparak gözün'], ['hızını artır.']
    ]
];

let srState = {
    phase: -1,
    phaseTimer: 0,
    totalElapsed: 0,
    timerInterval: null,
    phaseTimerInterval: null,
    isRunning: false,
    rsvpWords: [],
    rsvpIndex: 0,
    rsvpInterval: null,
    rsvpWpm: 250,
    schulteTarget: 1,
    schulteSize: 4,
    schulteGrid: [],
    schulteFound: 0,
    schulteTotal: 0,
    chunkIndex: 0,
    chunkData: [],
    wpmPassage: null,
    wpmAnswered: false,
    wpmStartTime: 0,
    wpmWpm: 0,
    sessionWpm: 0,
    schulteAvgTime: 0,
    schulteRounds: 0,
    schulteRoundStart: 0
};

let srHistory = [];

async function loadHistory() {
    const data = await chrome.storage.local.get(SR_STORAGE_KEY);
    srHistory = data[SR_STORAGE_KEY] || [];
}

async function saveSession(wpm) {
    await loadHistory();
    const entry = {
        date: new Date().toLocaleDateString('tr-TR'),
        wpm,
        timestamp: Date.now()
    };
    srHistory.unshift(entry);
    if (srHistory.length > 30) srHistory = srHistory.slice(0, 30);
    await chrome.storage.local.set({ [SR_STORAGE_KEY]: srHistory });
}

function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

export async function setupSpeedReadingUI() {
    await loadHistory();
    renderStartScreen();
}

function getContainer() {
    return document.getElementById('speed-reading-exercise-area');
}

function renderStartScreen() {
    const container = getContainer();
    if (!container) return;

    const todayDone = srHistory.length > 0 && srHistory[0].date === new Date().toLocaleDateString('tr-TR');

    container.innerHTML = `
        <div class="sr-start-screen">
            <div class="sr-start-icon">⚡</div>
            <div class="sr-start-title">Hızlı Okuma Egzersizi</div>
            <div class="sr-start-subtitle">
                Kanıtlanmış bilimsel yöntemlerle okuma hızını ve anlama kapasiteni geliştir.
                ${todayDone ? '<br><strong style="color:#22c55e">✅ Bugünkü egzersizini yaptın!</strong>' : ''}
            </div>
            <ul class="sr-program-list">
                <li><span class="sr-step-num">1</span> Schulte Tablosu – Periferik Görüş <span class="sr-step-dur">2 dk</span></li>
                <li><span class="sr-step-num">2</span> RSVP – Hızlı Kelime Okuma <span class="sr-step-dur">3 dk</span></li>
                <li><span class="sr-step-num">3</span> Kelime Grubu Okuma <span class="sr-step-dur">3 dk</span></li>
                <li><span class="sr-step-num">4</span> Hız & Anlama Testi <span class="sr-step-dur">2 dk</span></li>
            </ul>
            <button class="sr-start-btn" id="sr-start-btn">
                ${todayDone ? '🔄 Tekrar Başlat' : '▶ Egzersizi Başlat'}
            </button>
            ${srHistory.length > 0 ? renderHistoryHtml() : ''}
        </div>
    `;

    document.getElementById('sr-start-btn').addEventListener('click', startSession);
}

function renderHistoryHtml() {
    if (srHistory.length === 0) return '';
    const items = srHistory.slice(0, 5).map(h =>
        `<li class="sr-history-item"><span>${h.date}</span><span class="sr-hist-wpm">${h.wpm} KDK</span></li>`
    ).join('');
    return `
        <div class="sr-history-section">
            <div class="sr-history-title">Son Sonuçlar (Kelime/Dakika)</div>
            <ul class="sr-history-list">${items}</ul>
        </div>
    `;
}

function startSession() {
    srState = {
        ...srState,
        phase: 0,
        totalElapsed: 0,
        isRunning: true,
        sessionWpm: 0,
        schulteAvgTime: 0,
        schulteRounds: 0
    };
    clearAllIntervals();
    startPhase(0);
}

function clearAllIntervals() {
    if (srState.timerInterval) clearInterval(srState.timerInterval);
    if (srState.phaseTimerInterval) clearInterval(srState.phaseTimerInterval);
    if (srState.rsvpInterval) clearInterval(srState.rsvpInterval);
    srState.timerInterval = null;
    srState.phaseTimerInterval = null;
    srState.rsvpInterval = null;
}

function startPhase(phaseIdx) {
    clearAllIntervals();
    srState.phase = phaseIdx;
    srState.phaseTimer = PHASES[phaseIdx].duration;

    const phase = PHASES[phaseIdx];
    if (phase.id === 'schulte') renderSchultePhase();
    else if (phase.id === 'rsvp') renderRSVPPhase();
    else if (phase.id === 'chunk') renderChunkPhase();
    else if (phase.id === 'wpm') renderWPMPhase();

    srState.phaseTimerInterval = setInterval(() => {
        srState.phaseTimer--;
        srState.totalElapsed++;
        updatePhaseTimer();
        updateSessionProgress();
        if (srState.phaseTimer <= 0) {
            clearInterval(srState.phaseTimerInterval);
            if (phase.id === 'rsvp') stopRSVP();
            advancePhase();
        }
    }, 1000);
}

function advancePhase() {
    const next = srState.phase + 1;
    if (next >= PHASES.length) {
        finishSession();
    } else {
        startPhase(next);
    }
}

function updatePhaseTimer() {
    const el = document.getElementById('sr-phase-countdown');
    if (el) {
        const m = Math.floor(srState.phaseTimer / 60);
        const s = srState.phaseTimer % 60;
        el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }
}

function updateSessionProgress() {
    const el = document.getElementById('sr-session-progress-fill');
    if (el) {
        const pct = Math.min(100, (srState.totalElapsed / TOTAL_DURATION) * 100);
        el.style.width = pct + '%';
    }
}

function phaseHeaderHtml(phaseIdx) {
    const p = PHASES[phaseIdx];
    const m = Math.floor(p.duration / 60);
    const s = p.duration % 60;
    return `
        <div class="sr-session-progress"><div class="sr-session-progress-fill" id="sr-session-progress-fill" style="width:${(srState.totalElapsed/TOTAL_DURATION)*100}%"></div></div>
        <div class="sr-phase-header">
            <div class="sr-phase-badge">${p.badge}</div>
            <div class="sr-phase-title">${p.label}</div>
            <div class="sr-phase-desc">${p.desc}</div>
        </div>
        <div class="sr-phase-timer" id="sr-phase-countdown">${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}</div>
    `;
}

// ===== AŞAMA 1: SCHULTE TABLOSU =====
function renderSchultePhase() {
    const container = getContainer();
    if (!container) return;

    srState.schulteSize = 4;
    srState.schulteTarget = 1;
    srState.schulteFound = 0;
    srState.schulteTotal = srState.schulteSize * srState.schulteSize;
    srState.schulteGrid = generateSchulteGrid(srState.schulteSize);
    srState.schulteRoundStart = Date.now();

    container.innerHTML = `
        <div class="sr-exercise-area">
            ${phaseHeaderHtml(0)}
            <div class="schulte-info">
                <span id="schulte-round-label">Tur: 1</span>
                <span id="schulte-score">Bulunan: 0/${srState.schulteTotal}</span>
            </div>
            <div class="schulte-target" id="schulte-target-num">${srState.schulteTarget}</div>
            <div class="schulte-target-label">Bu sayıyı bul</div>
            <div class="schulte-grid sz-${srState.schulteSize}" id="schulte-grid"></div>
        </div>
    `;
    renderSchulteGrid();
}

function generateSchulteGrid(size) {
    const nums = Array.from({length: size*size}, (_, i) => i+1);
    for (let i = nums.length-1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i+1));
        [nums[i], nums[j]] = [nums[j], nums[i]];
    }
    return nums;
}

function renderSchulteGrid() {
    const gridEl = document.getElementById('schulte-grid');
    if (!gridEl) return;
    gridEl.innerHTML = '';
    srState.schulteGrid.forEach((num, idx) => {
        const cell = document.createElement('div');
        cell.className = 'schulte-cell';
        cell.dataset.num = num;
        cell.dataset.idx = idx;
        cell.textContent = num;
        cell.addEventListener('click', () => handleSchulteClick(num, cell));
        gridEl.appendChild(cell);
    });
}

function handleSchulteClick(num, cell) {
    if (num === srState.schulteTarget) {
        cell.classList.add('found');
        cell.style.pointerEvents = 'none';
        srState.schulteFound++;
        srState.schulteTarget++;

        const targetEl = document.getElementById('schulte-target-num');
        const scoreEl = document.getElementById('schulte-score');
        if (targetEl) targetEl.textContent = srState.schulteTarget <= srState.schulteTotal ? srState.schulteTarget : '✓';
        if (scoreEl) scoreEl.textContent = `Bulunan: ${srState.schulteFound}/${srState.schulteTotal}`;

        if (srState.schulteFound === srState.schulteTotal) {
            const elapsed = (Date.now() - srState.schulteRoundStart) / 1000;
            srState.schulteRounds++;
            srState.schulteAvgTime = ((srState.schulteAvgTime * (srState.schulteRounds-1)) + elapsed) / srState.schulteRounds;

            setTimeout(() => {
                srState.schulteTarget = 1;
                srState.schulteFound = 0;
                srState.schulteGrid = generateSchulteGrid(srState.schulteSize);
                srState.schulteRoundStart = Date.now();

                const roundEl = document.getElementById('schulte-round-label');
                if (roundEl) roundEl.textContent = `Tur: ${srState.schulteRounds + 1}`;
                const scoreEl2 = document.getElementById('schulte-score');
                if (scoreEl2) scoreEl2.textContent = `Bulunan: 0/${srState.schulteTotal}`;
                const targetEl2 = document.getElementById('schulte-target-num');
                if (targetEl2) targetEl2.textContent = '1';

                renderSchulteGrid();
            }, 600);
        }
    } else {
        cell.classList.add('wrong');
        setTimeout(() => cell.classList.remove('wrong'), 400);
    }
}

// ===== AŞAMA 2: RSVP =====
function renderRSVPPhase() {
    const container = getContainer();
    if (!container) return;

    const textIdx = Math.floor(Math.random() * RSVP_TEXTS.length);
    srState.rsvpWords = RSVP_TEXTS[textIdx].split(' ').filter(w => w.trim());
    srState.rsvpIndex = 0;
    srState.rsvpWpm = 250;

    container.innerHTML = `
        <div class="sr-exercise-area">
            ${phaseHeaderHtml(1)}
            <div class="rsvp-container">
                <div class="rsvp-display">
                    <div class="rsvp-focus-line"></div>
                    <div class="rsvp-word" id="rsvp-word">Hazır?</div>
                </div>
                <div class="rsvp-controls">
                    <span class="rsvp-speed-label">Hız:</span>
                    <input type="range" class="rsvp-speed-slider" id="rsvp-speed" min="100" max="600" step="25" value="${srState.rsvpWpm}">
                    <span class="rsvp-wpm-display" id="rsvp-wpm-val">${srState.rsvpWpm} KDK</span>
                </div>
                <div class="rsvp-stats">
                    <span id="rsvp-progress">0 / ${srState.rsvpWords.length} kelime</span>
                    <span id="rsvp-loops">Döngü: 1</span>
                </div>
            </div>
        </div>
    `;

    document.getElementById('rsvp-speed').addEventListener('input', (e) => {
        srState.rsvpWpm = parseInt(e.target.value);
        document.getElementById('rsvp-wpm-val').textContent = srState.rsvpWpm + ' KDK';
        restartRSVP();
    });

    startRSVP();
}

function startRSVP() {
    stopRSVP();
    const interval = Math.floor(60000 / srState.rsvpWpm);
    let loop = 1;

    srState.rsvpInterval = setInterval(() => {
        const wordEl = document.getElementById('rsvp-word');
        const progressEl = document.getElementById('rsvp-progress');
        const loopsEl = document.getElementById('rsvp-loops');
        if (!wordEl) { stopRSVP(); return; }

        const word = srState.rsvpWords[srState.rsvpIndex];
        const focusIdx = Math.floor(word.length * 0.35);
        const before = word.slice(0, focusIdx);
        const focus = word[focusIdx] || '';
        const after = word.slice(focusIdx + 1);
        wordEl.innerHTML = `${before}<span class="rsvp-focus-char">${focus}</span>${after}`;

        if (progressEl) progressEl.textContent = `${srState.rsvpIndex + 1} / ${srState.rsvpWords.length} kelime`;

        srState.rsvpIndex++;
        if (srState.rsvpIndex >= srState.rsvpWords.length) {
            srState.rsvpIndex = 0;
            loop++;
            if (loopsEl) loopsEl.textContent = `Döngü: ${loop}`;
        }
    }, interval);
}

function stopRSVP() {
    if (srState.rsvpInterval) {
        clearInterval(srState.rsvpInterval);
        srState.rsvpInterval = null;
    }
}

function restartRSVP() {
    stopRSVP();
    startRSVP();
}

// ===== AŞAMA 3: KELIME GRUBU OKUMA =====
function renderChunkPhase() {
    const container = getContainer();
    if (!container) return;

    const textIdx = Math.floor(Math.random() * CHUNK_TEXTS.length);
    srState.chunkData = CHUNK_TEXTS[textIdx];
    srState.chunkIndex = 0;

    container.innerHTML = `
        <div class="sr-exercise-area">
            ${phaseHeaderHtml(2)}
            <div class="chunk-container">
                <div class="chunk-display">
                    <div class="chunk-text" id="chunk-display-text">${srState.chunkData[0].join(' ')}</div>
                </div>
                <div class="chunk-progress-text" id="chunk-progress">1 / ${srState.chunkData.length}</div>
                <button class="chunk-btn" id="chunk-next-btn">Sonraki ›</button>
            </div>
        </div>
    `;

    document.getElementById('chunk-next-btn').addEventListener('click', nextChunk);
}

function nextChunk() {
    srState.chunkIndex++;
    if (srState.chunkIndex >= srState.chunkData.length) {
        srState.chunkIndex = 0;
    }
    const displayEl = document.getElementById('chunk-display-text');
    const progressEl = document.getElementById('chunk-progress');
    if (displayEl) displayEl.textContent = srState.chunkData[srState.chunkIndex].join(' ');
    if (progressEl) progressEl.textContent = `${srState.chunkIndex + 1} / ${srState.chunkData.length}`;
}

// ===== AŞAMA 4: WPM TESTİ =====
function renderWPMPhase() {
    const container = getContainer();
    if (!container) return;

    const passage = READING_TEXTS[Math.floor(Math.random() * READING_TEXTS.length)];
    srState.wpmPassage = passage;
    srState.wpmAnswered = false;
    srState.wpmWpm = 0;
    srState.wpmStartTime = Date.now();

    const optionsHtml = passage.options.map((opt, i) =>
        `<div class="wpm-option" data-idx="${i}">${String.fromCharCode(65+i)}) ${opt}</div>`
    ).join('');

    container.innerHTML = `
        <div class="sr-exercise-area">
            ${phaseHeaderHtml(3)}
            <div class="wpm-container">
                <div class="wpm-passage" id="wpm-passage">${passage.text}</div>
                <div class="wpm-question">
                    <p>❓ ${passage.question}</p>
                    <div class="wpm-options" id="wpm-options">${optionsHtml}</div>
                </div>
            </div>
        </div>
    `;

    document.querySelectorAll('.wpm-option').forEach(opt => {
        opt.addEventListener('click', () => handleWpmAnswer(parseInt(opt.dataset.idx)));
    });
}

function handleWpmAnswer(selectedIdx) {
    if (srState.wpmAnswered) return;
    srState.wpmAnswered = true;

    const elapsed = (Date.now() - srState.wpmStartTime) / 1000 / 60;
    srState.wpmWpm = Math.round(srState.wpmPassage.words / Math.max(elapsed, 0.05));
    srState.sessionWpm = srState.wpmWpm;

    const correct = srState.wpmPassage.answer;
    document.querySelectorAll('.wpm-option').forEach((opt, i) => {
        opt.style.pointerEvents = 'none';
        if (i === correct) opt.classList.add('correct');
        else if (i === selectedIdx) opt.classList.add('wrong');
    });
}

// ===== BİTİRME =====
async function finishSession() {
    clearAllIntervals();
    srState.isRunning = false;

    const wpm = srState.wpmWpm || 200;
    await saveSession(wpm);

    let wpmEval = '';
    if (wpm < 150) wpmEval = 'Çok iyi başlangıç! Pratik yaparak hızlanacaksın.';
    else if (wpm < 200) wpmEval = 'Ortalama okuyucu seviyesindesin.';
    else if (wpm < 300) wpmEval = 'İyi! Ortalama üzeri bir hız.';
    else if (wpm < 400) wpmEval = 'Harika! Hızlı okuyucu seviyesin.';
    else wpmEval = 'Mükemmel! Elit okuyucu seviyesindesin!';

    const container = getContainer();
    if (!container) return;

    const historyItems = srHistory.slice(0, 5).map(h =>
        `<li class="sr-history-item"><span>${h.date}</span><span class="sr-hist-wpm">${h.wpm} KDK</span></li>`
    ).join('');

    container.innerHTML = `
        <div class="sr-completion-screen">
            <div class="sr-completion-icon">🎉</div>
            <div class="sr-completion-title">Egzersiz Tamamlandı!</div>
            <div class="sr-stats-grid">
                <div class="sr-stat-card">
                    <div class="sr-stat-value">${wpm}</div>
                    <div class="sr-stat-label">Kelime/Dakika</div>
                </div>
                <div class="sr-stat-card">
                    <div class="sr-stat-value">10</div>
                    <div class="sr-stat-label">Dakika</div>
                </div>
                <div class="sr-stat-card">
                    <div class="sr-stat-value">${srState.schulteRounds || 1}</div>
                    <div class="sr-stat-label">Schulte Turu</div>
                </div>
                <div class="sr-stat-card">
                    <div class="sr-stat-value">4</div>
                    <div class="sr-stat-label">Aşama</div>
                </div>
            </div>
            <div style="font-size:0.85rem; color:var(--text-primary); font-weight:600; text-align:center;">${wpmEval}</div>
            <div class="sr-history-section" style="max-width:300px; width:100%">
                <div class="sr-history-title">Son Sonuçlar</div>
                <ul class="sr-history-list">${historyItems}</ul>
            </div>
            <button class="sr-again-btn" id="sr-again-btn">🔄 Tekrar Başlat</button>
        </div>
    `;

    document.getElementById('sr-again-btn').addEventListener('click', startSession);
}
