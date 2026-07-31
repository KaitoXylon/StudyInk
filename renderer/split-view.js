/**
 * split-view.js — Side-by-Side PDF Split View Manager
 * Full feature parity with single PDF view:
 *  - Drawing / annotation (pen, highlighter, eraser, text, sticky, shape)
 *  - Add & delete blank pages per pane
 *  - Per-pane zoom (buttons + Ctrl+Scroll)
 *  - Page backgrounds (uses shared BG_PATTERNS from pdf-viewer.js)
 *  - Drag-to-swap pane handles
 *  - Resizable center divider
 *  - Undo / redo per focused pane (Ctrl+Z / Y)
 */

class SplitViewManager {
  constructor(appState) {
    this.appState = appState;
    this.isOpen = false;
    this.focusedPane = 'left';
    this.dragSourcePane = null;

    // Pane states — created lazily in openSplitView()
    this.leftState = null;
    this.rightState = null;

    this._buildContainer();
    this._buildPickerModal();
    this._bindDividerResize();
    this._bindPickerModal();
  }

  // ── Pane State ────────────────────────────────────────────────────────────

  _createPaneState(side) {
    const ae = new AnnotationEngine();
    // Share the toolState object reference so tool / color / size changes
    // from the main toolbar propagate automatically to both pane engines.
    ae.toolState = this.appState.annotationEngine.toolState;
    return {
      side,
      filePath: null,
      pdfDoc: null,
      pages: [],   // same structure as PDFViewer.pages
      zoom: 1.0,
      annotEngine: ae,
    };
  }

  _getState(side) {
    return side === 'left' ? this.leftState : this.rightState;
  }

  // ── DOM: Main Container ────────────────────────────────────────────────────

  _buildContainer() {
    const container = document.createElement('div');
    container.id = 'split-view-container';
    container.innerHTML = `
      <div class="split-pane" id="split-pane-left">
        ${this._buildPaneHeader('left')}
        <div class="split-viewport" id="split-viewport-left">
          <div class="split-pages-container" id="split-pages-left"></div>
        </div>
        <div class="split-drop-overlay hidden" id="split-drop-left">
          <div class="split-drop-label">↔ Drop to swap</div>
        </div>
      </div>

      <div class="split-divider" id="split-divider">
        <div class="split-divider-handle"></div>
      </div>

      <div class="split-pane" id="split-pane-right">
        ${this._buildPaneHeader('right')}
        <div class="split-viewport" id="split-viewport-right">
          <div class="split-pages-container" id="split-pages-right"></div>
        </div>
        <div class="split-drop-overlay hidden" id="split-drop-right">
          <div class="split-drop-label">↔ Drop to swap</div>
        </div>
      </div>
    `;

    document.getElementById('canvas-area').appendChild(container);

    this._bindPaneFocus();
    this._bindDragToSwap();
    this._bindZoomButtons();
    this._bindAddPageHeaderButtons();
    this._bindNewNotebookPaneButtons();
    this._bindUndoRedoButtons();
    this._bindCtrlScrollPerPane();
    this._bindCloseButtons();
  }

