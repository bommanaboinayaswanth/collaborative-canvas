# 🎨 SyncDraw — Real-Time Collaborative Drawing Canvas

A high-performance, multi-user real-time drawing whiteboard built from scratch with **Vanilla JavaScript/HTML5 Canvas** on the frontend and **Node.js + Socket.IO** on the backend. Zero frontend frameworks, zero external canvas drawing libraries.

---

## ⚡ Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+ recommended)
- `npm` (v9+)

### Installation & Run

```bash
# 1. Clone or open the project folder
cd collaborative-canvas

# 2. Install dependencies
npm install

# 3. Start the server
npm start
```

The server will start on: **`http://localhost:3000`**

To run with auto-reload during development:
```bash
npm run dev
```

To run the automated multi-user integration test suite:
```bash
npm test
```

---

## 👥 How to Test with Multiple Users

1. Open **`http://localhost:3000`** in Google Chrome (User A).
2. Open **`http://localhost:3000`** in a second window or Incognito tab / Firefox (User B).
3. Both users will automatically enter the `#main` room with unique assigned presence colors and names (e.g. *Artist 101*, *Artist 405*).
4. **Real-Time Streaming**: Draw with User A. Notice how User B sees the stroke rendered incrementally in real time as the mouse moves, *not* only after the mouse is released.
5. **Live Peer Cursors**: Move your mouse across the canvas. Notice each user's colored cursor pointer, name tag, and pen-down indicator tracking in real time.
6. **Global Undo/Redo**:
   - User A draws a red line.
   - User B draws a blue circle.
   - User A clicks **Undo** (or presses `Ctrl+Z`).
   - Notice User B's circle disappears on both screens simultaneously (Server-authoritative global undo).
   - User B clicks **Redo** (or presses `Ctrl+Y`). The circle reappears on both screens!
7. **Selective User Undo**: Change the dropdown from `Global Undo` to `My Actions Only`. Now pressing Undo will only revert strokes authored by your user ID.
8. **Rooms / Isolated Canvases**: Enter a new room name in the top bar (e.g., `design-team`) and click **Join**, or visit `http://localhost:3000/#design-team`. Share the URL to invite peers to your isolated canvas.
9. **Export**: Click **Export** to download the collaborative artwork as a high-resolution PNG.

---

## 🛠️ Tech Stack & Architecture Highlights

| Layer | Technologies Used | Rationale |
|---|---|---|
| **Frontend** | HTML5 Canvas, Vanilla ES6 Modules, Modern CSS3 | Strict requirement: zero frontend frameworks (no React/Vue) and zero canvas libraries (no Fabric.js/Konva) to demonstrate raw DOM and 2D Canvas mastery. |
| **Backend** | Node.js, Express, Socket.IO | Express handles static asset delivery; Socket.IO provides low-latency WebSocket communication, automatic reconnection, and built-in room isolation. |
| **Testing** | Node.js automated test runner, `socket.io-client` | Automated headless integration testing verifying real-time sync, monotonic sequencing, and undo/redo determinism across 3 concurrent clients. |

---

## ✨ Features Implemented

### 🖌️ Core Canvas & Drawing
- **Dual-Layer Canvas Architecture**:
  - **Base Canvas**: Stores finalized, committed operations.
  - **Active / Scratch Canvas**: Renders high-frequency, in-flight strokes for both local and remote peers without clearing or redrawing the base canvas.
- **Path Smoothing**: Quadratic bezier curves using midpoint interpolation (`(p1 + p2)/2`) to eliminate jagged lines from raw pointer inputs.
- **HiDPI / Retina Crispness**: Dynamic `devicePixelRatio` scaling so strokes remain razor-sharp on 2x/3x Retina screens.
- **Logical Coordinate System**: Normalizes coordinates to a `1920x1080` logical resolution, guaranteeing identical drawing alignment regardless of screen sizes, aspect ratios, or mobile viewport dimensions.
- **Tools Included**:
  - 🖌️ Freehand Brush
  - 🧼 Eraser (draws canvas background)
  - 📏 Straight Line
  - ➡️ Arrow
  - ⬛ Rectangle
  - ⭕ Ellipse / Circle
