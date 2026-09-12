/**
 * rooms.js
 * 
 * Multi-room state and user presence management.
 * Tracks connected users, assigned distinct colors, cursor coordinates, and maps rooms to DrawingStates.
 */

const DrawingState = require('./drawing-state');

// Distinct, vibrant color palette for users
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
    // Map of roomId -> RoomObject
    this.rooms = new Map();
    
    // Reverse lookup: socketId -> roomId
    this.socketToRoom = new Map();

    // User lookup: socketId -> UserObject
    this.socketToUser = new Map();

    this.colorIndex = 0;
  }

  /**
   * Get an existing room or create a new room with its own DrawingState.
   */
  getOrCreateRoom(roomId = 'main') {
    const cleanId = String(roomId).trim().toLowerCase() || 'main';

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

  /**
   * Generate next distinct color for user.
   */
  getNextColor() {
    const color = USER_COLORS[this.colorIndex % USER_COLORS.length];
    this.colorIndex += 1;
    return color;
  }

  /**
   * Add a connected user to a room.
   */
  addUser(roomId, socketId, options = {}) {
    const room = this.getOrCreateRoom(roomId);
    
    // If socket was in another room, leave it first
    if (this.socketToRoom.has(socketId)) {
      this.removeUser(socketId);
    }

    const assignedColor = options.userColor || this.getNextColor();
    const assignedName = options.userName || `Artist ${Math.floor(100 + Math.random() * 900)}`;

    const user = {
      socketId,
      userId: options.userId || `usr_${Math.random().toString(36).slice(2, 9)}`,
      userName: assignedName,
      userColor: assignedColor,
      cursor: { x: -1, y: -1, isDown: false, tool: 'brush' },
      joinedAt: Date.now()
    };

    room.users.set(socketId, user);
    this.socketToRoom.set(socketId, room.id);
    this.socketToUser.set(socketId, user);

    return { room, user };
  }

  /**
   * Remove a user when disconnecting or switching rooms.
   */
  removeUser(socketId) {
    const roomId = this.socketToRoom.get(socketId);
    const user = this.socketToUser.get(socketId);

    if (roomId && this.rooms.has(roomId)) {
      const room = this.rooms.get(roomId);
      room.users.delete(socketId);

      // Clean up empty non-main rooms if empty for over 10 minutes (optional)
      if (room.users.size === 0 && room.id !== 'main') {
        // Can be kept in memory or pruned
      }
    }

    this.socketToRoom.delete(socketId);
    this.socketToUser.delete(socketId);

    return { roomId, user };
  }

  /**
   * Update a user's cursor position and drawing state.
   */
  updateCursor(socketId, cursorData) {
    const user = this.socketToUser.get(socketId);
    if (!user) return null;

    user.cursor = {
      x: cursorData.x,
      y: cursorData.y,
      isDown: !!cursorData.isDown,
      tool: cursorData.tool || user.cursor.tool
    };

    return user;
  }

  /**
   * Update user's profile display name or color.
   */
  updateProfile(socketId, { userName, userColor }) {
    const user = this.socketToUser.get(socketId);
    if (!user) return null;

    if (userName && typeof userName === 'string') {
      user.userName = userName.trim().slice(0, 24);
    }
    if (userColor && typeof userColor === 'string') {
      user.userColor = userColor;
    }

    return user;
  }

  /**
   * Get user by socket ID.
   */
  getUser(socketId) {
    return this.socketToUser.get(socketId) || null;
  }

  /**
   * Get list of active users in a room.
   */
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

  /**
   * Get drawing state for a room.
   */
  getDrawingState(roomId) {
    const room = this.rooms.get(roomId);
    return room ? room.drawingState : null;
  }
}

module.exports = RoomManager;
