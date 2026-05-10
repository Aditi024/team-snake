// Team Snake client. Screen routing + WebSocket + input.

import { render } from "/render.js";

// ---------- Tiny DOM helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function showScreen(name) {
  $$(".screen").forEach((s) => {
    s.classList.toggle("is-active", s.dataset.screen === name);
  });
  app.screen = name;
}

function showOverlay(msg) {
  $("#overlay-msg").textContent = msg;
  $("#overlay").hidden = false;
}
function hideOverlay() {
  $("#overlay").hidden = true;
}

// Screen reader announcements. Live regions only re-announce when their
// text content changes, so we toggle a zero-width-space when repeating
// the same message (e.g. two foods of the same score).
function announce(msg, urgent = false) {
  const el = document.getElementById(urgent ? "sr-live-assertive" : "sr-live");
  if (!el) return;
  el.textContent = el.textContent === msg ? msg + "\u200B" : msg;
}

// ---------- App state ----------
const app = {
  screen: "landing",
  ws: null,
  playerId: sessionStorage.getItem("ts_playerId") || null,
  roomCode: sessionStorage.getItem("ts_roomCode") || null,
  role: null, // "host" | "guest"
  mode: "4P", // default create mode
  name: sessionStorage.getItem("ts_name") || "",
  lobby: null, // last lobby snapshot
  game: null, // last state snapshot
  mySlot: null,
  hostId: null,
  reconnectAttempts: 0,
  reconnectTimer: null,
  isReconnecting: false,
  pendingJoinIntent: null, // { type: "create"|"join", ... }
};

function saveSession() {
  if (app.playerId) sessionStorage.setItem("ts_playerId", app.playerId);
  if (app.roomCode) sessionStorage.setItem("ts_roomCode", app.roomCode);
  if (app.name) sessionStorage.setItem("ts_name", app.name);
}
function clearSession() {
  sessionStorage.removeItem("ts_playerId");
  sessionStorage.removeItem("ts_roomCode");
}

