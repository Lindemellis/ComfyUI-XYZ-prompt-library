import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = path => readFile(new URL(path, import.meta.url), 'utf8');
let moduleId = 0;
const load = code => import('data:text/javascript;base64,' + Buffer.from(code + `\n//# sourceURL=tagac-offline-${++moduleId}.js`).toString('base64'));
// Exercise the real TagAC listeners, settings, requests and popup with a small
// offline DOM. No browser, external requests or personal settings are touched.
class Element {
  constructor(tag = 'div') {
    this.nodeName = tag.toUpperCase(); this.childNodes = []; this.dataset = {}; this.style = {};
    this.listeners = {}; this.isConnected = true; this.offsetHeight = 100; this.offsetWidth = 300;
    this.scrollTop = this.scrollLeft = this.offsetTop = this.offsetLeft = 0;
  }
  append(...children) { for (const child of children) { child.parentNode = this; this.childNodes.push(child); } }
  appendChild(child) { this.append(child); return child; }
  removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1); }
  contains(node) { return node === this || this.childNodes.some(child => child.contains?.(node)); }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  dispatchEvent(event) {
    Object.defineProperty(event, 'currentTarget', { configurable: true, value: this });
    for (const callback of this.listeners[event.type] || []) callback(event);
    return !event.defaultPrevented;
  }
  getBoundingClientRect() { return { top: 20, left: 30, right: 330, width: 300, height: 21 }; }
  querySelectorAll() { return []; }
  set innerHTML(value) { this.childNodes = []; this.html = value; }
  matches() { return false; }
  focus() { document.activeElement = this; }
}
globalThis.document = Object.assign(new Element('document'), {
  body: new Element('body'), createElement: tag => new Element(tag),
  createDocumentFragment: () => new Element('fragment'),
});
globalThis.localStorage = { getItem: () => JSON.stringify({ enabled: true, enableRelated: true }) };
globalThis.window = { innerWidth: 1000, innerHeight: 800, getComputedStyle: () => ({ lineHeight: '21px', fontSize: '14px' }) };
globalThis.getComputedStyle = window.getComputedStyle;
window.monaco = { editor: { EditorOption: { lineHeight: 1 } } };
globalThis.KeyboardEvent = class extends Event { constructor(type, options) { super(type, options); Object.assign(this, options); } };
globalThis.FocusEvent = globalThis.MouseEvent = Event;
const tagSource = (await source('../../js/tagac.js')).replace(/^import .*;\r?\n/gm, '');
globalThis.loraHelpers = await load(await source('../../js/lora_completion.js'));
const { handler } = await load('const {loraCompletions}=globalThis.loraHelpers; const app = { registerExtension() {} }; const ComfyWidgets = {};\n' + tagSource + '\nexport { handler };');
const api = window.xyzTagAC;
const hosts = await load(await source('../../js/tagac_host.js'));
globalThis.tagacHostHelpers = hosts;
globalThis.inlineHelpers = await load(await source('../../js/plv4/text_input.js'));
globalThis.promptHelpers = await load(await source('../../js/plv4/prompt_text.js'));
const { attachInlineAutocomplete } = await load(`
const { tagacReady } = globalThis.tagacHostHelpers;
const { inlineText, inlineOffset, inlinePoint } = globalThis.inlineHelpers;
const { autocompleteText } = globalThis.promptHelpers;
const nativeCompletions = async () => null;
` + (await source('../../js/plv4/inline_input.js')).replace(/^import .*;\r?\n/gm, ''));
const { attachTagAC } = await load('const { tagacReady } = globalThis.tagacHostHelpers; const braceContextText = () => "text";\n' + (await source('../../js/plv3/tagac_monaco.js')).replace(/^import .*;\r?\n/gm, ''));
const tag = { name: 'blue_eyes', category: 0, post_count: 1000, sources: ['danbooru'], aliases: [] };
let requests = [];
globalThis.fetch = async url => {
  requests.push(url);
  return { ok: true, json: async () => url.startsWith('/xyz/tagdb/related')
    ? { related: [{ ...tag, name: 'looking_at_viewer' }] } : [tag] };
};
const settle = () => new Promise(resolve => setTimeout(resolve, 100));

async function checkEvents(field) {
  handler.ui.hide(); requests = [];
  field.dispatchEvent({ type: 'input', isTrusted: true }); await settle();
  assert.equal(handler.ui.isVisible(), true);
  assert.equal(handler.ui._candidates[0].name, 'blue_eyes');
  assert.equal(handler.ui._target, field);
  field.dispatchEvent({ type: 'click' }); await settle();
  assert.equal(handler.ui._isInfo, true);
  assert.equal(handler.ui._candidates[0]._isSelf, true);
  assert.equal(handler.ui._candidates[1].name, 'looking_at_viewer');
  assert.ok(requests.some(url => url.startsWith('/xyz/tagdb/related')));
}

test('Details inputs use the real shared autocomplete and related-tag popup', async () => {
  const field = new Element('input'); field.value = 'blue eyes'; field.selectionStart = field.selectionEnd = 9;
  await hosts.attachPromptAutocomplete(field);
  await checkEvents(field);
});

