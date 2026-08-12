import { app } from '../../../scripts/app.js';

// A target picker + Apply under every code block the agent prints.
//
// The panel writes the canvas directly; this makes its text a PROPOSAL you
// accept, and lets one conversation feed different nodes — the positive prompt
// here, a negative there — without rebinding anything between messages.
//
// Deliberately NOT a patch to the panel's 29k-line bundle: this only reads its
// rendered DOM and appends to it, so a panel update degrades to "the bar stops
// appearing", never to a broken panel.

const KEY = 'xyz.agentOutput.target';
const MARK = 'xyzApplyBar';

// Widget names that hold prompt-ish text. `text` covers the PLv3 nodes (both the
// plain and the Monaco one — they differ only in their editor, not their widget).
const TEXT_WIDGET = /^(text|prompt|string|value|wildcard_text|populated_text|positive|negative)$/i;

const loadTarget = () => {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
};
const saveTarget = (t) => {
  if (t) localStorage.setItem(KEY, JSON.stringify(t));
  else localStorage.removeItem(KEY);
  app.graph?.setDirtyCanvas(true, true);
};

/**
 * Every node/widget pair that can receive text, newest-looking first is NOT the
 * order — graph order is, so the list does not reshuffle between messages.
 *
 * Multiline widgets sort ahead of single-line ones: a prompt goes into a text
 * area far more often than into a filename field, and the list is long.
 */
function candidates() {
  const out = [];
  for (const node of app.graph?._nodes ?? []) {
    for (const w of node.widgets ?? []) {
      if (typeof w.value !== 'string' && w.value != null) continue;
      if (!TEXT_WIDGET.test(w.name || '')) continue;
      out.push({
        nodeId: String(node.id),
        widget: w.name,
        multiline: !!w.inputEl || w.type === 'customtext',
        label: `#${node.id} ${node.title || node.type} · ${w.name}`,
      });
    }
  }
  out.sort((a, b) => Number(b.multiline) - Number(a.multiline));
  return out;
}

function resolve(target) {
  if (!target) return null;
  const node =
    app.graph?.getNodeById?.(target.nodeId) ??
    (app.graph?._nodes ?? []).find((n) => String(n.id) === String(target.nodeId));
  if (!node) return null;
  const widget = (node.widgets ?? []).find((w) => w.name === target.widget);
  return widget ? { node, widget } : null;
}

/** Write the text and make every view of it agree. */
function applyText(target, text) {
  const found = resolve(target);
  if (!found) return '目标节点/控件不在了';
  const { node, widget } = found;
  widget.value = text;
  // A DOM widget keeps its own element; setting `.value` alone leaves the
  // visible textarea showing the old text until something else redraws it.
  if (widget.inputEl && 'value' in widget.inputEl) widget.inputEl.value = text;
  try {
    // PLv3 wraps this callback to emit `plv3:node-edited`, which is what makes
    // the embedded Monaco and the floating editor follow the change.
    widget.callback?.(text, app.canvas, node);
  } catch (err) {
    console.warn('[xyz-agent-output] widget callback threw', err);
  }
  node.onWidgetChanged?.(widget.name, text, undefined, widget);
  app.graph.setDirtyCanvas(true, true);
  return null;
}

function styleOnce() {
  if (document.getElementById('xyz-apply-css')) return;
  const css = document.createElement('style');
  css.id = 'xyz-apply-css';
  css.textContent = `
    .xyz-apply-bar{display:flex;gap:6px;align-items:center;margin:-6px 0 10px;padding:6px 8px;
      background:#0f1115;border:1px solid #262b33;border-top:0;border-radius:0 0 6px 6px;
      font:11px/1.4 system-ui,sans-serif}
    .xyz-apply-bar select{flex:1;min-width:0;background:#171a21;color:#e8eaed;border:1px solid #333a45;
      border-radius:4px;padding:3px 4px;font-size:11px;cursor:pointer}
    .xyz-apply-bar button{background:#2f6feb;color:#fff;border:0;border-radius:4px;padding:3px 10px;
      cursor:pointer;font-weight:600;font-size:11px;white-space:nowrap}
    .xyz-apply-bar button:disabled{background:#333a45;color:#8b919a;cursor:default}
    .xyz-apply-bar .xyz-apply-msg{color:#9aa0a6;white-space:nowrap;max-width:44%;overflow:hidden;
      text-overflow:ellipsis}
  `;
  document.head.appendChild(css);
}

