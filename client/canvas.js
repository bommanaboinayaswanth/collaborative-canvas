/**
 * canvas.js
 * 
 * Vanilla HTML5 Canvas Engine.
 * Features:
 * - Dual-layer architecture: Base Canvas (committed) + Active Canvas (in-flight/preview)
 * - HiDPI / Retina display auto-scaling (devicePixelRatio)
 * - Logical coordinate system (1920x1080) for cross-device synchronization
 * - Smooth quadratic bezier curves with midpoint interpolation
 * - Pointer Events (Mouse, Stylus with pressure, Touch)
 * - Tools: Brush, Eraser, Line, Rectangle, Circle, Arrow
 * - Snapshot caching & deterministic full history replay for Undo/Redo
 */

export class CanvasEngine {
  constructor(containerEl, options = {}) {
    this.container = containerEl;
    this.logicalWidth = options.logicalWidth || 1920;
    this.logicalHeight = options.logicalHeight || 1080;

    // Layer 1: Base canvas for finalized, committed drawing history
    this.baseCanvas = document.createElement('canvas');
    this.baseCtx = this.baseCanvas.getContext('2d', { alpha: false, desynchronized: true });

    // Layer 2: Active scratch canvas for real-time in-flight strokes (local & peers)
    this.activeCanvas = document.createElement('canvas');
    this.activeCtx = this.activeCanvas.getContext('2d', { alpha: true });

    // Configure DOM structure
    this.baseCanvas.className = 'canvas-layer base-layer';
    this.activeCanvas.className = 'canvas-layer active-layer';
    this.container.appendChild(this.baseCanvas);
    this.container.appendChild(this.activeCanvas);

    // Current local drawing state
    this.currentTool = 'brush'; // 'brush' | 'eraser' | 'line' | 'rectangle' | 'circle'
    this.currentColor = '#000000';
    this.currentWidth = 4;
    this.isDrawing = false;
    this.currentStrokeId = null;
    this.currentStrokePoints = [];
    this.shapeStartPoint = null;

    // Remote in-flight strokes: opId -> { tool, color, width, points }
    this.remoteActiveStrokes = new Map();

    // Event callbacks
    this.onStrokeStart = null;
    this.onStrokePoints = null;
    this.onStrokeEnd = null;
    this.onCursorMove = null;
    this.onCursorLeave = null;

    // Setup resolution & listeners
    this.dpr = window.devicePixelRatio || 1;
    this.resizeCanvas();
    this.initEvents();

    // Resize observer
    window.addEventListener('resize', () => this.resizeCanvas());
  }

  /**
   * Resize canvases matching container while preserving logical resolution and crisp DPI.
   */
  resizeCanvas() {
    const rect = this.container.getBoundingClientRect();
    this.displayWidth = rect.width || window.innerWidth;
    this.displayHeight = rect.height || window.innerHeight;

    this.dpr = window.devicePixelRatio || 1;

    // Set internal pixel buffer size (HiDPI crispness)
    const bufferWidth = Math.round(this.displayWidth * this.dpr);
    const bufferHeight = Math.round(this.displayHeight * this.dpr);

    // Save base canvas bitmap before resize (if exists)
    let tempCanvas = null;
    if (this.baseCanvas.width > 0 && this.baseCanvas.height > 0) {
      tempCanvas = document.createElement('canvas');
      tempCanvas.width = this.baseCanvas.width;
      tempCanvas.height = this.baseCanvas.height;
      const tCtx = tempCanvas.getContext('2d');
      tCtx.drawImage(this.baseCanvas, 0, 0);
    }

    [this.baseCanvas, this.activeCanvas].forEach(canvas => {
      canvas.width = bufferWidth;
      canvas.height = bufferHeight;
      canvas.style.width = `${this.displayWidth}px`;
      canvas.style.height = `${this.displayHeight}px`;
    });

    // Scale contexts to support logical coordinate space (1920x1080)
    this.scaleContext(this.baseCtx);
    this.scaleContext(this.activeCtx);

    // Fill white background on base canvas
    this.baseCtx.save();
    this.baseCtx.fillStyle = '#ffffff';
    this.baseCtx.fillRect(0, 0, this.logicalWidth, this.logicalHeight);
    this.baseCtx.restore();

    // Restore previous content or request redraw
    if (tempCanvas) {
      this.baseCtx.save();
      // Reset transform temporarily for direct pixel copy
      this.baseCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.baseCtx.drawImage(tempCanvas, 0, 0, bufferWidth, bufferHeight);
      this.baseCtx.restore();
    }
  }

  /**
   * Apply coordinate transforms: Screen Buffer -> Display CSS Pixels -> Logical Canvas (1920x1080)
   */
  scaleContext(ctx) {
    const scaleX = (this.displayWidth * this.dpr) / this.logicalWidth;
    const scaleY = (this.displayHeight * this.dpr) / this.logicalHeight;
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  }

