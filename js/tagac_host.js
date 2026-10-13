// All prompt editors attach to the same TagAC extension and settings.
export function tagacReady(timeoutMs = 8000) {
  if (window.xyzTagAC) return Promise.resolve(window.xyzTagAC);
  return new Promise(resolve => {
    const started = Date.now();
    const tick = () => {
      if (window.xyzTagAC) return resolve(window.xyzTagAC);
      if (Date.now() - started >= timeoutMs) return resolve(null);
      setTimeout(tick, 50);
    };
    tick();
  });
}

export async function attachPromptAutocomplete(element) {
  element._xyzPoolSuggestions = query => window.xyzPLv4Memberships?.(query) || [];
  const immediate = window.xyzTagAC;
  const api = immediate || await tagacReady();
  // A Details redraw may have replaced this input while TagAC was loading.
  if (!api || (!immediate && !element.isConnected)) return;
  api.attach(element, { related: true, getDelimiter: () => ', ' });
}

export async function attachPromptPreview(slot, name) {
  const api = window.xyzTagAC || await tagacReady();
  api?.attachPreview?.(slot, name);
}
