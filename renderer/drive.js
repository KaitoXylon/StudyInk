/**
 * drive.js — Google Drive Sync UI Manager
 * Handles Drive sidebar panel, auto-sync on save, file listing, download, and conflict resolution.
 */

class DriveManager {
  constructor(appState) {
    this.app = appState;
    this.isConnected = false;
    this.userEmail = null;
    this._pendingConflict = null; // { fileId, localPath, fileName, localMod, driveMod }
    this._syncQueue = new Set(); // paths currently being uploaded
    this._connectPollTimer = null;

    this._bindSidebar();
    this._bindConflictModal();
    this._checkStatus();
  }

  // ── Status & Connection ───────────────────────────────────────────────────

  async _checkStatus() {
    if (!window.studyAPI?.driveGetStatus) return;
    try {
      const status = await window.studyAPI.driveGetStatus();
      this._applyStatus(status);
      if (status.connected) this._loadDriveFiles();
    } catch (e) {
      console.error('[Drive] Status check failed:', e);
    }
  }

  _applyStatus(status) {
    this.isConnected = status.connected;
    this.userEmail = status.email || null;

    // Update Drive sidebar status indicator
    const indicator = document.getElementById('drive-status-indicator');
    const statusText = document.getElementById('drive-status-text');
    const emailEl = document.getElementById('drive-status-email');
    const connectArea = document.getElementById('drive-connect-area');
    const filesArea = document.getElementById('drive-files-area');
    const disconnectArea = document.getElementById('drive-disconnect-area');
    const syncDot = document.getElementById('drive-sync-dot');
    const driveBtn = document.getElementById('btn-drive');

    if (status.connected) {
      indicator?.classList.remove('drive-status-disconnected');
      indicator?.classList.add('drive-status-connected');
      if (statusText) statusText.textContent = 'Connected';
      if (emailEl) {
        emailEl.textContent = status.email || '';
        emailEl.classList.remove('hidden');
      }
      connectArea?.classList.add('hidden');
      filesArea?.classList.remove('hidden');
      disconnectArea?.classList.remove('hidden');
      syncDot?.classList.remove('hidden');
      driveBtn?.classList.add('drive-connected');
    } else {
      indicator?.classList.remove('drive-status-connected');
      indicator?.classList.add('drive-status-disconnected');
      if (statusText) statusText.textContent = 'Not connected';
      emailEl?.classList.add('hidden');
      connectArea?.classList.remove('hidden');
      filesArea?.classList.add('hidden');
      disconnectArea?.classList.add('hidden');
      syncDot?.classList.add('hidden');
      driveBtn?.classList.remove('drive-connected');
    }
  }

  async connect() {
    if (!window.studyAPI?.driveConnect) return;
    try {
      showToast('Opening Google sign-in...', 'info');
      await window.studyAPI.driveConnect();
      // Poll for auth completion (up to 3 minutes)
      let attempts = 0;
      this._connectPollTimer = setInterval(async () => {
        attempts++;
        const status = await window.studyAPI.driveGetStatus();
        if (status.connected) {
          clearInterval(this._connectPollTimer);
          this._applyStatus(status);
          showToast('✅ Connected to Google Drive!', 'success');
          this._loadDriveFiles();
        } else if (attempts > 36) { // 3 minutes
          clearInterval(this._connectPollTimer);
        }
      }, 5000);
    } catch (e) {
      showToast('Drive connection failed: ' + e.message, 'error');
    }
  }

  async disconnect() {
    if (!window.studyAPI?.driveDisconnect) return;
    try {
      await window.studyAPI.driveDisconnect();
      clearInterval(this._connectPollTimer);
      this._applyStatus({ connected: false });
      document.getElementById('drive-file-list').innerHTML = '';
      showToast('Disconnected from Google Drive');
    } catch (e) {
      showToast('Disconnect failed: ' + e.message, 'error');
    }
  }

  // ── Auto-sync: called after every save ────────────────────────────────────

