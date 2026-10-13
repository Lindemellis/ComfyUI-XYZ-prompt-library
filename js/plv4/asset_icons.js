import { element } from './ui.js';

export const iconPaths = {
  folder: 'M3 7V5h6l2 2h10v13H3V7Z M3 10h18',
  class: 'm12 3 9 5-9 5-9-5 9-5Z M3 12l9 5 9-5 M3 16l9 5 9-5',
  tag: 'M4 4h7l9 9-7 7-9-9V4Z M8 8h.01',
  block: 'm12 3 9 5v9l-9 5-9-5V8l9-5Z M3 8l9 5 9-5 M12 13v9',
  document: 'M5 3h10l4 4v14H5V3Z M14 3v5h5 M8 12h8 M8 16h8',
};

export function assetIcon(kind, style = 'asset-icon', size = 18) {
  const icon = element('span', style); icon.dataset.iconKind = kind;
  icon.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="${iconPaths[kind] || iconPaths.block}"/></svg>`;
  return icon;
}
