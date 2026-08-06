(() => {
  const canvas = document.getElementById("rink");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.getElementById("score");
  const resetBtn = document.getElementById("resetBtn");

  const W = canvas.width;
  const H = canvas.height;
  const WALL = 20;          // playable-area inset from canvas edge
  const PUCK_R = 24;
  const FRICTION = 0.992;   // per-substep velocity damping
  const RESTITUTION_WALL = 0.85;
  const RESTITUTION_PUCK = 0.95;
  const MIN_SPEED = 0.02;   // below this, treat as stopped
  const SUBSTEPS = 4;

  const bounds = {
    left: WALL + PUCK_R,
    right: W - WALL - PUCK_R,
    top: WALL + PUCK_R,
    bottom: H - WALL - PUCK_R,
  };

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
    list.push(makePuck(W / 2, H - 90, true));
    const cols = 3, rows = 2;
    const startX = W / 2 - ((cols - 1) * 90) / 2;
    const startY = 130;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        list.push(makePuck(startX + c * 90, startY + r * 70, false));
      }
    }
    return list;
  }

  let pucks = initialLayout();
  let collisionCount = 0;

  function resetGame() {
    pucks = initialLayout();
    collisionCount = 0;
    drag = null;
    updateScore();
  }

  function updateScore() {
    scoreEl.textContent = `Rebotes: ${collisionCount}`;
  }

  // ---- Pointer / drag handling ----
  let drag = null; // { puck, offsetX, offsetY, history: [{x,y,t}] }

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
      canvas.classList.add("grabbing");
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
      const maxSpeed = 26;
      const speed = Math.hypot(puck.vx, puck.vy);
      if (speed > maxSpeed) {
        puck.vx = (puck.vx / speed) * maxSpeed;
        puck.vy = (puck.vy / speed) * maxSpeed;
      }
    }
    drag = null;
    canvas.classList.remove("grabbing");
  }

  canvas.addEventListener("mousedown", pointerDown);
  window.addEventListener("mousemove", pointerMove);
  window.addEventListener("mouseup", pointerUp);
  canvas.addEventListener("touchstart", pointerDown, { passive: false });
  window.addEventListener("touchmove", pointerMove, { passive: false });
  window.addEventListener("touchend", pointerUp);

  resetBtn.addEventListener("click", resetGame);

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // ---- Physics ----
  function step(dt) {
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
    }

    // puck-puck collisions
    for (let i = 0; i < pucks.length; i++) {
      for (let j = i + 1; j < pucks.length; j++) {
        resolveCollision(pucks[i], pucks[j]);
      }
    }
  }

  function resolveCollision(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const minDist = a.r + b.r;
    if (dist === 0 || dist >= minDist) return;

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
  function drawRink() {
    ctx.clearRect(0, 0, W, H);

    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#dff4ff");
    grad.addColorStop(1, "#b7e2fb");
    ctx.fillStyle = grad;
    roundRect(ctx, WALL / 2, WALL / 2, W - WALL, H - WALL, 24);
    ctx.fill();

    ctx.save();
    ctx.strokeStyle = "#1b3a63";
    ctx.lineWidth = WALL;
    roundRect(ctx, WALL / 2, WALL / 2, W - WALL, H - WALL, 24);
    ctx.stroke();
    ctx.restore();

    // center line
    ctx.strokeStyle = "rgba(226, 67, 74, 0.55)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(WALL, H / 2);
    ctx.lineTo(W - WALL, H / 2);
    ctx.stroke();

    // center circle
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 60, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(226, 67, 74, 0.4)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
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

    ctx.beginPath();
    ctx.arc(puck.x, puck.y, puck.r * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    ctx.fill();
  }

  function render() {
    drawRink();
    for (const puck of pucks) drawPuck(puck);
  }

  function loop() {
    for (let i = 0; i < SUBSTEPS; i++) step();
    render();
    requestAnimationFrame(loop);
  }

  updateScore();
  requestAnimationFrame(loop);
})();
