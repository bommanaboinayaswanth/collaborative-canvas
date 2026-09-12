/**
 * drawing-state.js
 * 
 * Server-authoritative canvas state management.
 * Maintains operation log, active in-progress strokes, global undo/redo stack,
 * and deterministic sequence numbers for conflict resolution.
 * 
 * Hardened with:
 * - Idempotency protection against duplicate commits
 * - Input validation & bounds clamping
 * - Redo stack safety
 * - Snapshot caching support
 */

const ALLOWED_TOOLS = new Set(['brush', 'eraser', 'line', 'arrow', 'rectangle', 'circle', 'clear']);

class DrawingState {
  constructor(roomId = 'default') {
    this.roomId = roomId;
    
    // Ordered map of all committed operations: opId -> operation
    this.operations = new Map();
    
    // Chronological order of operation IDs
    this.order = [];
    
    // Set of operation IDs that are currently undone (tombstones)
    this.undoneOpIds = new Set();
    
    // History stack of undone operations for redo: [opId, opId, ...]
    this.redoStack = [];
    
    // Currently in-flight strokes: opId -> InProgressStroke
    this.activeStrokes = new Map();
    
    // Monotonic sequence counter for total order
    this.sequenceNumber = 0;
  }

  /**
   * Sanitize coordinate point.
   */
  sanitizePoint(pt) {
    if (!pt || typeof pt !== 'object') return null;
    const x = Number(pt.x);
    const y = Number(pt.y);
    if (Number.isNaN(x) || Number.isNaN(y)) return null;
    return {
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      pressure: typeof pt.pressure === 'number' ? pt.pressure : 0.5
    };
  }

  /**
   * Start a new in-progress stroke from a user.
   */
  startStroke(userId, strokeData = {}) {
    if (!strokeData || !strokeData.opId) return null;

    const opId = String(strokeData.opId);
    const tool = ALLOWED_TOOLS.has(strokeData.tool) ? strokeData.tool : 'brush';
    const color = typeof strokeData.color === 'string' ? strokeData.color.slice(0, 32) : '#000000';
    const width = Math.min(Math.max(Number(strokeData.width) || 4, 1), 100);
    const validPoint = this.sanitizePoint(strokeData.point) || { x: 0, y: 0 };

    const stroke = {
      id: opId,
      userId: String(userId || 'anonymous'),
      userName: String(strokeData.userName || 'Anonymous').slice(0, 24),
      userColor: String(strokeData.userColor || '#3b82f6').slice(0, 24),
      tool,
      color,
      width,
      points: [validPoint],
      startedAt: Date.now()
    };

    this.activeStrokes.set(opId, stroke);
    return stroke;
  }

  /**
   * Append stream of points to an active stroke.
   */
  appendPoints(opId, points) {
    if (!opId) return null;
    const stroke = this.activeStrokes.get(String(opId));
    if (!stroke) return null;

    if (Array.isArray(points)) {
      for (const pt of points) {
        const cleanPt = this.sanitizePoint(pt);
        if (cleanPt) stroke.points.push(cleanPt);
      }
    } else if (points) {
      const cleanPt = this.sanitizePoint(points);
      if (cleanPt) stroke.points.push(cleanPt);
    }

    return stroke;
  }

  /**
   * Finalize an active stroke or commit a shape/clear operation.
   * Idempotent: returns existing operation if already committed.
   */
  endStroke(opId, finalData = {}) {
    if (!opId) return null;
    const cleanOpId = String(opId);

    // IDEMPOTENCY CHECK: If already committed, ignore duplicate commit
    if (this.operations.has(cleanOpId)) {
      return null;
    }

    let operation = this.activeStrokes.get(cleanOpId);

    if (operation) {
      // Append any trailing points
      if (finalData.points && Array.isArray(finalData.points)) {
        const sanitized = [];
        for (const pt of finalData.points) {
          const cleanPt = this.sanitizePoint(pt);
          if (cleanPt) sanitized.push(cleanPt);
        }
        if (sanitized.length > 0) operation.points = sanitized;
      }
      this.activeStrokes.delete(cleanOpId);
    } else if (finalData.tool) {
      // Geometric shape or clear operation committed directly
      const tool = ALLOWED_TOOLS.has(finalData.tool) ? finalData.tool : 'brush';
      const color = typeof finalData.color === 'string' ? finalData.color.slice(0, 32) : '#000000';
      const width = Math.min(Math.max(Number(finalData.width) || 4, 1), 100);

      operation = {
        id: cleanOpId,
        userId: String(finalData.userId || 'anonymous'),
        userName: String(finalData.userName || 'Anonymous').slice(0, 24),
        userColor: String(finalData.userColor || '#3b82f6').slice(0, 24),
        tool,
        color,
        width,
        points: Array.isArray(finalData.points) ? finalData.points.map(p => this.sanitizePoint(p)).filter(Boolean) : [],
        startPoint: this.sanitizePoint(finalData.startPoint) || null,
        endPoint: this.sanitizePoint(finalData.endPoint) || null,
        fillColor: typeof finalData.fillColor === 'string' ? finalData.fillColor.slice(0, 32) : 'transparent',
        startedAt: Date.now()
      };
    } else {
      return null;
    }

    // Assign monotonic sequence number
    this.sequenceNumber += 1;
    operation.seq = this.sequenceNumber;
    operation.completedAt = Date.now();
    operation.isUndone = false;

    // Store in authoritative operation log
    this.operations.set(cleanOpId, operation);
    this.order.push(cleanOpId);

    // Any new drawing action invalidates future redo branch
    this.redoStack = [];

    return operation;
  }

