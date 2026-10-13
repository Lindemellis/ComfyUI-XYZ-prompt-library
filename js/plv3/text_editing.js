// Both native Block UI and syntax editing borrow the vendored Monaco menu and
// Find controller. No duplicate menu definitions, search engine or history.
export class NativeEditorInput {
  constructor(pane) {
    this.pane = pane;
    this.container = document.createElement('div');
    this.container.hidden = true; this.container.setAttribute('aria-hidden', 'true');
    pane.container.append(this.container);
    this.model = pane.monaco.editor.createModel('', pane.model().getLanguageId()); if (pane.monaco.editor.EndOfLineSequence) this.model.setEOL?.(pane.monaco.editor.EndOfLineSequence.LF);
    this.editor = pane.monaco.editor.create(this.container, {
      ...pane.editor.getRawOptions(), model: this.model, automaticLayout: false,
      contextmenu: false, readOnly: false, quickSuggestions: false, suggestOnTriggerCharacters: false,
      inlineSuggest: { enabled: false }, parameterHints: { enabled: false },
    });
  }
  prepare(field, value, anchor, focus) {
    const options = this.pane.editor.getRawOptions();
    if (this.options !== options) {
      this.options = options;
      this.editor.updateOptions({ ...options, automaticLayout: false, contextmenu: false, readOnly: false,
        quickSuggestions: false, suggestOnTriggerCharacters: false, inlineSuggest: { enabled: false }, parameterHints: { enabled: false } });
    }
    if (this.field !== field || this.model.getValue() !== value) {
      this.field = field; this.model.setValue(value);
    }
    this.model.updateOptions(this.pane.model().getOptions());
    this.editor.setSelection(this.pane.monaco.Selection.fromPositions(this.model.getPositionAt(anchor), this.model.getPositionAt(focus)));
  }
  result() {
    const selection = this.editor.getSelection();
    return { text: this.model.getValue(), anchor: this.model.getOffsetAt(selection.getSelectionStart()), focus: this.model.getOffsetAt(selection.getPosition()) };
  }
  edit(field, value, anchor, focus, command, args) {
    this.prepare(field, value, anchor, focus);
    this.editor.trigger('keyboard', command, args);
    return this.result();
  }
  async action(field, value, anchor, focus, id) {
    this.prepare(field, value, anchor, focus);
    if (id === 'plv3.weightUp' || id === 'plv3.weightDown') {
      // Borrow PromptEditor's weight action against the native draft model.
      const pane = Object.create(this.pane);
      pane.editor = this.editor; pane.model = () => this.model;
      pane.adjustWeight(id === 'plv3.weightUp' ? 1 : -1);
      return this.result();
    }
    const action = this.editor.getAction(id); if (!action) return null;
    await action.run(); return this.result();
  }
  actionForKey(event) {
    if (event.isComposing || event.keyCode === 229 || (!event.ctrlKey && !event.metaKey && !event.altKey)) return null;
    const service = this.pane.editor._standaloneKeybindingService || this.pane.editor._keybindingService;
    if (!service?.resolveKeyboardEvent || !service.lookupKeybinding) return null;
    const keyCode = this.pane.monaco.KeyCode[event.code.replace(/^Arrow(\w+)$/, '$1Arrow')] ?? this.pane.monaco.KeyCode[event.key];
    if (keyCode == null) return null;
    const key = service.resolveKeyboardEvent({ keyCode, code: event.code, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey });
    const chord = key?.getDispatchChords()[0]; if (!chord) return null;
    return this.pane.editor.getSupportedActions().find(action => {
      const chords = service.lookupKeybinding(action.id)?.getDispatchChords();
      return chords?.length === 1 && chords[0] === chord;
    })?.id || null;
  }
  dispose() { this.editor.dispose(); this.model.dispose(); this.container.remove(); }
}

