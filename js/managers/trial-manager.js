import { addTrial, getTrials, deleteTrial } from '../db.js';
import { showConfirm, showToast } from '../utils/ui-utils.js';

export function setupTrialUI() {
    const lisansBtn = document.getElementById('trial-lisans-btn');
    const onlisansBtn = document.getElementById('trial-onlisans-btn');
    const calcBtn = document.getElementById('calculate-btn');
    const saveBtn = document.getElementById('save-trial-btn');

    let currentType = 'Lisans (P3)';

    lisansBtn.addEventListener('click', () => {
        lisansBtn.classList.add('active');
        onlisansBtn.classList.remove('active');
        currentType = 'Lisans (P3)';
    });

    onlisansBtn.addEventListener('click', () => {
        onlisansBtn.classList.add('active');
        lisansBtn.classList.remove('active');
        currentType = 'Önlisans (P93)';
    });

    calcBtn.addEventListener('click', () => {
        const results = calculateScore(currentType === 'Lisans (P3)');
        document.getElementById('calculated-score').textContent = results.score.toFixed(2);
        saveBtn.classList.remove('hidden');

        // Store temp results for saving
        saveBtn.onclick = () => {
            addTrial({ type: currentType, ...results });
            loadTrialHistory();
            saveBtn.classList.add('hidden');
            showToast('Deneme sonucu kaydedildi');
            // Reset inputs
            document.querySelectorAll('.calc-grid input').forEach(i => i.value = 0);
            document.getElementById('calculated-score').textContent = '0.00';
        };
    });
}

function calculateScore(isLisans) {
    const getVal = (id) => parseInt(document.getElementById(id).value) || 0;

    const trD = getVal('tr-d'); const trY = getVal('tr-y');
    const matD = getVal('mat-d'); const matY = getVal('mat-y');
    const tarD = getVal('tar-d'); const tarY = getVal('tar-y');
    const cogD = getVal('cog-d'); const cogY = getVal('cog-y');
    const anaD = getVal('ana-d'); const anaY = getVal('ana-y');

    const calcNet = (d, y) => d - (y * 0.25);
    const trNet = calcNet(trD, trY);
    const matNet = calcNet(matD, matY);
    const tarNet = calcNet(tarD, tarY);
    const cogNet = calcNet(cogD, cogY);
    const anaNet = calcNet(anaD, anaY);

    const totalNet = trNet + matNet + tarNet + cogNet + anaNet;

    // Professional 2024 Calibration (Reverse-engineered from 70 net anchors)
    // Lisans (P3): 70 net -> ~82.39 | Formula: 51.8 + (Net * 0.437)
    // Önlisans (P93): 70 net -> ~83.30 | Formula: 52.5 + (Net * 0.44)

    let score;
    if (isLisans) {
        score = 51.8 + (totalNet * 0.437);
    } else {
        score = 52.5 + (totalNet * 0.44);
    }

    // Standardize bounds
    score = Math.max(0, Math.min(100, score));

    return { trD, trY, matD, matY, tarD, tarY, cogD, cogY, anaD, anaY, totalNet, score };
}

export function loadTrialHistory() {
    const list = document.getElementById('trial-history-list');
    const countHeader = document.getElementById('trial-count-header');
    const trials = getTrials();
    list.innerHTML = '';

    if (countHeader) {
        countHeader.textContent = `Toplam Deneme: ${trials.length}`;
    }

    if (trials.length === 0) {
        list.innerHTML = '<p class="empty-state">Henüz kaydedilmiş deneme yok.</p>';
        return;
    }

    const header = document.createElement('div');
    header.className = 'trial-history-item header';
    header.innerHTML = `
        <span class="cell">Türkçe</span>
        <span class="cell">Matematik</span>
        <span class="cell">Tarih</span>
        <span class="cell">Coğrafya</span>
        <span class="cell">Anayasa</span>
        <span class="cell">Net</span>
        <span class="cell">Puan</span>
        <span class="cell date">Tarih</span>
        <span></span>
    `;
    list.appendChild(header);

    trials.forEach(t => {
        const item = document.createElement('div');
        item.className = 'trial-history-item row';
        // Full date format
        const date = new Date(t.created_at).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

        const calcNet = (d, y) => {
            const net = d - (y * 0.25);
            return net % 1 === 0 ? net : net.toFixed(1);
        };

        item.innerHTML = `
            <span class="cell">${calcNet(t.trD, t.trY)}</span>
            <span class="cell">${calcNet(t.matD, t.matY)}</span>
            <span class="cell">${calcNet(t.tarD, t.tarY)}</span>
            <span class="cell">${calcNet(t.cogD, t.cogY)}</span>
            <span class="cell">${calcNet(t.anaD, t.anaY)}</span>
            <span class="cell total-net">${t.totalNet.toFixed(1)}</span>
            <span class="cell score">${t.score.toFixed(1)}</span>
            <span class="cell date" title="${t.type}">${date}</span>
            <button class="delete-trial-btn" data-id="${t.id}" title="Sil">✕</button>
        `;

        item.querySelector('.delete-trial-btn').addEventListener('click', async () => {
            if (await showConfirm('Bu deneme sonucunu silmek istiyor musun?')) {
                deleteTrial(t.id);
                loadTrialHistory();
            }
        });

        list.appendChild(item);
    });
}
