/**
 * export.js — High-DPI PDF Export using pdf-lib
 * Flattens annotations onto high-resolution canvases (2.5x / 180-220 DPI)
 * and safely exports multi-page PDFs without call stack size limit errors.
 */

function uint8ArrayToBase64(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  const chunkSize = 0x8000; // 32KB chunks to prevent "Maximum call stack size exceeded"
  for (let i = 0; i < len; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, len)));
  }
  return btoa(binary);
}

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

    showToast('Exporting high-quality PDF...', '');
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

    const { PDFDocument } = window.PDFLib || {};
    if (!window.PDFLib) { showToast('pdf-lib not loaded', 'error'); return null; }

    const exportDoc = await window.PDFLib.PDFDocument.create();

    const pdfViewerObj = isSplit
      ? window.appState?.splitViewManager?.getActivePaneState()
      : this.pdfViewer;
    const annotEngineObj = isSplit
      ? window.appState?.splitViewManager?._getState(side)?.annotEngine
      : this.annotEngine;

    // High-resolution export scale: 2.5x yields ~180-220 DPI (crisp, vector-sharp lines without blur)
    const exportScale = 2.5;

    for (let i = 0; i < pages.length; i++) {
      const pageDesc = pages[i];
      const wrapper = isSplit
        ? document.querySelector(`#split-pages-${side} .page-wrapper[data-page="${i}"][data-pane="${side}"]`)
        : document.querySelector(`.page-wrapper[data-page="${i}"]`);

      const baseW = Math.max(100, pageDesc.baseWidth || parseFloat(wrapper?.dataset.baseWidth) || 595);
      const baseH = Math.max(100, pageDesc.baseHeight || parseFloat(wrapper?.dataset.baseHeight) || 842);

      const exportW = Math.round(baseW * exportScale);
      const exportH = Math.round(baseH * exportScale);

      const mergedCanvas = document.createElement('canvas');
      mergedCanvas.width = exportW;
      mergedCanvas.height = exportH;
      const ctx = mergedCanvas.getContext('2d');

      // 1. Render Background Pattern / Color
      const bgType = pageDesc.background || 'white';
      const bgColor = pageDesc.bgColor;
      ctx.save();
      if (bgType === 'lined') {
        ctx.fillStyle = bgColor || '#ffffff';
        ctx.fillRect(0, 0, exportW, exportH);
        const lineSpacing = 28 * exportScale;
        ctx.strokeStyle = '#d1d5db';
        ctx.lineWidth = 0.8 * exportScale;
        for (let y = lineSpacing; y < exportH; y += lineSpacing) {
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(exportW, y); ctx.stroke();
        }
        ctx.strokeStyle = '#fca5a5';
        ctx.lineWidth = 1 * exportScale;
        ctx.beginPath(); ctx.moveTo(60 * exportScale, 0); ctx.lineTo(60 * exportScale, exportH); ctx.stroke();
      } else if (bgType === 'grid') {
        ctx.fillStyle = bgColor || '#ffffff';
        ctx.fillRect(0, 0, exportW, exportH);
        const spacing = 20 * exportScale;
        ctx.strokeStyle = '#e5e7eb';
        ctx.lineWidth = 0.6 * exportScale;
        for (let x = spacing; x < exportW; x += spacing) {
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, exportH); ctx.stroke();
        }
        for (let y = spacing; y < exportH; y += spacing) {
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(exportW, y); ctx.stroke();
        }
      } else if (bgType === 'dots') {
        ctx.fillStyle = bgColor || '#ffffff';
        ctx.fillRect(0, 0, exportW, exportH);
        const spacing = 20 * exportScale;
        ctx.fillStyle = '#c4c4d0';
        for (let x = spacing; x < exportW; x += spacing) {
          for (let y = spacing; y < exportH; y += spacing) {
            ctx.beginPath(); ctx.arc(x, y, 1 * exportScale, 0, Math.PI * 2); ctx.fill();
          }
        }
      } else if (bgType === 'cream') {
        ctx.fillStyle = '#fdf6e3';
        ctx.fillRect(0, 0, exportW, exportH);
      } else if (bgType === 'dark') {
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, exportW, exportH);
      } else {
        ctx.fillStyle = bgColor || '#ffffff';
        ctx.fillRect(0, 0, exportW, exportH);
      }
      ctx.restore();

      // 2. Render PDF Page at High-Resolution if this is a PDF page
      const pdfDoc = pdfViewerObj?.pdfDoc;
      if (pageDesc.type === 'pdf' && pdfDoc && pageDesc.pdfPageIndex) {
        try {
          const pdfPage = await pdfDoc.getPage(pageDesc.pdfPageIndex);
          const exportViewport = pdfPage.getViewport({ scale: exportScale });
          await pdfPage.render({ canvasContext: ctx, viewport: exportViewport }).promise;
        } catch (err) {
          console.warn('PDF export page render fallback:', err);
          const pdfCanvas = wrapper?.querySelector('.page-pdf-canvas');
          if (pdfCanvas && pdfCanvas.width > 0) {
            ctx.drawImage(pdfCanvas, 0, 0, exportW, exportH);
          }
        }
      }

      // 3. Render High-Resolution Vector Annotations (Pen, Shapes, Highlighters)
      const pageData = annotEngineObj?.getPageData(i);
      if (pageData && pageData.strokes && pageData.strokes.length > 0) {
        ctx.save();
        ctx.scale(exportScale, exportScale);

        // Highlighters first
        for (const stroke of pageData.strokes) {
          if (stroke.tool === 'highlighter') {
            annotEngineObj.drawStroke(ctx, stroke);
          }
        }
        // Pen & shapes second
        for (const stroke of pageData.strokes) {
          if (stroke.tool !== 'highlighter') {
            annotEngineObj.drawStroke(ctx, stroke);
          }
        }
        ctx.restore();
      }

      // 4. Render Text Boxes
      if (pageData && pageData.textBoxes && pageData.textBoxes.length > 0) {
        ctx.save();
        ctx.scale(exportScale, exportScale);
        for (const tb of pageData.textBoxes) {
          if (!tb.text) continue;
          const fontSize = tb.fontSize || 16;
          ctx.font = `${fontSize}px Inter, -apple-system, sans-serif`;
          ctx.fillStyle = tb.color || '#1a1a2e';
          ctx.textBaseline = 'top';
          const lines = tb.text.split('\n');
          const lineHeight = fontSize * 1.25;
          lines.forEach((line, idx) => {
            ctx.fillText(line, tb.x, tb.y + idx * lineHeight);
          });
        }
        ctx.restore();
      }

      // 5. Render Sticky Notes
      if (pageData && pageData.stickyNotes && pageData.stickyNotes.length > 0) {
        ctx.save();
        ctx.scale(exportScale, exportScale);
        for (const sn of pageData.stickyNotes) {
          const w = 180, h = 140;
          ctx.fillStyle = sn.color || '#ffd166';
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(sn.x, sn.y, w, h, 6);
          else ctx.rect(sn.x, sn.y, w, h);
          ctx.fill();

          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.font = 'bold 11px Inter, sans-serif';
          ctx.fillText('📝 Note', sn.x + 8, sn.y + 14);

          if (sn.text) {
            ctx.font = '12px Inter, sans-serif';
            ctx.fillStyle = '#1a1a2e';
            const lines = sn.text.split('\n');
            lines.forEach((line, lIdx) => {
              ctx.fillText(line, sn.x + 8, sn.y + 34 + lIdx * 15);
            });
          }
        }
        ctx.restore();
      }

      // 6. Render Image Stamps (Screenshots / Pasted images)
      if (pageData && pageData.imageStamps && pageData.imageStamps.length > 0) {
        ctx.save();
        ctx.scale(exportScale, exportScale);
        for (const imgStamp of pageData.imageStamps) {
          await new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
              ctx.drawImage(img, imgStamp.x, imgStamp.y, imgStamp.width, imgStamp.height);
              resolve();
            };
            img.onerror = resolve;
            img.src = imgStamp.dataUrl;
          });
        }
        ctx.restore();
      }

      // 7. Convert Canvas to PNG Bytes safely without call stack limit or memory leak
      const blob = await new Promise(resolve => mergedCanvas.toBlob(resolve, 'image/png'));
      const arrayBuffer = await blob.arrayBuffer();
      const imgBytes = new Uint8Array(arrayBuffer);

      const pngImage = await exportDoc.embedPng(imgBytes);

      // Embed page with standard point dimensions (e.g. 595 x 842 pt for A4)
      const page = exportDoc.addPage([baseW, baseH]);
      page.drawImage(pngImage, { x: 0, y: 0, width: baseW, height: baseH });
    }

    const pdfBytes = await exportDoc.save();
    const base64 = uint8ArrayToBase64(pdfBytes);
    return base64;
  }
}

window.ExportManager = ExportManager;

