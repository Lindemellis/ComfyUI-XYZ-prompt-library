import { app } from '../../../scripts/app.js';

const PROMPT_LIB_DEBUG = '[XYZ Prompt Library]';
const PROMPT_LIB_DEBUG_ENABLED = false;
const debugLog = PROMPT_LIB_DEBUG_ENABLED ? (...args) => console.debug(PROMPT_LIB_DEBUG, ...args) : () => {};

/**
 * Prompt Library Node Extension
 *
 * This extension manages the ComfyUI node interface for the prompt library system.
 * It provides:
 * - Node widget management and synchronization
 * - Output count controls
 * - Integration with the library window
 * - Hidden widget handling for backend communication
 *
 * @author XYZNodes
 * @version 1.0.0
 */
app.registerExtension({
  name: 'XYZNodes.PromptLibraryNode',

  setup() {
    // Load CSS styles
    this.loadStyles();

    // Message handlers for communication with Python backend
    // - Library save/load operations
    // - Error handling
  },

  loadStyles() {
    // Create and inject CSS styles
    const style = document.createElement('style');
    style.textContent = `
      /* Prompt Library Node Styles */
      .prompt-library-container {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }

      .prompt-library-header {
        background: rgba(40, 44, 52, 0.8) !important;
        border: 1px solid rgba(66, 153, 225, 0.3) !important;
        border-radius: 6px !important;
      }

      .output-controls {
        background: rgba(40, 44, 52, 0.6) !important;
        border: 1px solid rgba(66, 153, 225, 0.2) !important;
        border-radius: 6px !important;
      }


    `;
    document.head.appendChild(style);
  },

  async nodeCreated(node) {
    if (node.comfyClass === 'XYZ Prompt Library') {
      // Enable widget serialization
      node.serialize_widgets = true;

      // Initialize the node
      this.initializeNode(node);

      // Ensure hydration after Comfy loads saved widget values
      const originalOnConfigure = node.onConfigure?.bind(node);
      node.onConfigure = o => {
        if (originalOnConfigure) originalOnConfigure(o);
        // After widgets_values are applied, hydrate UI from hidden widgets
        this.hydrateFromHiddenWidgets(node);
        this.syncOutputCount(node);
        // this.updateNodeSize(node); // Commented out for testing
      };
    }
  },

  initializeNode(node) {
    // Store node state
    node.libraryData = {};
    node.outputCount = 1;
    debugLog('initializeNode', { id: node.id, widgetCount: node.widgets?.length || 0 });

    // Create the header UI
    this.createHeaderUI(node);

    // Attach to backend hidden widgets and hydrate state
    this.attachHiddenWidgets(node);
    this.hydrateFromHiddenWidgets(node);

    // Sync output count with existing outputs (this should happen after hydration)
    this.syncOutputCount(node);

    // Hidden widgets are already attached; ensure they reflect current state
    this.updateHiddenWidgets(node);

    // Request sync from library window once we're ready
    this.requestLibrarySync(node);

    // Set initial size
    // this.updateNodeSize(node); // Commented out for testing
  },

  createHeaderUI(node) {
    // Create header with all controls in one row
    const header = document.createElement('div');
    header.className = 'prompt-library-header';
    header.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px;
      background: rgba(40, 44, 52, 0.6);
      border-radius: 6px;
      border: 1px solid rgba(226, 232, 240, 0.2);
      max-height: 40px;
      overflow: hidden;
    `;

    // Library button
    const libraryBtn = this.createButton('📚 Library', () => {
      this.openLibraryWindow(node);
    });
    header.appendChild(libraryBtn);

    // Output count display
    const countDisplay = document.createElement('span');
    countDisplay.className = 'output-count';
    countDisplay.style.cssText = `
      color: rgba(226, 232, 240, 0.8);
      font-size: 12px;
      margin-left: auto;
    `;
    countDisplay.textContent = `Outputs: ${node.outputCount}`;
    header.appendChild(countDisplay);

    // Store reference for updating
    node.outputCountDisplay = countDisplay;

    // Add output button
    const addOutputBtn = this.createButton('+', () => {
      this.addOutput(node);
    });
    header.appendChild(addOutputBtn);

    // Remove output button
    const removeOutputBtn = this.createButton('-', () => {
      this.removeOutput(node);
    });
    header.appendChild(removeOutputBtn);

    // Add to node directly as a DOM widget
    const widget = node.addDOMWidget('header_ui', 'custom', header, {
      getValue: () => '',
      setValue: () => {},
    });
    widget.computeSize = () => [node.size[0], 60];
    // ComfyUI v2.0 (Vue) node renderer stretches any widget that exposes
    // computeLayoutSize into an 'auto' grid row, leaving a big blank gap below
    // this fixed-height header. Shadow the inherited method so the new renderer
    // treats it as min-content; the classic renderer keeps using computeSize.
    widget.computeLayoutSize = undefined;
  },

  syncOutputCount(node) {
    // Count existing outputs and sync the count
    if (node.outputs && Array.isArray(node.outputs)) {
      const actualOutputCount = node.outputs.length;
      node.outputCount = actualOutputCount;
      debugLog('syncOutputCount', node.id, 'outputs detected', actualOutputCount);

      // Update the display
      this.updateOutputCount(node);

      // Also sync with the hidden widget to ensure backend knows the correct count
      this.updateHiddenWidgets(node);
    }
  },

  addOutput(node) {
    if (node.outputCount < 10) {
      // Limit to 10 outputs
      node.outputCount++;

      // Add output to the node with proper naming
      const outputName = `prompt_${node.outputCount}`;
      node.addOutput(outputName, 'STRING');

      // Update the hidden widget to sync with backend
      this.updateHiddenWidgets(node);

      // Update the display
      this.updateOutputCount(node);

      // Update node size
      // this.updateNodeSize(node); // Commented out for testing
    }
  },

  removeOutput(node) {
    if (node.outputCount > 1) {
      // Remove the last output
      const lastOutputIndex = node.outputs.length - 1;
      if (lastOutputIndex >= 0) {
        const removedOutput = node.outputs[lastOutputIndex];
        node.removeOutput(lastOutputIndex);
        node.outputCount--;

        // Update the hidden widget to sync with backend
        this.updateHiddenWidgets(node);

        // Update the display
        this.updateOutputCount(node);

        // Update node size
        // this.updateNodeSize(node); // Commented out for testing
      }
    }
  },

  updateOutputCount(node) {
    if (node.outputCountDisplay) {
      node.outputCountDisplay.textContent = `Outputs: ${node.outputCount}`;
    }
  },

  openLibraryWindow(node) {
    // Open the library window
    if (window.promptLibraryWindow) {
      window.promptLibraryWindow.openLibraryWindow();
    } else {
      this.showError('Library window not available');
    }
  },

  attachHiddenWidgets(node) {
    // Find existing backend-provided hidden widgets
    if (node.widgets && Array.isArray(node.widgets)) {
      // Attach to library_data widget
      const libraryWidget = node.widgets.find(w => w && (w.name === 'library_data' || w.label === 'library_data'));
      if (libraryWidget) {
        debugLog('attachHiddenWidgets', node.id, 'found backend library_data widget');
        libraryWidget.hidden = true;
        libraryWidget.type = 'converted-widget';
        libraryWidget.computeSize = () => [0, 0];
        if (typeof libraryWidget.callback !== 'function') {
          libraryWidget.callback = value => this.storeWidgetValue(node, libraryWidget, value);
        }
        node.libraryWidget = libraryWidget;
      } else {
        debugLog('attachHiddenWidgets', node.id, 'backend library_data widget missing');
      }

      // Attach to output_count widget
      const outputWidget = node.widgets.find(w => w && (w.name === 'output_count' || w.label === 'output_count'));
      if (outputWidget) {
        debugLog('attachHiddenWidgets', node.id, 'found backend output_count widget');
        outputWidget.hidden = true;
        outputWidget.type = 'converted-widget';
        outputWidget.computeSize = () => [0, -4];
        if (typeof outputWidget.callback !== 'function') {
          outputWidget.callback = value => this.storeWidgetValue(node, outputWidget, value);
        }
        node.outputWidget = outputWidget;
      } else {
        debugLog('attachHiddenWidgets', node.id, 'backend output_count widget missing');
      }
    }

    // Fallback: create if not found
    if (!node.libraryWidget) {
      const hiddenWidget = node.addWidget('text', 'library_data', '', value => {
        this.storeWidgetValue(node, hiddenWidget, value);
      });
      debugLog('attachHiddenWidgets', node.id, 'created fallback library_data widget');
      hiddenWidget.type = 'converted-widget';
      hiddenWidget.hidden = true;
      hiddenWidget.computeSize = () => [0, -4];
      node.libraryWidget = hiddenWidget;
    }

    if (!node.outputWidget) {
      const hiddenWidget = node.addWidget('text', 'output_count', '1', value => {
        this.storeWidgetValue(node, hiddenWidget, value);
      });
      debugLog('attachHiddenWidgets', node.id, 'created fallback output_count widget');
      hiddenWidget.type = 'converted-widget';
      hiddenWidget.hidden = true;
      hiddenWidget.computeSize = () => [0, -4];
      node.outputWidget = hiddenWidget;
    }
  },

  hydrateFromHiddenWidgets(node) {
    try {
      // Hydrate library data
      if (node.libraryWidget) {
        const raw = node.libraryWidget.value || '';
        debugLog('hydrateFromHiddenWidgets', node.id, 'library_data length', raw.length);
        if (raw && typeof raw === 'string' && raw.trim().length) {
          try {
            const parsed = JSON.parse(raw);
            if (typeof parsed === 'object') {
              node.libraryData = parsed;
              debugLog('hydrateFromHiddenWidgets', node.id, 'parsed entries', Object.keys(parsed).length);
            }
          } catch (e) {
            console.warn('Failed to parse library data:', e);
            debugLog('hydrateFromHiddenWidgets', node.id, 'library_data parse error', e.message);
          }
        } else {
          debugLog('hydrateFromHiddenWidgets', node.id, 'library_data empty string');
        }
      } else {
        debugLog('hydrateFromHiddenWidgets', node.id, 'libraryWidget missing');
      }

      // Hydrate output count
      if (node.outputWidget) {
        const raw = node.outputWidget.value || '1';
        debugLog('hydrateFromHiddenWidgets', node.id, 'output_count raw', raw);
        try {
          const count = parseInt(raw);
          if (!isNaN(count) && count > 0) {
            node.outputCount = count;
            this.updateOutputCount(node);
          }
        } catch (e) {
          console.warn('Failed to parse output count:', e);
          debugLog('hydrateFromHiddenWidgets', node.id, 'output_count parse error', e.message);
        }
      } else {
        debugLog('hydrateFromHiddenWidgets', node.id, 'outputWidget missing');
      }

      // Initialize defaults if no data
      if (!node.libraryData) node.libraryData = {};
      if (!node.outputCount) node.outputCount = 1;
      debugLog('hydrateFromHiddenWidgets', node.id, 'post hydration state', {
        entryCount: Object.keys(node.libraryData || {}).length,
        outputCount: node.outputCount,
      });
    } catch (e) {
      console.warn('Failed to hydrate from hidden widgets:', e);
      // Initialize defaults
      if (!node.libraryData) node.libraryData = {};
      if (!node.outputCount) node.outputCount = 1;
      debugLog('hydrateFromHiddenWidgets', node.id, 'exception fallback', e.message);
    }
  },

  updateHiddenWidgets(node) {
    // Update library data widget
    if (node.libraryWidget) {
      const serializedData = JSON.stringify(node.libraryData || {}, null, 2);
      if (node.libraryWidget.value !== serializedData) {
        debugLog('updateHiddenWidgets', node.id, 'sync library_data', serializedData.length);
        this.writeWidgetValue(node, node.libraryWidget, serializedData, 'library_data');
      }
    } else {
      debugLog('updateHiddenWidgets', node.id, 'libraryWidget missing');
    }

    // Update output count widget
    if (node.outputWidget) {
      const value = String(node.outputCount || 1);
      if (node.outputWidget.value !== value) {
        debugLog('updateHiddenWidgets', node.id, 'sync output_count', value);
        this.writeWidgetValue(node, node.outputWidget, value, 'output_count');
      }
    } else {
      debugLog('updateHiddenWidgets', node.id, 'outputWidget missing');
    }
  },

  writeWidgetValue(node, widget, value, label = 'widget') {
    if (!node || !widget) {
      debugLog('writeWidgetValue', 'missing node or widget', { label });
      return;
    }
    this.storeWidgetValue(node, widget, value, label);
    widget.value = value;

    if (typeof widget.callback === 'function') {
      if (widget.__xyz_updating) {
        return;
      }
      widget.__xyz_updating = true;
      try {
        widget.callback(value);
        debugLog('writeWidgetValue', node.id, label, 'callback invoked');
      } finally {
        widget.__xyz_updating = false;
      }
    } else {
      debugLog('writeWidgetValue', node.id, label, 'callback missing');
    }
  },

  storeWidgetValue(node, widget, value, label = 'widget') {
    if (!node.widgets_values) {
      node.widgets_values = (node.widgets || []).map(w => w?.value ?? null);
      debugLog('storeWidgetValue', node.id, 'initialized widgets_values array');
    }

    const widgetIndex = (node.widgets || []).indexOf(widget);
    if (widgetIndex !== -1) {
      while (node.widgets_values.length <= widgetIndex) {
        node.widgets_values.push(null);
      }
      node.widgets_values[widgetIndex] = value;
      debugLog('storeWidgetValue', node.id, label, 'stored at index', widgetIndex);
    } else {
      debugLog('storeWidgetValue', node.id, label, 'widget not found in node.widgets');
    }
  },

  requestLibrarySync(node, attempt = 0) {
    const cached = window.__xyzPromptLibrarySerialized;
    if (cached && node.libraryWidget) {
      debugLog('requestLibrarySync', node.id, 'applying cached data', window.__xyzPromptLibraryEntryCount || 0);
      this.applySerializedLibrary(node, cached, 'global-cache');
      return;
    }

    const windowExt = window.promptLibraryWindow;
    if (windowExt?.updateAllPromptLibraryNodes) {
      debugLog('requestLibrarySync', node.id, 'triggering window sync', attempt);
      try {
        windowExt.updateAllPromptLibraryNodes();
      } catch (err) {
        console.warn('PromptLibraryNode sync error:', err);
      }
    } else if (attempt < 5) {
      setTimeout(() => this.requestLibrarySync(node, attempt + 1), 500 * (attempt + 1));
    } else {
      debugLog('requestLibrarySync', node.id, 'library window not available after retries');
    }
  },

  applySerializedLibrary(node, serializedData, source = 'unknown') {
    if (!node.libraryWidget || !serializedData) {
      return;
    }

    try {
      const parsed = JSON.parse(serializedData);
      if (parsed && typeof parsed === 'object') {
        node.libraryData = parsed;
        debugLog('applySerializedLibrary', node.id, 'parsed entries', Object.keys(parsed).length, 'source', source);
      }
    } catch (error) {
      console.warn('Failed to parse serialized library data:', error);
      return;
    }

    this.writeWidgetValue(node, node.libraryWidget, serializedData, 'library_data');
  },

  // updateNodeSize(node) { // Commented out for testing
  //   // Calculate height based on actual content
  //   const headerHeight = 40; // Header with controls
  //   const padding = 16; // Minimal padding
  //
  //   // Let ComfyUI handle the prompt template widget sizing automatically
  //   const requiredHeight = headerHeight + padding;
  //   const currentHeight = node.size[1];
  //
  //   // Only resize if we need to make it smaller, let ComfyUI expand naturally
  //   if (currentHeight > requiredHeight && currentHeight > 200) {
  //     node.setSize([node.size[0], requiredHeight]);
  //     node.setDirtyCanvas(true, true);
  //   }
  // },

  createButton(text, onClick) {
    const button = document.createElement('button');
    button.textContent = text;
    button.style.cssText = `
      background: rgba(66, 153, 225, 0.9);
      border: none;
      border-radius: 4px;
      color: white;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
    `;

    button.addEventListener('click', onClick);
    button.addEventListener('mouseenter', () => {
      button.style.background = 'rgba(66, 153, 225, 1)';
    });
    button.addEventListener('mouseleave', () => {
      button.style.background = 'rgba(66, 153, 225, 0.9)';
    });

    return button;
  },

  showError(message) {
    console.error('Prompt Library Error:', message);
    if (app?.extensionManager?.dialog?.confirm) {
      app.extensionManager.dialog.confirm({
        title: 'Error',
        message: String(message),
        type: 'default',
      });
    }
  },

  showSuccess(message) {
    if (app?.extensionManager?.dialog?.confirm) {
      app.extensionManager.dialog.confirm({
        title: 'Info',
        message: String(message),
        type: 'default',
      });
    }
  },
});
