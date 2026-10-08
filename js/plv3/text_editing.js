// Both native Block UI and syntax editing borrow the vendored Monaco menu and
// Find controller. No duplicate menu definitions, search engine or history.
export function showEditorContextMenu(pane, anchor, adapt, onHide) {
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
  controller._contextMenuService.showContextMenu({ getAnchor: () => anchor,
    getActions: () => actions.map(map), getKeyBinding: action => controller._keybindingFor(action), onHide });
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
