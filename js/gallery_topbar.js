import { app } from '../../../scripts/app.js';
import { makeMenuButton, makeButtonGroup } from './xyz_topbar.js';

const BUTTON_GROUP_CLASS = 'xyz-gallery-top-menu-group';
const DROPDOWN_CLASS = 'xyz-topbar-dropdown';
const GALLERY_URL = '/xyz/gallery';
const MAX_ATTACH_ATTEMPTS = 120;

// ─── Gallery icon ──────────────────────────────────────────────────────────────

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

// ─── Dropdown menu ─────────────────────────────────────────────────────────────

function createDropdownButton() {
  const btn = document.createElement('button');
  btn.className = 'comfyui-button comfyui-menu-mobile-collapse primary';
  btn.title = 'XYZ Tools';
  btn.setAttribute('aria-label', 'XYZ Tools');
  btn.innerHTML = `<i style="font-size:1.15rem;line-height:1;">☰</i>`;

  let menuEl = null;

  function closeMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; }
    document.removeEventListener('mousedown', onOutsideClick);
  }

  function onOutsideClick(e) {
    if (menuEl && !menuEl.contains(e.target) && e.target !== btn) {
      closeMenu();
    }
  }

  function buildMenu() {
    const menu = document.createElement('div');
    Object.assign(menu.style, {
      position: 'fixed',
      background: '#1e1e2e',
      border: '1px solid #45475a',
      borderRadius: '6px',
      boxShadow: '0 6px 20px rgba(0,0,0,.6)',
      padding: '4px 0',
      minWidth: '220px',
      zIndex: '100010',
      fontFamily: 'ui-sans-serif,system-ui,sans-serif',
      fontSize: '13px',
      color: '#cdd6f4',
    });

    const items = [
      { label: 'Prompt Library V2 — Text Editor',
        action: () => { try { window.plv2?.windows?.editor?.show(null); } catch {} } },
      { label: 'Prompt Library V2 — Library',
        action: () => { try { window.plv2?.windows?.library?.show(); } catch {} } },
      { separator: true },
      { label: 'Prompt Library V1 Manager',
        action: () => { try { window.xyzV1Library?.show(); } catch {} } },
      { separator: true },
      { label: 'XYZ Prompt Tools Settings',
        action: () => { try { window.xyzSettingsPage?.show(); } catch {} } },
    ];

    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.style.cssText = 'height:1px;background:#313244;margin:3px 0;';
        menu.appendChild(sep);
        continue;
      }
      const row = document.createElement('div');
      row.textContent = item.label;
      row.style.cssText = 'padding:7px 16px;cursor:pointer;white-space:nowrap;';
      row.addEventListener('mouseenter', () => { row.style.background = '#313244'; });
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
      row.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
      row.addEventListener('click', () => { item.action(); closeMenu(); });
      menu.appendChild(row);
    }

    return menu;
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menuEl) { closeMenu(); return; }
    menuEl = buildMenu();
    document.body.appendChild(menuEl);

    // Position below the button
    const r = btn.getBoundingClientRect();
    menuEl.style.top = (r.bottom + 2) + 'px';
    menuEl.style.left = r.left + 'px';
    // Keep menu within viewport
    requestAnimationFrame(() => {
      const mr = menuEl.getBoundingClientRect();
      if (mr.right > window.innerWidth) menuEl.style.left = (window.innerWidth - mr.width - 8) + 'px';
      if (mr.bottom > window.innerHeight) menuEl.style.top = (r.top - mr.height - 2) + 'px';
    });

    document.addEventListener('mousedown', onOutsideClick);
  });

  return { element: btn };
}

// ─── Attach to topbar ──────────────────────────────────────────────────────────

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

  const galleryBtn = createGalleryButton();
  const dropdownBtn = createDropdownButton();
  const buttonGroup = makeButtonGroup(galleryBtn, dropdownBtn);
  buttonGroup.element.classList.add(BUTTON_GROUP_CLASS);
  settingsGroup.element.before(buttonGroup.element);
}

app.registerExtension({
  name: 'XYZ.Gallery.Topbar',
  setup() {
    attachTopMenuButton();
  },
});
