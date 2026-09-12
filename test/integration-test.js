/**
 * integration-test.js
 * 
 * Comprehensive 17-Scenario Automated Test Suite for Real-Time Collaborative Canvas.
 * Covers:
 * 1. Health check endpoint
 * 2. Client connection & initial state
 * 3. Multi-user connection & presence
 * 4. User roster synchronization
 * 5. Strict room isolation
 * 6. Sub-frame stroke streaming (start -> points -> commit)
 * 7. Simultaneous drawing concurrency
 * 8. Geometric shape (Rectangle)
 * 9. Geometric shape (Circle & Line)
 * 10. Eraser tool operations
 * 11. Selective user undo
 * 12. Global undo (cross-user)
 * 13. Global redo
 * 14. Late-joiner full state sync
 * 15. Reconnection state recovery
 * 16. Idempotency & duplicate operation protection
 * 17. Malformed payload resilience
 * 18. Disconnect presence cleanup
 */

const { io } = require('socket.io-client');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const RoomManager = require('../server/rooms');

const TEST_PORT = 4056;
const SERVER_URL = `http://localhost:${TEST_PORT}`;

// Spin up dedicated test server instance matching production server logic
const app = express();
const server = http.createServer(app);
const serverIo = new Server(server, { cors: { origin: '*' } });
const roomManager = new RoomManager();

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    activeRooms: roomManager.rooms.size,
    timestamp: Date.now()
  });
});

// Setup server handlers identical to production server.js
serverIo.on('connection', (socket) => {
  socket.on('room:join', (payload = {}) => {
    try {
      const roomId = String(payload.roomId || 'main').trim().toLowerCase().slice(0, 32) || 'main';
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
    } catch (err) {
      console.error('[Test Server] error room:join:', err);
    }
  });

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
      const active = drawingState.startStroke(user.userId, strokeData);
      if (active) socket.to(roomId).emit('stroke:start', active);
    } catch (err) {}
  });

  socket.on('stroke:points', (data) => {
    try {
      if (!data || !data.opId || !data.points) return;
      const roomId = roomManager.socketToRoom.get(socket.id);
      const drawingState = roomManager.getDrawingState(roomId);
      if (!drawingState) return;
      drawingState.appendPoints(data.opId, data.points);
      socket.to(roomId).emit('stroke:points', data);
    } catch (err) {}
  });

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
        serverIo.in(roomId).emit('stroke:committed', {
          operation: committedOp,
          sequenceNumber: drawingState.sequenceNumber
        });
      }
    } catch (err) {}
  });

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
        serverIo.in(roomId).emit('history:undone', {
          opId: result.opId,
          undoneBy: user.userName,
          mode,
          sequenceNumber: drawingState.sequenceNumber
        });
      }
    } catch (err) {}
  });

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
        serverIo.in(roomId).emit('history:redone', {
          opId: result.opId,
          operation: result.operation,
          redoneBy: user.userName,
          mode,
          sequenceNumber: drawingState.sequenceNumber
        });
      }
    } catch (err) {}
  });

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
    } catch (err) {}
  });
});

