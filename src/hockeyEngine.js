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
    wall: 18,
    puckR: 30,
    minSpeed: 0.02,
    maxThrowSpeed: 30,
  };

  const FRICTION = 0.992; // per-substep velocity damping
  const RESTITUTION_WALL = 0.85;
  const RESTITUTION_PUCK = 0.95;
  const SUBSTEPS = 4;

  let W = REF_W;
  let H = REF_W * (16 / 9);
  let scale = 1;
  let WALL = BASE.wall;
  let PUCK_R = BASE.puckR;
  let MIN_SPEED = BASE.minSpeed;
  let MAX_THROW_SPEED = BASE.maxThrowSpeed;

  const bounds = { left: 0, right: 0, top: 0, bottom: 0 };

  function updateBounds() {
    bounds.left = WALL + PUCK_R;
    bounds.right = W - WALL - PUCK_R;
    bounds.top = WALL + PUCK_R;
    bounds.bottom = H - WALL - PUCK_R;
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
    WALL = BASE.wall * scale;
    PUCK_R = BASE.puckR * scale;
    MIN_SPEED = BASE.minSpeed * scale;
    MAX_THROW_SPEED = BASE.maxThrowSpeed * scale;
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
  let collisionCount = 0;

  function resetGame() {
    pucks = initialLayout();
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

  // ---- Physics ----
  function step() {
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
    roundRect(ctx, WALL / 2, WALL / 2, W - WALL, H - WALL, 24 * scale);
    ctx.fill();

    ctx.save();
    ctx.strokeStyle = "#1b3a63";
    ctx.lineWidth = WALL;
    roundRect(ctx, WALL / 2, WALL / 2, W - WALL, H - WALL, 24 * scale);
    ctx.stroke();
    ctx.restore();

    // center line
    ctx.strokeStyle = "rgba(226, 67, 74, 0.55)";
    ctx.lineWidth = 3 * scale;
    ctx.beginPath();
    ctx.moveTo(WALL, H / 2);
    ctx.lineTo(W - WALL, H / 2);
    ctx.stroke();

    // center circle
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 60 * scale, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(226, 67, 74, 0.4)";
    ctx.lineWidth = 2 * scale;
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

  function render() {
    drawRink();
    for (const puck of pucks) drawPuck(puck);
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
