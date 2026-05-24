/**
 * XYZ Tag DB Manager — settings panel for the danbooru tag database.
 *
 * A self-contained floating window covering: danbooru credentials, the official
 * dataset (check/download from the GitHub Release), manual updates (incremental
 * vs full) with a live log + staleness banner, and snapshot switching/export.
 *
 * Talks to the /xyz/tagdb/* routes. Opened via the "Open Tag DB Manager" command
 * / action-bar button. No external deps (does not import the PLv2 window helper).
 */

import { app } from '../../../scripts/app.js';

const EXT_ID = 'XYZNodes.TagDBManager';

const KIND_COLORS = {
  working:  '#aaffaa',
  official: '#aaddff',
  local:    '#ffee88',
  legacy:   '#bbbbbb',
};

// Display labels — "official" internally is the AUTHOR's prebuilt dataset, not a
// danbooru-provided one, so show "prebuilt" to avoid that misreading.
const KIND_LABELS = {
  working:  'working',
  official: 'prebuilt',
  local:    'local',
  legacy:   'legacy',
};

// Persistent default for the scrape threshold (count >= N), set in ComfyUI Settings.
const SCRAPE_MIN_SETTING = EXT_ID + '.ScrapeMinPostCount';
function scrapeMinDefault() {
  const n = parseInt(app.extensionManager?.setting?.get(SCRAPE_MIN_SETTING), 10);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

// ─── API ───────────────────────────────────────────────────────────────────────

const api = {
  async getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
    return r.json();
  },
  async postJSON(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
    return r.json();
  },
  settings:        () => api.getJSON('/xyz/tagdb/settings'),
  saveSettings:    (b) => api.postJSON('/xyz/tagdb/settings', b),
  officialCheck:   () => api.getJSON('/xyz/tagdb/official/check'),
  officialDownload:(b) => api.postJSON('/xyz/tagdb/official/download', b),
  maintain:        (b) => api.postJSON('/xyz/tagdb/maintain', b),
  maintainStatus:  () => api.getJSON('/xyz/tagdb/maintain/status'),
  maintainCancel:  () => api.postJSON('/xyz/tagdb/maintain/cancel', {}),
  snapshots:       () => api.getJSON('/xyz/tagdb/snapshots'),
  setActive:       (b) => api.postJSON('/xyz/tagdb/snapshots/active', b),
  exportWorking:   () => api.postJSON('/xyz/tagdb/snapshots/export', {}),
};

// ─── DOM helpers ─────────────────────────────────────────────────────────────────

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style') Object.assign(e.style, v);
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

const fmtDays = (d) => (d == null ? 'never' : `${d} day(s) ago`);
const fmtEpoch = (s) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : '—');

// ─── Panel ───────────────────────────────────────────────────────────────────────

class TagDBManager {
  constructor() {
    this.root = null;
    this.pollTimer = null;
    this.els = {};
  }

  toggle() {
    if (this.root && this.root.style.display !== 'none') this.hide();
    else this.show();
  }

  hide() {
    if (this.root) this.root.style.display = 'none';
    this._stopPolling();
  }

  show() {
    if (!this.root) this._build();
    this.root.style.display = 'flex';
    this.refreshAll();
    this._startPolling();
  }

  // ── build ──
  _build() {
    const win = el('div', { class: 'xyz-tagdb-win', style: {
      position: 'fixed', top: '80px', right: '40px', width: '440px',
      maxHeight: '80vh', background: '#1e1e1e', color: '#ddd',
      border: '1px solid #444', borderRadius: '8px', zIndex: 10000,
      display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,.5)',
      font: '13px sans-serif',
    }});

    // title bar (draggable)
    const bar = el('div', { style: {
      cursor: 'move', padding: '8px 12px', background: '#2a2a2a',
      borderBottom: '1px solid #444', borderRadius: '8px 8px 0 0',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }},
      el('b', {}, 'Tag DB Manager'),
      el('span', { style: { cursor: 'pointer', padding: '0 6px' }, onclick: () => this.hide() }, '✕'),
    );
    this._makeDraggable(win, bar);