test('Block UI attaches even when TagAC finishes loading after the field is focused', async () => {
  delete window.xyzTagAC;
  const field = new Element(); field.innerText = 'blue eyes'; delete field.childNodes;
  globalThis.getSelection = () => ({ rangeCount: 0 });
  const attaching = attachInlineAutocomplete(field, { whenIdle: async () => {} });
  window.xyzTagAC = api; await attaching;
  assert.equal(field._xyzTagACHooked, true);
  await checkEvents(field);
});

test('Monaco synthetic input and mouse events reach the same TagAC popup', async () => {
  const callbacks = {};
  const model = { getValue: () => '{ blue eyes }', getOffsetAt: () => 11 };
  const editor = { getModel: () => model, getPosition: () => ({}), hasTextFocus: () => true,
    getScrolledVisiblePosition: () => ({ top: 0, left: 0, height: 21 }), getOption: () => 21 };
  for (const name of ['onDidChangeModelContent', 'onKeyDown', 'onKeyUp', 'onDidBlurEditorText', 'onMouseUp']) editor[name] = callback => { callbacks[name] = callback; };
  const host = await attachTagAC(editor, new Element());
  handler.ui.hide(); callbacks.onDidChangeModelContent(); await settle();
  assert.equal(handler.ui._target, host); assert.equal(handler.ui.isVisible(), true);
  callbacks.onMouseUp(); await settle();
  assert.equal(handler.ui._candidates[0]._isSelf, true);
  assert.equal(handler.ui._candidates[1].name, 'looking_at_viewer');
});

test('shared Autocomplete/Related settings control Details inputs without separate switches', async () => {
  const field = new Element('input'); field.value = 'blue eyes'; field.selectionStart = 9;
  await hosts.attachPromptAutocomplete(field);
  handler.ui.hide(); requests = [];
  window.xyzAcSettings.enabled = false;
  field.dispatchEvent({ type: 'input', isTrusted: true }); field.dispatchEvent({ type: 'click' }); await settle();
  assert.equal(handler.ui.isVisible(), false); assert.equal(requests.length, 0);
  window.xyzAcSettings.enabled = true; window.xyzAcSettings.enableRelated = false;
  field.dispatchEvent({ type: 'click' }); await settle();
  assert.equal(handler.ui.isVisible(), false); assert.equal(requests.length, 0);
  window.xyzAcSettings.enableRelated = true;
});

test('waiting for TagAC never attaches a removed Details field or disposed Block run', async () => {
  delete window.xyzTagAC;
  const detail = new Element('input');
  const waiting = hosts.attachPromptAutocomplete(detail); detail.isConnected = false;
  const block = new Element(), session = { whenIdle: async () => {} };
  const blockWaiting = attachInlineAutocomplete(block, session); session.disposed = true;
  window.xyzTagAC = api; await Promise.all([waiting, blockWaiting]);
  assert.equal(detail._xyzTagACHooked, undefined); assert.equal(block._xyzTagACHooked, undefined);
});

test('Library membership augments D/G information instead of replacing the tag row', async () => {
  const field = new Element('input'); field.value = 'blue eyes'; field.selectionStart = 9;
  let opened = 0;
  field._xyzPoolSuggestions = async () => [{ name: 'blue eyes', kind: 'poolTag', path: 'Characters / Alice',
    folders: [{ id: 'alice', path: 'Characters / Alice', open: () => opened++ }] }];
  await handler.ui.showTags(field, { query: 'blue eyes', rangeStart: 0 });
  const candidate = handler.ui._candidates[0];
  assert.deepEqual(candidate.sources, ['danbooru']);
  assert.equal(candidate.post_count, 1000);
  assert.equal(handler.ui._candidates.length, 1);
  const row = handler.ui._root.childNodes[0].childNodes[0];
  const link = row.childNodes.find(node => node.textContent === 'L');
  assert.ok(link, 'L sits in the same row as the D/G links');
  link.dispatchEvent(new Event('mousedown', { cancelable: true }));
  assert.equal(opened, 1);
});

test('Library-only prompt uses the alias slot for its Folder path and has no site preview', async () => {
  const field = new Element('input'); field.value = 'unique'; field.selectionStart = 6;
  field._xyzPoolSuggestions = async () => [{ name: 'unique', kind: 'poolTag', path: 'Custom / Outfit',
    folders: [{ id: 'outfit', path: 'Custom / Outfit', open() {} }] }];
  window.xyzAcSettings.showTagPreview = true;
  await handler.ui.showTags(field, { query: 'unique', rangeStart: 0 });
  const fragment = handler.ui._root.childNodes[0];
  const row = fragment.childNodes[0];
  assert.ok(row.childNodes.some(node => node.textContent === 'Custom / Outfit'));
  assert.ok(row.childNodes.some(node => node.textContent === 'L'));
  assert.ok(!row.childNodes.some(node => ['D', 'G', '🖼'].includes(node.textContent)));
  window.xyzAcSettings.showTagPreview = false;
});

