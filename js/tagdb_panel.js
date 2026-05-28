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
  async delJSON(url, body) {
    const r = await fetch(url, {
      method: 'DELETE',
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
  gelbooruCheck:   () => api.getJSON('/xyz/tagdb/gelbooru/check'),
  gelbooruDownload:(b) => api.postJSON('/xyz/tagdb/gelbooru/download', b),
  gelbooruBuild:   (b) => api.postJSON('/xyz/tagdb/gelbooru/build', b),
  gelbooruDelete:  () => api.postJSON('/xyz/tagdb/gelbooru/delete', {}),
  gelbooruExport:  () => api.postJSON('/xyz/tagdb/gelbooru/export', {}),
  maintain:        (b) => api.postJSON('/xyz/tagdb/maintain', b),
  maintainStatus:  () => api.getJSON('/xyz/tagdb/maintain/status'),
  maintainCancel:  () => api.postJSON('/xyz/tagdb/maintain/cancel', {}),
  snapshots:       () => api.getJSON('/xyz/tagdb/snapshots'),
  activeInfo:      () => api.getJSON('/xyz/tagdb/snapshots/active'),
  setActive:       (b) => api.postJSON('/xyz/tagdb/snapshots/active', b),
  exportWorking:   () => api.postJSON('/xyz/tagdb/snapshots/export', {}),
  deleteSnapshot:  (b) => api.delJSON('/xyz/tagdb/snapshots', b),
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
    this._buildTabbed(host);
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
    this._buildTabbed(body);
    win.append(bar, body);
    document.body.append(win);
    this.root = win;
  }

  // A prominent, full-width segmented control (Danbooru | Gelbooru) at the very top —
  // this is the top-level source switch, visually a tier above the per-page sections.
  // Each page holds that source's own management sections.
  _buildTabbed(container) {
    const pageStyle = { display: 'flex', flexDirection: 'column', gap: '14px' };
    const pageDan = el('div', { style: { ...pageStyle } });
    const pageGel = el('div', { style: { ...pageStyle, display: 'none' } });

    const tabs = {};
    const ACCENT = { danbooru: '#4a90d9', gelbooru: '#3aa55a' };
    const select = (key) => {
      this._activeTab = key;
      pageDan.style.display = key === 'danbooru' ? 'flex' : 'none';
      pageGel.style.display = key === 'gelbooru' ? 'flex' : 'none';
      for (const k in tabs) {
        const on = k === key;
        Object.assign(tabs[k].style, {
          color: on ? '#fff' : '#888',
          background: on ? '#262626' : 'transparent',
          borderBottom: `3px solid ${on ? ACCENT[k] : 'transparent'}`,
        });
      }
    };
    // Full-width segmented bar: two equal segments, bottom-accent on the active one.
    const tabBar = el('div', { style: {
      display: 'flex', width: '100%', marginBottom: '14px',
      borderBottom: '1px solid #333', background: '#1a1a1a', borderRadius: '6px 6px 0 0',
    }});
    for (const [key, label] of [['danbooru', 'Danbooru'], ['gelbooru', 'Gelbooru']]) {
      const t = el('button', { onclick: () => select(key), style: {
        flex: '1', textAlign: 'center', padding: '11px 0', fontSize: '15px',
        fontWeight: 'bold', letterSpacing: '0.3px', background: 'transparent',
        color: '#888', border: 'none', borderBottom: '3px solid transparent',
        cursor: 'pointer', transition: 'color .12s, background .12s',
      }}, label);
      tabs[key] = t; tabBar.append(t);
    }

    pageDan.append(
      this._sectionActive(),
      this._sectionCredentials(),
      this._sectionOfficial(),
      this._sectionUpdate(),
      this._sectionSnapshots(),
    );
    pageGel.append(
      this._sectionGelbooruActive(),
      this._sectionGelbooruCreds(),
      this._sectionGelbooruDataset(),
      this._sectionGelbooruSnapshots(),
    );

    container.append(tabBar, pageDan, pageGel);
    select(this._activeTab || 'danbooru');
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
    return this._section('Prebuilt dataset (from the node author’s GitHub release)',
      this.els.official,
      el('div', {},
        this._btn('Check for updates', () => this._checkOfficial()),
        this._btn('Download / Update', () => this._downloadOfficial(), { primary: true }),
      ),
    );
  }

  // ── gelbooru (second source) ──
  // Active gelbooru dataset banner (parallel to danbooru's _sectionActive).
  _sectionGelbooruActive() {
    this.els.gelBanner = el('div', { style: { fontSize: '12px', color: '#ccc', lineHeight: '1.7' } }, 'Loading…');
    return this._section('Active gelbooru dataset', this.els.gelBanner);
  }

  // Gelbooru credentials (api_key + user_id; masked with Show/Hide).
  _sectionGelbooruCreds() {
    this.els.gelUserId = el('input', { type: 'text', placeholder: 'gelbooru user_id', style: this._inputStyle() });
    this.els.gelApiKey = el('input', { type: 'password', placeholder: 'gelbooru api key', style: this._inputStyle() });
    this._gelKeyShown = false;
    const toggle = this._btn('Show', async () => {
      if (!this._gelKeyShown) {
        if (!this.els.gelApiKey.value) {
          try { const s = await api.getJSON('/xyz/tagdb/settings?reveal=1'); this.els.gelApiKey.value = s.gelbooru_api_key || ''; } catch {}
        }
        this.els.gelApiKey.type = 'text'; this._gelKeyShown = true; toggle.textContent = 'Hide';
      } else {
        this.els.gelApiKey.type = 'password'; this._gelKeyShown = false; toggle.textContent = 'Show';
      }
    });
    return this._section('Gelbooru credentials (needed only to build/update directly)',
      el('div', { style: { fontSize: '11px', color: '#999', marginBottom: '4px' } },
        'Required to build directly from gelbooru (its tag API returns 401 without them). Downloading a prebuilt dataset needs no credentials. Stored locally, masked by default.'),
      this.els.gelUserId,
      this.els.gelApiKey,
      el('div', { style: { marginTop: '6px' } },
        this._btn('Save credentials', async () => {
          const body = { gelbooru_user_id: this.els.gelUserId.value.trim() };
          if (this.els.gelApiKey.value) body.gelbooru_api_key = this.els.gelApiKey.value.trim();
          await api.saveSettings(body);
          this._loadCredentials();
          this._toast('Gelbooru credentials saved');
        }, { primary: true }),
        toggle,
      ),
    );
  }

  // Gelbooru dataset: status + download / build / remove + a live log (parallel to
  // danbooru's "Update from danbooru" section, incl. the terminal-style <pre> log).
  _sectionGelbooruDataset() {
    this.els.gelStatus = el('div', { style: { fontSize: '12px', margin: '4px 0' } }, '—');
    this.els.gelMinCount = el('input', { type: 'number', value: '20', style: { ...this._inputStyle(), width: '70px', display: 'inline-block' } });
    this.els.gelLog = el('pre', { style: {
      background: '#111', border: '1px solid #333', borderRadius: '4px', padding: '6px',
      height: '120px', overflowY: 'auto', fontSize: '11px', whiteSpace: 'pre-wrap', margin: '6px 0 0',
    }}, '');
    return this._section('Gelbooru dataset',
      el('div', { style: { fontSize: '11px', color: '#999', marginBottom: '4px' } },
        'When installed AND enabled in Settings → Autocomplete, gelbooru tags merge into suggestions (rows show D/G tokens). Deprecated tags are excluded. No time machine — gelbooru is current-only.'),
      this.els.gelStatus,
      el('div', {},
        this._btn('Check for updates', () => this._checkGelbooru()),
        this._btn('Download dataset', () => this._downloadGelbooru(), { primary: true }),
      ),
      el('div', { style: { marginTop: '6px' } },
        el('label', { style: { fontSize: '12px' } }, 'build direct: post count ≥ '), this.els.gelMinCount,
        this._btn('Build from gelbooru', () => this._buildGelbooru()),
        this._btn('Cancel', () => api.maintainCancel()),
        this._btn('Remove', () => this._removeGelbooru()),
      ),
      this.els.gelLog,
    );
  }

  // Gelbooru snapshots: switch between datasets scraped at different times. Gelbooru has
  // no time-reconstruction, but different-date downloads/exports are switchable here.
  _sectionGelbooruSnapshots() {
    this.els.gelSnaps = el('div', {});
    return this._section('Gelbooru snapshots (switch dataset)',
      el('div', { style: { fontSize: '11px', color: '#999', marginBottom: '8px' } },
        '"Use" switches gelbooru autocomplete to read from that dataset (the working DB is untouched). Different-date downloads and exported checkpoints appear here.'),
      el('div', {}, this._btn('Export current → checkpoint', async () => {
        try { await api.gelbooruExport(); this._loadSnapshots(); this._toast('Exported gelbooru checkpoint'); }
        catch (e) { this._toast('Export failed: ' + e.message); }
      })),
      this.els.gelSnaps,
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
        'Incremental: new events + full post_count refresh + artist translations. Full: re-scrape everything from scratch (~15–20 min).'),
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
    return this._section('Snapshots (switch read source)',
      el('div', { style: { fontSize: '11px', color: '#999', marginBottom: '8px' } },
        '"Use" switches autocomplete to read from that snapshot. The working DB is not modified. Run Maintain to update the working DB.'),
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
    await this._refreshActiveInfo();   // sets _activeFilename for the danbooru list marker
    await this._checkGelbooru(true);   // sets _gelActiveFilename for the gelbooru list marker
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
      if (this.els.gelUserId) {
        this.els.gelUserId.value = s.gelbooru_user_id || '';
        this.els.gelApiKey.value = '';
        this.els.gelApiKey.type = 'password';
        this._gelKeyShown = false;
        this.els.gelApiKey.placeholder = s.has_gelbooru_credentials ? 'api key saved (•••) — type to change' : 'gelbooru api key';
      }
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
      await api.officialDownload({ replace_working: hasWorking });
      this._toast('Download started');
    } catch (e) { this._toast('Download error: ' + e.message); }
  }

  async _checkGelbooru(silent) {
    try {
      const info = await api.gelbooruCheck();
      this._gelActiveFilename = info.active ? (info.active_filename || 'gelbooru.sqlite') : null;
      // Active-dataset banner (parallel to danbooru's).
      if (this.els.gelBanner) {
        if (info.active) {
          const tc = Number(info.working_tag_count || 0).toLocaleString();
          const ac = Number(info.working_alias_count || 0).toLocaleString();
          const date = info.working_date ? ` · built ${info.working_date}` : '';
          const which = info.active_is_working ? 'working DB' : (info.active_filename || '');
          this.els.gelBanner.innerHTML =
            `<b>${tc} tags</b>, ${ac} aliases${date}` +
            `<br><span style="color:#888;font-size:11px">reading: ${which}</span>`;
        } else {
          this.els.gelBanner.innerHTML =
            'No gelbooru dataset installed. Download a prebuilt one, or build directly with credentials below.';
        }
      }
      // Download/update status line.
      let txt = info.active ? 'installed' : 'not installed';
      if (info.has_manifest) {
        txt += ` · latest DLC: <b>${info.latest || '—'}</b>`;
        if (info.update_available) txt += ' · <span style="color:#6f6">update available</span>';
      } else {
        txt += ' · no prebuilt DLC published — build directly with credentials';
      }
      if (this.els.gelStatus) this.els.gelStatus.innerHTML = txt;
      if (!silent) this._toast('Gelbooru: ' + (info.active ? 'installed' : 'not installed'));
    } catch (e) {
      if (this.els.gelStatus) this.els.gelStatus.textContent = 'check failed: ' + e.message;
      if (!silent) this._toast('Check failed: ' + e.message);
    }
  }

  async _downloadGelbooru() {
    try {
      await api.gelbooruDownload({});
      this._toast('Gelbooru download started');
    } catch (e) { this._toast('Download error: ' + e.message); }
  }

  async _buildGelbooru() {
    try {
      await api.gelbooruBuild({ min_post_count: parseInt(this.els.gelMinCount.value, 10) || 20 });
      this._toast('Gelbooru build started (this can take a while)');
    } catch (e) {
      this._toast(e.message.includes('409') ? 'A task is already running'
        : e.message.includes('400') ? 'Set gelbooru credentials first' : 'Error: ' + e.message);
    }
  }

  async _removeGelbooru() {
    if (!confirm('Remove the gelbooru dataset? Autocomplete will fall back to danbooru only.')) return;
    try {
      await api.gelbooruDelete();
      this._checkGelbooru();
      this._toast('Gelbooru dataset removed');
    } catch (e) { this._toast('Remove failed: ' + e.message); }
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
      const isGel = (s) => (s.source || '') === 'gelbooru';
      this._renderSnapList(snaps.filter((s) => !isGel(s)), this.els.snaps, this._activeFilename);
      if (this.els.gelSnaps) {
        this._renderSnapList(snaps.filter(isGel), this.els.gelSnaps, this._gelActiveFilename);
      }
    } catch (e) {
      if (this.els.snaps) this.els.snaps.textContent = 'failed: ' + e.message;
    }
  }

  // Render one source's snapshot list into `host`; `activeFilename` marks the active row.
  _renderSnapList(snaps, host, activeFilename) {
    host.innerHTML = '';
    if (!snaps.length) {
      host.append(el('div', { style: { fontSize: '12px', color: '#888', padding: '4px 0' } },
        'No datasets installed yet.'));
      return;
    }
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
            `${s.filename} (${(s.tag_count || 0).toLocaleString()} tags)`)),
        el('span', { style: { display: 'inline-flex', gap: '4px', flexShrink: '0', minWidth: '110px', justifyContent: 'flex-end' } },
          s.filename === activeFilename
            ? el('span', { style: { color: '#6f6', fontSize: '11px', padding: '5px 8px' } }, 'active')
            : this._btn('Use', async () => {
                await api.setActive({ filename: s.filename });
                await this._refreshActiveInfo();
                await this._checkGelbooru(true);
                this._loadSnapshots();
                this._toast('Switched to ' + s.filename);
              }),
          s.kind !== 'working'
            ? this._btn('Del', async () => {
                if (!confirm(`Delete ${s.filename}?\n\nThis snapshot will be removed from disk.`)) return;
                try {
                  const r = await api.deleteSnapshot({ filename: s.filename });
                  await this._refreshActiveInfo();
                  await this._checkGelbooru(true);
                  this._loadSnapshots();
                  this._toast(r.deleted + ' deleted');
                } catch (e) { this._toast('Delete failed: ' + e.message); }
              })
            : null,
        ),
      );
      host.append(row);
    }
  }

  // ── polling for the live log while open ──
  _startPolling() {
    if (this.pollTimer) return;
    const tick = async () => {
      try {
        const st = await api.maintainStatus();
        // Only rewrite the log when it actually changed, and preserve the user's scroll
        // position (auto-scroll only if at bottom). danbooru + gelbooru ops share the
        // single maintenance log, so both log boxes mirror it.
        const text = (st.log || []).join('\n');
        if (text !== this._lastLog) {
          for (const pre of [this.els.log, this.els.gelLog]) {
            if (!pre) continue;
            const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
            pre.textContent = text;
            if (atBottom) pre.scrollTop = pre.scrollHeight;
          }
          this._lastLog = text;
        }
        // On running→idle transition, refresh the active-dataset info + lists.
        if (!st.running && this._wasRunning) {
          this._refreshActiveInfo();
          this._checkGelbooru(true);
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
