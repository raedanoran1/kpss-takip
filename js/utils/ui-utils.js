// Custom Modal Logic
export function showConfirm(message, title = 'Onay Gerekiyor') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'custom-modal-overlay active';

        overlay.innerHTML = `
            <div class="custom-modal">
                <div class="custom-modal-header">
                    <h3>${title}</h3>
                </div>
                <div class="custom-modal-body">
                    <p>${message}</p>
                </div>
                <div class="custom-modal-footer">
                    <button class="ghost-btn cancel-btn">İptal</button>
                    <button class="primary-btn confirm-btn">Evet</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const close = (result) => {
            overlay.classList.remove('active');
            setTimeout(() => overlay.remove(), 300);
            resolve(result);
        };

        overlay.querySelector('.cancel-btn').addEventListener('click', () => close(false));
        overlay.querySelector('.confirm-btn').addEventListener('click', () => close(true));
    });
}

export function showAlert(message, title = 'Bilgi') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'custom-modal-overlay active';

        overlay.innerHTML = `
            <div class="custom-modal">
                <div class="custom-modal-header">
                    <h3>${title}</h3>
                </div>
                <div class="custom-modal-body">
                    <p>${message}</p>
                </div>
                <div class="custom-modal-footer">
                    <button class="primary-btn ok-btn">Tamam</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        overlay.querySelector('.ok-btn').addEventListener('click', () => {
            overlay.classList.remove('active');
            setTimeout(() => overlay.remove(), 300);
            resolve();
        });
    });
}

export function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : '⚠️';

    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    toast.style.maxWidth = '90vw';
    toast.style.whiteSpace = 'normal';
    toast.style.wordBreak = 'break-word';

    container.appendChild(toast);

    // Hata mesajları daha uzun süre görünsün
    const duration = type === 'error' ? 6000 : type === 'warning' ? 4500 : 3000;
    setTimeout(() => {
        toast.remove();
    }, duration);
}

export function toggleClass(elementId, className, force) {
    const el = document.getElementById(elementId);
    if (el) {
        el.classList.toggle(className, force);
    }
}
