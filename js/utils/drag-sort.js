/**
 * setupPointerDragSort
 * iOS-safe (pointer events) drag-to-reorder for any list.
 *
 * @param {HTMLElement} listEl       - The container element
 * @param {string} itemSelector      - CSS selector for draggable items (must be direct children)
 * @param {string} handleSelector    - CSS selector for the drag handle inside each item
 * @param {function} onOrderChange   - Called with (newOrderIds []) when order changes
 */
export function setupPointerDragSort(listEl, itemSelector, handleSelector, onOrderChange) {
    listEl.addEventListener('pointerdown', (e) => {
        const handle = e.target.closest(handleSelector);
        if (!handle) return;

        const item = handle.closest(itemSelector);
        if (!item || item.parentElement !== listEl) return;

        e.preventDefault();
        e.stopPropagation();

        const rect = item.getBoundingClientRect();

        // Ghost: visual copy that follows the finger/cursor
        const ghost = item.cloneNode(true);
        ghost.style.cssText = `
            position: fixed;
            left: ${rect.left}px;
            top: ${rect.top}px;
            width: ${rect.width}px;
            height: ${rect.height}px;
            z-index: 10000;
            opacity: 0.88;
            box-shadow: 0 10px 32px rgba(0,0,0,0.45);
            pointer-events: none;
            border-radius: 8px;
            transform: scale(1.02);
            transition: box-shadow .15s;
        `;
        document.body.appendChild(ghost);

        // Placeholder: keeps the gap in the list
        const placeholder = document.createElement('div');
        placeholder.className = 'drag-sort-placeholder';
        placeholder.style.cssText = `
            height: ${rect.height}px;
            background: rgba(99,102,241,0.10);
            border: 2px dashed rgba(99,102,241,0.55);
            border-radius: 8px;
            box-sizing: border-box;
            flex-shrink: 0;
        `;
        listEl.insertBefore(placeholder, item);
        item.style.display = 'none';

        const startY = e.clientY;
        const startTop = rect.top;

        const onMove = (ev) => {
            const dy = ev.clientY - startY;
            ghost.style.top = (startTop + dy) + 'px';

            // Rearrange placeholder to show drop target
            const midY = ev.clientY;
            const candidates = [...listEl.children].filter(
                el => el !== placeholder && el !== item && el.matches(itemSelector)
            );

            let insertBefore = null;
            for (const c of candidates) {
                const cr = c.getBoundingClientRect();
                if (midY < cr.top + cr.height / 2) {
                    insertBefore = c;
                    break;
                }
            }
            if (insertBefore) {
                listEl.insertBefore(placeholder, insertBefore);
            } else {
                listEl.appendChild(placeholder);
            }
        };

        const onUp = () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);

            ghost.remove();
            item.style.display = '';
            listEl.insertBefore(item, placeholder);
            placeholder.remove();

            const newOrder = [...listEl.querySelectorAll(itemSelector)].map(el => el.dataset.id);
            onOrderChange(newOrder);
        };

        document.addEventListener('pointermove', onMove, { passive: true });
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
    }, { passive: false });
}
