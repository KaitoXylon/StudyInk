/**
 * app.js — Main Application Orchestrator
 * Wires together all modules: pdf-viewer, annotation, toolbar, sidebar,
 * bookmarks, search, flashcards, theme, export.
 */

class AppState {
  constructor() {
    this.currentPage = 0;
    this.autoSaveTimer = null;
    this.currentFilePath = null;

    // Initialize modules
    this.themeManager = new ThemeManager();
    this.annotationEngine = new AnnotationEngine();
    // Default pen color to black — more natural for writing on white pages
    this.annotationEngine.toolState.color = '#1a1a2e';
    this.annotationEngine.toolState.size = 2;
    this.annotationEngine.toolState.highlighterColor = '#FFE600';
    this.annotationEngine.toolState.highlighterSize = 12;
    this.pdfViewer = new PDFViewer(this.annotationEngine);
    this.floatingToolbar = new FloatingToolbar(this.annotationEngine);
    this.sidebar = new Sidebar(this.pdfViewer, this);
    this.bookmarkManager = new BookmarkManager(this.pdfViewer);
    this.searchManager = new SearchManager(this.pdfViewer);
    this.flashcardManager = new FlashcardManager(this.pdfViewer);
    this.exportManager = new ExportManager(this.pdfViewer, this.annotationEngine);

    // Expose globally
    window.appState = this;
    this.isLightMode = false;
    this.isFullscreen = false;
    this.splitViewManager = null; // initialized after DOM ready

    // Add fullscreen hint
    const hint = document.createElement('div');
    hint.className = 'fullscreen-hint';
    hint.textContent = 'Press Esc or F11 to exit fullscreen';
    document.body.appendChild(hint);

    // Load pdf-lib from node_modules
    this.loadPDFLib();

    this.bindUI();
    this.bindKeyboard();
    this.initResizeHandler();
    this.loadSettings();

    // Initialize split view (after DOM is ready)
    this.splitViewManager = new SplitViewManager(this);
  }

  async loadPDFLib() {
    try {
      // Load pdf-lib from node_modules via require (available in Electron renderer with nodeIntegration)
      // Since we use contextIsolation, we load from a relative path
      const script = document.createElement('script');
      script.src = '../node_modules/pdf-lib/dist/pdf-lib.min.js';
      script.onload = () => console.log('pdf-lib loaded');
      script.onerror = () => {
        // Try CDN fallback
        const s2 = document.createElement('script');
        s2.src = 'https://unpkg.com/pdf-lib/dist/pdf-lib.min.js';
        document.head.appendChild(s2);
      };
      document.head.appendChild(script);
    } catch (e) {
      console.error('pdf-lib load error:', e);
    }
  }

  // ── File Management ─────────────────────────────────────────────────────

  async openFile() {
    const paths = await window.studyAPI.openFileDialog();
    if (!paths || paths.length === 0) return;
    for (const p of paths) {
      await this.openFileFromPath(p, true);
    }
  }

  async createNewNotebook() {
    const count = this.sidebar.openFiles.filter(f => f.name.startsWith('Untitled Notebook')).length + 1;
    const name = `Untitled Notebook ${count}.pdf`;
    const path = `virtual://notebook_${Date.now()}_${name}`;

    this.sidebar.addFile(name, path, null);
    if (this.splitViewManager && this.splitViewManager.isOpen) {
      const side = this.splitViewManager.focusedPane || 'left';
      await this.splitViewManager.loadIntoPane(side, path);
    } else {
      await this.loadPDF(path, null, true);
    }
  }