// ---------- WebSocket plumbing ----------
function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}`;
}

function connect(onOpen) {
  if (app.ws && app.ws.readyState === WebSocket.OPEN) {
    onOpen && onOpen();
    return;
  }
  if (app.ws && app.ws.readyState === WebSocket.CONNECTING) return;

  const ws = new WebSocket(wsUrl());
  app.ws = ws;

  ws.addEventListener("open", () => {
    app.reconnectAttempts = 0;
    app.isReconnecting = false;
    hideOverlay();
    onOpen && onOpen();
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleServer(msg);
  });

  ws.addEventListener("close", () => {
    // Only auto-reconnect if we're in an active room.
    if (app.roomCode && app.screen !== "landing" && app.screen !== "create" && app.screen !== "join") {
      scheduleReconnect();
    }
  });

  ws.addEventListener("error", () => {
    /* close will fire */
  });
}

function cancelReconnect() {
  if (app.reconnectTimer) {
    clearTimeout(app.reconnectTimer);
    app.reconnectTimer = null;
  }
  app.isReconnecting = false;
  app.reconnectAttempts = 0;
}

function scheduleReconnect() {
  if (app.reconnectTimer) return;
  app.isReconnecting = true;
  showOverlay("RECONNECTING…");
  const delay = Math.min(8000, 500 * Math.pow(2, app.reconnectAttempts));
  app.reconnectAttempts++;
  app.reconnectTimer = setTimeout(() => {
    app.reconnectTimer = null;
    connect(() => {
      // Rejoin with existing playerId.
      if (app.roomCode && app.playerId) {
        send({
          type: "join_room",
          code: app.roomCode,
          name: app.name,
          playerId: app.playerId,
        });
      }
    });
  }, delay);
}

function send(obj) {
  if (!app.ws || app.ws.readyState !== WebSocket.OPEN) {
    // Queue via reconnect: easiest is to just drop; server-authoritative game tolerates it.
    return false;
  }
  app.ws.send(JSON.stringify(obj));
  return true;
}

// ---------- Server message handlers ----------
function handleServer(msg) {
  switch (msg.type) {
    case "room_joined":
      app.playerId = msg.playerId;
      app.roomCode = msg.code;
      app.role = msg.role;
      app.mode = msg.mode;
      saveSession();
      hideOverlay();
      if (app.screen === "landing" || app.screen === "create" || app.screen === "join") {
        showScreen("lobby");
      }
      announce(`Joined room ${msg.code}. ${msg.mode === "4P" ? "Four-player" : "Two-player"} mode.`);
      break;
    case "lobby":
      announceLobbyDelta(msg);
      app.lobby = msg;
      app.hostId = msg.hostId;
      app.mode = msg.mode;
      app.mySlot = findMySlot(msg.slots);
      renderLobby();
      // Only jump to lobby screen when the room is actually in LOBBY status AND
      // we're not currently on a relevant screen. State changes to PLAYING/OVER
      // are driven by `state` messages, so don't duplicate the transition here.
      if (msg.status === "LOBBY" && app.screen !== "lobby") showScreen("lobby");
      break;
    case "state":
      announceStateDelta(msg);
      app.game = msg;
      app.mode = msg.mode;
      app.mySlot = findMySlot(msg.slots);
      if (msg.status === "PLAYING") {
        if (app.screen !== "play") {
          showScreen("play");
          announce(`Game started. You steer ${describeOwnedDir()}.`);
        }
        renderPlay();
      } else if (msg.status === "OVER") {
        if (app.screen !== "over") showScreen("over");
      }
      break;
    case "game_over":
      renderGameOver(msg);
      showScreen("over");
      announce(
        `Game over. ${msg.cause === "WALL" ? "Hit the wall" : "Bit yourself"}. Final score ${msg.score}.`,
        true
      );
      break;
    case "error":
      handleError(msg);
      break;
    case "pong":
      break;
  }
}

// Track previous game-state values so we only announce deltas.
const _prev = { score: 0, length: 0, lobbyHash: "" };

function announceStateDelta(msg) {
  if (typeof msg.score === "number" && msg.score > _prev.score) {
    announce(`Score ${msg.score}. Length ${msg.length}.`);
  }
  _prev.score = msg.score ?? _prev.score;
  _prev.length = msg.length ?? _prev.length;
}

function announceLobbyDelta(msg) {
  if (!msg.slots) return;
  // Hash slot occupancy + ready state. Announce when something changes.
  const hash = msg.slots
    .map((s) => `${s.slot}:${s.playerId || ""}:${s.ready ? 1 : 0}:${s.connected ? 1 : 0}`)
    .join("|");
  if (hash === _prev.lobbyHash) return;

  // Find the most relevant change to announce.
  const prevSlots = app.lobby?.slots || [];
  for (const s of msg.slots) {
    const old = prevSlots.find((p) => p.slot === s.slot);
    const dir = s.slot.toLowerCase();
    if (!old) continue;
    if (!old.playerId && s.playerId) {
      announce(`${s.name || "A player"} joined as ${dir}.`);
      break;
    }
    if (old.playerId && !s.playerId) {
      announce(`${old.name || "A player"} left ${dir}.`);
      break;
    }
    if (!old.ready && s.ready) {
      announce(`${s.name || "Player"} ready as ${dir}.`);
      break;
    }
    if (old.connected && !s.connected) {
      announce(`${s.name || "Player"} disconnected from ${dir}.`);
      break;
    }
  }
  _prev.lobbyHash = hash;
}

function describeOwnedDir() {
  if (app.mode === "2P") {
    if (app.mySlot === "UP") return "the up and down axis";
    if (app.mySlot === "LEFT") return "the left and right axis";
  }
  if (app.mySlot) return app.mySlot.toLowerCase();
  return "no direction yet";
}

function handleError(msg) {
  switch (msg.code) {
    case "ROOM_NOT_FOUND":
      // If we're booting from a stale session, bail back to landing.
      if (app.screen !== "join") {
        clearSession();
        app.roomCode = null;
        app.playerId = null;
        cancelReconnect();
        hideOverlay();
        showScreen("landing");
      }
      setStatus("join-status", "ROOM NOT FOUND");
      break;
    case "ROOM_FULL":
      setStatus("join-status", "ROOM IS FULL");
      break;
    case "ROOM_EXPIRED":
      clearSession();
      app.roomCode = null;
      app.playerId = null;
      cancelReconnect();
      hideOverlay();
      showScreen("landing");
      setStatus("join-status", "ROOM EXPIRED");
      break;
    case "KICKED":
      clearSession();
      alert("ANOTHER TAB CLAIMED YOUR SLOT");
      location.reload();
      break;
    case "SLOT_TAKEN":
      setStatus("lobby-status", "SLOT TAKEN — PICK ANOTHER");
      break;
    case "NOT_HOST":
    case "NOT_READY":
      // Silent — UI should already prevent these.
      break;
    default:
      console.warn("server error:", msg);
  }
}

function findMySlot(slots) {
  if (!slots) return null;
  const mine = slots.find((s) => s.playerId === app.playerId);
  return mine ? mine.slot : null;
}

function setStatus(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}

// ---------- Lobby render ----------
function renderLobby() {
  if (!app.lobby) return;
  $("#lobby-code").textContent = app.lobby.code;
  $("#lobby-mode").textContent = app.lobby.mode === "4P" ? "4 PLAYERS" : "2 PLAYERS";
  const slotsUl = $("#lobby-slots");
  slotsUl.innerHTML = "";
  for (const s of app.lobby.slots) {
    const li = document.createElement("li");
    li.className = "slot-row";
    const mine = s.playerId && s.playerId === app.playerId;
    const open = !s.playerId;
    li.dataset.open = open ? "true" : "false";
    li.dataset.mine = mine ? "true" : "false";
    li.dataset.connected = s.connected ? "true" : "false";

    const arrow = document.createElement("span");
    arrow.className = "slot-arrow";
    arrow.textContent = arrowFor(s.slot);

    const name = document.createElement("span");
    name.className = "slot-name";
    name.textContent = s.name ? s.name : "— OPEN —";

    const ready = document.createElement("span");
    ready.className = "slot-ready";
    ready.textContent = s.ready ? "READY" : open ? "" : "WAIT";

    li.append(arrow, name, ready);
    if (open) {
      li.addEventListener("click", () => send({ type: "claim_slot", slot: s.slot }));
    }
    slotsUl.append(li);
  }

  const readyBtn = $("#ready-btn");
  const startBtn = $("#start-btn");
  const iAm = app.lobby.slots.find((s) => s.playerId === app.playerId);
  readyBtn.disabled = !iAm || !iAm.slot;
  readyBtn.textContent = iAm && iAm.ready ? "UNREADY" : "READY";

  const isHost = app.playerId === app.lobby.hostId;
  startBtn.hidden = !isHost;
  startBtn.disabled = !app.lobby.canStart;

  if (!iAm?.slot) {
    setStatus("lobby-status", "TAP AN ARROW TO CLAIM IT");
  } else if (!iAm.ready) {
    setStatus("lobby-status", "TAP READY WHEN YOU'RE SET");
  } else if (!app.lobby.canStart) {
    setStatus("lobby-status", "WAITING FOR OTHERS…");
  } else if (isHost) {
    setStatus("lobby-status", "TAP START TO BEGIN");
  } else {
    setStatus("lobby-status", "WAITING FOR HOST…");
  }
}

function arrowFor(slot) {
  return { UP: "▲", DOWN: "▼", LEFT: "◀", RIGHT: "▶" }[slot] || "?";
}

// ---------- Play render ----------
function renderPlay() {
  if (!app.game) return;
  $("#hud-score").textContent = String(app.game.score).padStart(4, "0");
  $("#hud-length").textContent = String(app.game.length).padStart(2, "0");

  // Slot strip — in 4P show 4 cells, in 2P show 2 axis cells.
  const strip = $("#slot-strip");
  strip.innerHTML = "";
  const is2P = app.mode === "2P";
  strip.style.gridTemplateColumns = is2P ? "repeat(2, 1fr)" : "repeat(4, 1fr)";

  const displaySlots = is2P ? ["UP", "LEFT"] : ["UP", "DOWN", "LEFT", "RIGHT"];
  for (const slot of displaySlots) {
    const info = app.game.slots.find((s) => s.slot === slot);
    const li = document.createElement("li");
    li.className = "strip-cell";
    if (info && info.playerId === app.playerId) li.dataset.mine = "true";
    li.dataset.connected = info && info.connected ? "true" : "false";
    li.dataset.slot = slot;

    const arr = document.createElement("div");
    arr.className = "cell-arrow";
    arr.textContent = is2P ? (slot === "UP" ? "▲▼" : "◀▶") : arrowFor(slot);

    const name = document.createElement("div");
    name.className = "cell-name";
    if (!info || !info.playerId) name.textContent = "—";
    else if (info.connected) name.textContent = info.name || "";
    else name.textContent = "OFF";

    li.append(arr, name);
    strip.append(li);
  }

  // Mark d-pad button ownership.
  for (const btn of $$(".dpad-btn")) {
    const dir = btn.dataset.dir;
    const owned = ownsDir(app.mode, app.mySlot, dir);
    btn.dataset.own = owned ? "true" : "false";
    btn.dataset.active = app.screen === "play" ? "true" : "false";
  }

  render($("#board"), app.game);
}

function renderGameOver(msg) {
  $("#over-cause").textContent = msg.cause === "WALL" ? "HIT THE WALL" : "BIT YOURSELF";
  $("#over-score").textContent = String(msg.score).padStart(4, "0");
  const isHost = app.playerId === app.hostId;
  $("#restart-btn").hidden = !isHost;
  setStatus("over-status", isHost ? "TAP PLAY AGAIN OR LEAVE" : "WAITING FOR HOST…");
}

function ownsDir(mode, slot, dir) {
  if (!slot) return false;
  if (mode === "4P") return slot === dir;
  if (mode === "2P") {
    if (slot === "UP") return dir === "UP" || dir === "DOWN";
    if (slot === "LEFT") return dir === "LEFT" || dir === "RIGHT";
  }
  return false;
}

// ---------- Input ----------
function pulseDir(dir) {
  // In 4P, each dir has its own cell. In 2P, UP/DOWN share the UP cell and LEFT/RIGHT share LEFT.
  let cellSlot = dir;
  if (app.mode === "2P") {
    cellSlot = dir === "UP" || dir === "DOWN" ? "UP" : "LEFT";
  }
  const cell = document.querySelector(`.strip-cell[data-slot="${cellSlot}"]`);
  if (!cell) return;
  cell.dataset.pulse = "true";
  setTimeout(() => {
    if (cell) cell.dataset.pulse = "false";
  }, 120);
}

function handleDir(dir) {
  if (app.screen !== "play") return;
  if (!ownsDir(app.mode, app.mySlot, dir)) return;
  send({ type: "turn", dir });
  pulseDir(dir);
}

// Keyboard
window.addEventListener("keydown", (e) => {
  // Don't intercept keys while the user is typing in a form field.
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
    return;
  }
  const key = e.key;
  const map = {
    ArrowUp: "UP",
    ArrowDown: "DOWN",
    ArrowLeft: "LEFT",
    ArrowRight: "RIGHT",
    w: "UP",
    W: "UP",
    s: "DOWN",
    S: "DOWN",
    a: "LEFT",
    A: "LEFT",
    d: "RIGHT",
    D: "RIGHT",
  };
  const dir = map[key];
  if (dir) {
    e.preventDefault();
    handleDir(dir);
  }
});

// D-pad taps
for (const btn of $$(".dpad-btn")) {
  btn.addEventListener("click", () => {
    const dir = btn.dataset.dir;
    handleDir(dir);
  });
}

// ---------- Button actions ----------
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  switch (action) {
    case "go-create": {
      // Pre-fill name from session.
      $("#create-name").value = app.name || "";
      showScreen("create");
      break;
    }
    case "go-join": {
      $("#join-name").value = app.name || "";
      setStatus("join-status", "");
      showScreen("join");
      break;
    }
    case "back-landing":
      showScreen("landing");
      break;
    case "create-submit": {
      const name = $("#create-name").value.trim() || "YOU";
      app.name = name;
      saveSession();
      connect(() => {
        send({
          type: "create_room",
          mode: app.mode,
          name,
        });
      });
      break;
    }
    case "join-submit": {
      const code = $("#join-code").value.trim().toUpperCase();
      const name = $("#join-name").value.trim() || "YOU";
      if (code.length !== 4) {
        setStatus("join-status", "NEED 4-CHAR CODE");
        return;
      }
      app.name = name;
      saveSession();
      setStatus("join-status", "JOINING…");
      connect(() => {
        send({ type: "join_room", code, name, playerId: app.playerId });
      });
      break;
    }
    case "copy-code": {
      if (app.lobby?.code) {
        navigator.clipboard?.writeText(app.lobby.code).catch(() => {});
        setStatus("lobby-status", "CODE COPIED");
      }
      break;
    }
    case "ready": {
      const iAm = app.lobby?.slots.find((s) => s.playerId === app.playerId);
      const newReady = !(iAm && iAm.ready);
      send({ type: "ready", ready: newReady });
      break;
    }
    case "start":
      send({ type: "start" });
      break;
    case "restart":
      send({ type: "restart" });
      break;
    case "leave": {
      clearSession();
      app.roomCode = null;
      app.playerId = null;
      app.lobby = null;
      app.game = null;
      if (app.ws) {
        try {
          app.ws.close();
        } catch {}
      }
      showScreen("landing");
      break;
    }
  }
});

// Mode toggle on create
for (const btn of $$(".toggle-btn")) {
  btn.addEventListener("click", () => {
    $$(".toggle-btn").forEach((b) => b.classList.toggle("is-on", b === btn));
    app.mode = btn.dataset.mode;
  });
}

// Uppercase inputs live
for (const id of ["create-name", "join-name", "join-code"]) {
  const el = document.getElementById(id);
  if (!el) continue;
  el.addEventListener("input", () => {
    el.value = el.value.toUpperCase();
  });
}

// ---------- Heartbeat ----------
setInterval(() => {
  if (app.ws && app.ws.readyState === WebSocket.OPEN) {
    send({ type: "ping" });
  }
}, 10000);

// Resize → re-render board.
window.addEventListener("resize", () => {
  if (app.screen === "play") renderPlay();
});

// ---------- Boot ----------
(function boot() {
  showScreen("landing");
  // Silent rejoin: if a stored session is still valid, the `room_joined`
  // handler will route us into the lobby/play screen. If not, we just stay
  // on landing. No overlay — cold reloads shouldn't flash a loading state.
  if (app.roomCode && app.playerId) {
    connect(() => {
      send({
        type: "join_room",
        code: app.roomCode,
        name: app.name || "YOU",
        playerId: app.playerId,
      });
    });
    // Auto-forget the stale session after 3s if we didn't land anywhere.
    setTimeout(() => {
      if (app.screen === "landing") {
        clearSession();
        app.roomCode = null;
        app.playerId = null;
        cancelReconnect();
        hideOverlay();
      }
    }, 3000);
  }
})();