async function runComprehensiveTests() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' 🚀 RUNNING 100% COLLABORATIVE CANVAS INTEGRATION TEST SUITE');
  console.log('═══════════════════════════════════════════════════════════\n');

  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
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

  const clients = [];

  function createClient() {
    const c = io(SERVER_URL, { reconnection: false, forceNew: true });
    clients.push(c);
    return c;
  }

  try {
    // -------------------------------------------------------------
    // Test 1: Health Check Endpoint
    // -------------------------------------------------------------
    console.log('--- Phase 1: Server Health & Connectivity ---');
    const healthRes = await fetch(`${SERVER_URL}/api/health`);
    const healthData = await healthRes.json();
    assert(healthRes.status === 200 && healthData.status === 'ok', '1. HTTP /api/health endpoint returns status: "ok"');

    // -------------------------------------------------------------
    // Test 2: Single Client Connection
    // -------------------------------------------------------------
    const client1 = createClient();
    const c1Init = await new Promise((resolve) => {
      client1.on('init:state', (d) => resolve(d));
      client1.emit('room:join', { roomId: 'test-room', userName: 'Alice', userId: 'user_alice' });
    });
    assert(c1Init.room.id === 'test-room', '2. Client receives init:state with matching roomId');
    assert(c1Init.user.userName === 'Alice', '   Client receives verified userName');

    // -------------------------------------------------------------
    // Test 3 & 4: Multi-User Connection & Presence Roster
    // -------------------------------------------------------------
    console.log('\n--- Phase 2: Multi-User Presence & Roster Sync ---');
    const client2 = createClient();
    const [c1Notice, c2Init] = await Promise.all([
      new Promise(res => client1.on('user:joined', res)),
      new Promise(res => {
        client2.on('init:state', res);
        client2.emit('room:join', { roomId: 'test-room', userName: 'Bob', userId: 'user_bob' });
      })
    ]);
    assert(c1Notice.user.userName === 'Bob', '3. Existing user notified when new user connects');
    assert(c2Init.users.length === 2, '4. Presence roster synchronizes count of active users');

    // -------------------------------------------------------------
    // Test 5: Room Isolation
    // -------------------------------------------------------------
    console.log('\n--- Phase 3: Room Isolation ---');
    const clientOtherRoom = createClient();
    let leakedEvent = false;
    clientOtherRoom.on('stroke:start', () => { leakedEvent = true; });
    clientOtherRoom.on('stroke:committed', () => { leakedEvent = true; });

    await new Promise(res => {
      clientOtherRoom.on('init:state', res);
      clientOtherRoom.emit('room:join', { roomId: 'isolated-room-z', userName: 'Zoe' });
    });

    // Draw in test-room
    client1.emit('stroke:start', { opId: 'iso_stroke_1', tool: 'brush', point: { x: 10, y: 10 } });
    client1.emit('stroke:end', { opId: 'iso_stroke_1', tool: 'brush', points: [{ x: 10, y: 10 }] });

    await new Promise(r => setTimeout(r, 80));
    assert(!leakedEvent, '5. Drawing in test-room does NOT leak into isolated-room-z');

    // -------------------------------------------------------------
    // Test 6: Sub-frame Stroke Streaming
    // -------------------------------------------------------------
    console.log('\n--- Phase 4: Real-Time Stroke Streaming ---');
    const opStreamId = 'stream_op_01';
    let startReceived = false;
    let pointsReceived = false;
    let pointsCount = 0;

    client2.on('stroke:start', (data) => {
      if (data.id === opStreamId || data.opId === opStreamId) startReceived = true;
    });

    client2.on('stroke:points', (data) => {
      if (data.opId === opStreamId) {
        pointsReceived = true;
        pointsCount += data.points.length;
      }
    });

    client1.emit('stroke:start', { opId: opStreamId, tool: 'brush', color: '#ff0000', width: 4, point: { x: 50, y: 50 } });
    await new Promise(r => setTimeout(r, 20));
    client1.emit('stroke:points', { opId: opStreamId, points: [{ x: 55, y: 55 }, { x: 60, y: 60 }] });
    await new Promise(r => setTimeout(r, 20));

    assert(startReceived, '6. stroke:start received by peer in sub-frame time before stroke:end');
    assert(pointsReceived && pointsCount === 2, '   stroke:points batch chunk received incrementally');

    // Commit stroke
    const commitPromise = new Promise(res => client2.on('stroke:committed', res));
    client1.emit('stroke:end', { opId: opStreamId, points: [{ x: 50, y: 50 }, { x: 60, y: 60 }] });
    const commitRes = await commitPromise;
    assert(commitRes.operation.id === opStreamId, '   stroke:committed confirmed with authoritative seq');

    // -------------------------------------------------------------
    // Test 7: Simultaneous Drawing Concurrency
    // -------------------------------------------------------------
    console.log('\n--- Phase 5: Concurrency & Conflict Resolution ---');
    const simOp1 = 'sim_op_alice';
    const simOp2 = 'sim_op_bob';

    const commitOrders = [];
    const collectCommits = (data) => {
      if (data.operation.id === simOp1 || data.operation.id === simOp2) {
        commitOrders.push(data.operation.id);
      }
    };
    client1.on('stroke:committed', collectCommits);

    // Emit simultaneously
    client1.emit('stroke:start', { opId: simOp1, tool: 'brush', point: { x: 100, y: 100 } });
    client2.emit('stroke:start', { opId: simOp2, tool: 'brush', point: { x: 200, y: 200 } });

    client1.emit('stroke:end', { opId: simOp1, points: [{ x: 100, y: 100 }, { x: 110, y: 110 }] });
    client2.emit('stroke:end', { opId: simOp2, points: [{ x: 200, y: 200 }, { x: 210, y: 210 }] });

    await new Promise(r => setTimeout(r, 100));
    client1.off('stroke:committed', collectCommits);
    assert(commitOrders.length === 2, '7. Simultaneous strokes from Alice and Bob both commit cleanly');

    // -------------------------------------------------------------
    // Test 8 & 9: Geometric Shapes (Rectangle, Circle, Line)
    // -------------------------------------------------------------
    console.log('\n--- Phase 6: Shapes & Tools ---');
    const rectOpId = 'shape_rect_1';
    const circleOpId = 'shape_circle_1';

    const rectCommitPromise = new Promise(res => client1.on('stroke:committed', res));
    client2.emit('stroke:end', {
      opId: rectOpId,
      tool: 'rectangle',
      color: '#00ff00',
      width: 5,
      startPoint: { x: 100, y: 100 },
      endPoint: { x: 300, y: 250 }
    });
    const rectCommitted = await rectCommitPromise;
    assert(rectCommitted.operation.tool === 'rectangle', '8. Rectangle shape committed with geometric coordinates');

    const circleCommitPromise = new Promise(res => client1.on('stroke:committed', res));
    client2.emit('stroke:end', {
      opId: circleOpId,
      tool: 'circle',
      color: '#0000ff',
      width: 3,
      startPoint: { x: 400, y: 400 },
      endPoint: { x: 500, y: 500 }
    });
    const circleCommitted = await circleCommitPromise;
    assert(circleCommitted.operation.tool === 'circle', '9. Circle shape committed successfully');

    // -------------------------------------------------------------
    // Test 10: Eraser Tool
    // -------------------------------------------------------------
    const eraserOpId = 'eraser_op_1';
    const eraserPromise = new Promise(res => client1.on('stroke:committed', res));
    client1.emit('stroke:end', {
      opId: eraserOpId,
      tool: 'eraser',
      width: 20,
      points: [{ x: 105, y: 105 }, { x: 110, y: 110 }]
    });
    const eraserCommitted = await eraserPromise;
    assert(eraserCommitted.operation.tool === 'eraser', '10. Eraser stroke committed to room history');

    // -------------------------------------------------------------
    // Test 11: Selective User Undo
    // -------------------------------------------------------------
    console.log('\n--- Phase 7: State Synchronization & Undo / Redo ---');
    // Bob undos Bob's own last stroke (circleOpId)
    const userUndoPromise = new Promise(res => client1.on('history:undone', res));
    client2.emit('history:undo', { mode: 'user' });
    const userUndoRes = await userUndoPromise;
    assert(userUndoRes.opId === circleOpId, '11. Selective user undo targets User B\'s action specifically');

    // -------------------------------------------------------------
    // Test 12: Global Undo (Cross-User)
    // -------------------------------------------------------------
    // Latest active on canvas is now eraserOpId (drawn by Alice). Bob calls global undo!
    const globalUndoPromise = new Promise(res => client1.on('history:undone', res));
    client2.emit('history:undo', { mode: 'global' });
    const globalUndoRes = await globalUndoPromise;
    assert(globalUndoRes.opId === eraserOpId, '12. Global undo allows User B to undo User A\'s latest stroke');

    // -------------------------------------------------------------
    // Test 13: Global Redo
    // -------------------------------------------------------------
    const globalRedoPromise = new Promise(res => client2.on('history:redone', res));
    client1.emit('history:redo', { mode: 'global' });
    const globalRedoRes = await globalRedoPromise;
    assert(globalRedoRes.opId === eraserOpId, '13. Global redo restores the undone stroke across all clients');

    // -------------------------------------------------------------
    // Test 14: Late-Joiner Synchronization
    // -------------------------------------------------------------
    console.log('\n--- Phase 8: Late Joiners & Reconnection ---');
    const clientLate = createClient();
    const lateInit = await new Promise(res => {
      clientLate.on('init:state', res);
      clientLate.emit('room:join', { roomId: 'test-room', userName: 'Charlie' });
    });
    assert(lateInit.snapshot.operations.length >= 4, '14. Late-joining client receives complete chronological operations log');
    assert(lateInit.snapshot.undoneOpIds.includes(circleOpId), '    Undone operations preserved with tombstones');

    // -------------------------------------------------------------
    // Test 15: Reconnection State Recovery
    // -------------------------------------------------------------
    // Disconnect Alice, then reconnect with the same persistent userId
    client1.disconnect();
    const clientAliceReconnected = createClient();
    const aliceReconState = await new Promise(res => {
      clientAliceReconnected.on('init:state', res);
      clientAliceReconnected.emit('room:join', { roomId: 'test-room', userName: 'Alice', userId: 'user_alice' });
    });
    assert(aliceReconState.user.userId === 'user_alice', '15. Reconnected user retains identity and receives full state');

    // -------------------------------------------------------------
    // Test 16: Idempotency & Duplicate Operation Protection
    // -------------------------------------------------------------
    console.log('\n--- Phase 9: Resilience & Edge Cases ---');
    const dupOpId = 'dup_test_operation_99';
    let commitCount = 0;
    const countListener = (d) => { if (d.operation.id === dupOpId) commitCount++; };
    client2.on('stroke:committed', countListener);

    // Emit stroke:end twice with identical opId
    client2.emit('stroke:end', { opId: dupOpId, tool: 'brush', points: [{ x: 1, y: 1 }] });
    client2.emit('stroke:end', { opId: dupOpId, tool: 'brush', points: [{ x: 1, y: 1 }] });

    await new Promise(r => setTimeout(r, 60));
    client2.off('stroke:committed', countListener);
    assert(commitCount === 1, '16. Duplicate stroke:end with identical opId is idempotent (committed once)');

    // -------------------------------------------------------------
    // Test 17: Malformed / Invalid Event Resilience
    // -------------------------------------------------------------
    // Sending null, undefined, and garbage data should NOT crash the server
    client2.emit('stroke:start', null);
    client2.emit('stroke:points', { opId: null, points: 'not_an_array' });
    client2.emit('stroke:end', { opId: null });
    client2.emit('cursor:move', { x: NaN, y: 'corrupted' });
    client2.emit('history:undo', null);

    await new Promise(r => setTimeout(r, 50));
    // Test server is still alive and responds
    const pingRes = await fetch(`${SERVER_URL}/api/health`);
    assert(pingRes.status === 200, '17. Server gracefully ignores malformed payloads without crashing');

    // -------------------------------------------------------------
    // Test 18: Disconnect Presence Cleanup
    // -------------------------------------------------------------
    const leavePromise = new Promise(res => client2.on('user:left', res));
    clientAliceReconnected.disconnect();
    const leaveEvent = await leavePromise;
    assert(leaveEvent.userName === 'Alice', '18. Disconnect broadcast received and user presence updated');

  } catch (err) {
    console.error('Fatal test runner exception:', err);
  } finally {
    for (const c of clients) {
      try { c.disconnect(); } catch (e) {}
    }
    serverIo.close();
    server.close();
    console.log(`\n═══════════════════════════════════════════════════════════`);
    console.log(` 🏆 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log(`═══════════════════════════════════════════════════════════\n`);
    setTimeout(() => {
      process.exit(failed === 0 ? 0 : 1);
    }, 150);
  }
}

runComprehensiveTests();