  async openFileFromPath(filePath, switchToFile = true) {
    if (filePath.startsWith('virtual://')) {
      const parts = filePath.split('_');
      const name = parts[parts.length - 1] || 'Untitled Notebook.pdf';
      this.sidebar.addFile(name, filePath, null);
      if (switchToFile) {
        if (this.splitViewManager && this.splitViewManager.isOpen) {
          const side = this.splitViewManager.focusedPane || 'left';
          await this.splitViewManager.loadIntoPane(side, filePath);
        } else {
          await this.loadPDF(filePath, null, true);
        }
      }
      return;
    }

    const result = await window.studyAPI.readFile(filePath);
    if (!result.success) { showToast('Failed to open file: ' + result.error, 'error'); return; }
    const name = filePath.split(/[\\/]/).pop();
    this.sidebar.addFile(name, filePath, result.data);
    if (switchToFile) {
      if (this.splitViewManager && this.splitViewManager.isOpen) {
        const side = this.splitViewManager.focusedPane || 'left';
        await this.splitViewManager.loadIntoPane(side, filePath);
      } else {
        await this.loadPDF(filePath, result.data, true);
      }
    }
  }

  async loadPDF(filePath, base64Data, isNew = true) {
    this.currentFilePath = filePath;
    document.getElementById('welcome-screen').style.display = 'none';
    document.getElementById('pdf-viewport').style.display = 'block';

    // Always reset annotation/bookmark/flashcard state before loading a new file.
    // Without this, drawings from the previous PDF bleed onto the newly loaded one
    // because the annotation engine still holds the old file's page data in memory.
    // Saved state is reloaded from disk immediately after, so nothing is lost.
    this.annotationEngine.pages = {};
    this.annotationEngine.undoStacks = {};
    this.annotationEngine.redoStacks = {};
    this.bookmarkManager.bookmarks = [];
    this.bookmarkManager.renderBookmarkList();
    this.flashcardManager.cards = [];
    this.flashcardManager.renderCards();

    if (filePath.startsWith('virtual://')) {
      await this.pdfViewer.loadNewNotebook(filePath);
    } else {
      await this.pdfViewer.loadPDF(base64Data, filePath);
    }

    // Load saved annotations
    const saved = await window.studyAPI.loadAnnotations(filePath);
    if (saved.success && saved.data) {
      this.restoreState(saved.data);
      // Re-render pages to show restored annotations
      await this.pdfViewer.renderAllPages();
    }

    document.title = `StudyInk — ${filePath.split(/[\\/]/).pop()}`;
  }

  // ── Auto-save ───────────────────────────────────────────────────────────

  scheduleAutoSave() {
    clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = setTimeout(() => this.autoSave(), 2000);
  }

  async autoSave() {
    if (this.splitViewManager && this.splitViewManager.isOpen) {
      await this.splitViewManager.saveAllPanes();
    }
    if (this.currentFilePath) {
      const state = this.buildSaveState();
      await window.studyAPI.saveAnnotations(this.currentFilePath, state);
    }
  }

  // ── State Serialization ─────────────────────────────────────────────────

  buildSaveState() {
    return {
      annotations: this.annotationEngine.serialize(),
      bookmarks: this.bookmarkManager.serialize(),
      flashcards: this.flashcardManager.serialize(),
      viewerState: this.pdfViewer.getState(),
      theme: this.themeManager.getState(),
    };
  }

  restoreState(data) {
    if (data.annotations) this.annotationEngine.deserialize(data.annotations);
    if (data.bookmarks) this.bookmarkManager.deserialize(data.bookmarks);
    if (data.flashcards) this.flashcardManager.deserialize(data.flashcards);
    if (data.viewerState) {
      if (data.viewerState.pages && Array.isArray(data.viewerState.pages)) {
        this.pdfViewer.pages = data.viewerState.pages.map(p => ({ ...p }));
      }
      if (data.viewerState.zoom) {
        this.pdfViewer.zoom = data.viewerState.zoom;
        const zoomLabel = document.getElementById('zoom-label');
        if (zoomLabel) zoomLabel.textContent = `${Math.round(this.pdfViewer.zoom * 100)}%`;
      }
    }
  }

  scheduleSaveSettings() {
    clearTimeout(this.saveSettingsTimer);
    this.saveSettingsTimer = setTimeout(() => this.saveSettings(), 1000);
  }

