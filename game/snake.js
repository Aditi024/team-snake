// Pure game logic. No IO, no sockets, no timers.
// Everything is a function that takes state and returns new state.

export const GRID_W = 20;
export const GRID_H = 16;

export const DIRS = {
  UP: { x: 0, y: -1 },
  DOWN: { x: 0, y: 1 },
  LEFT: { x: -1, y: 0 },
  RIGHT: { x: 1, y: 0 },
};

export const OPPOSITE = {
  UP: "DOWN",
  DOWN: "UP",
  LEFT: "RIGHT",
  RIGHT: "LEFT",
};

export const INITIAL_TICK_MS = 220;
export const MIN_TICK_MS = 80;
// Shrink the tick interval by 8ms for every 3 apples eaten, floored.
export function tickMsForLength(length) {
  const apples = Math.max(0, length - 3);
  const step = Math.floor(apples / 3) * 8;
  return Math.max(MIN_TICK_MS, INITIAL_TICK_MS - step);
}

export function newGame() {
  // Snake starts length 3, middle-left, heading right.
  const midY = Math.floor(GRID_H / 2);
  const snake = [
    { x: 5, y: midY },
    { x: 4, y: midY },
    { x: 3, y: midY },
  ];
  return {
    snake,
    heading: "RIGHT",
    turnBuffer: null, // last valid turn request, applied at tick
    apple: spawnApple(snake, null),
    score: 0,
    cause: null, // "WALL" | "SELF" | null
    status: "PLAYING", // "PLAYING" | "OVER"
    tickCount: 0,
  };
}

export function spawnApple(snake, rng = Math.random) {
  // Pick a random cell that isn't a snake segment.
  const occupied = new Set(snake.map((s) => `${s.x},${s.y}`));
  const free = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (!occupied.has(`${x},${y}`)) free.push({ x, y });
    }
  }
  if (free.length === 0) return null; // win condition, unreachable in practice
  const idx = Math.floor((typeof rng === "function" ? rng() : Math.random()) * free.length);
  return free[idx];
}

// Apply a turn request. Rejects reversals and invalid directions.
// Returns new state (mutated turnBuffer only).
export function requestTurn(game, dir) {
  if (game.status !== "PLAYING") return game;
  if (!DIRS[dir]) return game;
  // Can't reverse directly into the current heading.
  if (OPPOSITE[game.heading] === dir) return game;
  return { ...game, turnBuffer: dir };
}

// Advance one tick. Returns new state.
export function tick(game, rng = Math.random) {
  if (game.status !== "PLAYING") return game;

  // Apply buffered turn.
  let heading = game.heading;
  if (game.turnBuffer && OPPOSITE[heading] !== game.turnBuffer) {
    heading = game.turnBuffer;
  }

  const head = game.snake[0];
  const delta = DIRS[heading];
  const nextHead = { x: head.x + delta.x, y: head.y + delta.y };

  // Wall collision.
  if (nextHead.x < 0 || nextHead.x >= GRID_W || nextHead.y < 0 || nextHead.y >= GRID_H) {
    return { ...game, status: "OVER", cause: "WALL", heading, turnBuffer: null };
  }

  const eating = game.apple && nextHead.x === game.apple.x && nextHead.y === game.apple.y;

  // Build next body. If eating, snake grows (don't drop the tail).
  const nextBody = [nextHead, ...game.snake];
  if (!eating) nextBody.pop();

  // Self collision (check against the body that will exist AFTER move).
  // Head vs rest of body.
  for (let i = 1; i < nextBody.length; i++) {
    if (nextBody[i].x === nextHead.x && nextBody[i].y === nextHead.y) {
      return { ...game, status: "OVER", cause: "SELF", heading, turnBuffer: null };
    }
  }

  let apple = game.apple;
  let score = game.score;
  if (eating) {
    apple = spawnApple(nextBody, rng);
    score += 10;
  }

  return {
    ...game,
    snake: nextBody,
    heading,
    turnBuffer: null,
    apple,
    score,
    tickCount: game.tickCount + 1,
  };
}

// Who owns which direction for each mode.
// 2P: P1 owns UP+DOWN, P2 owns LEFT+RIGHT.
// 4P: one direction each.
export function slotOwnsDirection(mode, slot, dir) {
  if (mode === "4P") return slot === dir;
  if (mode === "2P") {
    if (slot === "UP") return dir === "UP" || dir === "DOWN";
    if (slot === "LEFT") return dir === "LEFT" || dir === "RIGHT";
  }
  return false;
}

// Required slots for each mode (matching the keys above).
export const REQUIRED_SLOTS = {
  "2P": ["UP", "LEFT"],
  "4P": ["UP", "DOWN", "LEFT", "RIGHT"],
};
