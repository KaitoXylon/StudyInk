/**
 * annotation.js — Annotation Engine for StudyInk
 * Handles all drawing tools: pen, highlighter, eraser, shapes.
 * Optimized for lag-free buttery smooth drawing and zoom invariance.
 */

class AnnotationEngine {
  constructor() {
    this.pages = {};      // Map: pageIndex -> { strokes, textBoxes, stickyNotes }
    this.undoStacks = {}; // Map: pageIndex -> array of states
    this.redoStacks = {};
    this.isDrawing = false;
    this.currentStroke = null;
    this.activePageIndex = 0;
    this.shapeSnapEnabled = true;
    this.snapHintTimer = null;

    // Tool state
    this.toolState = {
      tool: 'select',
      color: '#1a1a2e',
      size: 2,
      opacity: 1,
      highlighterColor: '#FFE600',
      highlighterSize: 12,
    };
  }

  getPageData(pageIndex) {
    if (!this.pages[pageIndex]) {
      this.pages[pageIndex] = { strokes: [], textBoxes: [], stickyNotes: [] };
    }
    return this.pages[pageIndex];
  }

  /**
   * Attach event listeners to a page's drawing canvas
   */
  attachToCanvas(canvas, pageIndex) {
    canvas.style.touchAction = 'none';
    canvas.style.pointerEvents = 'auto';

    if (canvas._annotHandlers) {
      canvas.removeEventListener('pointerdown', canvas._annotHandlers.onPointerDown);
      canvas.removeEventListener('pointermove', canvas._annotHandlers.onPointerMove);
      canvas.removeEventListener('pointerup', canvas._annotHandlers.onPointerUp);
      canvas.removeEventListener('pointercancel', canvas._annotHandlers.onPointerUp);
      canvas.removeEventListener('pointerleave', canvas._annotHandlers.onPointerUp);
    }

    const onPointerDown = (e) => this.onPointerDown(e, canvas, pageIndex);
    const onPointerMove = (e) => this.onPointerMove(e, canvas, pageIndex);
    const onPointerUp = (e) => this.onPointerUp(e, canvas, pageIndex);

    canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
    canvas.addEventListener('pointermove', onPointerMove, { passive: false });
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerUp);