- **Customization**: 8-color preset palette + native HTML5 color picker, and dynamic stroke width slider (1px to 48px).

### ⚡ Real-Time Synchronization & Presence
- **Sub-frame Streaming**: Streams coordinates in ~16ms batches (`stroke:start`, `stroke:points`, `stroke:end`).
- **Live Peer Cursors**: Smooth hardware-accelerated CSS translation with user tags, distinct color rings, and drawing status indicators.
- **User Presence**: Live online user roster with avatars, auto-assigned high-contrast colors, and custom profile editing.
- **Real-Time HUD**: Live FPS counter (`requestAnimationFrame`) and ping roundtrip latency indicator (`ping`/`pong` in milliseconds).

### 🔄 Global & Selective Undo / Redo
- **Server-Authoritative Operation Log**: Operations are assigned monotonic sequence numbers (`seq`).
- **Tombstone Operation Flags**: Undone operations are marked with `isUndone = true` rather than destructively removed, enabling reliable Redo and state auditability.
- **Deterministic History Replay**: Canvas state can be reconstructed identically on any connected or late-joining client.
- **Dual Mode**: Choose between **Global Undo** (whiteboard style: undoes last action on canvas) and **User Undo** (Figma style: undoes only the invoking user's actions).

---

## ⏱️ Time Spent on Project
- **Architecture & System Design**: ~2.5 hours
- **Canvas Engine & Path Smoothing**: ~3 hours
- **Socket.IO Backend & Real-time Protocol**: ~2.5 hours
- **Global Undo/Redo & Conflict Resolution**: ~3 hours
- **UI/UX, Peer Cursors, HUD & Tooling**: ~2.5 hours
- **Automated Integration Testing & Documentation**: ~2.5 hours
- **Total Time**: ~16 hours

---

## ⚠️ Known Limitations & Edge Cases

1. **Very Long Sessions (>5,000 strokes)**: Replaying thousands of operations upon undo can cause brief frame drops. In production, this is solved using **Checkpoint Snapshots** (storing offscreen rasterized bitmaps every 50 operations).
2. **Text Tool**: While geometric shapes (rectangles, circles, lines, arrows) are fully supported, rich multi-line editable text boxes are omitted to keep the focus on raw 2D path manipulation and synchronization.
3. **Persistent Storage**: Currently in-memory per room. If the Node.js process restarts, the canvas resets. Can easily be hooked into Redis or PostgreSQL/SQLite for long-term persistence.

---

## 🎤 Live Interview Demo Script & FAQs

If asked to demo this in the interview:

1. **2-Minute Walkthrough**:
   - Open two browser tabs side by side.
   - Show how strokes stream smoothly *as you drag* rather than when mouse is released.
   - Demonstrate the dual-canvas architecture: explain why the active scratch layer prevents redrawing the entire canvas on every mouse move event.
   - Show peer cursor tracking with username and color tags.
   - Draw Stroke A, Stroke B, Stroke C. Trigger **Global Undo** from the second tab to prove server-authoritative state synchronization.
   - Show the live FPS and Latency metrics.
2. **Key Questions to Expect**:
   - *"Why did you use Socket.IO instead of native WebSockets?"*  
     Socket.IO provides built-in room isolation, automatic reconnection, heartbeat/ping-pong, and event framing out of the box while allowing seamless fallback.
   - *"How do you handle conflict resolution when two users draw simultaneously?"*  
     Both users draw onto their active scratch layers locally with zero latency (optimistic local rendering). The server assigns a monotonic sequence number `seq` upon stroke completion, ensuring identical deterministic replay order across all clients.
   - *"How would you scale this to 10,000 concurrent users?"*  
     Use Socket.IO Redis adapter for multi-node horizontal scaling, spatial partitioning (only send strokes to clients viewing the relevant viewport area), and delta compression.
