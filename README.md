# Team Snake

A networked co-op Nokia-style Snake. Each player controls one direction —
nobody can steer the snake alone.

- **2P mode:** P1 = ↑/↓, P2 = ←/→
- **4P mode:** one direction each

## Run locally

```bash
npm install
npm start
```

Open http://localhost:8080 in two or four browser tabs (or on your phone via
`http://<your-laptop-lan-ip>:8080`). One person creates a room, the others
join with the 4-char code, everyone claims a direction, and the host starts.

Keyboard (laptop): Arrow keys or WASD.
Touch (phone): the on-screen D-pad below the screen.

## What's in v1

- Room lifecycle: create, join, 4-char code, slot picker, ready check
- Server-authoritative game loop (Node + `ws`)
- Canvas LCD rendering in Nokia 3310 style
- Keyboard + on-screen D-pad input
- `sessionStorage`-based reconnect (refresh the page and you rejoin your slot)
- Two-tab eviction (opening the same session twice kicks the first)
- Room idle timeout (10 min)
- 2P and 4P modes
- Auto-speed-up with length

## What's not in v1 (next)

- Global leaderboard (SQLite + Fly volume)
- Fly.io deploy
- Sound (skipped intentionally)
- Spectator mode for late joiners

## File layout

```
server.js                  Node HTTP + WebSocket server
game/
  snake.js                 Pure game logic (unit-testable)
  room.js                  Room lifecycle + player management
public/
  index.html               Shell + all screens
  style.css                Nokia 3310 shell + LCD palette
  client.js                Screen routing, WebSocket, input
  render.js                Canvas board renderer
```

## Smoke tests

End-to-end tests live in `.agents/artifacts/`. Run them with the server
already running:

```bash
node .agents/artifacts/smoke-test.mjs        # 2P start + movement
node .agents/artifacts/smoke-test-death.mjs  # 4P → run into wall → game_over
```