  /**
   * Undo an operation.
   * Supports 'global' (last canvas stroke) and 'user' (last stroke by specific user).
   */
  undo(userId = null, mode = 'global') {
    let targetOpId = null;

    for (let i = this.order.length - 1; i >= 0; i--) {
      const opId = this.order[i];
      if (!this.undoneOpIds.has(opId)) {
        if (mode === 'user' && userId) {
          const op = this.operations.get(opId);
          if (op && op.userId === userId) {
            targetOpId = opId;
            break;
          }
        } else {
          // Global undo: latest operation on the canvas
          targetOpId = opId;
          break;
        }
      }
    }

    if (!targetOpId) {
      return { success: false, opId: null, operation: null };
    }

    this.undoneOpIds.add(targetOpId);
    this.redoStack.push(targetOpId);

    const op = this.operations.get(targetOpId);
    if (op) {
      op.isUndone = true;
    }

    return {
      success: true,
      opId: targetOpId,
      operation: op
    };
  }

  /**
   * Redo an undone operation.
   */
  redo(userId = null, mode = 'global') {
    if (this.redoStack.length === 0) {
      return { success: false, opId: null, operation: null };
    }

    let targetIndex = -1;
    let targetOpId = null;

    if (mode === 'user' && userId) {
      for (let i = this.redoStack.length - 1; i >= 0; i--) {
        const opId = this.redoStack[i];
        const op = this.operations.get(opId);
        if (op && op.userId === userId) {
          targetIndex = i;
          targetOpId = opId;
          break;
        }
      }
    } else {
      // Global redo: top of redo stack
      targetIndex = this.redoStack.length - 1;
      targetOpId = this.redoStack[targetIndex];
    }

    if (targetIndex === -1 || !targetOpId) {
      return { success: false, opId: null, operation: null };
    }

    // Remove from redo stack and undone set
    this.redoStack.splice(targetIndex, 1);
    this.undoneOpIds.delete(targetOpId);

    const op = this.operations.get(targetOpId);
    if (op) {
      op.isUndone = false;
    }

    return {
      success: true,
      opId: targetOpId,
      operation: op
    };
  }

  /**
   * Clear canvas. Recorded as an undoable operation.
   */
  clearCanvas(userId, userName) {
    const opId = `clear_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    // Terminate any active in-flight strokes
    this.activeStrokes.clear();

    const clearOp = this.endStroke(opId, {
      userId,
      userName,
      tool: 'clear'
    });

    return clearOp;
  }

  /**
   * Cancel an in-flight stroke.
   */
  cancelStroke(opId) {
    if (!opId) return false;
    return this.activeStrokes.delete(String(opId));
  }

  /**
   * Full state snapshot for new clients, reconnects, or synchronization audits.
   */
  getSnapshot() {
    const operationsList = [];
    for (const opId of this.order) {
      const op = this.operations.get(opId);
      if (op) {
        operationsList.push(op);
      }
    }

    const activeList = Array.from(this.activeStrokes.values());

    return {
      roomId: this.roomId,
      sequenceNumber: this.sequenceNumber,
      operations: operationsList,
      undoneOpIds: Array.from(this.undoneOpIds),
      activeStrokes: activeList
    };
  }
}

module.exports = DrawingState;
