// Canvas renderer. Draws the board, snake, and apple in Nokia LCD style.

const GRID_W = 20;
const GRID_H = 16;
const INK = "#1F2713";
const DIM = "#7A8A2E";

export function render(canvas, state) {
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  // Size the canvas to match CSS size * dpr once.
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const targetW = Math.floor(cssW * dpr);
  const targetH = Math.floor(cssH * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const cellW = canvas.width / GRID_W;
  const cellH = canvas.height / GRID_H;

  // Clear to LCD background (handled by CSS; we draw a faint dim grid for mood).
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Dim pixel grid — very subtle "unlit cells" feel.
  ctx.fillStyle = DIM;
  const dotSize = Math.max(1, Math.floor(cellW * 0.1));
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const px = Math.floor(x * cellW + cellW / 2 - dotSize / 2);
      const py = Math.floor(y * cellH + cellH / 2 - dotSize / 2);
      ctx.globalAlpha = 0.25;
      ctx.fillRect(px, py, dotSize, dotSize);
    }
  }
  ctx.globalAlpha = 1;

  if (!state) return;

  // Apple: 3x3 pixel cluster inside the cell.
  if (state.apple) {
    drawApple(ctx, state.apple.x, state.apple.y, cellW, cellH);
  }

  // Snake segments with 1-pixel inner gap so blocks read as pixels.
  if (state.snake) {
    for (let i = 0; i < state.snake.length; i++) {
      const seg = state.snake[i];
      drawCell(ctx, seg.x, seg.y, cellW, cellH, INK, i === 0);
    }
  }
}

function drawCell(ctx, gx, gy, cw, ch, color, isHead) {
  const pad = Math.max(1, Math.floor(cw * 0.08));
  const x = Math.floor(gx * cw + pad);
  const y = Math.floor(gy * ch + pad);
  const w = Math.ceil(cw - pad * 2);
  const h = Math.ceil(ch - pad * 2);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  if (isHead) {
    // Tiny "eye": one-pixel hole in the center for character.
    const eye = Math.max(1, Math.floor(cw * 0.15));
    const ex = x + Math.floor(w / 2 - eye / 2);
    const ey = y + Math.floor(h / 2 - eye / 2);
    ctx.clearRect(ex, ey, eye, eye);
  }
}

function drawApple(ctx, gx, gy, cw, ch) {
  // 3x3 pixel cluster, centered.
  const unit = Math.max(1, Math.floor(cw / 5));
  const cx = Math.floor(gx * cw + cw / 2 - unit * 1.5);
  const cy = Math.floor(gy * ch + ch / 2 - unit * 1.5);
  ctx.fillStyle = INK;
  // Plus-sign shape reads more "apple" than a square at this resolution.
  ctx.fillRect(cx + unit, cy, unit, unit);
  ctx.fillRect(cx, cy + unit, unit * 3, unit);
  ctx.fillRect(cx + unit, cy + unit * 2, unit, unit);
  // Stem
  ctx.fillRect(cx + unit, cy - unit, unit, unit);
}
