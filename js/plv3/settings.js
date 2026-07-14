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
  // Prompt weight — `(tag:1.2)`. 2.0 is already extreme for most models; the range is
  // what the slider can REACH, so a wider one only makes the useful part harder to hit.
  weightMin: 0,
  weightMax: 2,
  weightStep: 0.05,

  // LoRA weight — `<lora:name:0.8>`. A different control with a different range: a
  // negative LoRA weight is a real technique (subtracting a style), which is nonsense
  // for a prompt weight, and that is why these are not one setting.
  loraMin: -1,
  loraMax: 2,
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

const state = { ...DEFAULTS, ...read() };

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

/** The slider config a prompt weight control wants — read at render time, so a change
 *  in the settings panel shows up on the next repaint without a reload. */
export function weightRange() {
  return { min: state.weightMin, max: state.weightMax, step: state.weightStep };
}

/** ...and the LoRA one, which is genuinely a different range (it may go negative). */
export function loraRange() {
  return { min: state.loraMin, max: state.loraMax, step: state.loraStep };
}
