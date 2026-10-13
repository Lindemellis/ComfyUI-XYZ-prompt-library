const installed = new WeakSet();

// Frontend 1.53.6 converts the same slot-color table for every rendered link.
// Share that conversion only within one synchronous paint, so the next paint
// still picks up in-place palette edits and workflow/renderer replacement.
export function installCanvasColorCache(canvas) {
  if (!canvas || installed.has(canvas)) return;
  const draw = canvas.draw;
  if (typeof draw !== 'function') return;
  installed.add(canvas);
  canvas.draw = function (...args) {
    const renderer = this.linkRenderer;
    const convert = renderer?.convertColorMap;
    // This adapter is internal to ComfyUI; older/newer frontends can omit it.
    if (typeof convert !== 'function') return draw.apply(this, args);
    const colors = new WeakMap();
    renderer.convertColorMap = function (palette) {
      if (!colors.has(palette)) colors.set(palette, convert.call(this, palette));
      return colors.get(palette);
    };
    try {
      return draw.apply(this, args);
    } finally {
      renderer.convertColorMap = convert;
    }
  };
}