function buildBar(pre) {
  const bar = document.createElement('div');
  bar.className = 'xyz-apply-bar';

  const select = document.createElement('select');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Apply →';
  const msg = document.createElement('span');
  msg.className = 'xyz-apply-msg';

  // Filled on OPEN, not once: nodes get added, renamed and deleted while a
  // conversation is running, and a list built when the message arrived would
  // quietly point at a node that no longer exists.
  const fill = () => {
    const list = candidates();
    const keep = select.value;
    const remembered = loadTarget();
    select.replaceChildren(
      ...list.map((c) => {
        const o = document.createElement('option');
        o.value = `${c.nodeId}|${c.widget}`;
        o.textContent = c.label;
        return o;
      }),
    );
    if (!list.length) {
      const o = document.createElement('option');
      o.textContent = '（画布上没有文本控件）';
      o.value = '';
      select.append(o);
    }
    const want = keep || (remembered ? `${remembered.nodeId}|${remembered.widget}` : '');
    if (want && [...select.options].some((o) => o.value === want)) select.value = want;
    btn.disabled = !select.value;
  };

  select.addEventListener('mousedown', fill);
  select.addEventListener('focus', fill);
  select.addEventListener('change', () => {
    const [nodeId, widget] = select.value.split('|');
    if (nodeId) saveTarget({ nodeId, widget }); // becomes the default for later blocks
    btn.disabled = !select.value;
  });

  btn.onclick = () => {
    const [nodeId, widget] = (select.value || '').split('|');
    if (!nodeId) return;
    // The CODE element, not the <pre>: the pre also contains the panel's own
    // copy/wrap buttons, whose labels would ride along into the node.
    const text = (pre.querySelector('code')?.textContent ?? '').replace(/\s+$/, '');
    const err = applyText({ nodeId, widget }, text);
    msg.textContent = err ? `✗ ${err}` : `✓ 已写入 ${text.length} 字`;
    msg.style.color = err ? '#f38ba8' : '#a6e3a1';
    if (!err) {
      const node = resolve({ nodeId, widget })?.node;
      console.log(`[xyz-agent-output] applied ${text.length} chars → #${nodeId}.${widget}`, node?.title ?? '');
    }
    setTimeout(() => { msg.textContent = ''; }, 4000);
  };

  bar.append(select, btn, msg);
  fill();
  return bar;
}

/** Attach a bar under every code block that does not have one yet. */
function decorate() {
  styleOnce();
  for (const pre of document.querySelectorAll('pre.cmcp-codeblock')) {
    if (pre.dataset[MARK]) continue;
    // Only inside the agent's own messages — a user message can contain a fenced
    // block too, and offering to apply the text you just typed is noise.
    if (!pre.closest('.cmcp-bubble.agent')) continue;
    pre.dataset[MARK] = '1';
    pre.after(buildBar(pre));
  }
}

app.registerExtension({
  name: 'xyz.agent.output',

  async setup() {
    styleOnce();
    // The panel re-renders its log constantly (streaming deltas), so this runs
    // often; `decorate` is idempotent and keyed off a data attribute, and a
    // rebuilt block simply gets a fresh bar.
    let pending = null;
    const obs = new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; decorate(); }, 150);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    decorate();
    console.log('[xyz-agent-output] ready — every agent code block gets a target picker + Apply');
  },

  // Right-click a node to make it the DEFAULT selection for new blocks. The
  // per-block dropdown still overrides it, so this is a convenience, not a mode.
  beforeRegisterNodeDef(nodeType) {
    const orig = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      orig?.apply(this, arguments);
      const texts = (this.widgets || []).filter((w) => TEXT_WIDGET.test(w.name || ''));
      if (texts.length) {
        options.push({
          content: '📌 设为 Agent 默认输出端',
          has_submenu: true,
          submenu: {
            options: texts.map((w) => ({
              content: w.name,
              callback: () => saveTarget({ nodeId: String(this.id), widget: w.name }),
            })),
          },
        });
      }
      if (loadTarget()) {
        options.push({ content: '❌ 清除默认输出端', callback: () => saveTarget(null) });
      }
      return options;
    };
  },

  nodeCreated(node) {
    const draw = node.onDrawForeground;
    node.onDrawForeground = function (ctx) {
      draw?.apply(this, arguments);
      const t = loadTarget();
      if (!t || String(t.nodeId) !== String(this.id) || this.flags?.collapsed) return;
      ctx.save();
      ctx.fillStyle = '#2f6feb';
      ctx.font = 'bold 10px system-ui';
      ctx.fillText(`📌 AGENT OUT → ${t.widget}`, 8, -6);
      ctx.restore();
    };
  },
});
