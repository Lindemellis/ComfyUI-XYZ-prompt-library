/**
 * Prompt Library V2 — folder (no-op)
 *
 * Folder detail has been replaced by _template entry inheritance.
 * Clicking a folder in the tree no longer shows a detail panel.
 */

import { app } from '../../../scripts/app.js';

app.registerExtension({
  name: 'XYZNodes.PromptLibraryV2.Folder',

  async setup() {
    // Folder detail removed per template restructuring.
    // Template inheritance is handled by plv2_entry.js.
  },
});
