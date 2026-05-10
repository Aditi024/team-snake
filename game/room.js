// Room lifecycle: create, join, claim, ready, start, tick, end.
// One Room owns one game. All client input flows through here.

import { customAlphabet } from "nanoid";
import {
  newGame,
  requestTurn,
  tick,
  tickMsForLength,
  slotOwnsDirection,
  REQUIRED_SLOTS,
} from "./snake.js";

const nanoCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4);

// status: "LOBBY" | "PLAYING" | "OVER"
export class Room {
  constructor(code, mode, onDestroy) {
    this.code = code;
    this.mode = mode; // "2P" | "4P"
    this.status = "LOBBY";
    this.hostId = null;
    this.players = new Map(); // playerId -> { ws, name, slot, ready, connected }
    this.game = null;
    this.tickHandle = null;
    this.lastActivity = Date.now();
    this.onDestroy = onDestroy || (() => {});
  }

  // -- Lifecycle --
  touch() {
    this.lastActivity = Date.now();
  }

  destroy() {
    if (this.tickHandle) clearInterval(this.tickHandle);
    this.tickHandle = null;
    this.onDestroy(this);
  }

  // -- Players --
  addPlayer(playerId, ws, name) {
    this.touch();
    const isFirst = this.players.size === 0;
    const existing = this.players.get(playerId);
    if (existing) {
      // Reconnect: same playerId, new ws.
      existing.ws = ws;
      existing.connected = true;
      if (isFirst) this.hostId = playerId;
      return existing;
    }
    const player = {
      ws,
      name: sanitizeName(name),
      slot: null,
      ready: false,
      connected: true,
    };
    this.players.set(playerId, player);
    if (isFirst || !this.hostId) this.hostId = playerId;
    return player;
  }

  removePlayer(playerId) {
    this.touch();
    const player = this.players.get(playerId);
    if (!player) return;
    // Mid-game: keep the slot reservation; just mark disconnected.
    if (this.status === "PLAYING") {
      player.connected = false;
      return;
    }
    // In lobby/over: fully remove.
    this.players.delete(playerId);
    if (playerId === this.hostId) {
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }
    if (this.players.size === 0) this.destroy();
  }

  markDisconnected(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connected = false;
    this.touch();
  }

  // -- Slot claiming --
  claimSlot(playerId, slot) {
    if (this.status !== "LOBBY") return { ok: false, error: "NOT_LOBBY" };
    const player = this.players.get(playerId);
    if (!player) return { ok: false, error: "NO_PLAYER" };
    const allowed = REQUIRED_SLOTS[this.mode];
    if (!allowed.includes(slot)) return { ok: false, error: "BAD_SLOT" };
    // Is slot taken by another player?
    for (const [pid, p] of this.players) {
      if (pid !== playerId && p.slot === slot) return { ok: false, error: "SLOT_TAKEN" };
    }
    // Release previous slot and clear ready.
    player.slot = slot;
    player.ready = false;
    this.touch();
    return { ok: true };
  }

  setReady(playerId, ready) {
    const player = this.players.get(playerId);
    if (!player || !player.slot) return { ok: false, error: "NO_SLOT" };
    player.ready = !!ready;
    this.touch();
    return { ok: true };
  }

  canStart() {
    const required = REQUIRED_SLOTS[this.mode];
    const filled = new Set();
    for (const p of this.players.values()) {
      if (p.slot && p.ready && p.connected) filled.add(p.slot);
    }
    return required.every((s) => filled.has(s));
  }

  start(startTickFn) {
    if (this.status !== "LOBBY") return { ok: false, error: "NOT_LOBBY" };
    if (!this.canStart()) return { ok: false, error: "NOT_READY" };
    this.game = newGame();
    this.status = "PLAYING";
    this._scheduleTick(startTickFn);
    this.touch();
    return { ok: true };
  }

  restart(startTickFn) {
    if (this.status !== "OVER") return { ok: false, error: "NOT_OVER" };
    // Reset ready flags so players re-confirm is NOT required; we just replay.
    this.game = newGame();
    this.status = "PLAYING";
    this._scheduleTick(startTickFn);
    this.touch();
    return { ok: true };
  }

  _scheduleTick(broadcast) {
    if (this.tickHandle) clearInterval(this.tickHandle);
    const schedule = () => {
      const ms = tickMsForLength(this.game?.snake?.length ?? 3);
      this.tickHandle = setInterval(() => {
        if (!this.game) return;
        this.game = tick(this.game);
        broadcast(this);
        if (this.game.status === "OVER") {
          clearInterval(this.tickHandle);
          this.tickHandle = null;
          this.status = "OVER";
          broadcast(this);
          return;
        }
        // Adjust tick speed if length crossed a threshold.
        const nextMs = tickMsForLength(this.game.snake.length);
        if (nextMs !== ms) {
          clearInterval(this.tickHandle);
          this.tickHandle = null;
          schedule();
        }
      }, ms);
    };
    schedule();
  }

  // -- Turns --
  submitTurn(playerId, dir) {
    if (this.status !== "PLAYING" || !this.game) return { ok: false, error: "NOT_PLAYING" };
    const player = this.players.get(playerId);
    if (!player || !player.slot) return { ok: false, error: "NO_SLOT" };
    if (!slotOwnsDirection(this.mode, player.slot, dir)) {
      return { ok: false, error: "NOT_YOUR_DIR" };
    }
    this.game = requestTurn(this.game, dir);
    this.touch();
    return { ok: true };
  }

  // -- Snapshots --
  lobbySnapshot() {
    const slots = REQUIRED_SLOTS[this.mode].map((slot) => {
      const entry = [...this.players.entries()].find(([_, p]) => p.slot === slot);
      if (!entry) return { slot, playerId: null, name: null, ready: false, connected: false };
      const [pid, p] = entry;
      return { slot, playerId: pid, name: p.name, ready: p.ready, connected: p.connected };
    });
    return {
      code: this.code,
      mode: this.mode,
      status: this.status,
      hostId: this.hostId,
      slots,
      canStart: this.canStart(),
    };
  }

  stateSnapshot() {
    if (!this.game) return null;
    return {
      status: this.status,
      snake: this.game.snake,
      apple: this.game.apple,
      heading: this.game.heading,
      score: this.game.score,
      length: this.game.snake.length,
      tickMs: tickMsForLength(this.game.snake.length),
      cause: this.game.cause,
      mode: this.mode,
      slots: this.lobbySnapshot().slots,
    };
  }
}

export function makeRoomCode() {
  return nanoCode();
}

function sanitizeName(raw) {
  if (typeof raw !== "string") return "PLAYER";
  // Uppercase ASCII letters, digits, and space. Max 8 chars.
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .trim()
    .slice(0, 8);
  return cleaned || "PLAYER";
}
