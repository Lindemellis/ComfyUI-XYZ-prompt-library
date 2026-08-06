// PLv3 — the library window (spec §8.4): folder tree | presets | detail.
//
// The library is a creation-time aid only. Nothing here is on the execution path: a
// group lands in a document as a fully expanded `[path]: { … }` block, and the
// compiler never reads the DB (spec §4.7).
//
// Two views of a group, and they are NOT the same thing:
//
//   the group itself   — WHAT IT CONTAINS. Add, rename, reorder, delete items. There
//                        is no text editor here: a group has no enable state to edit
//                        (§5.2 — that only exists relative to a text), so a text box
//                        would be inventing one.
//   a preset           — WHICH of those items are on, in what order, with what
//                        settings (§5.4). This is where the two-way text editor
//                        belongs (§8.4.3): the text IS the preset's enable list.
//
// A preset's text is a `[path]: { … }` block — the same thing a document holds. So the
// preset view is not a second implementation of "a block with switches on its items":
// it IS the main window's detail page (DetailPane) over the preset's text, driven by
// the same editor (PromptEditor) with the same autocomplete. Two copies of that UI
// would drift apart within a week, and the copy in here would be the worse one.

import { DetailPane, notifyLibraryChanged } from './detail.js';
import { PromptEditor } from './editor_core.js';
import { settings } from './settings.js';
import {
  T, button, div, el, iconButton, input, makeWindow, sectionLabel, splitter, tint,
  treeRow,
} from './theme.js';
import { showConfirm, showContextMenu, showForm, showPrompt, toast } from './ui.js';

export const api = {
  async call(method, path, body) {
    const res = await fetch(`/xyz/plv3/library${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${method} ${path} -> ${res.status}`);
    return data;
  },
  tree() { return this.call('GET', '/tree'); },
  group(id) { return this.call('GET', `/groups/${id}`); },
  createFolder(name, parent_id) { return this.call('POST', '/folders', { name, parent_id }); },
  createGroup(b) { return this.call('POST', '/groups', b); },
  updateGroup(id, b) { return this.call('PATCH', `/groups/${id}`, b); },
  deleteGroup(id) { return this.call('DELETE', `/groups/${id}`); },
  deleteFolder(id) { return this.call('DELETE', `/folders/${id}`); },
  addItem(id, b) { return this.call('POST', `/groups/${id}/items`, b); },
  updateItem(id, b) { return this.call('PATCH', `/items/${id}`, b); },
  deleteItem(id) { return this.call('DELETE', `/items/${id}`); },
  reorder(id, item_ids) { return this.call('POST', `/groups/${id}/reorder`, { item_ids }); },
  expand(b) { return this.call('POST', '/expand', b); },
  sync(text) { return this.call('POST', '/sync', { text }); },
  savePreset(b) { return this.call('POST', '/presets', b); },
  deletePreset(id) { return this.call('DELETE', `/presets/${id}`); },
  groupFromText(b) { return this.call('POST', '/groups/from_text', b); },
  saveDocument(b) { return this.call('POST', '/documents', b); },
  getDocument(id) { return this.call('GET', `/documents/${id}`); },
  updateDocument(id, b) { return this.call('PATCH', `/documents/${id}`, b); },
  deleteDocument(id) { return this.call('DELETE', `/documents/${id}`); },
};

// Which rows the user folded away. Persisted: a tree that forgets its shape every time the
// window closes is a tree nobody bothers to fold.
const COLLAPSE_KEY = 'xyz.plv3.libtree.collapsed';

class LibraryWindow {
  constructor() {
    this.win = null;
    this.selected = null;  // group id
    this.preset = null;    // the selected preset, or null = "the group itself"
    this.selectedDoc = null;  // a saved document's id — the third kind of row
    this.docRow = null;    // ...and its contents, once fetched
    this.onInsert = null;  // set by window.js
    this.onLoadDocument = null;  // set by window.js — only it knows the active node
    this.collapsed = loadCollapsed();  // 'f<id>' / 'g<id>' of every folded row
    // Tags our own library edits so we don't refresh twice on an event we just emitted.
    this._libSrc = Symbol('plv3-libwin');
  }

  /** A library edit landed somewhere (this window's own detail page, or a node's detail
   *  page in the editor window). Refetch so the tree/items reflect it — but skip our own
   *  emissions, which have already refreshed. Debounced so a burst collapses to one. */
  onLibraryChanged(e) {
    if (e.detail?.source === this._libSrc || !this.isVisible()) return;
    clearTimeout(this._libRefreshTimer);
    this._libRefreshTimer = setTimeout(() => this.refresh().catch(() => {}), 60);
  }

  /** Tell the editor window's detail pages that this window changed the library. */
  notifyChanged(path) {
    notifyLibraryChanged(path ? [path] : null, this._libSrc);
  }

  isVisible() { return !!this.win && this.win.isVisible(); }

  async toggle() {
    if (this.isVisible()) { await this.close(); return; }
    await this.show();
  }

  /** Never close over an unsaved edit. Monaco's blur would usually commit it, but "the
   *  window is gone before the request went out" is exactly the case blur does not
   *  cover — so flush first, then hide. */
  async close() {
    await this.commitEditor();
    this.win.hide();
  }

  async show() {
    this.build();
    this.win.show();
    await this.initEditor();
    this.editor?.relayout();
    await this.refresh();
  }