    const body = el('div', { style: { padding: '12px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px' } });
    body.append(
      this._sectionActive(),
      this._sectionCredentials(),
      this._sectionOfficial(),
      this._sectionUpdate(),
      this._sectionSnapshots(),
    );
    win.append(bar, body);
    document.body.append(win);
    this.root = win;
  }

  _section(title, ...nodes) {
    return el('div', { style: { borderTop: '1px solid #333', paddingTop: '10px' } },
      el('div', { style: { fontWeight: 'bold', marginBottom: '6px', color: '#9cf' } }, title),
      ...nodes);
  }

  _btn(label, onclick, opts = {}) {
    return el('button', { onclick, style: {
      background: opts.primary ? '#3a6' : '#3a3a3a', color: '#fff', border: '1px solid #555',
      borderRadius: '4px', padding: '5px 10px', cursor: 'pointer', marginRight: '6px',
    }}, label);
  }

  // ── active / freshness banner ──
  _sectionActive() {
    this.els.banner = el('div', { style: { fontSize: '12px', color: '#ccc' } }, 'Loading…');
    return this._section('Active database', this.els.banner);
  }

  // ── credentials (api key only; login lives in ComfyUI Settings) ──
  _sectionCredentials() {
    this.els.apikey = el('input', { type: 'password', placeholder: 'api key', style: this._inputStyle() });
    return this._section('Danbooru API key (optional — raises rate limit)',
      el('div', { style: { fontSize: '11px', color: '#999', marginBottom: '4px' } },
        'Login is set in ComfyUI Settings → XYZ Tag Autocomplete. The key is stored locally and masked by default.'),
      this.els.apikey,
      el('div', { style: { marginTop: '6px' } },
        this._btn('Save', async () => {
          if (!this.els.apikey.value) { this._toast('Enter a key to save'); return; }
          await api.saveSettings({ danbooru_api_key: this.els.apikey.value.trim() });
          this.els.apikey.value = '';
          this.els.apikey.type = 'password';
          this._loadCredentials();
          this._toast('API key saved');
        }, { primary: true }),
        this._btn('Show stored', async () => {
          // Reveal the user's own stored key (localhost) into the field.
          try {
            const s = await api.getJSON('/xyz/tagdb/settings?reveal=1');
            this.els.apikey.value = s.danbooru_api_key || '';
            this.els.apikey.type = 'text';
          } catch {}
        }),
      ),
    );
  }

  // ── official dataset ──
  _sectionOfficial() {
    this.els.official = el('div', { style: { fontSize: '12px', marginBottom: '6px' } }, '—');
    return this._section('Prebuilt dataset (from the node author’s GitHub release)',
      this.els.official,
      el('div', {},
        this._btn('Check for updates', () => this._checkOfficial()),
        this._btn('Download / Update', () => this._downloadOfficial(), { primary: true }),
      ),
    );
  }

  // ── update ──
  _sectionUpdate() {
    this.els.minCount = el('input', { type: 'number', value: '10', style: { ...this._inputStyle(), width: '70px', display: 'inline-block' } });
    this.els.log = el('pre', { style: {
      background: '#111', border: '1px solid #333', borderRadius: '4px', padding: '6px',
      height: '120px', overflowY: 'auto', fontSize: '11px', whiteSpace: 'pre-wrap', margin: '6px 0 0',
    }}, '');
    return this._section('Update from danbooru',
      el('div', { style: { fontSize: '12px', marginBottom: '6px', color: '#fb8' } },
        'Incremental: only new/changed tags, versions, aliases — does NOT refresh post counts or related tags of unchanged tags. Full: re-scrape everything (~15–20 min).'),
      el('label', { style: { fontSize: '12px' } }, 'only scrape tags with post count ≥ '), this.els.minCount,
      el('div', { style: { fontSize: '11px', color: '#888', margin: '2px 0' } },
        'Default is set in ComfyUI Settings → XYZ Tag Autocomplete; change here for a one-off run.'),
      el('div', { style: { margin: '6px 0' } },
        this._btn('Incremental', () => this._runUpdate('incremental'), { primary: true }),
        this._btn('Full re-scrape', () => this._runUpdate('full')),
        this._btn('Cancel', () => api.maintainCancel()),
      ),
      this.els.log,
    );
  }

  // ── snapshots ──
  _sectionSnapshots() {
    this.els.snaps = el('div', {});
    return this._section('Snapshots (switch time node)',
      el('div', {}, this._btn('Export working DB → checkpoint', async () => {
        await api.exportWorking(); this._loadSnapshots(); this._toast('Exported checkpoint');
      })),
      this.els.snaps,
    );
  }

  _inputStyle() {
    return { width: '100%', boxSizing: 'border-box', margin: '3px 0', padding: '5px',
             background: '#2a2a2a', color: '#fff', border: '1px solid #555', borderRadius: '4px' };
  }

  // ── data loads ──
  refreshAll() {
    if (this.els.minCount) this.els.minCount.value = String(scrapeMinDefault());
    this._loadCredentials();
    this._loadSnapshots();
    this._checkOfficial(true);
  }

  async _loadCredentials() {
    try {
      const s = await api.settings();
      this.els.apikey.placeholder = s.has_credentials ? 'api key saved (•••) — type to change' : 'api key';
    } catch {}
  }

  async _checkOfficial(silent) {
    try {
      const info = await api.officialCheck();
      if (!info.has_manifest) {
        this.els.official.textContent = 'No prebuilt dataset published yet — use a Full re-scrape, or wait for the author to publish one.';
        return;
      }
      this.els.official.innerHTML =
        `latest: <b>${info.latest || '—'}</b> · installed: <b>${info.installed || 'none'}</b>` +
        (info.update_available ? ' · <span style="color:#6f6">update available</span>' : ' · up to date');
    } catch (e) {
      if (!silent) this.els.official.textContent = 'check failed: ' + e.message;
    }
  }

  async _downloadOfficial() {
    try {
      // If a working DB exists, replace it (the backend exports it to local/ first).
      const snaps = await api.snapshots();
      const hasWorking = snaps.some((s) => s.kind === 'working');
      await api.officialDownload({ replace_working: hasWorking });
      this._toast('Download started');
    } catch (e) { this._toast('Download error: ' + e.message); }
  }

  async _runUpdate(mode) {
    try {
      await api.maintain({ mode, min_post_count: parseInt(this.els.minCount.value, 10) || 10 });
      this._toast(`${mode} update started`);
    } catch (e) {
      this._toast(e.message.includes('409') ? 'A task is already running' : 'Error: ' + e.message);
    }
  }

  async _loadSnapshots() {
    try {
      const snaps = await api.snapshots();
      this.els.snaps.innerHTML = '';
      for (const s of snaps) {
        const badge = el('span', { style: {
          background: KIND_COLORS[s.kind] || '#999', color: '#111', borderRadius: '3px',
          padding: '0 5px', fontSize: '10px', marginRight: '6px', fontWeight: 'bold',
        }}, KIND_LABELS[s.kind] || s.kind);
        const row = el('div', { style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '4px 0', borderBottom: '1px solid #2a2a2a',
        }},
          el('div', {}, badge,
            el('span', { title: `structure→${fmtEpoch(s.structure_synced_through)}, counts→${fmtEpoch(s.full_count_synced_at)}` },
              `${s.filename} (${s.tag_count.toLocaleString()} tags)`)),
          s.kind === 'working' ? el('span', { style: { color: '#6f6', fontSize: '11px' } }, 'active')
            : this._btn('Use', async () => { await api.setActive({ filename: s.filename }); this._toast('Switched'); this._refreshBanner(); }),
        );
        this.els.snaps.append(row);
      }
    } catch (e) { this.els.snaps.textContent = 'failed: ' + e.message; }
  }

  async _refreshBanner() {
    try {
      const st = await api.maintainStatus();
      const f = st.freshness || {};
      const stale = f.full_count_age_days;
      this.els.banner.innerHTML =
        `structure current to <b>${fmtEpoch(f.structure_synced_through)}</b> · ` +
        `post counts refreshed <b style="color:${stale > 30 ? '#f88' : '#9c9'}">${fmtDays(stale)}</b>`;
    } catch {}
  }

  // ── polling for the live log + freshness while open ──
  _startPolling() {
    if (this.pollTimer) return;
    const tick = async () => {
      try {
        const st = await api.maintainStatus();
        this.els.log.textContent = (st.log || []).join('\n');
        this.els.log.scrollTop = this.els.log.scrollHeight;
        const f = st.freshness || {};
        const stale = f.full_count_age_days;
        this.els.banner.innerHTML =
          `structure current to <b>${fmtEpoch(f.structure_synced_through)}</b> · ` +
          `post counts refreshed <b style="color:${stale > 30 ? '#f88' : '#9c9'}">${fmtDays(stale)}</b>` +
          (st.running ? ` · <span style="color:#fc6">${st.mode || 'task'} running…</span>` : '');
        if (!st.running && this._wasRunning) { this._loadSnapshots(); this._checkOfficial(true); }
        this._wasRunning = st.running;
      } catch {}
    };
    tick();
    this.pollTimer = setInterval(tick, 1500);
  }

  _stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  _toast(msg) {
    try {
      app.extensionManager?.toast?.add({ severity: 'info', summary: 'Tag DB', detail: msg, life: 2500 });
    } catch { /* ignore */ }
  }

  _makeDraggable(win, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'SPAN') return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = win.getBoundingClientRect(); ox = r.left; oy = r.top;
      win.style.right = 'auto';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      win.style.left = `${ox + e.clientX - sx}px`;
      win.style.top = `${oy + e.clientY - sy}px`;
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }
}

