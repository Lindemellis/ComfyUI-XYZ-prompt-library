/**
 * Minimal top-bar button helpers — plain-DOM replacements for the deprecated
 * `scripts/ui/components/button.js` / `buttonGroup.js` (ComfyButton/ComfyButtonGroup).
 *
 * Reproduces the same shape the call sites rely on (`.element`, `.iconElement`,
 * group `.element`) and the same ComfyUI CSS classes, so existing buttons look
 * and behave identically without importing the legacy modules.
 */

/**
 * @param {{icon?:string, tooltip?:string, classList?:string}} opts
 *   `icon` is an MDI icon name (rendered as `<i class="mdi mdi-<icon>">`); callers
 *   that use a custom SVG simply overwrite `iconElement.className` + `.innerHTML`.
 * @returns {{element:HTMLButtonElement, iconElement:HTMLElement}}
 */
export function makeMenuButton({ icon, tooltip, classList } = {}) {
  const element = document.createElement('button');
  element.className = classList || 'comfyui-button';
  if (tooltip) {
    element.title = tooltip;
    element.setAttribute('aria-label', tooltip);
  }
  const iconElement = document.createElement('i');
  if (icon) iconElement.className = `mdi mdi-${icon}`;
  element.appendChild(iconElement);
  return { element, iconElement };
}

/**
 * @param {...{element:HTMLElement}} buttons
 * @returns {{element:HTMLDivElement}}
 */
export function makeButtonGroup(...buttons) {
  const element = document.createElement('div');
  element.className = 'comfyui-button-group';
  for (const b of buttons) if (b?.element) element.appendChild(b.element);
  return { element };
}
