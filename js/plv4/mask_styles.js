import {element} from './ui.js';
import {mountDesign} from './design_adapter.js';
export function maskStyles() {
  if (document.getElementById('xyz-mask-css')) return;
  const style = element('style'); style.id = 'xyz-mask-base'; document.head.append(style); mountDesign(style, () => {});
  const link = element('link'); link.id = 'xyz-mask-css'; link.rel = 'stylesheet'; link.href = new URL('./mask_library.css', import.meta.url).href; document.head.append(link);
}
