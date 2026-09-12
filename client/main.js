/**
 * main.js
 * 
 * Application Entry Point.
 * Orchestrates CanvasEngine, WebSocketClient, and the User Interface:
 * - Floating toolbars, tool selection, color picker, width slider
 * - Peer cursor management & name tags
 * - Global vs User Undo/Redo modes & shortcut keys
 * - Room switcher & URL hash linking
 * - Real-time FPS and Latency performance metrics
 * - In-app toast notification feed
 */

import { CanvasEngine } from './canvas.js';
import { WebSocketClient } from './websocket.js';

class CollaborativeApp {
  constructor() {
    this.canvasContainer = document.getElementById('canvas-container');
    this.cursorOverlay = document.getElementById('cursor-overlay');
    
    // Core engines
    this.canvasEngine = new CanvasEngine(this.canvasContainer);
    this.wsClient = new WebSocketClient();

    // Application state
    this.operations = [];
    this.undoneOpIds = new Set();
    this.undoMode = 'global'; // 'global' | 'user'
    this.peerCursors = new Map(); // userId -> HTMLElement
    this.onlineUsers = [];

    // Performance metrics
    this.fps = 60;
    this.frameCount = 0;
    this.lastFpsUpdate = performance.now();

    this.initUI();
    this.initShortcuts();
    this.initSocketEvents();
    this.initPerformanceMonitor();

    // Detect room from URL hash or default to 'main'
    const hashRoom = window.location.hash.replace('#', '').trim();
    const initialRoom = hashRoom || 'main';

    this.wsClient.connect({ roomId: initialRoom });

    // Listen for hash change for room navigation
    window.addEventListener('hashchange', () => {
      const newRoom = window.location.hash.replace('#', '').trim() || 'main';
      this.wsClient.switchRoom(newRoom);
      this.updateRoomDisplay(newRoom);
    });
  }

  // =========================================================================
  //  UI INITIALIZATION & BINDINGS
  // =========================================================================

