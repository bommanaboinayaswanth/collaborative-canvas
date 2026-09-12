/**
 * websocket.js
 * 
 * WebSocket / Socket.IO Client Adapter.
 * Handles bidirectional real-time communication:
 * - Persistent client userId across reconnects
 * - Connection lifecycle & reconnection
 * - Point batching / streaming with frame throttling (~60Hz)
 * - Peer cursor synchronization (~30Hz)
 * - Latency RTT measurement
 * - Event dispatching to application logic
 */

export class WebSocketClient {
  constructor() {
    this.socket = null;
    this.connected = false;
    
    // Persistent userId stored across page refreshes
    let savedUserId = null;
    try {
      savedUserId = localStorage.getItem('cc_userid');
      if (!savedUserId) {
        savedUserId = `usr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        localStorage.setItem('cc_userid', savedUserId);
      }
    } catch (e) {
      savedUserId = `usr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    }
    this.userId = savedUserId;

    this.userName = null;
    this.userColor = null;
    this.roomId = 'main';

    // Point stream batching buffer (~60 Hz)
    this.pointsBuffer = [];
    this.bufferOpId = null;
    this.flushTimeout = null;
    this.BATCH_INTERVAL_MS = 16;

    // Cursor throttling (~30 Hz)
    this.lastCursorEmit = 0;
    this.CURSOR_THROTTLE_MS = 35;

    // Latency measurement
    this.latencyMs = 0;
    this.pingTimer = null;

    // Listeners map
    this.listeners = new Map();

    // Flush on page unload
    window.addEventListener('beforeunload', () => {
      this.flushPointsBuffer();
    });
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  emitEvent(event, data) {
    const list = this.listeners.get(event);
    if (list) {
      list.forEach(cb => {
        try {
          cb(data);
        } catch (err) {
          console.error(`[WebSocket] Error in ${event} callback:`, err);
        }
      });
    }
  }

  connect(options = {}) {
    if (typeof io === 'undefined') {
      console.error('[WebSocket] Socket.io client library not loaded.');
      return;
    }

    this.socket = io({
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 15,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000
    });

    this.roomId = options.roomId || 'main';
    
    try {
      this.userName = options.userName || localStorage.getItem('cc_username') || `Artist ${Math.floor(100 + Math.random() * 900)}`;
      this.userColor = options.userColor || localStorage.getItem('cc_usercolor') || null;
    } catch (e) {
      this.userName = `Artist ${Math.floor(100 + Math.random() * 900)}`;
      this.userColor = null;
    }

    this.setupSocketEvents();
  }

  setupSocketEvents() {
    this.socket.on('connect', () => {
      this.connected = true;
      console.log(`[WebSocket] Connected: ${this.socket.id}`);
      this.emitEvent('connected', { socketId: this.socket.id });

      // Join room with persistent userId
      this.socket.emit('room:join', {
        roomId: this.roomId,
        userName: this.userName,
        userColor: this.userColor,
        userId: this.userId
      });

      this.startLatencyPing();
    });

    this.socket.on('disconnect', (reason) => {
      this.connected = false;
      console.warn(`[WebSocket] Disconnected: ${reason}`);
      this.emitEvent('disconnected', { reason });
      this.stopLatencyPing();
    });

    this.socket.on('connect_error', (err) => {
      this.emitEvent('connectError', err);
    });

    // Room state initialization & snapshots
    this.socket.on('init:state', (data) => {
      if (data && data.user) {
        this.userId = data.user.userId;
        this.userName = data.user.userName;
        this.userColor = data.user.userColor;
        try {
          localStorage.setItem('cc_userid', this.userId);
          localStorage.setItem('cc_username', this.userName);
          localStorage.setItem('cc_usercolor', this.userColor);
        } catch (e) {}
      }
      this.emitEvent('initState', data);
    });

    // Real-time strokes
    this.socket.on('stroke:start', (data) => this.emitEvent('remoteStrokeStart', data));
    this.socket.on('stroke:points', (data) => this.emitEvent('remoteStrokePoints', data));
    this.socket.on('stroke:committed', (data) => this.emitEvent('strokeCommitted', data));
    this.socket.on('stroke:cancel', (data) => this.emitEvent('remoteStrokeCancel', data));

    // Peer cursors
    this.socket.on('cursor:update', (data) => this.emitEvent('cursorUpdate', data));
    this.socket.on('cursor:leave', (data) => this.emitEvent('cursorLeave', data));

    // History & Canvas
    this.socket.on('history:undone', (data) => this.emitEvent('historyUndone', data));
    this.socket.on('history:redone', (data) => this.emitEvent('historyRedone', data));
    this.socket.on('canvas:cleared', (data) => this.emitEvent('canvasCleared', data));

    // User presence
    this.socket.on('user:joined', (data) => this.emitEvent('userJoined', data));
    this.socket.on('user:left', (data) => this.emitEvent('userLeft', data));
    this.socket.on('room:users', (data) => this.emitEvent('usersUpdated', data));

    // Latency pong
    this.socket.on('latency:pong', (data) => {
      const now = Date.now();
      this.latencyMs = Math.max(1, now - (data ? data.clientTime : now));
      this.emitEvent('latencyUpdate', { latencyMs: this.latencyMs });
    });
  }

  startLatencyPing() {
    this.stopLatencyPing();
    this.pingTimer = setInterval(() => {
      if (this.socket && this.connected) {
        this.socket.emit('latency:ping', { clientTime: Date.now() });
      }
    }, 2500);
  }

  stopLatencyPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  sendStrokeStart(strokeData) {
    if (!this.connected || !strokeData) return;
    this.bufferOpId = strokeData.opId;
    this.pointsBuffer = [];
    this.socket.emit('stroke:start', strokeData);
  }

  sendStrokePoint(opId, point) {
    if (!this.connected || !point) return;

    if (this.bufferOpId !== opId) {
      this.flushPointsBuffer();
      this.bufferOpId = opId;
    }

    this.pointsBuffer.push(point);

    if (!this.flushTimeout) {
      this.flushTimeout = setTimeout(() => {
        this.flushPointsBuffer();
      }, this.BATCH_INTERVAL_MS);
    }
  }

  flushPointsBuffer() {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    if (this.pointsBuffer.length > 0 && this.bufferOpId && this.connected) {
      this.socket.emit('stroke:points', {
        opId: this.bufferOpId,
        points: this.pointsBuffer
      });
      this.pointsBuffer = [];
    }
  }

  sendStrokeEnd(strokeOperation) {
    if (!this.connected || !strokeOperation) return;
    this.flushPointsBuffer();
    this.socket.emit('stroke:end', strokeOperation);
  }

  sendStrokeCancel(opId) {
    if (!this.connected) return;
    this.flushPointsBuffer();
    this.socket.emit('stroke:cancel', { opId });
  }

  sendCursorMove(cursorData) {
    if (!this.connected || !cursorData) return;
    const now = performance.now();
    if (now - this.lastCursorEmit < this.CURSOR_THROTTLE_MS) return;

    this.lastCursorEmit = now;
    this.socket.emit('cursor:move', cursorData);
  }

  sendCursorLeave() {
    if (!this.connected) return;
    this.socket.emit('cursor:leave');
  }

  sendUndo(mode = 'global') {
    if (!this.connected) return;
    this.socket.emit('history:undo', { mode });
  }

  sendRedo(mode = 'global') {
    if (!this.connected) return;
    this.socket.emit('history:redo', { mode });
  }

  sendClearCanvas() {
    if (!this.connected) return;
    this.socket.emit('canvas:clear');
  }

  updateProfile(userName, userColor) {
    this.userName = userName;
    this.userColor = userColor;
    try {
      localStorage.setItem('cc_username', userName);
      localStorage.setItem('cc_usercolor', userColor);
    } catch (e) {}

    if (this.connected) {
      this.socket.emit('user:updateProfile', { userName, userColor });
    }
  }

  switchRoom(newRoomId) {
    if (!newRoomId || newRoomId === this.roomId) return;
    this.roomId = newRoomId.trim().toLowerCase();
    
    if (this.connected) {
      this.socket.emit('room:join', {
        roomId: this.roomId,
        userName: this.userName,
        userColor: this.userColor,
        userId: this.userId
      });
    }
  }
}