test('four completion switches act independently and LoRA preserves existing weights', async () => {
  const field = new Element('input'); field.value = '<lora:characters/de'; field.selectionStart = field.value.length;
  let inserted;
  field._xyzAcc = { getValue: () => field.value, getCaret: () => field.selectionStart, caretCoords: () => ({top:20,left:30,lineHeight:21}), splice: (s,e,text) => { inserted = {s,e,text}; } };
  api.attach(field);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push(url);
    if (url.includes('/loras/')) return { ok: true, json: async () => ({ ok: true, items: [{ relative: 'characters/demo.safetensors' }] }) };
    return originalFetch(url, options);
  };
  const s = window.xyzAcSettings;
  try {
    s.enabled = false; s.libraryCompletion = false; s.sourceCompletion = false;
    field.dispatchEvent({ type: 'input', isTrusted: true }); await settle();
    assert.equal(handler.ui._candidates[0].detail, 'LoRA');
    await handler.ui._insert(field, handler.ui._candidates[0]);
    assert.equal(inserted.text, '<lora:characters/demo.safetensors:1>');
    const weights = await loraHelpers.loraCompletions('<lora:de:0.8:0.7>', 8);
    assert.equal(weights[0].insertText, '<lora:characters/demo.safetensors:0.8:0.7>');
    assert.equal(weights[0].end, 17);
    const prefix = await loraHelpers.loraCompletions('<lora:de:0.8:0.7>', 3);
    assert.equal(prefix[0].insertText, weights[0].insertText);
    assert.equal(prefix[0].end, 17);
    requests = []; s.loraCompletion = false;
    field.value = '<lora:uncached'; field.selectionStart = field.value.length;
    field.dispatchEvent({ type: 'input', isTrusted: true }); await settle();
    assert.equal(handler.ui.isVisible(), false); assert.equal(requests.length, 0);
    field.value = 'blue eyes'; field.selectionStart = 9;
    field._xyzSourceSuggestions = async () => null;
    field._xyzPoolSuggestions = async () => [{name:'unique',kind:'poolTag',path:'Folder'}];
    s.libraryCompletion = true;
    field.dispatchEvent({ type: 'input', isTrusted: true }); await settle();
    assert.equal(handler.ui._candidates[0].name, 'unique');
    s.libraryCompletion = false; s.enabled = true;
    field.dispatchEvent({ type: 'input', isTrusted: true }); await settle();
    assert.equal(handler.ui._candidates[0].name, 'blue_eyes');
    s.enabled = false; s.sourceCompletion = true;
    field._xyzSourceSuggestions = async () => [{name:'@schedule',kind:'syntax',start:0}];
    field.dispatchEvent({ type: 'input', isTrusted: true }); await settle();
    assert.equal(handler.ui._candidates[0].name, '@schedule');
    s.sourceCompletion = false;
    field.dispatchEvent({ type: 'input', isTrusted: true }); await settle();
    assert.equal(handler.ui.isVisible(), false);
    assert.equal(await loraHelpers.loraCompletions('"<lora:de', 9), null);
    assert.equal(await loraHelpers.loraCompletions('\\<lora:de', 9), null);
  } finally {
    Object.assign(s,{enabled:true,libraryCompletion:true,sourceCompletion:true,loraCompletion:true});
    globalThis.fetch=originalFetch; handler.ui.hide();
  }
});

test('a popup from the previous input cannot consume Enter after focus moves to another Block run', async () => {
  const previous = new Element('input'), current = new Element('input');
  previous.value = current.value = 'blue eyes'; previous.selectionStart = current.selectionStart = 9;
  api.attach(previous); api.attach(current);
  let inserted = 0;
  handler.ui._open(previous, [{name: '@schedule', kind: 'syntax', insert: () => inserted++}], 0);
  const enter = Object.assign(new Event('keydown', {cancelable: true}), {key: 'Enter'});
  current.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, false);
  assert.equal(inserted, 0);
  assert.equal(handler.ui.isVisible(), false);
});

test('IME composition leaves Enter untouched and hides pending suggestions', async () => {
  const field = new Element('input'); field.value='blue eyes'; field.selectionStart=9; api.attach(field);
  field.dispatchEvent({type:'input',isTrusted:true}); await settle();
  assert.ok(handler.ui.isVisible());
  field.dispatchEvent(new Event('compositionstart'));
  assert.equal(handler.ui.isVisible(),false);
  const enter=Object.assign(new Event('keydown',{cancelable:true}),{key:'Enter'});
  field.dispatchEvent(enter); assert.equal(enter.defaultPrevented,false);
  field.dispatchEvent(new Event('compositionend')); await settle();
  assert.ok(handler.ui.isVisible()); handler.ui.hide();
});

test('an unavailable Pool completion leaves Enter available for a newline without a warning', async () => {
  const field=new Element('input');field.value='blue eyes';field.selectionStart=9;api.attach(field);
  let inserted=0;
  handler.ui._open(field,[{name:'blue eyes',kind:'poolTag',canInsert:()=>false,insert:()=>inserted++}],0);
  const enter=Object.assign(new Event('keydown',{cancelable:true}),{key:'Enter'});
  field.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented,false);
  assert.equal(inserted,0);
  assert.equal(handler.ui.isVisible(),false);
});
