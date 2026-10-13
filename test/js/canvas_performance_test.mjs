import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installCanvasColorCache } from '../../js/prompt_shared/canvas_performance.js';

function fixture() {
  const palette = { IMAGE: '#fff', MASK: '#000' };
  const renderer = {
    calls: 0,
    convertColorMap(value) {
      this.calls++;
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)]));
    },
  };
  const canvas = {
    linkRenderer: renderer,
    draw(count = 270) {
      return Array.from({ length: count }, () => this.linkRenderer.convertColorMap(palette));
    },
  };
  return { canvas, renderer, palette };
}

test('a real multi-link paint converts each palette once and preserves colors', () => {
  const { canvas, renderer } = fixture();
  const expected = canvas.draw();
  renderer.calls = 0;
  installCanvasColorCache(canvas);
  assert.deepEqual(canvas.draw(), expected);
  assert.equal(renderer.calls, 1);
});

test('in-place palette edits are visible on the next paint', () => {
  const { canvas, renderer, palette } = fixture();
  installCanvasColorCache(canvas);
  canvas.draw();
  palette.IMAGE = '#123456';
  assert.equal(canvas.draw()[0].IMAGE, '#123456');
  assert.equal(renderer.calls, 2);
});

test('different palettes in the same paint remain independent', () => {
  const { canvas, renderer, palette } = fixture();
  const second = { IMAGE: '#abcdef' };
  canvas.draw = function () {
    return [palette, second, palette, second].map(p => this.linkRenderer.convertColorMap(p));
  };
  installCanvasColorCache(canvas);
  assert.deepEqual(canvas.draw().map(p => p.IMAGE), ['#fff', '#abcdef', '#fff', '#abcdef']);
  assert.equal(renderer.calls, 2);
});

test('replacing the renderer on a workflow switch is supported', () => {
  const { canvas } = fixture();
  installCanvasColorCache(canvas);
  canvas.draw();
  const other = fixture();
  canvas.linkRenderer = other.renderer;
  assert.deepEqual(canvas.draw(), other.canvas.draw());
  assert.equal(other.renderer.calls, 271);
});

test('exceptions restore the adapter and do not poison later paints', () => {
  const { canvas, renderer } = fixture();
  const convert = renderer.convertColorMap;
  const paint = canvas.draw;
  canvas.draw = function (count) {
    const result = paint.call(this, count);
    if (!count) throw new Error('paint failed');
    return result;
  };
  installCanvasColorCache(canvas);
  assert.throws(() => canvas.draw(0), /paint failed/);
  assert.equal(renderer.convertColorMap, convert);
  assert.equal(canvas.draw(1).length, 1);
});

test('installation is idempotent and missing adapters use the original paint', () => {
  const canvas = { draw(value) { return value; } };
  installCanvasColorCache(canvas);
  const draw = canvas.draw;
  installCanvasColorCache(canvas);
  assert.equal(canvas.draw, draw);
  assert.equal(canvas.draw('unchanged'), 'unchanged');
});

test('calls outside a paint retain the original converter behavior', () => {
  const { canvas, renderer, palette } = fixture();
  const original = renderer.convertColorMap;
  installCanvasColorCache(canvas);
  canvas.draw();
  assert.equal(renderer.convertColorMap, original);
  assert.notEqual(renderer.convertColorMap(palette), renderer.convertColorMap(palette));
  assert.equal(renderer.calls, 3);
});