  build() {
    if (this.win) return;
    this.win = makeWindow({
      key: 'xyz.plv3.library',
      title: 'PLv3 Library Manager',
      defaults: { x: 200, y: 120, w: 1020, h: 620 },
      minW: 720,
      minH: 380,
      onResize: () => this.editor?.relayout(),
    });
    this.win.bar.append(iconButton('✕', 'Close', () => this.close()));

    this.treeEl = div(`width:250px;flex-shrink:0;overflow:auto;background:${T.bg2};
      padding:6px 4px;min-width:0;`);
    this.presetEl = div(`width:190px;flex-shrink:0;overflow:auto;background:${T.bg2};
      padding:6px 4px;min-width:0;`);

    const right = div('flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;');
    // Two detail views, one visible at a time: the group's item list, and — for a
    // preset — the main window's detail page over the preset's block text.
    this.detailEl = div('flex:1;min-height:0;overflow:auto;padding:10px 12px;min-width:0;');
    this.presetDetailEl = div('flex:1;min-height:0;min-width:0;display:none;');
    this.editorWrap = div(`display:none;flex-direction:column;height:230px;flex-shrink:0;
      border-top:1px solid ${T.line};min-height:0;`);
    this.editorHead = div(`display:flex;align-items:center;gap:8px;padding:5px 10px;
      background:${T.bg2};flex-shrink:0;`);
    this.editorEl = div('flex:1;min-height:0;');
    this.editorWrap.append(this.editorHead, this.editorEl);

    right.append(
      this.detailEl,
      this.presetDetailEl,
      splitter(this.editorWrap, { dir: 'y', key: 'xyz.plv3.libeditor.h', min: 120, max: 480, invert: true }),
      this.editorWrap,
    );

    this.win.body.append(
      this.treeEl,
      splitter(this.treeEl, { dir: 'x', key: 'xyz.plv3.libtree.w', min: 160, max: 420 }),
      this.presetEl,
      splitter(this.presetEl, { dir: 'x', key: 'xyz.plv3.libpreset.w', min: 140, max: 320 }),
      right,
    );
    this.win.el.addEventListener('plv3:resized', () => this.editor?.relayout());
    // Live-refresh when a library edit lands from anywhere (esp. a node's detail page in
    // the editor window deleting/adding an item in a group this window is showing).
    document.addEventListener('plv3:library-changed', (e) => this.onLibraryChanged(e));
  }

  async initEditor() {
    if (this.editor) return;
    // The same editor as the main window: Monarch grammar, danbooru autocomplete with
    // the wiki links and related tags, `[` library-path completion, squiggles.
    this.editor = new PromptEditor(this.editorEl, {
      // A preset's text is a library block — a positive, unseeded document.
      params: () => ({ seed: 0, region_mode: 'couple', polarity: 'positive' }),
      onAst: (payload, meta) => this.detail?.setAst(payload, null, meta),
      onCompiled: () => {},
      // The library window persists on blur and after every detail-page edit, so it
      // does its own commit (which already syncs) instead of the generic blur-sync.
      syncOnBlur: false,
      onBlur: () => this.commitEditor(),
      onEdited: () => this.saveSoon(),
      options: { fontSize: Math.max(10, settings().fontSize - 1) },
    });
    await this.editor.init();
    this.detail = new DetailPane(this.presetDetailEl, {
      pane: this.editor,
      // A preset is one block: an outline of a single entry is a column of empty space.
      outline: false,
      // ...and you are already inside it: no "load a preset" into the preset you are
      // editing, no "save as preset" next to the list of presets. Edits save themselves.
      presetBar: false,
      // A nested block may FOLLOW a preset of its own (§5.4). Only in here: a link lives
      // in a preset's body, and a document has nowhere to keep one.
      links: {
        get: (path) => this.links[path] ?? null,
        set: (path, presetId) => this.linkTo(path, presetId),
        clear: (path) => this.unlink(path),
      },
      // A preset has no node to hang the weight memory on, so it lives in the preset's
      // body and is persisted whenever the preset is saved (commitEditor). Seeded from the
      // body when a preset is opened (renderEditor), so a disabled item's weight survives
      // the window being closed and reopened.
      memoryStore: {
        load: () => this.presetMem || {},
        save: (dump) => { this.presetMem = dump; this.saveSoon(); },
      },
      emptyText: 'Pick a preset.',
    });
    // The embedded detail page's library edits are OUR edits: share the source token so this
    // window does not treat its own preset-page edits as external and refresh-churn on them.
    this.detail._libSrc = this._libSrc;
    this.presetModel = this.editor.createModel('');
    this.editor.setModel(this.presetModel);
  }

  /** Follow a preset of the nested group from now on.
   *
   *  Linking ADOPTS: the block's text is replaced by what that preset expands to. It has
   *  to be — the block currently shows something else, and the first save would write
   *  THAT through and overwrite the very preset the user just chose to follow. */
  async linkTo(path, presetId) {
    this.links[path] = presetId;
    await this.commitEditor({ force: true });   // stores the link (no write-through yet)
    await this.reloadPresetText();              // ...and adopts the linked contents
  }

  /** Stop following it. The block keeps what is on screen — as its own copy. */
  async unlink(path) {
    delete this.links[path];
    await this.commitEditor({ force: true });
    await this.reloadPresetText();
  }