const manager = new TagDBManager();

// ─── Extension registration ─────────────────────────────────────────────────────

app.registerExtension({
  id: EXT_ID,
  name: 'XYZ Tag DB Manager',
  // Launcher button rendered INSIDE the ComfyUI Settings page (function-type
  // setting → custom DOM). Grouped under the same category as the autocomplete
  // settings. NOT a topbar button.
  settings: [
    {
      id: SCRAPE_MIN_SETTING,
      name: 'Scrape: only fetch tags with post count ≥ this',
      tooltip: 'Lower = more (rarer) tags but a larger DB and longer scrape. 10 is a good default.',
      type: 'number',
      attrs: { min: 0, step: 5 },
      defaultValue: 10,
      category: ['XYZ Tag Autocomplete', 'Danbooru account', 'Scrape threshold'],
    },
    {
      id: EXT_ID + '.openManager',
      name: 'Tag DB Manager (API key, dataset download/update, snapshots)',
      category: ['XYZ Tag Autocomplete', 'Danbooru account', 'Manager'],
      type: () => {
        const b = document.createElement('button');
        b.textContent = 'Open Tag DB Manager';
        Object.assign(b.style, {
          background: '#3a6', color: '#fff', border: '1px solid #555',
          borderRadius: '4px', padding: '5px 12px', cursor: 'pointer',
        });
        b.addEventListener('click', () => manager.show());
        return b;
      },
    },
  ],
  // Also expose via command palette + the main menu (Extensions) — never topbar.
  commands: [
    {
      id: EXT_ID + '.open',
      label: 'Open Tag DB Manager',
      icon: 'pi pi-database',
      function: () => manager.toggle(),
    },
  ],
  menuCommands: [
    { path: ['Extensions', 'XYZ Nodes'], commands: [EXT_ID + '.open'] },
  ],
});

export { manager };
