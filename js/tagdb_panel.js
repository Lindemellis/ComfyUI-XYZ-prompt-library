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

// Scrape threshold default (count >= N) — lives in the shared settings object,
// edited in the unified XYZ Prompt Tools settings page.
function scrapeMinDefault() {
  const n = parseInt(window.xyzAcSettings?.scrapeMin, 10);
  return Number.isFinite(n) && n >= 0 ? n : 50;
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
  translationsCheck:    () => api.getJSON('/xyz/tagdb/translations/check'),
  translationsDownload: () => api.postJSON('/xyz/tagdb/translations/download', {}),
  maintain:        (b) => api.postJSON('/xyz/tagdb/maintain', b),
  maintainStatus:  () => api.getJSON('/xyz/tagdb/maintain/status'),
  maintainCancel:  () => api.postJSON('/xyz/tagdb/maintain/cancel', {}),
  snapshots:       () => api.getJSON('/xyz/tagdb/snapshots'),
  activeInfo:      () => api.getJSON('/xyz/tagdb/snapshots/active'),
  setActive:       (b) => api.postJSON('/xyz/tagdb/snapshots/active', b),
  exportWorking:   () => api.postJSON('/xyz/tagdb/snapshots/export', {}),
  reconstruct:     (b) => api.postJSON('/xyz/tagdb/reconstruct', b),
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

  // Render the manager's sections into a host element (the unified settings page's
  // "Tag dataset" tab) instead of a standalone window.
  renderInto(host) {
    host.append(
      this._sectionActive(),
      this._sectionCredentials(),
      this._sectionOfficial(),
      this._sectionUpdate(),
      this._sectionSnapshots(),
    );
    this.refreshAll();
    this._startPolling();
  }

  detach() {
    this._stopPolling();
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

  // ── active dataset info ──
  _sectionActive() {
    this.els.banner = el('div', { style: { fontSize: '12px', color: '#ccc', lineHeight: '1.7' } }, 'Loading…');
    return this._section('Active dataset', this.els.banner);
  }

  async _refreshActiveInfo() {
    try {
      const a = (await api.activeInfo()).active;
      if (!a) { this.els.banner.textContent = 'No active dataset.'; this._activeFilename = null; return; }
      const tc = Number(a.tag_count || 0).toLocaleString();
      const created      = fmtEpoch(Number(a.created_at || 0));
      const incrUpdate   = Number(a.structure_synced_through || 0);
      const incrStr      = incrUpdate ? fmtEpoch(incrUpdate) : '—';
      const countRelated = fmtEpoch(Number(a.full_count_synced_at || 0));
      const isRecon      = String(a.label || '').startsWith('recon');
      const reconDate    = isRecon ? (String(a.label || '').replace('recon_', '')) : null;
      const parts = [
        `<b>${a.label || a.filename}</b> · ${tc} tags`,
        `Creation: <b>${created}</b>`,
        `Latest incremental update: <b>${incrStr}</b>`,
        `Count &amp; related data date: <b>${countRelated}</b>`,
      ];
      if (isRecon && reconDate) {
        parts.push(`Time backtrack: <b style="color:#fc6">${reconDate}</b> <span style="color:#fc6">(historical snapshot)</span>`);
      }
      this.els.banner.innerHTML = parts.join('<br>');
      this._activeFilename = a.filename;
    } catch {}
  }

  // ── credentials (login + api key; key masked with Show/Hide) ──
  _sectionCredentials() {
    this.els.login = el('input', { type: 'text', placeholder: 'danbooru login', style: this._inputStyle() });
    this.els.apikey = el('input', { type: 'password', placeholder: 'api key', style: this._inputStyle() });
    this._keyShown = false;
    const toggle = this._btn('Show', async () => {
      if (!this._keyShown) {
        if (!this.els.apikey.value) {
          try {
            const s = await api.getJSON('/xyz/tagdb/settings?reveal=1');
            this.els.apikey.value = s.danbooru_api_key || '';
          } catch {}
        }
        this.els.apikey.type = 'text'; this._keyShown = true; toggle.textContent = 'Hide';
      } else {
        this.els.apikey.type = 'password'; this._keyShown = false; toggle.textContent = 'Show';
      }
    });
    return this._section('Danbooru credentials (optional — raises rate limit)',
      el('div', { style: { fontSize: '11px', color: '#999', marginBottom: '4px' } },
        'Stored locally; the API key is masked by default.'),
      this.els.login,
      this.els.apikey,
      el('div', { style: { marginTop: '6px' } },
        this._btn('Save', async () => {
          const body = { danbooru_login: this.els.login.value.trim() };
          if (this.els.apikey.value) body.danbooru_api_key = this.els.apikey.value.trim();
          await api.saveSettings(body);
          this._loadCredentials();
          this._toast('Credentials saved');
        }, { primary: true }),
        toggle,
      ),
    );
  }

  // ── official dataset ──
  _sectionOfficial() {
    this.els.official = el('div', { style: { fontSize: '12px', marginBottom: '6px' } }, '—');
    this.els.trStatus = el('div', { style: { fontSize: '11px', color: '#999', margin: '4px 0' } }, '');
    this.els.inclTr = el('input', { type: 'checkbox' });
    return this._section('Prebuilt dataset (from the node author’s GitHub release)',
      this.els.official,
      el('div', {},
        this._btn('Check for updates', () => this._checkOfficial()),
        this._btn('Download / Update', () => this._downloadOfficial(), { primary: true }),
      ),
      el('label', { style: { fontSize: '12px', display: 'block', marginTop: '8px' } },
        this.els.inclTr, ' also fetch the translations add-on (JP/CN names + artist former names)'),
      this.els.trStatus,
      el('div', {}, this._btn('Download translations add-on only', () => this._downloadTranslations())),
    );
  }

  async _downloadTranslations() {
    try { await api.translationsDownload(); this._toast('Translations download started'); }
    catch (e) { this._toast(e.message.includes('400') ? 'Download the base dataset first' : 'Error: ' + e.message); }
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
    this.els.reconDate = el('input', { type: 'date',
      style: { ...this._inputStyle(), width: '150px', display: 'inline-block' } });
    return this._section('Snapshots (switch time node)',
      el('div', { style: { marginBottom: '6px' } },
        el('span', { style: { fontSize: '12px' } }, 'Reconstruct vocabulary as of '),
        this.els.reconDate,
        this._btn('Reconstruct & use', () => this._reconstruct(), { primary: true })),
      el('div', { style: { fontSize: '11px', color: '#888', marginBottom: '6px' } },
        'Rebuilds which tags existed + their category/name at that date (needs a dataset built with --with-versions for category history). Post counts & related stay current.'),
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
  async refreshAll() {
    if (this.els.minCount) this.els.minCount.value = String(scrapeMinDefault());
    this._loadCredentials();
    await this._refreshActiveInfo();   // sets _activeFilename for the list marker
    this._loadSnapshots();
    this._checkOfficial(true);
  }

  async _loadCredentials() {
    try {
      const s = await api.settings();
      this.els.login.value = s.danbooru_login || '';
      this.els.apikey.value = '';
      this.els.apikey.type = 'password';
      this._keyShown = false;
      this.els.apikey.placeholder = s.has_credentials ? 'api key saved (•••) — type to change' : 'api key';
    } catch {}
  }

  async _checkOfficial(silent) {
    try {
      const info = await api.officialCheck();
      if (!info.has_manifest) {
        this.els.official.textContent = 'No prebuilt dataset published yet — use a Full re-scrape, or wait for the author to publish one.';
        if (!silent) this._toast('No prebuilt dataset published yet');
        return;
      }
      const status = info.update_available ? 'update available' : 'up to date';
      this.els.official.innerHTML =
        `latest: <b>${info.latest || '—'}</b> · installed: <b>${info.installed || 'none'}</b>` +
        (info.update_available ? ' · <span style="color:#6f6">update available</span>' : ' · up to date');
      if (!silent) this._toast(`Prebuilt dataset: ${status} (latest ${info.latest || '—'}, installed ${info.installed || 'none'})`);
      try {
        const t = await api.translationsCheck();
        this.els.trStatus.textContent = t.available
          ? (t.installed ? 'Translations add-on: installed ✓'
                         : `Translations add-on: available (${Math.round((t.size_bytes || 0) / 1e6)} MB) — not installed`)
          : 'Translations add-on: none published';
      } catch {}
    } catch (e) {
      this.els.official.textContent = 'check failed: ' + e.message;
      if (!silent) this._toast('Check failed: ' + e.message);
    }
  }

  async _downloadOfficial() {
    try {
      // If a working DB exists, replace it (the backend exports it to local/ first).
      const snaps = await api.snapshots();
      const hasWorking = snaps.some((s) => s.kind === 'working');
      await api.officialDownload({ replace_working: hasWorking,
                                   include_translations: this.els.inclTr?.checked });
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

  async _reconstruct() {
    const date = this.els.reconDate.value;
    if (!date) { this._toast('Pick a date first'); return; }
    try {
      await api.reconstruct({ date });
      this._toast(`Reconstructing as of ${date}…`);
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
          s.filename === this._activeFilename
            ? el('span', { style: { color: '#6f6', fontSize: '11px' } }, 'active')
            : this._btn('Use', async () => {
                await api.setActive({ filename: s.filename });
                await this._refreshActiveInfo();
                this._loadSnapshots();
                this._toast('Switched');
              }),
        );
        this.els.snaps.append(row);
      }
    } catch (e) { this.els.snaps.textContent = 'failed: ' + e.message; }
  }

  // ── polling for the live log while open ──
  _startPolling() {
    if (this.pollTimer) return;
    const tick = async () => {
      try {
        const st = await api.maintainStatus();
        // Only rewrite the log when it actually changed, and preserve the user's
        // scroll position / text selection (auto-scroll only if already at bottom).
        const text = (st.log || []).join('\n');
        if (text !== this._lastLog) {
          const pre = this.els.log;
          const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
          pre.textContent = text;
          if (atBottom) pre.scrollTop = pre.scrollHeight;
          this._lastLog = text;
        }
        // On running→idle transition, refresh the active-dataset info + lists.
        if (!st.running && this._wasRunning) {
          this._refreshActiveInfo();
          this._loadSnapshots();
          this._checkOfficial(true);
        }
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

// No native ComfyUI settings / launcher here — the unified XYZ Prompt Tools
// settings page (xyz_settings.js) embeds this manager via manager.renderInto().
export { manager };
