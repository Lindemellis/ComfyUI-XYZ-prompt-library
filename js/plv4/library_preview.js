import { libraryRequest } from './asset_client.js';
import { element } from './ui.js';

const textOf = node => node.kind !== 'group' || node.opaque ? node.raw : (node.open || '') + (node.lead || '') + (node.children || []).map(child => textOf(child) + (child.sep || '')).join('') + (node.close || '');
let previewNumber = 0;

// A content preview includes parked tags and never samples random/shuffle settings.
export function previewTags(snapshot, active = true) {
  const enabled = active && snapshot.enabled !== false;
  if (snapshot.kind !== 'group' || snapshot.form === 'paren' || snapshot.opaque)
    return [{ text: textOf(snapshot), enabled }];
  return (snapshot.children || []).flatMap(child => previewTags(child, enabled));
}

export async function assetPreview(asset) {
  if (asset.kind === 'block') {
    const data = await libraryRequest('expand', { id: asset.id });
    return previewTags(data.snapshot);
  }
  if (asset.kind === 'folder') return [];
  const data = await libraryRequest('candidates', { pool: asset.id });
  const walk = nodes => nodes.flatMap(node => node.kind === 'class'
    ? walk(node.children) : previewTags(node.snapshot));
  return walk(data.candidates);
}

export class LibraryPreview {
  close() {
    clearTimeout(this.closeTimer);
    this.token = (this.token || 0) + 1;
    this.anchor?.setAttribute('aria-expanded', 'false'); this.anchor?.removeAttribute('aria-describedby'); this.anchor = null;
    this.popup?.remove(); this.popup = null;
  }
  keepOpen() { clearTimeout(this.closeTimer); }
  scheduleClose() { this.keepOpen(); this.closeTimer = setTimeout(() => this.close(), 150); }
  async show(anchor, asset) {
    // Pointer enter, focus and click can all fire for one icon. Keep the same
    // pending request and popup rather than continually replacing them.
    if (this.anchor === anchor && this.popup) { this.keepOpen(); return; }
    this.close(); const token = this.token;
    this.anchor = anchor; anchor.setAttribute('aria-expanded', 'true');
    const popup = this.popup = element('div', 'plv4 library-tag-preview');
    popup.id = `plv4-library-preview-${++previewNumber}`; anchor.setAttribute('aria-describedby', popup.id);
    popup.setAttribute('role', 'tooltip');
    popup.onpointerenter = () => this.keepOpen(); popup.onpointerleave = () => this.scheduleClose();
    const heading = element('div', 'preview-heading'), count = element('small', 'preview-count');
    heading.append(element('strong', '', asset.name), count);
    popup.append(heading, element('div', 'preview-tags', '正在读取…'));
    document.body.append(popup); this.position(anchor, popup);
    try {
      const tags = await assetPreview(asset);
      if (token !== this.token) return;
      if (!anchor.isConnected) { this.close(); return; }
      const list = popup.querySelector('.preview-tags'); list.replaceChildren();
      const parked = tags.filter(tag => !tag.enabled).length;
      count.textContent = `${tags.length} 条${parked ? ` · ${parked} 已关闭` : ''}`;
      if (!tags.length) list.append(element('div', 'preview-empty', '暂无 tag'));
      for (const [index, tag] of tags.entries()) {
        if (index) list.append(element('span', 'preview-separator', tags[index - 1].text.trimEnd().endsWith('.') ? ' ' : ', '));
        const item = element('span', `preview-tag${tag.enabled ? '' : ' parked'}`, tag.text);
        if (!tag.enabled) { item.title = '已关闭'; item.setAttribute('aria-label', `${tag.text}（已关闭）`); }
        list.append(item);
      }
      this.position(anchor, popup);
    } catch (error) {
      if (token === this.token) popup.querySelector('.preview-tags').textContent = error.message;
    }
  }
  position(anchor, popup) {
    const bounds = anchor.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(bounds.right + 8, innerWidth - popup.offsetWidth - 8))}px`;
    popup.style.top = `${Math.max(8, Math.min(bounds.top, innerHeight - popup.offsetHeight - 8))}px`;
  }
}