  /**
   * Transform client screen pointer coordinates into canvas logical coordinate system.
   */
  getLogicalPoint(e) {
    const rect = this.activeCanvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * this.logicalWidth;
    const y = ((e.clientY - rect.top) / rect.height) * this.logicalHeight;
    const pressure = e.pressure !== undefined && e.pressure > 0 ? e.pressure : 0.5;

    return {
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      pressure
    };
  }

  /**
   * Initialize Pointer Events for unified Mouse, Touch, and Stylus support.
   */
  initEvents() {
    const target = this.activeCanvas;

    target.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
    window.addEventListener('pointermove', (e) => this.handlePointerMove(e));
    window.addEventListener('pointerup', (e) => this.handlePointerUp(e));
    target.addEventListener('pointercancel', (e) => this.handlePointerCancel(e));
    target.addEventListener('pointerleave', (e) => {
      if (this.onCursorLeave) this.onCursorLeave();
    });

    // Prevent touch scrolling gestures when drawing on mobile
    target.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    target.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }

  handlePointerDown(e) {
    // Only primary mouse button or touch/pen
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    this.isDrawing = true;
    this.activeCanvas.setPointerCapture(e.pointerId);

    const point = this.getLogicalPoint(e);
    this.currentStrokeId = `op_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.currentStrokePoints = [point];
    this.shapeStartPoint = point;

    if (this.currentTool === 'brush' || this.currentTool === 'eraser') {
      // Draw initial point/dot immediately for instantaneous client-side feedback
      this.drawPointOnActive(point, this.currentTool, this.currentColor, this.currentWidth);

      if (this.onStrokeStart) {
        this.onStrokeStart({
          opId: this.currentStrokeId,
          tool: this.currentTool,
          color: this.currentColor,
          width: this.currentWidth,
          point
        });
      }
    }
  }

  handlePointerMove(e) {
    const point = this.getLogicalPoint(e);

    // Emit live cursor coordinates for presence
    if (this.onCursorMove) {
      this.onCursorMove({
        x: point.x,
        y: point.y,
        isDown: this.isDrawing,
        tool: this.currentTool
      });
    }

    if (!this.isDrawing) return;

    if (this.currentTool === 'brush' || this.currentTool === 'eraser') {
      const prevPoint = this.currentStrokePoints[this.currentStrokePoints.length - 1];
      
      // Filter out redundant micro-movements (< 1.5 logical pixels) for performance
      const dist = Math.hypot(point.x - prevPoint.x, point.y - prevPoint.y);
      if (dist < 1.5) return;

      this.currentStrokePoints.push(point);

      // Render local smooth segment incrementally
      this.drawIncrementalSegment(
        this.activeCtx,
        this.currentStrokePoints,
        this.currentTool,
        this.currentColor,
        this.currentWidth
      );

      // Stream new point to peers
      if (this.onStrokePoints) {
        this.onStrokePoints({
          opId: this.currentStrokeId,
          point
        });
      }
    } else if (['rectangle', 'circle', 'line', 'arrow'].includes(this.currentTool)) {
      // For geometric shapes, clear active layer and re-render preview shape
      this.redrawActiveLayer();
      this.drawShapePreview(
        this.activeCtx,
        this.shapeStartPoint,
        point,
        this.currentTool,
        this.currentColor,
        this.currentWidth
      );
    }
  }

  handlePointerUp(e) {
    if (!this.isDrawing) return;
    this.isDrawing = false;

    const endPoint = this.getLogicalPoint(e);

    if (this.currentTool === 'brush' || this.currentTool === 'eraser') {
      this.currentStrokePoints.push(endPoint);

      const strokeOperation = {
        opId: this.currentStrokeId,
        tool: this.currentTool,
        color: this.currentColor,
        width: this.currentWidth,
        points: this.currentStrokePoints
      };

      // Commit finalized stroke to base layer
      this.renderOperation(this.baseCtx, strokeOperation);

      // Clear local stroke from active layer
      this.redrawActiveLayer();

      // Emit stroke end to commit on server
      if (this.onStrokeEnd) {
        this.onStrokeEnd(strokeOperation);
      }
    } else if (['rectangle', 'circle', 'line', 'arrow'].includes(this.currentTool)) {
      const shapeOperation = {
        opId: this.currentStrokeId,
        tool: this.currentTool,
        color: this.currentColor,
        width: this.currentWidth,
        startPoint: this.shapeStartPoint,
        endPoint
      };

      // Commit shape to base canvas
      this.renderOperation(this.baseCtx, shapeOperation);
      this.redrawActiveLayer();

      if (this.onStrokeEnd) {
        this.onStrokeEnd(shapeOperation);
      }
    }

    this.currentStrokePoints = [];
    this.shapeStartPoint = null;
    this.currentStrokeId = null;
  }

  handlePointerCancel() {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    this.currentStrokePoints = [];
    this.shapeStartPoint = null;
    this.redrawActiveLayer();
  }

  // =========================================================================
  //  REMOTE REAL-TIME PEER RENDERING
  // =========================================================================

  /**
   * Handle incoming peer stroke start.
   */
  handleRemoteStrokeStart(strokeData) {
    this.remoteActiveStrokes.set(strokeData.opId, {
      opId: strokeData.opId,
      tool: strokeData.tool,
      color: strokeData.color,
      width: strokeData.width,
      points: [strokeData.point]
    });

    this.drawPointOnActive(strokeData.point, strokeData.tool, strokeData.color, strokeData.width);
  }

  /**
   * Handle incoming peer stream of points.
   */
  handleRemoteStrokePoints(opId, points) {
    const stroke = this.remoteActiveStrokes.get(opId);
    if (!stroke) return;

    const pointsArr = Array.isArray(points) ? points : [points];
    stroke.points.push(...pointsArr);

    this.drawIncrementalSegment(
      this.activeCtx,
      stroke.points,
      stroke.tool,
      stroke.color,
      stroke.width
    );
  }

  /**
   * Handle incoming committed stroke from server.
   */
  handleRemoteStrokeCommitted(operation) {
    // Remove from active scratch layer
    this.remoteActiveStrokes.delete(operation.id || operation.opId);

    // Commit cleanly into base canvas
    this.renderOperation(this.baseCtx, operation);

    // Refresh active canvas to keep other live strokes clean
    this.redrawActiveLayer();
  }

  /**
   * Handle stroke cancellation.
   */
  handleRemoteStrokeCancel(opId) {
    this.remoteActiveStrokes.delete(opId);
    this.redrawActiveLayer();
  }

  // =========================================================================
  //  CANVAS DRAWING ROUTINES & PATH SMOOTHING
  // =========================================================================

  /**
   * Draw a single round dot (for clicks without drag).
   */
  drawPointOnActive(point, tool, color, width) {
    this.activeCtx.save();
    this.activeCtx.lineCap = 'round';
    this.activeCtx.lineJoin = 'round';

    if (tool === 'eraser') {
      this.activeCtx.fillStyle = '#ffffff';
    } else {
      this.activeCtx.fillStyle = color;
    }

    this.activeCtx.beginPath();
    this.activeCtx.arc(point.x, point.y, width / 2, 0, Math.PI * 2);
    this.activeCtx.fill();
    this.activeCtx.restore();
  }

  /**
   * Smooth curve rendering using quadratic bezier curves with midpoint interpolation.
   */
  drawIncrementalSegment(ctx, points, tool, color, width) {
    const len = points.length;
    if (len < 2) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = width;

    if (tool === 'eraser') {
      ctx.strokeStyle = '#ffffff';
    } else {
      ctx.strokeStyle = color;
    }

    ctx.beginPath();

    if (len === 2) {
      ctx.moveTo(points[0].x, points[0].y);
      ctx.lineTo(points[1].x, points[1].y);
    } else {
      // Connect through previous midpoint to new midpoint
      const pPrevPrev = points[len - 3];
      const pPrev = points[len - 2];
      const pCurr = points[len - 1];

      const mid1X = (pPrevPrev.x + pPrev.x) / 2;
      const mid1Y = (pPrevPrev.y + pPrev.y) / 2;
      const mid2X = (pPrev.x + pCurr.x) / 2;
      const mid2Y = (pPrev.y + pCurr.y) / 2;

      ctx.moveTo(mid1X, mid1Y);
      ctx.quadraticCurveTo(pPrev.x, pPrev.y, mid2X, mid2Y);
    }

    ctx.stroke();
    ctx.restore();
  }

  /**
   * Render complete freehand stroke smoothly from full point array.
   */
  drawFullSmoothStroke(ctx, stroke) {
    const { points, tool, color, width } = stroke;
    if (!points || points.length === 0) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = width || 4;

    if (tool === 'eraser') {
      ctx.strokeStyle = '#ffffff';
      ctx.fillStyle = '#ffffff';
    } else {
      ctx.strokeStyle = color || '#000000';
      ctx.fillStyle = color || '#000000';
    }

    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, (width || 4) / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    if (points.length === 2) {
      ctx.lineTo(points[1].x, points[1].y);
    } else {
      for (let i = 1; i < points.length - 1; i++) {
        const midX = (points[i].x + points[i + 1].x) / 2;
        const midY = (points[i].y + points[i + 1].y) / 2;
        ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
      }
      ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    }

    ctx.stroke();
    ctx.restore();
  }

  /**
   * Draw preview of geometric shapes on active layer.
   */
  drawShapePreview(ctx, start, current, tool, color, width) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = width;
    ctx.strokeStyle = color;

    if (tool === 'rectangle') {
      const x = Math.min(start.x, current.x);
      const y = Math.min(start.y, current.y);
      const w = Math.abs(current.x - start.x);
      const h = Math.abs(current.y - start.y);
      ctx.strokeRect(x, y, w, h);
    } else if (tool === 'circle') {
      const radiusX = Math.abs(current.x - start.x) / 2;
      const radiusY = Math.abs(current.y - start.y) / 2;
      const centerX = Math.min(start.x, current.x) + radiusX;
      const centerY = Math.min(start.y, current.y) + radiusY;

      ctx.beginPath();
      ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (tool === 'line') {
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(current.x, current.y);
      ctx.stroke();
    } else if (tool === 'arrow') {
      this.drawArrow(ctx, start.x, start.y, current.x, current.y, width);
    }

    ctx.restore();
  }

  /**
   * Draw line with arrowhead.
   */
  drawArrow(ctx, fromX, fromY, toX, toY, width) {
    const headLen = Math.max(width * 3, 14);
    const angle = Math.atan2(toY - fromY, toX - fromX);

    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - headLen * Math.cos(angle - Math.PI / 6), toY - headLen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(toX - headLen * Math.cos(angle + Math.PI / 6), toY - headLen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  }

  /**
   * Render any committed operation onto target canvas context.
   */
  renderOperation(ctx, op) {
    if (!op || op.isUndone) return;

    if (op.tool === 'brush' || op.tool === 'eraser') {
      this.drawFullSmoothStroke(ctx, op);
    } else if (op.tool === 'rectangle') {
      ctx.save();
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.width;
      const x = Math.min(op.startPoint.x, op.endPoint.x);
      const y = Math.min(op.startPoint.y, op.endPoint.y);
      const w = Math.abs(op.endPoint.x - op.startPoint.x);
      const h = Math.abs(op.endPoint.y - op.startPoint.y);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    } else if (op.tool === 'circle') {
      ctx.save();
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.width;
      const rx = Math.abs(op.endPoint.x - op.startPoint.x) / 2;
      const ry = Math.abs(op.endPoint.y - op.startPoint.y) / 2;
      const cx = Math.min(op.startPoint.x, op.endPoint.x) + rx;
      const cy = Math.min(op.startPoint.y, op.endPoint.y) + ry;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else if (op.tool === 'line') {
      ctx.save();
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.width;
      ctx.beginPath();
      ctx.moveTo(op.startPoint.x, op.startPoint.y);
      ctx.lineTo(op.endPoint.x, op.endPoint.y);
      ctx.stroke();
      ctx.restore();
    } else if (op.tool === 'arrow') {
      ctx.save();
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.width;
      this.drawArrow(ctx, op.startPoint.x, op.startPoint.y, op.endPoint.x, op.endPoint.y, op.width);
      ctx.restore();
    } else if (op.tool === 'clear') {
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.logicalWidth, this.logicalHeight);
      ctx.restore();
    }
  }

  /**
   * Redraw active scratch canvas (clears and re-draws in-flight strokes).
   */
  redrawActiveLayer() {
    this.activeCtx.clearRect(0, 0, this.logicalWidth, this.logicalHeight);

    // Replay any remote active strokes
    for (const stroke of this.remoteActiveStrokes.values()) {
      this.drawFullSmoothStroke(this.activeCtx, stroke);
    }
  }

  /**
   * Deterministically replay all active operations onto base canvas.
   * Called during initial state load, global undo, and global redo.
   */
  reconstructBaseCanvas(operations, undoneOpIds = new Set()) {
    // Fill pristine white background
    this.baseCtx.save();
    this.baseCtx.fillStyle = '#ffffff';
    this.baseCtx.fillRect(0, 0, this.logicalWidth, this.logicalHeight);
    this.baseCtx.restore();

    const undoneSet = undoneOpIds instanceof Set ? undoneOpIds : new Set(undoneOpIds);

    // Replay each operation in chronological sequence
    for (const op of operations) {
      const opId = op.id || op.opId;
      if (!undoneSet.has(opId) && !op.isUndone) {
        this.renderOperation(this.baseCtx, op);
      }
    }

    // Refresh active layer on top
    this.redrawActiveLayer();
  }

  /**
   * Export the merged canvas as a PNG data URL or image download.
   */
  exportImage(filename = 'whiteboard.png') {
    // Create temporary offscreen canvas at display resolution
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = this.baseCanvas.width;
    exportCanvas.height = this.baseCanvas.height;
    const ctx = exportCanvas.getContext('2d');

    // Draw base layer
    ctx.drawImage(this.baseCanvas, 0, 0);

    // Draw active layer if any
    ctx.drawImage(this.activeCanvas, 0, 0);

    const link = document.createElement('a');
    link.download = filename;
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
  }
}
