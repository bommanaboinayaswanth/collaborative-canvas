/**
 * drawing-state.js
 * 
 * Server-authoritative canvas state management.
 * Maintains operation log, active in-progress strokes, global undo/redo stack,
 * and deterministic sequence numbers for conflict resolution.
 */

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
    
    // Currently in-flight strokes: socketId/userId -> InProgressStroke
    this.activeStrokes = new Map();
    
    // Monotonic sequence counter for total order
    this.sequenceNumber = 0;
  }

  /**
   * Start a new in-progress stroke from a user.
   */
  startStroke(userId, strokeData) {
    const { opId, tool, color, width, point, userName, userColor } = strokeData;
    
    const stroke = {
      id: opId,
      userId,
      userName: userName || 'Anonymous',
      userColor: userColor || '#3b82f6',
      tool: tool || 'brush',
      color: color || '#000000',
      width: Number(width) || 4,
      points: [point],
      startedAt: Date.now()
    };

    this.activeStrokes.set(opId, stroke);
    return stroke;
  }

  /**
   * Append stream of points to an active stroke.
   */
  appendPoints(opId, points) {
    const stroke = this.activeStrokes.get(opId);
    if (!stroke) return null;

    if (Array.isArray(points)) {
      stroke.points.push(...points);
    } else if (points) {
      stroke.points.push(points);
    }
    return stroke;
  }

  /**
   * Finalize an active stroke or add a shape/clear operation.
   */
  endStroke(opId, finalData = {}) {
    let operation = this.activeStrokes.get(opId);

    if (operation) {
      // Append any trailing points
      if (finalData.points && Array.isArray(finalData.points)) {
        operation.points = finalData.points;
      }
      this.activeStrokes.delete(opId);
    } else if (finalData.tool) {
      // Operation was submitted directly (e.g. Shape, Clear)
      operation = {
        id: opId,
        userId: finalData.userId,
        userName: finalData.userName || 'Anonymous',
        userColor: finalData.userColor || '#3b82f6',
        tool: finalData.tool,
        color: finalData.color || '#000000',
        width: Number(finalData.width) || 4,
        points: finalData.points || [],
        startPoint: finalData.startPoint || null,
        endPoint: finalData.endPoint || null,
        fillColor: finalData.fillColor || 'transparent',
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

    // Store in operation log
    this.operations.set(opId, operation);
    this.order.push(opId);

    // New drawing action clears future redo stack (standard whiteboard semantics)
    this.redoStack = [];

    return operation;
  }

  /**
   * Undo an operation.
   * @param {string} [userId] - Optional. If provided with mode='user', undos this user's last action.
   * @param {'global'|'user'} [mode='global'] - Undo mode.
   * @returns {{ success: boolean, opId: string | null, operation: object | null }}
   */
  undo(userId = null, mode = 'global') {
    // Traverse chronological order backwards to find the last active operation
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
          // Global undo: picks the absolute latest active operation
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
   * Redo the most recently undone operation.
   * @param {string} [userId] - Optional. If provided with mode='user', redoes this user's last undone action.
   * @param {'global'|'user'} [mode='global'] - Redo mode.
   * @returns {{ success: boolean, opId: string | null, operation: object | null }}
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
      // Global redo
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
   * Clear canvas operation. Recorded as an operation so it can be undone.
   */
  clearCanvas(userId, userName) {
    const opId = `clear_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    // Clear any active in-flight strokes
    this.activeStrokes.clear();

    const clearOp = this.endStroke(opId, {
      userId,
      userName,
      tool: 'clear'
    });

    return clearOp;
  }

  /**
   * Cancel an in-flight stroke (e.g. if user cancels pointer or disconnects mid-stroke).
   */
  cancelStroke(opId) {
    if (this.activeStrokes.has(opId)) {
      this.activeStrokes.delete(opId);
      return true;
    }
    return false;
  }

  /**
   * Get full state payload for new user or resynchronization.
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