  _buildPaneHeader(side) {
    return `
      <div class="split-pane-header" id="split-header-${side}">
        <div class="split-drag-handle" id="split-drag-${side}" draggable="true" title="Drag to swap sides">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <circle cx="8" cy="5" r="1.5" fill="currentColor"/>
            <circle cx="16" cy="5" r="1.5" fill="currentColor"/>
            <circle cx="8" cy="12" r="1.5" fill="currentColor"/>
            <circle cx="16" cy="12" r="1.5" fill="currentColor"/>
            <circle cx="8" cy="19" r="1.5" fill="currentColor"/>
            <circle cx="16" cy="19" r="1.5" fill="currentColor"/>
          </svg>
        </div>
        <span class="split-pane-label" id="split-label-${side}">${side === 'left' ? 'Left Pane' : 'Right Pane'}</span>
        <div class="split-pane-actions">
          <button class="split-icon-btn split-pane-zoom-out" data-pane="${side}" title="Zoom Out">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/><line x1="8" y1="11" x2="14" y2="11" stroke="currentColor" stroke-width="2"/><line x1="21" y1="21" x2="16.65" y2="16.65" stroke="currentColor" stroke-width="2"/></svg>
          </button>
          <span class="split-pane-zoom-label" id="split-zoom-${side}">100%</span>
          <button class="split-icon-btn split-pane-zoom-in" data-pane="${side}" title="Zoom In">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/><line x1="11" y1="8" x2="11" y2="14" stroke="currentColor" stroke-width="2"/><line x1="8" y1="11" x2="14" y2="11" stroke="currentColor" stroke-width="2"/><line x1="21" y1="21" x2="16.65" y2="16.65" stroke="currentColor" stroke-width="2"/></svg>
          </button>
          <div class="split-header-sep"></div>
          <button class="split-icon-btn split-new-notebook-pane-btn" data-pane="${side}" title="Create new notebook in this pane">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <button class="split-icon-btn split-add-page-header-btn" data-pane="${side}" title="Add blank page after current">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="2"/><line x1="12" y1="11" x2="12" y2="17" stroke="currentColor" stroke-width="2"/><line x1="9" y1="14" x2="15" y2="14" stroke="currentColor" stroke-width="2"/></svg>
          </button>
          <button class="split-icon-btn split-undo-btn" data-pane="${side}" title="Undo (Ctrl+Z)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 7v6h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="split-icon-btn split-redo-btn" data-pane="${side}" title="Redo (Ctrl+Y)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M21 7v6h-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 17a9 9 0 019-9 9 9 0 016 2.3L21 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="split-header-sep"></div>
          <button class="split-icon-btn split-close-btn" id="split-close-btn-${side}" title="Close split view">
            <svg width="11" height="11" viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
    `;
  }

  // ── DOM: Picker Modal ─────────────────────────────────────────────────────

