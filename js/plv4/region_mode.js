// Region backend is node-level execution state, stored in its existing widget.
// Keep old workflow values and connected inputs; Library blocks have no backend.
export function createRegionModeControl(host) {
  const label = document.createElement('div');
  label.className = 'plv4-region-mode'; label.title = 'Region 算法（当前节点所有区域）';
  const select = document.createElement('select'); select.setAttribute('aria-label', 'Region algorithm');
  for (const [mode, name] of [['couple', 'Attention Couple (COUPLE)'], ['mask', 'Latent Mask (AND)']]) {
    const option = document.createElement('option'); option.value = mode; option.textContent = name;
    select.append(option);
  }
  label.append(select);
  const update = () => {
    const node = host.context?.node;
    label.hidden = !node || !!host.folderContext || !node.comfyClass?.includes('Library V4');
    const external = node?.inputs?.some(input => input.name === 'region_mode' && input.link != null);
    select.disabled = !!external;
    select.value = node?.widgets?.find(widget => widget.name === 'region_mode')?.value || 'couple';
    label.title = external ? 'region_mode 由上游节点提供' : 'Region 算法（当前节点所有区域）';
  };
  select.addEventListener('change', () => {
    const node = host.context?.node, widget = node?.widgets?.find(widget => widget.name === 'region_mode');
    if (!widget || node.inputs?.some(input => input.name === 'region_mode' && input.link != null)) { update(); return; }
    node.graph?.beforeChange?.();
    widget.value = select.value; widget.callback?.call(widget, widget.value);
    node.graph?.afterChange?.(); node.graph?.setDirtyCanvas(true, false);
  });
  return { element: label, update };
}

export function hideRegionModeWidget(node) {
  if (!node.comfyClass?.includes('Library V4')) return;
  // Older workflow records restore their old inputs after node creation.
  // Append new optional sockets without shifting any existing link indices.
  for (const name of ['width', 'height']) {
    if (!node.inputs?.some(input => input.name === name)) node.addInput(name, 'INT');
  }
  // An older workflow may restore only its original two output descriptions.
  if (node.outputs?.length === 2) node.addOutput('metadata', 'PLV4_METADATA');
  if (node.outputs?.length === 3) node.addOutput('mask_bundle', 'PLV4_MASK_BUNDLE');
  const widget = node.widgets?.find(widget => widget.name === 'region_mode');
  if (!widget) return;
  widget.hidden = true;
  widget.computeSize = () => [0, -4];
  if (widget.inputEl) widget.inputEl.style.display = 'none';
}
