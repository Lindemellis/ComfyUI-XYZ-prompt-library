// A ComfyUI capture listener may schedule workflow undo before our listener
// owns the key. Event propagation cannot cancel that already queued callback.
const owned = new WeakSet();
const installed = new WeakMap();
export function ownHistoryKey(event) { owned.add(event); }
export function installWorkflowUndoGuard(ChangeTracker) {
  const prototype = ChangeTracker?.prototype;
  if (typeof prototype?.undoRedo !== 'function') return false;
  if (prototype.undoRedo === installed.get(prototype)) return true;
  const original = prototype.undoRedo;
  const guarded = function(event) {
    // Report this event as consumed so the deferred callback also skips capturing
    // a workflow-history entry for the editor operation. Other events are intact.
    if (owned.has(event)) return true;
    return original.apply(this, arguments);
  };
  prototype.undoRedo = guarded; installed.set(prototype, guarded); return true;
}
