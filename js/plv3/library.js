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

import { DetailPane } from './detail.js';
import { PromptEditor } from './editor_core.js';
import { settings } from './settings.js';
import {
  T, button, div, el, iconButton, input, makeWindow, sectionLabel, splitter, treeRow,
} from './theme.js';
import { showConfirm, showContextMenu, showPrompt, toast } from './ui.js';

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
};

class LibraryWindow {
  constructor() {
    this.win = null;
    this.selected = null;  // group id
    this.preset = null;    // the selected preset, or null = "the group itself"
    this.onInsert = null;  // set by window.js
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
      title: 'PLv3 Library',
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
      emptyText: 'Pick a preset.',
    });
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
  }

  // --- folder tree (spec §8.4.1) ---
  // Every operation is in the right-click menu, as in PLv2's library window: a
  // permanent toolbar needs a selection to act on, and "select, then reach for a
  // button up there" fits a tree far worse than "right-click the thing".
  renderTree() {
    const t = this.treeEl;
    t.replaceChildren();
    t.append(sectionLabel('library'));
    t.oncontextmenu = (e) => {
      if (e.target !== t) return;
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: 'New folder', action: () => this.createFolder(null) },
        { label: 'New group', action: () => this.createGroup({ folder_id: null }) },
      ]);
    };

    const { folders, groups } = this.data;
    const subFolders = (id) => folders.filter((f) => f.parent_id === id);
    const groupsIn = (id) => groups.filter((g) => g.folder_id === id && g.parent_group_id === null);

    const renderGroup = (g, depth) => {
      const subs = groups.filter((x) => x.parent_group_id === g.id);
      const row = treeRow({
        depth,
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
      for (const sub of subs) renderGroup(sub, depth + 1);
    };

    const renderFolder = (f, depth) => {
      const row = treeRow({
        depth,
        chevron: 'open',
        icon: '▸',
        iconColor: T.accent,
        label: f.name,
      });
      row.style.cursor = 'default';
      row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); this.folderMenu(e, f); };
      t.append(row);
      for (const g of groupsIn(f.id)) renderGroup(g, depth + 1);
      for (const sub of subFolders(f.id)) renderFolder(sub, depth + 1);
    };

    for (const f of subFolders(null)) renderFolder(f, 0);
    for (const g of groupsIn(null)) renderGroup(g, 0);
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
    if (name) await this.guard(() => api.createFolder(name, parentId));
  }

  async createGroup(where) {
    const name = await showPrompt(where.parent_group_id ? 'New subgroup name:' : 'New group name:');
    if (name) await this.guard(() => api.createGroup({ name, ...where }));
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

  async insert(groupId, presetId) {
    const { text } = await api.expand({ group_id: groupId, preset_id: presetId });
    this.onInsert?.(text);
  }

  async guard(fn) {
    try { await fn(); }
    catch (err) { toast(err.message, 'error'); return; }
    await this.refresh();
  }

  // --- selection ---
  async select(groupId, presetId = null) {
    // Leaving a preset saves it. Not "usually, if the blur landed first" — the editor
    // is about to be handed different text, and a pending 400 ms autosave would then
    // write the text of the preset the user just left into the one they just opened.
    await this.commitEditor();

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

  renderPresets() {
    const p = this.presetEl;
    p.replaceChildren();
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
    if (!this.current) return;

    // A preset IS a block of text, so it gets the document detail page — the same
    // component, the same unified enable/disable list, the same settings controls.
    const isPreset = !!this.preset;
    this.detailEl.style.display = isPreset ? 'none' : 'block';
    this.presetDetailEl.style.display = isPreset ? 'flex' : 'none';
    this.editorWrap.style.display = isPreset ? 'flex' : 'none';
    if (isPreset) return;

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
        box.onchange = async () => {
          await api.updateItem(item.id, { text: box.value.trim() });
          await this.select(this.selected, this.preset?.id);
        };
        row.append(box);
        const w = numberBox(item.weight ?? 1, async (v) => {
          await api.updateItem(item.id, { weight: v });
          await this.select(this.selected, this.preset?.id);
        });
        row.append(w);
      }
      row.append(iconButton('✕', 'Delete from the library', async () => {
        await api.deleteItem(item.id);
        await this.select(this.selected, this.preset?.id);
      }));
      d.append(row);
    }

    const add = div('display:flex;gap:8px;margin-top:10px;min-width:0;');
    const box = input('', { placeholder: 'new item — Enter to add' });
    const commit = async () => {
      const text = box.value.trim();
      if (!text) return;
      await api.addItem(group.id, { text, kind: text.startsWith('<lora:') ? 'lora' : 'prompt' })
        .catch((e) => toast(e.message, 'error'));
      box.value = '';
      await this.select(this.selected, this.preset?.id);
    };
    box.onkeydown = (e) => e.key === 'Enter' && commit();
    add.append(box);

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
      this.detail?.clear();
      return;
    }
    // Which nested blocks does this preset FOLLOW? The body keys them by ref-item id;
    // the server hands back the paths, which is what the UI thinks in.
    this.links = { ...(this.preset.links || {}) };
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
      saved: [`saved`, T.good, 'rgba(166,227,161,.10)'],
      saving: ['saving…', T.warn, 'rgba(249,226,175,.12)'],
      error: ['not saved', T.bad, 'rgba(243,139,168,.12)'],
    }[state] || ['saved', T.good, 'rgba(166,227,161,.10)'];

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
  }
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
