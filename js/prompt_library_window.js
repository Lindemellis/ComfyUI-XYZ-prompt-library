import { api } from '../../../scripts/api.js';
import { app } from '../../../scripts/app.js';
import { TagToolkitWindow } from './tag_toolkit_window.js';

const PROMPT_LIBRARY_WINDOW_DEBUG = '[XYZ Prompt Library Window]';
const PROMPT_LIBRARY_WINDOW_DEBUG_ENABLED = false;
const windowDebug = PROMPT_LIBRARY_WINDOW_DEBUG_ENABLED ? (...args) => console.debug(PROMPT_LIBRARY_WINDOW_DEBUG, ...args) : () => {};

/**
 * Prompt Library Window Extension
 *
 * This extension provides a comprehensive prompt library management system for ComfyUI.
 * It allows users to create, edit, organize, and manage prompt libraries with:
 * - Hierarchical organization (entries -> groups -> prompts)
 * - Advanced random selection algorithms
 * - Real-time synchronization with ComfyUI nodes
 * - Persistent storage with disk and browser caching
 * - Batch prompt creation and management
 *
 * @author XYZNodes
 * @version 1.0.0
 */
app.registerExtension({
  name: 'XYZNodes.PromptLibraryWindow',

  setup() {
    // Load CSS styles
    this.loadStyles();

    // Initialize the library window
    this.createLibraryWindow();

    // Global access for the consolidated topbar dropdown menu.
    window.xyzV1Library = { show: () => this.showLibraryWindow() };
  },

  loadStyles() {
    // Create and inject CSS styles
    const style = document.createElement('style');
    style.textContent = `
      /* Prompt Library Window Styles */
      .prompt-library-window {
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
      }

      .prompt-library-window input[type="text"],
      .prompt-library-window input[type="number"] {
        background: rgba(30, 41, 59, 0.8) !important;
        border: 1px solid rgba(148, 163, 184, 0.3) !important;
        color: rgba(226, 232, 240, 0.9) !important;
      }

      .prompt-library-window input:focus {
        border-color: rgba(148, 163, 184, 0.6) !important;
        outline: none !important;
        box-shadow: 0 0 0 2px rgba(148, 163, 184, 0.2) !important;
      }

      .prompt-library-window input[type="checkbox"] {
        accent-color: rgba(148, 163, 184, 0.8);
      }

      .entry-item:hover {
        background: rgba(51, 65, 85, 0.8) !important;
        border: 2px solid rgba(148, 163, 184, 0.4) !important;
      }

      .group-item {
        transition: all 0.2s ease;
      }

      .group-item:hover,
      .group-item.expanded {
        background: rgba(51, 65, 85, 0.8) !important;
      }

      .groups-container {
        overflow-y: auto !important;
        min-height: 0 !important;
      }

      .prompt-library-window ::-webkit-scrollbar {
        width: 8px;
      }

      .prompt-library-window ::-webkit-scrollbar-track {
        background: rgba(15, 23, 42, 0.6);
        border-radius: 4px;
      }

      .prompt-library-window ::-webkit-scrollbar-thumb {
        background: rgba(148, 163, 184, 0.6);
        border-radius: 4px;
      }

      .prompt-library-window ::-webkit-scrollbar-thumb:hover {
        background: rgba(148, 163, 184, 0.8);
      }

      .prompt-library-window button:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
      }

      .prompt-library-window input,
      .prompt-library-window textarea {
        transition: all 0.2s ease;
      }

      .entry-item {
        transition: border-color 0.2s ease;
        position: relative;
        width: 100%;
        max-width: 100%;
        overflow: hidden;
      }

      .entry-item.selected {
        border: 2px solid rgba(255, 193, 7, 0.8) !important;
        box-shadow: 0 0 8px rgba(255, 193, 7, 0.6) !important;
      }

      .entry-item .save-to-disk-btn {
        opacity: 0.8;
        transition: opacity 0.2s ease;
      }

      .entry-item .save-to-disk-btn:hover {
        opacity: 1;
        transform: scale(1.1);
      }

      .entry-list-container {
        overflow-x: hidden;
        overflow-y: auto;
      }

      .prompt-library-window .resize-handle {
        position: absolute;
        background: rgba(148, 163, 184, 0.3);
        border-radius: 2px;
      }

      .prompt-library-window .resize-handle.right {
        right: 0;
        top: 0;
        width: 4px;
        height: 100%;
        cursor: ew-resize;
      }

      .prompt-library-window .resize-handle.bottom {
        bottom: 0;
        left: 0;
        width: 100%;
        height: 4px;
        cursor: ns-resize;
      }

      .prompt-library-window .resize-handle.corner {
        right: 0;
        bottom: 0;
        width: 8px;
        height: 8px;
        cursor: nw-resize;
      }

      .prompt-library-window .sort-controls {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
        align-items: center;
      }

      /* Side-by-side mode specific styles */
      .prompt-library-window .side-by-side-container {
        display: grid !important;
        grid-template-columns: 1fr 1fr !important;
        gap: 16px !important;
      }

      .prompt-library-window .side-by-side-container .detail-container,
      .prompt-library-window .side-by-side-container .simple-container {
        display: flex !important;
        flex-direction: column !important;
      }

      .prompt-library-window .side-by-side-container .simple-container textarea {
        flex: 1 !important;
        min-height: 120px !important;
        resize: none !important;
      }

      .prompt-library-window .side-by-side-container .detail-container .prompts-container {
        flex: 1 !important;
        overflow-y: auto !important;
        min-height: 120px !important;
      }

      .prompt-library-window .sort-controls select {
        background: rgba(30, 41, 59, 0.7);
        border: 1px solid rgba(148, 163, 184, 0.3);
        border-radius: 4px;
        color: rgba(226, 232, 240, 0.9);
        padding: 4px 8px;
        font-size: 11px;
        cursor: pointer;
      }

      .prompt-library-window .sort-controls select:focus {
        border-color: rgba(148, 163, 184, 0.6);
        outline: none;
      }

      /* Topbar button styles */
      .comfy-prompt-library-button {
        background: rgba(66, 153, 225, 0.9) !important;
        border: none !important;
        border-radius: 4px !important;
        color: white !important;
        padding: 8px 16px !important;
        font-size: 12px !important;
        cursor: pointer !important;
        transition: all 0.2s ease !important;
        margin-left: 8px !important;
      }

      .comfy-prompt-library-button:hover {
        background: rgba(66, 153, 225, 1) !important;
        transform: translateY(-1px) !important;
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2) !important;
      }

      .comfy-prompt-library-button:active {
        transform: translateY(0) !important;
      }

      /* Tag Toolkit Window Styles */
      .tag-toolkit-window {
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
      }

      .tag-toolkit-window input[type="checkbox"] {
        accent-color: rgba(66, 153, 225, 0.8);
      }

      .tag-toolkit-window select {
        background: rgba(30, 41, 59, 0.7) !important;
        border: 1px solid rgba(148, 163, 184, 0.3) !important;
        color: rgba(226, 232, 240, 0.9) !important;
      }

      .tag-toolkit-window select:focus {
        border-color: rgba(148, 163, 184, 0.6) !important;
        outline: none !important;
        box-shadow: 0 0 0 2px rgba(148, 163, 184, 0.2) !important;
      }

      .tag-toolkit-window .resize-handle {
        transition: background 0.2s ease;
      }

      .tag-toolkit-window .resize-handle:hover {
        background: linear-gradient(135deg, transparent 0%, transparent 50%, rgba(148, 163, 184, 0.8) 50%, rgba(148, 163, 184, 0.8) 100%) !important;
      }

      /* Ensure proper scrolling in tag toolkit */
      .tag-toolkit-window {
        display: flex !important;
        flex-direction: column !important;
      }

      .tag-toolkit-window .tag-toolkit-content {
        flex: 1 !important;
        min-height: 0 !important;
        overflow: hidden !important;
        display: flex !important;
        flex-direction: column !important;
      }

      .tag-toolkit-window .entries-list-section {
        flex: 1 !important;
        min-height: 0 !important;
        display: flex !important;
        flex-direction: column !important;
      }

      .tag-toolkit-window .entries-container {
        flex: 1 !important;
        min-height: 0 !important;
        overflow-y: scroll !important;
        overflow-x: hidden !important;
      }
    `;
    document.head.appendChild(style);
  },

  createLibraryWindow() {
    // Create the main window container
    const windowContainer = document.createElement('div');
    windowContainer.className = 'prompt-library-window';
    windowContainer.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 1200px;
      height: 800px;
      background: rgba(30, 41, 59, 0.95);
      border: 2px solid rgba(148, 163, 184, 0.6);
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      z-index: 10000;
      display: none;
      flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    // Create header
    const header = this.createWindowHeader(windowContainer);
    windowContainer.appendChild(header);

    // Create main content area
    const content = this.createWindowContent();
    windowContainer.appendChild(content);

    // Add resize handles
    this.addResizeHandles(windowContainer);

    // Add to document
    document.body.appendChild(windowContainer);

    // Store reference
    this.libraryWindow = windowContainer;
    this.libraryContent = content;

    // Initialize data
    this.initializeLibraryData();

    // Make window draggable
    this.makeWindowDraggable(windowContainer, header);
  },

  addResizeHandles(container) {
    // Right resize handle
    const rightHandle = document.createElement('div');
    rightHandle.className = 'resize-handle right';
    container.appendChild(rightHandle);

    // Bottom resize handle
    const bottomHandle = document.createElement('div');
    bottomHandle.className = 'resize-handle bottom';
    container.appendChild(bottomHandle);

    // Corner resize handle
    const cornerHandle = document.createElement('div');
    cornerHandle.className = 'resize-handle corner';
    container.appendChild(cornerHandle);

    // Make window resizable
    this.makeWindowResizable(container, rightHandle, bottomHandle, cornerHandle);
  },

  makeWindowResizable(container, rightHandle, bottomHandle, cornerHandle) {
    let isResizing = false;
    let startX, startY, startWidth, startHeight;

    const startResize = (e, handle) => {
      isResizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startWidth = parseInt(container.style.width);
      startHeight = parseInt(container.style.height);

      document.addEventListener('mousemove', resize);
      document.addEventListener('mouseup', stopResize);
      e.preventDefault();
    };

    const resize = e => {
      if (!isResizing) return;

      if (rightHandle.classList.contains('right') || cornerHandle.classList.contains('corner')) {
        const newWidth = startWidth + (e.clientX - startX);
        if (newWidth > 400) {
          container.style.width = newWidth + 'px';
        }
      }

      if (bottomHandle.classList.contains('bottom') || cornerHandle.classList.contains('corner')) {
        const newHeight = startHeight + (e.clientY - startY);
        if (newHeight > 300) {
          container.style.height = newHeight + 'px';
        }
      }
    };

    const stopResize = () => {
      isResizing = false;
      document.removeEventListener('mousemove', resize);
      document.removeEventListener('mouseup', stopResize);
    };

    rightHandle.addEventListener('mousedown', e => startResize(e, rightHandle));
    bottomHandle.addEventListener('mousedown', e => startResize(e, bottomHandle));
    cornerHandle.addEventListener('mousedown', e => startResize(e, cornerHandle));
  },

  makeWindowDraggable(container, header) {
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const startDrag = e => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = container.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener('mousemove', drag);
      document.addEventListener('mouseup', stopDrag);
      e.preventDefault();
    };

    const drag = e => {
      if (!isDragging) return;

      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      const newLeft = startLeft + deltaX;
      const newTop = startTop + deltaY;

      container.style.left = newLeft + 'px';
      container.style.top = newTop + 'px';
      container.style.transform = 'none';
    };

    const stopDrag = () => {
      isDragging = false;
      document.removeEventListener('mousemove', drag);
      document.removeEventListener('mouseup', stopDrag);
    };

    header.addEventListener('mousedown', startDrag);
  },

  createWindowHeader(container) {
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 16px;
      background: rgba(40, 44, 52, 0.8);
      border-bottom: 1px solid rgba(66, 153, 225, 0.3);
      border-radius: 8px 8px 0 0;
      cursor: move;
    `;

    // Title
    const title = document.createElement('h2');
    title.textContent = '📚 Prompt Library Manager';
    title.style.cssText = `
      margin: 0;
      color: rgba(226, 232, 240, 0.9);
      font-size: 16px;
      font-weight: 600;
    `;
    header.appendChild(title);

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `
      background: rgba(220, 53, 69, 0.8);
      border: none;
      border-radius: 4px;
      color: white;
      padding: 8px 12px;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s ease;
    `;
    closeBtn.addEventListener('click', () => {
      this.hideLibraryWindow();
    });
    header.appendChild(closeBtn);

    return header;
  },

  createWindowContent() {
    const content = document.createElement('div');
    content.style.cssText = `
      display: flex;
      flex: 1;
      overflow: hidden;
    `;

    // Create left panel
    const leftPanel = this.createLeftPanel();
    content.appendChild(leftPanel);

    // Create right panel
    const rightPanel = this.createRightPanel();
    content.appendChild(rightPanel);

    // Store references
    this.leftPanel = leftPanel;
    this.rightPanel = rightPanel;

    return content;
  },

  createLeftPanel() {
    const panel = document.createElement('div');
    panel.style.cssText = `
      width: 300px;
      background: rgba(35, 39, 47, 0.8);
      border-right: 1px solid rgba(66, 153, 225, 0.3);
      display: flex;
      flex-direction: column;
      padding: 16px;
    `;

    // Search section
    const searchSection = this.createSearchSection();
    panel.appendChild(searchSection);

    // Sorting controls
    const sortSection = this.createSortSection();
    panel.appendChild(sortSection);

    // Cited entries filter
    const citedFilterSection = this.createCitedFilterSection();
    panel.appendChild(citedFilterSection);

    // Entry list section
    const entryListSection = this.createEntryListSection();
    panel.appendChild(entryListSection);

    // Bottom action buttons
    const actionButtons = this.createActionButtons();
    panel.appendChild(actionButtons);

    return panel;
  },

  createCitedFilterSection() {
    const section = document.createElement('div');
    section.style.cssText = `
      margin-bottom: 16px;
      padding: 6px 10px;
      background: rgba(45, 55, 72, 0.6);
      border-radius: 6px;
      border: 1px solid rgba(66, 153, 225, 0.2);
    `;

    const container = document.createElement('div');
    container.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    `;

    // Left side: Cited only filter
    const filterContainer = document.createElement('div');
    filterContainer.style.cssText = `
      display: flex;
      align-items: center;
      gap: 6px;
    `;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'cited-entries-filter';
    checkbox.style.cssText = `
      margin: 0;
      cursor: pointer;
      width: 14px;
      height: 14px;
    `;
    checkbox.addEventListener('change', () => {
      this.filterCitedEntries();
    });

    const label = document.createElement('label');
    label.htmlFor = 'cited-entries-filter';
    label.textContent = '📋 Cited only';
    label.style.cssText = `
      color: rgba(226, 232, 240, 0.9);
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      user-select: none;
    `;

    filterContainer.appendChild(checkbox);
    filterContainer.appendChild(label);

    // Right side: Entries header with add button
    const entriesHeader = document.createElement('div');
    entriesHeader.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
    `;

    const entriesTitle = document.createElement('span');
    entriesTitle.textContent = '📚 Entries';
    entriesTitle.style.cssText = `
      color: rgba(226, 232, 240, 0.9);
      font-size: 12px;
      font-weight: 600;
    `;

    const addBtn = this.createButton('+', () => {
      this.createNewEntry();
    });
    addBtn.style.cssText += `
      padding: 3px 6px;
      font-size: 11px;
      min-width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    entriesHeader.appendChild(entriesTitle);
    entriesHeader.appendChild(addBtn);

    // Add both containers to main container
    container.appendChild(filterContainer);
    container.appendChild(entriesHeader);
    section.appendChild(container);

    // Store reference
    this.citedFilterCheckbox = checkbox;

    return section;
  },

  createActionButtons() {
    const container = document.createElement('div');
    container.style.cssText = `
      margin-top: auto;
      display: flex;
      gap: 6px;
    `;

    // Save all button
    const saveAllBtn = this.createButton('💾 Save All', () => {
      this.saveAllChanges();
    });
    saveAllBtn.style.cssText += `
      flex: 1;
      background: rgba(40, 167, 69, 0.8);
      padding: 8px;
      font-size: 12px;
    `;

    // Reload button
    const reloadBtn = this.createButton('🔄 Reload', () => {
      this.reloadEntries();
    });
    reloadBtn.style.cssText += `
      flex: 1;
      background: rgba(66, 153, 225, 0.8);
      padding: 8px;
      font-size: 12px;
    `;

    container.appendChild(saveAllBtn);
    container.appendChild(reloadBtn);

    return container;
  },

  createSearchSection() {
    const section = document.createElement('div');
    section.style.cssText = `
      margin-bottom: 20px;
    `;

    // Name search input
    const nameSearchInput = document.createElement('input');
    nameSearchInput.type = 'text';
    nameSearchInput.placeholder = 'Search by name...';
    nameSearchInput.style.cssText = `
      width: 100%;
      padding: 8px 12px;
      background: rgba(45, 55, 72, 0.7);
      border: 1px solid rgba(226, 232, 240, 0.2);
      border-radius: 4px;
      color: rgba(226, 232, 240, 0.9);
      font-size: 12px;
      box-sizing: border-box;
      margin-bottom: 8px;
      border-left: 3px solid rgba(66, 153, 225, 0.6);
    `;
    nameSearchInput.addEventListener('input', e => {
      this.nameSearchTerm = e.target.value;
      this.filterEntries();
    });
    section.appendChild(nameSearchInput);

    // Tag search input
    const tagSearchInput = document.createElement('input');
    tagSearchInput.type = 'text';
    tagSearchInput.placeholder = 'Search by tags...';
    tagSearchInput.style.cssText = `
      width: 100%;
      padding: 8px 12px;
      background: rgba(45, 55, 72, 0.7);
      border: 1px solid rgba(226, 232, 240, 0.2);
      border-radius: 4px;
      color: rgba(226, 232, 240, 0.9);
      font-size: 12px;
      box-sizing: border-box;
      border-left: 3px solid rgba(40, 167, 69, 0.6);
    `;
    tagSearchInput.addEventListener('input', e => {
      this.tagSearchTerm = e.target.value;
      this.filterEntries();
    });
    // Tag toolkit button
    const tagToolkitBtn = document.createElement('button');
    tagToolkitBtn.innerHTML = '🔧';
    tagToolkitBtn.title = 'Tag Toolkit';
    tagToolkitBtn.style.cssText = `
      background: rgba(66, 153, 225, 0.8);
      border: none;
      border-radius: 4px;
      color: white;
      padding: 8px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
      min-width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    tagToolkitBtn.addEventListener('click', () => {
      this.showTagToolkit();
    });

    // Create container for tag search and toolkit button
    const tagContainer = document.createElement('div');
    tagContainer.style.cssText = `
      display: flex;
      gap: 8px;
      align-items: center;
    `;

    // Update tag search input to use flex: 1
    tagSearchInput.style.width = 'auto';
    tagSearchInput.style.flex = '1';

    tagContainer.appendChild(tagSearchInput);
    tagContainer.appendChild(tagToolkitBtn);
    section.appendChild(tagContainer);

    // Store references
    this.nameSearchInput = nameSearchInput;
    this.tagSearchInput = tagSearchInput;

    return section;
  },

  createSortSection() {
    const section = document.createElement('div');
    section.style.cssText = `
      margin-bottom: 16px;
      padding: 8px 12px;
      background: rgba(45, 55, 72, 0.6);
      border-radius: 6px;
      border: 1px solid rgba(66, 153, 225, 0.2);
    `;

    const container = document.createElement('div');
    container.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
    `;

    const label = document.createElement('span');
    label.textContent = 'Sort:';
    label.style.cssText = `
      color: rgba(226, 232, 240, 0.8);
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
    `;

    // Sort by dropdown
    const sortBySelect = document.createElement('select');
    sortBySelect.innerHTML = `
      <option value="name">Name</option>
      <option value="createDate">Create Date</option>
      <option value="lastEdit">Last Edit</option>
    `;
    sortBySelect.addEventListener('change', () => {
      this.sortEntries();
    });
    this.sortBySelect = sortBySelect;

    // Sort order dropdown
    const sortOrderSelect = document.createElement('select');
    sortOrderSelect.innerHTML = `
      <option value="asc">Ascending</option>
      <option value="desc">Descending</option>
    `;
    sortOrderSelect.addEventListener('change', () => {
      this.sortEntries();
    });
    this.sortOrderSelect = sortOrderSelect;

    container.appendChild(label);
    container.appendChild(sortBySelect);
    container.appendChild(sortOrderSelect);
    section.appendChild(container);

    return section;
  },

  createEntryListSection() {
    const section = document.createElement('div');
    section.style.cssText = `
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0; /* Important for flexbox scrolling */
    `;

    // Entry list container - now properly scrollable
    const listContainer = document.createElement('div');
    listContainer.className = 'entry-list-container';
    listContainer.style.cssText = `
      flex: 1;
      overflow-y: auto;
      background: rgba(25, 29, 37, 0.6);
      border-radius: 4px;
      padding: 8px;
      min-height: 0; /* Important for flexbox scrolling */
    `;
    section.appendChild(listContainer);

    // Store reference
    this.entryListContainer = listContainer;

    return section;
  },

  createRightPanel() {
    const panel = document.createElement('div');
    panel.style.cssText = `
      flex: 1;
      background: rgba(30, 34, 42, 0.8);
      display: flex;
      flex-direction: column;
      padding: 16px;
    `;

    // Entry details section
    const detailsSection = this.createEntryDetailsSection();
    panel.appendChild(detailsSection);

    return panel;
  },

  createEntryDetailsSection() {
    const section = document.createElement('div');
    section.style.cssText = `
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
    `;

    // Entry properties form
    const propertiesForm = this.createEntryPropertiesForm();
    section.appendChild(propertiesForm);

    // Groups section
    const groupsSection = this.createGroupsSection();
    section.appendChild(groupsSection);

    return section;
  },

  createEntryPropertiesForm() {
    const form = document.createElement('div');
    form.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-bottom: 20px;
    `;

    // Top row: Entry Name, Shuffle, Weight, Random
    const topRow = document.createElement('div');
    topRow.style.cssText = `
      display: flex;
      gap: 12px;
      align-items: center;
    `;

    // Entry Name label and input
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Entry Name:';
    nameLabel.style.cssText = `
      color: rgba(226, 232, 240, 0.8);
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
    `;
    topRow.appendChild(nameLabel);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'entry-name';
    nameInput.style.cssText = `
      flex: 1;
      padding: 6px 8px;
      background: rgba(45, 55, 72, 0.7);
      border: 1px solid rgba(226, 232, 240, 0.2);
      border-radius: 4px;
      color: rgba(226, 232, 240, 0.9);
      font-size: 12px;
    `;
    nameInput.addEventListener('change', this.handleNameChange.bind(this));
    topRow.appendChild(nameInput);

    // Prefix label and input
    const prefixLabel = document.createElement('label');
    prefixLabel.textContent = 'Prefix:';
    prefixLabel.style.cssText = `
      color: rgba(226, 232, 240, 0.8);
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      margin-left: 8px;
    `;
    topRow.appendChild(prefixLabel);

    const prefixInput = document.createElement('input');
    prefixInput.type = 'text';
    prefixInput.id = 'entry-prefix';
    prefixInput.placeholder = 'e.g., "123-"';
    prefixInput.style.cssText = `
      width: 80px;
      padding: 6px 8px;
      background: rgba(45, 55, 72, 0.7);
      border: 1px solid rgba(226, 232, 240, 0.2);
      border-radius: 4px;
      color: rgba(226, 232, 240, 0.9);
      font-size: 12px;
    `;
    prefixInput.addEventListener('change', this.handlePrefixChange.bind(this));
    topRow.appendChild(prefixInput);

    // Insert button for entry name
    const insertEntryBtn = document.createElement('button');
    insertEntryBtn.textContent = 'Insert';
    insertEntryBtn.title = 'Insert [entry_name] into prompt template';
    insertEntryBtn.style.cssText = `
      background: rgba(66, 153, 225, 0.8);
      border: none;
      border-radius: 4px;
      color: white;
      padding: 6px 12px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.2s ease;
      white-space: nowrap;
    `;
    insertEntryBtn.addEventListener('click', () => {
      this.insertIntoPromptTemplate(`[${nameInput.value || 'entry_name'}]`);
    });
    topRow.appendChild(insertEntryBtn);

    // Shuffle label and checkbox
    const shuffleLabel = document.createElement('label');
    shuffleLabel.textContent = 'Shuffle:';
    shuffleLabel.style.cssText = `
      color: rgba(226, 232, 240, 0.8);
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      margin-left: 8px;
    `;
    topRow.appendChild(shuffleLabel);

    const shuffleInput = document.createElement('input');
    shuffleInput.type = 'checkbox';
    shuffleInput.id = 'entry-shuffle';
    shuffleInput.style.cssText = `
      margin: 0;
      cursor: pointer;
      width: 14px;
      height: 14px;
    `;
    shuffleInput.addEventListener('change', this.handleShuffleChange.bind(this));
    topRow.appendChild(shuffleInput);

    // Weight label and input
    const weightLabel = document.createElement('label');
    weightLabel.textContent = 'Weight:';
    weightLabel.style.cssText = `
      color: rgba(226, 232, 240, 0.8);
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      margin-left: 8px;
    `;
    topRow.appendChild(weightLabel);

    const weightInput = document.createElement('input');
    weightInput.type = 'text';
    weightInput.id = 'entry-weight';
    weightInput.value = '1';
    weightInput.style.cssText = `
      width: 80px;
      padding: 6px 8px;
      background: rgba(45, 55, 72, 0.7);
      border: 1px solid rgba(226, 232, 240, 0.2);
      border-radius: 4px;
      color: rgba(226, 232, 240, 0.9);
      font-size: 12px;
      text-align: center;
    `;
    weightInput.addEventListener('change', this.handleWeightChange.bind(this));
    topRow.appendChild(weightInput);

    // Random label and input
    const randomLabel = document.createElement('label');
    randomLabel.textContent = 'Random:';
    randomLabel.style.cssText = `
      color: rgba(226, 232, 240, 0.8);
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      margin-left: 8px;
    `;
    topRow.appendChild(randomLabel);

    const randomInput = document.createElement('input');
    randomInput.type = 'text';
    randomInput.id = 'entry-random';
    randomInput.value = '';
    randomInput.style.cssText = `
      width: 100px;
      padding: 6px 8px;
      background: rgba(45, 55, 72, 0.7);
      border: 1px solid rgba(226, 232, 240, 0.2);
      border-radius: 4px;
      color: rgba(226, 232, 240, 0.9);
      font-size: 12px;
      text-align: center;
    `;
    randomInput.addEventListener('change', this.handleRandomChange.bind(this));
    topRow.appendChild(randomInput);

    form.appendChild(topRow);

    // Tags row: label and input in one row
    const tagsRow = document.createElement('div');
    tagsRow.style.cssText = `
      display: flex;
      gap: 12px;
      align-items: center;
    `;

    const tagsLabel = document.createElement('label');
    tagsLabel.textContent = 'Tags:';
    tagsLabel.style.cssText = `
      color: rgba(226, 232, 240, 0.8);
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
    `;
    tagsRow.appendChild(tagsLabel);

    const tagsInput = document.createElement('input');
    tagsInput.type = 'text';
    tagsInput.id = 'entry-tags';
    tagsInput.placeholder = 'tag1, tag2, tag3';
    tagsInput.style.cssText = `
      flex: 1;
      padding: 6px 8px;
      background: rgba(45, 55, 72, 0.7);
      border: 1px solid rgba(226, 232, 240, 0.2);
      border-radius: 4px;
      color: rgba(226, 232, 240, 0.9);
      font-size: 12px;
    `;
    tagsInput.addEventListener('change', this.handleTagsChange.bind(this));
    tagsRow.appendChild(tagsInput);

    form.appendChild(tagsRow);

    return form;
  },

  createFormField(label, type, id, defaultValue = '') {
    const field = document.createElement('div');
    field.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 4px;
    `;

    const labelElement = document.createElement('label');
    labelElement.textContent = label;
    labelElement.style.cssText = `
      color: rgba(226, 232, 240, 0.8);
      font-size: 12px;
      font-weight: 500;
    `;
    field.appendChild(labelElement);

    let input;
    if (type === 'checkbox') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = defaultValue === 'true';
    } else {
      input = document.createElement('input');
      input.type = type;
      input.value = defaultValue;
    }

    input.id = id;
    input.style.cssText = `
      padding: 6px 8px;
      background: rgba(45, 55, 72, 0.7);
      border: 1px solid rgba(226, 232, 240, 0.2);
      border-radius: 4px;
      color: rgba(226, 232, 240, 0.9);
      font-size: 12px;
    `;

    // Only add generic change listener for non-tags inputs
    if (id !== 'entry-tags') {
      const self = this;
      input.addEventListener('change', e => {
        self.updateCurrentEntry();
      });
    }

    field.appendChild(input);

    return field;
  },

  createGroupsSection() {
    const section = document.createElement('div');
    section.style.cssText = `
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
    `;

    // Section header
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    `;

    const title = document.createElement('h4');
    title.textContent = 'Prompt Groups';
    title.style.cssText = `
      margin: 0;
      color: rgba(226, 232, 240, 0.8);
      font-size: 14px;
      font-weight: 600;
    `;
    header.appendChild(title);

    const addGroupBtn = this.createButton('+ New Group', () => {
      this.createNewGroup();
    });
    addGroupBtn.style.cssText += `
      padding: 6px 12px;
      font-size: 12px;
    `;
    header.appendChild(addGroupBtn);

    section.appendChild(header);

    // Groups container
    const groupsContainer = document.createElement('div');
    groupsContainer.className = 'groups-container';
    groupsContainer.style.cssText = `
      flex: 1;
      overflow-y: auto;
      background: rgba(25, 29, 37, 0.6);
      border-radius: 4px;
      padding: 8px;
      min-height: 0;
    `;
    section.appendChild(groupsContainer);

    // Store reference
    this.groupsContainer = groupsContainer;

    return section;
  },

  createButton(text, onClick) {
    const button = document.createElement('button');
    button.textContent = text;
    button.style.cssText = `
      background: rgba(66, 153, 225, 0.9);
      border: none;
      border-radius: 4px;
      color: white;
      padding: 8px 16px;
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

  // Window management methods
  showLibraryWindow() {
    if (this.libraryWindow) {
      this.libraryWindow.style.display = 'flex';
      this.refreshEntryList();
    }
  },

  // No standalone topbar button — consolidated into the XYZ dropdown menu.

  showTagToolkit() {
    if (!this.tagToolkitWindow) {
      this.tagToolkitWindow = new TagToolkitWindow(this);
    }
    this.tagToolkitWindow.show();
  },

  hideLibraryWindow() {
    if (this.libraryWindow) {
      this.libraryWindow.style.display = 'none';
    }
  },

  // Data management methods
  initializeLibraryData() {
    this.libraryData = {};
    this.entryStates = {}; // Track entry states (disk, temporary, modified)
    this.currentEntry = null;
    this.nameSearchTerm = '';
    this.tagSearchTerm = '';
    this.filteredEntries = [];
    this.loadLibraryData();
  },

  async loadLibraryData() {
    try {
      // Load from disk first
      await this.loadEntriesFromDisk();

      // Load from temporary storage and merge
      await this.loadEntriesFromTemporaryStorage();

      // Ensure all entries have required fields
      this.ensureEntryIntegrity();

      // Initialize filtered entries
      this.filteredEntries = Object.keys(this.libraryData);
      this.sortEntries();

      windowDebug('loadLibraryData', 'entries loaded', this.filteredEntries.length);

      // Push latest data into all prompt library nodes
      this.updateAllPromptLibraryNodes();
    } catch (error) {
      console.error('Error loading library data:', error);
      // Initialize with sample data for testing
      this.initializeSampleData();
    }
  },

  async loadEntriesFromDisk() {
    try {
      // Load from backend
      const response = await api.fetchApi('/xyz/prompt_library/entries');
      if (response.ok) {
        const data = await response.json();
        const diskEntries = data.entries || {};

        // Process disk entries - use ID as primary key
        Object.keys(diskEntries).forEach(entryId => {
          const entry = diskEntries[entryId];

          // Ensure entry has unique ID
          if (!entry.id) {
            entry.id = this.generateUniqueId();
          }

          // Initialize expansion states if they don't exist
          if (!entry.expansionStates) {
            entry.expansionStates = {};
          }

          // Store entry by ID for proper identification
          this.libraryData[entryId] = entry;

          // Mark as disk entry
          this.entryStates[entry.id] = {
            source: 'disk',
            modified: false,
            originalData: JSON.parse(JSON.stringify(entry)),
          };
        });
      }
    } catch (error) {
      console.error('Error loading entries from disk:', error);
    }
  },

  async loadEntriesFromTemporaryStorage() {
    try {
      const keys = Object.keys(localStorage);
      const tempKeys = keys.filter(key => key.startsWith('prompt_library_'));

      for (const key of tempKeys) {
        try {
          const entryData = JSON.parse(localStorage.getItem(key));
          if (entryData && entryData.id) {
            // Use ID as the key for consistency
            const entryId = entryData.id;

            if (this.libraryData[entryId]) {
              // Entry exists on disk, check if modified
              const diskEntry = this.libraryData[entryId];
              const isModified = !this.areEntriesEqual(diskEntry, entryData);

              if (isModified) {
                // Initialize expansion states if they don't exist
                if (!entryData.expansionStates) {
                  entryData.expansionStates = {};
                }

                // Update with temporary version and mark as modified
                this.libraryData[entryId] = entryData;
                this.entryStates[entryData.id] = {
                  source: 'disk',
                  modified: true,
                  originalData: this.entryStates[entryData.id]?.originalData || JSON.parse(JSON.stringify(entryData)),
                };
              }
            } else {
              // New entry only in temporary storage
              // Initialize expansion states if they don't exist
              if (!entryData.expansionStates) {
                entryData.expansionStates = {};
              }

              this.libraryData[entryId] = entryData;
              this.entryStates[entryData.id] = {
                source: 'temporary',
                modified: false,
                originalData: null,
              };
            }
          }
        } catch (error) {
          console.warn('Error parsing temporary storage entry:', error);
        }
      }
    } catch (error) {
      console.error('Error loading entries from temporary storage:', error);
    }
  },

  generateUniqueId() {
    return 'entry_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  },

  areEntriesEqual(entry1, entry2) {
    // Deep comparison of entries, excluding metadata fields
    const fieldsToCompare = ['active', 'shuffle', 'weight', 'random', 'tags', 'groups'];

    for (const field of fieldsToCompare) {
      if (JSON.stringify(entry1[field]) !== JSON.stringify(entry2[field])) {
        return false;
      }
    }

    return true;
  },

  ensureEntryIntegrity() {
    const now = new Date().toISOString();

    Object.keys(this.libraryData).forEach(entryId => {
      const entry = this.libraryData[entryId];

      // Ensure unique ID
      if (!entry.id) {
        entry.id = this.generateUniqueId();
      }

      // Ensure timestamps
      if (!entry.createDate) {
        entry.createDate = now;
      }
      if (!entry.lastEdit) {
        entry.lastEdit = entry.createDate || now;
      }

      // Ensure arrays exist
      if (!Array.isArray(entry.tags)) {
        entry.tags = [];
      }
      if (!Array.isArray(entry.groups)) {
        entry.groups = [];
      }

      // Ensure prefix property exists
      if (entry.prefix === undefined) {
        entry.prefix = '';
      }

      // Ensure expansion states exist
      if (!entry.expansionStates || typeof entry.expansionStates !== 'object') {
        entry.expansionStates = {};
      }

      // Ensure groups have prefix properties
      entry.groups.forEach(group => {
        if (group.prefix === undefined) {
          group.prefix = '';
        }
      });

      // Ensure entry state tracking
      if (!this.entryStates[entry.id]) {
        this.entryStates[entry.id] = {
          source: 'memory',
          modified: false,
          originalData: null,
        };
      }
    });
  },

  initializeSampleData() {
    const now = new Date().toISOString();
    this.libraryData = {
      'Sample Entry 1': {
        id: this.generateUniqueId(),
        name: 'Sample Entry 1',
        active: true,
        shuffle: false,
        weight: '1',
        random: '',
        tags: ['sample', 'test'],
        groups: [],
        expansionStates: {},
        createDate: now,
        lastEdit: now,
      },
      'Sample Entry 2': {
        id: this.generateUniqueId(),
        name: 'Sample Entry 2',
        active: false,
        shuffle: true,
        weight: '2',
        random: '0.5',
        tags: ['sample', 'demo'],
        groups: [],
        expansionStates: {},
        createDate: new Date(Date.now() - 86400000).toISOString(),
        lastEdit: now,
      },
    };

    // Initialize entry states
    Object.keys(this.libraryData).forEach(entryId => {
      const entry = this.libraryData[entryId];
      this.entryStates[entry.id] = {
        source: 'memory',
        modified: false,
        originalData: null,
      };
    });

    this.filteredEntries = Object.keys(this.libraryData);
    this.sortEntries();
  },

  refreshEntryList() {
    if (!this.entryListContainer) return;

    this.entryListContainer.innerHTML = '';

    if (this.filteredEntries.length === 0) {
      const placeholder = document.createElement('div');
      placeholder.style.cssText = `
        text-align: center;
        padding: 40px 20px;
        color: rgba(226, 232, 240, 0.5);
        font-style: italic;
      `;
      placeholder.textContent = 'No library entries found. Create your first entry!';
      this.entryListContainer.appendChild(placeholder);
      return;
    }

    this.filteredEntries.forEach(entryId => {
      const entryElement = this.createEntryElement(entryId);
      // Add data attribute for selection highlighting
      entryElement.setAttribute('data-entry-id', entryId);
      this.entryListContainer.appendChild(entryElement);
    });

    // Re-highlight current selection if exists
    if (this.currentEntry) {
      const currentElement = document.querySelector(`[data-entry-id="${this.currentEntry}"]`);
      if (currentElement) {
        currentElement.classList.add('selected');
      }
    }
  },

  /**
   * Create a new entry in the prompt library
   *
   * This method creates a new entry with default settings and automatically:
   * 1. Creates a new group within the entry
   * 2. Creates an empty prompt within the group
   * 3. Sets the group to be expanded by default
   * 4. Selects the new entry for editing
   *
   * The new entry is stored in temporary storage until saved to disk.
   */
  createNewEntry() {
    const entryName = `New Entry ${Object.keys(this.libraryData).length + 1}`;
    const now = new Date().toISOString();
    const newEntry = {
      id: this.generateUniqueId(),
      name: entryName,
      active: true,
      shuffle: false,
      weight: '1',
      random: '',
      tags: [],
      groups: [],
      expansionStates: {}, // Store which groups are expanded
      createDate: now,
      lastEdit: now,
    };

    // Store by ID for proper identification
    this.libraryData[newEntry.id] = newEntry;
    this.entryStates[newEntry.id] = {
      source: 'temporary',
      modified: false,
      originalData: null,
    };

    // Save to local storage
    this.saveEntryToLocalStorage(newEntry);

    this.filteredEntries = Object.keys(this.libraryData);
    this.sortEntries();
    this.refreshEntryList();
    this.selectEntry(newEntry.id);

    // Auto-create a group for the new entry
    this.createNewGroup();
  },

  saveEntryToLocalStorage(entry) {
    try {
      const key = `prompt_library_${entry.id}`;
      localStorage.setItem(key, JSON.stringify(entry));
    } catch (error) {
      console.error('Error saving entry to local storage:', error);
    }
  },

  removeEntryFromLocalStorage(entryId) {
    try {
      const key = `prompt_library_${entryId}`;
      localStorage.removeItem(key);
    } catch (error) {
      console.error('Error removing entry from local storage:', error);
    }
  },

  createEntryElement(entryId) {
    const element = document.createElement('div');
    element.className = 'entry-item';

    // Get entry and its state
    const entry = this.libraryData[entryId];
    const entryState = this.entryStates[entry.id];

    // Set fixed dimensions and layout
    element.style.cssText = `
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      background: rgba(45, 55, 72, 0.8);
      border: 2px solid rgba(75, 85, 99, 0.6);
      border-radius: 6px;
      margin-bottom: 4px;
      cursor: pointer;
      transition: border-color 0.2s ease;
      min-height: 36px;
      box-sizing: border-box;
      width: 100%;
    `;

    // Add data attribute for selection
    element.setAttribute('data-entry-id', entryId);

    element.addEventListener('click', () => {
      this.selectEntry(entryId);
    });

    // Active toggle - synchronized with right panel
    const activeToggle = document.createElement('input');
    activeToggle.type = 'checkbox';
    activeToggle.checked = entry?.active !== false;
    activeToggle.style.cssText = `
      margin: 0;
      cursor: pointer;
      flex-shrink: 0;
      width: 14px;
      height: 14px;
    `;

    // Prevent checkbox clicks from triggering parent click
    activeToggle.addEventListener('click', e => {
      e.stopPropagation();
    });

    activeToggle.addEventListener('change', e => {
      e.stopPropagation();

      if (entry) {
        entry.active = e.target.checked;

        // Update the entry state to mark as modified
        if (this.entryStates[entry.id]) {
          this.entryStates[entry.id].modified = true;
        }

        // Save to local storage
        this.saveEntryToLocalStorage(entry);

        // Update nodes immediately when entry is modified
        this.updateAllPromptLibraryNodes();

        // Refresh the entry list to show save/undo buttons
        this.refreshEntryList();

        // If this is the current selected entry, also update the form
        if (this.currentEntry === entryId) {
          this.updateCurrentEntry();
        }
      }
    });

    element.appendChild(activeToggle);

    // Entry name with flexible width and truncation
    const nameSpan = document.createElement('span');
    nameSpan.textContent = entry.name || entryId;
    nameSpan.style.cssText = `
      flex: 1;
      color: rgba(226, 232, 240, 0.9);
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    `;
    element.appendChild(nameSpan);

    // Save to disk button (only show for modified or temporary entries)
    if (entryState && (entryState.modified || entryState.source === 'temporary')) {
      const saveBtn = document.createElement('button');
      saveBtn.textContent = 'save';
      saveBtn.title = 'Save to disk';
      saveBtn.style.cssText = `
        background: rgba(40, 167, 69, 0.8);
      border: none;
        color: white;
      cursor: pointer;
        font-size: 10px;
        padding: 3px 6px;
        border-radius: 4px;
        flex-shrink: 0;
        width: 42px;
        height: 22px;
        font-weight: 500;
        transition: background 0.2s ease;
      `;
      saveBtn.addEventListener('click', e => {
        e.stopPropagation();
        this.saveEntryToDisk(entryId);
      });
      element.appendChild(saveBtn);
    }

    // Undo button (only show if entry is modified or temporary)
    if (entryState && (entryState.modified || entryState.source === 'temporary')) {
      const undoBtn = document.createElement('button');
      undoBtn.textContent = 'undo';
      undoBtn.style.cssText = `
        background: rgba(220, 53, 69, 0.8);
        border: none;
        color: white;
        cursor: pointer;
        font-size: 10px;
        font-weight: 600;
        padding: 3px 6px;
        border-radius: 4px;
        flex-shrink: 0;
        width: 42px;
        height: 22px;
        transition: background 0.2s ease;
      `;
      undoBtn.addEventListener('click', e => {
        e.stopPropagation();
        this.deleteEntry(entryId);
      });
      element.appendChild(undoBtn);
    }

    return element;
  },

  selectEntry(entryId) {
    // Remove previous selection highlight
    const prevSelected = document.querySelector('.entry-item.selected');
    if (prevSelected) {
      prevSelected.classList.remove('selected');
    }

    this.currentEntry = entryId;
    this.displayEntryDetails(entryId);

    // Add highlight to current selection
    const currentElement = document.querySelector(`[data-entry-id="${entryId}"]`);
    if (currentElement) {
      currentElement.classList.add('selected');
    }
  },

  displayEntryDetails(entryId) {
    const entry = this.libraryData[entryId];
    if (!entry) return;

    // Update form fields
    const nameInput = document.getElementById('entry-name');
    const prefixInput = document.getElementById('entry-prefix');
    const shuffleInput = document.getElementById('entry-shuffle');
    const weightInput = document.getElementById('entry-weight');
    const randomInput = document.getElementById('entry-random');
    const tagsInput = document.getElementById('entry-tags');

    if (nameInput) {
      nameInput.value = entry.name || '';
      // Remove existing event listener and add new one
      nameInput.removeEventListener('change', this.handleNameChange);
      nameInput.addEventListener('change', this.handleNameChange.bind(this));
    }

    if (prefixInput) {
      prefixInput.value = entry.prefix || '';
      // Remove existing event listener and add new one
      prefixInput.removeEventListener('change', this.handlePrefixChange);
      prefixInput.addEventListener('change', this.handlePrefixChange.bind(this));
    }

    if (shuffleInput) {
      shuffleInput.checked = entry.shuffle === true;
      // Remove existing event listener and add new one
      shuffleInput.removeEventListener('change', this.handleShuffleChange);
      shuffleInput.addEventListener('change', this.handleShuffleChange.bind(this));
    }
    if (weightInput) {
      weightInput.value = entry.weight || '1';
      // Remove existing event listener and add new one
      weightInput.removeEventListener('change', this.handleWeightChange);
      weightInput.addEventListener('change', this.handleWeightChange.bind(this));
    }
    if (randomInput) {
      randomInput.value = entry.random || '';
      // Remove existing event listener and add new one
      randomInput.removeEventListener('change', this.handleRandomChange);
      randomInput.addEventListener('change', this.handleRandomChange.bind(this));
    }
    if (tagsInput) {
      tagsInput.value = Array.isArray(entry.tags) ? entry.tags.join(', ') : '';
      // Remove existing event listener and add new one
      tagsInput.removeEventListener('change', this.handleTagsChange);
      tagsInput.addEventListener('change', this.handleTagsChange.bind(this));
    }

    // Display groups
    this.displayGroups(entry.groups || []);
  },

  handleNameChange(e) {
    const newName = e.target.value.trim();
    if (newName && this.currentEntry) {
      this.renameEntry(this.currentEntry, newName);
      // Update nodes immediately when name changes
      this.updateAllPromptLibraryNodes();
    }
  },

  handlePrefixChange(e) {
    if (!this.currentEntry) return;

    const entry = this.libraryData[this.currentEntry];
    if (!entry) return;

    entry.prefix = e.target.value;
    entry.lastEdit = new Date().toISOString();

    // Update entry state
    if (this.entryStates[entry.id]) {
      this.entryStates[entry.id] = {
        ...this.entryStates[entry.id],
        modified: true,
      };
    }

    // Refresh entry list to show save/undo buttons
    this.refreshEntryList();

    // Update nodes immediately when prefix changes
    this.updateAllPromptLibraryNodes();
  },

  handleTagsChange(e) {
    if (!this.currentEntry) return;

    const entry = this.libraryData[this.currentEntry];
    if (!entry) return;

    // Parse and update tags
    const newTags = e.target.value
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => tag);

    entry.tags = newTags;
    entry.lastEdit = new Date().toISOString();

    // Update entry state
    if (this.entryStates[entry.id]) {
      this.entryStates[entry.id] = {
        ...this.entryStates[entry.id],
        modified: true,
      };
    }

    // Save to local storage
    this.saveEntryToLocalStorage(entry);

    // Update all prompt library nodes with the modified data
    this.updateAllPromptLibraryNodes();

    // Refresh display to show modified state
    this.refreshEntryList();
  },

  handleShuffleChange(e) {
    if (!this.currentEntry) return;

    const entry = this.libraryData[this.currentEntry];
    if (!entry) return;

    entry.shuffle = e.target.checked;
    entry.lastEdit = new Date().toISOString();

    // Update entry state
    if (this.entryStates[entry.id]) {
      this.entryStates[entry.id] = {
        ...this.entryStates[entry.id],
        modified: true,
      };
    }

    // Save to local storage
    this.saveEntryToLocalStorage(entry);

    // Update all prompt library nodes with the modified data
    this.updateAllPromptLibraryNodes();

    // Refresh display to show modified state
    this.refreshEntryList();
  },

  handleWeightChange(e) {
    if (!this.currentEntry) return;

    const entry = this.libraryData[this.currentEntry];
    if (!entry) return;

    entry.weight = e.target.value;
    entry.lastEdit = new Date().toISOString();

    // Update entry state
    if (this.entryStates[entry.id]) {
      this.entryStates[entry.id] = {
        ...this.entryStates[entry.id],
        modified: true,
      };
    }

    // Save to local storage
    this.saveEntryToLocalStorage(entry);

    // Update all prompt library nodes with the modified data
    this.updateAllPromptLibraryNodes();

    // Refresh display to show modified state
    this.refreshEntryList();
  },

  handleRandomChange(e) {
    if (!this.currentEntry) return;

    const entry = this.libraryData[this.currentEntry];
    if (!entry) return;

    entry.random = e.target.value;
    entry.lastEdit = new Date().toISOString();

    // Update entry state
    if (this.entryStates[entry.id]) {
      this.entryStates[entry.id] = {
        ...this.entryStates[entry.id],
        modified: true,
      };
    }

    // Save to local storage
    this.saveEntryToLocalStorage(entry);

    // Update all prompt library nodes with the modified data
    this.updateAllPromptLibraryNodes();

    // Refresh display to show modified state
    this.refreshEntryList();
  },

  /**
   * Rename an entry and ensure the name is unique
   *
   * @param {string} oldId - The current entry ID
   * @param {string} newName - The new name for the entry
   */
  renameEntry(oldId, newName) {
    if (!this.libraryData[oldId]) return;

    const entry = this.libraryData[oldId];
    const entryId = entry.id;

    // Ensure the new name is unique
    const uniqueName = this.ensureUniqueEntryName(newName, oldId);

    // Update the entry name (keep same ID key)
    entry.name = uniqueName;
    entry.lastEdit = new Date().toISOString();

    // Update entry state
    if (this.entryStates[entryId]) {
      this.entryStates[entryId] = {
        ...this.entryStates[entryId],
        modified: true,
      };
    }

    // Update local storage
    this.saveEntryToLocalStorage(entry);

    // Refresh the list
    this.refreshEntryList();
  },

  /**
   * Ensure an entry name is unique by adding a number suffix if needed
   *
   * @param {string} baseName - The base name to make unique
   * @param {string} excludeEntryId - Entry ID to exclude from duplicate check
   * @returns {string} - A unique entry name
   */
  ensureUniqueEntryName(baseName, excludeEntryId) {
    let uniqueName = baseName;
    let counter = 1;

    // Check all entries (both from disk and local storage)
    const allEntries = this.getAllEntries();

    while (this.isEntryNameExists(uniqueName, excludeEntryId, allEntries)) {
      uniqueName = `${baseName} ${counter}`;
      counter++;
    }

    return uniqueName;
  },

  /**
   * Check if an entry name already exists
   *
   * @param {string} case-insensitive name comparison
   * @param {string} excludeEntryId - Entry ID to exclude from duplicate check
   * @param {Array} allEntries - Array of all entries to check against
   * @returns {boolean} - True if name exists, false otherwise
   */
  isEntryNameExists(name, excludeEntryId, allEntries) {
    return allEntries.some(
      entry => entry.id !== excludeEntryId && entry.name && entry.name.toLowerCase() === name.toLowerCase(),
    );
  },

  /**
   * Get all entries from both disk and local storage
   *
   * @returns {Array} - Array of all entries
   */
  getAllEntries() {
    const allEntries = [];

    // Add entries from libraryData (current working data)
    Object.values(this.libraryData).forEach(entry => {
      allEntries.push(entry);
    });

    // Add entries from local storage that might not be in libraryData
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('prompt_library_')) {
        try {
          const entryData = JSON.parse(localStorage.getItem(key));
          if (entryData && !this.libraryData[entryData.id]) {
            allEntries.push(entryData);
          }
        } catch (error) {
          console.warn('Error parsing local storage entry:', error);
        }
      }
    }

    return allEntries;
  },

  async saveEntryToDisk(entryId) {
    try {
      const entry = this.libraryData[entryId];
      if (!entry) return;

      // Make actual API call to save entry to disk using ID
      const response = await api.fetchApi('/xyz/prompt_library/entry', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: entry.id,
          data: entry,
        }),
      });

      if (response.ok) {
        // Update entry state
        if (this.entryStates[entry.id]) {
          this.entryStates[entry.id] = {
            source: 'disk',
            modified: false,
            originalData: JSON.parse(JSON.stringify(entry)),
          };
        }

        // Remove from local storage
        this.removeEntryFromLocalStorage(entry.id);

        // Refresh display
        this.refreshEntryList();

        // Update all prompt library nodes with the new data
        this.updateAllPromptLibraryNodes();

        this.showSuccess(`Entry "${entry.name}" saved to disk successfully!`, 10002);
      } else {
        const errorData = await response.json();
        this.showError(`Failed to save entry to disk: ${errorData.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Error saving entry to disk:', error);
      this.showError('Error saving entry to disk');
    }
  },

  displayGroups(groups) {
    if (!this.groupsContainer || !this.currentEntry) return;

    // Get the current entry to access its expansion states
    const currentEntry = this.libraryData[this.currentEntry];
    if (!currentEntry) return;

    // Initialize expansion states if they don't exist
    if (!currentEntry.expansionStates) {
      currentEntry.expansionStates = {};
    }

    // Store current expansion states before clearing (for saving)
    const currentExpansionStates = {};
    if (this.groupsContainer.children.length > 0) {
      this.groupsContainer.querySelectorAll('.group-item').forEach((item, index) => {
        if (item.groupContent && item.groupContent.style.display !== 'none') {
          // Get the group data from the element's data attribute
          const groupName = item.getAttribute('data-group-name') || `group_${index}`;
          currentExpansionStates[groupName] = true;
        }
      });

      // Save current expansion states to entry data
      if (Object.keys(currentExpansionStates).length > 0) {
        currentEntry.expansionStates = { ...currentEntry.expansionStates, ...currentExpansionStates };
      }
    }

    this.groupsContainer.innerHTML = '';

    if (groups.length === 0) {
      const placeholder = document.createElement('div');
      placeholder.style.cssText = `
        text-align: center;
        padding: 40px 20px;
        color: rgba(226, 232, 240, 0.5);
        font-style: italic;
      `;
      placeholder.textContent = 'No groups yet. Create your first group!';
      this.groupsContainer.appendChild(placeholder);
      return;
    }

    groups.forEach((group, index) => {
      const groupElement = this.createGroupElement(group, index);
      this.groupsContainer.appendChild(groupElement);

      // Restore expansion state from entry data
      let groupIdentifier;
      if (group.name && group.name.trim()) {
        groupIdentifier = group.name.trim();
      } else {
        // Create a unique identifier based on group content hash
        const contentHash = JSON.stringify(group).slice(0, 20); // First 20 chars of content
        groupIdentifier = `group_${index}_${contentHash}`;
      }

      // Check if this group should be expanded based on stored state
      if (currentEntry.expansionStates[groupIdentifier]) {
        const contentContainer = groupElement.groupContent;
        const expandBtn = groupElement.expandBtn;
        if (contentContainer && expandBtn) {
          contentContainer.style.display = 'block';
          expandBtn.textContent = '▲';
          this.updateGroupDisplay(group, index);
        }
      }
    });
  },

  createGroupElement(group, index) {
    const element = document.createElement('div');
    element.className = 'group-item';
    element.style.cssText = `
      background: rgba(55, 65, 82, 0.6);
      border-radius: 4px;
      margin-bottom: 8px;
      overflow: hidden;
    `;

    // Add data attribute to identify this group for expansion state tracking
    // Use group name if available, otherwise create a unique identifier based on content
    let groupIdentifier;
    if (group.name && group.name.trim()) {
      groupIdentifier = group.name.trim();
    } else {
      // Create a unique identifier based on group content hash
      const contentHash = JSON.stringify(group).slice(0, 20); // First 20 chars of content
      groupIdentifier = `group_${index}_${contentHash}`;
    }
    element.setAttribute('data-group-name', groupIdentifier);

    // Group header
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: rgba(45, 55, 72, 0.8);
    `;

    // Expand/collapse button (moved to leftmost position)
    const expandBtn = document.createElement('button');
    expandBtn.textContent = '▼';
    expandBtn.style.cssText = `
      background: none;
      border: none;
      color: rgba(148, 163, 184, 0.8);
      cursor: pointer;
      font-size: 12px;
      padding: 2px;
      width: 20px;
      height: 20px;
      transition: transform 0.2s ease;
    `;
    expandBtn.addEventListener('click', () => {
      this.toggleGroupExpansion(group, index, expandBtn);
    });
    header.appendChild(expandBtn);

    // Active toggle
    const activeToggle = document.createElement('input');
    activeToggle.type = 'checkbox';
    activeToggle.checked = group.active !== false;
    activeToggle.style.cssText = `
      margin: 0;
      cursor: pointer;
      width: 14px;
      height: 14px;
    `;
    activeToggle.addEventListener('change', e => {
      group.active = e.target.checked;
      this.updateCurrentEntry();

      // Update nodes immediately when group is modified
      this.updateAllPromptLibraryNodes();
    });
    header.appendChild(activeToggle);

    // Group name
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = group.name || `Group ${index + 1}`;
    nameInput.style.cssText = `
      flex: 1;
      background: transparent;
      border: none;
      color: rgba(226, 232, 240, 0.9);
      font-size: 12px;
      padding: 2px 4px;
    `;
    nameInput.addEventListener('change', e => {
      group.name = e.target.value;
      this.updateCurrentEntry();

      // Update nodes immediately when group name changes
      this.updateAllPromptLibraryNodes();
    });
    header.appendChild(nameInput);

    // Insert button for group name
    const insertGroupBtn = document.createElement('button');
    insertGroupBtn.textContent = 'Insert';
    insertGroupBtn.title = 'Insert [entry_name/group_name] into prompt template';
    insertGroupBtn.style.cssText = `
      background: rgba(66, 153, 225, 0.8);
      border: none;
      border-radius: 3px;
      color: white;
      padding: 2px 6px;
      font-size: 9px;
      cursor: pointer;
      transition: all 0.2s ease;
      white-space: nowrap;
      margin-left: 4px;
    `;
    insertGroupBtn.addEventListener('click', () => {
      const entryName = this.libraryData[this.currentEntry]?.name || 'entry_name';
      const groupName = nameInput.value || `Group ${index + 1}`;
      this.insertIntoPromptTemplate(`[${entryName}/${groupName}]`);
    });
    header.appendChild(insertGroupBtn);

    // Weight label and input
    const weightLabel = document.createElement('span');
    weightLabel.textContent = 'W:';
    weightLabel.style.cssText = `
      color: rgba(226, 232, 240, 0.7);
      font-size: 10px;
      font-weight: 500;
      white-space: nowrap;
    `;
    header.appendChild(weightLabel);

    const weightInput = document.createElement('input');
    weightInput.type = 'text';
    weightInput.value = group.weight || '1';
    weightInput.style.cssText = `
      width: 60px;
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 3px;
      color: rgba(226, 232, 240, 0.9);
      font-size: 10px;
      padding: 2px 4px;
      text-align: center;
    `;
    weightInput.addEventListener('change', e => {
      group.weight = e.target.value;
      this.updateCurrentEntry();
      this.updateAllPromptLibraryNodes();
    });
    header.appendChild(weightInput);

    // Random label and input
    const randomLabel = document.createElement('span');
    randomLabel.textContent = 'R:';
    randomLabel.style.cssText = `
      color: rgba(226, 232, 240, 0.7);
      font-size: 10px;
      font-weight: 500;
      white-space: nowrap;
    `;
    header.appendChild(randomLabel);

    const randomInput = document.createElement('input');
    randomInput.type = 'text';
    randomInput.value = group.random || '';
    randomInput.style.cssText = `
      width: 80px;
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 3px;
      color: rgba(226, 232, 240, 0.9);
      font-size: 10px;
      padding: 2px 4px;
      text-align: center;
    `;
    randomInput.addEventListener('change', e => {
      group.random = e.target.value;
      this.updateCurrentEntry();
      this.updateAllPromptLibraryNodes();
    });
    header.appendChild(randomInput);

    // Move up button
    const moveUpBtn = document.createElement('button');
    moveUpBtn.textContent = '↑';
    moveUpBtn.style.cssText = `
      background: none;
      border: none;
      color: rgba(148, 163, 184, 0.8);
      cursor: pointer;
      font-size: 12px;
      padding: 2px;
      width: 20px;
      height: 20px;
    `;
    moveUpBtn.addEventListener('click', () => {
      this.moveGroup(index, -1);
    });
    header.appendChild(moveUpBtn);

    // Move down button
    const moveDownBtn = document.createElement('button');
    moveDownBtn.textContent = '↓';
    moveDownBtn.style.cssText = `
      background: none;
      border: none;
      color: rgba(148, 163, 184, 0.8);
      cursor: pointer;
      font-size: 12px;
      padding: 2px;
      width: 20px;
      height: 20px;
    `;
    moveDownBtn.addEventListener('click', () => {
      this.moveGroup(index, 1);
    });
    header.appendChild(moveDownBtn);

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '×';
    deleteBtn.style.cssText = `
      background: none;
      border: none;
      color: rgba(220, 53, 69, 0.8);
      cursor: pointer;
      font-size: 14px;
      font-weight: bold;
      padding: 2px;
      width: 20px;
      height: 20px;
    `;
    deleteBtn.addEventListener('click', () => {
      this.deleteGroup(index);
    });
    header.appendChild(deleteBtn);

    element.appendChild(header);

    // Group content container (initially hidden)
    const contentContainer = document.createElement('div');
    contentContainer.className = 'group-content';
    contentContainer.style.cssText = `
      display: none;
      padding: 12px;
      background: rgba(35, 39, 47, 0.6);
    `;

    // Group properties row - all controls in one line
    const propertiesRow = document.createElement('div');
    propertiesRow.style.cssText = `
      display: flex;
      gap: 12px;
      margin-bottom: 12px;
      align-items: center;
    `;

    // Shuffle label and toggle
    const shuffleLabel = document.createElement('span');
    shuffleLabel.textContent = 'Shuffle:';
    shuffleLabel.style.cssText = `
      color: rgba(226, 232, 240, 0.8);
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
    `;
    propertiesRow.appendChild(shuffleLabel);

    const shuffleToggle = document.createElement('input');
    shuffleToggle.type = 'checkbox';
    shuffleToggle.checked = group.shuffle === true;
    shuffleToggle.style.cssText = `
      margin: 0;
      cursor: pointer;
      width: 14px;
      height: 14px;
    `;
    shuffleToggle.addEventListener('change', e => {
      group.shuffle = e.target.checked;
      this.updateCurrentEntry();
    });
    propertiesRow.appendChild(shuffleToggle);

    // Display mode label and buttons
    const modeLabel = document.createElement('span');
    modeLabel.textContent = 'Mode:';
    modeLabel.style.cssText = `
      color: rgba(226, 232, 240, 0.8);
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
      margin-left: 8px;
    `;
    propertiesRow.appendChild(modeLabel);

    // Display mode buttons container
    const modeButtonsContainer = document.createElement('div');
    modeButtonsContainer.style.cssText = `
      display: flex;
      gap: 2px;
    `;

    // Detail mode button
    const detailBtn = document.createElement('button');
    detailBtn.textContent = 'Detail';
    detailBtn.style.cssText = `
      background: ${group.displayMode === 'detail' ? 'rgba(66, 153, 225, 0.9)' : 'rgba(45, 55, 72, 0.7)'};
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 3px;
      color: white;
      padding: 3px 6px;
      font-size: 9px;
      cursor: pointer;
      transition: all 0.2s ease;
      min-width: 45px;
      height: 22px;
    `;
    detailBtn.addEventListener('click', () => {
      group.displayMode = 'detail';
      this.updateGroupDisplay(group, index);
      this.updateAllPromptLibraryNodes();
      this.updateModeButtonStates(modeButtonsContainer, 'detail');

      // Mark entry as modified and refresh list to show save/undo buttons
      if (this.currentEntry) {
        const entry = this.libraryData[this.currentEntry];
        if (entry && this.entryStates[entry.id]) {
          this.entryStates[entry.id].modified = true;
        }
        this.refreshEntryList();
      }
    });
    modeButtonsContainer.appendChild(detailBtn);

    // Simple mode button
    const simpleBtn = document.createElement('button');
    simpleBtn.textContent = 'Simple';
    simpleBtn.style.cssText = `
      background: ${group.displayMode === 'simple' ? 'rgba(66, 153, 225, 0.9)' : 'rgba(45, 55, 72, 0.7)'};
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 3px;
      color: white;
      padding: 3px 6px;
      font-size: 9px;
      cursor: pointer;
      transition: all 0.2s ease;
      min-width: 45px;
      height: 22px;
    `;
    simpleBtn.addEventListener('click', () => {
      group.displayMode = 'simple';
      this.updateGroupDisplay(group, index);
      this.updateAllPromptLibraryNodes();
      this.updateModeButtonStates(modeButtonsContainer, 'simple');

      // Mark entry as modified and refresh list to show save/undo buttons
      if (this.currentEntry) {
        const entry = this.libraryData[this.currentEntry];
        if (entry && this.entryStates[entry.id]) {
          this.entryStates[entry.id].modified = true;
        }
        this.refreshEntryList();
      }
    });
    modeButtonsContainer.appendChild(simpleBtn);

    // Side-by-side mode button
    const sideBySideBtn = document.createElement('button');
    sideBySideBtn.textContent = 'Both';
    sideBySideBtn.style.cssText = `
      background: ${group.displayMode === 'side-by-side' ? 'rgba(66, 153, 225, 0.9)' : 'rgba(45, 55, 72, 0.7)'};
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 3px;
      color: white;
      padding: 3px 6px;
      font-size: 9px;
      cursor: pointer;
      transition: all 0.2s ease;
      min-width: 45px;
      height: 22px;
    `;
    sideBySideBtn.addEventListener('click', () => {
      group.displayMode = 'side-by-side';
      this.updateGroupDisplay(group, index);
      this.updateAllPromptLibraryNodes();
      this.updateModeButtonStates(modeButtonsContainer, 'side-by-side');

      // Mark entry as modified and refresh list to show save/undo buttons
      if (this.currentEntry) {
        const entry = this.libraryData[this.currentEntry];
        if (entry && this.entryStates[entry.id]) {
          this.entryStates[entry.id].modified = true;
        }
        this.refreshEntryList();
      }
    });
    modeButtonsContainer.appendChild(sideBySideBtn);

    propertiesRow.appendChild(modeButtonsContainer);

    // Prefix label and input
    const prefixLabel = document.createElement('span');
    prefixLabel.textContent = 'Prefix:';
    prefixLabel.style.cssText = `
      color: rgba(226, 232, 240, 0.8);
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
      margin-left: 8px;
    `;
    propertiesRow.appendChild(prefixLabel);

    const prefixInput = document.createElement('input');
    prefixInput.type = 'text';
    prefixInput.placeholder = 'e.g., "1234-"';
    prefixInput.value = group.prefix || '';
    prefixInput.style.cssText = `
      width: 60px;
      padding: 3px 6px;
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 3px;
      color: rgba(226, 232, 240, 0.9);
      font-size: 10px;
      height: 22px;
      box-sizing: border-box;
    `;
    prefixInput.addEventListener('change', e => {
      group.prefix = e.target.value;
      this.updateCurrentEntry();

      // Mark entry as modified and refresh list to show save/undo buttons
      if (this.currentEntry) {
        const entry = this.libraryData[this.currentEntry];
        if (entry && this.entryStates[entry.id]) {
          this.entryStates[entry.id].modified = true;
        }
        this.refreshEntryList();
      }

      // Update nodes immediately when group prefix changes
      this.updateAllPromptLibraryNodes();
    });
    propertiesRow.appendChild(prefixInput);

    // Create new prompt button
    const addPromptBtn = this.createButton('+ New Prompt', () => {
      this.createNewPrompt(group, index);
    });
    addPromptBtn.style.cssText += `
      padding: 4px 8px;
      font-size: 10px;
      height: 22px;
      margin-left: auto;
    `;
    propertiesRow.appendChild(addPromptBtn);

    contentContainer.appendChild(propertiesRow);

    // Prompts display area
    const promptsArea = document.createElement('div');
    promptsArea.className = 'prompts-area';
    contentContainer.appendChild(promptsArea);

    element.appendChild(contentContainer);

    // Store references
    element.groupContent = contentContainer;
    element.promptsArea = promptsArea;
    element.expandBtn = expandBtn;

    return element;
  },

  /**
   * Create a new group within the current entry
   *
   * This method creates a new group with default settings and automatically:
   * 1. Sets the group to be expanded by default
   * 2. Creates an empty prompt within the group
   * 3. Updates the display to show the expanded group
   * 4. Synchronizes with the current entry data
   *
   * The group is created with default display mode 'detail' and empty prompt list.
   */
  createNewGroup() {
    if (!this.currentEntry) return;

    const groups = this.libraryData[this.currentEntry].groups || [];
    const newGroup = {
      name: `Group ${groups.length + 1}`,
      active: true,
      shuffle: false,
      weight: '1',
      random: '',
      prompts: [],
      displayMode: 'detail', // Set default display mode
    };

    groups.push(newGroup);

    // Set the group to be expanded by default
    if (!this.libraryData[this.currentEntry].expansionStates) {
      this.libraryData[this.currentEntry].expansionStates = {};
    }

    // Mark this group as expanded
    this.libraryData[this.currentEntry].expansionStates[newGroup.name] = true;

    // Auto-create a prompt in the new group using existing method
    this.createNewPrompt(newGroup, groups.length - 1);

    // Display the groups (this will show the expanded group with the prompt)
    this.displayGroups(groups);
    this.updateCurrentEntry();

    // Force expand the newly created group by finding it in the DOM
    setTimeout(() => {
      const groupElements = this.groupsContainer.querySelectorAll('.group-item');
      const lastGroupElement = groupElements[groupElements.length - 1];
      if (lastGroupElement && lastGroupElement.groupContent && lastGroupElement.expandBtn) {
        lastGroupElement.groupContent.style.display = 'block';
        lastGroupElement.expandBtn.textContent = '▲';
        this.updateGroupDisplay(newGroup, groups.length - 1);
      }
    }, 100);
  },

  async deleteEntry(entryId) {
    try {
      const entry = this.libraryData[entryId];
      if (!entry) return;

      // Determine storage location and action
      const entryState = this.entryStates[entry.id];
      let action = 'delete';
      let message = '';

      if (entryState) {
        if (entryState.source === 'temporary') {
          // Entry only exists in temporary storage
          action = 'delete';
          message = `Entry "${entry.name}" only exists in temporary storage. Delete it completely?`;
        } else if (entryState.source === 'disk') {
          if (entryState.modified) {
            // Entry exists on disk but has been modified
            action = 'revert';
            message = `Entry "${entry.name}" exists on disk but has been modified. Revert to disk version and discard changes?`;
          } else {
            // Entry exists on disk and is unmodified
            action = 'revert';
            message = `Entry "${entry.name}" exists on disk. Revert to disk version and discard any temporary changes?`;
          }
        }
      } else {
        // No entry state info, assume temporary
        action = 'delete';
        message = `Delete entry "${entry.name}"?`;
      }

      // Show confirmation dialog
      const confirmed = await this.showDeleteConfirmation(entryId, message);

      if (confirmed) {
        if (action === 'delete') {
          // Delete entry completely (from temporary storage)
          const entryId = entry.id;

          // Remove from library data
          delete this.libraryData[entryId];

          // Remove from entry states
          if (entryId) {
            delete this.entryStates[entryId];
          }

          // Remove from filtered entries
          const filteredIndex = this.filteredEntries.indexOf(entryId);
          if (filteredIndex > -1) {
            this.filteredEntries.splice(filteredIndex, 1);
          }

          // Remove from local storage if present
          if (entryId) {
            this.removeEntryFromLocalStorage(entryId);
          }

          // Clear current entry if it was the deleted one
          if (this.currentEntry === entryId) {
            this.currentEntry = null;
            this.clearEntryDetails();
          }

          // Refresh the display
          this.refreshEntryList();

          // Update all nodes after deletion
          this.updateAllPromptLibraryNodes();
        } else if (action === 'revert') {
          // Revert to disk version
          try {
            // Load the original disk version using entry ID
            const response = await api.fetchApi(`/xyz/prompt_library/entry/${encodeURIComponent(entry.id)}`);

            if (response.ok) {
              const diskEntry = await response.json();

              // Update the entry with disk version (keep same ID key)
              this.libraryData[entryId] = diskEntry;

              // Update entry state to reflect disk version
              if (entry.id) {
                this.entryStates[entry.id] = {
                  source: 'disk',
                  modified: false,
                  originalData: JSON.parse(JSON.stringify(diskEntry)),
                };
              }

              // Remove from local storage
              this.removeEntryFromLocalStorage(entry.id);

              // Refresh the display
              this.refreshEntryList();

              // Update all nodes after reverting to disk version
              this.updateAllPromptLibraryNodes();

              // Update current entry if it was the reverted one
              if (this.currentEntry === entryId) {
                this.displayEntryDetails(entryId);
              }
            } else {
              // If we can't load from disk, just delete it
              this.showError(`Failed to load disk version of entry. Deleting entry completely.`);
              await this.deleteEntry(entryId);
            }
          } catch (error) {
            console.error('Error reverting to disk version:', error);
            this.showError(`Failed to revert entry to disk version. Deleting entry completely.`);
            await this.deleteEntry(entryId);
          }
        }
      }
    } catch (error) {
      console.error('Error deleting entry:', error);
      this.showError('Error deleting entry');
    }
  },

  checkIfEntryInTemporaryStorage(entryId) {
    // Check if entry exists in localStorage
    try {
      const keys = Object.keys(localStorage);
      const entryKeys = keys.filter(key => key.includes('prompt_library') && key.includes(entryId));
      return entryKeys.length > 0;
    } catch (error) {
      return false;
    }
  },

  checkIfEntryOnDisk(entryId) {
    // Check if entry file exists on disk by looking for it in the library data
    // This is a simplified check - in a real implementation, you might want to make an API call
    return this.libraryData[entryId] && this.libraryData[entryId].createDate;
  },

  async showDeleteConfirmation(entryId, message) {
    return new Promise(resolve => {
      // Create a custom confirmation dialog with high z-index
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(0, 0, 0, 0.7);
        z-index: 10002;
        display: flex;
        align-items: center;
        justify-content: center;
      `;

      const dialog = document.createElement('div');
      dialog.style.cssText = `
        background: rgba(45, 55, 72, 0.95);
        border: 2px solid rgba(220, 53, 69, 0.8);
        border-radius: 8px;
        padding: 24px;
        max-width: 500px;
        width: 90%;
        color: white;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.8);
      `;

      dialog.innerHTML = `
        <h3 style="margin: 0 0 16px 0; color: rgba(220, 53, 69, 0.9); font-size: 18px;">
          🗑️ Entry Action Required
        </h3>
        <p style="margin: 0 0 20px 0; line-height: 1.5; font-size: 14px;">
          ${message}
        </p>
        <p style="margin: 0 0 24px 0; line-height: 1.5; font-size: 14px; color: rgba(220, 53, 69, 0.9);">
          ⚠️ This action cannot be undone!
        </p>
        <div style="display: flex; gap: 12px; justify-content: flex-end;">
          <button id="cancel-delete" style="
            background: rgba(108, 117, 125, 0.8);
            border: none;
            color: white;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.2s ease;
          ">Cancel</button>
          <button id="confirm-delete" style="
            background: rgba(220, 53, 69, 0.9);
            border: none;
            color: white;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: bold;
            transition: background 0.2s ease;
          ">Confirm</button>
        </div>
      `;

      // Add hover effects
      const cancelBtn = dialog.querySelector('#cancel-delete');
      const confirmBtn = dialog.querySelector('#confirm-delete');

      cancelBtn.addEventListener('mouseenter', () => {
        cancelBtn.style.background = 'rgba(108, 117, 125, 1)';
      });
      cancelBtn.addEventListener('mouseleave', () => {
        cancelBtn.style.background = 'rgba(108, 117, 125, 0.8)';
      });

      confirmBtn.addEventListener('mouseenter', () => {
        confirmBtn.style.background = 'rgba(220, 53, 69, 1)';
      });
      confirmBtn.addEventListener('mouseleave', () => {
        confirmBtn.style.background = 'rgba(220, 53, 69, 0.9)';
      });

      // Add event listeners
      cancelBtn.addEventListener('click', () => {
        overlay.remove();
        resolve(false);
      });

      confirmBtn.addEventListener('click', () => {
        overlay.remove();
        resolve(true);
      });

      // Close on overlay click (outside dialog)
      overlay.addEventListener('click', e => {
        if (e.target === overlay) {
          overlay.remove();
          resolve(false);
        }
      });

      // Close on Escape key
      const handleEscape = e => {
        if (e.key === 'Escape') {
          overlay.remove();
          document.removeEventListener('keydown', handleEscape);
          resolve(false);
        }
      };
      document.addEventListener('keydown', handleEscape);

      // Add to DOM
      document.body.appendChild(overlay);
      overlay.appendChild(dialog);

      // Focus the confirm button for keyboard navigation
      setTimeout(() => confirmBtn.focus(), 100);
    });
  },

  filterCitedEntries() {
    if (!this.citedFilterCheckbox) return;

    const showOnlyCited = this.citedFilterCheckbox.checked;

    if (showOnlyCited) {
      // Filter to show only entries that are cited in prompt templates
      this.filteredEntries = this.filteredEntries.filter(entryId => {
        return this.isEntryCited(entryId);
      });
    } else {
      // Show all entries (re-apply current search filter)
      this.filterEntries();
    }

    this.sortEntries();
    this.refreshEntryList();
  },

  isEntryCited(entryId) {
    // Check if the entry is cited in any prompt templates
    const entry = this.libraryData[entryId];
    if (!entry) return false;

    // Try to scan for actual prompt template usage
    const isCited = this.scanPromptTemplatesForCitation(entryId, entry);

    return isCited;
  },

  scanPromptTemplatesForCitation(entryId, entry) {
    try {
      // Look for prompt templates in the current ComfyUI workspace
      // This is a simplified scan - in a real implementation, you'd want to scan all nodes

      // Check if there are any prompt template nodes in the current graph
      if (app && app.graph) {
        const nodes = app.graph._nodes || [];

        // Look for nodes that might contain prompt templates
        for (const node of nodes) {
          if (node.widgets) {
            for (const widget of node.widgets) {
              if (widget.value && typeof widget.value === 'string') {
                const templateText = widget.value;

                // Check for direct entry citation: [entry_name]
                if (templateText.includes(`[${entry.name}]`)) {
                  return true;
                }

                // Check for group citation: [entry_name/group_name]
                const groups = entry.groups || [];
                for (const group of groups) {
                  if (templateText.includes(`[${entry.name}/${group.name}]`)) {
                    return true;
                  }
                }

                // Check for tag citation: [[tag_name]]
                const tags = entry.tags || [];
                for (const tag of tags) {
                  if (templateText.includes(`[[${tag}]]`)) {
                    return true;
                  }
                }
              }
            }
          }
        }
      }

      // Also check localStorage for saved prompt templates
      try {
        const keys = Object.keys(localStorage);
        for (const key of keys) {
          if (key.includes('prompt') || key.includes('template')) {
            const value = localStorage.getItem(key);
            if (value && typeof value === 'string') {
              // Check for citations in the stored template
              if (value.includes(`[${entry.name}]`)) {
                return true;
              }

              // Check for group citations
              const groups = entry.groups || [];
              for (const group of groups) {
                if (value.includes(`[${entry.name}/${group.name}]`)) {
                  return true;
                }
              }

              // Check for tag citations
              const tags = entry.tags || [];
              for (const tag of tags) {
                if (value.includes(`[[${tag}]]`)) {
                  return true;
                }
              }
            }
          }
        }
      } catch (error) {
        // Ignore localStorage errors
      }

      return false;
    } catch (error) {
      console.warn('Error scanning prompt templates for citation:', error);
      return false;
    }
  },

  /**
   * Delete a group from the current entry with custom confirmation dialog
   *
   * @param {number} index - Index of the group to delete
   */
  async deleteGroup(index) {
    if (!this.currentEntry) return;

    const groups = this.libraryData[this.currentEntry].groups || [];
    const groupName = groups[index]?.name || `Group ${index + 1}`;

    const confirmed = await this.showGroupDeleteConfirmation(groupName);
    if (confirmed) {
      groups.splice(index, 1);
      this.displayGroups(groups);
      this.updateCurrentEntry();
    }
  },

  /**
   * Show confirmation dialog for group deletion
   *
   * @param {string} groupName - Name of the group to be deleted
   * @returns {Promise<boolean>} - True if confirmed, false if cancelled
   */
  async showGroupDeleteConfirmation(groupName) {
    return new Promise(resolve => {
      // Create a custom confirmation dialog with high z-index
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(0, 0, 0, 0.7);
        z-index: 10002;
        display: flex;
        align-items: center;
        justify-content: center;
      `;

      const dialog = document.createElement('div');
      dialog.style.cssText = `
        background: rgba(45, 55, 72, 0.95);
        border: 2px solid rgba(220, 53, 69, 0.8);
        border-radius: 8px;
        padding: 24px;
        max-width: 500px;
        width: 90%;
        color: white;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.8);
      `;

      dialog.innerHTML = `
        <h3 style="margin: 0 0 16px 0; color: rgba(220, 53, 69, 0.9); font-size: 18px;">
          🗑️ Delete Group
        </h3>
        <p style="margin: 0 0 20px 0; line-height: 1.5; font-size: 14px;">
          Are you sure you want to delete the group "<strong>${groupName}</strong>"?
        </p>
        <p style="margin: 0 0 24px 0; line-height: 1.5; font-size: 14px; color: rgba(220, 53, 69, 0.9);">
          ⚠️ This action cannot be undone!
        </p>
        <div style="display: flex; gap: 12px; justify-content: flex-end;">
          <button id="cancel-delete-group" style="
            background: rgba(108, 117, 125, 0.8);
            border: none;
            color: white;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.2s ease;
          ">Cancel</button>
          <button id="confirm-delete-group" style="
            background: rgba(220, 53, 69, 0.9);
            border: none;
            color: white;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: bold;
            transition: background 0.2s ease;
          ">Delete Group</button>
        </div>
      `;

      // Add hover effects
      const cancelBtn = dialog.querySelector('#cancel-delete-group');
      const confirmBtn = dialog.querySelector('#confirm-delete-group');

      cancelBtn.addEventListener('mouseenter', () => {
        cancelBtn.style.background = 'rgba(108, 117, 125, 1)';
      });
      cancelBtn.addEventListener('mouseleave', () => {
        cancelBtn.style.background = 'rgba(108, 117, 125, 0.8)';
      });

      confirmBtn.addEventListener('mouseenter', () => {
        confirmBtn.style.background = 'rgba(220, 53, 69, 1)';
      });
      confirmBtn.addEventListener('mouseleave', () => {
        confirmBtn.style.background = 'rgba(220, 53, 69, 0.9)';
      });

      // Add event listeners
      cancelBtn.addEventListener('click', () => {
        overlay.remove();
        resolve(false);
      });

      confirmBtn.addEventListener('click', () => {
        overlay.remove();
        resolve(true);
      });

      // Close on overlay click (outside dialog)
      overlay.addEventListener('click', e => {
        if (e.target === overlay) {
          overlay.remove();
          resolve(false);
        }
      });

      // Close on Escape key
      const handleEscape = e => {
        if (e.key === 'Escape') {
          overlay.remove();
          document.removeEventListener('keydown', handleEscape);
          resolve(false);
        }
      };
      document.addEventListener('keydown', handleEscape);

      // Add to DOM
      document.body.appendChild(overlay);
      overlay.appendChild(dialog);
    });
  },

  clearEntryDetails() {
    // Clear form fields
    const inputs = ['entry-name', 'entry-shuffle', 'entry-weight', 'entry-random', 'entry-tags'];
    inputs.forEach(id => {
      const input = document.getElementById(id);
      if (input) {
        if (input.type === 'checkbox') {
          input.checked = false;
        } else {
          input.value = '';
        }
      }
    });

    // Clear groups
    if (this.groupsContainer) {
      this.groupsContainer.innerHTML = '';
    }
  },

  updateCurrentEntry() {
    if (!this.currentEntry) return;

    const entry = this.libraryData[this.currentEntry];
    if (!entry) return;

    // Update entry properties from form
    const nameInput = document.getElementById('entry-name');
    const prefixInput = document.getElementById('entry-prefix');
    const shuffleInput = document.getElementById('entry-shuffle');
    const weightInput = document.getElementById('entry-weight');
    const randomInput = document.getElementById('entry-random');
    const tagsInput = document.getElementById('entry-tags');

    // Handle entry renaming
    if (nameInput && nameInput.value !== this.currentEntry) {
      const newName = nameInput.value.trim();
      if (newName && newName !== this.currentEntry) {
        this.renameEntry(this.currentEntry, newName);
        return; // Exit early as renameEntry handles the rest
      }
    }

    // Update other properties
    if (prefixInput) entry.prefix = prefixInput.value;
    if (shuffleInput) entry.shuffle = shuffleInput.checked;
    if (weightInput) entry.weight = weightInput.value;
    if (randomInput) entry.random = randomInput.value;
    if (tagsInput) {
      const newTags = tagsInput.value
        .split(',')
        .map(tag => tag.trim())
        .filter(tag => tag);
      entry.tags = newTags;
    }

    // Update last edit timestamp
    entry.lastEdit = new Date().toISOString();

    // Mark as modified and save to local storage
    if (this.entryStates[entry.id]) {
      this.entryStates[entry.id] = {
        ...this.entryStates[entry.id],
        modified: true,
      };
    }

    // Save to local storage
    this.saveEntryToLocalStorage(entry);

    // Update all prompt library nodes with the modified data
    this.updateAllPromptLibraryNodes();

    // Refresh display to show modified state
    this.refreshEntryList();
  },

  async reloadEntries() {
    try {
      // Show loading state
      const reloadBtn = document.querySelector('.prompt-library-window button[onclick*="reloadEntries"]');
      if (reloadBtn) {
        reloadBtn.textContent = '⏳ Loading...';
        reloadBtn.disabled = true;
      }

      // First, perform undo action for all modified entries
      await this.undoAllModifiedEntries();

      // Clear current data
      this.libraryData = {};
      this.entryStates = {};
      this.currentEntry = null;

      // Reload from disk and temporary storage
      await this.loadLibraryData();

      // Refresh the display
      this.refreshEntryList();

      // Update all prompt library nodes with the new data
      this.updateAllPromptLibraryNodes();

      // Show success message
      this.showSuccess('Entries reloaded successfully! All changes undone and new entries loaded.', 10001);
    } catch (error) {
      console.error('Error reloading entries:', error);
      this.showError('Failed to reload entries', 10001);
    } finally {
      // Reset button state
      const reloadBtn = document.querySelector('.prompt-library-window button[onclick*="reloadEntries"]');
      if (reloadBtn) {
        reloadBtn.textContent = '🔄 Reload';
        reloadBtn.disabled = false;
      }
    }
  },

  async undoAllModifiedEntries() {
    try {
      // Get all entries that have been modified
      const modifiedEntries = {};
      Object.keys(this.libraryData).forEach(entryId => {
        const entry = this.libraryData[entryId];
        const entryState = this.entryStates[entry.id];

        if (entryState && entryState.modified) {
          modifiedEntries[entryId] = entry;
        }
      });

      if (Object.keys(modifiedEntries).length === 0) {
        return;
      }

      // For each modified entry, try to load the original disk version
      for (const [entryId, entry] of Object.entries(modifiedEntries)) {
        try {
          // Try to load the original disk version
          const response = await api.fetchApi(`/xyz/prompt_library/entry/${encodeURIComponent(entry.id)}`);

          if (response.ok) {
            const diskEntry = await response.json();

            // Replace the modified entry with the disk version
            this.libraryData[entryId] = diskEntry;

            // Update entry state to reflect disk source
            if (this.entryStates[entry.id]) {
              this.entryStates[entry.id] = {
                source: 'disk',
                modified: false,
                originalData: JSON.parse(JSON.stringify(diskEntry)),
              };
            }

            // Entry reverted to disk version
          } else {
            // If disk version not found, mark as temporary and unmodified
            if (this.entryStates[entry.id]) {
              this.entryStates[entry.id] = {
                source: 'temporary',
                modified: false,
                originalData: null,
              };
            }
          }
        } catch (error) {
          console.error(`Error reverting entry "${entry.name}":`, error);
          // Mark as temporary and unmodified if there's an error
          if (this.entryStates[entry.id]) {
            this.entryStates[entry.id] = {
              source: 'temporary',
              modified: false,
              originalData: null,
            };
          }
        }
      }

      // Remove all modified entries from local storage
      Object.keys(modifiedEntries).forEach(entryId => {
        const entry = this.libraryData[entryId];
        if (entry && entry.id) {
          this.removeEntryFromLocalStorage(entry.id);
        }
      });

      // CRITICAL: Update all nodes after reverting entries to ensure widget synchronization
      this.updateAllPromptLibraryNodes();

      // Successfully undone all modified entries
    } catch (error) {
      console.error('Error undoing modified entries:', error);
      throw error;
    }
  },

  async saveAllChanges() {
    try {
      // Get all entries that need to be saved (modified or temporary)
      const entriesToSave = {};
      Object.keys(this.libraryData).forEach(entryId => {
        const entry = this.libraryData[entryId];
        const entryState = this.entryStates[entry.id];

        if (entryState && (entryState.modified || entryState.source === 'temporary')) {
          entriesToSave[entryId] = entry;
        }
      });

      if (Object.keys(entriesToSave).length === 0) {
        this.showSuccess('No changes to save!', 10001);
        return;
      }

      // Make actual API call to save all entries to disk
      const response = await api.fetchApi('/xyz/prompt_library/save_all', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          entries: entriesToSave,
        }),
      });

      if (response.ok) {
        const result = await response.json();

        // Mark all saved entries as disk entries
        Object.keys(entriesToSave).forEach(entryId => {
          const entry = entriesToSave[entryId];
          if (this.entryStates[entry.id]) {
            this.entryStates[entry.id] = {
              source: 'disk',
              modified: false,
              originalData: JSON.parse(JSON.stringify(entry)),
            };
          }

          // Remove from local storage
          this.removeEntryFromLocalStorage(entry.id);
        });

        // Refresh display
        this.refreshEntryList();

        // Update all prompt library nodes with the new data
        this.updateAllPromptLibraryNodes();

        this.showSuccess(`${result.saved_count} entries saved to disk successfully!`, 10001);
      } else {
        const errorData = await response.json();
        this.showError(`Failed to save changes: ${errorData.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Error saving changes:', error);
      this.showError('Error saving changes');
    }
  },

  filterEntries() {
    const nameTerm = (this.nameSearchTerm || '').trim().toLowerCase();
    const tagTerm = (this.tagSearchTerm || '').trim().toLowerCase();

    // If both search terms are empty, show all entries
    if (!nameTerm && !tagTerm) {
      this.filteredEntries = Object.keys(this.libraryData);
    } else {
      this.filteredEntries = Object.keys(this.libraryData).filter(entryId => {
        const entry = this.libraryData[entryId];
        let matchesName = true;
        let matchesTag = true;

        // Check name match if name search term exists
        if (nameTerm) {
          matchesName = entry.name.toLowerCase().includes(nameTerm);
        }

        // Check tag match if tag search term exists
        if (tagTerm) {
          const tags = entry.tags || [];
          matchesTag = tags.some(tag => tag.toLowerCase().includes(tagTerm));
        }

        // Entry must match both search criteria (if both exist)
        return matchesName && matchesTag;
      });
    }

    // Apply cited filter if it's enabled
    if (this.citedFilterCheckbox && this.citedFilterCheckbox.checked) {
      this.filteredEntries = this.filteredEntries.filter(entryId => {
        return this.isEntryCited(entryId);
      });
    }

    this.sortEntries();
    this.refreshEntryList();
  },

  sortEntries() {
    if (!this.filteredEntries.length) return;

    const sortBy = this.sortBySelect?.value || 'name';
    const sortOrder = this.sortOrderSelect?.value || 'asc';

    this.filteredEntries.sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case 'name':
          const nameA = this.libraryData[a]?.name || '';
          const nameB = this.libraryData[b]?.name || '';
          comparison = nameA.localeCompare(nameB);
          break;
        case 'createDate':
          const createA = this.libraryData[a]?.createDate || '';
          const createB = this.libraryData[b]?.createDate || '';
          comparison = createA.localeCompare(createB);
          break;
        case 'lastEdit':
          const editA = this.libraryData[a]?.lastEdit || '';
          const editB = this.libraryData[b]?.lastEdit || '';
          comparison = editA.localeCompare(editB);
          break;
      }

      return sortOrder === 'desc' ? -comparison : comparison;
    });

    this.refreshEntryList();
  },

  showPopup(message, type = 'info', zIndex = 10002, autoRemoveDelay = 5000) {
    const colors = {
      error: 'rgba(220, 53, 69, 0.95)',
      success: 'rgba(40, 167, 69, 0.95)',
      info: 'rgba(148, 163, 184, 0.95)',
    };

    const titles = {
      error: 'Error',
      success: 'Success',
      info: 'Info',
    };

    const popup = document.createElement('div');
    popup.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: ${colors[type] || colors.info};
      color: white;
      padding: 20px;
      border-radius: 8px;
      z-index: ${zIndex};
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    `;

    popup.innerHTML = `
      <h3 style="margin: 0 0 10px 0;">${titles[type] || titles.info}</h3>
      <p style="margin: 0 0 15px 0;">${message}</p>
      <button onclick="this.parentElement.remove()" style="
        background: rgba(255, 255, 255, 0.2);
        border: none;
        color: white;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
      ">OK</button>
    `;

    document.body.appendChild(popup);

    // Auto-remove after specified delay
    setTimeout(() => {
      if (popup.parentElement) {
        popup.remove();
      }
    }, autoRemoveDelay);
  },

  showError(message, zIndex = 10002) {
    console.error('Prompt Library Error:', message);
    this.showPopup(message, 'error', zIndex, 5000);
  },

  showSuccess(message, zIndex = 10002) {
    this.showPopup(message, 'success', zIndex, 3000);
  },

  moveGroup(index, direction) {
    if (!this.currentEntry) return;

    const groups = this.libraryData[this.currentEntry].groups || [];
    const newIndex = index + direction;

    if (newIndex >= 0 && newIndex < groups.length) {
      // Reorder the groups
      const temp = groups[index];
      groups[index] = groups[newIndex];
      groups[newIndex] = temp;

      // Update the groups array in the entry data
      this.libraryData[this.currentEntry].groups = groups;

      // Redisplay groups with preserved expansion states
      this.displayGroups(groups);
      this.updateCurrentEntry();

      // Update nodes immediately when group order changes
      this.updateAllPromptLibraryNodes();
    }
  },

  toggleGroupExpansion(group, index, expandBtn) {
    if (!this.currentEntry) return;

    const groupElement = expandBtn.closest('.group-item');
    const contentContainer = groupElement.groupContent;
    const currentEntry = this.libraryData[this.currentEntry];

    if (!currentEntry.expansionStates) {
      currentEntry.expansionStates = {};
    }

    // Generate group identifier
    let groupIdentifier;
    if (group.name && group.name.trim()) {
      groupIdentifier = group.name.trim();
    } else {
      const contentHash = JSON.stringify(group).slice(0, 20);
      groupIdentifier = `group_${index}_${contentHash}`;
    }

    if (contentContainer.style.display === 'none') {
      // Expanding the group
      contentContainer.style.display = 'block';
      expandBtn.textContent = '▲';
      expandBtn.style.transform = 'rotate(0deg)';
      this.updateGroupDisplay(group, index);

      // Save expansion state
      currentEntry.expansionStates[groupIdentifier] = true;
    } else {
      // Collapsing the group
      contentContainer.style.display = 'none';
      expandBtn.textContent = '▼';
      expandBtn.style.transform = 'rotate(0deg)';

      // Save collapse state
      currentEntry.expansionStates[groupIdentifier] = false;
    }

    // Mark entry as modified and update nodes
    if (this.entryStates[currentEntry.id]) {
      this.entryStates[currentEntry.id].modified = true;
    }
    this.updateAllPromptLibraryNodes();
  },

  updateGroupDisplay(group, index) {
    const groupElement = document.querySelector(`.group-item:nth-child(${index + 1})`);
    if (!groupElement) return;

    const promptsArea = groupElement.promptsArea;
    promptsArea.innerHTML = '';

    switch (group.displayMode) {
      case 'detail':
        this.displayPromptsDetail(group, promptsArea, index);
        break;
      case 'simple':
        this.displayPromptsSimple(group, promptsArea, index);
        break;
      case 'side-by-side':
        this.displayPromptsSideBySide(group, promptsArea, index);
        break;
    }
  },

  updateModeButtonStates(container, activeMode) {
    const buttons = container.querySelectorAll('button');
    buttons.forEach(button => {
      if (
        button.textContent.toLowerCase().includes(activeMode) ||
        (activeMode === 'side-by-side' && button.textContent === 'Both')
      ) {
        button.style.background = 'rgba(66, 153, 225, 0.9)';
      } else {
        button.style.background = 'rgba(45, 55, 72, 0.7)';
      }
    });
  },

  displayPromptsDetail(group, promptsArea, groupIndex) {
    const prompts = group.prompts || [];

    if (prompts.length === 0) {
      const placeholder = document.createElement('div');
      placeholder.textContent = 'No prompts yet. Create your first prompt!';
      placeholder.style.cssText = `
        text-align: center;
        padding: 20px;
        color: rgba(226, 232, 240, 0.5);
        font-style: italic;
      `;
      promptsArea.appendChild(placeholder);
      return;
    }

    // Create a container for prompts that can expand
    const promptsContainer = document.createElement('div');
    promptsContainer.className = 'prompts-container';
    promptsContainer.style.cssText = `
      overflow-y: auto;
    `;

    prompts.forEach((prompt, promptIndex) => {
      const promptElement = this.createPromptElement(prompt, group, groupIndex, promptIndex);
      promptsContainer.appendChild(promptElement);
    });

    promptsArea.appendChild(promptsContainer);
  },

  displayPromptsSimple(group, promptsArea, groupIndex) {
    const prompts = group.prompts || [];

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Enter prompts separated by commas...\nFormat: prompt1, (prompt2:weight2), prompt3';
    textarea.value = this.formatPromptsForSimpleMode(prompts);

    textarea.style.cssText = `
      width: 100%;
      min-height: 80px;
      padding: 8px;
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 4px;
      color: rgba(226, 232, 240, 0.9);
      font-size: 11px;
      resize: vertical;
      box-sizing: border-box;
    `;

    // Use 'blur' event instead of 'change' to match specification
    textarea.addEventListener('blur', e => {
      this.parsePromptsFromSimpleMode(e.target.value, group, groupIndex);
      this.syncSideBySideMode(groupIndex);

      // Update nodes immediately when prompts are modified
      this.updateAllPromptLibraryNodes();
    });

    promptsArea.appendChild(textarea);
  },

  displayPromptsSideBySide(group, promptsArea, groupIndex) {
    const container = document.createElement('div');
    container.className = 'side-by-side-container';

    // Detail mode on left
    const detailContainer = document.createElement('div');
    detailContainer.className = 'detail-container';
    detailContainer.style.cssText = `
      border-right: 1px solid rgba(148, 163, 184, 0.2);
      padding-right: 8px;
    `;
    const detailTitle = document.createElement('h5');
    detailTitle.textContent = 'Detail Mode';
    detailTitle.style.cssText = `
      margin: 0 0 8px 0;
      color: rgba(226, 232, 240, 0.8);
      font-size: 11px;
      font-weight: 600;
    `;
    detailContainer.appendChild(detailTitle);
    this.displayPromptsDetail(group, detailContainer, groupIndex);
    container.appendChild(detailContainer);

    // Simple mode on right
    const simpleContainer = document.createElement('div');
    simpleContainer.className = 'simple-container';
    const simpleTitle = document.createElement('h5');
    simpleTitle.textContent = 'Simple Mode';
    simpleTitle.style.cssText = `
      margin: 0 0 8px 0;
      color: rgba(226, 232, 240, 0.8);
      font-size: 11px;
      font-weight: 600;
    `;
    simpleContainer.appendChild(simpleTitle);
    this.displayPromptsSimple(group, simpleContainer, groupIndex);
    container.appendChild(simpleContainer);

    // Store references for synchronization
    container.detailContainer = detailContainer;
    container.simpleContainer = simpleContainer;
    container.groupIndex = groupIndex;

    promptsArea.appendChild(container);
  },

  /**
   * Create a new prompt within a group
   *
   * This method creates a new prompt with default settings and automatically:
   * 1. Assigns the next available order index
   * 2. Reorders all prompts in the group
   * 3. Marks the entry as modified
   * 4. Updates all prompt library nodes
   *
   * The new prompt is created with empty context, active state, and default weight.
   *
   * @param {Object} group - The group to add the prompt to
   * @param {number} groupIndex - Index of the group in the entry
   */
  createNewPrompt(group, groupIndex) {
    const prompts = group.prompts || [];
    const newPrompt = {
      context: '',
      active: true,
      order_index: null, // Will be assigned by assignOrderIndexToPrompt
      weight: '1',
    };

    prompts.push(newPrompt);

    // Assign proper order index to the new prompt
    this.assignOrderIndexToPrompt(newPrompt, group, groupIndex);

    // Reorder all prompts according to new algorithm
    this.reorderPromptsInGroup(group, groupIndex);

    // Mark entry as modified and refresh list to show save/undo buttons
    if (this.currentEntry) {
      const entry = this.libraryData[this.currentEntry];
      if (entry && this.entryStates[entry.id]) {
        this.entryStates[entry.id].modified = true;
      }
      this.refreshEntryList();
    }

    // Update nodes immediately when new prompt is added
    this.updateAllPromptLibraryNodes();
  },

  createPromptElement(prompt, group, groupIndex, promptIndex) {
    const element = document.createElement('div');
    element.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px;
      background: rgba(45, 55, 72, 0.4);
      border-radius: 4px;
      margin-bottom: 4px;
    `;

    // Active toggle
    const activeToggle = document.createElement('input');
    activeToggle.type = 'checkbox';
    activeToggle.checked = prompt.active !== false;
    activeToggle.addEventListener('change', e => {
      const wasActive = prompt.active;
      prompt.active = e.target.checked;

      if (!wasActive && e.target.checked) {
        // Prompt was activated - assign next available order index
        this.assignOrderIndexToPrompt(prompt, group, groupIndex);
        // Reorder all prompts to show the new order
        this.reorderPromptsInGroup(group, groupIndex);
      } else if (wasActive && !e.target.checked) {
        // Prompt was deactivated - clear order index
        prompt.order_index = null;
        // Reorder remaining active prompts
        this.reorderPromptsInGroup(group, groupIndex);
      }

      this.updateCurrentEntry();
      this.syncSideBySideMode(groupIndex);

      // Update nodes immediately when prompt is modified
      this.updateAllPromptLibraryNodes();
    });
    element.appendChild(activeToggle);

    // Order index (editable only for active prompts)
    if (prompt.active) {
      const orderInput = document.createElement('input');
      orderInput.type = 'number';
      orderInput.value = prompt.order_index !== null && prompt.order_index !== undefined ? prompt.order_index : 1;
      orderInput.min = -999; // Allow any reasonable number
      orderInput.step = 'any'; // Allow decimal values if needed
      orderInput.style.cssText = `
        width: 40px;
        background: rgba(30, 41, 59, 0.7);
        border: 1px solid rgba(148, 163, 184, 0.3);
        border-radius: 4px;
        color: rgba(226, 232, 240, 0.9);
        font-size: 10px;
        padding: 2px 4px;
        text-align: center;
      `;

      // Handle order index changes
      const handleOrderChange = () => {
        const newOrder = parseInt(orderInput.value);
        if (isNaN(newOrder)) return;

        prompt.order_index = newOrder;

        // Reorder all prompts according to new algorithm
        this.reorderPromptsInGroup(group, groupIndex);

        // Mark entry as modified and refresh list to show save/undo buttons
        if (this.currentEntry) {
          const entry = this.libraryData[this.currentEntry];
          if (entry && this.entryStates[entry.id]) {
            this.entryStates[entry.id].modified = true;
          }
          this.refreshEntryList();
        }

        // Update nodes immediately when prompt order changes
        this.updateAllPromptLibraryNodes();
      };

      orderInput.addEventListener('change', handleOrderChange);
      orderInput.addEventListener('blur', handleOrderChange);
      orderInput.addEventListener('keypress', e => {
        if (e.key === 'Enter') {
          handleOrderChange();
          orderInput.blur();
        }
      });

      element.appendChild(orderInput);
    } else {
      // Inactive prompts show empty order index
      const orderSpan = document.createElement('span');
      orderSpan.textContent = '';
      orderSpan.style.cssText = `
        color: rgba(226, 232, 240, 0.3);
        font-size: 10px;
        min-width: 40px;
        text-align: center;
      `;
      element.appendChild(orderSpan);
    }

    // Context input
    const contextInput = document.createElement('input');
    contextInput.type = 'text';
    contextInput.value = prompt.context || '';
    contextInput.placeholder = 'Enter prompt text...';
    contextInput.style.cssText = `
      flex: 1;
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 4px;
      color: rgba(226, 232, 240, 0.9);
      font-size: 11px;
      padding: 4px 6px;
    `;
    contextInput.addEventListener('change', e => {
      prompt.context = e.target.value;

      // If this is an inactive prompt and context changed, we need to reorder
      if (!prompt.active) {
        this.reorderPromptsInGroup(group, groupIndex);
      }

      this.updateCurrentEntry();
      this.syncSideBySideMode(groupIndex);

      // Update nodes immediately when prompt is modified
      this.updateAllPromptLibraryNodes();
    });
    element.appendChild(contextInput);

    // Weight input
    const weightInput = document.createElement('input');
    weightInput.type = 'text';
    weightInput.value = prompt.weight || '1';
    weightInput.placeholder = '1';
    weightInput.style.cssText = `
      width: 50px;
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 4px;
      color: rgba(226, 232, 240, 0.9);
      font-size: 11px;
      padding: 4px 6px;
      text-align: center;
    `;
    weightInput.addEventListener('change', e => {
      prompt.weight = e.target.value;
      this.updateCurrentEntry();
      this.syncSideBySideMode(groupIndex);

      // Update nodes immediately when prompt is modified
      this.updateAllPromptLibraryNodes();
    });
    element.appendChild(weightInput);

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '×';
    deleteBtn.style.cssText = `
      background: none;
      border: none;
      color: rgba(220, 53, 69, 0.8);
      cursor: pointer;
      font-size: 14px;
      font-weight: bold;
      padding: 2px;
      width: 20px;
      height: 20px;
    `;
    deleteBtn.addEventListener('click', () => {
      this.deletePrompt(group, groupIndex, promptIndex);
    });
    element.appendChild(deleteBtn);

    return element;
  },

  deletePrompt(group, groupIndex, promptIndex) {
    const prompts = group.prompts || [];
    if (promptIndex >= 0 && promptIndex < prompts.length) {
      prompts.splice(promptIndex, 1);

      // Use the new reordering algorithm
      this.reorderPromptsInGroup(group, groupIndex);

      // Mark entry as modified and refresh list to show save/undo buttons
      if (this.currentEntry) {
        const entry = this.libraryData[this.currentEntry];
        if (entry && this.entryStates[entry.id]) {
          this.entryStates[entry.id].modified = true;
        }
        this.refreshEntryList();
      }

      // Update nodes immediately when prompt is deleted
      this.updateAllPromptLibraryNodes();
    }
  },

  formatPromptsForSimpleMode(prompts) {
    return prompts
      .filter(p => p.active)
      .map(p => (p.weight === '1' ? p.context : `(${p.context}:${p.weight})`))
      .join(', ');
  },

  parsePromptsFromSimpleMode(text, group, groupIndex) {
    const prompts = group.prompts || [];
    const lines = text
      .split(',')
      .map(line => line.trim())
      .filter(line => line);

    // Process each line from the textbox and maintain exact order
    const orderedPrompts = []; // This will maintain the exact order from textbox
    const newPrompts = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let context,
        weight = '1';

      // Check for ( ... : ... ) format, but only if parentheses are not escaped
      const match = line.match(/(?<!\\)\((.*)(?<!\\)\)/);
      if (match && match[1].includes(':')) {
        // Valid weight syntax
        const content = match[1];
        const lastColonIndex = content.lastIndexOf(':');

        if (lastColonIndex !== -1) {
          context = content.substring(0, lastColonIndex).trim();
          weight = content.substring(lastColonIndex + 1).trim();
        } else {
          context = content.trim();
          weight = '1';
        }
      } else {
        // Not in weight syntax, keep as-is
        context = line;
      }

      if (context) {
        // Check if this prompt already exists
        const existingPrompt = prompts.find(p => p.context === context);

        if (existingPrompt) {
          // Update existing prompt and add to ordered list
          existingPrompt.active = true;
          existingPrompt.weight = weight;
          existingPrompt.order_index = i + 1;
          orderedPrompts.push(existingPrompt);
        } else {
          // This is a new prompt - collect it for batch creation
          newPrompts.push({
            context,
            weight,
            orderIndex: i + 1,
          });
        }
      }
    }

    // Handle new prompts
    if (newPrompts.length > 0) {
      if (newPrompts.length <= 10) {
        // Create all new prompts directly
        this.createNewPromptsBatch(group, groupIndex, newPrompts, orderedPrompts);
      } else {
        // Ask for confirmation if more than 10
        this.askForBatchPromptCreation(group, groupIndex, newPrompts, orderedPrompts);
      }
    } else {
      // No new prompts, finalize parsing
      this.finalizeSimpleModeParsing(group, groupIndex, orderedPrompts);
    }
  },

  finalizeSimpleModeParsing(group, groupIndex, textboxPrompts) {
    const prompts = group.prompts || [];

    // Make all prompts not in the textbox inactive
    prompts.forEach(prompt => {
      if (!textboxPrompts.find(p => p.context === prompt.context)) {
        prompt.active = false;
        prompt.order_index = null; // Clear order index for inactive prompts
      }
    });

    // Reorder all active prompts according to textbox sequence
    textboxPrompts.forEach((prompt, index) => {
      prompt.order_index = index + 1;
    });

    // Use the new reordering algorithm
    this.reorderPromptsInGroup(group, groupIndex);

    // Update nodes immediately when prompts are modified
    this.updateAllPromptLibraryNodes();
  },

  createNewPromptsBatch(group, groupIndex, newPrompts, orderedPrompts) {
    // Create all new prompts in batch and insert them in the correct order
    newPrompts.forEach(newPrompt => {
      const prompt = {
        context: newPrompt.context,
        active: true,
        order_index: newPrompt.orderIndex,
        weight: newPrompt.weight,
      };

      group.prompts.push(prompt);

      // Insert the new prompt at the correct position in orderedPrompts
      // Find the correct insertion point based on orderIndex
      let insertIndex = orderedPrompts.length;
      for (let i = 0; i < orderedPrompts.length; i++) {
        if (orderedPrompts[i].order_index > newPrompt.orderIndex) {
          insertIndex = i;
          break;
        }
      }
      orderedPrompts.splice(insertIndex, 0, prompt);
    });

    // Finalize parsing with the correctly ordered prompts
    this.finalizeSimpleModeParsing(group, groupIndex, orderedPrompts);

    // Update nodes immediately when new prompts are added
    this.updateAllPromptLibraryNodes();
  },

  askForBatchPromptCreation(group, groupIndex, newPrompts, orderedPrompts) {
    // Create a custom confirmation dialog with high z-index
    this.showBatchPromptConfirmation(newPrompts).then(confirmed => {
      if (confirmed) {
        this.createNewPromptsBatch(group, groupIndex, newPrompts, orderedPrompts);
      } else {
        // User declined, finalize parsing without new prompts
        this.finalizeSimpleModeParsing(group, groupIndex, orderedPrompts);
      }
    });
  },

  showBatchPromptConfirmation(newPrompts) {
    return new Promise(resolve => {
      // Create a custom confirmation dialog with high z-index
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(0, 0, 0, 0.7);
        z-index: 10003;
        display: flex;
        align-items: center;
        justify-content: center;
      `;

      const dialog = document.createElement('div');
      dialog.style.cssText = `
        background: rgba(45, 55, 72, 0.95);
        border: 2px solid rgba(66, 153, 225, 0.8);
        border-radius: 8px;
        padding: 24px;
        max-width: 600px;
        width: 90%;
        color: white;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.8);
        max-height: 80vh;
        overflow-y: auto;
      `;

      const promptList = newPrompts.map(p => `• ${p.context} (weight: ${p.weight})`).join('\n');

      dialog.innerHTML = `
        <h3 style="margin: 0 0 16px 0; color: rgba(66, 153, 225, 0.9); font-size: 18px;">
          📝 Create New Prompts
        </h3>
        <p style="margin: 0 0 16px 0; line-height: 1.5; font-size: 14px;">
          The following ${newPrompts.length} new prompts were found in the textbox:
        </p>
        <div style="
          background: rgba(30, 41, 59, 0.6);
          border: 1px solid rgba(148, 163, 184, 0.3);
          border-radius: 6px;
          padding: 16px;
          margin: 0 0 20px 0;
          font-family: monospace;
          font-size: 12px;
          line-height: 1.4;
          white-space: pre-line;
          max-height: 300px;
          overflow-y: auto;
        ">${promptList}</div>
        <p style="margin: 0 0 24px 0; line-height: 1.5; font-size: 14px; color: rgba(66, 153, 225, 0.9);">
          Do you want to create all these prompts?
        </p>
        <div style="display: flex; gap: 12px; justify-content: flex-end;">
          <button id="cancel-batch" style="
            background: rgba(108, 117, 125, 0.8);
            border: none;
            color: white;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.2s ease;
          ">Cancel</button>
          <button id="confirm-batch" style="
            background: rgba(66, 153, 225, 0.9);
            border: none;
            color: white;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: bold;
            transition: background 0.2s ease;
          ">Create All Prompts</button>
        </div>
      `;

      // Add hover effects
      const cancelBtn = dialog.querySelector('#cancel-batch');
      const confirmBtn = dialog.querySelector('#confirm-batch');

      cancelBtn.addEventListener('mouseenter', () => {
        cancelBtn.style.background = 'rgba(108, 117, 125, 1)';
      });
      cancelBtn.addEventListener('mouseleave', () => {
        cancelBtn.style.background = 'rgba(108, 117, 125, 0.8)';
      });

      confirmBtn.addEventListener('mouseenter', () => {
        confirmBtn.style.background = 'rgba(66, 153, 225, 1)';
      });
      confirmBtn.addEventListener('mouseleave', () => {
        confirmBtn.style.background = 'rgba(66, 153, 225, 0.9)';
      });

      // Add event listeners
      cancelBtn.addEventListener('click', () => {
        overlay.remove();
        resolve(false);
      });

      confirmBtn.addEventListener('click', () => {
        overlay.remove();
        resolve(true);
      });

      // Close on overlay click (outside dialog)
      overlay.addEventListener('click', e => {
        if (e.target === overlay) {
          overlay.remove();
          resolve(false);
        }
      });

      // Close on Escape key
      const handleEscape = e => {
        if (e.key === 'Escape') {
          overlay.remove();
          document.removeEventListener('keydown', handleEscape);
          resolve(false);
        }
      };
      document.addEventListener('keydown', handleEscape);

      // Add to DOM
      document.body.appendChild(overlay);
      overlay.appendChild(dialog);

      // Focus the confirm button for keyboard navigation
      setTimeout(() => confirmBtn.focus(), 100);
    });
  },

  assignOrderIndexToPrompt(prompt, group, groupIndex) {
    // Find the next available order index
    const activePrompts = group.prompts.filter(p => p.active && p.order_index !== null && p.order_index !== undefined);
    let nextOrderIndex = 1;

    if (activePrompts.length > 0) {
      const maxOrderIndex = Math.max(...activePrompts.map(p => p.order_index));
      nextOrderIndex = maxOrderIndex + 1;
    }

    prompt.order_index = nextOrderIndex;

    // Don't call reorderPromptsInGroup here to avoid infinite loops
    // The reordering will happen when needed by other operations
  },

  reorderPromptsInGroup(group, groupIndex) {
    if (!group.prompts) return;

    // Separate active and inactive prompts
    const activePrompts = group.prompts.filter(p => p.active);
    const inactivePrompts = group.prompts.filter(p => !p.active);

    // Sort active prompts by order index (preserve user's custom ordering)
    activePrompts.sort((a, b) => {
      const aIndex = a.order_index !== null && a.order_index !== undefined ? a.order_index : 0;
      const bIndex = b.order_index !== null && b.order_index !== undefined ? b.order_index : 0;
      return aIndex - bIndex;
    });

    // Sort inactive prompts alphabetically by context
    inactivePrompts.sort((a, b) => (a.context || '').localeCompare(b.context || ''));

    // Reassign sequential order indices starting from 1 based on the sorted order
    // This preserves the user's intended order while normalizing indices
    activePrompts.forEach((prompt, index) => {
      prompt.order_index = index + 1;
    });

    // Clear order indices for inactive prompts
    inactivePrompts.forEach(prompt => {
      prompt.order_index = null;
    });

    // Rebuild the prompts array with new order
    group.prompts.length = 0;
    group.prompts.push(...activePrompts, ...inactivePrompts);

    // Refresh the display to show new order
    this.updateGroupDisplay(group, groupIndex);
    this.updateCurrentEntry();
    this.syncSideBySideMode(groupIndex);
  },

  syncSideBySideMode(groupIndex) {
    // Find the side-by-side container for this group
    const groupElement = document.querySelector(`.group-item:nth-child(${groupIndex + 1})`);
    if (!groupElement) return;

    const contentContainer = groupElement.groupContent;
    if (!contentContainer) return;

    const sideBySideContainer = contentContainer.querySelector('.prompts-area > div');
    if (!sideBySideContainer || !sideBySideContainer.detailContainer) return;

    // Update the simple mode textarea to reflect current prompt state
    const simpleTextarea = sideBySideContainer.simpleContainer.querySelector('textarea');
    if (simpleTextarea) {
      const group = this.libraryData[this.currentEntry]?.groups?.[groupIndex];
      if (group) {
        simpleTextarea.value = this.formatPromptsForSimpleMode(group.prompts || []);
      }
    }

    // Update the detail mode to reflect current prompt state
    const detailContainer = sideBySideContainer.detailContainer;
    if (detailContainer) {
      // Clear and recreate detail mode content
      detailContainer.innerHTML = '';
      const detailTitle = document.createElement('h5');
      detailTitle.textContent = 'Detail Mode';
      detailTitle.style.cssText = `
        margin: 0 0 8px 0;
        color: rgba(226, 232, 240, 0.8);
        font-size: 11px;
        font-weight: 600;
      `;
      detailContainer.appendChild(detailTitle);

      const group = this.libraryData[this.currentEntry]?.groups?.[groupIndex];
      if (group) {
        this.displayPromptsDetail(group, detailContainer, groupIndex);
      }
    }
  },

  syncNodeWidgetValue(node, widget, value, label = 'widget') {
    if (!node || !widget) {
      windowDebug('syncNodeWidgetValue', 'missing node or widget', { label });
      return;
    }

    if (!node.widgets_values) {
      node.widgets_values = (node.widgets || []).map(w => w?.value ?? null);
      windowDebug('syncNodeWidgetValue', node.id, 'initialized widgets_values array');
    }

    const widgetIndex = (node.widgets || []).indexOf(widget);
    if (widgetIndex !== -1) {
      while (node.widgets_values.length <= widgetIndex) {
        node.widgets_values.push(null);
      }
      node.widgets_values[widgetIndex] = value;
      windowDebug('syncNodeWidgetValue', node.id, label, 'stored at index', widgetIndex);
    } else {
      windowDebug('syncNodeWidgetValue', node.id, label, 'widget not found in node.widgets');
    }

    widget.value = value;

    if (typeof widget.callback === 'function') {
      widget.callback(value);
      windowDebug('syncNodeWidgetValue', node.id, label, 'callback invoked');
    } else {
      windowDebug('syncNodeWidgetValue', node.id, label, 'callback missing');
    }
  },

  /**
   * Insert text into the prompt template widget of the prompt library node
   *
   * This method finds the prompt library node and appends the given text to its
   * prompt template widget. If the template doesn't end with a comma, it adds one.
   *
   * @param {string} text - The text to insert (e.g., "[entry_name]" or "[entry_name/group_name]")
   */
  insertIntoPromptTemplate(text) {
    try {
      // Find all prompt library nodes in the current graph
      const nodes = app.graph._nodes || [];
      const promptLibraryNodes = nodes.filter(node => node.comfyClass === 'XYZ Prompt Library');

      if (promptLibraryNodes.length === 0) {
        this.showError('No prompt library node found in the current workflow');
        return;
      }

      // Use the first prompt library node found
      const node = promptLibraryNodes[0];

      // Find the prompt template widget
      const promptTemplateWidget = node.widgets?.find(w => w.name === 'prompt_template');

      if (!promptTemplateWidget) {
        this.showError('Prompt template widget not found in the prompt library node');
        return;
      }

      // Get current template value
      let currentTemplate = promptTemplateWidget.value || '';

      // Trim whitespace and check if it ends with comma
      currentTemplate = currentTemplate.trim();

      // Append text with proper comma handling
      if (currentTemplate && !currentTemplate.endsWith(',')) {
        currentTemplate += ', ' + text;
      } else {
        currentTemplate += text;
      }

      // Update the widget value
      promptTemplateWidget.value = currentTemplate;

      // Trigger the widget's callback to update the node
      if (promptTemplateWidget.callback) {
        promptTemplateWidget.callback(currentTemplate);
      }

      // Show success message
      this.showSuccess(`Inserted "${text}" into prompt template`, 10001);
    } catch (error) {
      console.error('Error inserting into prompt template:', error);
      this.showError('Failed to insert text into prompt template');
    }
  },

  // Update all prompt library nodes with current library data
  // CRITICAL: This method ensures widget storage is always synchronized with frontend data
  // The frontend is now the single source of truth for all library data
  updateAllPromptLibraryNodes() {
    try {
      // Find all prompt library nodes in the current graph
      const nodes = app.graph._nodes || [];
      const promptLibraryNodes = nodes.filter(node => node.comfyClass === 'XYZ Prompt Library');
      windowDebug('updateAllPromptLibraryNodes', 'nodes found', promptLibraryNodes.length);

      if (promptLibraryNodes.length === 0) {
        windowDebug('updateAllPromptLibraryNodes', 'no prompt library nodes detected');
      }

      // Single canonical JSON for all nodes, cache, and broadcast (must be in outer scope)
      const serializedData = JSON.stringify(this.libraryData || {}, null, 2);

      // Update each node's library data
      promptLibraryNodes.forEach(node => {
        if (!node.libraryWidget) {
          windowDebug('updateAllPromptLibraryNodes', node.id, 'libraryWidget missing');
          return;
        }

        // Update prompt library node with current data
        if (node.libraryWidget.value !== serializedData) {
          windowDebug('updateAllPromptLibraryNodes', node.id, 'syncing library_data', serializedData.length);
          this.syncNodeWidgetValue(node, node.libraryWidget, serializedData, 'library_data');
        } else {
          windowDebug('updateAllPromptLibraryNodes', node.id, 'library_data already up to date');
        }

        // Update the node's internal library data
        if (node.libraryData) {
          node.libraryData = { ...this.libraryData };
          windowDebug('updateAllPromptLibraryNodes', node.id, 'internal libraryData replaced', Object.keys(this.libraryData || {}).length);
        }
      });

      // Cache the serialized data globally for newly created nodes
      window.__xyzPromptLibrarySerialized = serializedData;
      window.__xyzPromptLibraryEntryCount = Object.keys(this.libraryData || {}).length;

      // Broadcast serialized data for any listeners
      this.broadcastLibraryData(serializedData);
    } catch (error) {
      console.warn('Failed to update prompt library nodes:', error);
      windowDebug('updateAllPromptLibraryNodes', 'error', error.message);
    }
  },

  broadcastLibraryData(serializedData) {
    try {
      window.dispatchEvent(new CustomEvent('xyzPromptLibraryData', {
        detail: {
          serializedData,
          entryCount: Object.keys(this.libraryData || {}).length,
          timestamp: Date.now(),
        },
      }));
      windowDebug('broadcastLibraryData', 'event dispatched');
    } catch (error) {
      console.warn('Failed to broadcast prompt library data:', error);
    }
  },

  // Public API for other extensions
  openLibraryWindow() {
    this.showLibraryWindow();
  },
});

// Make the library window accessible globally
window.promptLibraryWindow = app.extensions.find(ext => ext.name === 'XYZNodes.PromptLibraryWindow');
