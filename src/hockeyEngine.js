// Vanilla canvas physics engine for the hockey battle mini-game.
// Deliberately framework-agnostic — the game loop is imperative and runs
// outside React's render cycle. A component mounts it via createHockeyEngine
// and must call destroy() on unmount.
export function createHockeyEngine({ canvas, field, onScoreChange, onGrabChange }) {
  const ctx = canvas.getContext("2d");

  // Reference design width. All gameplay constants are defined relative to
  // this and rescaled by `scale` whenever the viewport changes. The field
  // always fills the full viewport — no letterboxing.
  const REF_W = 540;

  const BASE = {
    puckR: 30,
    minSpeed: 0.02,
    maxThrowSpeed: 30,
  };

  const FRICTION = 0.992; // per-substep velocity damping
  const RESTITUTION_WALL = 0.85;
  const RESTITUTION_PUCK = 0.95;
  const SUBSTEPS = 4;

  // The field is a grid of cells ("ladrillos"). Two kinds for now: wall
  // cells form a one-cell-thick ring that closes off the field, floor
  // cells are the playable area inside that ring. A mid-field wall (also
  // made of wall cells) splits the field with a gap pucks can pass through.
  const GRID_COLS = 9;
  const MID_WALL_GAP = 3;

  let W = REF_W;
  let H = REF_W * (16 / 9);
  let scale = 1;
  let cellW = 0;
  let cellH = 0;
  let gridRows = 0;
  let midWallRow = 0;
  let midWallCols = [];
  let midWallRects = [];
  let PUCK_R = BASE.puckR;
  let MIN_SPEED = BASE.minSpeed;
  let MAX_THROW_SPEED = BASE.maxThrowSpeed;

  const bounds = { left: 0, right: 0, top: 0, bottom: 0 };

  function updateBounds() {
    bounds.left = cellW + PUCK_R;
    bounds.right = W - cellW - PUCK_R;
    bounds.top = cellH + PUCK_R;
    bounds.bottom = H - cellH - PUCK_R;
  }

  function buildMidWall() {
    midWallRow = Math.floor(gridRows / 2);
    const playableCols = GRID_COLS - 2; // excludes the border wall columns
    const gapStart = 1 + Math.floor((playableCols - MID_WALL_GAP) / 2);
    const gapEnd = gapStart + MID_WALL_GAP - 1;

    midWallCols = [];
    for (let col = 1; col < GRID_COLS - 1; col++) {
      if (col < gapStart || col > gapEnd) midWallCols.push(col);
    }

    midWallRects = midWallCols.map((col) => ({
      x: col * cellW,
      y: midWallRow * cellH,
      w: cellW,
      h: cellH,
    }));
  }

  function resize() {
    // Fill the entire viewport — no letterboxing. The field's own aspect
    // ratio simply follows whatever the viewport's is (portrait on phones).
    const targetW = window.innerWidth;
    const targetH = window.innerHeight;

    const newScale = targetW / REF_W;
    const oldW = W;
    const factor = oldW > 0 ? targetW / oldW : 1;

    W = targetW;
    H = targetH;
    scale = newScale;
    PUCK_R = BASE.puckR * scale;
    MIN_SPEED = BASE.minSpeed * scale;
    MAX_THROW_SPEED = BASE.maxThrowSpeed * scale;

    cellW = W / GRID_COLS;
    gridRows = Math.max(3, Math.round(H / cellW));
    cellH = H / gridRows;

    buildMidWall();
    updateBounds();

    field.style.width = `${targetW}px`;
    field.style.height = `${targetH}px`;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(targetW * dpr);
    canvas.height = Math.round(targetH * dpr);
    canvas.style.width = `${targetW}px`;
    canvas.style.height = `${targetH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (pucks && pucks.length && factor !== 1 && oldW > 0) {
      for (const puck of pucks) {
        puck.x *= factor;
        puck.y *= factor;
        puck.vx *= factor;
        puck.vy *= factor;
        puck.r = PUCK_R;
      }
    }
  }

  function makePuck(x, y, isPlayer) {
    return {
      x, y, vx: 0, vy: 0,
      r: PUCK_R,
      isPlayer: !!isPlayer,
      grabbed: false,
    };
  }

  function initialLayout() {
    const list = [];
    list.push(makePuck(W / 2, H * 0.87, true));
    const cols = 3, rows = 2;
    const colGap = W * 0.24;
    const rowGap = H * 0.075;
    const startX = W / 2 - ((cols - 1) * colGap) / 2;
    const startY = H * 0.16;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        list.push(makePuck(startX + c * colGap, startY + r * rowGap, false));
      }
    }
    return list;
  }

  let pucks = [];
  let explosions = [];
  let collisionCount = 0;
  let toRemove = new Set();

  function resetGame() {
    pucks = initialLayout();
    explosions = [];
    collisionCount = 0;
    drag = null;
    updateScore();
  }

  function updateScore() {
    onScoreChange(collisionCount);
  }

  // ---- Pointer / drag handling ----
  let drag = null; // { puck, history: [{x,y,t}] }

  function canvasPoint(evt) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = W / rect.width;
    const scaleY = H / rect.height;
    const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
    const clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  function pointerDown(evt) {
    const p = canvasPoint(evt);
    const player = pucks.find((pk) => pk.isPlayer);
    if (!player) return;
    const dx = p.x - player.x;
    const dy = p.y - player.y;
    if (Math.hypot(dx, dy) <= player.r * 1.4) {
      drag = { puck: player, history: [{ x: p.x, y: p.y, t: performance.now() }] };
      player.grabbed = true;
      player.vx = 0;
      player.vy = 0;
      onGrabChange(true);
      evt.preventDefault();
    }
  }

  function pointerMove(evt) {
    if (!drag) return;
    const p = canvasPoint(evt);
    const puck = drag.puck;
    puck.x = clamp(p.x, bounds.left, bounds.right);
    puck.y = clamp(p.y, bounds.top, bounds.bottom);
    drag.history.push({ x: p.x, y: p.y, t: performance.now() });
    if (drag.history.length > 6) drag.history.shift();
    evt.preventDefault();
  }

  function pointerUp(evt) {
    if (!drag) return;
    const puck = drag.puck;
    puck.grabbed = false;
    const hist = drag.history;
    if (hist.length >= 2) {
      const a = hist[0];
      const b = hist[hist.length - 1];
      const dt = Math.max(1, b.t - a.t);
      const throwScale = 16; // ms-per-frame-ish scale to turn px/ms into a nice px/frame speed
      puck.vx = ((b.x - a.x) / dt) * throwScale;
      puck.vy = ((b.y - a.y) / dt) * throwScale;
      const speed = Math.hypot(puck.vx, puck.vy);
      if (speed > MAX_THROW_SPEED) {
        puck.vx = (puck.vx / speed) * MAX_THROW_SPEED;
        puck.vy = (puck.vy / speed) * MAX_THROW_SPEED;
      }
    }
    drag = null;
    onGrabChange(false);
  }

  canvas.addEventListener("mousedown", pointerDown);
  window.addEventListener("mousemove", pointerMove);
  window.addEventListener("mouseup", pointerUp);
  canvas.addEventListener("touchstart", pointerDown, { passive: false });
  window.addEventListener("touchmove", pointerMove, { passive: false });
  window.addEventListener("touchend", pointerUp);

  let resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 60);
  }
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", resize);

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function resolveWallCellCollision(puck, rect) {
    const closestX = clamp(puck.x, rect.x, rect.x + rect.w);
    const closestY = clamp(puck.y, rect.y, rect.y + rect.h);
    const dx = puck.x - closestX;
    const dy = puck.y - closestY;
    const distSq = dx * dx + dy * dy;
    if (distSq >= puck.r * puck.r) return;

    let nx, ny, penetration;
    const dist = Math.sqrt(distSq);
    if (dist > 0) {
      nx = dx / dist;
      ny = dy / dist;
      penetration = puck.r - dist;
    } else {
      // Center is inside the rect (fast-moving puck tunneled in) — push
      // out along whichever axis needs the least travel.
      const left = puck.x - rect.x;
      const right = rect.x + rect.w - puck.x;
      const top = puck.y - rect.y;
      const bottom = rect.y + rect.h - puck.y;
      const min = Math.min(left, right, top, bottom);
      nx = min === left ? -1 : min === right ? 1 : 0;
      ny = min === top ? -1 : min === bottom ? 1 : 0;
      penetration = puck.r + min;
    }

    puck.x += nx * penetration;
    puck.y += ny * penetration;

    const vDotN = puck.vx * nx + puck.vy * ny;
    if (vDotN < 0) {
      puck.vx -= (1 + RESTITUTION_WALL) * vDotN * nx;
      puck.vy -= (1 + RESTITUTION_WALL) * vDotN * ny;
    }
  }

  // ---- Physics ----
  function step() {
    toRemove = new Set();

    for (const puck of pucks) {
      if (puck.grabbed) continue;

      puck.x += puck.vx;
      puck.y += puck.vy;
      puck.vx *= FRICTION;
      puck.vy *= FRICTION;
      if (Math.hypot(puck.vx, puck.vy) < MIN_SPEED) {
        puck.vx = 0;
        puck.vy = 0;
      }

      if (puck.x < bounds.left) {
        puck.x = bounds.left;
        puck.vx = Math.abs(puck.vx) * RESTITUTION_WALL;
      } else if (puck.x > bounds.right) {
        puck.x = bounds.right;
        puck.vx = -Math.abs(puck.vx) * RESTITUTION_WALL;
      }
      if (puck.y < bounds.top) {
        puck.y = bounds.top;
        puck.vy = Math.abs(puck.vy) * RESTITUTION_WALL;
      } else if (puck.y > bounds.bottom) {
        puck.y = bounds.bottom;
        puck.vy = -Math.abs(puck.vy) * RESTITUTION_WALL;
      }

      for (const rect of midWallRects) resolveWallCellCollision(puck, rect);
    }

    // puck-puck collisions
    for (let i = 0; i < pucks.length; i++) {
      for (let j = i + 1; j < pucks.length; j++) {
        resolveCollision(pucks[i], pucks[j]);
      }
    }

    if (toRemove.size) {
      pucks = pucks.filter((p) => !toRemove.has(p));
    }
  }

  function spawnExplosion(x, y, r) {
    const count = 10;
    const particles = [];
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      particles.push({
        angle,
        speed: (0.6 + Math.random() * 1.4) * scale,
        size: r * (0.18 + Math.random() * 0.18),
      });
    }
    explosions.push({ x, y, r, t: 0, duration: 24, particles });
  }

  function resolveCollision(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const minDist = a.r + b.r;
    if (dist === 0 || dist >= minDist) return;

    // The player's puck destroys whatever it hits on contact — it still
    // bounces back off the impact like it hit something solid, but the
    // target explodes and is removed instead of bouncing itself.
    // Non-player pucks still bounce off each other normally.
    if (a.isPlayer !== b.isPlayer) {
      const target = a.isPlayer ? b : a;
      const impactor = a.isPlayer ? a : b;
      if (!toRemove.has(target)) {
        toRemove.add(target);
        spawnExplosion(target.x, target.y, target.r);
        collisionCount++;
        updateScore();
      }

      const nix = (impactor.x - target.x) / dist;
      const niy = (impactor.y - target.y) / dist;
      const closingSpeed = impactor.vx * nix + impactor.vy * niy;
      if (closingSpeed < 0) {
        impactor.vx -= (1 + RESTITUTION_PUCK) * closingSpeed * nix;
        impactor.vy -= (1 + RESTITUTION_PUCK) * closingSpeed * niy;
      }
      return;
    }

    const nx = dx / dist;
    const ny = dy / dist;

    // separate overlapping pucks
    const overlap = minDist - dist;
    if (a.grabbed && !b.grabbed) {
      b.x += nx * overlap;
      b.y += ny * overlap;
    } else if (b.grabbed && !a.grabbed) {
      a.x -= nx * overlap;
      a.y -= ny * overlap;
    } else {
      a.x -= (nx * overlap) / 2;
      a.y -= (ny * overlap) / 2;
      b.x += (nx * overlap) / 2;
      b.y += (ny * overlap) / 2;
    }

    // relative velocity along normal
    const rvx = b.vx - a.vx;
    const rvy = b.vy - a.vy;
    const velAlongNormal = rvx * nx + rvy * ny;
    if (velAlongNormal > 0) return; // already separating

    const impulse = -(1 + RESTITUTION_PUCK) * velAlongNormal / 2;
    const ix = impulse * nx;
    const iy = impulse * ny;

    if (!a.grabbed) {
      a.vx -= ix;
      a.vy -= iy;
    }
    if (!b.grabbed) {
      b.vx += ix;
      b.vy += iy;
    }

    collisionCount++;
    updateScore();
  }

  // ---- Rendering ----
  // The field itself is a grid of cells: a one-cell wall ring closes it
  // off, and floor cells fill the playable area inside that ring.
  function drawWallCell(row, col) {
    const x = col * cellW;
    const y = row * cellH;
    const grad = ctx.createLinearGradient(x, y, x + cellW, y + cellH);
    grad.addColorStop(0, "#2a5085");
    grad.addColorStop(1, "#132844");
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, cellW, cellH);

    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = Math.max(1, scale);
    ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);

    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = Math.max(1, scale);
    ctx.beginPath();
    ctx.moveTo(x + 1, y + cellH - 1);
    ctx.lineTo(x + 1, y + 1);
    ctx.lineTo(x + cellW - 1, y + 1);
    ctx.stroke();
  }

  function drawField() {
    ctx.clearRect(0, 0, W, H);

    const floorLeft = cellW;
    const floorTop = cellH;
    const floorRight = W - cellW;
    const floorBottom = H - cellH;

    // floor cells — one continuous ice sheet with tile seams
    const grad = ctx.createLinearGradient(0, floorTop, 0, floorBottom);
    grad.addColorStop(0, "#dff4ff");
    grad.addColorStop(1, "#b7e2fb");
    ctx.fillStyle = grad;
    ctx.fillRect(floorLeft, floorTop, floorRight - floorLeft, floorBottom - floorTop);

    ctx.strokeStyle = "rgba(27, 58, 99, 0.08)";
    ctx.lineWidth = Math.max(1, scale);
    for (let col = 1; col < GRID_COLS - 1; col++) {
      const x = col * cellW;
      ctx.beginPath();
      ctx.moveTo(x, floorTop);
      ctx.lineTo(x, floorBottom);
      ctx.stroke();
    }
    for (let row = 1; row < gridRows - 1; row++) {
      const y = row * cellH;
      ctx.beginPath();
      ctx.moveTo(floorLeft, y);
      ctx.lineTo(floorRight, y);
      ctx.stroke();
    }

    // wall cells — the ring that closes off the field
    for (let col = 0; col < GRID_COLS; col++) {
      drawWallCell(0, col);
      drawWallCell(gridRows - 1, col);
    }
    for (let row = 1; row < gridRows - 1; row++) {
      drawWallCell(row, 0);
      drawWallCell(row, GRID_COLS - 1);
    }

    // mid-field wall — same wall cells, with a gap pucks can pass through
    for (const col of midWallCols) drawWallCell(midWallRow, col);
  }

  function drawPuck(puck) {
    const grad = ctx.createRadialGradient(
      puck.x - puck.r * 0.3, puck.y - puck.r * 0.3, puck.r * 0.2,
      puck.x, puck.y, puck.r
    );
    if (puck.isPlayer) {
      grad.addColorStop(0, "#ffb066");
      grad.addColorStop(1, "#b85f14");
    } else {
      grad.addColorStop(0, "#4b5b78");
      grad.addColorStop(1, "#171d29");
    }

    ctx.beginPath();
    ctx.ellipse(puck.x, puck.y + puck.r * 0.65, puck.r * 0.9, puck.r * 0.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(puck.x, puck.y, puck.r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = puck.grabbed ? 3 : 1.5;
    ctx.strokeStyle = puck.grabbed ? "#fff" : "rgba(255,255,255,0.4)";
    ctx.stroke();

    drawFace(puck);
  }

  function drawFace(puck) {
    const r = puck.r;

    // eyes glance slightly toward the direction the puck is moving
    const speed = Math.hypot(puck.vx, puck.vy);
    let lookX = 0, lookY = 0;
    if (speed > 0.4) {
      lookX = (puck.vx / speed) * r * 0.09;
      lookY = (puck.vy / speed) * r * 0.09;
    }

    const eyeR = r * 0.3;
    const pupilR = eyeR * 0.48;
    const eyeOffsetX = r * 0.34;
    const eyeOffsetY = r * -0.08;
    const eyes = [
      { x: puck.x - eyeOffsetX, y: puck.y + eyeOffsetY },
      { x: puck.x + eyeOffsetX, y: puck.y + eyeOffsetY },
    ];

    for (const eye of eyes) {
      ctx.beginPath();
      ctx.arc(eye.x, eye.y, eyeR, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.lineWidth = Math.max(1, r * 0.03);
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(eye.x + lookX, eye.y + lookY, pupilR, 0, Math.PI * 2);
      ctx.fillStyle = "#1a1a1a";
      ctx.fill();

      ctx.beginPath();
      ctx.arc(eye.x + lookX - pupilR * 0.35, eye.y + lookY - pupilR * 0.35, pupilR * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fill();
    }

    // smiling mouth
    ctx.beginPath();
    ctx.arc(puck.x, puck.y + r * 0.32, r * 0.32, Math.PI * 0.12, Math.PI * 0.88);
    ctx.lineWidth = Math.max(1.5, r * 0.07);
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineCap = "round";
    ctx.stroke();

    // rosy cheeks
    ctx.fillStyle = puck.isPlayer ? "rgba(255,255,255,0.25)" : "rgba(255,150,150,0.3)";
    ctx.beginPath();
    ctx.ellipse(puck.x - eyeOffsetX * 1.05, puck.y + r * 0.3, r * 0.14, r * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(puck.x + eyeOffsetX * 1.05, puck.y + r * 0.3, r * 0.14, r * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function updateExplosions() {
    for (let i = explosions.length - 1; i >= 0; i--) {
      explosions[i].t++;
      if (explosions[i].t > explosions[i].duration) explosions.splice(i, 1);
    }
  }

  function drawExplosions() {
    for (const ex of explosions) {
      const progress = ex.t / ex.duration;
      const alpha = 1 - progress;

      ctx.beginPath();
      ctx.arc(ex.x, ex.y, ex.r * (1 + progress * 1.5), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,180,60,${alpha * 0.8})`;
      ctx.lineWidth = Math.max(1, 3 * scale * (1 - progress));
      ctx.stroke();

      for (const p of ex.particles) {
        const dist = p.speed * ex.t;
        const px = ex.x + Math.cos(p.angle) * dist;
        const py = ex.y + Math.sin(p.angle) * dist;
        const size = Math.max(0, p.size * (1 - progress));
        if (size <= 0) continue;
        ctx.beginPath();
        ctx.arc(px, py, size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,140,40,${alpha})`;
        ctx.fill();
      }
    }
  }

  function render() {
    drawField();
    for (const puck of pucks) drawPuck(puck);
    updateExplosions();
    drawExplosions();
  }

  let rafId = null;
  let running = true;
  function loop() {
    if (!running) return;
    for (let i = 0; i < SUBSTEPS; i++) step();
    render();
    rafId = requestAnimationFrame(loop);
  }

  resize();
  pucks = initialLayout();
  updateScore();
  rafId = requestAnimationFrame(loop);

  function destroy() {
    running = false;
    if (rafId !== null) cancelAnimationFrame(rafId);
    clearTimeout(resizeTimer);
    canvas.removeEventListener("mousedown", pointerDown);
    window.removeEventListener("mousemove", pointerMove);
    window.removeEventListener("mouseup", pointerUp);
    canvas.removeEventListener("touchstart", pointerDown);
    window.removeEventListener("touchmove", pointerMove);
    window.removeEventListener("touchend", pointerUp);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("orientationchange", resize);
  }

  return { reset: resetGame, destroy };
}
