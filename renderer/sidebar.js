/**
 * sidebar.js — File Manager & Page Thumbnail Sidebar
 */

class Sidebar {
  constructor(pdfViewer, appState) {
    this.pdfViewer = pdfViewer;
    this.appState = appState;
    this.openFiles = []; // Array of { name, path, base64 }
    this.activeFileIndex = -1;
    this._contextMenu = null;
    this._contextTargetIndex = -1;
    this.init();
  }

  init() {
    // Tab switching
    document.querySelectorAll('.sidebar-tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
    });

    // Open sidebar button
    document.getElementById('btn-open-sidebar').addEventListener('click', () => {
      this.appState.openFile();
    });

    // Add/delete page buttons in sidebar
    document.getElementById('btn-add-page-sidebar').addEventListener('click', () => {
      this.appState.showInsertPageModal();
    });

    document.getElementById('btn-del-page-sidebar').addEventListener('click', () => {
      const page = this.pdfViewer.getCurrentPage();
      if (confirm(`Delete page ${page + 1}?`)) {
        this.pdfViewer.deletePage(page);
      }
    });

    // Drop zone
    const dropZone = document.getElementById('drop-zone');
    const body = document.body;

    body.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });

    body.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || !body.contains(e.relatedTarget)) {
        dropZone.classList.remove('drag-over');
      }
    });

    body.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.pdf'));
      for (const file of files) {
        await this.appState.openFileFromPath(file.path);
      }
    });

    // Build and attach the context menu element
    this._buildContextMenu();

    // Dismiss context menu on click outside
    document.addEventListener('click', (e) => {
      if (this._contextMenu && !this._contextMenu.contains(e.target)) {
        this._hideContextMenu();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._hideContextMenu();
    });
  }

  // ── Context Menu ───────────────────────────────────────────────────────────

  _buildContextMenu() {
    const menu = document.createElement('div');
    menu.id = 'file-context-menu';
    menu.className = 'file-context-menu hidden';
    menu.innerHTML = `
      <button class="ctx-item" id="ctx-rename">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
        Rename
      </button>
      <div class="ctx-divider"></div>
      <button class="ctx-item ctx-danger" id="ctx-close">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
        Close
      </button>
    `;
    document.body.appendChild(menu);
    this._contextMenu = menu;

    document.getElementById('ctx-rename').addEventListener('click', () => {
      this._hideContextMenu();
      if (this._contextTargetIndex >= 0) this._startInlineRename(this._contextTargetIndex);
    });

    document.getElementById('ctx-close').addEventListener('click', () => {
      this._hideContextMenu();
      if (this._contextTargetIndex >= 0) this.closeFile(this._contextTargetIndex);
    });
  }

  _showContextMenu(e, index) {
    e.preventDefault();
    this._contextTargetIndex = index;
    const menu = this._contextMenu;
    menu.classList.remove('hidden');

    // Position near cursor, keeping inside viewport
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = e.clientX;
    let y = e.clientY;

    // Temporarily show to measure
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    if (x + mw > vw) x = vw - mw - 6;
    if (y + mh > vh) y = vh - mh - 6;

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }

  _hideContextMenu() {
    this._contextMenu?.classList.add('hidden');
    this._contextTargetIndex = -1;
  }

  // ── Inline Rename ─────────────────────────────────────────────────────────

  _startInlineRename(index) {
    const file = this.openFiles[index];
    if (!file) return;

    // Virtual notebooks can be renamed too (name only, no disk op)
    const isVirtual = file.path.startsWith('virtual://');

    const list = document.getElementById('file-list');
    const item = list.children[index];
    if (!item) return;

    const nameEl = item.querySelector('.file-item-name');
    if (!nameEl) return;

    // Strip .pdf from display name for editing
    const baseName = file.name.replace(/\.pdf$/i, '');

    // Replace name element with an input
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'file-rename-input';
    input.value = baseName;

    nameEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
      const newBaseName = input.value.trim();
      if (!newBaseName || newBaseName === baseName) {
        // No change — restore original
        input.replaceWith(nameEl);
        return;
      }

      const newName = newBaseName.endsWith('.pdf') ? newBaseName : newBaseName + '.pdf';

      if (isVirtual) {
        // Virtual: just rename in memory
        file.name = newName;
        nameEl.textContent = newName;
        input.replaceWith(nameEl);
        document.title = `StudyInk — ${newName}`;
        this.appState.saveSettings();
        showToast(`Renamed to "${newName}"`, 'success');
        return;
      }

      // Real file: rename on disk
      const result = await window.studyAPI.renameFile(file.path, newName);
      if (result.success) {
        // Update in-memory record
        const oldPath = file.path;
        file.name = result.newName;
        file.path = result.newPath;

        // Update window title if this is the active file
        if (index === this.activeFileIndex) {
          document.title = `StudyInk — ${result.newName}`;
          this.appState.currentFilePath = result.newPath;
        }

        nameEl.textContent = result.newName;
        input.replaceWith(nameEl);

        // Update path label too
        const pathEl = item.querySelector('.file-item-path');
        if (pathEl) pathEl.textContent = result.newPath;

        this.appState.saveSettings();
        showToast(`Renamed to "${result.newName}"`, 'success');
      } else {
        input.replaceWith(nameEl);
        showToast('Rename failed: ' + result.error, 'error');
      }
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') {
        input.removeEventListener('blur', commit);
        input.replaceWith(nameEl);
      }
    });
  }

  // ── Tab Switching ──────────────────────────────────────────────────────────

  switchTab(tab) {
    document.querySelectorAll('.sidebar-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    document.querySelectorAll('.sidebar-panel').forEach(p => {
      p.classList.toggle('active', p.id === `panel-${tab}`);
    });
  }

  // ── File List ──────────────────────────────────────────────────────────────

  addFile(name, path, base64) {
    // Check for duplicate
    const exists = this.openFiles.findIndex(f => f.path === path);
    if (exists >= 0) {
      this.setActiveFile(exists);
      return;
    }
    this.openFiles.push({ name, path, base64 });
    this.setActiveFile(this.openFiles.length - 1);
    this.renderFileList();
    this.appState.saveSettings();
  }

  setActiveFile(index) {
    this.activeFileIndex = index;
    this.renderFileList();
  }

  renderFileList() {
    const list = document.getElementById('file-list');
    const dropZone = document.getElementById('drop-zone');
    list.innerHTML = '';

    if (this.openFiles.length === 0) {
      dropZone.style.display = 'block';
      return;
    }
    dropZone.style.display = this.openFiles.length === 0 ? 'block' : 'none';

    this.openFiles.forEach((file, i) => {
      const item = document.createElement('div');
      item.className = `file-item ${i === this.activeFileIndex ? 'active' : ''}`;
      item.innerHTML = `
        <div class="file-item-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="2"/>
            <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="2"/>
          </svg>
        </div>
        <div class="file-item-info">
          <div class="file-item-name">${file.name}</div>
          <div class="file-item-path">${file.path}</div>
        </div>
        <div class="file-item-close" title="Close">✕</div>
      `;

      // Left click
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('file-item-close')) {
          this.closeFile(i);
        } else {
          this.switchToFile(i);
        }
      });

      // Right click → context menu
      item.addEventListener('contextmenu', (e) => {
        this._showContextMenu(e, i);
      });

      // Double-click → rename inline
      item.addEventListener('dblclick', (e) => {
        if (!e.target.classList.contains('file-item-close')) {
          this._startInlineRename(i);
        }
      });

      list.appendChild(item);
    });
  }

  async switchToFile(index) {
    this.activeFileIndex = index;
    this.renderFileList();
    const file = this.openFiles[index];
    await this.appState.loadPDF(file.path, file.base64, false);
    this.appState.saveSettings();
  }

  closeFile(index) {
    this.openFiles.splice(index, 1);
    if (this.activeFileIndex >= this.openFiles.length) {
      this.activeFileIndex = this.openFiles.length - 1;
    }
    this.renderFileList();
    if (this.openFiles.length > 0) {
      this.switchToFile(this.activeFileIndex);
    } else {
      // Show welcome screen
      document.getElementById('welcome-screen').style.display = 'flex';
      document.getElementById('pdf-viewport').style.display = 'none';
      this.appState.saveSettings();
    }
  }

  getCurrentFile() {
    return this.activeFileIndex >= 0 ? this.openFiles[this.activeFileIndex] : null;
  }
}

window.Sidebar = Sidebar;
