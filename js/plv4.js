import { app } from '../../../scripts/app.js';
import { PLv4Window } from './plv4/window.js';
import { NODE_TYPES, widget } from './plv4/host_sessions.js';
import { report } from './plv4/ui.js';
import { installWorkflowUndoGuard } from './plv4/history_shortcuts.js';
import { LoraBrowserWindow } from './plv4/lora_browser.js';

const editorWindow = new PLv4Window(app);
const loras = new LoraBrowserWindow(app, editorWindow);
editorWindow.openLoras = (node, id) => loras.open(node, id);
window.plv4 = { window: editorWindow, loras, connectNode: async node => {
  const context = editorWindow.sessions.contexts.get(node);
  if (context) editorWindow.sessions.attachEmbedded(context);
  else {
    let saved; try { saved = JSON.parse(widget(node, 'doc')?.value || 'null'); } catch {}
    if (saved?.root?.meta?.compiler === 'plv4' || node.comfyClass?.includes('Library V4')) await editorWindow.sessions.get(node);
  }
} };

app.registerExtension({
  name: 'XYZNodes.PromptLibraryV4',
  nodeCreated(node) {
    if (!NODE_TYPES.has(node.comfyClass)) return;
    for (const name of ['seed', 'region_mode']) {
      const value = widget(node, name); if (!value) continue;
      const callback = value.callback;
      value.callback = function() {
        const result = callback?.apply(this, arguments);
        if (editorWindow.visible && editorWindow.seedNode === node && !editorWindow.sessions.resolvingInputs) {
          editorWindow.pane?.scheduleLint();
          if (editorWindow.context?.session.view === 'preview') editorWindow.preview().catch(report);
        }
        return result;
      };
    }
    const removed = node.onRemoved;
    node.onRemoved = function() { editorWindow.remove(this); return removed?.apply(this, arguments); };
    const configured = node.onConfigure;
    node.onConfigure = function() {
      const result = configured?.apply(this, arguments);
      // A graph restore may reuse an object with completely different widgets.
      if (!editorWindow._graphRestoring && editorWindow.sessions.contexts.has(this)) {
        const active = editorWindow.context?.node === this && editorWindow.visible;
        editorWindow.run(async () => { if (active) await editorWindow.detach(); editorWindow.sessions.remove(this); if (active) await editorWindow.open(this); });
      }
      return result;
    };
    if (node.comfyClass.includes('Library V4')) {
      const added = node.onAdded;
      node.onAdded = function() { const result = added?.apply(this, arguments); window.plv4.connectNode(this).catch(report); return result; };
    }
  },
  setup() {
    installWorkflowUndoGuard(window.comfyAPI?.changeTracker?.ChangeTracker);
    document.addEventListener('plv3:node-edited', event => {
      const node = app.graph?._nodes.find(n => String(n.id) === String(event.detail?.nodeId));
      if (node) editorWindow.sessions.external(node, event.detail.value).catch(report);
    });
    const queue = app.queuePrompt;
    app.queuePrompt = async function() { await editorWindow.flushEditor(); await editorWindow.sessions.flush(); return queue.apply(this, arguments); };
  },
  beforeConfigureGraph() { return editorWindow.beginGraphRestore(); },
  afterConfigureGraph() { return editorWindow.endGraphRestore(); },
});
