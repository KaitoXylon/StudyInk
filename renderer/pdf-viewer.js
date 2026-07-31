/**
 * pdf-viewer.js — PDF Rendering Engine
 * Uses PDF.js to render PDF pages onto canvases.
 * Manages page backgrounds, blank page insertion, and page lifecycle.
 */

const BG_PATTERNS = {
  white: (canvas, ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  },
  cream: (canvas, ctx) => {
    ctx.fillStyle = '#fdf6e3';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  },
  dark: (canvas, ctx) => {
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  },
  lined: (canvas, ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const lineSpacing = 28;
    ctx.strokeStyle = '#d1d5db';
    ctx.lineWidth = 0.8;
    for (let y = lineSpacing; y < canvas.height; y += lineSpacing) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }
    // Left margin line
    ctx.strokeStyle = '#fca5a5';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(60, 0);
    ctx.lineTo(60, canvas.height);
    ctx.stroke();
  },
  grid: (canvas, ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const spacing = 20;
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 0.6;
    for (let x = spacing; x < canvas.width; x += spacing) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = spacing; y < canvas.height; y += spacing) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
  },
  dots: (canvas, ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const spacing = 20;
    ctx.fillStyle = '#c4c4d0';
    for (let x = spacing; x < canvas.width; x += spacing) {
      for (let y = spacing; y < canvas.height; y += spacing) {
        ctx.beginPath();
        ctx.arc(x, y, 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  },
  darklined: (canvas, ctx) => {
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const lineSpacing = 28;
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 0.8;
    for (let y = lineSpacing; y < canvas.height; y += lineSpacing) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(108,99,255,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(60, 0); ctx.lineTo(60, canvas.height); ctx.stroke();
  },
  darkgrid: (canvas, ctx) => {
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const spacing = 20;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 0.6;
    for (let x = spacing; x < canvas.width; x += spacing) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = spacing; y < canvas.height; y += spacing) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
  },
  custom: (canvas, ctx, color) => {
    ctx.fillStyle = color || '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  },
};

class PDFViewer {
  constructor(annotationEngine) {
    this.annotationEngine = annotationEngine;
    this.pdfDoc = null;
    this.pages = [];       // Array of page descriptors
    this.zoom = 1.0;
    this.container = document.getElementById('pages-container');
    this.viewport = document.getElementById('pdf-viewport');
    this.renderQueue = [];
    this.isRendering = false;

    // Set up PDF.js worker
    if (typeof pdfjsLib !== 'undefined') {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  }

  /**
   * Load a PDF from a base64 string
   */
  async loadPDF(base64Data, filePath) {
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const loadingTask = pdfjsLib.getDocument({ data: bytes });
    this.pdfDoc = await loadingTask.promise;

    this.pages = [];
    for (let i = 0; i < this.pdfDoc.numPages; i++) {
      this.pages.push({
        type: 'pdf',      // 'pdf' or 'blank'
        pdfPageIndex: i + 1,
        background: 'white',
        bgColor: null,
        rendered: false,
      });
    }

    await this.renderAllPages();
  }

  /**
   * Clear and render all pages
   */
  async renderAllPages() {
    this.container.innerHTML = '';
    for (let i = 0; i < this.pages.length; i++) {
      await this.renderPage(i);
    }
    this.updateThumbnails();
  }

  /**
   * Render a single page at the given index
   */
  async renderPage(pageIndex) {
    const pageDesc = this.pages[pageIndex];
    const existing = this.container.querySelector(`.page-wrapper[data-page="${pageIndex}"]`);
    if (existing) existing.remove();

    let width, height;

    if (pageDesc.type === 'pdf' && this.pdfDoc) {
      const pdfPage = await this.pdfDoc.getPage(pageDesc.pdfPageIndex);

      // Cache base sizes on load
      if (!pageDesc.baseWidth || !pageDesc.baseHeight) {
        const vp1 = pdfPage.getViewport({ scale: 1.0 });
        pageDesc.baseWidth = vp1.width;
        pageDesc.baseHeight = vp1.height;
      }

      const viewport = pdfPage.getViewport({ scale: this.zoom * window.devicePixelRatio });
      const cssVP = pdfPage.getViewport({ scale: this.zoom });
      width = Math.floor(cssVP.width);
      height = Math.floor(cssVP.height);

      const wrapper = this.createPageWrapper(pageIndex, width, height, false, pageDesc.baseWidth, pageDesc.baseHeight);
      this.insertWrapperAtIndex(wrapper, pageIndex);

      // PDF canvas
      const pdfCanvas = wrapper.querySelector('.page-pdf-canvas');
      pdfCanvas.width = Math.floor(viewport.width);
      pdfCanvas.height = Math.floor(viewport.height);
      pdfCanvas.style.width = `${width}px`;
      pdfCanvas.style.height = `${height}px`;

      const ctx = pdfCanvas.getContext('2d');
      await pdfPage.render({ canvasContext: ctx, viewport }).promise;

    } else {
      // Blank page
      if (!pageDesc.baseWidth || !pageDesc.baseHeight) {
        pageDesc.baseWidth = 595;
        pageDesc.baseHeight = 842;
      }
      width = Math.floor(pageDesc.baseWidth * this.zoom);
      height = Math.floor(pageDesc.baseHeight * this.zoom);

      const wrapper = this.createPageWrapper(pageIndex, width, height, true, pageDesc.baseWidth, pageDesc.baseHeight);
      this.insertWrapperAtIndex(wrapper, pageIndex);
    }

    // Setup background and drawing canvases
    const wrapper2 = this.container.querySelector(`.page-wrapper[data-page="${pageIndex}"]`);
    const bgCanvas = wrapper2.querySelector('.page-bg-canvas');
    const annotCanvas = wrapper2.querySelector('.page-annotation-canvas');
    const drawCanvas = wrapper2.querySelector('.page-drawing-canvas');

    bgCanvas.width = Math.floor(width * window.devicePixelRatio);
    bgCanvas.height = Math.floor(height * window.devicePixelRatio);
    bgCanvas.style.width = `${width}px`;
    bgCanvas.style.height = `${height}px`;

    annotCanvas.width = Math.floor(width * window.devicePixelRatio);
    annotCanvas.height = Math.floor(height * window.devicePixelRatio);
    annotCanvas.style.width = `${width}px`;
    annotCanvas.style.height = `${height}px`;

    drawCanvas.width = Math.floor(width * window.devicePixelRatio);
    drawCanvas.height = Math.floor(height * window.devicePixelRatio);
    drawCanvas.style.width = `${width}px`;
    drawCanvas.style.height = `${height}px`;

    // Apply background
    this.applyBackground(pageIndex, pageDesc.background, pageDesc.bgColor);

    // Attach annotation engine to drawing canvas
    this.annotationEngine.attachToCanvas(drawCanvas, pageIndex);
    this.annotationEngine.redrawPage(annotCanvas, pageIndex);
    this.annotationEngine.restorePageOverlays(wrapper2, pageIndex);

    // Click overlay for text/sticky tool placement (on drawing canvas)
    drawCanvas.addEventListener('click', (e) => this.handleCanvasClick(e, wrapper2, pageIndex, drawCanvas));

    // Add + button row below this page
    const existing_add = this.container.querySelector(`.page-add-row[data-after-page="${pageIndex}"]`);
    if (existing_add) existing_add.remove();
    const addBtn = this.createAddPageBtn(pageIndex);
    addBtn.dataset.afterPage = pageIndex;
    wrapper2.after(addBtn);

    pageDesc.rendered = true;
  }

  createPageWrapper(pageIndex, width, height, isBlank = false, baseWidth = 595, baseHeight = 842) {
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.dataset.page = pageIndex;
    wrapper.dataset.baseWidth = baseWidth;
    wrapper.dataset.baseHeight = baseHeight;
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;

    const deleteBtn = isBlank
      ? `<button class="page-del-badge-btn" title="Delete blank page" onclick="window.appState.pdfViewer.deletePage(${pageIndex})">✕</button>`
      : '';

    wrapper.innerHTML = `
      <canvas class="page-bg-canvas" style="width:${width}px;height:${height}px"></canvas>
      <canvas class="page-pdf-canvas" style="width:${width}px;height:${height}px"></canvas>
      <canvas class="page-annotation-canvas" style="width:${width}px;height:${height}px"></canvas>
      <canvas class="page-drawing-canvas" style="width:${width}px;height:${height}px"></canvas>
      <div class="page-overlays" style="pointer-events:none;position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible"></div>
      <div class="page-number-badge">
        <span>Page ${pageIndex + 1}</span>
        ${deleteBtn}
      </div>
    `;
    return wrapper;
  }

  createAddPageBtn(pageIndex) {
    const bg = this.pages[pageIndex]?.background || 'white';
    const div = document.createElement('div');
    div.className = 'page-add-row';
    div.dataset.afterPage = pageIndex;
    div.innerHTML = `
      <button class="page-add-btn" title="Insert blank page after page ${pageIndex + 1}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
    `;
    div.querySelector('.page-add-btn').addEventListener('click', async () => {
      await this.insertBlankPage(pageIndex + 1, bg);
    });
    return div;
  }

  insertWrapperAtIndex(wrapper, pageIndex) {
    const children = Array.from(this.container.children).filter(c => c.classList.contains('page-wrapper'));
    if (pageIndex >= children.length) {
      this.container.appendChild(wrapper);
    } else {
      this.container.insertBefore(wrapper, children[pageIndex]);
    }
  }

  handleCanvasClick(e, wrapper, pageIndex, canvas) {
    const tool = this.annotationEngine.toolState.tool;
    if (tool !== 'text' && tool !== 'sticky') return;

    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left);
    const y = (e.clientY - rect.top);

    if (tool === 'text') {
      this.annotationEngine.addTextBox(wrapper, pageIndex, x, y);
    } else if (tool === 'sticky') {
      this.annotationEngine.addStickyNote(wrapper, pageIndex, x, y);
    }
  }

  /**
   * Apply a background pattern to a page
   */
  applyBackground(pageIndex, bgType, bgColor = null) {
    const wrapper = this.container.querySelector(`.page-wrapper[data-page="${pageIndex}"]`);
    if (!wrapper) return;
    const bgCanvas = wrapper.querySelector('.page-bg-canvas');
    if (!bgCanvas) return;
    const ctx = bgCanvas.getContext('2d');

    const pattern = BG_PATTERNS[bgType] || BG_PATTERNS.white;
    pattern(bgCanvas, ctx, bgColor);

    this.pages[pageIndex].background = bgType;
    this.pages[pageIndex].bgColor = bgColor;
  }

  /**
   * Insert a blank page at the given index
   */
  async insertBlankPage(atIndex, background = 'white') {
    this.pages.splice(atIndex, 0, {
      type: 'blank',
      pdfPageIndex: null,
      background,
      bgColor: null,
      rendered: false,
    });

    // Shift all annotations/undo/redo stacks for pages after/at atIndex up by 1
    const shiftKeysInsert = (map) => {
      const keys = Object.keys(map).map(Number).sort((a, b) => b - a);
      for (const k of keys) {
        if (k >= atIndex) {
          map[k + 1] = map[k];
          delete map[k];
        }
      }
    };
    shiftKeysInsert(this.annotationEngine.pages);
    shiftKeysInsert(this.annotationEngine.undoStacks);
    shiftKeysInsert(this.annotationEngine.redoStacks);

    // Re-render all pages to update indices
    await this.renderAllPages();
    this.scrollToPage(atIndex);
    if (window.appState) window.appState.scheduleAutoSave();
  }

  /**
   * Delete a page at the given index
   */
  async deletePage(pageIndex) {
    if (this.pages.length <= 1) { showToast('Cannot delete the only page', 'error'); return; }
    this.pages.splice(pageIndex, 1);

    // Shift all annotations/undo/redo stacks for pages after pageIndex down by 1
    const shiftKeysDelete = (map) => {
      const keys = Object.keys(map).map(Number).sort((a, b) => a - b);
      for (const k of keys) {
        if (k === pageIndex) {
          delete map[k];
        } else if (k > pageIndex) {
          map[k - 1] = map[k];
          delete map[k];
        }
      }
    };
    shiftKeysDelete(this.annotationEngine.pages);
    shiftKeysDelete(this.annotationEngine.undoStacks);
    shiftKeysDelete(this.annotationEngine.redoStacks);

    await this.renderAllPages();
    if (window.appState) window.appState.scheduleAutoSave();
  }

  /**
   * Change zoom level and re-render
   */
  async setZoom(zoom) {
    this.zoom = Math.max(0.25, Math.min(3.0, zoom));
    document.getElementById('zoom-label').textContent = `${Math.round(this.zoom * 100)}%`;
    await this.renderAllPages();
  }

  scrollToPage(pageIndex) {
    const wrapper = this.container.querySelector(`.page-wrapper[data-page="${pageIndex}"]`);
    if (wrapper) wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  getCurrentPage() {
    // Find which page is most visible
    const wrappers = this.container.querySelectorAll('.page-wrapper');
    const vpRect = this.viewport.getBoundingClientRect();
    let maxVisible = 0, bestPage = 0;
    wrappers.forEach((w, i) => {
      const rect = w.getBoundingClientRect();
      const visible = Math.min(rect.bottom, vpRect.bottom) - Math.max(rect.top, vpRect.top);
      if (visible > maxVisible) { maxVisible = visible; bestPage = i; }
    });
    return bestPage;
  }

  /**
   * Render page thumbnails in the sidebar
   */
  async updateThumbnails() {
    const container = document.getElementById('page-thumbnails');
    if (!container) return;
    container.innerHTML = '';

    for (let i = 0; i < this.pages.length; i++) {
      const item = document.createElement('div');
      item.className = 'thumb-item';
      item.dataset.page = i;

      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 200;
      thumbCanvas.height = Math.floor(200 * (this.pages[i].type === 'blank' ? 842 / 595 : 1.414));
      const thumbCtx = thumbCanvas.getContext('2d');

      // Draw thumbnail from main page canvas
      const mainWrapper = this.container.querySelector(`.page-wrapper[data-page="${i}"]`);
      if (mainWrapper) {
        const bgCv = mainWrapper.querySelector('.page-bg-canvas');
        const pdfCv = mainWrapper.querySelector('.page-pdf-canvas');
        const annotCv = mainWrapper.querySelector('.page-annotation-canvas');

        const scale = thumbCanvas.width / bgCv.width;
        thumbCtx.scale(scale, scale);
        if (bgCv.width > 0) thumbCtx.drawImage(bgCv, 0, 0);
        if (pdfCv.width > 0) thumbCtx.drawImage(pdfCv, 0, 0);
        if (annotCv.width > 0) thumbCtx.drawImage(annotCv, 0, 0);
        thumbCtx.setTransform(1, 0, 0, 1, 0, 0);
      }

      item.appendChild(thumbCanvas);
      const label = document.createElement('div');
      label.className = 'thumb-label';
      label.textContent = `${i + 1}`;
      item.appendChild(label);

      item.addEventListener('click', () => {
        this.scrollToPage(i);
        document.querySelectorAll('.thumb-item').forEach(t => t.classList.remove('active'));
        item.classList.add('active');
        if (window.appState) window.appState.currentPage = i;
      });

      container.appendChild(item);
    }
  }

  getState() {
    return {
      pages: this.pages.map(p => ({
        type: p.type,
        pdfPageIndex: p.pdfPageIndex,
        background: p.background,
        bgColor: p.bgColor,
      })),
      zoom: this.zoom,
    };
  }

  async loadNewNotebook(filePath) {
    this.pdfDoc = null;
    this.pages = [
      {
        type: 'blank',
        pdfPageIndex: null,
        background: 'white',
        bgColor: null,
        rendered: false,
        baseWidth: 595,
        baseHeight: 842
      }
    ];
    await this.renderAllPages();
  }
}

window.PDFViewer = PDFViewer;
window.BG_PATTERNS = BG_PATTERNS;
