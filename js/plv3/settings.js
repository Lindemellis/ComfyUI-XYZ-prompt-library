// PLv3 — user settings, in one place.
//
// Everything here was a constant sitting in the file that happened to need it: the
// weight slider's range in detail.js, the lint delay in editor_core.js, the autosave
// delay in library.js. They are all things a user has an opinion about, and none of
// them belonged where they were.
//
// Persisted in localStorage (one key, one JSON object) and read live — a change takes
// effect on the next render, with no reload. `xyz_settings.js` renders the panel; this
// file owns the values and their defaults.

const KEY = 'xyz.plv3.settings';

export const DEFAULTS = {
  // Prompt weight — `(tag:1.2)`. Unbounded, with a configurable shortcut step.
  weightStep: 0.05,

  // LoRA weight — `<lora:name:0.8>`. Its shortcut step is independent.
  loraStep: 0.05,

  // Schedule — `[@schedule] 0 - 0.3:`. The step of the two-handle range slider. 0.05 is
  // 20 stops across a run, which is about as fine as a step schedule is worth setting.
  scheduleStep: 0.05,

  // Editor
  fontSize: 13,
  wordWrap: true,
  // How long after you stop typing before the preview and the detail page catch up.
  // Every keystroke would be a round trip; too long and the panels feel detached.
  lintDelayMs: 250,

  // Library window: how long after a switch/slider before the preset is written back.
  // It exists so that dragging a slider is one save, not forty.
  autosaveDelayMs: 400,
};

const state = { ...DEFAULTS, ...Object.fromEntries(Object.entries(read()).filter(([key]) => key in DEFAULTS)) };

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); }
  catch { return {}; }
}

export function settings() {
  return state;
}

export function set(key, value) {
  if (!(key in DEFAULTS)) return;
  state[key] = value;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ }
  document.dispatchEvent(new CustomEvent('plv3:settings-changed', { detail: { key, value } }));
}

export function reset() {
  Object.assign(state, DEFAULTS);
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  document.dispatchEvent(new CustomEvent('plv3:settings-changed', { detail: {} }));
}
