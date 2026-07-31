/**
 * export.js — PDF Export using pdf-lib
 * Flattens canvas annotations onto PDF pages and exports.
 * Handles both overwrite and Save As workflows.
 */

class ExportManager {
  constructor(pdfViewer, annotationEngine) {
    this.pdfViewer = pdfViewer;
    this.annotEngine = annotationEngine;
    this.init();
  }

  init() {
    document.getElementById('btn-save').addEventListener('click', () => this.save(false));
    document.getElementById('btn-saveas').addEventListener('click', () => this.save(true));
  }

  async save(saveAs = false) {
    if (window.appState?.splitViewManager?.isOpen) {
      await window.appState.splitViewManager.saveAllPanes();
    }
    const sidebar = window.appState?.sidebar;
    let currentFile = sidebar?.getCurrentFile();
    let filePath = currentFile?.path || null;

    if (window.appState?.splitViewManager?.isOpen) {
      const activeState = window.appState.splitViewManager.getActivePaneState();
      if (activeState && activeState.filePath) {
        filePath = activeState.filePath;
        currentFile = sidebar?.openFiles.find(f => f.path === filePath) || currentFile;
      }
    }

    const isVirtual = filePath && filePath.startsWith('virtual://');

    showToast('Exporting PDF...', '');
    try {
      const base64 = await this.buildExportedPDF();
      if (!base64) { showToast('Nothing to export', 'error'); return; }

      if (saveAs || !filePath || isVirtual) {
        const defaultName = (filePath && !isVirtual) ? filePath.split(/[\\/]/).pop() : 'StudyInk_Notebook.pdf';
        const result = await window.studyAPI.saveFileDialog(base64, defaultName);
        if (result.success) {
          showToast(`Saved: ${result.path}`, 'success');
          // Update file properties if it was virtual
          if (isVirtual && currentFile) {
            currentFile.path = result.path;
            currentFile.name = result.path.split(/[\\/]/).pop();
            if (window.appState?.splitViewManager?.isOpen) {
              const activeState = window.appState.splitViewManager.getActivePaneState();
              if (activeState) activeState.filePath = result.path;
            } else {
              window.appState.currentFilePath = result.path;
              document.title = `StudyInk — ${currentFile.name}`;
            }
            sidebar.renderFileList();
            window.appState.saveSettings();
          }
        } else if (!result.canceled) {
          showToast('Save failed: ' + result.error, 'error');
        }
      } else {
        const result = await window.studyAPI.saveFile(filePath, base64);
        if (result.success) showToast('Overwritten successfully ✓', 'success');
        else showToast('Save failed: ' + result.error, 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('Export error: ' + err.message, 'error');
    }
  }

  async buildExportedPDF() {
    let pages = this.pdfViewer.pages;
    let isSplit = false;
    let side = null;

    if (window.appState?.splitViewManager?.isOpen) {
      const activeState = window.appState.splitViewManager.getActivePaneState();
      if (activeState && activeState.pages) {
        pages = activeState.pages;
        isSplit = true;
        side = window.appState.splitViewManager.focusedPane;
      }
    }

    if (pages.length === 0) return null;

    const { PDFDocument, rgb, degrees } = window.PDFLib || {};
    if (!PDFLib) { showToast('pdf-lib not loaded', 'error'); return null; }

    const exportDoc = await PDFLib.PDFDocument.create();

    for (let i = 0; i < pages.length; i++) {
      const wrapper = isSplit
        ? document.querySelector(`#split-pages-${side} .page-wrapper[data-page="${i}"][data-pane="${side}"]`)
        : document.querySelector(`.page-wrapper[data-page="${i}"]`);

      // Get merged canvas image (bg + pdf + annotations)
      const mergedCanvas = document.createElement('canvas');
      const bgCanvas = wrapper?.querySelector('.page-bg-canvas');
      const pdfCanvas = wrapper?.querySelector('.page-pdf-canvas');
      const annotCanvas = wrapper?.querySelector('.page-annotation-canvas');

      if (!bgCanvas) continue;
      mergedCanvas.width = bgCanvas.width;
      mergedCanvas.height = bgCanvas.height;
      const ctx = mergedCanvas.getContext('2d');

      if (bgCanvas.width > 0) ctx.drawImage(bgCanvas, 0, 0);
      if (pdfCanvas && pdfCanvas.width > 0) ctx.drawImage(pdfCanvas, 0, 0);
      if (annotCanvas && annotCanvas.width > 0) ctx.drawImage(annotCanvas, 0, 0);

      // Render overlay image stamps into merged canvas for export
      const pageData = isSplit
        ? window.appState?.splitViewManager?._getState(side)?.annotEngine?.getPageData(i)
        : this.annotEngine.getPageData(i);

      if (pageData && pageData.imageStamps && pageData.imageStamps.length > 0) {
        const baseW = parseFloat(wrapper?.dataset.baseWidth) || 595;
        const baseH = parseFloat(wrapper?.dataset.baseHeight) || 842;
        const scaleX = mergedCanvas.width / baseW;
        const scaleY = mergedCanvas.height / baseH;

        for (const imgStamp of pageData.imageStamps) {
          await new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
              ctx.drawImage(img, imgStamp.x * scaleX, imgStamp.y * scaleY, imgStamp.width * scaleX, imgStamp.height * scaleY);
              resolve();
            };
            img.onerror = resolve;
            img.src = imgStamp.dataUrl;
          });
        }
      }

      // Convert canvas to PNG
      const imgData = mergedCanvas.toDataURL('image/png');
      const base64 = imgData.split(',')[1];
      const imgBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

      const pngImage = await exportDoc.embedPng(imgBytes);
      const { width, height } = pngImage.scale(1);

      const page = exportDoc.addPage([width, height]);
      page.drawImage(pngImage, { x: 0, y: 0, width, height });
    }

    const pdfBytes = await exportDoc.save();
    const base64 = btoa(String.fromCharCode(...pdfBytes));
    return base64;
  }
}

window.ExportManager = ExportManager;