  _buildPickerModal() {
    const modal = document.createElement('div');
    modal.id = 'split-picker-modal';
    modal.className = 'modal hidden';
    modal.innerHTML = `
      <div class="modal-card split-picker-card">
        <div class="modal-header">
          <div class="split-picker-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="8" height="18" rx="1"/><rect x="13" y="3" width="8" height="18" rx="1"/>
            </svg>
            <h3>Open Side by Side</h3>
          </div>
          <button class="modal-close" id="split-picker-close">✕</button>
        </div>
        <div class="split-picker-body">
          <div class="split-picker-col">
            <div class="split-picker-col-label">
              <div class="split-picker-side-badge left">L</div>Left Pane
            </div>
            <select id="split-select-left" class="select-input"></select>
          </div>
          <div class="split-picker-arrow">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M21 16v3a2 2 0 01-2 2h-3M3 16v3a2 2 0 002 2h3"/>
            </svg>
          </div>
          <div class="split-picker-col">
            <div class="split-picker-col-label">
              <div class="split-picker-side-badge right">R</div>Right Pane
            </div>
            <select id="split-select-right" class="select-input"></select>
          </div>
        </div>
        <div class="modal-footer">
          <button id="split-picker-close-view" class="btn-secondary" style="display:none">Close Split View</button>
          <button id="split-picker-new-notebook" class="btn-secondary" style="margin-right:8px">+ New Notebook</button>
          <button id="split-picker-open" class="btn-primary">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px;vertical-align:middle">
              <rect x="3" y="3" width="8" height="18" rx="1"/><rect x="13" y="3" width="8" height="18" rx="1"/>
            </svg>
            Open Split View
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  // ── Picker Modal Logic ────────────────────────────────────────────────────

  _bindPickerModal() {
    document.getElementById('split-picker-close').addEventListener('click', () => this.closePickerModal());

    document.getElementById('split-picker-modal').addEventListener('click', (e) => {
      if (e.target.id === 'split-picker-modal') this.closePickerModal();
    });

    document.getElementById('split-picker-open').addEventListener('click', () => {
      const leftPath  = document.getElementById('split-select-left').value;
      const rightPath = document.getElementById('split-select-right').value;
      if (!leftPath || !rightPath) { showToast('Please select a PDF for each pane', 'error'); return; }
      this.closePickerModal();
      this.openSplitView(leftPath, rightPath);
    });

    document.getElementById('split-picker-close-view').addEventListener('click', () => {
      this.closePickerModal();
      this.closeSplitView();
    });

    document.getElementById('split-picker-new-notebook')?.addEventListener('click', async () => {
      const count = this.appState.sidebar.openFiles.filter(f => f.name.startsWith('Untitled Notebook')).length + 1;
      const name = `Untitled Notebook ${count}.pdf`;
      const path = `virtual://notebook_${Date.now()}_${name}`;
      this.appState.sidebar.addFile(name, path, null);
      if (!this.leftState?.filePath) {
        if (this.leftState) this.leftState.filePath = path;
      } else {
        if (this.rightState) this.rightState.filePath = path;
      }
      this.openPickerModal();
      const rSel = document.getElementById('split-select-right');
      if (rSel) rSel.value = path;
    });
  }

  openPickerModal() {
    const files = this.appState.sidebar.openFiles;
    if (files.length < 1) { showToast('Open at least one PDF first', 'error'); return; }

    const buildOpts = (sel, preferPath) => {
      sel.innerHTML = '';
      files.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.path;
        opt.textContent = f.name;
        if (f.path === preferPath) opt.selected = true;
        sel.appendChild(opt);
      });
    };

    buildOpts(document.getElementById('split-select-left'),
      this.leftState?.filePath  || files[0]?.path);
    buildOpts(document.getElementById('split-select-right'),
      this.rightState?.filePath || files[1]?.path || files[0]?.path);

    document.getElementById('split-picker-close-view').style.display = this.isOpen ? 'inline-flex' : 'none';
    document.getElementById('split-picker-modal').classList.remove('hidden');
  }

  closePickerModal() {
    document.getElementById('split-picker-modal').classList.add('hidden');
  }

  // ── Open / Close ──────────────────────────────────────────────────────────

  async openSplitView(leftPath, rightPath) {
    if (this.isOpen) {
      await this.saveAllPanes();
    }

    const leftUnchanged = (this.isOpen && this.leftState && this.leftState.filePath === leftPath);
    const rightUnchanged = (this.isOpen && this.rightState && this.rightState.filePath === rightPath);

    if (!leftUnchanged) {
      this.leftState = this._createPaneState('left');
    }
    if (!rightUnchanged) {
      this.rightState = this._createPaneState('right');
    }

    this.isOpen = true;
    document.body.classList.add('split-view-active');

    const splitBtn = document.getElementById('ft-btn-split-view');
    if (splitBtn) splitBtn.classList.add('active');

    if (!leftUnchanged && !rightUnchanged) {
      document.getElementById('split-pane-left').style.cssText  = 'flex:1';
      document.getElementById('split-pane-right').style.cssText = 'flex:1';
    }

    const tasks = [];
    if (!leftUnchanged) tasks.push(this._loadPaneFile('left', leftPath));
    if (!rightUnchanged) tasks.push(this._loadPaneFile('right', rightPath));
    await Promise.all(tasks);

    if (!leftUnchanged && !rightUnchanged) {
      this._setFocus('left');
    }
    showToast('Split view ready', 'success');
  }

  async closeSplitView() {
    if (this.isOpen) {
      await this.saveAllPanes();
    }
    this.isOpen = false;
    document.body.classList.remove('split-view-active');

    const splitBtn = document.getElementById('ft-btn-split-view');
    if (splitBtn) splitBtn.classList.remove('active');

    document.getElementById('split-pages-left').innerHTML  = '';
    document.getElementById('split-pages-right').innerHTML = '';
    document.getElementById('split-pane-left').classList.remove('focused');
    document.getElementById('split-pane-right').classList.remove('focused');
    document.getElementById('split-zoom-left').textContent  = '100%';
    document.getElementById('split-zoom-right').textContent = '100%';

    this.leftState  = null;
    this.rightState = null;

    if (this.appState.floatingToolbar) {
      this.appState.floatingToolbar.annotEngine = this.appState.annotationEngine;
    }

    if (this.appState.currentFilePath) {
      const saved = await window.studyAPI.loadAnnotations(this.appState.currentFilePath);
      if (saved.success && saved.data) {
        this.appState.restoreState(saved.data);
        if (this.appState.pdfViewer) {
          await this.appState.pdfViewer.renderAllPages();
        }
      }
    }

    showToast('Split view closed');
  }

  // ── Load File into Pane ───────────────────────────────────────────────────

  async _loadPaneFile(side, filePath) {
    const state = this._getState(side);
    const container = document.getElementById(`split-pages-${side}`);
    container.innerHTML = '<div class="split-loading"><div class="split-loading-spinner"></div><span>Loading…</span></div>';

    state.filePath = filePath;
    state.pages = [];
    state.annotEngine.pages = {};
    state.annotEngine.undoStacks = {};
    state.annotEngine.redoStacks = {};

    const labelEl = document.getElementById(`split-label-${side}`);

    try {
      if (filePath.startsWith('virtual://')) {
        const parts = filePath.split('_');
        const name = parts[parts.length - 1] || 'Untitled Notebook.pdf';
        if (labelEl) labelEl.textContent = name;
        state.pdfDoc = null;
        state.pages  = [{ type: 'blank', pdfPageIndex: null, background: 'white', bgColor: null, rendered: false, baseWidth: 595, baseHeight: 842 }];
      } else {
        const file = this.appState.sidebar.openFiles.find(f => f.path === filePath);
        if (!file) { container.innerHTML = '<div class="split-error">File not found in library</div>'; return; }

        if (labelEl) labelEl.textContent = file.name;

        let base64 = file.base64;
        if (!base64) {
          const r = await window.studyAPI.readFile(filePath);
          if (!r.success) { container.innerHTML = '<div class="split-error">Failed to load file</div>'; return; }
          base64 = r.data;
          file.base64 = base64; // cache
        }

        const binary = atob(base64);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        state.pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;

        for (let i = 0; i < state.pdfDoc.numPages; i++) {
          state.pages.push({ type: 'pdf', pdfPageIndex: i + 1, background: 'white', bgColor: null, rendered: false });
        }
      }

      const saved = await window.studyAPI.loadAnnotations(filePath);
      if (saved.success && saved.data) {
        if (saved.data.annotations) {
          state.annotEngine.deserialize(saved.data.annotations);
        }
        if (saved.data.viewerState && saved.data.viewerState.pages && Array.isArray(saved.data.viewerState.pages)) {
          state.pages = saved.data.viewerState.pages.map(p => ({ ...p }));
        }
        if (saved.data.viewerState && saved.data.viewerState.zoom) {
          state.zoom = saved.data.viewerState.zoom;
          const labelElZoom = document.getElementById(`split-zoom-${side}`);
          if (labelElZoom) labelElZoom.textContent = `${Math.round(state.zoom * 100)}%`;
        }
        state.bookmarks = saved.data.bookmarks || [];
        state.flashcards = saved.data.flashcards || [];
      } else {
        state.bookmarks = [];
        state.flashcards = [];
      }

      container.innerHTML = '';
      await this._renderAllPanePages(side);

    } catch (err) {
      console.error(`Split pane ${side} error:`, err);
      container.innerHTML = `<div class="split-error">Error: ${err.message}</div>`;
    }
  }

  async _renderAllPanePages(side) {
    const state = this._getState(side);
    if (!state) return;
    const container = document.getElementById(`split-pages-${side}`);
    container.innerHTML = '';
    for (let i = 0; i < state.pages.length; i++) {
      await this._renderPanePage(side, i);
    }
  }

  // ── Per-Page Rendering (full 4-canvas stack) ──────────────────────────────

  async _renderPanePage(side, pageIndex) {
    const state     = this._getState(side);
    const container = document.getElementById(`split-pages-${side}`);
    const pageDesc  = state.pages[pageIndex];

    // Remove stale wrapper
    const existing = container.querySelector(`.page-wrapper[data-page="${pageIndex}"][data-pane="${side}"]`);
    if (existing) existing.remove();

    let width, height;

    if (pageDesc.type === 'pdf' && state.pdfDoc) {
      const pdfPage = await state.pdfDoc.getPage(pageDesc.pdfPageIndex);

      if (!pageDesc.baseWidth || !pageDesc.baseHeight) {
        const vp1 = pdfPage.getViewport({ scale: 1.0 });
        pageDesc.baseWidth  = vp1.width;
        pageDesc.baseHeight = vp1.height;
      }

      const viewport = pdfPage.getViewport({ scale: state.zoom * window.devicePixelRatio });
      const cssVP    = pdfPage.getViewport({ scale: state.zoom });
      width  = Math.floor(cssVP.width);
      height = Math.floor(cssVP.height);

      const wrapper = this._createPageWrapper(side, pageIndex, width, height, false, pageDesc.baseWidth, pageDesc.baseHeight);
      this._insertWrapperAtIndex(container, wrapper, pageIndex);

      const pdfCanvas = wrapper.querySelector('.page-pdf-canvas');
      pdfCanvas.width  = Math.floor(viewport.width);
      pdfCanvas.height = Math.floor(viewport.height);
      pdfCanvas.style.width  = `${width}px`;
      pdfCanvas.style.height = `${height}px`;
      await pdfPage.render({ canvasContext: pdfCanvas.getContext('2d'), viewport }).promise;

    } else {
      if (!pageDesc.baseWidth || !pageDesc.baseHeight) {
        pageDesc.baseWidth  = 595;
        pageDesc.baseHeight = 842;
      }
      width  = Math.floor(pageDesc.baseWidth  * state.zoom);
      height = Math.floor(pageDesc.baseHeight * state.zoom);

      const wrapper = this._createPageWrapper(side, pageIndex, width, height, true, pageDesc.baseWidth, pageDesc.baseHeight);
      this._insertWrapperAtIndex(container, wrapper, pageIndex);
    }

    // Retrieve freshly inserted wrapper
    const wrapper2  = container.querySelector(`.page-wrapper[data-page="${pageIndex}"][data-pane="${side}"]`);
    const bgCanvas  = wrapper2.querySelector('.page-bg-canvas');
    const annotCv   = wrapper2.querySelector('.page-annotation-canvas');
    const drawCv    = wrapper2.querySelector('.page-drawing-canvas');

    const dpr = window.devicePixelRatio;
    [bgCanvas, annotCv, drawCv].forEach(cv => {
      cv.width  = Math.floor(width  * dpr);
      cv.height = Math.floor(height * dpr);
      cv.style.width  = `${width}px`;
      cv.style.height = `${height}px`;
    });

    // Apply background pattern
    this._applyPaneBackground(side, pageIndex, pageDesc.background, pageDesc.bgColor);

    // Attach annotation engine (drawing canvas gets mouse/touch events)
    state.annotEngine.attachToCanvas(drawCv, pageIndex);
    state.annotEngine.redrawPage(annotCv, pageIndex);
    state.annotEngine.restorePageOverlays(wrapper2, pageIndex);

    // Focus this pane on any drawing interaction
    drawCv.addEventListener('mousedown', () => { if (this.isOpen) this._setFocus(side); });

    // Text / sticky click placement
    drawCv.addEventListener('click', (e) => {
      if (!this.isOpen) return;
      this._setFocus(side);
      const tool = state.annotEngine.toolState.tool;
      if (tool !== 'text' && tool !== 'sticky') return;
      const rect = drawCv.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (tool === 'text')   state.annotEngine.addTextBox(wrapper2, pageIndex, x, y);
      if (tool === 'sticky') state.annotEngine.addStickyNote(wrapper2, pageIndex, x, y);
    });

    // "+" add row between pages
    const existingRow = container.querySelector(`.split-add-row[data-after-page="${pageIndex}"][data-pane="${side}"]`);
    if (existingRow) existingRow.remove();
    wrapper2.after(this._createAddPageRow(side, pageIndex));

    pageDesc.rendered = true;
  }

  _createPageWrapper(side, pageIndex, width, height, isBlank, baseWidth = 595, baseHeight = 842) {
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.dataset.page = pageIndex;
    wrapper.dataset.pane = side;
    wrapper.dataset.baseWidth = baseWidth;
    wrapper.dataset.baseHeight = baseHeight;
    wrapper.style.width  = `${width}px`;
    wrapper.style.height = `${height}px`;

    const delBtn = isBlank
      ? `<button class="page-del-badge-btn" title="Delete blank page"
           onclick="window.appState.splitViewManager._deletePage('${side}', ${pageIndex})">✕</button>`
      : '';

    wrapper.innerHTML = `
      <canvas class="page-bg-canvas"         style="width:${width}px;height:${height}px"></canvas>
      <canvas class="page-pdf-canvas"        style="width:${width}px;height:${height}px"></canvas>
      <canvas class="page-annotation-canvas" style="width:${width}px;height:${height}px"></canvas>
      <canvas class="page-drawing-canvas"    style="width:${width}px;height:${height}px"></canvas>
      <div class="page-overlays" style="pointer-events:none;position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible"></div>
      <div class="page-number-badge">
        <span>Page ${pageIndex + 1}</span>
        ${delBtn}
      </div>
    `;
    return wrapper;
  }

  _insertWrapperAtIndex(container, wrapper, pageIndex) {
    const children = Array.from(container.children).filter(c => c.classList.contains('page-wrapper'));
    if (pageIndex >= children.length) {
      container.appendChild(wrapper);
    } else {
      container.insertBefore(wrapper, children[pageIndex]);
    }
  }

  _createAddPageRow(side, pageIndex) {
    const div = document.createElement('div');
    div.className  = 'page-add-row split-add-row';
    div.dataset.afterPage = pageIndex;
    div.dataset.pane      = side;
    div.innerHTML = `
      <button class="page-add-btn" title="Insert blank page after page ${pageIndex + 1}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <line x1="12" y1="5"  x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <line x1="5"  y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
    `;
    div.querySelector('.page-add-btn').addEventListener('click', async () => {
      const state = this._getState(side);
      const bg    = state.pages[pageIndex]?.background || 'white';
      await this._insertBlankPage(side, pageIndex + 1, bg);
    });
    return div;
  }

  // ── Background ────────────────────────────────────────────────────────────

  _applyPaneBackground(side, pageIndex, bgType, bgColor) {
    const container = document.getElementById(`split-pages-${side}`);
    const wrapper   = container?.querySelector(`.page-wrapper[data-page="${pageIndex}"][data-pane="${side}"]`);
    if (!wrapper) return;
    const bgCanvas  = wrapper.querySelector('.page-bg-canvas');
    if (!bgCanvas)  return;
    const ctx       = bgCanvas.getContext('2d');
    const patterns  = window.BG_PATTERNS || {};
    const fn        = patterns[bgType] || patterns['white'];
    if (fn) fn(bgCanvas, ctx, bgColor);
    const state = this._getState(side);
    if (state && state.pages[pageIndex]) {
      state.pages[pageIndex].background = bgType;
      state.pages[pageIndex].bgColor    = bgColor;
    }
  }

  // ── Add / Delete Blank Pages ──────────────────────────────────────────────

  async _insertBlankPage(side, atIndex, background = 'white') {
    const state = this._getState(side);
    if (!state) return;

    state.pages.splice(atIndex, 0, {
      type: 'blank', pdfPageIndex: null,
      background, bgColor: null,
      rendered: false, baseWidth: 595, baseHeight: 842,
    });

    // Shift annotation stacks up
    const shiftUp = (map) => {
      const keys = Object.keys(map).map(Number).sort((a, b) => b - a);
      for (const k of keys) {
        if (k >= atIndex) { map[k + 1] = map[k]; delete map[k]; }
      }
    };
    shiftUp(state.annotEngine.pages);
    shiftUp(state.annotEngine.undoStacks);
    shiftUp(state.annotEngine.redoStacks);

    await this._renderAllPanePages(side);
    if (window.appState) window.appState.scheduleAutoSave();
    showToast(`Blank page inserted at position ${atIndex + 1}`, 'success');
  }

  async _deletePage(side, pageIndex) {
    const state = this._getState(side);
    if (!state) return;
    if (state.pages.length <= 1) { showToast('Cannot delete the only page', 'error'); return; }

    state.pages.splice(pageIndex, 1);

    const shiftDown = (map) => {
      const keys = Object.keys(map).map(Number).sort((a, b) => a - b);
      for (const k of keys) {
        if (k === pageIndex)    { delete map[k]; }
        else if (k > pageIndex) { map[k - 1] = map[k]; delete map[k]; }
      }
    };
    shiftDown(state.annotEngine.pages);
    shiftDown(state.annotEngine.undoStacks);
    shiftDown(state.annotEngine.redoStacks);

    await this._renderAllPanePages(side);
    if (window.appState) window.appState.scheduleAutoSave();
    showToast('Page deleted');
  }

  // ── Zoom ──────────────────────────────────────────────────────────────────

  _bindZoomButtons() {
    document.querySelectorAll('.split-pane-zoom-in').forEach(btn => {
      btn.addEventListener('click', () => {
        const state = this._getState(btn.dataset.pane);
        if (state) this._setZoom(btn.dataset.pane, state.zoom + 0.15);
      });
    });
    document.querySelectorAll('.split-pane-zoom-out').forEach(btn => {
      btn.addEventListener('click', () => {
        const state = this._getState(btn.dataset.pane);
        if (state) this._setZoom(btn.dataset.pane, state.zoom - 0.15);
      });
    });
  }

  async _setZoom(side, zoom) {
    const state = this._getState(side);
    if (!state) return;
    state.zoom = Math.max(0.25, Math.min(3.0, zoom));
    const label = document.getElementById(`split-zoom-${side}`);
    if (label) label.textContent = `${Math.round(state.zoom * 100)}%`;
    await this._renderAllPanePages(side);
  }

  _bindCtrlScrollPerPane() {
    ['left', 'right'].forEach(side => {
      document.getElementById(`split-viewport-${side}`).addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const state = this._getState(side);
        if (state) this._setZoom(side, state.zoom + (e.deltaY > 0 ? -0.1 : 0.1));
      }, { passive: false });
    });
  }

  // ── Undo / Redo per Pane (header buttons) ─────────────────────────────────

  _bindUndoRedoButtons() {
    document.querySelectorAll('.split-undo-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const side  = btn.dataset.pane;
        const state = this._getState(side);
        if (!state) return;
        const page   = this.getCurrentPanePage(side);
        const canvas = document.querySelector(`#split-pages-${side} .page-wrapper[data-page="${page}"] .page-annotation-canvas`);
        if (canvas) state.annotEngine.undo(page, canvas);
      });
    });
    document.querySelectorAll('.split-redo-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const side  = btn.dataset.pane;
        const state = this._getState(side);
        if (!state) return;
        const page   = this.getCurrentPanePage(side);
        const canvas = document.querySelector(`#split-pages-${side} .page-wrapper[data-page="${page}"] .page-annotation-canvas`);
        if (canvas) state.annotEngine.redo(page, canvas);
      });
    });
  }

  // ── Header "Add Page" Buttons ─────────────────────────────────────────────

  _bindAddPageHeaderButtons() {
    document.querySelectorAll('.split-add-page-header-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const side  = btn.dataset.pane;
        const state = this._getState(side);
        if (!state || !this.isOpen) return;
        const currentPage = this.getCurrentPanePage(side);
        await this._insertBlankPage(side, currentPage + 1, 'white');
      });
    });
  }

  // ── Close Buttons ─────────────────────────────────────────────────────────

  _bindCloseButtons() {
    ['left', 'right'].forEach(side => {
      document.getElementById(`split-close-btn-${side}`).addEventListener('click', () => {
        this.closeSplitView();
      });
    });
  }

  _bindNewNotebookPaneButtons() {
    document.querySelectorAll('.split-new-notebook-pane-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const side = btn.dataset.pane;
        const count = this.appState.sidebar.openFiles.filter(f => f.name.startsWith('Untitled Notebook')).length + 1;
        const name = `Untitled Notebook ${count}.pdf`;
        const path = `virtual://notebook_${Date.now()}_${name}`;
        this.appState.sidebar.addFile(name, path, null);
        await this.loadIntoPane(side, path);
        showToast(`Created & opened ${name} in ${side} pane`, 'success');
      });
    });
  }

  async loadIntoPane(side, filePath) {
    if (!this.isOpen) return;
    await this._savePane(side);
    if (side === 'left') {
      this.leftState = this._createPaneState('left');
    } else {
      this.rightState = this._createPaneState('right');
    }
    await this._loadPaneFile(side, filePath);
    this._setFocus(side);
  }

  async saveAllPanes() {
    if (!this.isOpen) return;
    if (this.leftState) await this._savePane('left');
    if (this.rightState) await this._savePane('right');
  }

  async _savePane(side) {
    const state = this._getState(side);
    if (!state || !state.filePath) return;

    const isSingleViewActive = (this.appState.currentFilePath === state.filePath);

    const saveState = {
      annotations: state.annotEngine.serialize(),
      bookmarks: isSingleViewActive ? this.appState.bookmarkManager.serialize() : (state.bookmarks || []),
      flashcards: isSingleViewActive ? this.appState.flashcardManager.serialize() : (state.flashcards || []),
      viewerState: {
        pages: state.pages.map(p => ({
          type: p.type,
          pdfPageIndex: p.pdfPageIndex,
          background: p.background,
          bgColor: p.bgColor,
        })),
        zoom: state.zoom,
      },
      theme: this.appState.themeManager.getState(),
    };

    await window.studyAPI.saveAnnotations(state.filePath, saveState);

    if (isSingleViewActive) {
      this.appState.annotationEngine.deserialize(saveState.annotations);
      if (this.appState.pdfViewer) {
        this.appState.pdfViewer.pages = saveState.viewerState.pages.map(p => ({ ...p }));
      }
    }
  }

  // ── Pane Focus ────────────────────────────────────────────────────────────

  _bindPaneFocus() {
    ['left', 'right'].forEach(side => {
      document.getElementById(`split-pane-${side}`).addEventListener('mousedown', () => {
        if (this.isOpen) this._setFocus(side);
      });
    });
  }

  _setFocus(side) {
    this.focusedPane = side;
    document.getElementById('split-pane-left').classList.toggle('focused',  side === 'left');
    document.getElementById('split-pane-right').classList.toggle('focused', side === 'right');

    // Route floating toolbar annotation engine to the focused pane
    const state = this._getState(side);
    if (state && this.appState.floatingToolbar) {
      this.appState.floatingToolbar.annotEngine = state.annotEngine;
    }
  }

  // ── Public Helpers for app.js keyboard routing ────────────────────────────

  getActivePaneState() {
    return this._getState(this.focusedPane);
  }

  getCurrentPanePage(side) {
    const vp        = document.getElementById(`split-viewport-${side}`);
    const container = document.getElementById(`split-pages-${side}`);
    const wrappers  = container.querySelectorAll('.page-wrapper');
    const vpRect    = vp.getBoundingClientRect();
    let maxVisible  = 0, bestPage = 0;
    wrappers.forEach((w, i) => {
      const rect    = w.getBoundingClientRect();
      const visible = Math.min(rect.bottom, vpRect.bottom) - Math.max(rect.top, vpRect.top);
      if (visible > maxVisible) { maxVisible = visible; bestPage = i; }
    });
    return bestPage;
  }

  // ── Drag to Swap ──────────────────────────────────────────────────────────

  _bindDragToSwap() {
    ['left', 'right'].forEach(src => {
      const handle  = document.getElementById(`split-drag-${src}`);
      const srcPane = document.getElementById(`split-pane-${src}`);

      handle.addEventListener('dragstart', (e) => {
        this.dragSourcePane = src;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', src);
        srcPane.classList.add('dragging');
      });
      handle.addEventListener('dragend', () => {
        srcPane.classList.remove('dragging');
        document.getElementById('split-drop-left').classList.add('hidden');
        document.getElementById('split-drop-right').classList.add('hidden');
        this.dragSourcePane = null;
      });
    });

    ['left', 'right'].forEach(target => {
      const paneEl = document.getElementById(`split-pane-${target}`);
      const dropEl = document.getElementById(`split-drop-${target}`);

      paneEl.addEventListener('dragover', (e) => {
        if (this.dragSourcePane && this.dragSourcePane !== target) {
          e.preventDefault();
          dropEl.classList.remove('hidden');
        }
      });
      paneEl.addEventListener('dragleave', (e) => {
        if (!paneEl.contains(e.relatedTarget)) dropEl.classList.add('hidden');
      });
      paneEl.addEventListener('drop', (e) => {
        e.preventDefault();
        dropEl.classList.add('hidden');
        if (this.dragSourcePane && this.dragSourcePane !== target) this._swapPanes();
      });
    });
  }

  async _swapPanes() {
    if (!this.isOpen) return;

    // Swap state references
    const tmp      = this.leftState;
    this.leftState = this.rightState;
    this.rightState = tmp;
    this.leftState.side  = 'left';
    this.rightState.side = 'right';

    // Swap labels & zoom labels
    const ll = document.getElementById('split-label-left');
    const rl = document.getElementById('split-label-right');
    [ll.textContent, rl.textContent] = [rl.textContent, ll.textContent];

    document.getElementById('split-zoom-left').textContent  = `${Math.round(this.leftState.zoom  * 100)}%`;
    document.getElementById('split-zoom-right').textContent = `${Math.round(this.rightState.zoom * 100)}%`;

    await Promise.all([
      this._renderAllPanePages('left'),
      this._renderAllPanePages('right'),
    ]);

    showToast('Panes swapped ↔');
  }

  // ── Divider Resize ────────────────────────────────────────────────────────

  _bindDividerResize() {
    const divider  = document.getElementById('split-divider');
    const leftPane = document.getElementById('split-pane-left');
    const rightPane = document.getElementById('split-pane-right');

    divider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      let startX = e.clientX;
      divider.classList.add('active');

      const onMove = (ev) => {
        const dx       = ev.clientX - startX;
        const leftW    = leftPane.getBoundingClientRect().width;
        const rightW   = rightPane.getBoundingClientRect().width;
        const total    = leftW + rightW;
        const newLeft  = Math.max(200, Math.min(total - 200, leftW + dx));
        const newRight = total - newLeft;
        leftPane.style.flex  = 'none';
        rightPane.style.flex = 'none';
        leftPane.style.width  = `${newLeft}px`;
        rightPane.style.width = `${newRight}px`;
        startX = ev.clientX;
      };

      const onUp = () => {
        divider.classList.remove('active');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  async onFullscreenExit() {
    if (this.isOpen) await this.closeSplitView();
    this.closePickerModal();
  }
}

window.SplitViewManager = SplitViewManager;
