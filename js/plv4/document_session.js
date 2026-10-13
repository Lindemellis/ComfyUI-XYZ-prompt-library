// One editing history for syntax, Block UI and details. No editor-owned seed.
// The host retains one session per workflow node / Library block.
const clone = value => JSON.parse(JSON.stringify(value));

export class SessionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export async function documentRequest(operation, body) {
  const response = await fetch(`/xyz/plv4/document/${operation}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new SessionError(payload.code, payload.error);
  return payload;
}

export class DocumentSession {
  constructor(opened, { request = documentRequest, historyLimit = 100 } = {}) {
    this.request = request;
    this.state = clone(opened.state);
    this.projection = clone(opened.projection);
    this.historyLimit = historyLimit;
    this.past = [];
    this.future = [];
    this.listeners = new Set();
    this.draftFlushers = new Set();
    this.view = 'block';
    this.viewState = new Map();
    this._queue = Promise.resolve();
    this._disposed = false;
    this._idFloor = this.state.doc.next_id;
  }

  static async open(body, options = {}) {
    const request = options.request ?? documentRequest;
    return new DocumentSession(await request('open', body), { ...options, request });
  }

  get revision() { return this.state.revision; }
  get text() { return this.state.text; }
  get valid() { return this.state.valid; }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  whenIdle() { return this._queue; }
  async flushDrafts() { for (const flush of this.draftFlushers) await flush(); }

  _selectionFor(id) {
    const tree = this.projection.tree;
    if (this.selectionTree !== tree) {
      this.selectionTree = tree; this.selectionRows = new Map();
      const visit = row => { if (!row) return; this.selectionRows.set(row.id, row); row.children.forEach(visit); }; visit(tree);
    }
    const node = this.selectionRows.get(id); if (!node) return null;
    let block = node;
    while (block.parent_id != null) {
      const settings = block.settings || {};
      const prompt = block.meta?.presentation === 'prompt' && block.form === 'brace' && block.children.length === 1 && block.children[0].enabled
        && (block.children[0].kind !== 'group' || block.children[0].form === 'paren')
        && !settings.region && !settings.format && !settings.shuffle && !settings.random_select && !settings.dropout && settings.seed == null;
      if (block.kind === 'group' && block.form !== 'paren' && !prompt) break;
      block = this.selectionRows.get(block.parent_id); if (!block) return null;
    }
    return { node_id: node.id, block_id: block.id, prompt_id: block === node ? null : node.id };
  }

  locate(id) {
    if (this._disposed) throw new SessionError('disposed', 'editing session has been disposed');
    const selection = this._selectionFor(id);
    if (!selection) throw new SessionError('unknown_node', '目标已经移除');
    const previous = this.state.selection;
    if (previous.node_id === selection.node_id && previous.block_id === selection.block_id && previous.prompt_id === selection.prompt_id) return;
    this.state.selection = selection;
    this.selectionEpoch = (this.selectionEpoch || 0) + 1;
    this._emit('LocateDetails');
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _emit(reason, edit = null) {
    for (const listener of this.listeners) listener({ reason, edit, session: this });
  }

  _snapshot() { return clone({ state: this.state, projection: this.projection }); }

  _enqueue(action) {
    const run = this._queue.then(() => {
      if (this._disposed) throw new SessionError('disposed', 'editing session has been disposed');
      return action();
    });
    this._queue = run.catch(() => {});
    return run;
  }

  dispatch(command, expectedRevision = this.revision) {
    const input = clone(command);
    return this._enqueue(async () => {
      if (this.revision !== expectedRevision) {
        throw new SessionError('stale_revision', 'document changed; recompute the target');
      }
      return this._apply({ ...input, revision: expectedRevision });
    });
  }

  // Typing supplies a complete raw draft, so it can queue safely without spans.
  replaceText(text, { deferPool = false, completion = null } = {}) {
    return this._enqueue(() => this._apply({ type: 'ReplaceText', text, revision: this.revision, ...(completion ? { completion } : {}), ...(deferPool ? { defer_pool: true } : {}) }));
  }

  commitPool() {
    return this._enqueue(async () => {
      if (!this._pendingPool || !this.valid || !this.request.flush) return;
      const result = await this.request.flush({ state: clone(this.state) });
      if (this._disposed) return;
      if (result) {
        if (result.state.revision !== this.revision + 1) throw new SessionError('stale_response', 'unexpected pool sync revision');
        this.state = clone(result.state); this.projection = clone(result.projection);
        // Source adoption completes the current typing operation, not another
        // undo step. Pool additions never delete library tags during undo.
        this._emit('SyncPool');
      }
      this._pendingPool = false;
    });
  }

  // Loading a saved whole document preserves its parked nodes and joins the
  // same undo history as typing and structural commands.
  loadDocument(body) {
    return this._enqueue(async () => {
      const opened = await this.request('open', clone(body));
      if (this._disposed) throw new SessionError('disposed', 'editing session has been disposed');
      const revision = this.revision + 1;
      this.past.push(this._snapshot());
      if (this.past.length > this.historyLimit) this.past.shift();
      this.future = [];
      this.state = clone(opened.state); this.state.revision = revision;
      this.state.doc.root.meta ??= {};
      // Loading content does not borrow another document's observation identity.
      if (this.past.at(-1)?.state.doc.root.meta?.owner) this.state.doc.root.meta.owner = this.past.at(-1).state.doc.root.meta.owner;
      this._idFloor = Math.max(this._idFloor, this.state.doc.next_id);
      this.state.doc.next_id = this._idFloor;
      this.projection = clone(opened.projection); this.projection.revision = revision;
      this._pendingPool = false;
      await this.request.observe?.(this);
      this._emit('LoadDocument'); return this.state;
    });
  }

  async _apply(command) {
    const selectionEpoch = this.selectionEpoch;
    const before = this._snapshot();
    const result = await this.request('command', { state: clone(this.state), command });
    if (this._disposed) throw new SessionError('disposed', 'editing session has been disposed');
    if (result.state.revision !== this.revision + 1) {
      throw new SessionError('stale_response', 'unexpected document revision in response');
    }
    const changed = JSON.stringify(result.state.doc) !== JSON.stringify(this.state.doc);
    if (changed) {
      this.past.push(before);
      if (this.past.length > this.historyLimit) this.past.shift();
      this.future = [];
    }
    const currentSelection = this.state.selection;
    this.state = clone(result.state);
    this._pendingPool = !!command.defer_pool;
    this.projection = clone(result.projection);
    if (this.selectionEpoch !== selectionEpoch) this.state.selection = this._selectionFor(currentSelection.node_id) || this.state.selection;
    this._idFloor = Math.max(this._idFloor, this.state.doc.next_id);
    this._emit(command.type, result.edit);
    return result;
  }

  async _restore(snapshot, reason) {
    const revision = this.revision + 1;
    this.state = clone(snapshot.state);
    this.state.revision = revision;
    this.state.doc.next_id = Math.max(this._idFloor, this.state.doc.next_id);
    this._pendingPool = false;
    this.projection = clone(snapshot.projection);
    this.projection.revision = revision;
    await this.request.observe?.(this);
    this._emit(reason);
    return this.state;
  }

  undo() {
    return this._enqueue(() => {
      if (!this.canUndo) return false;
      this.future.push(this._snapshot());
      return this._restore(this.past.pop(), 'Undo');
    });
  }

  redo() {
    return this._enqueue(() => {
      if (!this.canRedo) return false;
      this.past.push(this._snapshot());
      return this._restore(this.future.pop(), 'Redo');
    });
  }

  setView(view, currentViewState = null) {
    if (!['syntax', 'block', 'preview'].includes(view)) throw new SessionError('invalid_view', 'unknown view');
    if (currentViewState != null) this.viewState.set(this.view, currentViewState);
    // Invalid drafts remain in this same session even when another view is selected.
    this.view = view;
    this._emit('View');
    return this.viewState.get(view) ?? null;
  }

  compile(nodeInputs) {
    const { seed, region_mode } = nodeInputs;
    if (!Number.isSafeInteger(seed)) return Promise.reject(new SessionError('node_seed_only', 'read the resolved ComfyUI node seed input'));
    return this._enqueue(async () => {
      const revision = this.revision;
      const result = await this.request('compile', { state: clone(this.state), seed, region_mode });
      if (result.revision !== revision) throw new SessionError('stale_response', 'preview belongs to an old revision');
      return result;
    });
  }

  resolveMasks(request, canApply = () => true) {
    return this._enqueue(async () => {
      if (!this.valid || !canApply()) return;
      const result = await request('resolve', { state: clone(this.state) });
      if (this._disposed || !canApply()) return;
      if (JSON.stringify(result.state.doc) === JSON.stringify(this.state.doc)) return;
      const revision = this.revision + 1;
      this.state = clone(result.state); this.state.revision = revision;
      this.projection = clone(result.projection); this.projection.revision = revision;
      // Shared asset refresh is external state, not a local editing undo step.
      this._emit('MaskResources');
    });
  }

  dispose() { this._disposed = true; this.listeners.clear(); this.draftFlushers.clear(); this.viewState.clear(); }
}
