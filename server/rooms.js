/**
 * rooms.js
 * 
 * Multi-room state and user presence management.
 * Tracks connected users, assigned distinct colors, cursor coordinates, and maps rooms to DrawingStates.
 * 
 * Hardened with:
 * - Persistent userId support across reconnects
 * - Safe cursor bounds sanitization
 * - Active stroke cleanup on user disconnect
 */

const DrawingState = require('./drawing-state');

const USER_COLORS = [
  '#ef4444', // Red
  '#3b82f6', // Blue
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#8b5cf6', // Violet
  '#ec4899', // Pink
  '#06b6d4', // Cyan
  '#84cc16', // Lime
  '#f97316', // Orange
  '#6366f1'  // Indigo
];

class RoomManager {
  constructor() {
    this.rooms = new Map();         // roomId -> RoomObject
    this.socketToRoom = new Map();  // socketId -> roomId
    this.socketToUser = new Map();  // socketId -> UserObject
    this.userToSocket = new Map();  // userId -> socketId (for reconnect tracking)
    this.colorIndex = 0;
  }

  getOrCreateRoom(roomId = 'main') {
    const cleanId = String(roomId || 'main').trim().toLowerCase().slice(0, 32) || 'main';

    if (!this.rooms.has(cleanId)) {
      this.rooms.set(cleanId, {
        id: cleanId,
        createdAt: Date.now(),
        drawingState: new DrawingState(cleanId),
        users: new Map() // socketId -> user
      });
    }

    return this.rooms.get(cleanId);
  }

  getNextColor() {
    const color = USER_COLORS[this.colorIndex % USER_COLORS.length];
    this.colorIndex += 1;
    return color;
  }

  addUser(roomId, socketId, options = {}) {
    const room = this.getOrCreateRoom(roomId);
    
    // If socket was already in another room, clean up first
    if (this.socketToRoom.has(socketId)) {
      this.removeUser(socketId);
    }

    const assignedColor = (typeof options.userColor === 'string' && options.userColor.startsWith('#'))
      ? options.userColor
      : this.getNextColor();

    const assignedName = (typeof options.userName === 'string' && options.userName.trim())
      ? options.userName.trim().slice(0, 24)
      : `Artist ${Math.floor(100 + Math.random() * 900)}`;

    const userId = (typeof options.userId === 'string' && options.userId.trim())
      ? options.userId.trim()
      : `usr_${Math.random().toString(36).slice(2, 9)}`;

    const user = {
      socketId,
      userId,
      userName: assignedName,
      userColor: assignedColor,
      cursor: { x: -1, y: -1, isDown: false, tool: 'brush' },
      joinedAt: Date.now()
    };

    room.users.set(socketId, user);
    this.socketToRoom.set(socketId, room.id);
    this.socketToUser.set(socketId, user);
    this.userToSocket.set(userId, socketId);

    return { room, user };
  }

  removeUser(socketId) {
    const roomId = this.socketToRoom.get(socketId);
    const user = this.socketToUser.get(socketId);

    if (roomId && this.rooms.has(roomId)) {
      const room = this.rooms.get(roomId);
      room.users.delete(socketId);

      // Clean up any abandoned in-flight strokes started by this user
      if (user && room.drawingState) {
        for (const [opId, stroke] of room.drawingState.activeStrokes.entries()) {
          if (stroke.userId === user.userId) {
            room.drawingState.cancelStroke(opId);
          }
        }
      }
    }

    if (user) {
      this.userToSocket.delete(user.userId);
    }
    this.socketToRoom.delete(socketId);
    this.socketToUser.delete(socketId);

    return { roomId, user };
  }

  updateCursor(socketId, cursorData = {}) {
    const user = this.socketToUser.get(socketId);
    if (!user || !cursorData) return null;

    const x = Number(cursorData.x);
    const y = Number(cursorData.y);

    user.cursor = {
      x: Number.isNaN(x) ? -1 : Math.round(x * 10) / 10,
      y: Number.isNaN(y) ? -1 : Math.round(y * 10) / 10,
      isDown: Boolean(cursorData.isDown),
      tool: typeof cursorData.tool === 'string' ? cursorData.tool : user.cursor.tool
    };

    return user;
  }

  updateProfile(socketId, { userName, userColor } = {}) {
    const user = this.socketToUser.get(socketId);
    if (!user) return null;

    if (userName && typeof userName === 'string') {
      user.userName = userName.trim().slice(0, 24);
    }
    if (userColor && typeof userColor === 'string' && userColor.startsWith('#')) {
      user.userColor = userColor.slice(0, 16);
    }

    return user;
  }

  getUser(socketId) {
    return this.socketToUser.get(socketId) || null;
  }

  getRoomUsers(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.users.values()).map(u => ({
      userId: u.userId,
      userName: u.userName,
      userColor: u.userColor,
      cursor: u.cursor
    }));
  }

  getDrawingState(roomId) {
    const room = this.rooms.get(roomId);
    return room ? room.drawingState : null;
  }
}

module.exports = RoomManager;
