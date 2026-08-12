import { app } from '../../../scripts/app.js';
import { api } from '../../../scripts/api.js';

// One button instead of a terminal. The comfyui-mcp sidebar panel cannot start
// its own orchestrator — that pack is published to the Comfy Registry, which
// forbids a node pack from spawning processes — so it can only print a command
// for you to run. We are not published there, so `/xyz/agent/start` runs it.
//
// The panel polls the bridge on its own and connects the moment it is up, so
// nothing here has to talk to the panel.

const POLL_MS = 2000;
let panel = null, pollTimer = null;

const get = async (url) => {
  const r = await api.fetchApi(url);
  return r.json();
};
const post = async (url, body) => {
  const r = await api.fetchApi(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
};

function row(label, value, tone) {
  const d = document.createElement('div');
  d.style.cssText = 'display:flex;gap:10px;padding:3px 0;font-size:12px;';
  const k = document.createElement('span');
  k.textContent = label;
  k.style.cssText = 'color:#9399b2;min-width:78px;';
  const v = document.createElement('span');
  v.textContent = value ?? '—';
  v.style.cssText = `color:${tone || '#cdd6f4'};word-break:break-all;`;
  d.append(k, v);
  return d;
}

function build() {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;right:18px;top:70px;z-index:1200;width:420px;background:#1e1e2e;' +
    'color:#cdd6f4;border:1px solid #313244;border-radius:10px;padding:14px 16px;' +
    'font:13px/1.5 system-ui,sans-serif;box-shadow:0 10px 34px #0009;';

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;';
  const title = document.createElement('b');
  title.textContent = 'Agent Orchestrator';
  const close = document.createElement('span');
  close.textContent = '✕';
  close.style.cssText = 'cursor:pointer;color:#9399b2;padding:0 4px;';
  close.onclick = hide;
  head.append(title, close);

  const body = document.createElement('div');

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;margin-top:12px;';
  const start = document.createElement('button');
  start.textContent = '启动';
  start.style.cssText =
    'flex:1;background:#89b4fa;color:#1e1e2e;border:0;border-radius:6px;padding:7px 0;' +
    'cursor:pointer;font-weight:600;';
  const logBtn = document.createElement('button');
  logBtn.textContent = '日志';
  logBtn.style.cssText =
    'background:transparent;color:#9399b2;border:1px solid #313244;border-radius:6px;' +
    'padding:7px 14px;cursor:pointer;';
  actions.append(start, logBtn);

  // Endpoint switcher for the custom lane. The panel's own model dropdown only
  // ever lists what the CURRENT endpoint serves, so switching provider there is
  // impossible by construction — it was a settings.json edit plus a restart.
  const provWrap = document.createElement('div');
  provWrap.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px solid #313244;';
  const provLabel = document.createElement('div');
  provLabel.textContent = 'Custom lane 端点';
  provLabel.style.cssText = 'font-size:12px;color:#9399b2;margin-bottom:6px;';
  const selCss =
    'width:100%;background:#11111b;color:#cdd6f4;border:1px solid #313244;' +
    'border-radius:6px;padding:5px 6px;font-size:12px;cursor:pointer;';
  const provPick = document.createElement('select');
  provPick.style.cssText = selCss;
  const modelPick = document.createElement('select');
  modelPick.style.cssText = selCss + 'margin-top:6px;';
  const provApply = document.createElement('button');
  provApply.textContent = '切换（会重启 orchestrator）';
  provApply.style.cssText =
    'width:100%;margin-top:6px;background:#313244;color:#cdd6f4;border:0;border-radius:6px;' +
    'padding:6px 0;cursor:pointer;font-size:12px;';
  provWrap.append(provLabel, provPick, modelPick, provApply);

  // Content note: one switch plus a picker over agent_data/unlock/*.md. Applies
  // to BOTH lanes (each re-reads one fixed file per turn, whose contents the
  // backend rewrites), so neither the switch nor the picker needs a restart.
  const unlockWrap = document.createElement('div');
  unlockWrap.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px solid #313244;';

  const unlockRow = document.createElement('label');
  unlockRow.style.cssText =
    'display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;';
  const unlockBox = document.createElement('input');
  unlockBox.type = 'checkbox';
  unlockBox.style.cssText = 'cursor:pointer;';
  const unlockText = document.createElement('span');
  unlockText.textContent = '破限提示词常驻（两条 lane 都生效）';
  unlockRow.append(unlockBox, unlockText);

  const unlockPick = document.createElement('select');
  unlockPick.style.cssText =
    'width:100%;margin-top:7px;background:#11111b;color:#cdd6f4;border:1px solid #313244;' +
    'border-radius:6px;padding:5px 6px;font-size:12px;cursor:pointer;';
  unlockWrap.append(unlockRow, unlockPick);

  // Always on, not switchable: these are correctness rules (do not edit the
  // canvas unasked; read the model's skill first), and a correctness rule
  // behind a toggle is a bug waiting for the toggle to be off.
  const rulesRow = document.createElement('div');
  rulesRow.style.cssText = 'margin-top:8px;font-size:11px;color:#9399b2;';

  const note = document.createElement('div');
  note.style.cssText = 'margin-top:10px;font-size:11px;color:#9399b2;white-space:pre-wrap;';

  const log = document.createElement('pre');
  log.style.cssText =
    'display:none;margin-top:10px;max-height:200px;overflow:auto;background:#11111b;' +
    'border:1px solid #313244;border-radius:6px;padding:8px;font-size:11px;white-space:pre-wrap;';

  start.onclick = async () => {
    start.disabled = true;
    start.textContent = '启动中…';
    note.textContent = '正在等待 bridge 应答 —— 进程存在不等于服务就绪，所以要等。';
    const { ok, data } = await post('/xyz/agent/start', { wait: true, timeout: 60 });
    start.disabled = false;
    start.textContent = '启动';
    if (!ok) {
      note.textContent = `✗ ${data.error || '启动失败'}\n看日志查原因。`;
      note.style.color = '#f38ba8';
    } else {
      note.textContent = data.launched
        ? '✓ 已启动，bridge 已应答。到侧边栏点 Agent Panel → Connect。'
        : '✓ 本来就在跑。到侧边栏点 Agent Panel → Connect。';
      note.style.color = '#a6e3a1';
    }
    refresh();
  };

  const applyUnlock = async (body, okText) => {
    const { ok, data } = await post('/xyz/agent/unlock', body);
    if (!ok) {
      note.textContent = `✗ ${data.error || '切换失败'}`;
      note.style.color = '#f38ba8';
      refresh();
      return;
    }
    note.textContent = okText(data);
    note.style.color = data.chars ? '#a6e3a1' : '#f9e2af';
    refresh();
  };

  unlockBox.onchange = () =>
    applyUnlock({ enabled: unlockBox.checked }, (d) => {
      if (!d.unlock) return '✓ 已关闭。';
      if (!d.chars) return '⚠ agent_data/unlock/ 里没有可用的 .md —— 开关已记住，但没有内容可注入。';
      return `✓ 已开启：${d.label}（${d.chars} 字），下一轮对话生效，无需重启。`;
    });

  unlockPick.onchange = () =>
    applyUnlock({ choice: unlockPick.value }, (d) =>
      d.unlock
        ? `✓ 已切换到：${d.label}（${d.chars} 字），下一轮生效。`
        : `已记住选择：${d.label}。开关还是关的。`,
    );

  // Loading the models means a round trip to the provider, so it happens when
  // the provider is CHOSEN, never on the 2 s status poll.
  const loadModels = async (pid, want) => {
    modelPick.replaceChildren(new Option('读取中…', ''));
    modelPick.disabled = true;
    const d = await get(`/xyz/agent/models?provider=${encodeURIComponent(pid)}`).catch(() => ({}));
    if (!d.ok) {
      modelPick.replaceChildren(new Option(d.error || '取不到模型列表', ''));
      return;
    }
    modelPick.replaceChildren(...d.models.map((m) => new Option(m, m)));
    modelPick.value = d.models.includes(want) ? want : (d.default_model || d.models[0]);
    modelPick.disabled = false;
  };

  provPick.onchange = () => loadModels(provPick.value, '');

  provApply.onclick = async () => {
    if (!provPick.value) return;
    provApply.disabled = true;
    provApply.textContent = '切换中…';
    const { ok, data } = await post('/xyz/agent/provider', {
      provider: provPick.value,
      model: modelPick.value || undefined,
    });
    provApply.disabled = false;
    provApply.textContent = '切换（会重启 orchestrator）';
    note.textContent = ok
      ? `✓ 已切到 ${data.label} · ${data.model}。在侧边栏 Disconnect → Connect 一下。`
      : `✗ ${data.error || '切换失败'}`;
    note.style.color = ok ? '#a6e3a1' : '#f38ba8';
    refresh();
  };

  logBtn.onclick = async () => {
    if (log.style.display === 'block') { log.style.display = 'none'; return; }
    const d = await get('/xyz/agent/log').catch(() => ({}));
    log.textContent = d.log ? d.log.slice(-4000) : (d.error || '(还没有日志)');
    log.style.display = 'block';
    log.scrollTop = log.scrollHeight;
  };

  el.append(head, body, provWrap, unlockWrap, rulesRow, actions, note, log);
  document.body.appendChild(el);
  return { el, body, note, start, unlockBox, unlockText, unlockPick, rulesRow,
           provPick, modelPick, loadModels };
}

async function refresh() {
  if (!panel) return;
  let s;
  try { s = await get('/xyz/agent/status'); } catch { return; }
  panel.body.replaceChildren(
    row('状态', s.running ? '● 运行中' : '○ 未运行', s.running ? '#a6e3a1' : '#f9e2af'),
    row('bridge', s.bridge),
    row('入口', s.entry || '未找到 —— 设 XYZ_AGENT_ENTRY 或 POST /xyz/agent/entry', s.entry ? '#cdd6f4' : '#f38ba8'),
    row('node', s.node || '不在 PATH 上', s.node ? '#cdd6f4' : '#f38ba8'),
    row('模型', s.model || '(用环境变量里的)'),
  );
  panel.start.style.display = s.running ? 'none' : '';
  panel.unlockBox.checked = !!s.unlock;
  panel.unlockText.style.color = s.unlock_present ? '#cdd6f4' : '#6c7086';

  // Rebuild the picker only when the file list actually changed — a 2 s poll
  // that re-created the <option>s would close the dropdown under the pointer
  // every time the user tried to use it.
  const opts = s.unlock_options || [];
  const sig = opts.map((o) => `${o.name}:${o.chars}`).join('|');
  if (panel.unlockSig !== sig) {
    panel.unlockSig = sig;
    panel.unlockPick.replaceChildren(
      ...opts.map((o) => {
        const el = document.createElement('option');
        el.value = o.name;
        el.textContent = `${o.label} · ${o.chars} 字`;
        return el;
      }),
    );
    if (!opts.length) {
      const el = document.createElement('option');
      el.textContent = '（agent_data/unlock/ 里没有 .md）';
      panel.unlockPick.append(el);
    }
  }
  panel.unlockPick.disabled = !opts.length;
  if (s.unlock_choice) panel.unlockPick.value = s.unlock_choice;
  panel.unlockPick.title = s.unlock_dir || '';

  if (!panel.provLoaded) {
    panel.provLoaded = true;
    const p = await get('/xyz/agent/providers').catch(() => null);
    if (p) {
      panel.provPick.replaceChildren(
        ...p.providers.map((x) => {
          const o = new Option(x.has_key ? x.label : `${x.label}（没有 key）`, x.id);
          // Shown but not selectable: "log in with pi" is more useful than an
          // option that silently is not there.
          o.disabled = !x.has_key;
          return o;
        }),
      );
      if (p.current) panel.provPick.value = p.current;
      await panel.loadModels(panel.provPick.value, p.model || '');
    }
  }

  panel.rulesRow.textContent = s.house_rules
    ? '常驻规则：已加载 house_rules.md（不擅自改图 / 写词前先读 skill）'
    : '⚠ house_rules.md 缺失 —— 常驻规则没有生效';
  panel.rulesRow.style.color = s.house_rules ? '#9399b2' : '#f9e2af';
  panel.rulesRow.title = s.house_rules_file || '';
}

function show() {
  if (!panel) panel = build();
  panel.el.style.display = 'block';
  refresh();
  if (!pollTimer) pollTimer = setInterval(refresh, POLL_MS);
}
function hide() {
  if (panel) panel.el.style.display = 'none';
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

window.xyzAgent = {
  show,
  hide,
  toggle: () => (panel && panel.el.style.display !== 'none' ? hide() : show()),
  status: () => get('/xyz/agent/status'),
};

app.registerExtension({ name: 'xyz.agent.launcher' });