  async saveSettings() {
    const recentPaths = this.sidebar.openFiles.map(f => f.path);
    const activeFile = this.sidebar.getCurrentFile();
    const currentPage = this.pdfViewer ? this.pdfViewer.getCurrentPage() : 0;
    const settings = {
      theme: this.themeManager.getState(),
      isLightMode: this.isLightMode,
      recentFiles: recentPaths,
      activeFilePath: activeFile ? activeFile.path : null,
      lastPage: currentPage,
      zoom: this.pdfViewer ? this.pdfViewer.zoom : 1.0,
      panelWidth: document.getElementById('right-panel').style.width,
      splitView: (this.splitViewManager && this.splitViewManager.isOpen) ? {
        leftPath: this.splitViewManager.leftState?.filePath,
        rightPath: this.splitViewManager.rightState?.filePath,
      } : null
    };
    await window.studyAPI.saveSettings(settings);
  }

  async loadSettings() {
    const result = await window.studyAPI.loadSettings();
    if (result.success && result.data) {
      if (result.data.theme) this.themeManager.restoreState(result.data.theme);

      // Restore dark / light mode
      if (result.data.isLightMode && !this.isLightMode) {
        this.toggleLightMode();
      }

      // Restore resizable sidebar width
      if (result.data.panelWidth) {
        document.getElementById('right-panel').style.width = result.data.panelWidth;
      }

      // Restore previous sessions (sequential load)
      if (result.data.recentFiles && result.data.recentFiles.length > 0) {
        const activePath = result.data.activeFilePath;
        for (const filePath of result.data.recentFiles) {
          const makeActive = (filePath === activePath);
          await this.openFileFromPath(filePath, makeActive);
        }

        // Restore zoom level & last viewed page
        if (typeof result.data.lastPage === 'number' && result.data.lastPage >= 0) {
          setTimeout(() => {
            if (this.pdfViewer) {
              if (typeof result.data.zoom === 'number') {
                this.pdfViewer.setZoom(result.data.zoom);
              }
              this.pdfViewer.scrollToPage(result.data.lastPage);
            }
          }, 350);
        }
      }

      // Restore split view session if active
      if (result.data.splitView && result.data.splitView.leftPath && result.data.splitView.rightPath) {
        setTimeout(async () => {
          if (this.splitViewManager) {
            if (!this.isFullscreen) this.toggleFullscreen();
            await this.splitViewManager.openSplitView(result.data.splitView.leftPath, result.data.splitView.rightPath);
          }
        }, 600);
      }
    }
  }

  // ── UI Binding ──────────────────────────────────────────────────────────

