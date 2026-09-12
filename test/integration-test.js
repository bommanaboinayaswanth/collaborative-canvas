/**
 * integration-test.js
 * 
 * Multi-user automated integration test suite for real-time collaborative canvas.
 * Simulates multiple WebSocket clients simultaneously connecting, streaming strokes,
 * executing global undo/redo, conflict resolution, and verifying late-joiner synchronization.
 */

const { io } = require('socket.io-client');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const RoomManager = require('../server/rooms');

const TEST_PORT = 4055;
const SERVER_URL = `http://localhost:${TEST_PORT}`;

// Create dedicated test server
const app = express();
const server = http.createServer(app);
const serverIo = new Server(server, { cors: { origin: '*' } });
const roomManager = new RoomManager();

// Setup server handlers identical to server.js
serverIo.on('connection', (socket) => {
  socket.on('room:join', (payload = {}) => {
    const roomId = (payload.roomId || 'main').trim().toLowerCase();
    const { room, user } = roomManager.addUser(roomId, socket.id, {
      userName: payload.userName,
      userColor: payload.userColor,
      userId: payload.userId
    });

    socket.join(room.id);
    const snapshot = room.drawingState.getSnapshot();
    const activeUsers = roomManager.getRoomUsers(room.id);

    socket.emit('init:state', { user, room: { id: room.id }, snapshot, users: activeUsers });
    socket.to(room.id).emit('user:joined', { user, users: activeUsers });
  });

  socket.on('stroke:start', (strokeData) => {
    const user = roomManager.getUser(socket.id);
    if (!user) return;
    const roomId = roomManager.socketToRoom.get(socket.id);
    const drawingState = roomManager.getDrawingState(roomId);
    strokeData.userId = user.userId;
    drawingState.startStroke(user.userId, strokeData);
    socket.to(roomId).emit('stroke:start', strokeData);
  });

  socket.on('stroke:points', (data) => {
    const roomId = roomManager.socketToRoom.get(socket.id);
    const drawingState = roomManager.getDrawingState(roomId);
    drawingState.appendPoints(data.opId, data.points);
    socket.to(roomId).emit('stroke:points', data);
  });

  socket.on('stroke:end', (finalData) => {
    const user = roomManager.getUser(socket.id);
    if (!user) return;
    const roomId = roomManager.socketToRoom.get(socket.id);
    const drawingState = roomManager.getDrawingState(roomId);
    finalData.userId = user.userId;
    const committedOp = drawingState.endStroke(finalData.opId, finalData);
    serverIo.in(roomId).emit('stroke:committed', {
      operation: committedOp,
      sequenceNumber: drawingState.sequenceNumber
    });
  });

  socket.on('history:undo', (payload = {}) => {
    const user = roomManager.getUser(socket.id);
    const roomId = roomManager.socketToRoom.get(socket.id);
    const drawingState = roomManager.getDrawingState(roomId);
    const result = drawingState.undo(user.userId, payload.mode || 'global');
    if (result.success) {
      serverIo.in(roomId).emit('history:undone', {
        opId: result.opId,
        undoneBy: user.userName,
        sequenceNumber: drawingState.sequenceNumber
      });
    }
  });

  socket.on('history:redo', (payload = {}) => {
    const user = roomManager.getUser(socket.id);
    const roomId = roomManager.socketToRoom.get(socket.id);
    const drawingState = roomManager.getDrawingState(roomId);
    const result = drawingState.redo(user.userId, payload.mode || 'global');
    if (result.success) {
      serverIo.in(roomId).emit('history:redone', {
        opId: result.opId,
        operation: result.operation,
        redoneBy: user.userName,
        sequenceNumber: drawingState.sequenceNumber
      });
    }
  });

  socket.on('cursor:move', (cursorData) => {
    const user = roomManager.updateCursor(socket.id, cursorData);
    const roomId = roomManager.socketToRoom.get(socket.id);
    socket.to(roomId).emit('cursor:update', {
      userId: user.userId,
      userName: user.userName,
      cursor: user.cursor
    });
  });
});

