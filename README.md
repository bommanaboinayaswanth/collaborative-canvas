# 🎨 SyncDraw — Real-Time Collaborative Drawing Canvas

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/bommanaboinayaswanth/collaborative-canvas)

A high-performance, multi-user real-time drawing whiteboard built from scratch with **Vanilla JavaScript/HTML5 Canvas** on the frontend and **Node.js + Socket.IO** on the backend. Zero frontend frameworks (no React/Vue), zero external canvas drawing libraries (no Fabric.js/Konva).

---

## 🌐 Live Deployed Demo Link

* **Direct Public Live Demo**: **[https://8d55df35b40937.lhr.life](https://8d55df35b40937.lhr.life)**
* **1-Click Cloud Deploy (Render)**: **[Deploy to Render](https://render.com/deploy?repo=https://github.com/bommanaboinayaswanth/collaborative-canvas)**
* **GitHub Repository**: **[https://github.com/bommanaboinayaswanth/collaborative-canvas](https://github.com/bommanaboinayaswanth/collaborative-canvas)**

---

## ⚡ Quick Start (Local Run)

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+ recommended, v24 supported)
- `npm` (v9+)

### 1. Install & Run
```bash
# Clone or enter the repository
cd collaborative-canvas

# Install dependencies
npm install

# Start production server
npm start
```

Open your browser to: **`http://localhost:3000`**

### 2. Development Mode (Auto-Reload)
```bash
npm run dev
```

### 3. Run Automated Multi-User Test Suite (18 Scenarios)
```bash
npm test
```

---

## 🚀 1-Click Cloud Deployment

This repository is pre-configured for instant zero-config cloud deployment:

### Option A: Render.com (Recommended Free Hosting)
1. Push your repository to GitHub.
2. Log into [Render.com](https://render.com/) and click **New +** -> **Blueprint**.
3. Select this repository. Render will automatically read `render.yaml` and deploy your app.
4. Your live URL will be active in ~2 minutes! (e.g., `https://collaborative-canvas-xxxx.onrender.com`).

### Option B: Railway.app
1. Go to [Railway.app](https://railway.app/) -> **New Project** -> **Deploy from GitHub repo**.
2. Railway detects the `Dockerfile` or `package.json` automatically and provisions your app with an SSL domain.

### Option C: Docker Container
```bash
# Build Docker image
docker build -t syncdraw .

# Run Docker container
docker run -p 3000:3000 syncdraw
```
Visit `http://localhost:3000`.

---

## 👥 How to Test with Multiple Users

1. Open **`http://localhost:3000`** in Window 1 (User A).
2. Open **`http://localhost:3000`** in Window 2 or an Incognito Window / Mobile browser (User B).
3. Both users automatically connect to the `#main` room with unique assigned presence colors and names.
4. **Real-Time Streaming**: Draw with User A. Notice how User B sees the stroke rendered incrementally in real time as the mouse drags, *not* only after release.
5. **Live Peer Cursors**: Move your mouse across the canvas. Notice each user's colored cursor arrow, name tag, and drawing indicator (`✏️`) tracking smoothly.
6. **Global Undo/Redo**:
   - User A draws a red line.
   - User B draws a blue circle.
   - User A clicks **Undo** (or `Ctrl+Z`). User B's circle disappears on both screens simultaneously (server-authoritative global undo).
   - User B clicks **Redo** (or `Ctrl+Y`). The circle reappears on both screens!
7. **Selective User Undo**: Change the scope dropdown to `My Actions Only`. Now clicking Undo will only revert strokes authored by your own user ID.
8. **Room Isolation**: In the top bar, enter a new room name (e.g. `team-sync`) and click **Join**, or visit `http://localhost:3000/#team-sync`. Share the URL to invite peers to an isolated whiteboard.
9. **Export**: Click **Export** to download the collaborative artwork as a high-resolution PNG.

---

## 🛠️ System Architecture & Tech Stack

```
collaborative-canvas/
├── client/
│   ├── index.html          # Canvas container, floating frosted-glass toolbar, modals
│   ├── style.css           # Modern dark UI theme, peer cursor styles, responsive
│   ├── canvas.js           # Multi-layer canvas engine, path smoothing, shapes, HiDPI
│   ├── websocket.js        # Socket.IO client, coordinate batching & event dispatching
│   └── main.js             # App orchestration, UI controls, shortcuts, presence, HUD
├── server/
│   ├── server.js           # Express + Socket.IO server, real-time routing, health checks
│   ├── rooms.js            # Room management, user presence, distinct color palette
│   └── drawing-state.js    # Authoritative operation log, global/user undo-redo, sequencing
├── test/
│   └── integration-test.js # 18-scenario automated multi-user test suite
├── Dockerfile              # Production multi-stage Alpine Docker container
├── render.yaml             # Render Blueprint for 1-click cloud deployment
├── ARCHITECTURE.md         # Detailed architectural specs, protocols, and conflict resolution
├── INTERVIEW_GUIDE.md      # 5-minute demo script, top 10 interview Q&As, live coding extension
└── package.json            # Scripts: start, dev, test
```

| Layer | Technologies Used | Architectural Rationale |
|---|---|---|
| **Frontend** | HTML5 Canvas, Vanilla ES6, Modern CSS3 | Zero frontend frameworks (no React/Vue) and zero canvas libraries (no Fabric.js/Konva) to demonstrate raw 2D Canvas and DOM mastery. |
| **Backend** | Node.js, Express, Socket.IO | Express serves static client files; Socket.IO provides low-latency bi-directional event streaming, room isolation, and heartbeat pings. |
| **Testing** | Headless Node.js Test Runner, `socket.io-client` | Automated integration test suite covering 18 real-time multi-user scenarios with 100% pass rate. |
| **Deployment** | Docker (Alpine Linux), Render Blueprint | Production-ready containerization and 1-click cloud deployment. |

---

## ✨ Features Checklist

- [x] **Dual-Canvas Layer Architecture**: Dedicated Base Canvas (committed operations) + Active Canvas (in-flight strokes & shape previews) to eliminate full-canvas redrawing during mouse movement.
- [x] **Path Smoothing**: Quadratic bezier curves with midpoint interpolation (`(p1 + p2)/2`) eliminate jagged lines.
- [x] **HiDPI / Retina Crispness**: Dynamic `devicePixelRatio` scaling prevents blurriness on 2x/3x Retina screens.
- [x] **Logical Coordinates**: Normalized `1920x1080` coordinate space ensures identical stroke alignment across iPhones, iPads, and 4K desktop screens.
- [x] **Drawing Tools**: Freehand Brush, Eraser, Line, Arrow, Rectangle, Circle, 8-color preset swatches + custom HTML5 color picker, and 1px–48px stroke width slider.
- [x] **Sub-frame Streaming**: Coordinates batched every 16ms (~60Hz) to prevent TCP saturation while maintaining fluid peer rendering.
- [x] **Live Peer Cursors**: GPU-accelerated CSS translation with user tags, distinct colors, and drawing status indicators.
- [x] **Room Isolation**: Multi-room system via top-bar input or `#room-name` URL hashing.
- [x] **Presence & Profile**: Live online user roster with avatars, auto-assigned high-contrast colors, and custom profile editing.
- [x] **Performance HUD**: Live FPS counter (`requestAnimationFrame`) and real-time network latency monitor (`ping`/`pong` roundtrip time in ms).
- [x] **Global & User Undo/Redo**: Server-authoritative tombstone operation log with monotonic sequence numbers (`seq`).
- [x] **Conflict Resolution**: Total ordering serialization on Node.js event loop ensures identical deterministic state convergence.
- [x] **Input Hardening & Idempotency**: Bounded coordinate validation and duplicate commit deduplication prevent crashes.
- [x] **Persistent User Identity**: Reconnecting clients retain their user ID across refreshes via `localStorage`.

---

## 🧪 Automated Test Suite (18 Scenarios)

Run:
```bash
npm test
```

**Test Verification Matrix**:
```text
═══════════════════════════════════════════════════════════
 🚀 RUNNING 100% COLLABORATIVE CANVAS INTEGRATION TEST SUITE
═══════════════════════════════════════════════════════════

--- Phase 1: Server Health & Connectivity ---
  ✅ PASS: 1. HTTP /api/health endpoint returns status: "ok"
  ✅ PASS: 2. Client receives init:state with matching roomId
  ✅ PASS:    Client receives verified userName

--- Phase 2: Multi-User Presence & Roster Sync ---
  ✅ PASS: 3. Existing user notified when new user connects
  ✅ PASS: 4. Presence roster synchronizes count of active users

--- Phase 3: Room Isolation ---
  ✅ PASS: 5. Drawing in test-room does NOT leak into isolated-room-z

--- Phase 4: Real-Time Stroke Streaming ---
  ✅ PASS: 6. stroke:start received by peer in sub-frame time before stroke:end
  ✅ PASS:    stroke:points batch chunk received incrementally
  ✅ PASS:    stroke:committed confirmed with authoritative seq

--- Phase 5: Concurrency & Conflict Resolution ---
  ✅ PASS: 7. Simultaneous strokes from Alice and Bob both commit cleanly

--- Phase 6: Shapes & Tools ---
  ✅ PASS: 8. Rectangle shape committed with geometric coordinates
  ✅ PASS: 9. Circle shape committed successfully
  ✅ PASS: 10. Eraser stroke committed to room history

--- Phase 7: State Synchronization & Undo / Redo ---
  ✅ PASS: 11. Selective user undo targets User B's action specifically
  ✅ PASS: 12. Global undo allows User B to undo User A's latest stroke
  ✅ PASS: 13. Global redo restores the undone stroke across all clients

--- Phase 8: Late Joiners & Reconnection ---
  ✅ PASS: 14. Late-joining client receives complete chronological operations log
  ✅ PASS:     Undone operations preserved with tombstones
  ✅ PASS: 15. Reconnected user retains identity and receives full state

--- Phase 9: Resilience & Edge Cases ---
  ✅ PASS: 16. Duplicate stroke:end with identical opId is idempotent (committed once)
  ✅ PASS: 17. Server gracefully ignores malformed payloads without crashing
  ✅ PASS: 18. Disconnect broadcast received and user presence updated

═══════════════════════════════════════════════════════════
 🏆 TEST RESULTS: 22 PASSED, 0 FAILED
═══════════════════════════════════════════════════════════
```

---

## ⚠️ Known Limitations & Design Trade-offs

1. **Session History Depth**: Canvas history is replayed from the operation log upon undo/redo. For ultra-long sessions (>5,000 operations), this is optimized by introducing offscreen raster checkpoint snapshots every 50 operations (documented in [ARCHITECTURE.md](ARCHITECTURE.md)).
2. **Text Tool**: While geometric shapes (rectangles, circles, lines, arrows) are fully supported, rich multi-line editable text input boxes were omitted to prioritize core 2D vector path manipulation and real-time synchronization.
3. **Storage Persistence**: Drawing states are stored in-memory per room on the server. In production, this can be backed by Redis or PostgreSQL/S3 for persistent whiteboards across server restarts.

---

## ⏱️ Time Spent on the Project

| Milestone | Time Spent |
|---|---|
| Architecture & Protocol Specification | 2.5 hours |
| Dual-Layer Canvas Engine & Path Smoothing | 3.5 hours |
| Socket.IO Real-time Streaming & Presence | 2.5 hours |
| Server-Authoritative Global Undo/Redo & Conflict Resolution | 3.0 hours |
| UI/UX Design, Peer Cursors, HUD & Shortcuts | 2.5 hours |
| 18-Scenario Automated Test Suite & Server Hardening | 2.5 hours |
| Cloud Deployment Setup (Docker, Render) & Documentation | 2.0 hours |
| **Total Time** | **~18.5 hours** |

---

## 🎙️ Interview Preparation

See [INTERVIEW_GUIDE.md](INTERVIEW_GUIDE.md) for:
- 5-minute live demo script with exact timestamps
- Top 10 core architectural interview questions with simple analogies + deep technical explanations
- Live coding challenge extension: Adding a new tool (e.g. Triangle) in 3 minutes
- 1,000 to 100,000 user scaling discussion
