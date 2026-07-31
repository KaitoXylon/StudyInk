/**
 * floating-toolbar.js — Draggable Floating Vertical Toolbar
 * Transparent when idle, shows on hover.
 * Optimized for Veikk S640 stylus users.
 */

class FloatingToolbar {
  constructor(annotationEngine) {
    this.el = document.getElementById('floating-toolbar');
    this.handle = document.getElementById('ft-handle');
    this.toolsContainer = document.getElementById('ft-tools');
    this.toggleBtn = document.getElementById('ft-toggle');
    this.colorPreview = document.getElementById('ft-color-preview');
    this.colorInput = document.getElementById('ft-color-input');
    this.sizeSlider = document.getElementById('ft-size-slider');
    this.annotEngine = annotationEngine;
    this.collapsed = false;
    this.isDragging = false;

    this.init();
  }

  init() {
    this.makeDraggable();
    this.bindTools();
    this.bindColorPicker();
    this.bindColorSwatches();
    this.bindFitButtons();
    this.bindToggle();
    this.syncWithAnnotationEngine();
  }

  bindFitButtons() {
    document.getElementById('ft-btn-fit-width').addEventListener('click', () => {
      const viewer = window.appState.pdfViewer;
      const vw = document.getElementById('canvas-area').clientWidth - 48;
      const pageIndex = viewer.getCurrentPage();
      const pageDesc = viewer.pages[pageIndex];
      const baseW = pageDesc?.baseWidth || 595;
      viewer.setZoom(vw / baseW);
    });

    document.getElementById('ft-btn-fit-screen').addEventListener('click', () => {
      const viewer = window.appState.pdfViewer;
      const vh = document.getElementById('canvas-area').clientHeight - 48;
      const pageIndex = viewer.getCurrentPage();
      const pageDesc = viewer.pages[pageIndex];
      const baseH = pageDesc?.baseHeight || 842;
      viewer.setZoom(vh / baseH);
    });
  }

  makeDraggable() {
    let startX, startY, startLeft, startTop;

    const onMouseDown = (e) => {
      if (e.target !== this.handle && !this.handle.contains(e.target)) return;
      e.preventDefault();
      this.isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = this.el.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      this.el.style.transition = 'opacity var(--t-med)';
      this.el.classList.add('is-active');
      // Switch to absolute left/top positioning
      this.el.style.right = 'auto';
      this.el.style.transform = 'none';
      this.el.style.left = `${startLeft}px`;
      this.el.style.top = `${startTop}px`;

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    const onMouseMove = (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const rect = this.el.getBoundingClientRect();
      const newLeft = rect.left + dx;
      const newTop = rect.top + dy;
      const maxLeft = window.innerWidth - rect.width - 8;
      const maxTop = window.innerHeight - rect.height - 8;

      this.el.style.left = `${Math.max(8, Math.min(maxLeft, newLeft))}px`;
      this.el.style.top  = `${Math.max(8, Math.min(maxTop, newTop))}px`;
      startX = e.clientX;
      startY = e.clientY;
    };

    const onMouseUp = () => {
      this.isDragging = false;
      this.el.classList.remove('is-active');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    this.handle.addEventListener('mousedown', onMouseDown);
  }

  bindTools() {
    const ftBtns = this.el.querySelectorAll('.ft-btn[data-tool]');
    ftBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;
        this.annotEngine.toolState.tool = tool;
        document.body.dataset.tool = tool;
        ftBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        const mainBtn = document.querySelector(`.tool-btn[data-tool="${tool}"]`);
        if (mainBtn) mainBtn.classList.add('active');
      });
    });

    document.getElementById('ft-btn-paste')?.addEventListener('click', () => {
      if (window.appState) window.appState.pasteClipboardImage();
    });

    document.getElementById('ft-btn-copy-drawing')?.addEventListener('click', () => {
      if (window.appState) window.appState.copyCurrentPageDrawing();
    });

    this.sizeSlider.addEventListener('input', () => {
      const val = parseFloat(this.sizeSlider.value);
      this.annotEngine.toolState.size = val;
      this.annotEngine.toolState.highlighterSize = Math.max(2, val * 5);
      this.sizeSlider.title = `Brush Size: ${val}`;
    });
  }

  bindColorSwatches() {
    const swatches = this.el.querySelectorAll('.ft-swatch');
    swatches.forEach(swatch => {
      swatch.addEventListener('click', () => {
        const color = swatch.dataset.color;
        this.setColor(color);
        swatches.forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
      });
    });
    // Default active swatch = first one (black)
    if (swatches.length > 0) swatches[0].classList.add('active');
  }

  setColor(color) {
    this.colorInput.value = color;
    this.colorPreview.style.background = color;
    this.annotEngine.toolState.color = color;
    this.annotEngine.toolState.highlighterColor = color;
  }

  bindColorPicker() {
    this.colorPreview.addEventListener('click', () => {
      this.colorInput.click();
    });

    this.colorInput.addEventListener('input', (e) => {
      const color = e.target.value;
      this.colorPreview.style.background = color;
      this.annotEngine.toolState.color = color;
      this.annotEngine.toolState.highlighterColor = color;
    });
  }

  bindToggle() {
    this.toggleBtn.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      if (this.collapsed) {
        this.toolsContainer.classList.add('collapsed');
        this.toggleBtn.classList.add('collapsed');
      } else {
        this.toolsContainer.classList.remove('collapsed');
        this.toggleBtn.classList.remove('collapsed');
      }
    });
  }

  syncWithAnnotationEngine() {
    // Set initial active state
    const initialTool = this.annotEngine.toolState.tool;
    const btn = this.el.querySelector(`.ft-btn[data-tool="${initialTool}"]`);
    if (btn) btn.classList.add('active');
    if (this.sizeSlider) {
      const sz = this.annotEngine.toolState.size || 2;
      this.sizeSlider.value = sz;
      this.sizeSlider.title = `Brush Size: ${sz}`;
    }
  }

  setTool(tool) {
    this.el.querySelectorAll('.ft-btn[data-tool]').forEach(b => b.classList.remove('active'));
    const btn = this.el.querySelector(`.ft-btn[data-tool="${tool}"]`);
    if (btn) btn.classList.add('active');
  }

  changePenSize(delta) {
    const current = this.annotEngine.toolState.size || 2;
    const newSize = Math.max(0.5, Math.min(15, Math.round((current + delta) * 10) / 10));
    this.annotEngine.toolState.size = newSize;
    this.annotEngine.toolState.highlighterSize = Math.max(2, newSize * 5);
    if (this.sizeSlider) {
      this.sizeSlider.value = newSize;
      this.sizeSlider.title = `Brush Size: ${newSize}`;
    }
    showToast(`Pen size: ${newSize}px`);
  }

  cyclePenColor(direction) {
    const swatches = Array.from(this.el.querySelectorAll('.ft-swatch'));
    if (swatches.length === 0) return;
    const colors = swatches.map(s => s.dataset.color);
    const current = this.annotEngine.toolState.color;
    let idx = colors.indexOf(current);
    if (idx === -1) idx = 0;

    let nextIdx = (idx + direction + colors.length) % colors.length;
    const nextColor = colors[nextIdx];
    this.setColor(nextColor);

    swatches.forEach((s, i) => s.classList.toggle('active', i === nextIdx));
    const title = swatches[nextIdx].title || 'Color';
    showToast(`Pen color: ${title}`);
  }
}

window.FloatingToolbar = FloatingToolbar;
