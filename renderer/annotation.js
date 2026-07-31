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
      this.pages[pageIndex] = { strokes: [], textBoxes: [], stickyNotes: [], imageStamps: [] };
    }
    if (!this.pages[pageIndex].imageStamps) {
      this.pages[pageIndex].imageStamps = [];
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

  getBaseDimensions(el) {
    const wrapper = el ? (el.classList.contains('page-wrapper') ? el : el.closest('.page-wrapper')) : null;
    let baseWidth = 595;
    let baseHeight = 842;
    if (wrapper) {
      if (wrapper.dataset.baseWidth) baseWidth = parseFloat(wrapper.dataset.baseWidth);
      if (wrapper.dataset.baseHeight) baseHeight = parseFloat(wrapper.dataset.baseHeight);
    }
    return { baseWidth, baseHeight };
  }

  getPageScale(pageWrapper) {
    if (!pageWrapper) return 1.0;
    const wrapper = pageWrapper.classList.contains('page-wrapper') ? pageWrapper : pageWrapper.closest('.page-wrapper');
    if (!wrapper) return 1.0;
    const { baseWidth } = this.getBaseDimensions(wrapper);
    const rect = wrapper.getBoundingClientRect();
    const currentWidth = (rect && rect.width > 0) ? rect.width : (parseFloat(wrapper.style.width) || baseWidth);
    return currentWidth / baseWidth;
  }

  getRelativePos(e, canvas) {
    const rect = canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const { baseWidth, baseHeight } = this.getBaseDimensions(canvas);
    const scaleX = rect.width > 0 ? (rect.width / baseWidth) : 1.0;
    const scaleY = rect.height > 0 ? (rect.height / baseHeight) : 1.0;
    return {
      x: cssX / scaleX,
      y: cssY / scaleY
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

    const { baseWidth, baseHeight } = this.getBaseDimensions(canvas);
    const scaleX = baseWidth > 0 ? (canvas.width / baseWidth) : 1.0;
    const scaleY = baseHeight > 0 ? (canvas.height / baseHeight) : 1.0;

    ctx.save();
    ctx.scale(scaleX, scaleY);

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

    const { baseWidth, baseHeight } = this.getBaseDimensions(canvas);
    const scaleX = baseWidth > 0 ? (canvas.width / baseWidth) : 1.0;
    const scaleY = baseHeight > 0 ? (canvas.height / baseHeight) : 1.0;

    ctx.save();
    ctx.scale(scaleX, scaleY);

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

  renderTextBoxDOM(pageWrapper, pageIndex, entry) {
    const container = pageWrapper.querySelector('.page-overlays');
    if (!container) return;

    const scale = this.getPageScale(pageWrapper);

    const box = document.createElement('div');
    box.className = 'text-overlay';
    box.style.cssText = `left:${entry.x * scale}px; top:${entry.y * scale}px; position:absolute; min-width:${Math.max(60, 120 * scale)}px; min-height:${Math.max(20, 30 * scale)}px; pointer-events:auto;`;

    const ta = document.createElement('textarea');
    ta.value = entry.text;
    ta.style.cssText = `font-size:${Math.max(8, entry.fontSize * scale)}px; color:${entry.color || this.toolState.color}; min-height:${Math.max(20, 30 * scale)}px; background:transparent; border:none; outline:none; resize:none; font-family:inherit; padding:2px;`;
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
    const scale = this.getPageScale(pageWrapper);
    const baseFontSize = this.toolState.size * 4 + 8;
    const entry = {
      type: 'textbox',
      x: cssX / scale,
      y: cssY / scale,
      text: '',
      fontSize: baseFontSize,
      color: this.toolState.color
    };

    this.saveUndoState(pageIndex);
    this.getPageData(pageIndex).textBoxes.push(entry);
    this.renderTextBoxDOM(pageWrapper, pageIndex, entry);
  }

  renderStickyNoteDOM(pageWrapper, pageIndex, entry) {
    const container = pageWrapper.querySelector('.page-overlays');
    if (!container) return;

    const scale = this.getPageScale(pageWrapper);

    const note = document.createElement('div');
    note.className = 'sticky-note';
    const noteW = Math.max(100, 180 * scale);
    const noteH = Math.max(80, 140 * scale);
    const fontSize = Math.max(9, 12 * scale);
    note.style.cssText = `left:${entry.x * scale}px; top:${entry.y * scale}px; width:${noteW}px; height:${noteH}px; background:${entry.color}; position:absolute; pointer-events:auto; font-size:${fontSize}px; display:flex; flex-direction:column; border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,0.3); padding:4px; border:1px solid rgba(0,0,0,0.1);`;

    const header = document.createElement('div');
    header.className = 'sticky-header';
    header.style.cssText = `display:flex; justify-content:space-between; align-items:center; cursor:move; padding-bottom:4px; font-weight:600; font-size:${fontSize * 0.9}px; user-select:none; color:rgba(0,0,0,0.7);`;
    header.innerHTML = `<span>📝 Note</span><button class="sticky-del-btn" title="Delete" style="background:none;border:none;cursor:pointer;font-size:${fontSize}px;color:rgba(0,0,0,0.5);">✕</button>`;

    const body = document.createElement('textarea');
    body.className = 'sticky-body';
    body.placeholder = 'Write your note here...';
    body.value = entry.text;
    body.style.cssText = `flex:1; width:100%; border:none; background:transparent; resize:none; outline:none; font-size:${fontSize}px; color:#1a1a2e; font-family:inherit;`;

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
    const scale = this.getPageScale(pageWrapper);
    const colors = ['#ffd166', '#ff6b6b', '#a8edea', '#c3b1e1', '#b5ead7'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const entry = {
      type: 'sticky',
      x: cssX / scale,
      y: cssY / scale,
      text: '',
      color
    };

    this.saveUndoState(pageIndex);
    this.getPageData(pageIndex).stickyNotes.push(entry);
    this.renderStickyNoteDOM(pageWrapper, pageIndex, entry);
  }

  addImageStamp(pageWrapper, pageIndex, dataUrl, cssX = null, cssY = null, widthBase = 300, heightBase = null) {
    const scale = this.getPageScale(pageWrapper);
    const { baseWidth, baseHeight } = this.getBaseDimensions(pageWrapper);

    let x = (cssX !== null) ? (cssX / scale) : (baseWidth / 2 - widthBase / 2);
    let y = (cssY !== null) ? (cssY / scale) : (baseHeight / 4);

    if (x < 10) x = 10;
    if (y < 10) y = 10;

    const img = new Image();
    img.onload = () => {
      let calcWidth = widthBase;
      let calcHeight = heightBase;
      if (!calcHeight) {
        const aspect = img.naturalHeight / (img.naturalWidth || 1);
        calcHeight = Math.round(calcWidth * aspect);
      }

      const entry = {
        id: 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        type: 'image',
        x,
        y,
        width: calcWidth,
        height: calcHeight,
        dataUrl
      };

      this.saveUndoState(pageIndex);
      this.getPageData(pageIndex).imageStamps.push(entry);
      this.renderImageStampDOM(pageWrapper, pageIndex, entry);
      if (window.appState) window.appState.scheduleAutoSave();
    };
    img.src = dataUrl;
  }

  renderImageStampDOM(pageWrapper, pageIndex, entry) {
    const container = pageWrapper.querySelector('.page-overlays');
    if (!container) return;

    // Avoid duplicate DOM elements for same entry id
    if (container.querySelector(`.image-stamp[data-id="${entry.id}"]`)) return;

    const scale = this.getPageScale(pageWrapper);

    const stamp = document.createElement('div');
    stamp.className = 'image-stamp';
    stamp.dataset.id = entry.id;
    stamp.style.cssText = `left:${entry.x * scale}px; top:${entry.y * scale}px; width:${entry.width * scale}px; height:${entry.height * scale}px; position:absolute; pointer-events:auto; display:inline-block; border:1.5px dashed transparent; user-select:none; z-index:10; border-radius:4px; box-sizing:border-box;`;

    const controls = document.createElement('div');
    controls.className = 'image-stamp-controls';
    controls.style.cssText = `position:absolute; top:-28px; right:0; display:flex; align-items:center; gap:4px; background:rgba(20,20,30,0.9); backdrop-filter:blur(6px); padding:2px 8px; border-radius:4px; border:1px solid rgba(255,255,255,0.2); opacity:0; transition:opacity 0.2s ease; pointer-events:auto; cursor:move; z-index:12; user-select:none; shadow:0 2px 8px rgba(0,0,0,0.3);`;
    controls.innerHTML = `
      <span style="font-size:10px; color:#e0e0e0; font-weight:600; padding-right:4px;">🖼️ Screenshot</span>
      <button class="image-stamp-del-btn" title="Delete Screenshot" style="background:none; border:none; cursor:pointer; color:#ff6b6b; font-size:13px; line-height:18px; padding:0 4px; border-radius:3px; transition:color 0.2s;">✕</button>
    `;

    const imgEl = document.createElement('img');
    imgEl.src = entry.dataUrl;
    imgEl.style.cssText = `width:100%; height:100%; object-fit:contain; display:block; pointer-events:none; border-radius:3px;`;

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'image-stamp-resize-handle';
    resizeHandle.title = 'Drag corner to resize';
    resizeHandle.style.cssText = `position:absolute; right:-6px; bottom:-6px; width:12px; height:12px; background:var(--accent-color, #6c5ce7); border:2px solid #fff; border-radius:50%; cursor:se-resize; opacity:0; transition:opacity 0.2s ease; z-index:12; box-shadow:0 2px 4px rgba(0,0,0,0.3);`;

    stamp.appendChild(controls);
    stamp.appendChild(imgEl);
    stamp.appendChild(resizeHandle);

    stamp.addEventListener('mouseenter', () => {
      stamp.style.borderColor = 'var(--accent-color, #6c5ce7)';
      controls.style.opacity = '1';
      resizeHandle.style.opacity = '1';
    });
    stamp.addEventListener('mouseleave', () => {
      if (!stamp.classList.contains('active-stamp')) {
        stamp.style.borderColor = 'transparent';
        controls.style.opacity = '0';
        resizeHandle.style.opacity = '0';
      }
    });

    controls.querySelector('.image-stamp-del-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      stamp.remove();
      const pageData = this.getPageData(pageIndex);
      pageData.imageStamps = pageData.imageStamps.filter(item => item !== entry && item.id !== entry.id);
      if (window.appState) window.appState.scheduleAutoSave();
    });

    this.makeImageDraggable(stamp, controls, pageWrapper, entry);
    this.makeImageResizable(stamp, resizeHandle, pageWrapper, entry);

    container.appendChild(stamp);
  }

  makeImageDraggable(el, handle, container, entry) {
    let startX, startY, startLeft, startTop;

    const onMouseDown = (e) => {
      if (e.target.classList.contains('image-stamp-del-btn') || e.target.classList.contains('image-stamp-resize-handle')) return;
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseFloat(el.style.left) || 0;
      startTop = parseFloat(el.style.top) || 0;

      const onMouseMove = (ev) => {
        const cssX = startLeft + ev.clientX - startX;
        const cssY = startTop + ev.clientY - startY;
        el.style.left = `${cssX}px`;
        el.style.top = `${cssY}px`;
        const scale = this.getPageScale(container);
        if (entry) {
          entry.x = cssX / scale;
          entry.y = cssY / scale;
        }
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        if (window.appState) window.appState.scheduleAutoSave();
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    handle.addEventListener('mousedown', onMouseDown);
    el.addEventListener('mousedown', onMouseDown);
  }

  makeImageResizable(el, handle, container, entry) {
    let startX, startY, startW, startH, aspectRatio;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startY = e.clientY;
      startW = parseFloat(el.style.width) || 100;
      startH = parseFloat(el.style.height) || 100;
      aspectRatio = startH / (startW || 1);

      const onMouseMove = (ev) => {
        const dx = ev.clientX - startX;
        const newW = Math.max(40, startW + dx);
        const newH = Math.max(30, Math.round(newW * aspectRatio));

        el.style.width = `${newW}px`;
        el.style.height = `${newH}px`;

        const scale = this.getPageScale(container);
        if (entry) {
          entry.width = newW / scale;
          entry.height = newH / scale;
        }
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        if (window.appState) window.appState.scheduleAutoSave();
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
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
      const scale = this.getPageScale(container);
      const cssX = startLeft + e.clientX - startX;
      const cssY = startTop + e.clientY - startY;
      el.style.left = `${cssX}px`;
      el.style.top = `${cssY}px`;
      if (entry) {
        entry.x = cssX / scale;
        entry.y = cssY / scale;
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
    const state = JSON.stringify({ strokes: data.strokes, imageStamps: data.imageStamps || [] });
    this.undoStacks[pageIndex].push(state);
    if (this.undoStacks[pageIndex].length > 50) this.undoStacks[pageIndex].shift();
    this.redoStacks[pageIndex] = [];
  }

  undo(pageIndex, canvas) {
    if (!this.undoStacks[pageIndex] || this.undoStacks[pageIndex].length === 0) return;
    const data = this.getPageData(pageIndex);
    if (!this.redoStacks[pageIndex]) this.redoStacks[pageIndex] = [];
    this.redoStacks[pageIndex].push(JSON.stringify({ strokes: data.strokes, imageStamps: data.imageStamps || [] }));
    const prev = JSON.parse(this.undoStacks[pageIndex].pop());
    data.strokes = prev.strokes;
    if (prev.imageStamps) {
      data.imageStamps = prev.imageStamps;
      const wrapper = canvas.closest('.page-wrapper');
      if (wrapper) this.restorePageOverlays(wrapper, pageIndex);
    }
    this.redrawPage(canvas, pageIndex);
    if (window.appState) window.appState.scheduleAutoSave();
  }

  redo(pageIndex, canvas) {
    if (!this.redoStacks[pageIndex] || this.redoStacks[pageIndex].length === 0) return;
    const data = this.getPageData(pageIndex);
    if (!this.undoStacks[pageIndex]) this.undoStacks[pageIndex] = [];
    this.undoStacks[pageIndex].push(JSON.stringify({ strokes: data.strokes, imageStamps: data.imageStamps || [] }));
    const next = JSON.parse(this.redoStacks[pageIndex].pop());
    data.strokes = next.strokes;
    if (next.imageStamps) {
      data.imageStamps = next.imageStamps;
      const wrapper = canvas.closest('.page-wrapper');
      if (wrapper) this.restorePageOverlays(wrapper, pageIndex);
    }
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
        imageStamps: (data.imageStamps || []).map(img => ({ id: img.id, type: 'image', x: img.x, y: img.y, width: img.width, height: img.height, dataUrl: img.dataUrl })),
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
        imageStamps: pageData.imageStamps || [],
      };
    }
  }

  restorePageOverlays(pageWrapper, pageIndex) {
    const container = pageWrapper.querySelector('.page-overlays');
    if (container) container.innerHTML = '';

    const pageData = this.getPageData(pageIndex);

    for (const tb of pageData.textBoxes) {
      this.renderTextBoxDOM(pageWrapper, pageIndex, tb);
    }
    for (const sn of pageData.stickyNotes) {
      this.renderStickyNoteDOM(pageWrapper, pageIndex, sn);
    }
    if (pageData.imageStamps) {
      for (const img of pageData.imageStamps) {
        this.renderImageStampDOM(pageWrapper, pageIndex, img);
      }
    }
  }
}

window.AnnotationEngine = AnnotationEngine;