  async syncAfterSave(pdfPath, annotationData) {
    if (!this.isConnected) return;
    if (!pdfPath || pdfPath.startsWith('virtual://')) return;
    if (this._syncQueue.has(pdfPath)) return; // already uploading

    this._syncQueue.add(pdfPath);
    this._showSyncing(true);

    try {
      // Upload annotations (fast, always)
      if (annotationData) {
        await window.studyAPI.driveUploadAnnotations(pdfPath, annotationData);
      }
      // Upload the PDF itself (background, non-blocking feel)
      window.studyAPI.driveUploadPDF(pdfPath).then(result => {
        if (result.success) {
          console.log('[Drive] PDF synced:', pdfPath, result.action);
        }
      }).catch(err => {
        console.error('[Drive] PDF upload failed:', err);
      });
    } catch (e) {
      console.error('[Drive] Sync failed:', e);
    } finally {
      this._syncQueue.delete(pdfPath);
      if (this._syncQueue.size === 0) {
        // Keep dot visible a bit so user sees it synced
        setTimeout(() => this._showSyncing(false), 1500);
      }
    }
  }

  _showSyncing(active) {
    const dot = document.getElementById('drive-sync-dot');
    if (!dot) return;
    if (active) {
      dot.classList.remove('hidden');
      dot.classList.add('syncing');
    } else {
      dot.classList.remove('syncing');
      // Keep visible as stable connected indicator
    }
  }

  // ── Drive File Browser ────────────────────────────────────────────────────

  async _loadDriveFiles() {
    if (!this.isConnected) return;

    const loading = document.getElementById('drive-loading');
    const fileList = document.getElementById('drive-file-list');
    const emptyHint = document.getElementById('drive-empty-hint');

    loading?.classList.remove('hidden');
    if (fileList) fileList.innerHTML = '';
    emptyHint?.classList.add('hidden');

    try {
      const result = await window.studyAPI.driveListFiles();
      loading?.classList.add('hidden');

      if (!result.success || !result.files || result.files.length === 0) {
        emptyHint?.classList.remove('hidden');
        return;
      }

      if (fileList) {
        result.files.forEach(file => {
          const item = this._buildFileItem(file);
          fileList.appendChild(item);
        });
      }
    } catch (e) {
      loading?.classList.add('hidden');
      emptyHint?.classList.remove('hidden');
      console.error('[Drive] List files error:', e);
    }
  }

  _buildFileItem(file) {
    const div = document.createElement('div');
    div.className = 'drive-file-item';
    div.title = file.name;

    const sizeStr = file.size ? this._formatSize(parseInt(file.size)) : '';
    const dateStr = file.modifiedTime ? this._formatDate(file.modifiedTime) : '';

    div.innerHTML = `
      <div class="drive-file-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <polyline points="10 9 9 9 8 9"/>
        </svg>
      </div>
      <div class="drive-file-info">
        <div class="drive-file-name">${this._escHtml(file.name)}</div>
        <div class="drive-file-meta">${sizeStr ? sizeStr + ' · ' : ''}${dateStr}</div>
      </div>
      <button class="drive-file-download-btn" title="Download &amp; Open" data-file-id="${file.id}" data-file-name="${this._escHtml(file.name)}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="8 17 12 21 16 17"/>
          <line x1="12" y1="12" x2="12" y2="21"/>
          <path d="M20.88 18.09A5 5 0 0018 9h-1.26A8 8 0 103 16.29"/>
        </svg>
      </button>
    `;

    div.querySelector('.drive-file-download-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      this._downloadAndOpen(btn.dataset.fileId, btn.dataset.fileName, btn);
    });