async function runIntegrationTests() {
  console.log('🚀 Starting Integration Tests for Real-Time Canvas...\n');

  // Start test server
  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  console.log(`[Test Server] Listening on ${SERVER_URL}`);

  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      failed++;
    }
  }

  try {
    // -------------------------------------------------------------
    // Test 1: Connect Alice and Bob to room 'test-room'
    // -------------------------------------------------------------
    console.log('\n--- 1. Testing Multi-User Connection & Presence ---');
    const clientAlice = io(SERVER_URL);
    const clientBob = io(SERVER_URL);

    const aliceInitPromise = new Promise((resolve) => {
      clientAlice.on('init:state', (data) => resolve(data));
    });

    const bobJoinedPromise = new Promise((resolve) => {
      clientAlice.on('user:joined', (data) => resolve(data));
    });

    clientAlice.emit('room:join', { roomId: 'test-room', userName: 'Alice', userColor: '#ef4444' });
    const aliceInit = await aliceInitPromise;
    assert(aliceInit.room.id === 'test-room', 'Alice joined test-room');
    assert(aliceInit.user.userName === 'Alice', 'Alice received verified identity');

    clientBob.emit('room:join', { roomId: 'test-room', userName: 'Bob', userColor: '#3b82f6' });
    const bobPresence = await bobJoinedPromise;
    assert(bobPresence.user.userName === 'Bob', 'Alice notified when Bob joined');

    // -------------------------------------------------------------
    // Test 2: Real-time stroke streaming from Alice to Bob
    // -------------------------------------------------------------
    console.log('\n--- 2. Testing Real-time Stroke Streaming ---');
    const opId1 = 'stroke_alice_001';

    const bobReceivedStartPromise = new Promise((resolve) => {
      clientBob.on('stroke:start', (data) => resolve(data));
    });

    const bobReceivedPointsPromise = new Promise((resolve) => {
      clientBob.on('stroke:points', (data) => resolve(data));
    });

    const committedPromise = new Promise((resolve) => {
      clientBob.on('stroke:committed', (data) => resolve(data));
    });

    // Alice starts stroke
    clientAlice.emit('stroke:start', {
      opId: opId1,
      tool: 'brush',
      color: '#ef4444',
      width: 6,
      point: { x: 100, y: 100 }
    });

    const receivedStart = await bobReceivedStartPromise;
    assert(receivedStart.opId === opId1 && receivedStart.point.x === 100, 'Bob received stroke:start in real-time');

    // Alice streams point chunk
    clientAlice.emit('stroke:points', {
      opId: opId1,
      points: [{ x: 105, y: 105 }, { x: 110, y: 110 }]
    });

    const receivedPoints = await bobReceivedPointsPromise;
    assert(receivedPoints.points.length === 2, 'Bob received stroke:points batch');

    // Alice finishes stroke
    clientAlice.emit('stroke:end', {
      opId: opId1,
      points: [{ x: 100, y: 100 }, { x: 105, y: 105 }, { x: 110, y: 110 }, { x: 120, y: 120 }]
    });

    const commitResult = await committedPromise;
    assert(commitResult.operation.id === opId1, 'Stroke successfully committed to room operation log');
    assert(commitResult.sequenceNumber === 1, 'Sequence number 1 monotonically assigned');

    // -------------------------------------------------------------
    // Test 3: Bob draws a shape (Rectangle)
    // -------------------------------------------------------------
    console.log('\n--- 3. Testing Shape Operations ---');
    const opId2 = 'shape_bob_002';
    const aliceReceivedCommitPromise = new Promise((resolve) => {
      clientAlice.on('stroke:committed', (data) => resolve(data));
    });

    clientBob.emit('stroke:end', {
      opId: opId2,
      tool: 'rectangle',
      color: '#3b82f6',
      width: 4,
      startPoint: { x: 200, y: 200 },
      endPoint: { x: 400, y: 350 }
    });

    const shapeCommit = await aliceReceivedCommitPromise;
    assert(shapeCommit.operation.id === opId2, 'Bob rectangle committed');
    assert(shapeCommit.sequenceNumber === 2, 'Sequence number monotonically incremented to 2');

    // -------------------------------------------------------------
    // Test 4: Global Undo (User A undoes User B's action)
    // -------------------------------------------------------------
    console.log('\n--- 4. Testing Global Undo/Redo Conflict Semantics ---');
    const bobUndoPromise = new Promise((resolve) => {
      clientBob.on('history:undone', (data) => resolve(data));
    });

    // Alice triggers Global Undo
    clientAlice.emit('history:undo', { mode: 'global' });
    const undoEvent = await bobUndoPromise;
    assert(undoEvent.opId === opId2, 'Global undo targeted the latest committed action (Bob rectangle)');

    // -------------------------------------------------------------
    // Test 5: Global Redo (Restores the undone operation)
    // -------------------------------------------------------------
    console.log('\n--- 5. Testing Global Redo ---');
    const bobRedoPromise = new Promise((resolve) => {
      clientBob.on('history:redone', (data) => resolve(data));
    });

    clientAlice.emit('history:redo', { mode: 'global' });
    const redoEvent = await bobRedoPromise;
    assert(redoEvent.opId === opId2, 'Global redo restored Bob rectangle');

    // -------------------------------------------------------------
    // Test 6: Late Joiner Synchronization
    // -------------------------------------------------------------
    console.log('\n--- 6. Testing Late Joiner Synchronization ---');
    const clientCharlie = io(SERVER_URL);
    const charlieInitPromise = new Promise((resolve) => {
      clientCharlie.on('init:state', (data) => resolve(data));
    });

    clientCharlie.emit('room:join', { roomId: 'test-room', userName: 'Charlie' });
    const charlieInit = await charlieInitPromise;
    assert(charlieInit.snapshot.operations.length === 2, 'Charlie received all 2 committed operations');
    assert(charlieInit.users.length === 3, 'Charlie sees all 3 users currently online');

    // Cleanup
    clientAlice.disconnect();
    clientBob.disconnect();
    clientCharlie.disconnect();

  } catch (err) {
    console.error('Unexpected test error:', err);
    failed++;
  } finally {
    server.close();
    console.log(`\n===================================================`);
    console.log(` Test Summary: ${passed} passed, ${failed} failed`);
    console.log(`===================================================\n`);
    process.exit(failed === 0 ? 0 : 1);
  }
}

runIntegrationTests();
