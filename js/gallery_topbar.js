import { app } from '../../../scripts/app.js';
import { makeMenuButton, makeButtonGroup } from './xyz_topbar.js';

const BUTTON_GROUP_CLASS = 'xyz-gallery-top-menu-group';
const GALLERY_URL = '/xyz/gallery';
const MAX_ATTACH_ATTEMPTS = 120;

function getGalleryIcon() {
  return `
    <svg width="20" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
      <circle cx="8.5" cy="8.5" r="1.5"/>
      <polyline points="21 15 16 10 5 21"/>
    </svg>
  `;
}

function createGalleryButton() {
  const button = makeMenuButton({
    icon: 'image-multiple',
    tooltip: 'Open XYZ Gallery',
    classList: 'comfyui-button comfyui-menu-mobile-collapse primary',
  });

  button.element.setAttribute('aria-label', 'Open XYZ Gallery');
  button.element.title = 'Open XYZ Gallery';

  if (button.iconElement) {
    // ComfyButton 用 `icon:` 参数把 iconElement 标成 `mdi mdi-<name>`，
    // MDI 字体通过 ::before 渲染一个图标；若我们再塞入自定义 SVG，
    // 同一个 <i> 里就会同时出现「字体图标 + SVG」两个图标（上下堆叠）。
    // 清掉 className 即可让只剩下我们的 SVG 生效。
    button.iconElement.className = '';
    button.iconElement.innerHTML = getGalleryIcon();
    button.iconElement.style.width = '1.2rem';
    button.iconElement.style.height = '1.2rem';
  }

  button.element.addEventListener('click', () => {
    window.open(GALLERY_URL, '_blank');
  });

  return button;
}

function attachTopMenuButton(attempt = 0) {
  if (document.querySelector(`.${BUTTON_GROUP_CLASS}`)) {
    return;
  }

  const settingsGroup = app.menu?.settingsGroup;
  if (!settingsGroup?.element?.parentElement) {
    if (attempt >= MAX_ATTACH_ATTEMPTS) {
      console.warn('[XYZ Gallery] Unable to locate ComfyUI settings button group; top-bar button skipped.');
      return;
    }
    requestAnimationFrame(() => attachTopMenuButton(attempt + 1));
    return;
  }

  const buttonGroup = makeButtonGroup(createGalleryButton());
  buttonGroup.element.classList.add(BUTTON_GROUP_CLASS);
  settingsGroup.element.before(buttonGroup.element);
}

app.registerExtension({
  name: 'XYZ.Gallery.Topbar',
  setup() {
    attachTopMenuButton();
  },
});
