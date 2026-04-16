import { addHabit, getAllHabits, getHabitById, incrementHabitCount, resetDailyHabits, deleteHabit, moveHabitUp, moveHabitDown } from '../db.js';
import { showToast, showConfirm } from '../utils/ui-utils.js';

export function setupHabitsUI() {
    const addBtn = document.getElementById('add-habit-btn');
    const modal = document.getElementById('add-habit-modal');
    const cancelBtn = document.getElementById('cancel-add-habit');
    const saveBtn = document.getElementById('save-new-habit');
    const nameInput = document.getElementById('habit-name-input');
    const targetInput = document.getElementById('habit-target-input');

    if (addBtn) {
        addBtn.addEventListener('click', () => {
            modal.classList.add('active');
            nameInput.focus();
        });
    }

    const closeModal = () => {
        modal.classList.remove('active');
        nameInput.value = '';
        targetInput.value = '1';
    };

    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            const name = nameInput.value.trim();
            const target = parseInt(targetInput.value) || 1;
            if (name) {
                addHabit(name, target);
                loadHabits();
                closeModal();
                showToast('Alışkanlık eklendi');
            }
        });
    }

    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }

    // Her gün sayaçları sıfırla (sayfa yüklendiğinde kontrol et)
    resetDailyHabits();
}

// Sayfa her yüklendiğinde günlük sıfırlamayı kontrol et
export function checkAndResetDailyHabits() {
    resetDailyHabits();
}

export function loadHabits() {
    const list = document.getElementById('habits-list');
    const emptyState = document.getElementById('habits-empty-state');
    
    if (!list) return;

    const habits = getAllHabits();
    list.innerHTML = '';

    if (habits.length === 0) {
        if (emptyState) emptyState.classList.remove('hidden');
        return;
    }

    if (emptyState) emptyState.classList.add('hidden');

    habits.forEach(habit => {
        const item = document.createElement('div');
        item.className = `habit-item ${habit.current_count >= habit.target_count ? 'completed' : ''}`;
        item.dataset.habitId = habit.id;

        const progress = Math.min((habit.current_count / habit.target_count) * 100, 100);

        item.innerHTML = `
            <div class="habit-order-controls">
                <button class="habit-order-btn habit-order-up" data-habit-id="${habit.id}" title="Yukarı">▲</button>
                <button class="habit-order-btn habit-order-down" data-habit-id="${habit.id}" title="Aşağı">▼</button>
            </div>
            <div class="habit-info">
                <h4 class="habit-name">${habit.name}</h4>
            </div>
            <button class="habit-delete-btn" data-habit-id="${habit.id}" title="Sil">✕</button>
            <div class="habit-counter-wrapper">
                <button class="habit-counter-btn" data-habit-id="${habit.id}" 
                    ${habit.current_count >= habit.target_count ? 'disabled' : ''}>
                    <span class="counter-display">${habit.current_count} / ${habit.target_count}</span>
                    <span class="counter-icon">${habit.current_count >= habit.target_count ? '✅' : '+'}</span>
                </button>
            </div>
        `;

        // Counter button click - Ultra-fast, no debounce
        const counterBtn = item.querySelector('.habit-counter-btn');
        if (counterBtn) {
            counterBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Hemen artır, UI'ı gecikme olmadan güncelle
                incrementHabitCount(habit.id);
                // Sadece bu kartı güncelle, tüm listeyi yeniden yükleme
                const updatedHabit = getHabitById(habit.id);
                if (updatedHabit) {
                    const displayEl = item.querySelector('.counter-display');
                    const iconEl = item.querySelector('.counter-icon');
                    const btn = item.querySelector('.habit-counter-btn');
                    
                    // UI'ı hemen güncelle (optimistic update)
                    if (displayEl) displayEl.textContent = `${updatedHabit.current_count} / ${updatedHabit.target_count}`;
                    
                    if (updatedHabit.current_count >= updatedHabit.target_count) {
                        item.classList.add('completed');
                        if (btn) btn.disabled = true;
                        if (iconEl) iconEl.textContent = '✅';
                        // Completed habit - move to bottom by reloading
                        loadHabits();
                    } else {
                        item.classList.remove('completed');
                        if (btn) btn.disabled = false;
                        if (iconEl) iconEl.textContent = '+';
                    }
                }
            });
        }

        // Order controls
        const upBtn = item.querySelector('.habit-order-up');
        const downBtn = item.querySelector('.habit-order-down');
        
        if (upBtn) {
            upBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (moveHabitUp(habit.id)) {
                    loadHabits();
                }
            });
        }
        
        if (downBtn) {
            downBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (moveHabitDown(habit.id)) {
                    loadHabits();
                }
            });
        }

        // Delete button click
        const deleteBtn = item.querySelector('.habit-delete-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (await showConfirm('Bu alışkanlığı silmek istediğine emin misin?')) {
                    deleteHabit(habit.id);
                    loadHabits();
                    showToast('Alışkanlık silindi');
                }
            });
        }

        list.appendChild(item);
    });
}