  bindUI() {
    // Window controls
    document.getElementById('btn-minimize').addEventListener('click', () => window.studyAPI.minimize());
    document.getElementById('btn-maximize').addEventListener('click', () => window.studyAPI.maximize());
    document.getElementById('btn-close').addEventListener('click', async () => {
      await this.autoSave();
      await this.saveSettings();
      window.studyAPI.close();
    });

    window.addEventListener('beforeunload', () => {
      this.autoSave();
      this.saveSettings();
    });

    // Open file & New Notebook buttons
    document.getElementById('btn-open').addEventListener('click', () => this.openFile());
    document.getElementById('btn-welcome-open').addEventListener('click', () => this.openFile());
    document.getElementById('btn-new-notebook').addEventListener('click', () => this.createNewNotebook());
    document.getElementById('btn-welcome-new').addEventListener('click', () => this.createNewNotebook());

    // Zoom controls
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      this.pdfViewer.setZoom(this.pdfViewer.zoom + 0.15);
    });
    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      this.pdfViewer.setZoom(this.pdfViewer.zoom - 0.15);
    });
    document.getElementById('btn-zoom-fit').addEventListener('click', () => {
      const vw = document.getElementById('canvas-area').clientWidth - 48;
      const pageW = this.pdfViewer.pages.length > 0 ? (595) : 595;
      const fitZoom = Math.min(vw / pageW, 1.5);
      this.pdfViewer.setZoom(fitZoom);
    });

    // Tool buttons (main toolbar)
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;
        this.annotationEngine.toolState.tool = tool;
        document.body.dataset.tool = tool;

        document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        this.floatingToolbar.setTool(tool);
      });
    });

    document.getElementById('btn-paste-image')?.addEventListener('click', () => this.pasteClipboardImage());

    // Undo/Redo
    document.getElementById('btn-undo').addEventListener('click', () => {
      const page = this.pdfViewer.getCurrentPage();
      const canvas = document.querySelector(`.page-wrapper[data-page="${page}"] .page-annotation-canvas`);
      if (canvas) this.annotationEngine.undo(page, canvas);
    });
    document.getElementById('btn-redo').addEventListener('click', () => {
      const page = this.pdfViewer.getCurrentPage();
      const canvas = document.querySelector(`.page-wrapper[data-page="${page}"] .page-annotation-canvas`);
      if (canvas) this.annotationEngine.redo(page, canvas);
    });

    // Shape snap toggle
    document.getElementById('btn-shape-snap').addEventListener('click', (e) => {
      this.annotationEngine.shapeSnapEnabled = !this.annotationEngine.shapeSnapEnabled;
      e.currentTarget.classList.toggle('active', this.annotationEngine.shapeSnapEnabled);
      showToast(`Shape recognition ${this.annotationEngine.shapeSnapEnabled ? 'ON' : 'OFF'}`);
    });

    // Dark / Light mode toggle
    document.getElementById('btn-dark-light').addEventListener('click', () => this.toggleLightMode());

    // Fullscreen toggle
    document.getElementById('btn-fullscreen').addEventListener('click', () => this.toggleFullscreen());

    // Insert page
    document.getElementById('btn-insert-page').addEventListener('click', () => this.showInsertPageModal());

    // Insert page modal
    let insertPosition = 'after';
    document.getElementById('insert-before').addEventListener('click', (e) => {
      insertPosition = 'before';
      document.getElementById('insert-before').classList.add('active');
      document.getElementById('insert-after').classList.remove('active');
    });
    document.getElementById('insert-after').addEventListener('click', () => {
      insertPosition = 'after';
      document.getElementById('insert-after').classList.add('active');
      document.getElementById('insert-before').classList.remove('active');
    });
    document.getElementById('btn-confirm-insert').addEventListener('click', async () => {
      const bg = document.getElementById('insert-bg-select').value;
      document.getElementById('insert-page-modal').classList.add('hidden');
      if (this.splitViewManager && this.splitViewManager.isOpen) {
        const side = this.splitViewManager.focusedPane || 'left';
        const current = this.splitViewManager.getCurrentPanePage(side);
        const idx = insertPosition === 'after' ? current + 1 : current;
        await this.splitViewManager._insertBlankPage(side, idx, bg);
      } else {
        const current = this.pdfViewer.getCurrentPage();
        const idx = insertPosition === 'after' ? current + 1 : current;
        await this.pdfViewer.insertBlankPage(idx, bg);
        showToast(`Blank page inserted at position ${idx + 1}`, 'success');
      }
    });
    document.getElementById('btn-close-insert').addEventListener('click', () => {
      document.getElementById('insert-page-modal').classList.add('hidden');
    });

    // Page background
    document.getElementById('btn-page-bg').addEventListener('click', () => {
      document.getElementById('bg-modal').classList.remove('hidden');
    });
    document.getElementById('btn-close-bg').addEventListener('click', () => {
      document.getElementById('bg-modal').classList.add('hidden');
    });

    let selectedBg = 'white';
    document.querySelectorAll('.bg-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        document.querySelectorAll('.bg-opt').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        selectedBg = opt.dataset.bg;
      });
    });

    document.getElementById('btn-apply-bg').addEventListener('click', async () => {
      const applyAll = document.getElementById('bg-apply-all').checked;
      const customColor = document.getElementById('custom-bg-color').value;
      const bg = selectedBg === 'custom' ? 'custom' : selectedBg;

      if (this.splitViewManager && this.splitViewManager.isOpen) {
        const side = this.splitViewManager.focusedPane || 'left';
        const state = this.splitViewManager.getActivePaneState();
        if (state) {
          if (applyAll) {
            for (let i = 0; i < state.pages.length; i++) {
              this.splitViewManager._applyPaneBackground(side, i, bg, bg === 'custom' ? customColor : null);
            }
            showToast('Background applied to all pages in focused pane', 'success');
          } else {
            const page = this.splitViewManager.getCurrentPanePage(side);
            this.splitViewManager._applyPaneBackground(side, page, bg, bg === 'custom' ? customColor : null);
            showToast('Background applied to focused pane', 'success');
          }
          await this.splitViewManager._renderAllPanePages(side);
          this.scheduleAutoSave();
        }
      } else {
        if (applyAll) {
          for (let i = 0; i < this.pdfViewer.pages.length; i++) {
            this.pdfViewer.applyBackground(i, bg, bg === 'custom' ? customColor : null);
          }
          showToast('Background applied to all pages', 'success');
        } else {
          const page = this.pdfViewer.getCurrentPage();
          this.pdfViewer.applyBackground(page, bg, bg === 'custom' ? customColor : null);
          showToast('Background applied', 'success');
        }
        this.scheduleAutoSave();
        this.pdfViewer.updateThumbnails();
      }

      document.getElementById('bg-modal').classList.add('hidden');
    });

    document.getElementById('bg-modal').addEventListener('click', (e) => {
      if (e.target === document.getElementById('bg-modal')) document.getElementById('bg-modal').classList.add('hidden');
    });

    // Theme modal
    document.getElementById('btn-theme').addEventListener('click', () => {
      document.getElementById('theme-modal').classList.remove('hidden');
    });
    document.getElementById('btn-close-theme').addEventListener('click', () => {
      document.getElementById('theme-modal').classList.add('hidden');
    });
    document.getElementById('theme-modal').addEventListener('click', (e) => {
      if (e.target === document.getElementById('theme-modal')) document.getElementById('theme-modal').classList.add('hidden');
    });
    document.getElementById('btn-apply-custom-theme').addEventListener('click', () => {
      const color = document.getElementById('custom-accent-color').value;
      this.themeManager.applyCustomAccent(color);
      document.getElementById('theme-modal').classList.add('hidden');
    });

    // Search, Flashcard & Gemini buttons
    document.getElementById('btn-search').addEventListener('click', () => this.toggleRightPanel('search'));
    document.getElementById('btn-flashcard').addEventListener('click', () => this.toggleRightPanel('flashcards'));
    document.getElementById('btn-gemini').addEventListener('click', () => this.toggleRightPanel('gemini'));
    document.getElementById('ft-btn-gemini-toggle').addEventListener('click', () => this.toggleRightPanel('gemini'));
    document.getElementById('btn-close-rpanel').addEventListener('click', () => this.closeRightPanel());

    document.querySelectorAll('.right-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.right-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.rpanel').forEach(p => p.classList.remove('active'));
        document.getElementById(`rpanel-${tab.dataset.rtab}`).classList.add('active');
      });
    });

    // Track scroll to update current page and save session position
    document.getElementById('pdf-viewport')?.addEventListener('scroll', () => {
      this.currentPage = this.pdfViewer.getCurrentPage();
      // Update thumbnail highlight
      document.querySelectorAll('.thumb-item').forEach((t, i) => {
        t.classList.toggle('active', i === this.currentPage);
      });
      this.scheduleSaveSettings();
    });

    // Split View button (only visible in fullscreen)
    document.getElementById('ft-btn-split-view').addEventListener('click', () => {
      if (!this.isFullscreen) {
        showToast('Split view is only available in fullscreen mode', 'error');
        return;
      }
      this.splitViewManager.openPickerModal();
    });
  }

  showInsertPageModal() {
    document.getElementById('insert-page-modal').classList.remove('hidden');
  }

  openRightPanel(tab) {
    const panel = document.getElementById('right-panel');
    panel.classList.remove('hidden');
    document.querySelectorAll('.right-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.rtab === tab);
    });
    document.querySelectorAll('.rpanel').forEach(p => {
      p.classList.toggle('active', p.id === `rpanel-${tab}`);
    });
  }

  closeRightPanel() {
    document.getElementById('right-panel').classList.add('hidden');
    this.saveSettings();
  }

  toggleRightPanel(tab) {
    const panel = document.getElementById('right-panel');
    const isClosed = panel.classList.contains('hidden');
    const isSameTab = document.getElementById(`rpanel-${tab}`).classList.contains('active');

    if (isClosed) {
      this.openRightPanel(tab);
    } else if (isSameTab) {
      this.closeRightPanel();
    } else {
      this.openRightPanel(tab);
    }
  }

  initResizeHandler() {
    const panel = document.getElementById('right-panel');
    const handle = document.getElementById('panel-resize-handle');
    if (!panel || !handle) return;

    let startX, startWidth;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = panel.getBoundingClientRect().width;
      handle.classList.add('resizing');

      const onMouseMove = (ev) => {
        const deltaX = ev.clientX - startX;
        const newWidth = Math.max(250, Math.min(900, startWidth + deltaX));
        panel.style.width = `${newWidth}px`;
        panel.style.transition = 'none';
      };

      const onMouseUp = () => {
        handle.classList.remove('resizing');
        panel.style.transition = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        this.saveSettings();
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  toggleLightMode() {
    this.isLightMode = !this.isLightMode;
    document.body.classList.toggle('light-mode', this.isLightMode);

    // Update button icon and label
    const iconDark = document.getElementById('icon-dark');
    const iconLight = document.getElementById('icon-light');
    const label = document.getElementById('dark-light-label');
    if (this.isLightMode) {
      iconDark.style.display = 'none';
      iconLight.style.display = '';
      label.textContent = 'Dark';
    } else {
      iconDark.style.display = '';
      iconLight.style.display = 'none';
      label.textContent = 'Light';
    }
    showToast(this.isLightMode ? '☀️ Light mode' : '🌙 Dark mode');
  }

  toggleFullscreen() {
    this.isFullscreen = !this.isFullscreen;
    document.body.classList.toggle('fullscreen-mode', this.isFullscreen);
    if (this.isFullscreen) {
      showToast('Fullscreen — press Esc or F11 to exit');
    } else {
      // Close split view when leaving fullscreen
      if (this.splitViewManager && this.splitViewManager.isOpen) {
        this.splitViewManager.onFullscreenExit();
        // Update split button state
        const splitBtn = document.getElementById('ft-btn-split-view');
        if (splitBtn) splitBtn.classList.remove('active');
      }
    }
  }

  selectTool(tool) {
    this.annotationEngine.toolState.tool = tool;
    document.body.dataset.tool = tool;

    // Update main toolbar active states
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });

    // Update floating toolbar active states
    this.floatingToolbar.setTool(tool);

    showToast(`Tool: ${tool.toUpperCase()}`);
  }

  async pasteClipboardImage(clipboardData = null) {
    let dataUrl = null;

    if (clipboardData && clipboardData.items) {
      for (const item of clipboardData.items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            dataUrl = await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = (e) => resolve(e.target.result);
              reader.onerror = () => resolve(null);
              reader.readAsDataURL(file);
            });
          }
          break;
        }
      }
    }

    if (!dataUrl && window.studyAPI?.readClipboardImage) {
      dataUrl = await window.studyAPI.readClipboardImage();
    }

    if (!dataUrl) {
      showToast('No screenshot/image found in clipboard', 'error');
      return;
    }

    let activeAnnotEngine = this.annotationEngine;
    let targetPage = this.pdfViewer.getCurrentPage();
    let wrapper = document.querySelector(`.page-wrapper[data-page="${targetPage}"]`);

    if (this.splitViewManager && this.splitViewManager.isOpen) {
      const side = this.splitViewManager.focusedPane || 'left';
      const paneState = this.splitViewManager.getActivePaneState();
      if (paneState) {
        activeAnnotEngine = paneState.annotEngine;
        targetPage = this.splitViewManager.getCurrentPanePage(side);
        wrapper = document.querySelector(`#split-pages-${side} .page-wrapper[data-page="${targetPage}"][data-pane="${side}"]`);
      }
    }

    if (!wrapper) {
      showToast('Open a PDF page to paste screenshot', 'error');
      return;
    }

    activeAnnotEngine.addImageStamp(wrapper, targetPage, dataUrl);
    showToast('Screenshot pasted ✓', 'success');
  }

  async copyCurrentPageDrawing() {
    let targetPage = this.pdfViewer.getCurrentPage();
    let side = null;
    let isSplit = false;

    if (this.splitViewManager && this.splitViewManager.isOpen) {
      isSplit = true;
      side = this.splitViewManager.focusedPane || 'left';
      targetPage = this.splitViewManager.getCurrentPanePage(side);
    }

    const wrapper = isSplit
      ? document.querySelector(`#split-pages-${side} .page-wrapper[data-page="${targetPage}"][data-pane="${side}"]`)
      : document.querySelector(`.page-wrapper[data-page="${targetPage}"]`);

    if (!wrapper) {
      showToast('No active page found to copy drawing', 'error');
      return;
    }

    const annotCanvas = wrapper.querySelector('.page-annotation-canvas');
    if (!annotCanvas || annotCanvas.width === 0 || annotCanvas.height === 0) {
      showToast('No drawing found on current page', 'error');
      return;
    }

    const pageData = isSplit
      ? this.splitViewManager.getActivePaneState()?.annotEngine?.getPageData(targetPage)
      : this.annotationEngine.getPageData(targetPage);

    if (!pageData || !pageData.strokes || pageData.strokes.length === 0) {
      showToast(`No drawings on page ${targetPage + 1}`, 'error');
      return;
    }

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = annotCanvas.width;
    tempCanvas.height = annotCanvas.height;
    const ctx = tempCanvas.getContext('2d');
    ctx.drawImage(annotCanvas, 0, 0);

    const dataUrl = tempCanvas.toDataURL('image/png');

    if (window.studyAPI?.writeClipboardImage) {
      const res = await window.studyAPI.writeClipboardImage(dataUrl);
      if (res && res.success) {
        showToast(`Drawing on page ${targetPage + 1} copied to clipboard ✓`, 'success');
      } else {
        showToast('Failed to copy drawing', 'error');
      }
    } else {
      showToast('Clipboard write not available', 'error');
    }
  }

  // ── Keyboard Shortcuts ──────────────────────────────────────────────────

  bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key === 'o') { e.preventDefault(); this.openFile(); }
      if (ctrl && e.key === 's') { e.preventDefault(); this.exportManager.save(false); }
      if (ctrl && e.key === 'z') {
        e.preventDefault();
        if (this.splitViewManager && this.splitViewManager.isOpen) {
          const pState = this.splitViewManager.getActivePaneState();
          const side = this.splitViewManager.focusedPane;
          const page = this.splitViewManager.getCurrentPanePage(side);
          const canvas = document.querySelector(`#split-pages-${side} .page-wrapper[data-page="${page}"] .page-annotation-canvas`);
          if (canvas && pState) pState.annotEngine.undo(page, canvas);
        } else {
          const page = this.pdfViewer.getCurrentPage();
          const canvas = document.querySelector(`.page-wrapper[data-page="${page}"] .page-annotation-canvas`);
          if (canvas) this.annotationEngine.undo(page, canvas);
        }
      }
      if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
        e.preventDefault();
        if (this.splitViewManager && this.splitViewManager.isOpen) {
          const pState = this.splitViewManager.getActivePaneState();
          const side = this.splitViewManager.focusedPane;
          const page = this.splitViewManager.getCurrentPanePage(side);
          const canvas = document.querySelector(`#split-pages-${side} .page-wrapper[data-page="${page}"] .page-annotation-canvas`);
          if (canvas && pState) pState.annotEngine.redo(page, canvas);
        } else {
          const page = this.pdfViewer.getCurrentPage();
          const canvas = document.querySelector(`.page-wrapper[data-page="${page}"] .page-annotation-canvas`);
          if (canvas) this.annotationEngine.redo(page, canvas);
        }
      }
      if (ctrl && e.key === 'f') { e.preventDefault(); this.openRightPanel('search'); }
      if (ctrl && e.key === '=') { e.preventDefault(); this.pdfViewer.setZoom(this.pdfViewer.zoom + 0.15); }
      if (ctrl && e.key === '-') { e.preventDefault(); this.pdfViewer.setZoom(this.pdfViewer.zoom - 0.15); }
      if (ctrl && e.key.toLowerCase() === 'v') {
        if (!['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
          e.preventDefault();
          this.pasteClipboardImage();
        }
      }

      // F11 toggles fullscreen
      if (e.key === 'F11') { e.preventDefault(); this.toggleFullscreen(); }

      // Tool shortcuts (only when not typing in an input)
      if (!['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        let tool = null;
        const key = e.key.toLowerCase();
        const code = e.code;

        if (key === '1' || code === 'Digit1') tool = 'pen';
        else if (key === '2' || code === 'Digit2') tool = 'eraser';
        else if (key === '3' || code === 'Digit3') tool = 'highlighter';
        else if (key === '4' || code === 'Digit4') {
          e.preventDefault();
          this.copyCurrentPageDrawing();
        }
        else if (key === 'p' || code === 'KeyP') tool = 'pen';
        else if (key === 'e' || code === 'KeyE') tool = 'eraser';
        else if (key === 'h' || code === 'KeyH') tool = 'highlighter';
        else if (key === 't' || code === 'KeyT') tool = 'text';
        else if (key === 'n' || code === 'KeyN') tool = 'sticky';
        else if (key === 'v' || code === 'KeyV') tool = 'select';
        else if (key === 's' || code === 'KeyS') tool = 'shape';
        else if (key === 'b' || code === 'KeyB') {
          e.preventDefault();
          this.bookmarkManager.toggleBookmark();
        }

        // Arrow keys: Up/Down change pen size, Left/Right change pen color
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.floatingToolbar.changePenSize(0.5);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.floatingToolbar.changePenSize(-0.5);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          this.floatingToolbar.cyclePenColor(1);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          this.floatingToolbar.cyclePenColor(-1);
        }

        if (tool) {
          e.preventDefault();
          this.selectTool(tool);
        }
        if (e.key === 'Escape') {
          const hasOpenModal = [...document.querySelectorAll('.modal')].some(m => !m.classList.contains('hidden'));
          if (hasOpenModal) {
            document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
          } else if (this.isFullscreen) {
            this.toggleFullscreen();
          } else {
            this.closeRightPanel();
          }
        }
      }
    });

    // Zoom with Ctrl+Scroll
    document.getElementById('pdf-viewport')?.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        this.pdfViewer.setZoom(this.pdfViewer.zoom + delta);
      }
    }, { passive: false });

    // Paste event listener for images/screenshots
    document.addEventListener('paste', (e) => {
      if (!['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        if (e.clipboardData && Array.from(e.clipboardData.items).some(item => item.type.startsWith('image/'))) {
          e.preventDefault();
          this.pasteClipboardImage(e.clipboardData);
        }
      }
    });
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  new AppState();
});