  initUI() {
    // Tool buttons
    const toolButtons = document.querySelectorAll('[data-tool]');
    toolButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        toolButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tool = btn.getAttribute('data-tool');
        this.canvasEngine.currentTool = tool;
        this.showToast(`Tool: ${tool.toUpperCase()}`, 1200);
      });
    });

    // Color swatches & custom input
    const colorSwatches = document.querySelectorAll('.color-swatch');
    const colorInput = document.getElementById('color-picker');

    colorSwatches.forEach(swatch => {
      swatch.addEventListener('click', () => {
        colorSwatches.forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
        const color = swatch.getAttribute('data-color');
        this.canvasEngine.currentColor = color;
        colorInput.value = color;
      });
    });

    colorInput.addEventListener('input', (e) => {
      colorSwatches.forEach(s => s.classList.remove('active'));
      this.canvasEngine.currentColor = e.target.value;
    });

    // Stroke width slider
    const widthSlider = document.getElementById('stroke-width');
    const widthVal = document.getElementById('width-value');
    const widthPreview = document.getElementById('width-preview-dot');

    widthSlider.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      this.canvasEngine.currentWidth = val;
      widthVal.textContent = `${val}px`;
      if (widthPreview) {
        widthPreview.style.width = `${Math.min(val, 28)}px`;
        widthPreview.style.height = `${Math.min(val, 28)}px`;
      }
    });

    // Undo / Redo buttons
    document.getElementById('btn-undo').addEventListener('click', () => this.handleUndo());
    document.getElementById('btn-redo').addEventListener('click', () => this.handleRedo());

    // Undo mode toggle
    const undoModeSelect = document.getElementById('undo-mode-select');
    if (undoModeSelect) {
      undoModeSelect.addEventListener('change', (e) => {
        this.undoMode = e.target.value;
        this.showToast(`Undo scope: ${this.undoMode === 'global' ? 'Global (All Users)' : 'My Actions Only'}`);
      });
    }

    // Clear Canvas button
    document.getElementById('btn-clear').addEventListener('click', () => {
      if (confirm('Are you sure you want to clear the canvas for everyone? (This can be undone)')) {
        this.wsClient.sendClearCanvas();
      }
    });

    // Export PNG
    document.getElementById('btn-export').addEventListener('click', () => {
      this.canvasEngine.exportImage(`whiteboard_${this.wsClient.roomId}_${Date.now()}.png`);
      this.showToast('Exported canvas as PNG!');
    });

    // Room Switcher input
    const roomInput = document.getElementById('room-name-input');
    const btnJoinRoom = document.getElementById('btn-join-room');
    if (btnJoinRoom && roomInput) {
      btnJoinRoom.addEventListener('click', () => {
        const newRoom = roomInput.value.trim().toLowerCase();
        if (newRoom) {
          window.location.hash = newRoom;
        }
      });
      roomInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          btnJoinRoom.click();
        }
      });
    }

    // Profile modal / edit button
    const btnEditProfile = document.getElementById('btn-edit-profile');
    const profileModal = document.getElementById('profile-modal');
    const btnSaveProfile = document.getElementById('btn-save-profile');
    const btnCloseProfile = document.getElementById('btn-close-profile');
    const usernameInput = document.getElementById('profile-username');
    const userColorInput = document.getElementById('profile-color');

    if (btnEditProfile && profileModal) {
      btnEditProfile.addEventListener('click', () => {
        usernameInput.value = this.wsClient.userName || '';
        userColorInput.value = this.wsClient.userColor || '#3b82f6';
        profileModal.classList.remove('hidden');
      });

      btnCloseProfile.addEventListener('click', () => {
        profileModal.classList.add('hidden');
      });

      btnSaveProfile.addEventListener('click', () => {
        const newName = usernameInput.value.trim();
        const newColor = userColorInput.value;
        if (newName) {
          this.wsClient.updateProfile(newName, newColor);
          this.updateOwnProfileBadge(newName, newColor);
          this.showToast('Profile updated!');
        }
        profileModal.classList.add('hidden');
      });
    }

    // Copy Room Invite Link
    const btnShareRoom = document.getElementById('btn-share-room');
    if (btnShareRoom) {
      btnShareRoom.addEventListener('click', () => {
        navigator.clipboard.writeText(window.location.href);
        this.showToast('Invite link copied to clipboard!');
      });
    }

    // Connect CanvasEngine drawing events to WebSocketClient
    this.canvasEngine.onStrokeStart = (data) => {
      this.wsClient.sendStrokeStart(data);
    };

    this.canvasEngine.onStrokePoints = (data) => {
      this.wsClient.sendStrokePoint(data.opId, data.point);
    };

    this.canvasEngine.onStrokeEnd = (data) => {
      this.wsClient.sendStrokeEnd(data);
    };

    this.canvasEngine.onCursorMove = (data) => {
      this.wsClient.sendCursorMove(data);
    };

    this.canvasEngine.onCursorLeave = () => {
      this.wsClient.sendCursorLeave();
    };
  }

  // =========================================================================
  //  KEYBOARD SHORTCUTS
  // =========================================================================

  initShortcuts() {
    window.addEventListener('keydown', (e) => {
      // Ignore if user is typing in an input
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

      const isCtrlOrCmd = e.ctrlKey || e.metaKey;

      if (isCtrlOrCmd && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          this.handleRedo();
        } else {
          this.handleUndo();
        }
      } else if (isCtrlOrCmd && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.handleRedo();
      } else if (!isCtrlOrCmd) {
        // Tool hotkeys
        switch (e.key.toLowerCase()) {
          case 'b':
            this.setToolActive('brush');
            break;
          case 'e':
            this.setToolActive('eraser');
            break;
          case 'l':
            this.setToolActive('line');
            break;
          case 'r':
            this.setToolActive('rectangle');
            break;
          case 'c':
            this.setToolActive('circle');
            break;
          case 'a':
            this.setToolActive('arrow');
            break;
        }
      }
    });
  }

  setToolActive(toolName) {
    const btn = document.querySelector(`[data-tool="${toolName}"]`);
    if (btn) btn.click();
  }

  handleUndo() {
    this.wsClient.sendUndo(this.undoMode);
  }

  handleRedo() {
    this.wsClient.sendRedo(this.undoMode);
  }

  // =========================================================================
  //  SOCKET EVENTS & STATE SYNCHRONIZATION
  // =========================================================================

  initSocketEvents() {
    // Initial state upon connection
    this.wsClient.on('initState', (data) => {
      console.log('[App] Received room state snapshot:', data);
      this.updateRoomDisplay(data.room.id);
      this.updateOwnProfileBadge(data.user.userName, data.user.userColor);

      // Reconstruct operation log
      this.operations = data.snapshot.operations || [];
      this.undoneOpIds = new Set(data.snapshot.undoneOpIds || []);

      // Reconstruct canvas deterministically
      this.canvasEngine.reconstructBaseCanvas(this.operations, this.undoneOpIds);

      // Render any existing active strokes from peers
      if (data.snapshot.activeStrokes) {
        data.snapshot.activeStrokes.forEach(stroke => {
          this.canvasEngine.handleRemoteStrokeStart(stroke);
          if (stroke.points && stroke.points.length > 1) {
            this.canvasEngine.handleRemoteStrokePoints(stroke.id, stroke.points.slice(1));
          }
        });
      }

      this.updateUsersList(data.users || []);
      this.updateOperationsBadge();
      this.showToast(`Connected to room: ${data.room.id}`, 2000);
    });

    // Remote peer stroke events
    this.wsClient.on('remoteStrokeStart', (data) => {
      this.canvasEngine.handleRemoteStrokeStart(data);
    });

    this.wsClient.on('remoteStrokePoints', (data) => {
      this.canvasEngine.handleRemoteStrokePoints(data.opId, data.points);
    });

    this.wsClient.on('strokeCommitted', (data) => {
      const op = data.operation;
      
      // Check if operation already exists (deduplication)
      const existingIdx = this.operations.findIndex(o => (o.id || o.opId) === (op.id || op.opId));
      if (existingIdx !== -1) {
        this.operations[existingIdx] = op;
      } else {
        this.operations.push(op);
      }

      this.canvasEngine.handleRemoteStrokeCommitted(op);
      this.updateOperationsBadge();
    });

    this.wsClient.on('remoteStrokeCancel', (data) => {
      this.canvasEngine.handleRemoteStrokeCancel(data.opId);
    });

    // History undo/redo events
    this.wsClient.on('historyUndone', (data) => {
      this.undoneOpIds.add(data.opId);
      
      // Update local operation object tombstone
      const op = this.operations.find(o => (o.id || o.opId) === data.opId);
      if (op) op.isUndone = true;

      // Deterministically reconstruct base canvas
      this.canvasEngine.reconstructBaseCanvas(this.operations, this.undoneOpIds);
      this.updateOperationsBadge();

      const who = data.undoneBy || 'A user';
      this.showToast(`Undo by ${who} (${data.mode === 'user' ? 'User' : 'Global'})`, 2000);
    });

    this.wsClient.on('historyRedone', (data) => {
      this.undoneOpIds.delete(data.opId);

      const op = this.operations.find(o => (o.id || o.opId) === data.opId);
      if (op) {
        op.isUndone = false;
      } else if (data.operation) {
        this.operations.push(data.operation);
      }

      this.canvasEngine.reconstructBaseCanvas(this.operations, this.undoneOpIds);
      this.updateOperationsBadge();

      const who = data.redoneBy || 'A user';
      this.showToast(`Redo by ${who} (${data.mode === 'user' ? 'User' : 'Global'})`, 2000);
    });

    // Clear canvas
    this.wsClient.on('canvasCleared', (data) => {
      this.operations.push(data.operation);
      this.canvasEngine.renderOperation(this.canvasEngine.baseCtx, data.operation);
      this.canvasEngine.redrawActiveLayer();
      this.updateOperationsBadge();
      this.showToast(`Canvas cleared by ${data.clearedBy || 'someone'}`);
    });

    // Live peer cursors
    this.wsClient.on('cursorUpdate', (data) => {
      this.updatePeerCursor(data);
    });

    this.wsClient.on('cursorLeave', (data) => {
      this.removePeerCursor(data.userId);
    });

    // User presence
    this.wsClient.on('userJoined', (data) => {
      this.updateUsersList(data.users);
      this.showToast(`${data.user.userName} joined`, 2000);
    });

    this.wsClient.on('userLeft', (data) => {
      this.removePeerCursor(data.userId);
      this.updateUsersList(data.users);
      this.showToast(`${data.userName} left`, 2000);
    });

    this.wsClient.on('usersUpdated', (data) => {
      this.updateUsersList(data.users);
    });

    // Latency update
    this.wsClient.on('latencyUpdate', (data) => {
      const badge = document.getElementById('latency-indicator');
      if (badge) {
        badge.textContent = `${data.latencyMs} ms`;
        if (data.latencyMs < 50) {
          badge.className = 'metric-tag ping-fast';
        } else if (data.latencyMs < 150) {
          badge.className = 'metric-tag ping-medium';
        } else {
          badge.className = 'metric-tag ping-slow';
        }
      }
    });

    // Connection state
    this.wsClient.on('disconnected', () => {
      const statusDot = document.getElementById('connection-status-dot');
      if (statusDot) statusDot.className = 'status-dot disconnected';
      this.showToast('Disconnected. Reconnecting...', 3000);
    });

    this.wsClient.on('connected', () => {
      const statusDot = document.getElementById('connection-status-dot');
      if (statusDot) statusDot.className = 'status-dot connected';
    });
  }

  // =========================================================================
  //  PEER CURSOR RENDERING (DOM OVERLAY)
  // =========================================================================

  updatePeerCursor(data) {
    // Don't render own cursor
    if (data.userId === this.wsClient.userId) return;

    let cursorEl = this.peerCursors.get(data.userId);

    if (!cursorEl) {
      cursorEl = document.createElement('div');
      cursorEl.className = 'peer-cursor';
      cursorEl.innerHTML = `
        <svg class="cursor-pointer" viewBox="0 0 24 24" width="22" height="22">
          <path d="M5.653 4.31a1.2 1.2 0 0 1 1.776-.43l11.455 7.93a1.2 1.2 0 0 1-.36 2.19l-4.72 1.34 2.8 5.76a1.2 1.2 0 1 1-2.14 1.04l-2.8-5.76-3.7 3.23a1.2 1.2 0 0 1-1.99-.9V4.74c0-.15.03-.3.08-.43z" />
        </svg>
        <span class="cursor-tag"></span>
      `;
      this.cursorOverlay.appendChild(cursorEl);
      this.peerCursors.set(data.userId, cursorEl);
    }

    // Convert logical coordinates (1920x1080) to screen pixel coordinates
    const rect = this.canvasEngine.activeCanvas.getBoundingClientRect();
    const screenX = (data.cursor.x / this.canvasEngine.logicalWidth) * rect.width;
    const screenY = (data.cursor.y / this.canvasEngine.logicalHeight) * rect.height;

    // Apply GPU-accelerated transform
    cursorEl.style.transform = `translate3d(${screenX}px, ${screenY}px, 0)`;

    // Update color and label
    const svgPath = cursorEl.querySelector('svg path');
    const tag = cursorEl.querySelector('.cursor-tag');

    svgPath.style.fill = data.userColor || '#3b82f6';
    tag.style.backgroundColor = data.userColor || '#3b82f6';
    tag.textContent = `${data.userName}${data.cursor.isDown ? ' ✏️' : ''}`;

    cursorEl.style.opacity = '1';
  }

  removePeerCursor(userId) {
    const cursorEl = this.peerCursors.get(userId);
    if (cursorEl) {
      cursorEl.style.opacity = '0';
      setTimeout(() => {
        cursorEl.remove();
        this.peerCursors.delete(userId);
      }, 300);
    }
  }

  // =========================================================================
  //  PRESENCE & UI HELPERS
  // =========================================================================

  updateUsersList(users) {
    this.onlineUsers = users;
    const countEl = document.getElementById('user-count');
    const avatarsContainer = document.getElementById('user-avatars');

    if (countEl) countEl.textContent = `${users.length} online`;

    if (avatarsContainer) {
      avatarsContainer.innerHTML = '';
      users.forEach(user => {
        const isMe = user.userId === this.wsClient.userId;
        const pill = document.createElement('div');
        pill.className = `user-pill ${isMe ? 'is-self' : ''}`;
        pill.title = `${user.userName} ${isMe ? '(You)' : ''}`;
        pill.innerHTML = `
          <span class="user-color-dot" style="background-color: ${user.userColor}"></span>
          <span class="user-pill-name">${user.userName}${isMe ? ' (You)' : ''}</span>
        `;
        avatarsContainer.appendChild(pill);
      });
    }
  }

  updateRoomDisplay(roomId) {
    const titleEl = document.getElementById('current-room-name');
    if (titleEl) titleEl.textContent = `#${roomId}`;
    const roomInput = document.getElementById('room-name-input');
    if (roomInput) roomInput.value = roomId;
  }

  updateOwnProfileBadge(name, color) {
    const badge = document.getElementById('my-profile-name');
    const dot = document.getElementById('my-profile-dot');
    if (badge) badge.textContent = name;
    if (dot) dot.style.backgroundColor = color;
  }

  updateOperationsBadge() {
    const badge = document.getElementById('ops-count');
    if (badge) {
      const activeOps = this.operations.filter(o => !this.undoneOpIds.has(o.id || o.opId) && !o.isUndone).length;
      badge.textContent = `${activeOps} strokes`;
    }
  }

  // =========================================================================
  //  PERFORMANCE MONITOR (FPS & HUD)
  // =========================================================================

  initPerformanceMonitor() {
    const fpsEl = document.getElementById('fps-indicator');

    const loop = (now) => {
      this.frameCount += 1;
      if (now - this.lastFpsUpdate >= 1000) {
        this.fps = Math.round((this.frameCount * 1000) / (now - this.lastFpsUpdate));
        this.frameCount = 0;
        this.lastFpsUpdate = now;

        if (fpsEl) {
          fpsEl.textContent = `${this.fps} FPS`;
          if (this.fps >= 50) {
            fpsEl.className = 'metric-tag fps-high';
          } else if (this.fps >= 30) {
            fpsEl.className = 'metric-tag fps-mid';
          } else {
            fpsEl.className = 'metric-tag fps-low';
          }
        }
      }
      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
  }

  // =========================================================================
  //  TOAST FEED
  // =========================================================================

  showToast(message, duration = 2400) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast-item';
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => toast.classList.add('visible'), 10);

    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
}

// Bootstrap application once DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  window.app = new CollaborativeApp();
});