  /** A detail-page control just rewrote the preset's text. That IS the preset (§8.4.3),
   *  so it has to be stored — but not on every tick of a slider drag. */
  saveSoon() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.commitEditor(), settings().autosaveDelayMs);
  }

  async refresh() {
    this.data = await api.tree();
    this.renderTree();
    if (this.selected) await this.select(this.selected, this.preset?.id);
    else if (this.selectedDoc) await this.selectDoc(this.selectedDoc);
  }

  // --- folding ---
  /** Fold/unfold one row. The key is 'f<id>' for a folder, 'g<id>' for a group. */
  toggleCollapse(key) {
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    saveCollapsed(this.collapsed);
    this.renderTree();
  }

  /** Every row that CAN fold: a folder, or a group that has subgroups. Anything else
   *  would put keys in the set for rows that never show a chevron. */
  collapsibleKeys() {
    const { folders = [], groups = [] } = this.data || {};
    const parents = new Set(groups.filter((g) => g.parent_group_id != null)
      .map((g) => g.parent_group_id));
    return [...folders.map((f) => `f${f.id}`), ...[...parents].map((id) => `g${id}`)];
  }

  collapseAll() {
    this.collapsed = new Set(this.collapsibleKeys());
    saveCollapsed(this.collapsed);
    this.renderTree();
  }

  expandAll() {
    this.collapsed.clear();
    saveCollapsed(this.collapsed);
    this.renderTree();
  }

  // --- folder tree (spec §8.4.1) ---
  // Everything that acts on a row is in its right-click menu, as in PLv2's library
  // window: "right-click the thing" beats "select it, then reach for a button up there".
  // The toolbar carries only what has no row to right-click — creating at the root, and
  // folding the whole tree.
  renderTree() {
    const t = this.treeEl;
    t.replaceChildren();

    const head = div('display:flex;align-items:center;gap:2px;');
    const lbl = sectionLabel('library');
    lbl.style.flex = '1';
    head.append(
      lbl,
      iconButton('⊟', 'Collapse all', () => this.collapseAll()),
      iconButton('⊞', 'Expand all', () => this.expandAll()),
    );
    t.append(head);

    const bar = div('display:flex;gap:4px;padding:0 2px 6px;');
    const addFolder = button('+ folder', { variant: 'quiet', size: 'sm' });
    addFolder.title = 'New folder at the root';
    addFolder.onclick = () => this.createFolder(null);
    const addGroup = button('+ group', { variant: 'quiet', size: 'sm' });
    addGroup.title = 'New group at the root';
    addGroup.onclick = () => this.createGroup({ folder_id: null });
    bar.append(addFolder, addGroup);
    t.append(bar);

    t.oncontextmenu = (e) => {
      if (e.target !== t) return;
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: 'New folder', action: () => this.createFolder(null) },
        { label: 'New group', action: () => this.createGroup({ folder_id: null }) },
      ]);
    };

    const { folders, groups } = this.data;
    const documents = this.data.documents || [];
    const subFolders = (id) => folders.filter((f) => f.parent_id === id);
    const groupsIn = (id) => groups.filter((g) => g.folder_id === id && g.parent_group_id === null);
    const docsIn = (id) => documents.filter((d) => (d.folder_id ?? null) === id);

    // A whole saved prompt: structure, regions, schedules and the items switched off.
    // It is NOT a group — a group is a list of items — so it gets its own row type
    // rather than pretending to be one.
    const renderDoc = (doc, depth) => {
      const row = treeRow({
        depth,
        icon: '▦',
        iconColor: T.good,
        label: doc.name,
        selected: doc.id === this.selectedDoc,
        tail: div(`font-size:${T.fs.micro};color:${T.muted};font-family:${T.mono};`,
          charCount(doc.size)),
      });
      row.onclick = () => this.selectDoc(doc.id);
      row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); this.docMenu(e, doc); };
      t.append(row);
    };

    const renderGroup = (g, depth) => {
      const subs = groups.filter((x) => x.parent_group_id === g.id);
      const key = `g${g.id}`;
      const open = !this.collapsed.has(key);
      const row = treeRow({
        depth,
        // A group's row SELECTS it, so only the chevron folds — and it is only there
        // when there is something under it to fold.
        chevron: subs.length ? (open ? 'open' : 'closed') : null,
        onChevron: subs.length ? () => this.toggleCollapse(key) : null,
        icon: g.parent_group_id ? '↳' : '▤',
        iconColor: g.parent_group_id ? T.muted : T.lib,
        label: g.name,
        selected: g.id === this.selected,
        tail: subs.length
          ? div(`font-size:${T.fs.micro};color:${T.muted};font-family:${T.mono};`, String(subs.length))
          : null,
      });
      row.onclick = () => this.select(g.id);
      row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); this.groupMenu(e, g); };
      t.append(row);
      if (open) for (const sub of subs) renderGroup(sub, depth + 1);
    };

    const renderFolder = (f, depth) => {
      const key = `f${f.id}`;
      const open = !this.collapsed.has(key);
      const kids = groupsIn(f.id);
      const subs = subFolders(f.id);
      const docs = docsIn(f.id);
      const row = treeRow({
        depth,
        // The chevron is the fold state — so the icon must NOT be a second triangle.
        // A folder is an empty container; a group (▤) is one with contents.
        chevron: open ? 'open' : 'closed',
        icon: '□',
        iconColor: T.accent,
        label: f.name,
        tail: kids.length + subs.length + docs.length
          ? div(`font-size:${T.fs.micro};color:${T.muted};font-family:${T.mono};`,
            String(kids.length + subs.length + docs.length))
          : null,
      });
      // A folder has nothing to select, so the whole row folds it.
      row.onclick = () => this.toggleCollapse(key);
      row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); this.folderMenu(e, f); };
      t.append(row);
      if (!open) return;
      for (const g of kids) renderGroup(g, depth + 1);
      for (const doc of docs) renderDoc(doc, depth + 1);
      for (const sub of subs) renderFolder(sub, depth + 1);
    };

    for (const f of subFolders(null)) renderFolder(f, 0);
    for (const g of groupsIn(null)) renderGroup(g, 0);
    for (const doc of docsIn(null)) renderDoc(doc, 0);
    t.append(div('height:60px;')); // right-clickable empty space = the root
  }

  folderMenu(e, f) {
    showContextMenu(e.clientX, e.clientY, [
      { label: 'New sub-folder', action: () => this.createFolder(f.id) },
      { label: 'New group', action: () => this.createGroup({ folder_id: f.id }) },
      { separator: true },
      { label: 'Rename…', action: () => this.renameFolder(f) },
      { label: 'Move to…', submenu: () => this.folderTargets((x) => this.moveFolder(f, x), f.id) },
      { separator: true },
      { label: 'Delete', danger: true, action: () => this.deleteFolder(f) },
    ]);
  }

  groupMenu(e, g) {
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Insert into editor', action: () => this.insert(g.id) },
      { separator: true },
      { label: 'New subgroup', action: () => this.createGroup({ parent_group_id: g.id }) },
      { label: 'Rename…', action: () => this.renameGroup(g) },
      {
        label: 'Move to…',
        submenu: () => [
          ...this.folderTargets((x) => this.moveGroup(g, { folder_id: x })),
          { separator: true },
          ...this.data.groups
            .filter((x) => x.id !== g.id && !this.isDescendant(x.id, g.id))
            .map((x) => ({
              label: `↳ under ${x.path}`,
              action: () => this.moveGroup(g, { parent_group_id: x.id }),
            })),
        ],
      },
      { separator: true },
      { label: 'Delete', danger: true, action: () => this.deleteGroup(g) },
    ]);
  }

  docMenu(e, doc) {
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Load into the active node', action: () => this.selectDoc(doc.id).then(() => this.loadDocument()) },
      { separator: true },
      { label: 'Rename…', action: () => this.renameDocument(doc) },
      { label: 'Move to…', submenu: () => this.folderTargets((x) => this.moveDocument(doc, x)) },
      { separator: true },
      { label: 'Delete', danger: true, action: () => this.deleteDocument(doc) },
    ]);
  }

  folderTargets(action, exclude = null) {
    const banned = new Set();
    if (exclude != null) {
      const walk = (id) => {
        banned.add(id);
        for (const f of this.data.folders.filter((x) => x.parent_id === id)) walk(f.id);
      };
      walk(exclude);
    }
    return [
      { label: '(root)', action: () => action(null) },
      ...this.data.folders.filter((f) => !banned.has(f.id))
        .map((f) => ({ label: `▸ ${this.folderPath(f)}`, action: () => action(f.id) })),
    ];
  }

  folderPath(f) {
    const parts = [f.name];
    let p = f.parent_id;
    while (p != null) {
      const parent = this.data.folders.find((x) => x.id === p);
      if (!parent) break;
      parts.unshift(parent.name);
      p = parent.parent_id;
    }
    return parts.join('.');
  }

  isDescendant(candidate, groupId) {
    let node = this.data.groups.find((g) => g.id === candidate);
    while (node) {
      if (node.id === groupId) return true;
      node = this.data.groups.find((g) => g.id === node.parent_group_id);
    }
    return false;
  }

  // --- tree operations ---
  async createFolder(parentId) {
    const name = await showPrompt('New folder name:');
    if (!name) return;
    this.reveal(parentId != null ? `f${parentId}` : null);
    await this.guard(() => api.createFolder(name, parentId));
  }

  async createGroup(where) {
    const name = await showPrompt(where.parent_group_id ? 'New subgroup name:' : 'New group name:');
    if (!name) return;
    if (where.parent_group_id != null) this.reveal(`g${where.parent_group_id}`);
    else if (where.folder_id != null) this.reveal(`f${where.folder_id}`);
    await this.guard(() => api.createGroup({ name, ...where }));
  }

  /** Unfold a row, so something just created inside it is actually on screen. */
  reveal(key) {
    if (!key || !this.collapsed.delete(key)) return;
    saveCollapsed(this.collapsed);
  }

  async renameFolder(f) {
    const name = await showPrompt(`Rename folder "${f.name}" to:`, f.name);
    if (name && name !== f.name) await this.guard(() => api.call('PATCH', `/folders/${f.id}`, { name }));
  }

  async renameGroup(g) {
    const name = await showPrompt(`Rename group "${g.name}" to:`, g.name);
    if (name && name !== g.name) await this.guard(() => api.updateGroup(g.id, { name }));
  }

  async moveFolder(f, parentId) {
    await this.guard(() => api.call('PATCH', `/folders/${f.id}`, { parent_id: parentId }));
  }

  async moveGroup(g, where) {
    await this.guard(() => api.call('POST', `/groups/${g.id}/move`, where));
  }

  async deleteFolder(f) {
    const ok = await showConfirm(
      `Delete folder "${f.name}"?\n\nEverything inside it — sub-folders, groups, their items — goes with it.`,
      { okLabel: 'Delete', danger: true });
    if (ok) await this.guard(() => api.deleteFolder(f.id));
  }

  async deleteGroup(g) {
    const ok = await showConfirm(
      `Delete group "${g.name}"?\n\nIts items, subgroups and presets go with it. Documents that ` +
      `already expanded it keep their text — they never point at the library.`,
      { okLabel: 'Delete', danger: true });
    if (!ok) return;
    if (this.selected === g.id) { this.selected = null; this.preset = null; }
    await this.guard(() => api.deleteGroup(g.id));
  }

  async renameDocument(doc) {
    const name = await showPrompt(`Rename the document “${doc.name}” to:`, doc.name);
    if (!name || name === doc.name) return;
    await this.guard(() => api.updateDocument(doc.id, { name }));
  }

  async moveDocument(doc, folderId) {
    await this.guard(() => api.updateDocument(doc.id, { folder_id: folderId }));
  }

  async deleteDocument(doc) {
    const ok = await showConfirm(
      `Delete the saved document “${doc.name}”?\n\nThe groups it references stay where ` +
      `they are — a document never owns them.`,
      { okLabel: 'Delete', danger: true });
    if (!ok) return;
    if (this.selectedDoc === doc.id) { this.selectedDoc = null; this.docRow = null; }
    await this.guard(() => api.deleteDocument(doc.id));
  }

  /** Hand the selected document to whoever knows which node is open. */
  loadDocument() {
    if (!this.docRow) return;
    if (!this.onLoadDocument) {
      toast('Open the PLv3 editor window first — a document is loaded into a node.', 'error');
      return;
    }
    this.onLoadDocument(this.docRow);
  }

  async insert(groupId, presetId) {
    const { text } = await api.expand({ group_id: groupId, preset_id: presetId });
    this.onInsert?.(text);
  }

  async guard(fn) {
    try { await fn(); }
    catch (err) { toast(err.message, 'error'); return; }
    await this.refresh();
    this.notifyChanged();   // a group/folder changed — editor detail pages may show it
  }

  // --- selection ---
  async select(groupId, presetId = null) {
    // Leaving a preset saves it. Not "usually, if the blur landed first" — the editor
    // is about to be handed different text, and a pending 400 ms autosave would then
    // write the text of the preset the user just left into the one they just opened.
    await this.commitEditor();

    this.selectedDoc = null;
    this.docRow = null;
    this.selected = groupId;
    this.current = await api.group(groupId);
    this.preset = presetId
      ? this.current.presets.find((p) => p.id === presetId) || null
      : null;
    this.renderTree();
    this.renderPresets();
    this.renderDetail();
    await this.renderEditor();
  }

  /** A saved document is not a group: no items, no presets, no two-way editor. It is a
   *  snapshot you load into a node — so it gets a read-only page, and the columns that
   *  only make sense for a group stand down. */
  async selectDoc(id) {
    await this.commitEditor();
    this.selected = null;
    this.preset = null;
    this.current = null;
    this.selectedDoc = id;
    try {
      this.docRow = await api.getDocument(id);
    } catch (err) {
      this.selectedDoc = null;
      this.docRow = null;
      toast(err.message, 'error');
    }
    this.renderTree();
    this.renderPresets();
    this.renderDetail();
    await this.renderEditor();
  }

  renderPresets() {
    const p = this.presetEl;
    p.replaceChildren();
    if (!this.current) {
      p.append(sectionLabel('views'));
      p.append(div(`font-size:${T.fs.micro};color:${T.muted};padding:2px 8px;line-height:1.5;`,
        this.selectedDoc ? 'a saved document has no presets — it IS one snapshot' : 'pick a group'));
      return;
    }
    p.append(sectionLabel('views'));
    const { group, presets } = this.current;

    const self = treeRow({
      icon: '▤',
      iconColor: T.lib,
      label: group.name,
      selected: !this.preset,
    });
    self.onclick = () => this.select(this.selected, null);
    p.append(self);

    p.append(sectionLabel('presets'));
    if (!presets.length) {
      p.append(div(`font-size:${T.fs.micro};color:${T.muted};padding:2px 8px;`, 'none yet'));
    }
    for (const preset of presets) {
      const row = treeRow({
        icon: '◆',
        iconColor: T.accent,
        label: preset.name,
        selected: this.preset?.id === preset.id,
        tail: iconButton('✕', 'Delete preset', async () => {
          const ok = await showConfirm(`Delete the preset “${preset.name}”?`,
            { okLabel: 'Delete', danger: true });
          if (!ok) return;
          await api.deletePreset(preset.id);
          await this.select(this.selected, null);
        }),
      });
      row.onclick = () => this.select(this.selected, preset.id);
      row.oncontextmenu = (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          {
            // Only meaningful while a preset is open in the editor: "the block as it is
            // now" is the text, and the text is what a preset is.
            label: 'Overwrite with the current text',
            action: () => this.overwritePreset(preset),
          },
          { label: 'Rename…', action: () => this.renamePreset(preset) },
          { separator: true },
          { label: 'Delete', danger: true, action: async () => {
            const ok = await showConfirm(`Delete the preset “${preset.name}”?`,
              { okLabel: 'Delete', danger: true });
            if (!ok) return;
            await api.deletePreset(preset.id);
            await this.select(this.selected, null);
          } },
        ]);
      };
      p.append(row);
    }

    const add = button('+ preset', { variant: 'quiet', size: 'sm' });
    add.style.margin = '6px 4px';
    add.onclick = () => this.newPreset();
    p.append(add);
  }

  /** A new preset: everything the group has, on, in the group's own order. */
  async newPreset() {
    const name = await showPrompt('New preset — a snapshot of the group as it is now:');
    if (!name) return;
    // The backend upserts by (group, name), so a name that already exists REPLACES
    // that preset. Say so before it happens, rather than after it is gone.
    if (this.current.presets.some((p) => p.name === name)) {
      const ok = await showConfirm(
        `This group already has a preset called “${name}”.\n\nSaving replaces it.`,
        { okLabel: 'Replace', danger: true });
      if (!ok) return;
    }
    try {
      await api.call('POST', '/presets', {
        group_id: this.selected,
        name,
        body: {
          items: this.current.items.map((i) => i.id),   // a fresh preset has it all on
          settings: this.current.group.settings || {},
          children: {},
        },
      });
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    await this.select(this.selected, null);
  }

  /** Overwrite a preset with what is in the editor right now. */
  async overwritePreset(preset) {
    if (!this.preset || this.preset.id !== preset.id) {
      // Overwriting from the text means overwriting with THIS preset's text; if it is
      // not the one open, there is no "current text" that belongs to it.
      toast(`Open “${preset.name}” first — a preset is overwritten with its own text.`, 'error');
      return;
    }
    const ok = await showConfirm(
      `Overwrite the preset “${preset.name}” with the text as it is now?`,
      { okLabel: 'Overwrite' });
    if (!ok) return;
    this.editorText = null;      // force the commit, even if nothing changed since load
    await this.commitEditor();
    toast(`Preset “${preset.name}” overwritten.`);
  }

  async renamePreset(preset) {
    const name = await showPrompt(`Rename the preset “${preset.name}” to:`, preset.name);
    if (!name || name === preset.name) return;
    if (this.current.presets.some((p) => p.name === name)) {
      toast(`This group already has a preset called “${name}”.`, 'error');
      return;
    }
    // The preset table upserts by name, so a rename is: save the same body under the
    // new name, then drop the old row.
    try {
      await api.call('POST', '/presets', {
        group_id: this.selected, name, body: preset.body,
      });
      await api.deletePreset(preset.id);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    await this.select(this.selected, null);
  }

  // --- detail ---
  renderDetail() {
    // A preset IS a block of text, so it gets the document detail page — the same
    // component, the same unified enable/disable list, the same settings controls.
    const isDoc = !!this.selectedDoc;
    const isPreset = !isDoc && !!this.preset;
    this.detailEl.style.display = isPreset ? 'none' : 'block';
    this.presetDetailEl.style.display = isPreset ? 'flex' : 'none';
    this.editorWrap.style.display = isPreset ? 'flex' : 'none';
    if (isPreset) return;
    if (isDoc) { this.renderDocumentDetail(); return; }
    if (!this.current) { this.detailEl.replaceChildren(); return; }

    const d = this.detailEl;
    d.replaceChildren();
    const { group } = this.current;

    const head = div('display:flex;align-items:center;gap:10px;margin-bottom:10px;min-width:0;');
    head.append(div(`flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
      font-size:14px;font-weight:600;color:${T.text};`, group.path));
    const ins = button('↵ insert into editor', { variant: 'primary', size: 'sm' });
    ins.onclick = () => this.insert(group.id, this.preset?.id);
    head.append(ins);
    d.append(head);

    this.renderGroupItems(d);
  }

  /** A saved document: read-only, and deliberately so.
   *
   *  Editing it here would mean answering "does this change belong to the snapshot or to
   *  the node it came from?", and there is no good answer. Load it into a node, edit it
   *  there, save it again — the same round trip a preset makes. */
  renderDocumentDetail() {
    const d = this.detailEl;
    d.replaceChildren();
    const row = this.docRow;
    if (!row) return;

    const head = div('display:flex;align-items:center;gap:10px;margin-bottom:4px;min-width:0;');
    head.append(div(`flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
      font-size:14px;font-weight:600;color:${T.text};`, `▦ ${row.name}`));
    const load = button('⇥ load into the active node', { variant: 'primary', size: 'sm' });
    load.title = 'Replace the open node’s document with this one';
    load.onclick = () => this.loadDocument();
    head.append(load);
    d.append(head);

    const parked = countParked(row.doc_json);
    d.append(div(`font-size:${T.fs.micro};color:${T.muted};margin-bottom:10px;`, [
      `${row.text.length} characters`,
      row.updated_at ? `saved ${new Date(row.updated_at * 1000).toLocaleString()}` : null,
      // The whole reason the doc JSON is stored next to the text: these items are
      // nowhere in the text, and a text-only snapshot would have lost them.
      parked ? `${parked} item${parked === 1 ? '' : 's'} switched off` : null,
    ].filter(Boolean).join(' · ')));

    d.append(sectionLabel('the document, as it was saved'));
    const pre = el('pre', `background:${T.bg0};border:1px solid ${T.edge};
      border-radius:${T.radiusSm};color:${T.text};font-family:${T.mono};
      font-size:${T.fs.label};line-height:1.5;padding:8px 10px;margin:0;
      white-space:pre-wrap;word-break:break-word;`);
    pre.textContent = row.text;
    d.append(pre);
  }

  // --- saving into the library ------------------------------------------------

  /** "Where does it go, and what is it called?" — one dialog, both kinds of save.
   *
   *  A dropdown rather than a context menu of folders: a menu that is dismissed resolves
   *  nothing, and an await on it would hang for the rest of the session. */
  async askDestination(message, { initial = '', okLabel = 'Save' } = {}) {
    const options = [
      { value: '', label: '(root)' },
      ...this.data.folders.map((f) => ({ value: f.id, label: this.folderPath(f) })),
    ];
    const out = await showForm(message, [
      { key: 'name', label: 'Name', value: initial, placeholder: 'what to call it' },
      { key: 'folder', label: 'Folder', options },
    ], { okLabel });
    if (!out) return null;
    const name = (out.name || '').trim();
    if (!name) return null;
    return { name, folder_id: out.folder === '' ? null : Number(out.folder) };
  }

  /** Save a whole document — text AND the doc JSON, so the items switched off come too. */
  async saveDocument({ text, doc, suggested = '' }) {
    if (!String(text || '').trim()) {
      toast('Nothing to save — that document is empty.', 'error');
      return;
    }
    try {
      this.data = await api.tree();
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    const dest = await this.askDestination(
      'Save the whole prompt — groups, regions, schedules, the text between them, and the '
      + 'items you switched off.',
      { initial: suggested, okLabel: 'Save' });
    if (!dest) return;

    // The backend replaces by (folder, name). Say so before it happens, not after.
    const clash = (this.data.documents || []).find(
      (x) => x.name === dest.name && (x.folder_id ?? null) === dest.folder_id);
    if (clash) {
      const ok = await showConfirm(
        `A document called “${dest.name}” is already saved there.\n\nSaving replaces it.`,
        { okLabel: 'Replace', danger: true });
      if (!ok) return;
    }
    try {
      await api.saveDocument({ ...dest, text, doc: doc || '' });
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    toast(`Saved the document “${dest.name}”.`);
    if (this.isVisible()) await this.refresh();
  }

  /** Save a chunk of a document as a NEW library group.  Returns the `[path]: { … }`
   *  block that should replace it in the text, or null if nothing was created. */
  async saveSelectionAsGroup(text) {
    if (!String(text || '').trim()) {
      toast('Select some prompt text first.', 'error');
      return null;
    }
    try {
      this.data = await api.tree();
    } catch (err) {
      toast(err.message, 'error');
      return null;
    }
    const dest = await this.askDestination(
      'Save the selection as a new library group. The selected text is replaced by a '
      + 'reference to it, so the document and the library stay the same thing.',
      { okLabel: 'Create' });
    if (!dest) return null;

    // Groups do NOT upsert by name — and at the root SQLite would not even reject the
    // duplicate (NULL folder_id defeats the UNIQUE). So the check has to happen here.
    const clash = this.data.groups.find(
      (g) => g.name === dest.name && (g.folder_id ?? null) === dest.folder_id
        && g.parent_group_id === null);
    if (clash) {
      toast(`A group called “${dest.name}” already lives there.`, 'error');
      return null;
    }
    let res;
    try {
      res = await api.groupFromText({ ...dest, text });
    } catch (err) {
      toast(err.message, 'error');
      return null;
    }
    toast(`Created [${res.path}] — the selection now references it.`);
    if (this.isVisible()) await this.refresh();
    this.notifyChanged(res.path);
    return res.text;
  }

  /** The group itself: WHAT IT CONTAINS.  No enable state exists here (§5.2). */
  renderGroupItems(d) {
    const { group, items } = this.current;
    d.append(sectionLabel(`items — ${items.length}`));

    for (const item of items) {
      const row = div('display:flex;align-items:center;gap:8px;margin:3px 0;min-width:0;');
      if (item.kind === 'ref') {
        row.append(div(`flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
          font-size:${T.fs.body};color:${T.lib};`, `→ [${item.ref_path}]`));
      } else {
        const box = input(item.text, { mono: item.kind === 'lora' });
        if (item.kind !== 'lora') attachAC(box);
        box.onchange = async () => {
          await api.updateItem(item.id, { text: cleanItem(box.value) });
          await this.select(this.selected, this.preset?.id);
          this.notifyChanged(group.path);
        };
        row.append(box);
        const w = numberBox(item.weight ?? 1, async (v) => {
          await api.updateItem(item.id, { weight: v });
          await this.select(this.selected, this.preset?.id);
          this.notifyChanged(group.path);
        });
        row.append(w);
      }
      row.append(iconButton('✕', 'Delete from the library', async () => {
        await api.deleteItem(item.id);
        await this.select(this.selected, this.preset?.id);
        this.notifyChanged(group.path);
      }));
      d.append(row);
    }

    const add = div('display:flex;gap:8px;margin-top:10px;min-width:0;');
    const box = input('', { placeholder: 'new item — Enter to add' });
    attachAC(box);
    const commit = async () => {
      const parts = splitItems(box.value);
      if (!parts.length) return;
      box.value = '';
      for (const text of parts) {
        await api.addItem(group.id, { text, kind: text.startsWith('<lora:') ? 'lora' : 'prompt' })
          .catch((e) => toast(e.message, 'error'));
      }
      await this.select(this.selected, this.preset?.id);
      this.notifyChanged(group.path);
    };
    // Enter adds — unless autocomplete just consumed it to pick a tag (its keydown runs
    // first and calls preventDefault on a commit). The + button always adds.
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.defaultPrevented) return;
      e.preventDefault();
      commit();
    });
    add.append(box);
    const addBtn = button('+', { variant: 'quiet', size: 'sm' });
    addBtn.title = 'Add this item to the group';
    addBtn.onclick = commit;
    add.append(addBtn);

    const ref = el('select', `background:${T.bg0};border:1px solid ${T.edge};
      border-radius:${T.radiusSm};color:${T.text};font-size:${T.fs.label};max-width:200px;
      padding:3px 6px;`);
    ref.append(el('option', '', '+ reference a group…'));
    for (const g of this.data.groups) {
      if (g.id === group.id) continue;
      const o = el('option', '', g.path);
      o.value = String(g.id);
      ref.append(o);
    }
    ref.onchange = async () => {
      if (!ref.value) return;
      try {
        await api.addItem(group.id, { kind: 'ref', ref_group_id: Number(ref.value) });
      } catch (err) {
        // Spec §5.5 layer 1: the library never gets to contain a loop.
        toast(`Cannot add that reference — ${err.message}`, 'error');
      }
      ref.value = '';
      await this.select(this.selected, this.preset?.id);
      this.notifyChanged(group.path);
    };
    add.append(ref);
    d.append(add);

    this.editorWrap.style.display = 'none'; // a group has no text to be two-way with
  }

  /** A preset is a `[path]: { … }` block of text (§8.4.3), and the text IS its enable
   *  list. So load that block into the editor and let the detail page — the same one
   *  the main window uses — do the rest: switches per item, weights, settings, order. */
  async renderEditor() {
    if (!this.editor || !this.current) return;
    if (!this.preset) {
      this.links = {};
      this.presetMem = {};
      this.detail?.resetMemory();
      this.detail?.clear();
      return;
    }
    // Which nested blocks does this preset FOLLOW? The body keys them by ref-item id;
    // the server hands back the paths, which is what the UI thinks in.
    this.links = { ...(this.preset.links || {}) };
    // The remembered weights for this preset's disabled items — drop the detail page's
    // cached copy so it reloads from THIS preset's body, not the last one's.
    this.presetMem = { ...(this.preset.body?.weight_memory || {}) };
    this.detail?.resetMemory();
    await this.reloadPresetText();
  }

  /** Pull the preset's text back out of the library and put it on screen. Used when the
   *  preset is opened, and after a link changes — because linking ADOPTS the linked
   *  preset's contents, so the block's text is no longer what it was. */
  async reloadPresetText() {
    const { text } = await api.expand({
      group_id: this.current.group.id,
      preset_id: this.preset.id,
    });
    this.editorText = text;
    this.editor.setText(text);
    this.editor.relayout();
    this.editor.lintNow();      // feeds the detail page its AST
    this.renderEditorHead('saved');
  }

  /** There is no save button in here: a preset IS its text, and the text is edited in
   *  place. So the header has to answer the only question that leaves — "did that get
   *  stored?" — without being asked. */
  renderEditorHead(state) {
    if (!this.preset) return;
    const chip = {
      saved: ['saved', T.good, tint(T.good, .10)],
      saving: ['saving…', T.warn, tint(T.warn, .12)],
      error: ['not saved', T.bad, tint(T.bad, .12)],
    }[state] || ['saved', T.good, tint(T.good, .10)];

    const ins = button('↵ insert into editor', { variant: 'quiet', size: 'sm' });
    ins.onclick = () => this.insert(this.current.group.id, this.preset.id);

    this.editorHead.replaceChildren(
      div(`font-size:${T.fs.label};font-weight:600;color:${T.label};flex:1;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`,
        `◆ ${this.preset.name} — the text is the preset`),
      div(`font-size:${T.fs.micro};color:${chip[1]};background:${chip[2]};
        padding:2px 6px;border-radius:${T.radiusSm};flex-shrink:0;`, chip[0]),
      ins,
    );
  }

  /** Store what is in the editor as the preset. Typing gets here on blur; a detail-page
   *  control gets here through `saveSoon`. Both write the same thing: the text. */
  async commitEditor({ force = false } = {}) {
    clearTimeout(this._saveTimer);
    if (!this.editor || !this.current || !this.preset) return;
    const text = this.editor.text();
    if (!text.trim()) return;
    // `force`: a link was made or broken. The TEXT did not change, but what the preset
    // MEANS did, so the usual "nothing to do, the text is the same" shortcut is wrong.
    if (!force && text === this.editorText) return;
    this.editorText = text;
    this.renderEditorHead('saving');
    let res;
    try {
      await api.sync(text); // items typed in that the group lacks are appended (§5.3)
      res = await api.savePreset({
        text,
        path: this.current.group.path,
        name: this.preset.name,
        links: this.links,   // which nested blocks follow a preset of their own (§5.4)
        weight_memory: this.presetMem || {},  // disabled items' remembered weights
      });
    } catch (err) {
      this.renderEditorHead('error');
      toast(`Could not save the preset — ${err.message}`, 'error');
      return;
    }
    this.renderEditorHead('saved');
    // An edit inside a LINKED block went into the preset it follows — which everything
    // else that follows it now sees too. Do not let that happen quietly.
    for (const path of res.written_through || []) {
      toast(`Saved into the shared preset of [${path}] — everything that follows it changed.`);
    }
    // The group may have just grown; the detail page's enable/disable list is drawn from
    // it, and an item it does not know about would vanish instead of turning off.
    this.detail?.invalidateLibrary([this.current.group.path, ...(res.written_through || [])]);
    this.current = await api.group(this.selected);
    this.preset = this.current.presets.find((p) => p.id === this.preset.id) || this.preset;
    this.renderPresets();
    // A blur-sync may have appended items to the group — tell the editor window's detail
    // pages, whose enable/disable lists are drawn from it.
    this.notifyChanged(this.current.group.path);
  }
}

