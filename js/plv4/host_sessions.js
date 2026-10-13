import { DocumentSession } from './document_session.js';
import { bindPromptEditor } from './prompt_editor_binding.js';
import { report } from './ui.js';
import { libraryDocumentRequest, ensureOwner } from './asset_client.js';
import { maskRequest, MASK_EVENT } from './mask_library.js';

export { NODE_TYPES } from '../prompt_shared/node_types.js';
export const widget = (node, name) => node?.widgets?.find(w => w.name === name);
const copy = value => JSON.parse(JSON.stringify(value));

export function maskBindings(tree) {
  const bindings = [];
  const visit = (row, regional = true) => {
    if (!row) return;
    regional &&= !(row.form === 'region' && row.meta?.region_enabled === false);
    if (row.meta?.mask_library && row.settings?.region) bindings.push([row.id, row.effective, regional, row.settings.region, row.meta.mask_library]);
    row.children.forEach(child => visit(child, regional));
  };
  visit(tree); return JSON.stringify(bindings);
}

// Sessions belong to node objects, not numeric IDs reused by another graph.
export class NodeSessions {
  constructor(app) {
    this.app = app; this.contexts = new Map(); this.opening = new Map(); this.writing = new Set();
    window.addEventListener(MASK_EVENT, () => {
      for (const context of this.contexts.values()) {
        if (!JSON.stringify(context.session.state.doc).includes('mask_library')) continue;
        context.maskDirty = true;
        if (context.raw == null && context.session.valid) this.refreshMasks(context);
      }
    });
  }
  async get(node) {
    if (this.contexts.has(node)) return this.contexts.get(node);
    if (this.opening.has(node)) return this.opening.get(node);
    const promise = this.open(node);
    this.opening.set(node, promise);
    try { return await promise; } finally { this.opening.delete(node); }
  }
  async open(node) {
    const originalDoc = widget(node, 'doc')?.value || '', originalText = widget(node, 'text')?.value || '';
    let doc = null; try { doc = JSON.parse(originalDoc || 'null'); } catch {}
    const session = await DocumentSession.open({ text: originalText, doc }, { request: libraryDocumentRequest });
    if (!node.graph || !this.app.graph._nodes.includes(node)) { session.dispose(); throw new Error('节点已移除'); }
    // Graph restoration can populate widgets while the first open is in flight.
    if ((widget(node, 'doc')?.value || '') !== originalDoc || (widget(node, 'text')?.value || '') !== originalText) { session.dispose(); return this.open(node); }
    session.state.doc.root.meta ??= {};
    session.state.doc.root.meta.compiler = 'plv4';
    ensureOwner(session);
    await libraryDocumentRequest.observe(session);
    const context = { node, session, bindings: new Map(), folded: new Set(), focus: null, scroll: 0, syntaxState: null };
    context.maskBindings = maskBindings(session.projection.tree);
    context.unsubscribe = session.subscribe(({ reason }) => {
      if (context.raw === session.text) context.raw = null;
      if (!['View', 'LocateDetails'].includes(reason)) this.persist(context);
      if (session.valid) {
        const signature = maskBindings(session.projection.tree), changed = signature !== context.maskBindings;
        context.maskBindings = signature;
        if (!['View','LocateDetails','MaskResources'].includes(reason) && (changed || context.maskDirty) && context.raw == null && signature !== '[]') this.refreshMasks(context);
      }
    });
    this.contexts.set(node, context); this.attachEmbedded(context); this.persist(context);
    if (JSON.stringify(session.state.doc).includes('mask_library')) this.refreshMasks(context);
    return context;
  }
  refreshMasks(context) {
    context.maskDirty = false;
    return context.session.resolveMasks(maskRequest, () => {
      if (context.raw != null) { context.maskDirty = true; return false; }
      return true;
    }).catch(error => {
      context.maskDirty = true; context.maskError = error.message;
      window.dispatchEvent(new CustomEvent('xyz-plv4-document-changed', { detail: { node: context.node, error: error.message } }));
    });
  }
  persist(context, raw = null) {
    const { node, session } = context;
    if (!node.graph) return;
    // Save an in-flight draft synchronously: Run/save cannot execute an old tree
    // during the round trip which reconciles the newest keystroke.
    if (raw != null) context.raw = raw;
    const current = context.raw ?? session.text;
    const doc = copy(session.state.doc); doc.root.meta ??= {}; doc.root.meta.compiler = 'plv4';
    if (current !== session.text) doc.draft = current;
    this.writing.add(node);
    try {
      const dw = widget(node, 'doc'); if (dw) dw.value = JSON.stringify(doc);
      const tw = widget(node, 'text'); if (tw && tw.value !== current) { tw.value = current; tw.callback?.call(node, current); }
      node.graph.setDirtyCanvas(true, false);
    } finally { this.writing.delete(node); }
    window.dispatchEvent(new CustomEvent('xyz-plv4-document-changed', {detail:{node}}));
  }
  bind(context, pane) {
    if (context.bindings.has(pane)) return;
    pane.syncOnBlur = false;
    pane.params = () => this.inputs(context.node);
    const binding = bindPromptEditor(pane, context.session, { onError: report, onDraft: text => this.persist(context, text) });
    context.bindings.set(pane, binding);
  }
  unbind(context, pane) { context?.bindings.get(pane)?.dispose(); context?.bindings.delete(pane); }
  attachEmbedded(context) {
    const pane = context.node.__plv3Embed?.pe;
    if (pane?.model() && !context.bindings.has(pane)) this.bind(context, pane);
  }
  async external(node, text) {
    let context = this.contexts.get(node);
    if (!context) {
      let saved; try { saved = JSON.parse(widget(node, 'doc')?.value || 'null'); } catch {}
      if (saved?.root?.meta?.compiler === 'plv4') context = await this.get(node);
    }
    if (!context || this.writing.has(node)) return;
    if (text !== context.session.text && ![...context.bindings.keys()].some(p => p.text() === text)) await context.session.replaceText(text);
  }
  get resolvingInputs() { return !!this._inputPrompt; }
  async inputs(node) {
    const input = node.inputs?.find(i => i.name === 'seed');
    let seed = widget(node, 'seed')?.value;
    const modeInput = node.inputs?.find(i => i.name === 'region_mode');
    let regionMode = widget(node, 'region_mode')?.value || 'couple';
    if (input?.link != null || modeInput?.link != null) {
      // graphToPrompt propagates virtual widgets and calls their callbacks. Mark
      // the entire graph read before invoking it, and share concurrent readers,
      // so those callbacks cannot recursively start another Preview/lint read.
      this._inputPrompt ??= Promise.resolve().then(() => this.app.graphToPrompt()).finally(() => { this._inputPrompt = null; });
      const prompt = await this._inputPrompt;
      const resolved = prompt.output[String(node.id)]?.inputs;
      seed = resolved?.seed;
      regionMode = resolved?.region_mode;
      // Virtual/Primitive/global widget links are resolved by ComfyUI itself.
      // A backend-only upstream node is evaluated at execution, never guessed.
      if (Array.isArray(seed)) throw new Error('seed 由上游节点计算；运行工作流后查看实际输出。');
      if (Array.isArray(regionMode)) throw new Error('region_mode 由上游节点计算；运行工作流后查看实际输出。');
    }
    if (!Number.isSafeInteger(Number(seed))) throw new Error('节点 seed 必须是可准确表示的整数');
    if (!['couple', 'mask'].includes(regionMode)) throw new Error('region_mode 必须为 couple 或 mask');
    return { seed: Number(seed), region_mode: regionMode };
  }
  async flush() { await Promise.all([...this.contexts.values()].map(async c => { await c.session.flushDrafts(); await c.session.whenIdle(); await c.session.commitPool(); this.persist(c); })); }
  remove(node) {
    const context = this.contexts.get(node); if (!context) return;
    for (const binding of context.bindings.values()) binding.dispose();
    context.unsubscribe(); context.session.dispose(); this.contexts.delete(node);
  }
  prune() { for (const node of this.contexts.keys()) if (!this.app.graph._nodes.includes(node)) this.remove(node); }
}
