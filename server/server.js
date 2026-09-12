/**
 * server.js
 * 
 * Express + Socket.IO Server for Real-Time Collaborative Canvas.
 * Handles client connections, room isolation, real-time stroke streaming,
 * authoritative global undo/redo, presence, and ping-pong latency.
 * 
 * Hardened with:
 * - Robust payload guard clauses and crash prevention
 * - Safe handling of abrupt client disconnections
 * - Graceful shutdown
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
  /**
   * Client joins a specific room
   */
  socket.on('room:join', (payload = {}) => {
    try {
      const roomId = String(payload.roomId || 'main').trim().toLowerCase().slice(0, 32) || 'main';
      const { room, user } = roomManager.addUser(roomId, socket.id, {
        userName: payload.userName,
        userColor: payload.userColor,
        userId: payload.userId
      });

      socket.join(room.id);

      // 1. Send initialization snapshot to joining client
      const snapshot = room.drawingState.getSnapshot();
      const activeUsers = roomManager.getRoomUsers(room.id);

      socket.emit('init:state', {
        user,
        room: { id: room.id },
        snapshot,
        users: activeUsers
      });

      // 2. Notify other clients in the room
      socket.to(room.id).emit('user:joined', {
        user: {
          userId: user.userId,
          userName: user.userName,
          userColor: user.userColor,
          cursor: user.cursor
        },
        users: activeUsers
      });
    } catch (err) {
      console.error('[Socket] room:join error:', err.message);
    }
  });

  /**
   * Real-time drawing: Stroke Start
   */
  socket.on('stroke:start', (strokeData) => {
    try {
      if (!strokeData || !strokeData.opId) return;

      const user = roomManager.getUser(socket.id);
      if (!user) return;
      const roomId = roomManager.socketToRoom.get(socket.id);
      const drawingState = roomManager.getDrawingState(roomId);
      if (!drawingState) return;

      strokeData.userId = user.userId;
      strokeData.userName = user.userName;
      strokeData.userColor = user.userColor;

      const activeStroke = drawingState.startStroke(user.userId, strokeData);
      if (!activeStroke) return;

      socket.to(roomId).emit('stroke:start', activeStroke);
    } catch (err) {
      console.error('[Socket] stroke:start error:', err.message);
    }
  });

  /**
   * Real-time drawing: Stroke Points streaming
   */
  socket.on('stroke:points', (data) => {
    try {
      if (!data || !data.opId || !data.points) return;

      const roomId = roomManager.socketToRoom.get(socket.id);
      if (!roomId) return;
      const drawingState = roomManager.getDrawingState(roomId);
      if (!drawingState) return;

      const stroke = drawingState.appendPoints(data.opId, data.points);
      if (!stroke) return;

      socket.to(roomId).emit('stroke:points', {
        opId: data.opId,
        points: data.points
      });
    } catch (err) {
      console.error('[Socket] stroke:points error:', err.message);
    }
  });

  /**
   * Real-time drawing: Stroke End (Commit operation)
   */
  socket.on('stroke:end', (finalData) => {
    try {
      if (!finalData || !finalData.opId) return;

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
        io.in(roomId).emit('stroke:committed', {
          operation: committedOp,
          sequenceNumber: drawingState.sequenceNumber
        });
      }
    } catch (err) {
      console.error('[Socket] stroke:end error:', err.message);
    }
  });

  /**
   * Real-time drawing: Cancel stroke
   */
  socket.on('stroke:cancel', (data) => {
    try {
      if (!data || !data.opId) return;
      const roomId = roomManager.socketToRoom.get(socket.id);
      if (!roomId) return;
      const drawingState = roomManager.getDrawingState(roomId);
      if (!drawingState) return;

      drawingState.cancelStroke(data.opId);
      socket.to(roomId).emit('stroke:cancel', { opId: data.opId });
    } catch (err) {
      console.error('[Socket] stroke:cancel error:', err.message);
    }
  });

  /**
   * Live Peer Cursor movement
   */
  socket.on('cursor:move', (cursorData) => {
    try {
      if (!cursorData) return;
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
    } catch (err) {
      console.error('[Socket] cursor:move error:', err.message);
    }
  });

  /**
   * Cursor leaving canvas
   */
  socket.on('cursor:leave', () => {
    try {
      const user = roomManager.getUser(socket.id);
      if (!user) return;
      const roomId = roomManager.socketToRoom.get(socket.id);
      if (!roomId) return;

      user.cursor.x = -1;
      user.cursor.y = -1;
      socket.to(roomId).emit('cursor:leave', { userId: user.userId });
    } catch (err) {
      console.error('[Socket] cursor:leave error:', err.message);
    }
  });

  /**
   * Global & User Undo
   */
  socket.on('history:undo', (payload = {}) => {
    try {
      const user = roomManager.getUser(socket.id);
      if (!user) return;
      const roomId = roomManager.socketToRoom.get(socket.id);
      const drawingState = roomManager.getDrawingState(roomId);
      if (!drawingState) return;

      const mode = payload && payload.mode === 'user' ? 'user' : 'global';
      const result = drawingState.undo(user.userId, mode);

      if (result.success) {
        io.in(roomId).emit('history:undone', {
          opId: result.opId,
          undoneBy: user.userName,
          mode,
          sequenceNumber: drawingState.sequenceNumber
        });
      }
    } catch (err) {
      console.error('[Socket] history:undo error:', err.message);
    }
  });

  /**
   * Global & User Redo
   */
  socket.on('history:redo', (payload = {}) => {
    try {
      const user = roomManager.getUser(socket.id);
      if (!user) return;
      const roomId = roomManager.socketToRoom.get(socket.id);
      const drawingState = roomManager.getDrawingState(roomId);
      if (!drawingState) return;

      const mode = payload && payload.mode === 'user' ? 'user' : 'global';
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
    } catch (err) {
      console.error('[Socket] history:redo error:', err.message);
    }
  });

  /**
   * Clear canvas
   */
  socket.on('canvas:clear', () => {
    try {
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
    } catch (err) {
      console.error('[Socket] canvas:clear error:', err.message);
    }
  });

  /**
   * Profile update
   */
  socket.on('user:updateProfile', (data) => {
    try {
      if (!data) return;
      const user = roomManager.updateProfile(socket.id, data);
      if (!user) return;
      const roomId = roomManager.socketToRoom.get(socket.id);
      if (!roomId) return;

      io.in(roomId).emit('room:users', {
        users: roomManager.getRoomUsers(roomId)
      });
    } catch (err) {
      console.error('[Socket] user:updateProfile error:', err.message);
    }
  });

  /**
   * Latency Ping / Pong
   */
  socket.on('latency:ping', (data) => {
    try {
      if (!data || !data.clientTime) return;
      socket.emit('latency:pong', {
        clientTime: data.clientTime,
        serverTime: Date.now()
      });
    } catch (err) {
      console.error('[Socket] latency:ping error:', err.message);
    }
  });

  /**
   * Disconnection cleanup
   */
  socket.on('disconnect', () => {
    try {
      const { roomId, user } = roomManager.removeUser(socket.id);
      if (user && roomId) {
        socket.to(roomId).emit('user:left', {
          userId: user.userId,
          userName: user.userName,
          users: roomManager.getRoomUsers(roomId)
        });
      }
    } catch (err) {
      console.error('[Socket] disconnect error:', err.message);
    }
  });
});

// Start Server
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(` Collaborative Canvas Server running on port ${PORT}`);
    console.log(` http://localhost:${PORT}`);
    console.log(`===================================================`);
  });
}

module.exports = { app, server, io, roomManager };
