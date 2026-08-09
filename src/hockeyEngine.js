// Vanilla canvas physics engine for the hockey battle mini-game.
// Deliberately framework-agnostic — the game loop is imperative and runs
// outside React's render cycle. A component mounts it via createHockeyEngine
// and must call destroy() on unmount.
export function createHockeyEngine({
  canvas,
  field,
  onScoreChange,
  onGrabChange,
  onHpChange,
  onTurnChange,
  onGameOver,
}) {
  const ctx = canvas.getContext("2d");

  // Reference design width. All gameplay constants are defined relative to
  // this and rescaled by `scale` whenever the viewport changes. The field
  // always fills the full viewport — no letterboxing.
  const REF_W = 540;

  const BASE = {
    puckR: 30,
    minSpeed: 0.02,
    maxThrowSpeed: 30,
    // Threshold used to decide a puck has "settled" for turn-advancement
    // purposes. Much larger than minSpeed on purpose — waiting for pucks to
    // decay all the way to a full stop under the ice-like low friction
    // would make each turn take several seconds.
    settleSpeed: 1.6,
    // While dragging, the puck only follows the pointer when the pointer is
    // moving at least this fast (px per ~frame) — a real throwing motion.
    // Below that, or once the pointer stops, it eases back to where it
    // started the turn instead of staying wherever it was dropped.
    throwMotionSpeed: 2,
  };

  const FRICTION = 0.992; // per-substep velocity damping
  const RESTITUTION_WALL = 0.85;
  const RESTITUTION_PUCK = 0.95;
  const SUBSTEPS = 4;
  // If the pointer has been still for longer than this, treat the drag as
  // stopped — both for easing the puck back and for the release velocity,
  // so a pause-then-release doesn't launch using stale motion history.
  const THROW_IDLE_MS = 80;

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
  let SETTLE_SPEED = BASE.settleSpeed;
  let THROW_MOTION_SPEED = BASE.throwMotionSpeed;

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
    SETTLE_SPEED = BASE.settleSpeed * scale;
    THROW_MOTION_SPEED = BASE.throwMotionSpeed * scale;

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

  const PLAYER_START_HP = 3;
  const ENEMY_START_HP = 1;

  function makePuck(x, y, isPlayer) {
    return {
      x, y, vx: 0, vy: 0,
      r: PUCK_R,
      isPlayer: !!isPlayer,
      hp: isPlayer ? PLAYER_START_HP : ENEMY_START_HP,
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

  // ---- Turn-based battle state ----
  // "player": waiting for (or resolving) the player's own throw.
  // "enemy": the enemy phase — enemies move one at a time from enemyQueue.
  let turn = "player";
  let inputLocked = false; // true while a throw/impulse is still settling
  let enemyQueue = [];
  let playerHitThisEnemyMove = false; // caps each enemy's move to one hit
  let gameOver = null; // null | "win" | "lose"

  function resetGame() {
    pucks = initialLayout();
    explosions = [];
    collisionCount = 0;
    drag = null;
    turn = "player";
    inputLocked = false;
    enemyQueue = [];
    playerHitThisEnemyMove = false;
    gameOver = null;
    updateScore();
    onHpChange(PLAYER_START_HP);
    onTurnChange("player");
    onGameOver(null);
  }

  function updateScore() {
    onScoreChange(collisionCount);
  }

  function endGame(result) {
    if (gameOver) return;
    gameOver = result;
    inputLocked = true;
    onGameOver(result);
  }

  function takeNextEnemyTurn() {
    while (enemyQueue.length && !pucks.includes(enemyQueue[0])) enemyQueue.shift();

    if (enemyQueue.length === 0) {
      if (!pucks.some((p) => !p.isPlayer)) {
        endGame("win");
        return;
      }
      turn = "player";
      inputLocked = false;
      onTurnChange("player");
      return;
    }

    const enemy = enemyQueue.shift();
    playerHitThisEnemyMove = false;

    // Placeholder AI: a random impulse in a random direction.
    const angle = Math.random() * Math.PI * 2;
    const speed = MAX_THROW_SPEED * (0.35 + Math.random() * 0.5);
    enemy.vx = Math.cos(angle) * speed;
    enemy.vy = Math.sin(angle) * speed;
  }

  function advanceTurn() {
    if (gameOver) return;
    if (turn === "player") {
      if (!pucks.some((p) => !p.isPlayer)) {
        endGame("win");
        return;
      }
      turn = "enemy";
      onTurnChange("enemy");
      enemyQueue = pucks.filter((p) => !p.isPlayer);
      takeNextEnemyTurn();
    } else {
      takeNextEnemyTurn();
    }
  }

  function allSettled() {
    return (
      explosions.length === 0 &&
      pucks.every((p) => !p.grabbed && Math.hypot(p.vx, p.vy) < SETTLE_SPEED)
    );
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
    if (turn !== "player" || inputLocked || gameOver) return;
    const p = canvasPoint(evt);
    const player = pucks.find((pk) => pk.isPlayer);
    if (!player) return;
    const dx = p.x - player.x;
    const dy = p.y - player.y;
    if (Math.hypot(dx, dy) <= player.r * 1.4) {
      const now = performance.now();
      drag = {
        puck: player,
        anchorX: player.x,
        anchorY: player.y,
        pointerX: p.x,
        pointerY: p.y,
        speed: 0,
        lastMoveTime: now,
        history: [{ x: p.x, y: p.y, t: now }],
      };
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
    const now = performance.now();

    const prev = drag.history[drag.history.length - 1];
    const dt = Math.max(1, now - prev.t);
    const dist = Math.hypot(p.x - prev.x, p.y - prev.y);
    drag.speed = (dist / dt) * 16; // px per ~frame, matching the throw-speed convention below

    drag.pointerX = p.x;
    drag.pointerY = p.y;
    drag.lastMoveTime = now;

    drag.history.push({ x: p.x, y: p.y, t: now });
    if (drag.history.length > 6) drag.history.shift();
    evt.preventDefault();
  }

  // Runs every frame while a puck is being dragged. The puck only follows
  // the pointer while it's moving at throwing speed; otherwise (paused,
  // slow, or stalled) it eases back to where it started the turn.
  function updateDrag() {
    if (!drag) return;
    const puck = drag.puck;
    const idleMs = performance.now() - drag.lastMoveTime;
    const isThrowMotion = idleMs < THROW_IDLE_MS && drag.speed > THROW_MOTION_SPEED;

    if (isThrowMotion) {
      // Sticky follow — chases the pointer with a bit of elastic lag
      // instead of teleporting straight to it every frame.
      const STICK = 0.45;
      const targetX = clamp(drag.pointerX, bounds.left, bounds.right);
      const targetY = clamp(drag.pointerY, bounds.top, bounds.bottom);
      puck.x += (targetX - puck.x) * STICK;
      puck.y += (targetY - puck.y) * STICK;
    } else {
      const SPRING = 0.22;
      puck.x += (drag.anchorX - puck.x) * SPRING;
      puck.y += (drag.anchorY - puck.y) * SPRING;
    }
  }

  function pointerUp(evt) {
    if (!drag) return;
    const puck = drag.puck;
    puck.grabbed = false;
    const hist = drag.history;
    const idleMs = performance.now() - drag.lastMoveTime;
    // A pause before releasing means the puck already eased back toward the
    // origin — don't launch it using stale motion from before the pause.
    if (idleMs < THROW_IDLE_MS && hist.length >= 2) {
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
    inputLocked = true;
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

    // Combat: on the player's turn, the player's puck deals damage and
    // bounces back off the impact instead of bouncing normally. On the
    // enemy turn, the moving enemy deals one hit of damage to the player
    // and then both bounce off each other like a normal collision — an
    // enemy hitting another enemy never deals damage either way.
    if (a.isPlayer !== b.isPlayer) {
      const enemy = a.isPlayer ? b : a;
      const playerPuck = a.isPlayer ? a : b;

      // Still being aimed, not thrown yet — passing over an enemy while
      // dragging shouldn't count as a hit.
      if (playerPuck.grabbed) return;

      if (turn === "player") {
        if (!toRemove.has(enemy)) {
          enemy.hp -= 1;
          if (enemy.hp <= 0) {
            toRemove.add(enemy);
            spawnExplosion(enemy.x, enemy.y, enemy.r);
          }
          collisionCount++;
          updateScore();
        }

        const nix = (playerPuck.x - enemy.x) / dist;
        const niy = (playerPuck.y - enemy.y) / dist;
        const closingSpeed = playerPuck.vx * nix + playerPuck.vy * niy;
        if (closingSpeed < 0) {
          playerPuck.vx -= (1 + RESTITUTION_PUCK) * closingSpeed * nix;
          playerPuck.vy -= (1 + RESTITUTION_PUCK) * closingSpeed * niy;
        }
        return;
      }

      if (!playerHitThisEnemyMove && !toRemove.has(playerPuck)) {
        playerHitThisEnemyMove = true;
        playerPuck.hp -= 1;
        onHpChange(Math.max(0, playerPuck.hp));
        if (playerPuck.hp <= 0) {
          toRemove.add(playerPuck);
          spawnExplosion(playerPuck.x, playerPuck.y, playerPuck.r);
          endGame("lose");
        }
      }
      // fall through to the normal elastic bounce below
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

    // Weathered castle-stone brown, with a little per-brick color variation
    // (deterministic on position, not random, so it stays stable frame to
    // frame) so the wall doesn't read as one flat block of color.
    const brickPalettes = [
      ["#a1825a", "#5c4128"],
      ["#8f6f49", "#4e3620"],
      ["#96774f", "#553b22"],
    ];
    const [top, bottom] = brickPalettes[(row * 7 + col * 13) % brickPalettes.length];
    const grad = ctx.createLinearGradient(x, y, x + cellW, y + cellH);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
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

    if (puck.isPlayer) {
      drawWitcherFace(puck, lookX, lookY);
    } else {
      drawWarriorFace(puck, lookX, lookY);
    }
  }

  // The player's puck: white-wolf hair, golden cat-eyes, a scar and a
  // wolf-medallion nod to Geralt of Rivia — a lone monster hunter among
  // the warrior pucks.
  function drawWitcherFace(puck, lookX, lookY) {
    const r = puck.r;
    const eyeR = r * 0.28;
    const eyeOffsetX = r * 0.34;
    const eyeOffsetY = r * -0.08;
    const eyes = [
      { x: puck.x - eyeOffsetX, y: puck.y + eyeOffsetY },
      { x: puck.x + eyeOffsetX, y: puck.y + eyeOffsetY },
    ];

    // white hair swept back from the crown
    ctx.fillStyle = "#f2f2f0";
    for (let i = -2; i <= 2; i++) {
      const t = i / 2; // -1..1
      const bx = puck.x + t * r * 0.75;
      const by = puck.y - r * 0.82;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - r * 0.13 + t * r * 0.1, by - r * 0.42);
      ctx.lineTo(bx + r * 0.16, by + r * 0.12);
      ctx.closePath();
      ctx.fill();
    }

    // cat eyes: almond sclera + vertical slit pupil
    for (const eye of eyes) {
      ctx.beginPath();
      ctx.ellipse(eye.x, eye.y, eyeR, eyeR * 0.78, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.lineWidth = Math.max(1, r * 0.03);
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.stroke();

      ctx.beginPath();
      ctx.ellipse(eye.x + lookX, eye.y + lookY, eyeR * 0.62, eyeR * 0.62, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#c9962b";
      ctx.fill();

      ctx.beginPath();
      ctx.ellipse(eye.x + lookX, eye.y + lookY, eyeR * 0.16, eyeR * 0.58, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#161200";
      ctx.fill();
    }

    // scar over the right eye — dark base line with a pale highlight so it
    // reads against the orange puck at any zoom level
    ctx.strokeStyle = "rgba(90,45,40,0.75)";
    ctx.lineWidth = Math.max(1.5, r * 0.07);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(puck.x + eyeOffsetX - eyeR * 0.6, puck.y + eyeOffsetY - eyeR * 1.3);
    ctx.lineTo(puck.x + eyeOffsetX + eyeR * 0.5, puck.y + r * 0.42);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,225,215,0.9)";
    ctx.lineWidth = Math.max(1, r * 0.025);
    ctx.beginPath();
    ctx.moveTo(puck.x + eyeOffsetX - eyeR * 0.6, puck.y + eyeOffsetY - eyeR * 1.3);
    ctx.lineTo(puck.x + eyeOffsetX + eyeR * 0.5, puck.y + r * 0.42);
    ctx.stroke();

    // stern, closed mouth
    ctx.beginPath();
    ctx.moveTo(puck.x - r * 0.22, puck.y + r * 0.42);
    ctx.quadraticCurveTo(puck.x, puck.y + r * 0.38, puck.x + r * 0.22, puck.y + r * 0.42);
    ctx.lineWidth = Math.max(1.5, r * 0.06);
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.stroke();

    // wolf medallion at the chin
    ctx.beginPath();
    ctx.arc(puck.x, puck.y + r * 0.68, r * 0.16, 0, Math.PI * 2);
    ctx.fillStyle = "#8a8f9a";
    ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.025);
    ctx.strokeStyle = "#4a4e57";
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(puck.x - r * 0.07, puck.y + r * 0.72);
    ctx.lineTo(puck.x, puck.y + r * 0.6);
    ctx.lineTo(puck.x + r * 0.07, puck.y + r * 0.72);
    ctx.strokeStyle = "#4a4e57";
    ctx.lineWidth = Math.max(1, r * 0.02);
    ctx.stroke();
  }

  // Enemy pucks: horned helmets, furious brows, glowing red eyes and a
  // snarl of jagged teeth — a horde of evil warriors.
  function drawWarriorFace(puck, lookX, lookY) {
    const r = puck.r;
    const eyeR = r * 0.26;
    const eyeOffsetX = r * 0.34;
    const eyeOffsetY = r * -0.05;
    const eyes = [
      { x: puck.x - eyeOffsetX, y: puck.y + eyeOffsetY },
      { x: puck.x + eyeOffsetX, y: puck.y + eyeOffsetY },
    ];

    // curved horns
    ctx.fillStyle = "#2a2a2e";
    for (const side of [-1, 1]) {
      const baseX = puck.x + side * r * 0.55;
      const baseY = puck.y - r * 0.62;
      ctx.beginPath();
      ctx.moveTo(baseX - side * r * 0.14, baseY + r * 0.1);
      ctx.quadraticCurveTo(
        baseX + side * r * 0.55, baseY - r * 0.55,
        baseX + side * r * 0.18, baseY - r * 0.85
      );
      ctx.quadraticCurveTo(baseX + side * r * 0.02, baseY - r * 0.45, baseX + side * r * 0.16, baseY + r * 0.14);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.lineWidth = Math.max(1, r * 0.02);
      ctx.stroke();
    }

    // angry eyebrows
    ctx.strokeStyle = "#0d0d0f";
    ctx.lineWidth = Math.max(1.5, r * 0.07);
    ctx.lineCap = "round";
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(puck.x + side * (eyeOffsetX - eyeR * 0.9), puck.y + eyeOffsetY - eyeR * 0.4);
      ctx.lineTo(puck.x + side * (eyeOffsetX + eyeR * 0.9), puck.y + eyeOffsetY - eyeR * 1.4);
      ctx.stroke();
    }

    // glowing red eyes — no white sclera, just menacing embers
    for (const eye of eyes) {
      ctx.beginPath();
      ctx.arc(eye.x, eye.y, eyeR, 0, Math.PI * 2);
      ctx.fillStyle = "#1a0505";
      ctx.fill();

      const glow = ctx.createRadialGradient(
        eye.x + lookX, eye.y + lookY, 0,
        eye.x + lookX, eye.y + lookY, eyeR * 0.75
      );
      glow.addColorStop(0, "#ff5a3c");
      glow.addColorStop(1, "#8a1a10");
      ctx.beginPath();
      ctx.arc(eye.x + lookX, eye.y + lookY, eyeR * 0.62, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();
    }

    // snarling jagged teeth
    const mouthY = puck.y + r * 0.38;
    const mouthHalfW = r * 0.34;
    ctx.beginPath();
    ctx.moveTo(puck.x - mouthHalfW, mouthY);
    const teeth = 5;
    for (let i = 0; i <= teeth; i++) {
      const tx = puck.x - mouthHalfW + (i / teeth) * mouthHalfW * 2;
      const ty = mouthY + (i % 2 === 0 ? r * 0.14 : -r * 0.02);
      ctx.lineTo(tx, ty);
    }
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = Math.max(1.5, r * 0.05);
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.lineTo(puck.x + mouthHalfW, mouthY);
    ctx.closePath();
    ctx.fill();

    // war-paint stripes on the cheeks
    ctx.strokeStyle = "rgba(200,40,40,0.55)";
    ctx.lineWidth = Math.max(1, r * 0.045);
    ctx.lineCap = "round";
    for (const side of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        ctx.beginPath();
        ctx.moveTo(puck.x + side * (eyeOffsetX + r * 0.05 + i * r * 0.09), puck.y + r * 0.2);
        ctx.lineTo(puck.x + side * (eyeOffsetX - r * 0.05 + i * r * 0.09), puck.y + r * 0.4);
        ctx.stroke();
      }
    }
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
    updateDrag();
    for (let i = 0; i < SUBSTEPS; i++) step();
    render();
    if (inputLocked && !gameOver && allSettled()) advanceTurn();
    rafId = requestAnimationFrame(loop);
  }

  resize();
  resetGame();
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
