# Team Snake — Plan

A networked co-op Nokia-style Snake. Every player joins one website on any device,
enters a shared room code, and each player is locked to exactly one direction.
Nobody can steer the snake alone — teamwork or death.

---

## 1. Decisions Locked

| # | Decision | Choice |
|---|----------|--------|
| 1 | Transport | WebSocket, server-authoritative |
| 2 | Player count | Mode picker: 2P or 4P |
| 3 | Control split | 2P: P1 = ↑+↓, P2 = ←+→ · 4P: one direction per player |
| 4 | Movement | Classic auto-move (snake advances every tick) |
| 5 | Walls | Game over |
| 6 | Speed | Ramps up with length, floor-clamped |
| 7 | Unified UI | **One website. No host-vs-player split.** Every device — laptop or phone — joins by entering the same 4-char room code, sees the same board, and uses only its assigned direction(s). |
| 8 | Player drops | **Slot goes idle.** Game keeps running; their direction is uncontrollable until they rejoin. No pause. |
| 9 | Conflicting turns in one tick | **Last valid input before the tick wins** (server-authoritative, standard multiplayer convention). *[Reading your "Manners" answer as autocorrect of "server-authoritative last-wins" — flag if I'm wrong.]* |
| 10 | Sound | Skipped in v1. |
| 11 | High score | **Global leaderboard** (server-side, persistent). |
| 12 | Visual frame | **Full Nokia 3310 phone body shell** around the LCD. |
| 13 | Hosting | Public deploy (Fly.io free tier). *[Inferred from "common website they access on phone or laptop" — flag if you meant LAN-only.]* |

---

## 2. Architecture

### Authority model: server-authoritative
Server owns the snake, apple, score, tick timer. Clients send only `{type: "turn", dir}`; server validates the sender owns that direction for that room, buffers it, applies at next tick, broadcasts the new state.

### Tech stack
- **Server:** Node.js + `ws` (WebSockets) + `better-sqlite3` (leaderboard) + `nanoid` (room codes). Serves both the static client and the WebSocket.
- **Client:** `index.html` + `style.css` + `client.js` + `render.js`. Vanilla JS modules, Canvas 2D, no bundler.
- **Storage:** SQLite file on a Fly volume for the leaderboard. Rooms themselves are in-memory (ephemeral).
- **Deploy:** `fly launch` → `fly deploy`. Single process, single region to start.

### Why server-authoritative over peer-to-peer
- One source of truth → no desync across 2–4 clients.
- Turn ownership enforced server-side → can't cheat by sending a direction you don't own.
- Works across NATs without WebRTC.

### Message protocol

**Client → Server**
```
{type: "create_room", mode: "2P" | "4P", name}
{type: "join_room",   code, name}
{type: "claim_slot",  slot: "UP"|"DOWN"|"LEFT"|"RIGHT"}
{type: "ready"}
{type: "start"}                       // host only
{type: "turn",   dir: "UP"|"DOWN"|"LEFT"|"RIGHT"}
{type: "restart"}                     // host only, post-game-over
{type: "submit_score", name}          // on game over
{type: "leaderboard_request"}
{type: "ping"}                        // heartbeat
```

**Server → Client**
```
{type: "room_joined", code, playerId, role: "host"|"guest", mode}
{type: "lobby",       mode, slots: [{slot, playerId|null, name|null, ready}]}
{type: "state",       snake, apple, score, length, tickMs, status, activeDir, heading}
{type: "game_over",   score, cause, newHighScore: bool, rank: number|null}
{type: "leaderboard", entries: [{name, score, date}]}
{type: "error",       code, message}
{type: "pong"}
```

### State shape (server-side)
```
Room {
  code, mode, hostId, status: "LOBBY" | "PLAYING" | "OVER",
  players: Map<playerId, {ws, name, slot, ready, connected, lastSeen}>,
  game: {
    grid: {w: 20, h: 16},
    snake: [{x,y}, ...],            // head first
    heading: "UP",
    turnBuffer: "UP" | null,        // filled by last valid turn before tick
    apple: {x, y},
    score: 0,
    tickMs: 180,                    // shortens with length
    tickHandle,
    cause: null,                    // set on game over: "WALL"|"SELF"
  },
  createdAt, lastActivity
}
```

### Room lifecycle
- Created on `create_room`. Code = 4 upper-case letters (nanoid, ~456k combos, collision check on generation).
- Expires 10 min after last activity.
- If host disconnects and doesn't reconnect in 60s, host role transfers to earliest-joined remaining player.
- All players leave → room destroyed immediately.

---

## 3. Journey Map (applying `journey`)

### Primary user flow: 4P game, cold start

```
[Landing] → [Create or Join] → [Lobby: pick slot + ready] → [Play] → [Game Over]
                                    ↑                         ↓
                                    └── restart ──────────────┘
```

### Screen-by-screen with rationale

1. **Landing** — "TEAM SNAKE" logo + two big buttons: `CREATE ROOM` / `JOIN ROOM`.
   *Rationale:* Nokia games opened on the name screen. Two equal-weight actions because the asymmetry (host vs. guest) is a functional choice, not a hierarchy.

2. **Create Room** — Pick mode (2P/4P), enter your name, claim a starting slot. Server returns room code. Copy-to-clipboard button.
   *Rationale:* Name entry here, not later, because once the code is shared it's awkward to block the host on a form.

3. **Join Room** — Enter code, enter name, pick an available slot.
   *Rationale:* Slot picking happens *after* code validation so you don't fill a form for a non-existent room.

4. **Lobby** — Shows the 4-slot grid with names in each filled slot, a `READY` button, and (host only) a `START` button. Start is disabled until all required slots are filled AND everyone has pressed ready.
   *Rationale:* Ready check exists so nobody gets caught mid-bathroom-break when the game starts. Host is the single tap that triggers it — otherwise you get the "everybody waits for everybody" deadlock.

5. **Play** — Full Nokia LCD: grid + HUD (score, length) + 4-slot strip under the board showing which direction each player owns + the player's own direction highlighted. Below the LCD, one giant tap button labeled with the player's arrow (for phones). Keyboard keys also work (laptop).
   *Rationale:* Single unified view — no two modes to maintain. The phone-friendly tap button doubles as a visual affordance on laptop ("oh, THIS is my direction").

6. **Game Over** — LCD shows `GAME OVER`, final score, cause (`WALL` or `SELF`), your rank on the leaderboard if you made it, name entry if you broke the top 10. Host has a `PLAY AGAIN` button; guests wait.
   *Rationale:* Only the host restarts — otherwise two players tap "play again" and race.

### User variations

| User type | What's different |
|-----------|------------------|
| **Host** | Sees `START` and `PLAY AGAIN` buttons. Can kick a player from the lobby (stretch). |
| **Guest** | Joins via code. Can leave; can't start or restart. |
| **Reconnecting player** | Lands on the same slot they held, same playerId (stored in `sessionStorage`). If the game is mid-play, they drop straight into the Play screen. |
| **Late joiner** | If a round is in progress, they wait in a "spectate" mode and get placed into their slot at the next game. |

### Device variations

| Device | Primary differences |
|--------|---------------------|
| **Laptop** | Keyboard controls (arrows + WASD both work). Big LCD, phone body shell visible. Tap button is still there but secondary. |
| **Phone (portrait)** | LCD fills upper ~60% of screen. Giant tap button fills lower ~30%. Nokia phone body scales down. Touch is primary; keyboard hidden. |
| **Phone (landscape)** | Discouraged — we show a "rotate to portrait" hint. Portrait is the Nokia posture. |

### Copy specifications (draft)

| Screen | Element | Copy |
|--------|---------|------|
| Landing | Primary CTA | `CREATE ROOM` / `JOIN ROOM` |
| Landing | Subtitle | `A SNAKE GAME FOR THE TEAM` |
| Create | Mode toggle | `2 PLAYERS` / `4 PLAYERS` |
| Lobby | Waiting for players | `WAITING FOR PLAYERS — N/4` |
| Lobby | Waiting for ready | `TAP READY TO BEGIN` |
| Lobby | Host-only | `TAP START WHEN EVERYONE IS READY` |
| Play | Slot label | `↑ P1` `↓ P2` `← P3` `→ P4` (own slot inverted) |
| Play | Connection lost (own) | `RECONNECTING…` |
| Play | Teammate dropped | `P3 DISCONNECTED` (3 sec, then dims their slot) |
| Game Over | Cause | `HIT THE WALL` / `BIT YOURSELF` |
| Game Over | New high score | `NEW HIGH SCORE! #1 OF 10` |
| Game Over | Restart wait | `WAITING FOR HOST…` |

---

## 4. State Inventory (applying `fortify`)

Only non-trivial states listed.

| Screen | State | What the user sees | What they can do | Recovery / progress |
|--------|-------|--------------------|------------------|---------------------|
| Landing | Offline | "NO SIGNAL — CHECK YOUR CONNECTION" banner | Retry button | Reconnect → landing restores |
| Join Room | Invalid code | Inline "ROOM NOT FOUND" under the code input | Fix the code | Submit again |
| Join Room | Room full | "ROOM IS FULL" | Go back / try another code | — |
| Join Room | Game in progress | "THIS GAME IS ALREADY PLAYING — JOIN AS SPECTATOR?" | Accept or decline | Accept → spectate until next round |
| Lobby | Host left | "HOST LEFT — NEW HOST: [NAME]" | Continue | Auto, 1s toast |
| Lobby | Slot taken | Slot shows other player's name, dimmed tap | Pick another slot | — |
| Play | My socket dropped | `RECONNECTING…` overlay on the LCD, input disabled | Wait | Auto-reconnect with exponential backoff (1s, 2s, 4s, 8s) |
| Play | Teammate dropped | Their slot dims, their direction is uncontrollable | Play on | Their slot re-lights when they rejoin |
| Play | Phone screen locks | (game keeps running on server; their direction goes dark) | Unlock | On wake, client re-sends `ping`, server resyncs state |
| Play | Two tabs open by same player | Second tab sees "YOU'RE ALREADY IN THIS ROOM" | Close or kick first tab | First tab gets kicked if second claims |
| Play | Server crashes | "LOST SERVER — REFRESH" | Refresh | Room is gone, start over |
| Game Over | Leaderboard request times out | Local game-over still shown; leaderboard area shows "LEADERBOARD UNAVAILABLE" | Retry or skip | — |
| Game Over | Submitting score fails | "COULDN'T SAVE SCORE — RETRY?" | Retry or dismiss | — |

### Empty states
- **Leaderboard, zero scores:** `BE THE FIRST — PLAY A ROUND`
- **Lobby, zero other players:** `SHARE CODE: ABCD` displayed prominently with a copy button

### Loading states
- **Creating room:** brief (<300ms usual). Show `CREATING…` on the button, disable it.
- **Joining room:** `JOINING…`. On timeout (>5s), show "COULDN'T REACH SERVER" with retry.
- **Leaderboard fetch:** skeleton rows (dim blocks) for ~300ms max, then real entries.

### Overflow states
- **Snake fills the board:** tiny chance, but the speed floor prevents it getting unplayable. Apple can't spawn → show "YOU WIN" (unreachable except in theory; ship it anyway).
- **Leaderboard name:** max 8 chars, enforced client and server.
- **Score at 9999:** cap display at `9999+` to preserve the 4-digit HUD layout.

---

## 5. Edge Case Catalog (fortify, stress categories)

### Network
| Scenario | Handling |
|----------|----------|
| Connection drops mid-game | Client shows `RECONNECTING…`, input ignored. Server holds the slot for 30s. On reconnect, server sends current state; player resumes. |
| Connection intermittent (up 10s, down 5s) | Heartbeat every 3s. Missed 2 heartbeats → "reconnecting" overlay. Input is dropped during outages (no queueing — stale directions are dangerous). |
| Server unreachable at startup | Landing shows offline banner with retry. |
| High latency (>500ms) | Playable, but players see their direction apply 1 tick late. Small "PING: 540ms" indicator when >300ms so the team knows. |

### User behavior
| Scenario | Handling |
|----------|----------|
| Two players press conflicting directions the same tick | Last valid input before tick wins (server-side). Both see the applied direction. |
| Player reverses into their own direction (e.g. heading right, tries to go left) | Reject at server with no state change. No error shown — standard Snake. |
| Player spams their key | Only latest before each tick applies; extras are silently ignored. |
| Someone reloads the page mid-game | `sessionStorage` holds `{roomCode, playerId}`. On reload, client reconnects to the same slot. |
| Two tabs from same player | Second tab claim evicts first (server issues a `KICKED` message to first, then frees the slot for the second). |
| Phone screen locks | Socket eventually drops (iOS Safari ~30s). Treated as disconnect. On wake, reconnect. |
| Player closes the tab | Socket close → slot goes idle. Same as drop. |

### Content / device
| Scenario | Handling |
|----------|----------|
| Screen < 320px wide | LCD scales down but phone body shell simplifies (border only, no outer shell). |
| Screen > 1920px wide | LCD caps at 800px wide, centered. Phone body shell grows with a max. |
| Portrait phone | Default, optimal. |
| Landscape phone | Show hint `ROTATE TO PORTRAIT`. |
| 8-char name with emoji | Strip non-ASCII, pad/truncate. Display in pixel font — emoji won't render, we accept that. |
| Browser tab in background | WebSocket stays open if OS allows. When tab returns, game is in whatever state it's in. No pause. |

### Time
| Scenario | Handling |
|----------|----------|
| Player sits in lobby 10+ min | Room expires. Everyone gets `ROOM EXPIRED`. |
| Game runs 30+ min | Fine — no cap. Tick speed floor prevents instakill mode. |
| Server restart during a game | Room is lost. Clients get a `SERVER_RESTART` broadcast right before shutdown (where possible); on reconnect, they're bounced to landing. |

---

## 6. Visual Design

### Palette (strict)
- `--lcd-bg`: `#9BB03A` — olive-green LCD
- `--lcd-ink`: `#1F2713` — near-black pixel
- `--lcd-dim`: `#7A8A2E` — dead-pixel shadow
- `--phone-body`: `#2B2B2B` — dark gray Nokia plastic
- `--phone-edge`: `#4A4A4A` — plastic highlight

### Nokia 3310 shell
The whole page renders as a Nokia 3310 phone body in portrait:
- Rounded rectangle body, dark gray, faint plastic gradient.
- LCD screen inset with a thin inner bevel.
- Under the LCD: cosmetic directional pad (visual only on laptop; **on phones it becomes the real tap target for the player's direction**).
- Above the LCD: "NOKIA" wordmark in embossed gray, "TEAM SNAKE" below in small pixel text.
- Number keys below the D-pad: cosmetic on v1. Could become a keypad-based alternative in a future iteration.

### Grid & sprites
- 20 × 16 cells. 16px logical per cell, scaled up with `image-rendering: pixelated`.
- Snake segments drawn as filled squares with a 1px inner gap.
- Apple = 3×3 pixel cluster.
- Border = 2px dashed line around the play area, cycling 1px/frame to feel alive.

### Typography
- One pixel font: Press Start 2P (bundled).
- Sizes: 20px (title), 12px (HUD + lobby), 8px (fine print).

### Conformance to `sn-ui-checklist`
- 2 ink colors + 1 dim on LCD → **strict palette**.
- One font, 3 sizes → **disciplined typography**.
- Grid-based everything → **alignment discipline**.
- Mobile-first → **forces prioritization** (tactics).
- The phone body shell **is the product story** (tactics).

---

## 7. File Layout

```
team snake/
├── plan.md
├── package.json                      ← ws, better-sqlite3, nanoid
├── server.js                         ← HTTP + WS + game loop + leaderboard
├── db.js                             ← SQLite schema + queries
├── game/
│   ├── room.js                       ← Room class, lifecycle
│   ├── snake.js                      ← pure game logic (no IO)
│   └── protocol.js                   ← message schemas + validation
├── public/
│   ├── index.html
│   ├── style.css                     ← palette, shell, LCD
│   ├── client.js                     ← routing + WebSocket client + sessionStorage
│   ├── render.js                     ← canvas draw
│   └── assets/
│       └── PressStart2P.ttf
├── fly.toml                          ← deploy config
└── README.md
```

---

## 8. Build Order

Each step is independently runnable. Playable by step 6.

1. **HTTP + static serving** — Node serves `public/`. Open `index.html` in browser, see "TEAM SNAKE".
2. **WebSocket echo** — Prove the connection pipe works.
3. **Pure game logic** — `game/snake.js` with snake, apple, tick, collision. Unit-testable in isolation.
4. **Room lifecycle** — Create, join, claim slots, ready check, start. Lobby works; no game yet.
5. **Server game loop** — Tick runs, state broadcast, turns validated. Rendered via server logs only.
6. **Client render + input** — Canvas draws state; keyboard + tap button send turns. **Playable.**
7. **Screen routing** — Landing / Create / Join / Lobby / Play / GameOver. `sessionStorage` for reconnect.
8. **Nokia shell + polish** — Phone body, D-pad, pixel font, LCD bevel.
9. **Edge cases** — Disconnect/reconnect, host transfer, room expiry, two-tab eviction.
10. **SQLite + leaderboard** — Schema, submit score, fetch top 10, display on Game Over + landing.
11. **Fly deploy** — `fly launch`, persistent volume for SQLite, HTTPS, WebSocket upgrade.
12. **Stress testing pass** — run through the edge case catalog (§5) against deployed instance.

---

## 9. Risks

- **WebSocket idle on iOS Safari:** background tabs drop sockets fast. Heartbeat + reconnect logic is P0.
- **SQLite + Fly volume:** single region, single instance. Scaling is out of scope — if this game actually takes off we'd move leaderboard to Postgres + multi-region.
- **Public deploy means public abuse:** room code brute force, score submission forgery. For v1 I'll add rate limiting (10 req/s per IP) + a signed token tied to a completed game when submitting scores. Not bulletproof, good enough for a toy.
- **Global leaderboard gaming:** someone will try to POST a 99999 score. Server-side score validation — the server already tracks the real score from ticks, so `submit_score` just uses what the server already knows. Client never sends the number.
- **Two assumptions you didn't directly confirm** — flagged above. Override before I start:
  - *"Manners"* → I'm reading as "server-authoritative, last-wins." If you meant something else (first-wins, round-robin, priority by seat) say so.
  - *Hosting* → I'm assuming **Fly.io public deploy**. If you meant LAN only, the Fly stuff drops out and it's a 5-minute simpler plan.

---

## 10. What Happens Next

Confirm (or override) the two flagged assumptions in §9 and I'll start on step 1 of the build. I'll work through steps 1–6 in one pass so you can play-test before we spend time on polish and deploy.
