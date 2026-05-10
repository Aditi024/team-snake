// Team Snake — HTTP + WebSocket server.
// Serves public/ statically and runs all game rooms in-memory.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Room, makeRoomCode } from "./game/room.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 8080);
const ROOM_IDLE_MS = 10 * 60 * 1000; // 10 min

// -- Static file serving --
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  serveStatic(req, res);
});

// -- WebSocket + rooms --
const wss = new WebSocketServer({ server });

/** @type {Map<string, Room>} */
const rooms = new Map();

// Each ws has: ws.playerId, ws.roomCode
function send(ws, msg) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  const payload = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === p.ws.OPEN) p.ws.send(payload);
  }
}

function broadcastLobby(room) {
  broadcast(room, { type: "lobby", ...room.lobbySnapshot() });
}

function broadcastState(room) {
  const snap = room.stateSnapshot();
  if (!snap) return;
  broadcast(room, { type: "state", ...snap });
  if (room.status === "OVER") {
    broadcast(room, {
      type: "game_over",
      score: snap.score,
      cause: snap.cause,
    });
  }
}

function makePlayerId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: "error", code: "BAD_JSON" });
    }
    handleMessage(ws, msg);
  });

  ws.on("close", () => {
    const { roomCode, playerId } = ws;
    if (!roomCode || !playerId) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    room.markDisconnected(playerId);
    if (room.status === "LOBBY" || room.status === "OVER") {
      // In non-playing states, drop the player entirely.
      room.removePlayer(playerId);
      if (rooms.has(roomCode)) broadcastLobby(room);
    } else {
      // Mid-game: slot reserved; broadcast an updated state so teammates see disconnect.
      broadcastState(room);
    }
  });
});

function handleMessage(ws, msg) {
  switch (msg.type) {
    case "create_room":
      return handleCreateRoom(ws, msg);
    case "join_room":
      return handleJoinRoom(ws, msg);
    case "claim_slot":
      return withRoom(ws, (room) => {
        const r = room.claimSlot(ws.playerId, msg.slot);
        if (!r.ok) return send(ws, { type: "error", code: r.error });
        broadcastLobby(room);
      });
    case "ready":
      return withRoom(ws, (room) => {
        const r = room.setReady(ws.playerId, msg.ready !== false);
        if (!r.ok) return send(ws, { type: "error", code: r.error });
        broadcastLobby(room);
      });
    case "start":
      return withRoom(ws, (room) => {
        if (ws.playerId !== room.hostId) return send(ws, { type: "error", code: "NOT_HOST" });
        const r = room.start(broadcastState);
        if (!r.ok) return send(ws, { type: "error", code: r.error });
        broadcastState(room);
      });
    case "restart":
      return withRoom(ws, (room) => {
        if (ws.playerId !== room.hostId) return send(ws, { type: "error", code: "NOT_HOST" });
        const r = room.restart(broadcastState);
        if (!r.ok) return send(ws, { type: "error", code: r.error });
        broadcastState(room);
      });
    case "turn":
      return withRoom(ws, (room) => {
        const r = room.submitTurn(ws.playerId, msg.dir);
        if (!r.ok && r.error !== "NOT_YOUR_DIR") {
          // Silent on NOT_YOUR_DIR to avoid spam.
          send(ws, { type: "error", code: r.error });
        }
      });
    case "ping":
      return send(ws, { type: "pong" });
    default:
      return send(ws, { type: "error", code: "UNKNOWN_TYPE" });
  }
}

function withRoom(ws, fn) {
  const room = rooms.get(ws.roomCode);
  if (!room) return send(ws, { type: "error", code: "NO_ROOM" });
  fn(room);
}

function handleCreateRoom(ws, msg) {
  const mode = msg.mode === "2P" ? "2P" : "4P";
  let code;
  do {
    code = makeRoomCode();
  } while (rooms.has(code));
  const room = new Room(code, mode, (r) => rooms.delete(r.code));
  rooms.set(code, room);
  attachPlayer(ws, room, msg.name, msg.playerId);
  send(ws, {
    type: "room_joined",
    code: room.code,
    playerId: ws.playerId,
    role: ws.playerId === room.hostId ? "host" : "guest",
    mode: room.mode,
  });
  broadcastLobby(room);
}

function handleJoinRoom(ws, msg) {
  const code = typeof msg.code === "string" ? msg.code.toUpperCase().trim() : "";
  const room = rooms.get(code);
  if (!room) return send(ws, { type: "error", code: "ROOM_NOT_FOUND" });
  // Room full? In lobby, cap at REQUIRED_SLOTS length for their mode.
  if (room.status === "LOBBY") {
    const maxSlots = room.mode === "4P" ? 4 : 2;
    if (room.players.size >= maxSlots && !room.players.has(msg.playerId)) {
      return send(ws, { type: "error", code: "ROOM_FULL" });
    }
  }
  attachPlayer(ws, room, msg.name, msg.playerId);
  send(ws, {
    type: "room_joined",
    code: room.code,
    playerId: ws.playerId,
    role: ws.playerId === room.hostId ? "host" : "guest",
    mode: room.mode,
  });
  broadcastLobby(room);
  if (room.status === "PLAYING" || room.status === "OVER") {
    broadcastState(room);
  }
}

function attachPlayer(ws, room, name, existingId) {
  // Evict old websocket if same playerId already has one (two-tab rule).
  let playerId = existingId;
  if (playerId && room.players.has(playerId)) {
    const existing = room.players.get(playerId);
    if (existing.ws && existing.ws !== ws && existing.ws.readyState === existing.ws.OPEN) {
      send(existing.ws, { type: "error", code: "KICKED" });
      try {
        existing.ws.close();
      } catch {}
    }
  } else {
    playerId = makePlayerId();
  }
  ws.playerId = playerId;
  ws.roomCode = room.code;
  room.addPlayer(playerId, ws, name || "PLAYER");
}

// -- Heartbeat: kick dead sockets every 15s --
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch {}
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 15000);
wss.on("close", () => clearInterval(heartbeat));

// -- Room reaper: destroy idle rooms every 60s --
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (now - room.lastActivity > ROOM_IDLE_MS) {
      for (const p of room.players.values()) {
        if (p.ws) {
          send(p.ws, { type: "error", code: "ROOM_EXPIRED" });
          try {
            p.ws.close();
          } catch {}
        }
      }
      room.destroy();
    }
  }
}, 60000);

server.listen(PORT, () => {
  console.log(`[team-snake] listening on http://localhost:${PORT}`);
});
