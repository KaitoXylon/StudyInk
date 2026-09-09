/**
 * shape-recognition.js — Smart Shape Detection & Correction
 * Analyzes freehand strokes and snaps them to perfect shapes.
 * Supports: straight lines, rectangles, circles/ellipses, arrows
 */

const ShapeRecognition = (() => {

  /**
   * Simplify a stroke using Ramer-Douglas-Peucker algorithm
   */
  function rdpSimplify(points, epsilon = 2) {
    if (points.length <= 2) return points;
    let maxDist = 0, maxIdx = 0;
    const first = points[0], last = points[points.length - 1];
    for (let i = 1; i < points.length - 1; i++) {
      const d = pointToLineDistance(points[i], first, last);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > epsilon) {
      const left = rdpSimplify(points.slice(0, maxIdx + 1), epsilon);
      const right = rdpSimplify(points.slice(maxIdx), epsilon);
      return [...left.slice(0, -1), ...right];
    }
    return [first, last];
  }

  function pointToLineDistance(pt, lineStart, lineEnd) {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const len = Math.sqrt(dx*dx + dy*dy);
    if (len === 0) return Math.hypot(pt.x - lineStart.x, pt.y - lineStart.y);
    return Math.abs(dy*pt.x - dx*pt.y + lineEnd.x*lineStart.y - lineEnd.y*lineStart.x) / len;
  }

  function strokeLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
    }
    return len;
  }

  function getBoundingBox(pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }

  function getCentroid(pts) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    return { x: cx, y: cy };
  }

  /**
   * Check if stroke is a straight line
   */
  function isLine(pts) {
    if (pts.length < 2) return null;
    const start = pts[0], end = pts[pts.length - 1];
    const euclidDist = Math.hypot(end.x - start.x, end.y - start.y);
    if (euclidDist < 15) return null;

    const actualLen = strokeLength(pts);
    const ratio = actualLen / euclidDist;
    if (ratio > 1.32) return null;

    const simplified = rdpSimplify(pts, Math.max(3.5, euclidDist * 0.04));
    if (simplified.length > 4) return null;

    let x1 = start.x, y1 = start.y, x2 = end.x, y2 = end.y;
    const dx = x2 - x1, dy = y2 - y1;
    const deg = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);

    // Angle snapping: horizontal (within 7.5 deg)
    if (deg < 7.5 || deg > 172.5) {
      y2 = y1;
    }
    // Vertical (within 7.5 deg)
    else if (Math.abs(deg - 90) < 7.5) {
      x2 = x1;
    }
    // 45-degree diagonals (within 5 deg)
    else if (Math.abs(deg - 45) < 5 || Math.abs(deg - 135) < 5) {
      const signX = dx >= 0 ? 1 : -1;
      const signY = dy >= 0 ? 1 : -1;
      const avgLen = (Math.abs(dx) + Math.abs(dy)) / 2;
      x2 = x1 + signX * avgLen;
      y2 = y1 + signY * avgLen;
    }

    return { type: 'line', x1, y1, x2, y2 };
  }

  /**
   * Check if stroke is a circle
   */
  function isCircle(pts) {
    if (pts.length < 8) return null;
    const bb = getBoundingBox(pts);
    if (bb.w < 15 || bb.h < 15) return null;

    const start = pts[0], end = pts[pts.length - 1];
    const closingDist = Math.hypot(end.x - start.x, end.y - start.y);
    if (closingDist > (bb.w + bb.h) * 0.42) return null;

    const centroid = getCentroid(pts);
    const aspect = bb.w / (bb.h || 1);
    if (aspect < 0.65 || aspect > 1.52) return null;

    const dists = pts.map(p => Math.hypot(p.x - centroid.x, p.y - centroid.y));
    const avgR = dists.reduce((a, b) => a + b, 0) / dists.length;
    const variance = dists.reduce((a, b) => a + Math.pow(b - avgR, 2), 0) / dists.length;
    const coeffVar = Math.sqrt(variance) / (avgR || 1);

    if (coeffVar < 0.28) {
      const r = (bb.w + bb.h) / 4;
      return { type: 'circle', cx: centroid.x, cy: centroid.y, r };
    }
    return null;
  }

  /**
   * Check if stroke is an ellipse
   */
  function isEllipse(pts) {
    if (pts.length < 10) return null;
    const bb = getBoundingBox(pts);
    if (bb.w < 15 || bb.h < 15) return null;

    const start = pts[0], end = pts[pts.length - 1];
    const closingDist = Math.hypot(end.x - start.x, end.y - start.y);
    if (closingDist > (bb.w + bb.h) * 0.42) return null;

    const centroid = getCentroid(pts);
    const rx = bb.w / 2, ry = bb.h / 2;
    let errors = 0;
    for (const p of pts) {
      const dx = (p.x - centroid.x) / rx;
      const dy = (p.y - centroid.y) / ry;
      const val = dx*dx + dy*dy;
      if (Math.abs(val - 1) > 0.65) errors++;
    }
    if ((errors / pts.length) < 0.35) {
      return { type: 'ellipse', cx: centroid.x, cy: centroid.y, rx, ry };
    }
    return null;
  }

  /**
   * Check if stroke is a triangle
   */
  function isTriangle(pts) {
    if (pts.length < 8) return null;
    const bb = getBoundingBox(pts);
    if (bb.w < 15 || bb.h < 15) return null;

    const start = pts[0], end = pts[pts.length - 1];
    const closingDist = Math.hypot(end.x - start.x, end.y - start.y);
    if (closingDist > (bb.w + bb.h) * 0.42) return null;

    const simplified = rdpSimplify(pts, Math.max(7, (bb.w + bb.h) * 0.08));
    if (simplified.length >= 4 && simplified.length <= 5) {
      return {
        type: 'triangle',
        p1: { x: simplified[0].x, y: simplified[0].y },
        p2: { x: simplified[1].x, y: simplified[1].y },
        p3: { x: simplified[2].x, y: simplified[2].y }
      };
    }
    return null;
  }

  /**
   * Check if stroke is a rectangle
   */
  function isRectangle(pts) {
    if (pts.length < 6) return null;
    const bb = getBoundingBox(pts);
    if (bb.w < 15 || bb.h < 15) return null;

    const start = pts[0], end = pts[pts.length - 1];
    const closingDist = Math.hypot(end.x - start.x, end.y - start.y);
    const perimeter = 2 * (bb.w + bb.h);
    const strokeLen = strokeLength(pts);

    if (closingDist > (bb.w + bb.h) * 0.42) return null;
    if (strokeLen / perimeter > 1.65) return null;

    const simplified = rdpSimplify(pts, Math.max(5, (bb.w + bb.h) * 0.06));
    if (simplified.length >= 4 && simplified.length <= 8) {
      return {
        type: 'rect',
        x: bb.minX,
        y: bb.minY,
        w: bb.w,
        h: bb.h,
        origX: bb.minX,
        origY: bb.minY
      };
    }
    return null;
  }

  /**
   * Main recognition function. Returns { type, ... } or null if no shape detected.
   */
  function recognize(pts) {
    if (!pts || pts.length < 4) return null;

    const bb = getBoundingBox(pts);
    const start = pts[0], end = pts[pts.length - 1];
    const closingDist = Math.hypot(end.x - start.x, end.y - start.y);
    const isClosed = closingDist < (bb.w + bb.h) * 0.42;

    if (isClosed) {
      const circle = isCircle(pts);
      if (circle) return circle;

      const tri = isTriangle(pts);
      if (tri) return tri;

      const rect = isRectangle(pts);
      if (rect) return rect;

      const ellipse = isEllipse(pts);
      if (ellipse) return ellipse;
    }

    // Check line
    const line = isLine(pts);
    if (line) return line;

    // Check unclosed or loosely closed circle/rect
    const circleFallback = isCircle(pts);
    if (circleFallback) return circleFallback;

    const rectFallback = isRectangle(pts);
    if (rectFallback) return rectFallback;

    return null;
  }

  /**
   * Adjust shape dynamically based on pointer position while user holds down
   */
  function updateShapeWithPointer(shape, currentPos) {
    if (!shape || !currentPos) return;

    if (shape.type === 'line') {
      let x1 = shape.x1, y1 = shape.y1;
      let x2 = currentPos.x, y2 = currentPos.y;
      const dx = x2 - x1, dy = y2 - y1;
      const deg = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);

      if (deg < 7.5 || deg > 172.5) {
        y2 = y1;
      } else if (Math.abs(deg - 90) < 7.5) {
        x2 = x1;
      } else if (Math.abs(deg - 45) < 5 || Math.abs(deg - 135) < 5) {
        const signX = dx >= 0 ? 1 : -1;
        const signY = dy >= 0 ? 1 : -1;
        const avgLen = (Math.abs(dx) + Math.abs(dy)) / 2;
        x2 = x1 + signX * avgLen;
        y2 = y1 + signY * avgLen;
      }

      shape.x2 = x2;
      shape.y2 = y2;
    } else if (shape.type === 'circle') {
      shape.r = Math.max(4, Math.hypot(currentPos.x - shape.cx, currentPos.y - shape.cy));
    } else if (shape.type === 'ellipse') {
      shape.rx = Math.max(4, Math.abs(currentPos.x - shape.cx));
      shape.ry = Math.max(4, Math.abs(currentPos.y - shape.cy));
    } else if (shape.type === 'rect') {
      const origX = shape.origX !== undefined ? shape.origX : shape.x;
      const origY = shape.origY !== undefined ? shape.origY : shape.y;
      shape.x = Math.min(origX, currentPos.x);
      shape.y = Math.min(origY, currentPos.y);
      shape.w = Math.max(4, Math.abs(currentPos.x - origX));
      shape.h = Math.max(4, Math.abs(currentPos.y - origY));
    }
  }

  /**
   * Draw a recognized shape onto a canvas context
   */
  function drawShape(ctx, shape, style) {
    const { color = '#1a1a2e', lineWidth = 2, opacity = 1 } = style;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();

    if (shape.type === 'line') {
      ctx.moveTo(shape.x1, shape.y1);
      ctx.lineTo(shape.x2, shape.y2);
    } else if (shape.type === 'circle') {
      ctx.arc(shape.cx, shape.cy, Math.max(1, shape.r), 0, Math.PI * 2);
    } else if (shape.type === 'ellipse') {
      ctx.ellipse(shape.cx, shape.cy, Math.max(1, shape.rx), Math.max(1, shape.ry), 0, 0, Math.PI * 2);
    } else if (shape.type === 'rect') {
      ctx.rect(shape.x, shape.y, shape.w, shape.h);
    } else if (shape.type === 'triangle' && shape.p1 && shape.p2 && shape.p3) {
      ctx.moveTo(shape.p1.x, shape.p1.y);
      ctx.lineTo(shape.p2.x, shape.p2.y);
      ctx.lineTo(shape.p3.x, shape.p3.y);
      ctx.closePath();
    }

    ctx.stroke();
    ctx.restore();
    return shape;
  }

  return { recognize, drawShape, updateShapeWithPointer, rdpSimplify, getBoundingBox };
})();

window.ShapeRecognition = ShapeRecognition;