    return div;
  }

  async _downloadAndOpen(fileId, fileName, btnEl) {
    if (!window.studyAPI?.driveDownloadFile) return;

    // Save to Downloads folder
    let downloadsPath;
    try {
      downloadsPath = await window.studyAPI.driveGetDownloadsPath();
    } catch (e) {
      downloadsPath = null;
    }

    const destPath = downloadsPath
      ? `${downloadsPath}\\StudyLink\\${fileName}`
      : `C:\\Users\\${fileName}`;

    // Show loading state on button
    if (btnEl) {
      btnEl.innerHTML = '<div class="drive-spinner" style="width:14px;height:14px;border-width:2px"></div>';
      btnEl.disabled = true;
    }

    try {
      // Ensure the destination directory exists (create StudyLink subfolder in Downloads)
      // We rely on the main process creating directories — but we can use a trick:
      // For now use temp approach: download, check conflict, open
      const result = await window.studyAPI.driveDownloadFile(fileId, destPath);

      if (result.conflict) {
        // Show conflict modal
        this._showConflictModal(result, fileId, destPath, fileName);
      } else if (result.success) {
        showToast(`Downloaded: ${fileName}`, 'success');
        await this.app.openFileFromPath(result.path, true);
      } else {
        // May fail if directory doesn't exist — try creating via a different path
        showToast('Download failed: ' + (result.error || 'Unknown error'), 'error');
      }
    } catch (e) {
      showToast('Download error: ' + e.message, 'error');
    } finally {
      if (btnEl) {
        btnEl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/>
          <path d="M20.88 18.09A5 5 0 0018 9h-1.26A8 8 0 103 16.29"/>
        </svg>`;
        btnEl.disabled = false;
      }
    }
  }

  // ── Conflict Resolution ───────────────────────────────────────────────────

  _showConflictModal({ fileName, localModified, driveModified, localPath }, fileId, destPath, name) {
    this._pendingConflict = { fileId, localPath: localPath || destPath, fileName: name || fileName };

    const modal = document.getElementById('drive-conflict-modal');
    const fileNameEl = document.getElementById('conflict-filename');
    const localTimeEl = document.getElementById('conflict-local-time');
    const driveTimeEl = document.getElementById('conflict-drive-time');

    if (fileNameEl) fileNameEl.textContent = name || fileName;
    if (localTimeEl) localTimeEl.textContent = 'Last modified: ' + new Date(localModified).toLocaleString();
    if (driveTimeEl) driveTimeEl.textContent = 'Last modified: ' + new Date(driveModified).toLocaleString();

    modal?.classList.remove('hidden');
  }

  _bindConflictModal() {
    document.getElementById('btn-close-conflict')?.addEventListener('click', () => {
      document.getElementById('drive-conflict-modal')?.classList.add('hidden');
      this._pendingConflict = null;
    });

    document.getElementById('btn-conflict-keep-local')?.addEventListener('click', async () => {
      document.getElementById('drive-conflict-modal')?.classList.add('hidden');
      if (this._pendingConflict) {
        // Upload local to Drive (overwrite Drive version)
        showToast('Keeping local version & uploading to Drive...', 'info');
        await window.studyAPI.driveUploadPDF(this._pendingConflict.localPath);
        showToast('Local version uploaded to Drive ✓', 'success');
        this._pendingConflict = null;
      }
    });

    document.getElementById('btn-conflict-use-drive')?.addEventListener('click', async () => {
      document.getElementById('drive-conflict-modal')?.classList.add('hidden');
      if (this._pendingConflict) {
        const { fileId, localPath, fileName } = this._pendingConflict;
        this._pendingConflict = null;
        showToast('Downloading Drive version...', 'info');
        const result = await window.studyAPI.driveForceDownload(fileId, localPath);
        if (result.success) {
          showToast('Drive version downloaded ✓', 'success');
          await this.app.openFileFromPath(result.path, true);
        } else {
          showToast('Download failed: ' + (result.error || ''), 'error');
        }
      }
    });
  }

  // ── Sidebar Binding ───────────────────────────────────────────────────────

  _bindSidebar() {
    // Drive sidebar tab
    document.querySelector('[data-tab="drive"]')?.addEventListener('click', () => {
      if (this.isConnected) this._loadDriveFiles();
    });

    // Connect button
    document.getElementById('btn-drive-connect')?.addEventListener('click', () => this.connect());

    // Disconnect button
    document.getElementById('btn-drive-disconnect')?.addEventListener('click', () => this.disconnect());

    // Refresh button
    document.getElementById('btn-drive-refresh')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-drive-refresh');
      btn?.classList.add('spinning');
      await this._loadDriveFiles();
      btn?.classList.remove('spinning');
    });

    // Toolbar Drive button → open Drive tab in sidebar
    document.getElementById('btn-drive')?.addEventListener('click', () => {
      // Switch sidebar to Drive tab
      document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
      const driveTab = document.querySelector('[data-tab="drive"]');
      const drivePanel = document.getElementById('panel-drive');
      driveTab?.classList.add('active');
      drivePanel?.classList.add('active');
      if (this.isConnected) this._loadDriveFiles();
    });
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  _formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  _formatDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch { return ''; }
  }

  _escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
}