    canvas._annotHandlers = { onPointerDown, onPointerMove, onPointerUp };
  }

  getRelativePos(e, canvas) {
    const rect = canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const zoom = window.appState ? window.appState.pdfViewer.zoom : 1.0;
    return {
      x: cssX / zoom,
      y: cssY / zoom
    };
  }

  onPointerDown(e, canvas, pageIndex) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const tool = this.toolState.tool;
    if (tool === 'select') return;
    if (tool === 'text' || tool === 'sticky') return;

    e.preventDefault();
    e.stopPropagation();
    canvas.setPointerCapture(e.pointerId);

    const pos = this.getRelativePos(e, canvas);
    this.isDrawing = true;
    this.activePageIndex = pageIndex;

    this.currentStroke = {
      tool,
      color: tool === 'highlighter' ? this.toolState.highlighterColor : this.toolState.color,
      size: tool === 'highlighter' ? this.toolState.highlighterSize : this.toolState.size,
      opacity: tool === 'highlighter' ? 1.0 : this.toolState.opacity,
      points: [{ x: pos.x, y: pos.y }],
      recognized: null,
    };

    // Track smoothed values to filter out jitter
    this.lastSmoothedX = pos.x;
    this.lastSmoothedY = pos.y;

    if (tool === 'eraser') {
      const wrapper = canvas.closest('.page-wrapper');
      const annotCanvas = wrapper.querySelector('.page-annotation-canvas');
      this.eraseAt(annotCanvas, pageIndex, pos.x, pos.y, Math.max(8, this.toolState.size * 4));
    }
  }

  onPointerMove(e, canvas, pageIndex) {
    if (!this.isDrawing || this.activePageIndex !== pageIndex) return;
    e.preventDefault();
    e.stopPropagation();

    const pos = this.getRelativePos(e, canvas);

    if (this.toolState.tool === 'eraser') {
      const wrapper = canvas.closest('.page-wrapper');
      const annotCanvas = wrapper.querySelector('.page-annotation-canvas');
      this.eraseAt(annotCanvas, pageIndex, pos.x, pos.y, Math.max(8, this.toolState.size * 4));
      return;
    }

    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const ctx = canvas.getContext('2d');

    ctx.save();
    const zoom = window.appState ? window.appState.pdfViewer.zoom : 1.0;
    const dpr = window.devicePixelRatio || 1;
    ctx.scale(zoom * dpr, zoom * dpr);

    ctx.strokeStyle = this.currentStroke.color;
    ctx.lineWidth = this.currentStroke.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = this.currentStroke.opacity;

    // smoothFactor ranges from 0.0 (no smoothing) to 1.0 (frozen)
    // 0.65 provides high-quality calligraphic line smoothing for stylus handwriting
    const smoothFactor = 0.65;

    for (const ev of coalesced) {
      const p = this.getRelativePos(ev, canvas);
      const smoothedX = this.lastSmoothedX * smoothFactor + p.x * (1 - smoothFactor);
      const smoothedY = this.lastSmoothedY * smoothFactor + p.y * (1 - smoothFactor);

      this.currentStroke.points.push({ x: smoothedX, y: smoothedY });

      ctx.beginPath();
      ctx.moveTo(this.lastSmoothedX, this.lastSmoothedY);
      ctx.lineTo(smoothedX, smoothedY);
      ctx.stroke();

      this.lastSmoothedX = smoothedX;
      this.lastSmoothedY = smoothedY;
    }

    ctx.restore();
  }

  onPointerUp(e, canvas, pageIndex) {
    if (!this.isDrawing || this.activePageIndex !== pageIndex) return;
    this.isDrawing = false;

    // Clear the temporary drawing canvas
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (this.toolState.tool === 'eraser') {
      this.currentStroke = null;
      return;
    }

    if (!this.currentStroke || this.currentStroke.points.length < 2) {
      this.currentStroke = null;
      return;
    }

    // Shape recognition ONLY for shape tool (not when general writing/pen)
    if (this.shapeSnapEnabled && this.currentStroke.tool === 'shape') {
      const recognized = ShapeRecognition.recognize(this.currentStroke.points);
      if (recognized) {
        this.currentStroke.recognized = recognized;
        this.showShapeSnapHint(pageIndex);
      }
    }

    // Save stroke
    const pageData = this.getPageData(pageIndex);
    this.saveUndoState(pageIndex);
    pageData.strokes.push({ ...this.currentStroke });

    // Redraw final smooth Bézier stroke on the permanent annotation canvas
    const wrapper = canvas.closest('.page-wrapper');
    const annotCanvas = wrapper.querySelector('.page-annotation-canvas');
    if (annotCanvas) {
      this.redrawPage(annotCanvas, pageIndex);
    }

    this.currentStroke = null;

    if (window.appState) window.appState.scheduleAutoSave();
  }

  showShapeSnapHint(pageIndex) {
    const wrapper = document.querySelector(`.page-wrapper[data-page="${pageIndex}"]`);
    if (!wrapper) return;
    let hint = wrapper.querySelector('.shape-snap-hint');
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'shape-snap-hint';
      hint.textContent = '✦ Shape snapped';
      wrapper.appendChild(hint);
    }
    hint.classList.add('show');
    clearTimeout(this.snapHintTimer);
    this.snapHintTimer = setTimeout(() => hint.classList.remove('show'), 1500);
  }

  /**
   * Draw finalized stroke
   */
  drawStroke(ctx, stroke) {
    const { points, color, size, opacity, tool, recognized } = stroke;
    if (points.length === 0) return;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (recognized) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth = size;
      ShapeRecognition.drawShape(ctx, recognized, { color, lineWidth: size, opacity });
    } else if (tool === 'highlighter') {
      ctx.lineWidth = size;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
    } else {
      // Pen: smooth Bézier with constant width (no pressure sensing)
      ctx.lineWidth = size;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      if (points.length === 1) {
        ctx.arc(points[0].x, points[0].y, size * 0.5, 0, Math.PI * 2);
        ctx.fill();
      } else if (points.length === 2) {
        ctx.lineTo(points[1].x, points[1].y);
        ctx.stroke();
      } else {
        for (let i = 1; i < points.length - 1; i++) {
          const mx = (points[i].x + points[i + 1].x) / 2;
          const my = (points[i].y + points[i + 1].y) / 2;
          ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
        }
        const last = points[points.length - 1];
        const prev = points[points.length - 2];
        ctx.quadraticCurveTo(prev.x, prev.y, last.x, last.y);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /**
   * Vector-based stroke eraser
   */
  eraseAt(canvas, pageIndex, x, y, radius) {
    const pageData = this.getPageData(pageIndex);
    const initialCount = pageData.strokes.length;

    // Filter out strokes that cross/intersect the eraser circle
    pageData.strokes = pageData.strokes.filter(stroke => {
      const intersected = stroke.points.some(p => {
        const dx = p.x - x;
        const dy = p.y - y;
        return (dx * dx + dy * dy) < (radius * radius);
      });
      return !intersected;
    });

    if (pageData.strokes.length !== initialCount) {
      this.redrawPage(canvas, pageIndex);
      if (window.appState) window.appState.scheduleAutoSave();
    }
  }

  redrawPageCanvas(canvas, pageIndex) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    const zoom = window.appState ? window.appState.pdfViewer.zoom : 1.0;
    const dpr = window.devicePixelRatio || 1;
    ctx.scale(zoom * dpr, zoom * dpr);

    const pageData = this.getPageData(pageIndex);
    // Draw highlighters first
    for (const stroke of pageData.strokes) {
      if (stroke.tool === 'highlighter') {
        this.drawStroke(ctx, stroke);
      }
    }
    // Draw all other tools second
    for (const stroke of pageData.strokes) {
      if (stroke.tool !== 'highlighter') {
        this.drawStroke(ctx, stroke);
      }
    }
    ctx.restore();
  }

  redrawPage(canvas, pageIndex) {
    this.redrawPageCanvas(canvas, pageIndex);
  }

  renderTextBoxDOM(pageWrapper, pageIndex, entry, zoom) {
    const container = pageWrapper.querySelector('.page-overlays');
    if (!container) return;

    const box = document.createElement('div');
    box.className = 'text-overlay';
    box.style.cssText = `left:${entry.x * zoom}px; top:${entry.y * zoom}px; position:absolute; min-width:120px; min-height:30px; pointer-events:auto;`;

    const ta = document.createElement('textarea');
    ta.value = entry.text;
    ta.style.cssText = `font-size:${entry.fontSize * zoom}px; color:${entry.color || this.toolState.color}; min-height:30px;`;
    ta.placeholder = 'Type here...';
    ta.rows = 1;

    const adjustHeight = () => {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    };
    ta.addEventListener('input', () => {
      entry.text = ta.value;
      adjustHeight();
      if (window.appState) window.appState.scheduleAutoSave();
    });

    this.makeDraggable(box, ta, pageWrapper, entry);

    box.appendChild(ta);
    container.appendChild(box);
    adjustHeight();

    if (!entry.text) {
      setTimeout(() => ta.focus(), 50);
    }
  }

  addTextBox(pageWrapper, pageIndex, cssX, cssY) {
    const zoom = window.appState ? window.appState.pdfViewer.zoom : 1.0;
    const baseFontSize = this.toolState.size * 4 + 8;
    const entry = {
      type: 'textbox',
      x: cssX / zoom,
      y: cssY / zoom,
      text: '',
      fontSize: baseFontSize,
      color: this.toolState.color
    };

    this.saveUndoState(pageIndex);
    this.getPageData(pageIndex).textBoxes.push(entry);
    this.renderTextBoxDOM(pageWrapper, pageIndex, entry, zoom);
  }

  renderStickyNoteDOM(pageWrapper, pageIndex, entry, zoom) {
    const container = pageWrapper.querySelector('.page-overlays');
    if (!container) return;

    const note = document.createElement('div');
    note.className = 'sticky-note';
    note.style.cssText = `left:${entry.x * zoom}px; top:${entry.y * zoom}px; background:${entry.color}; position:absolute; pointer-events:auto;`;

    const header = document.createElement('div');
    header.className = 'sticky-header';
    header.innerHTML = `<span>📝 Note</span><button class="sticky-del-btn" title="Delete">✕</button>`;

    const body = document.createElement('textarea');
    body.className = 'sticky-body';
    body.placeholder = 'Write your note here...';
    body.value = entry.text;

    note.appendChild(header);
    note.appendChild(body);

    header.querySelector('.sticky-del-btn').addEventListener('click', () => {
      note.remove();
      const pageData = this.getPageData(pageIndex);
      pageData.stickyNotes = pageData.stickyNotes.filter(s => s !== entry);
      if (window.appState) window.appState.scheduleAutoSave();
    });

    body.addEventListener('input', () => {
      entry.text = body.value;
      if (window.appState) window.appState.scheduleAutoSave();
    });

    this.makeDraggable(note, header, pageWrapper, entry);
    container.appendChild(note);

    if (!entry.text) {
      setTimeout(() => body.focus(), 50);
    }
  }

  addStickyNote(pageWrapper, pageIndex, cssX, cssY) {
    const zoom = window.appState ? window.appState.pdfViewer.zoom : 1.0;
    const colors = ['#ffd166', '#ff6b6b', '#a8edea', '#c3b1e1', '#b5ead7'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const entry = {
      type: 'sticky',
      x: cssX / zoom,
      y: cssY / zoom,
      text: '',
      color
    };

    this.saveUndoState(pageIndex);
    this.getPageData(pageIndex).stickyNotes.push(entry);
    this.renderStickyNoteDOM(pageWrapper, pageIndex, entry, zoom);
  }

  makeDraggable(el, handle, container, entry) {
    let startX, startY, startLeft, startTop;
    const onMouseDown = (e) => {
      if (e.target.tagName === 'TEXTAREA' || e.target.classList.contains('sticky-del-btn')) return;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseInt(el.style.left) || 0;
      startTop = parseInt(el.style.top) || 0;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };
    const onMouseMove = (e) => {
      const zoom = window.appState ? window.appState.pdfViewer.zoom : 1.0;
      const cssX = startLeft + e.clientX - startX;
      const cssY = startTop + e.clientY - startY;
      el.style.left = `${cssX}px`;
      el.style.top = `${cssY}px`;
      if (entry) {
        entry.x = cssX / zoom;
        entry.y = cssY / zoom;
      }
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (window.appState) window.appState.scheduleAutoSave();
    };
    handle.addEventListener('mousedown', onMouseDown);
  }

  // ── Undo / Redo ──────────────────────────────────────────────────────

  saveUndoState(pageIndex) {
    if (!this.undoStacks[pageIndex]) this.undoStacks[pageIndex] = [];
    if (!this.redoStacks[pageIndex]) this.redoStacks[pageIndex] = [];
    const data = this.getPageData(pageIndex);
    const state = JSON.stringify({ strokes: data.strokes });
    this.undoStacks[pageIndex].push(state);
    if (this.undoStacks[pageIndex].length > 50) this.undoStacks[pageIndex].shift();
    this.redoStacks[pageIndex] = [];
  }

  undo(pageIndex, canvas) {
    if (!this.undoStacks[pageIndex] || this.undoStacks[pageIndex].length === 0) return;
    const data = this.getPageData(pageIndex);
    if (!this.redoStacks[pageIndex]) this.redoStacks[pageIndex] = [];
    this.redoStacks[pageIndex].push(JSON.stringify({ strokes: data.strokes }));
    const prev = JSON.parse(this.undoStacks[pageIndex].pop());
    data.strokes = prev.strokes;
    this.redrawPage(canvas, pageIndex);
    if (window.appState) window.appState.scheduleAutoSave();
  }

  redo(pageIndex, canvas) {
    if (!this.redoStacks[pageIndex] || this.redoStacks[pageIndex].length === 0) return;
    const data = this.getPageData(pageIndex);
    if (!this.undoStacks[pageIndex]) this.undoStacks[pageIndex] = [];
    this.undoStacks[pageIndex].push(JSON.stringify({ strokes: data.strokes }));
    const next = JSON.parse(this.redoStacks[pageIndex].pop());
    data.strokes = next.strokes;
    this.redrawPage(canvas, pageIndex);
    if (window.appState) window.appState.scheduleAutoSave();
  }

  // ── Serialization ─────────────────────────────────────────────────────

  serialize() {
    const out = {};
    for (const [idx, data] of Object.entries(this.pages)) {
      out[idx] = {
        strokes: data.strokes,
        textBoxes: data.textBoxes.map(t => ({ ...t })),
        stickyNotes: data.stickyNotes.map(s => ({ type: s.type, x: s.x, y: s.y, text: s.text, color: s.color })),
      };
    }
    return out;
  }

  deserialize(data) {
    for (const [idx, pageData] of Object.entries(data)) {
      this.pages[idx] = {
        strokes: pageData.strokes || [],
        textBoxes: pageData.textBoxes || [],
        stickyNotes: pageData.stickyNotes || [],
      };
    }
  }

  restorePageOverlays(pageWrapper, pageIndex) {
    const container = pageWrapper.querySelector('.page-overlays');
    if (container) container.innerHTML = '';

    const pageData = this.getPageData(pageIndex);
    const zoom = window.appState ? window.appState.pdfViewer.zoom : 1.0;

    for (const tb of pageData.textBoxes) {
      this.renderTextBoxDOM(pageWrapper, pageIndex, tb, zoom);
    }
    for (const sn of pageData.stickyNotes) {
      this.renderStickyNoteDOM(pageWrapper, pageIndex, sn, zoom);
    }
  }
}

window.AnnotationEngine = AnnotationEngine;