// The folded rows survive the window being closed — and a corrupt/absent entry is just
// "nothing is folded", never a tree that fails to draw.
function loadCollapsed() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch { return new Set(); }
}

// A saved document's size, for the tree row. Characters, not bytes — it is a prompt.
function charCount(size) {
  const n = Number(size) || 0;
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

// How many items the snapshot has switched OFF. They are nowhere in the text — that is
// the whole point of storing the doc JSON — so this is the only way to see they exist.
function countParked(docJson) {
  if (!docJson) return 0;
  let root;
  try { root = JSON.parse(docJson)?.root; } catch { return 0; }
  let n = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.enabled === false) n += 1;
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  return n;
}

function saveCollapsed(set) {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch { /* private mode */ }
}

// Danbooru autocomplete on a library detail-page text box (same bridge as the editor):
// tags-only PLv3 text, click a token for its related tags.
function attachAC(el) {
  try { window.xyzTagAC?.attach(el, { tagsOnly: true, related: true }); } catch { /* AC off */ }
}

// A single item never carries a leading/trailing comma — strip one autocomplete/paste left.
function cleanItem(v) {
  return String(v).replace(/^[\s,]+/, '').replace(/[\s,]+$/, '');
}

// Split typed text into items, exactly the way the lexer does (lexer.is_stop):
//
//   `,`  always separates, and is dropped — it is punctuation between items.
//   `.`  separates only when whitespace or the end follows, and it STAYS with the item
//        it ends — it is part of what the user wrote.
//
// So `tag1, tag2. tag3.` is `tag1`, `tag2.`, `tag3.`, and `0.5` or `a.b` is one item.
function splitItems(v) {
  const src = String(v);
  const out = [];
  let start = 0;
  for (let i = 0; i < src.length; i += 1) {
    const stop = src[i] === '.' && (i + 1 >= src.length || /\s/.test(src[i + 1]));
    if (src[i] !== ',' && !stop) continue;
    const piece = src.slice(start, stop ? i + 1 : i).trim();
    if (piece) out.push(piece);
    start = i + 1;
  }
  const tail = src.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function numberBox(value, onCommit) {
  const i = input(String(value));
  i.type = 'number';
  i.step = '0.05';
  i.style.flex = '0 0 68px';
  i.style.width = '68px';
  i.onchange = () => onCommit(Number(i.value) || 1);
  return i;
}

export const libraryWindow = new LibraryWindow();
