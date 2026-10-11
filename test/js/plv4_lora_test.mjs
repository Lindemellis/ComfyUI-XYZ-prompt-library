import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

class Element {
  constructor(tag, className = '', text = '') { Object.assign(this, { tagName: tag, className, textContent: text, children: [], dataset: {}, style: {} }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this[key] = value; }
  querySelectorAll(selector) {
    const result = [];
    const walk = item => { for (const child of item.children) { if (selector === '[data-lora-send]' && child.dataset.loraSend || selector === 'button' && child.tagName === 'button') result.push(child); walk(child); } };
    walk(this); return result;
  }
}
const dependencies = `
const element=(...args)=>new globalThis.Element(...args);
const button=(text,title,action,cls)=>{const item=element('button',cls,text);item.title=title;item.onclick=()=>action({currentTarget:item});return item;};
`;
globalThis.Element = Element;
const source = (await readFile(new URL('../../js/plv4/lora_browser.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const { LoraBrowserWindow, loraNodes } = await import('data:text/javascript;base64,' + Buffer.from(dependencies + source).toString('base64'));

function fixture(request = async () => ({ id: 'lora', name: 'demo', relative: 'demo.safetensors', pool_id: 'pool' })) {
  const node = { id: 1, title: 'Positive', comfyClass: 'XYZ Prompt Library V4' };
  const other = { id: 2, title: 'Negative', comfyClass: 'XYZ Prompt Library V4 Monaco' };
  const app = { graph: { _nodes: [node, other, { comfyClass: 'XYZ Prompt Library V3' }] } }; node.graph = other.graph = app.graph;
  const sent = [];
  const editor = { graphEpoch: 4, async sendLora(...args) { sent.push(args); } };
  const browser = new LoraBrowserWindow(app, editor, request);
  Object.assign(browser, { target: node, visible: true, win: { el: new Element('div') }, grid: new Element('main'), pagination: new Element('div'), targets: new Element('select'), status: {} });
  return { browser, app, node, other, editor, sent };
}

test('cards send without opening detail and preserve the chosen target object', async () => {
  const { browser, node, sent } = fixture();
  browser.openDetail = () => { throw new Error('must not open detail'); };
  browser.data = { total: 1, items: [{ id: 'lora', name: 'demo', relative: 'demo.safetensors', images: [] }] };
  browser.renderCards();
  const control = browser.grid.querySelectorAll('[data-lora-send]')[0];
  await control.onclick();
  assert.equal(sent.length, 1); assert.equal(sent[0][0], node); assert.equal(sent[0][3], 4);
  assert.equal(control.textContent, 'Send'); assert.equal(control.dataset.sending, 'false');
});

test('pending metadata request cannot redirect Send when the dropdown changes', async () => {
  let resolve;
  const { browser, node, other, sent } = fixture(() => new Promise(done => { resolve = done; }));
  const task = browser.send('lora'); await Promise.resolve(); browser.target = other;
  resolve({ id: 'lora', name: 'demo', pool_id: 'pool' }); await task;
  assert.equal(sent[0][0], node);
});

test('same-card double click is coalesced and request failures restore the control', async () => {
  let resolve, reads = 0;
  const { browser, sent } = fixture(() => { reads++; return new Promise(done => { resolve = done; }); });
  const control = browser.sendButton({ id: 'lora', name: 'demo' });
  browser.win.el.append(control);
  const first = browser.send('lora', control); const second = browser.send('lora', control);
  await Promise.resolve(); resolve({ id: 'lora', name: 'demo' }); await Promise.all([first, second]);
  assert.equal(reads, 1); assert.equal(sent.length, 1);
  browser.request = async () => { throw new Error('offline'); };
  await assert.rejects(browser.send('lora', control), /offline/);
  assert.equal(control.disabled, false); assert.equal(control.textContent, 'Send');
});

test('target choices contain only current V4 nodes and unavailable models disable Send', () => {
  const { browser, app, node } = fixture(); browser.refreshTargets();
  assert.equal(loraNodes(app).length, 2); assert.equal(browser.target, node);
  assert.equal(browser.sendButton({ id: 'duplicate', name: 'shadowed', shadowed: true }).disabled, true);
  app.graph._nodes = []; browser.refreshTargets();
  assert.equal(browser.target, null); assert.equal(browser.targets.disabled, true);
});

test('reopening the browser defaults to the active editor node and accepts an explicit target', async () => {
  const { browser, node, other, editor } = fixture();
  editor.context = { node: other }; browser.build = () => {}; browser.layout = () => {}; browser.win.show = () => {}; browser.reload = async () => {};
  await browser.open(); assert.equal(browser.target, other);
  await browser.open(node); assert.equal(browser.target, node);
});

const windowSource = (await readFile(new URL('../../js/plv4/window.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const { PLv4Window } = await import('data:text/javascript;base64,' + Buffer.from(windowSource).toString('base64'));

test('host refuses a stale workflow epoch even when the graph and node objects survived restoration', async () => {
  const { node, app } = fixture();
  const host = Object.create(PLv4Window.prototype); Object.assign(host, { app, graphEpoch: 2, flushEditor: async () => { throw new Error('must reject before edit'); } });
  await assert.rejects(host.sendLora(node, {}, app.graph, 1), /workflow/);
});

test('host flushes before appending and rejects removal during asynchronous session opening', async () => {
  const { node, app } = fixture(); const events = [];
  const session = { revision: 0, whenIdle: async () => {}, state: { selection: { block_id: 'inserted' } }, dispatch: async command => { events.push(command); } };
  const host = Object.create(PLv4Window.prototype);
  Object.assign(host, { app, flushEditor: async () => { events.push('flush'); }, sessions: { get: async () => ({ node, session }) } });
  assert.equal(await host.sendLora(node, { id: 'lora', name: 'demo', relative: 'demo.safetensors', pool_id: 'pool' }), 'inserted');
  assert.equal(events[0], 'flush'); assert.equal(events[1].type, 'InsertLora'); assert.equal(events[1].pool_id, 'pool');
  host.sessions.get = async () => { app.graph._nodes = []; return { node, session }; };
  await assert.rejects(host.sendLora(node, {}), /workflow/); assert.equal(events.length, 3);
});
