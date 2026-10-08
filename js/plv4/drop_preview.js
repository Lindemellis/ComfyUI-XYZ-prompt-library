import { element } from './ui.js';

// Fallback for card edges without a nearby structural insertion line (including
// folded cards). Internal moves and Library insertion use the same resolver.
export function blockPlacement(rect, y) {
  const edge = Math.min(12, rect.height / 4);
  return y < rect.top + edge ? 'before' : y > rect.bottom - edge ? 'after' : 'inside';
}

// Use the rendered insertion lines, rather than overlapping parent/child card
// edge bands. Moving downward through nested endings must move outward in order.
export function nearestBlockBoundary(container, x, y, distance = 12) {
  let best = null, bestDistance = Infinity;
  for (const slot of container.querySelectorAll('.boundary[data-parent]')) {
    if (slot.classList.contains('inline')) continue;
    const rect = slot.getBoundingClientRect();
    if (!rect.width || !rect.height || x < rect.left - 16 || x > rect.right + 16) continue;
    const delta = Math.abs(y - (rect.top + rect.bottom) / 2);
    if (delta <= distance && delta < bestDistance) { best = slot; bestDistance = delta; }
  }
  return best;
}

export function dropLocation(target) {
  const path = target.path || target.parent.meta?.name || (target.parent.form === 'root' ? 'Document' : 'Block');
  if (target.placement === 'inline') return `${path} · 文字之间`;
  if (target.command.edge === 'end') return `${path} · 末尾`;
  if (target.command.edge === 'start') return `${path} · 开头`;
  return `${path} · ${target.anchorName || '项目'}${target.command.before_id ? '之前' : '之后'}`;
}

export class DropPreview {
  constructor(host) {
    this.host = host;
    this.hint = element('div', 'plv4 plv4-drop drop-hint');
    this.mark = element('div', 'plv4 plv4-drop-mark');
    this.hint.hidden = this.mark.hidden = true;
    document.body.append(this.hint, this.mark);
  }
  clear() {
    this.host.blockView.clearDrop(); this.outlined?.classList.remove('drop-inside');
    this.outlined = null; this.hint.hidden = this.mark.hidden = true;
  }
  show(target, text, x, y) {
    this.clear(); if (!target) return;
    if (target.highlight) { this.outlined = target.highlight; this.outlined.classList.add('drop-inside'); }
    if (target.command && this.host.context?.session.view === 'block') {
      const slot = this.host.blockView.showDrop(target.parent.id, target.command, target.placement === 'inline');
      if (slot) slot.dataset.dropLabel = dropLocation(target);
    } else if (target.caret) {
      this.mark.hidden = false;
      Object.assign(this.mark.style, { left: `${target.caret.x}px`, top: `${target.caret.y}px`, height: `${target.caret.height}px` });
    }
    this.hint.textContent = text; this.hint.hidden = false;
    Object.assign(this.hint.style, { left: `${Math.max(8, Math.min(x + 16, innerWidth - this.hint.offsetWidth - 8))}px`, top: `${Math.max(8, Math.min(y + 18, innerHeight - this.hint.offsetHeight - 8))}px` });
  }
  // Continue scrolling while the pointer rests near an edge, even without a
  // new pointermove. Recompute the destination after each scroll step.
  autoScroll(container, move) {
    let pointer = null;
    const tick = () => {
      if (pointer && container && !container.hidden) {
        const r = container.getBoundingClientRect(), { clientX: x, clientY: y } = pointer;
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          const speed = y < r.top + 40 ? -Math.ceil((r.top + 40 - y) / 4) : y > r.bottom - 40 ? Math.ceil((y - r.bottom + 40) / 4) : 0;
          const before = container.scrollTop; container.scrollTop += speed;
          if (before !== container.scrollTop) move(pointer);
        }
      }
      this.frame = requestAnimationFrame(tick);
    };
    tick(); return event => { pointer = event; };
  }
  destroy() { cancelAnimationFrame(this.frame); this.clear(); this.hint.remove(); this.mark.remove(); }
}