export function showEditorContextMenu(pane, anchor, adapt, onHide, container = null) {
  const controller = pane.editor.getContribution('editor.contrib.contextmenu');
  const actions = controller._getMenuActions(pane.model(), pane.editor.contextMenuId);
  const map = action => {
    if (action.actions) {
      const submenu = Object.create(action);
      Object.defineProperty(submenu, 'actions', { value: action.actions.map(map) });
      return submenu;
    }
    const replacement = adapt(action);
    if (!replacement) return action;
    return { id: action.id, label: action.label, tooltip: action.tooltip, class: action.class,
      checked: action.checked, enabled: replacement.enabled ?? action.enabled,
      run: replacement.run };
  };
  const service = controller._contextMenuService, view = service.contextViewService;
  // Standalone Monaco otherwise chooses the active Source editor, which is
  // hidden in Blocks mode. Supply the visible host for this synchronous show.
  const show = container && view?.showContextView, move = typeof show === 'function';
  const ownShow = move && Object.hasOwn(view, 'showContextView');
  if (move) view.showContextView = delegate => show.call(view, delegate, container, false);
  try {
    service.showContextMenu({ getAnchor: () => anchor,
      getActions: () => actions.map(map), getKeyBinding: action => controller._keybindingFor(action), onHide });
  } finally {
    if (move) { if (ownShow) view.showContextView = show; else delete view.showContextView; }
  }
}

export async function showEditorFind(pane, container, replace, onMatch, { searchScope, onClearMatch = () => {} } = {}) {
  const controller = pane.editor.getContribution('editor.contrib.findController');
  const findState = controller.getState(), originalScope = findState.searchScope;
  await controller.start({ forceRevealReplace: replace, seedSearchStringFromSelection: 'single',
    seedSearchStringFromNonEmptySelection: true, seedSearchStringFromGlobalClipboard: false,
    shouldFocus: 0, shouldAnimate: false, updateSearchScope: false, loop: true },
    searchScope ? { searchScope: searchScope() } : undefined);
  const widget = controller._widget, node = widget.getDomNode();
  // Transfer overlay ownership too. Merely moving the DOM leaves Monaco free
  // to attach the widget to the hidden Source editor when its view is rebuilt.
  pane.editor.removeOverlayWidget(widget);
  container.replaceChildren(node); container.hidden = false;
  const match = () => {
    // Highlighting a native contenteditable selection can move focus away from
    // Find. Keep its query/replace input and caret while showing Block matches.
    const input = document.activeElement;
    const keepFocus = container.contains(input) && input.matches('input,textarea');
    const selection = keepFocus ? [input.selectionStart, input.selectionEnd, input.selectionDirection] : null;
    onMatch(pane.editor.getSelection());
    if (keepFocus && !container.hidden && input.isConnected && document.activeElement !== input) {
      input.focus({ preventScroll: true });
      if (selection[0] != null) input.setSelectionRange(...selection);
    }
  };
  const refreshScope = () => {
    if (!searchScope || !findState.isRevealed) return;
    const desired = searchScope(), current = findState.searchScope;
    const key = ranges => JSON.stringify(ranges == null ? null : (Array.isArray(ranges) ? ranges : [ranges])
      .map(r => [r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn]));
    if (key(desired) !== key(current)) findState.change({ searchScope: desired }, false);
  };
  // Monaco's Enter keybindings live on its editor DOM. This widget is now
  // outside that DOM, so plain Enter would otherwise insert a textarea newline.
  const keydown = event => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey ||
      !event.target.closest?.('.find-part')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    // Use the exact editor actions wired to FindWidget's arrow buttons.
    const action = pane.editor.getAction(event.shiftKey ? 'editor.action.previousMatchFindAction' : 'editor.action.nextMatchFindAction');
    return action.run().then(match, error => console.error('[PLv4 Find]', error));
  };
  container.addEventListener('keydown', keydown, true);
  const cursor = pane.editor.onDidChangeCursorSelection(match);
  const state = findState.onFindReplaceStateChange(() => {
    if (!findState.isRevealed) { container.hidden = true; onClearMatch(); }
    else refreshScope();
    if (findState.matchesCount === 0) onClearMatch();
  });
  replace ? widget.focusReplaceInput() : widget.focusFindInput();
  refreshScope();
  match();
  return { refreshScope, dispose() {
    cursor.dispose(); state.dispose(); container.hidden = true;
    onClearMatch();
    container.removeEventListener('keydown', keydown, true);
    if (searchScope) findState.change({ searchScope: originalScope }, false);
    pane.editor.addOverlayWidget(widget);
    pane.editor.layoutOverlayWidget(widget);
  } };
}
