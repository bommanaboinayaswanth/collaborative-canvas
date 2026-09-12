/**
 * server.js
 * 
 * Express + Socket.IO Server for Real-Time Collaborative Canvas.
 * Handles client connections, room isolation, real-time stroke streaming,
 * authoritative global undo/redo, presence, and ping-pong latency.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const RoomManager = require('./rooms');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingInterval: 10000,
  pingTimeout: 5000
});

const PORT = process.env.PORT || 3000;
const roomManager = new RoomManager();

// Serve static client assets
app.use(express.static(path.join(__dirname, '../client')));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    activeRooms: roomManager.rooms.size,
    timestamp: Date.now()
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  /**
   * Client joins a specific room
   */
  socket.on('room:join', (payload = {}) => {
    const roomId = (payload.roomId || 'main').trim().toLowerCase();
    const { room, user } = roomManager.addUser(roomId, socket.id, {
      userName: payload.userName,
      userColor: payload.userColor,
      userId: payload.userId
    });

    socket.join(room.id);
    console.log(`[Room] ${user.userName} (${user.userId}) joined room: ${room.id}`);

    // 1. Send initialization payload to the joining client
    const snapshot = room.drawingState.getSnapshot();
    const activeUsers = roomManager.getRoomUsers(room.id);

    socket.emit('init:state', {
      user,
      room: { id: room.id },
      snapshot,
      users: activeUsers
    });

    // 2. Notify other clients in the room about the new user
    socket.to(room.id).emit('user:joined', {
      user: {
        userId: user.userId,
        userName: user.userName,
        userColor: user.userColor,
        cursor: user.cursor
      },
      users: activeUsers
    });
  });

  /**
   * Real-time drawing: Stroke Start
   */
  socket.on('stroke:start', (strokeData) => {
    const user = roomManager.getUser(socket.id);
    if (!user) return;
    const roomId = roomManager.socketToRoom.get(socket.id);
    const drawingState = roomManager.getDrawingState(roomId);
    if (!drawingState) return;

    // Attach verified user identity
    strokeData.userId = user.userId;
    strokeData.userName = user.userName;
    strokeData.userColor = user.userColor;

    drawingState.startStroke(user.userId, strokeData);

    // Stream immediately to all peers in the room
    socket.to(roomId).emit('stroke:start', strokeData);
  });

  /**
   * Real-time drawing: Stroke Points streaming
   */
  socket.on('stroke:points', (data) => {
    const roomId = roomManager.socketToRoom.get(socket.id);
    if (!roomId) return;
    const drawingState = roomManager.getDrawingState(roomId);
    if (!drawingState) return;

    drawingState.appendPoints(data.opId, data.points);

    // Stream chunk to all peers
    socket.to(roomId).emit('stroke:points', {
      opId: data.opId,
      points: data.points
    });
  });

  /**
   * Real-time drawing: Stroke End (Commit operation)
   */
  socket.on('stroke:end', (finalData) => {
    const user = roomManager.getUser(socket.id);
    if (!user) return;
    const roomId = roomManager.socketToRoom.get(socket.id);
    const drawingState = roomManager.getDrawingState(roomId);
    if (!drawingState) return;

    finalData.userId = user.userId;
    finalData.userName = user.userName;
    finalData.userColor = user.userColor;

    const committedOp = drawingState.endStroke(finalData.opId, finalData);

    if (committedOp) {
      // Broadcast committed operation with sequence number to all clients (including sender)
      io.in(roomId).emit('stroke:committed', {
        operation: committedOp,
        sequenceNumber: drawingState.sequenceNumber
      });
    }
  });

  /**
   * Real-time drawing: Cancel stroke
   */
  socket.on('stroke:cancel', (data) => {
    const roomId = roomManager.socketToRoom.get(socket.id);
    if (!roomId) return;
    const drawingState = roomManager.getDrawingState(roomId);
    if (!drawingState) return;

    drawingState.cancelStroke(data.opId);
    socket.to(roomId).emit('stroke:cancel', { opId: data.opId });
  });

  /**
   * Live Peer Cursor movement
   */
  socket.on('cursor:move', (cursorData) => {
    const user = roomManager.updateCursor(socket.id, cursorData);
    if (!user) return;
    const roomId = roomManager.socketToRoom.get(socket.id);
    if (!roomId) return;

    socket.to(roomId).emit('cursor:update', {
      userId: user.userId,
      userName: user.userName,
      userColor: user.userColor,
      cursor: user.cursor
    });
  });

  /**
   * Cursor leaving canvas
   */
  socket.on('cursor:leave', () => {
    const user = roomManager.getUser(socket.id);
    if (!user) return;
    const roomId = roomManager.socketToRoom.get(socket.id);
    if (!roomId) return;

    user.cursor.x = -1;
    user.cursor.y = -1;
    socket.to(roomId).emit('cursor:leave', { userId: user.userId });
  });

  /**
   * Global & User Undo
   */
  socket.on('history:undo', (payload = {}) => {
    const user = roomManager.getUser(socket.id);
    if (!user) return;
    const roomId = roomManager.socketToRoom.get(socket.id);
    const drawingState = roomManager.getDrawingState(roomId);
    if (!drawingState) return;

    const mode = payload.mode || 'global';
    const result = drawingState.undo(user.userId, mode);

    if (result.success) {
      io.in(roomId).emit('history:undone', {
        opId: result.opId,
        undoneBy: user.userName,
        mode,
        sequenceNumber: drawingState.sequenceNumber
      });
    }
  });

  /**
   * Global & User Redo
   */
  socket.on('history:redo', (payload = {}) => {
    const user = roomManager.getUser(socket.id);
    if (!user) return;
    const roomId = roomManager.socketToRoom.get(socket.id);
    const drawingState = roomManager.getDrawingState(roomId);
    if (!drawingState) return;

    const mode = payload.mode || 'global';
    const result = drawingState.redo(user.userId, mode);

    if (result.success) {
      io.in(roomId).emit('history:redone', {
        opId: result.opId,
        operation: result.operation,
        redoneBy: user.userName,
        mode,
        sequenceNumber: drawingState.sequenceNumber
      });
    }
  });

  /**
   * Clear canvas
   */
  socket.on('canvas:clear', () => {
    const user = roomManager.getUser(socket.id);
    if (!user) return;
    const roomId = roomManager.socketToRoom.get(socket.id);
    const drawingState = roomManager.getDrawingState(roomId);
    if (!drawingState) return;

    const clearOp = drawingState.clearCanvas(user.userId, user.userName);

    io.in(roomId).emit('canvas:cleared', {
      operation: clearOp,
      clearedBy: user.userName,
      sequenceNumber: drawingState.sequenceNumber
    });
  });

  /**
   * Profile update (username or color)
   */
  socket.on('user:updateProfile', (data) => {
    const user = roomManager.updateProfile(socket.id, data);
    if (!user) return;
    const roomId = roomManager.socketToRoom.get(socket.id);
    if (!roomId) return;

    io.in(roomId).emit('room:users', {
      users: roomManager.getRoomUsers(roomId)
    });
  });

  /**
   * Latency Ping / Pong
   */
  socket.on('latency:ping', (data) => {
    socket.emit('latency:pong', {
      clientTime: data.clientTime,
      serverTime: Date.now()
    });
  });

  /**
   * Disconnection cleanup
   */
  socket.on('disconnect', () => {
    const { roomId, user } = roomManager.removeUser(socket.id);
    if (user && roomId) {
      console.log(`[Socket] Disconnected: ${user.userName} from room ${roomId}`);

      // Broadcast user leave
      socket.to(roomId).emit('user:left', {
        userId: user.userId,
        userName: user.userName,
        users: roomManager.getRoomUsers(roomId)
      });
    }
  });
});

// Start Server
server.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(` Collaborative Canvas Server running on port ${PORT}`);
  console.log(` http://localhost:${PORT}`);
  console.log(`===================================================`);
});
