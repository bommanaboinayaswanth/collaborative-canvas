/**
 * websocket.js
 * 
 * WebSocket / Socket.IO Client Adapter.
 * Handles bidirectional real-time communication:
 * - Connection lifecycle & reconnection
 * - Point batching / streaming with frame throttling
 * - Peer cursor synchronization
 * - Latency RTT measurement
 * - Event dispatching to application logic
 */

export class WebSocketClient {
  constructor() {
    this.socket = null;
    this.connected = false;
    this.userId = null;
    this.userName = null;
    this.userColor = null;
    this.roomId = 'main';

    // Point stream batching buffer
    this.pointsBuffer = [];
    this.bufferOpId = null;
    this.flushTimeout = null;
    this.BATCH_INTERVAL_MS = 16; // ~60 Hz batch rate

    // Cursor throttling
    this.lastCursorEmit = 0;
    this.CURSOR_THROTTLE_MS = 35; // ~30 Hz cursor update rate

    // Latency measurement
    this.latencyMs = 0;
    this.pingTimer = null;

    // Listeners
    this.listeners = new Map();
  }

  /**
   * Register event listener.
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  /**
   * Emit internal application event.
   */
  emitEvent(event, data) {
    const list = this.listeners.get(event);
    if (list) {
      list.forEach(cb => cb(data));
    }
  }

  /**
   * Connect to Socket.IO server.
   */
  connect(options = {}) {
    // Uses global `io` loaded via /socket.io/socket.io.js
    if (typeof io === 'undefined') {
      console.error('[WebSocket] Socket.io client library not found.');
      return;
    }

    this.socket = io({
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });

    this.roomId = options.roomId || 'main';
    this.userName = options.userName || localStorage.getItem('cc_username') || `Artist ${Math.floor(100 + Math.random() * 900)}`;
    this.userColor = options.userColor || localStorage.getItem('cc_usercolor') || null;

    this.setupSocketEvents();
  }

  setupSocketEvents() {
    this.socket.on('connect', () => {
      this.connected = true;
      console.log(`[WebSocket] Connected with socket ID: ${this.socket.id}`);
      this.emitEvent('connected', { socketId: this.socket.id });

      // Join room
      this.socket.emit('room:join', {
        roomId: this.roomId,
        userName: this.userName,
        userColor: this.userColor
      });

      // Start latency ping loop
      this.startLatencyPing();
    });

    this.socket.on('disconnect', (reason) => {
      this.connected = false;
      console.warn(`[WebSocket] Disconnected: ${reason}`);
      this.emitEvent('disconnected', { reason });
      this.stopLatencyPing();
    });

    // Room state initialization
    this.socket.on('init:state', (data) => {
      this.userId = data.user.userId;
      this.userName = data.user.userName;
      this.userColor = data.user.userColor;
      this.emitEvent('initState', data);
    });

    // Stroke events
    this.socket.on('stroke:start', (data) => this.emitEvent('remoteStrokeStart', data));
    this.socket.on('stroke:points', (data) => this.emitEvent('remoteStrokePoints', data));
    this.socket.on('stroke:committed', (data) => this.emitEvent('strokeCommitted', data));
    this.socket.on('stroke:cancel', (data) => this.emitEvent('remoteStrokeCancel', data));

    // Cursor events
    this.socket.on('cursor:update', (data) => this.emitEvent('cursorUpdate', data));
    this.socket.on('cursor:leave', (data) => this.emitEvent('cursorLeave', data));

    // History & Canvas events
    this.socket.on('history:undone', (data) => this.emitEvent('historyUndone', data));
    this.socket.on('history:redone', (data) => this.emitEvent('historyRedone', data));
    this.socket.on('canvas:cleared', (data) => this.emitEvent('canvasCleared', data));

    // User Presence events
    this.socket.on('user:joined', (data) => this.emitEvent('userJoined', data));
    this.socket.on('user:left', (data) => this.emitEvent('userLeft', data));
    this.socket.on('room:users', (data) => this.emitEvent('usersUpdated', data));

    // Latency pong
    this.socket.on('latency:pong', (data) => {
      const now = Date.now();
      this.latencyMs = Math.max(1, now - data.clientTime);
      this.emitEvent('latencyUpdate', { latencyMs: this.latencyMs });
    });
  }

  /**
   * Start 3-second ping interval for network latency monitor.
   */
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

  /**
   * Send stroke start immediately.
   */
  sendStrokeStart(strokeData) {
    if (!this.connected) return;
    this.bufferOpId = strokeData.opId;
    this.pointsBuffer = [];
    this.socket.emit('stroke:start', strokeData);
  }

  /**
   * Buffer and throttle point streaming (~60Hz).
   */
  sendStrokePoint(opId, point) {
    if (!this.connected) return;

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

  /**
   * Flush pending points buffer.
   */
  flushPointsBuffer() {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    if (this.pointsBuffer.length > 0 && this.bufferOpId) {
      this.socket.emit('stroke:points', {
        opId: this.bufferOpId,
        points: this.pointsBuffer
      });
      this.pointsBuffer = [];
    }
  }

  /**
   * Finalize and commit stroke operation.
   */
  sendStrokeEnd(strokeOperation) {
    if (!this.connected) return;
    this.flushPointsBuffer();
    this.socket.emit('stroke:end', strokeOperation);
  }

  /**
   * Cancel in-flight stroke.
   */
  sendStrokeCancel(opId) {
    if (!this.connected) return;
    this.flushPointsBuffer();
    this.socket.emit('stroke:cancel', { opId });
  }

  /**
   * Send peer cursor coordinates with throttle (~30Hz).
   */
  sendCursorMove(cursorData) {
    if (!this.connected) return;
    const now = performance.now();
    if (now - this.lastCursorEmit < this.CURSOR_THROTTLE_MS) return;

    this.lastCursorEmit = now;
    this.socket.emit('cursor:move', cursorData);
  }

  sendCursorLeave() {
    if (!this.connected) return;
    this.socket.emit('cursor:leave');
  }

  /**
   * Request Undo.
   */
  sendUndo(mode = 'global') {
    if (!this.connected) return;
    this.socket.emit('history:undo', { mode });
  }

  /**
   * Request Redo.
   */
  sendRedo(mode = 'global') {
    if (!this.connected) return;
    this.socket.emit('history:redo', { mode });
  }

  /**
   * Request Clear Canvas.
   */
  sendClearCanvas() {
    if (!this.connected) return;
    this.socket.emit('canvas:clear');
  }

  /**
   * Update Profile (Username or Color).
   */
  updateProfile(userName, userColor) {
    this.userName = userName;
    this.userColor = userColor;
    localStorage.setItem('cc_username', userName);
    localStorage.setItem('cc_usercolor', userColor);

    if (this.connected) {
      this.socket.emit('user:updateProfile', { userName, userColor });
    }
  }

  /**
   * Change Room.
   */
  switchRoom(newRoomId) {
    if (!newRoomId || newRoomId === this.roomId) return;
    this.roomId = newRoomId.trim().toLowerCase();
    
    if (this.connected) {
      this.socket.emit('room:join', {
        roomId: this.roomId,
        userName: this.userName,
        userColor: this.userColor
      });
    }
  }
}
