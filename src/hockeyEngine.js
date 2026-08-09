// Vanilla canvas physics engine for the hockey battle mini-game.
// Deliberately framework-agnostic — the game loop is imperative and runs
// outside React's render cycle. A component mounts it via createHockeyEngine
// and must call destroy() on unmount.
import floorTileUrl1 from "./assets/floor-tile-1.webp";
import floorTileUrl2 from "./assets/floor-tile-2.webp";
import floorTileUrl3 from "./assets/floor-tile-3.webp";
import wallBrickUrl1 from "./assets/wall-brick-1.webp";
import wallBrickUrl2 from "./assets/wall-brick-2.webp";
import wallBrickUrl3 from "./assets/wall-brick-3.webp";

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

  // Several stone/brick texture variants (Gemini-generated), tiled one
  // texture repeat per grid cell via pattern.setTransform. Each cell is
  // randomly assigned one variant (see buildVariantMaps) for visual
  // variety. drawField()/drawWallCell() fall back to a flat fill until a
  // variant group finishes loading.
  const FLOOR_URLS = [floorTileUrl1, floorTileUrl2, floorTileUrl3];
  const WALL_URLS = [wallBrickUrl1, wallBrickUrl2, wallBrickUrl3];

  const floorImages = FLOOR_URLS.map(() => new Image());
  const floorPatterns = new Array(FLOOR_URLS.length).fill(null);
  let floorReady = false;
  FLOOR_URLS.forEach((url, i) => {
    floorImages[i].onload = () => {
      floorPatterns[i] = ctx.createPattern(floorImages[i], "repeat");
      floorReady = floorPatterns.every(Boolean);
    };
    floorImages[i].src = url;
  });

  const wallImages = WALL_URLS.map(() => new Image());
  const wallPatterns = new Array(WALL_URLS.length).fill(null);
  let wallReady = false;
  WALL_URLS.forEach((url, i) => {
    wallImages[i].onload = () => {
      wallPatterns[i] = ctx.createPattern(wallImages[i], "repeat");
      wallReady = wallPatterns.every(Boolean);
    };
    wallImages[i].src = url;
  });

  function tiledPattern(pattern, img, cellSizeW, cellSizeH) {
    pattern.setTransform(new DOMMatrix().scale(cellSizeW / img.naturalWidth, cellSizeH / img.naturalHeight));
    return pattern;
  }

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
    // Minimum release speed (px per ~frame) for a drag to actually launch.
    // Below this, releasing does nothing — no weak dribbled-out throw.
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

  // The field is a grid of cells: a prison. `wallCells` holds every
  // currently-solid cell (border ring, the player's starting cell walls,
  // and the two doors) as { row, col, type, hp, rect }. Cells are removed
  // from it as doors break/open, so the collidable set shrinks over the
  // course of a level instead of being fixed at build time.
  const GRID_COLS = 9;

  let W = REF_W;
  let H = REF_W * (16 / 9);
  let scale = 1;
  let cellW = 0;
  let cellH = 0;
  let gridRows = 0;
  let wallCells = [];
  let mainDoorCell = null;
  let mainDoorRect = null;
  let mainDoorOpen = false;
  let playerStart = { x: 0, y: 0 };
  let guardStart = { x: 0, y: 0 };
  let beggarStart = { x: 0, y: 0 };
  let floorTintMap = [];
  let floorVariantMap = [];
  let wallVariantMap = [];
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

  function addWallCell(row, col, type, hp) {
    const cell = {
      row, col, type, hp: hp ?? null,
      rect: { x: col * cellW, y: row * cellH, w: cellW, h: cellH },
    };
    wallCells.push(cell);
    return cell;
  }

  function removeWallCell(cell) {
    const idx = wallCells.indexOf(cell);
    if (idx !== -1) wallCells.splice(idx, 1);
  }

  // A 2-row-tall cell built against the left or right border wall, with a
  // breakable door on the corridor-facing side (one row of the flanking
  // wall is the door, the other stays solid). Returns the cell's interior
  // center and the door cell so the caller can start a puck there / tag
  // what the door releases.
  function buildSideCell(side, bottomWallRow) {
    const isLeft = side === "left";
    const innerCol = isLeft ? 1 : GRID_COLS - 2; // against the border
    const outerCol = isLeft ? 2 : GRID_COLS - 3; // corridor-facing col
    const doorCol = isLeft ? 3 : GRID_COLS - 4;

    const r2 = bottomWallRow - 1; // lower interior row
    const r1 = r2 - 1; // upper interior row
    const topWallRow = r1 - 1;

    addWallCell(topWallRow, innerCol, "wall");
    addWallCell(topWallRow, outerCol, "wall");
    addWallCell(bottomWallRow, innerCol, "wall");
    addWallCell(bottomWallRow, outerCol, "wall");

    const doorCell = addWallCell(r1, doorCol, "cellDoor", 1);
    addWallCell(r2, doorCol, "wall");

    const center = {
      x: (Math.min(innerCol, outerCol) * cellW + (Math.max(innerCol, outerCol) + 1) * cellW) / 2,
      y: ((r1 + r2 + 1) / 2) * cellH,
    };
    return { center, doorCell };
  }

  // Builds the prison: four cells (two per side, lower and upper) opening
  // onto a central corridor that leads up to the main door. The player
  // starts locked in the lower-left cell; a beggar — not a threat, just
  // another prisoner — is locked in the upper-right one and stays put
  // until his own door is broken. A single guard patrols the corridor.
  // The main door starts closed (just another wall cell) and only opens
  // once the guard is defeated — see maybeOpenMainDoor().
  function buildLevel() {
    wallCells = [];

    const midCol = Math.floor(GRID_COLS / 2);

    // border ring, leaving a gap at the main door's column on the top row
    for (let col = 0; col < GRID_COLS; col++) {
      if (col !== midCol) addWallCell(0, col, "wall");
      addWallCell(gridRows - 1, col, "wall");
    }
    for (let row = 1; row < gridRows - 1; row++) {
      addWallCell(row, 0, "wall");
      addWallCell(row, GRID_COLS - 1, "wall");
    }

    mainDoorCell = addWallCell(0, midCol, "mainDoor");
    mainDoorRect = mainDoorCell.rect;
    mainDoorOpen = false;

    // The right-side cells are offset two rows up from their left-side
    // counterparts so a door on one side never lines up with a door/wall
    // on the other — the corridor is always at least two cells wide.
    const ROW_STAGGER = 2;
    const lowerBottomRow = gridRows - 2;
    const upperBottomRow = Math.floor(gridRows / 2);

    const lowerLeft = buildSideCell("left", lowerBottomRow);
    buildSideCell("right", lowerBottomRow - ROW_STAGGER); // empty cell, just flavor
    buildSideCell("left", upperBottomRow); // empty cell, just flavor
    const upperRight = buildSideCell("right", upperBottomRow - ROW_STAGGER);
    upperRight.doorCell.releases = "beggar";

    playerStart = lowerLeft.center;
    beggarStart = upperRight.center;

    const guardRow = Math.floor((lowerBottomRow - 4 + upperBottomRow) / 2);
    guardStart = { x: midCol * cellW + cellW / 2, y: guardRow * cellH + cellH / 2 };
  }

  function maybeOpenMainDoor() {
    if (mainDoorOpen) return;
    if (pucks.some((p) => !p.isPlayer && !p.isNpc)) return; // a guard is still alive
    mainDoorOpen = true;
    removeWallCell(mainDoorCell);
    spawnExplosion(
      mainDoorRect.x + mainDoorRect.w / 2,
      mainDoorRect.y + mainDoorRect.h / 2,
      Math.min(mainDoorRect.w, mainDoorRect.h) / 2
    );
  }

  function inDoorway(puck, r) {
    return (
      puck.x > r.x - puck.r * 0.3 &&
      puck.x < r.x + r.w + puck.r * 0.3 &&
      puck.y < r.y + r.h * 0.65
    );
  }

  function checkExit() {
    if (!mainDoorOpen) return;

    if (!gameOver) {
      const player = pucks.find((p) => p.isPlayer);
      if (player && inDoorway(player, mainDoorRect)) endGame("win");
    }

    // A freed prisoner who makes it to the open door escapes quietly —
    // flavor only, it doesn't affect the player's own win/lose.
    const npc = pucks.find((p) => p.isNpc && !p.imprisoned);
    if (npc && inDoorway(npc, mainDoorRect)) {
      pucks = pucks.filter((p) => p !== npc);
    }
  }

  // Randomized once (not per-frame, or it would flicker) whenever the grid
  // is (re)built, so each cell gets a stable random fallback tint / texture
  // variant.
  function buildFloorTintMap() {
    floorTintMap = [];
    floorVariantMap = [];
    wallVariantMap = [];
    for (let row = 0; row < gridRows; row++) {
      floorTintMap[row] = [];
      floorVariantMap[row] = [];
      wallVariantMap[row] = [];
      for (let col = 0; col < GRID_COLS; col++) {
        floorTintMap[row][col] = Math.floor(Math.random() * FLOOR_TINTS.length);
        floorVariantMap[row][col] = Math.floor(Math.random() * FLOOR_URLS.length);
        wallVariantMap[row][col] = Math.floor(Math.random() * WALL_URLS.length);
      }
    }
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
    // Needs enough rows for the border, the corridor, and two bands of
    // cells on each side to all fit (see buildLevel).
    gridRows = Math.max(18, Math.round(H / cellW));
    cellH = H / gridRows;

    buildLevel();
    buildFloorTintMap();
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
      isNpc: false, // a neutral prisoner — never attacks, never destroyed
      imprisoned: false, // locked behind an unbroken cell door: hidden, no physics
      hp: isPlayer ? PLAYER_START_HP : ENEMY_START_HP,
      grabbed: false,
    };
  }

  function initialLayout() {
    const beggar = makePuck(beggarStart.x, beggarStart.y, false);
    beggar.isNpc = true;
    beggar.imprisoned = true;
    return [
      makePuck(playerStart.x, playerStart.y, true),
      makePuck(guardStart.x, guardStart.y, false),
      beggar,
    ];
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
    buildLevel();
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
      maybeOpenMainDoor();
      turn = "player";
      inputLocked = false;
      onTurnChange("player");
      return;
    }

    const enemy = enemyQueue.shift();
    playerHitThisEnemyMove = false;

    // Placeholder AI: a random impulse in a random direction. Same rule as
    // the player's throw — below throwing speed, it just doesn't move. A
    // freed prisoner isn't hostile — it's biased toward the main door
    // instead of wandering randomly, since it's trying to escape.
    let angle;
    if (enemy.isNpc) {
      const toDoorX = mainDoorRect.x + mainDoorRect.w / 2 - enemy.x;
      const toDoorY = mainDoorRect.y + mainDoorRect.h / 2 - enemy.y;
      angle = Math.atan2(toDoorY, toDoorX) + (Math.random() - 0.5) * 0.8;
    } else {
      angle = Math.random() * Math.PI * 2;
    }
    const speed = MAX_THROW_SPEED * Math.random() * 0.85;
    if (speed >= THROW_MOTION_SPEED) {
      enemy.vx = Math.cos(angle) * speed;
      enemy.vy = Math.sin(angle) * speed;
    }
  }

  function advanceTurn() {
    if (gameOver) return;
    if (turn === "player") {
      maybeOpenMainDoor();
      turn = "enemy";
      onTurnChange("enemy");
      enemyQueue = pucks.filter((p) => !p.isPlayer && !p.imprisoned);
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
    const puck = drag.puck;

    // Pure free movement — the puck just follows the pointer directly,
    // clamped to the field.
    puck.x = clamp(p.x, bounds.left, bounds.right);
    puck.y = clamp(p.y, bounds.top, bounds.bottom);

    drag.lastMoveTime = performance.now();
    drag.history.push({ x: p.x, y: p.y, t: drag.lastMoveTime });
    if (drag.history.length > 6) drag.history.shift();
    evt.preventDefault();
  }

  function pointerUp(evt) {
    if (!drag) return;
    const puck = drag.puck;
    puck.grabbed = false;
    const hist = drag.history;
    const idleMs = performance.now() - drag.lastMoveTime;
    // A pause before releasing means the pointer wasn't actually moving at
    // release time — don't launch using stale motion from before the pause.
    if (idleMs < THROW_IDLE_MS && hist.length >= 2) {
      const a = hist[0];
      const b = hist[hist.length - 1];
      const dt = Math.max(1, b.t - a.t);
      const throwScale = 16; // ms-per-frame-ish scale to turn px/ms into a nice px/frame speed
      let vx = ((b.x - a.x) / dt) * throwScale;
      let vy = ((b.y - a.y) / dt) * throwScale;
      const speed = Math.hypot(vx, vy);
      // Below throwing speed, it doesn't launch at all rather than
      // dribbling out a weak throw.
      if (speed >= THROW_MOTION_SPEED) {
        if (speed > MAX_THROW_SPEED) {
          vx = (vx / speed) * MAX_THROW_SPEED;
          vy = (vy / speed) * MAX_THROW_SPEED;
        }
        puck.vx = vx;
        puck.vy = vy;
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

  function resolveLevelCellCollision(puck, cell, cellsToRemove) {
    const rect = cell.rect;
    const closestX = clamp(puck.x, rect.x, rect.x + rect.w);
    const closestY = clamp(puck.y, rect.y, rect.y + rect.h);
    const dx = puck.x - closestX;
    const dy = puck.y - closestY;
    const distSq = dx * dx + dy * dy;
    if (distSq >= puck.r * puck.r) return;

    // The player breaks the cell door open on contact during their turn —
    // same "destroys what it hits" rule as enemy pucks. Every other
    // contact (the guard, or the player just passing by outside their
    // turn) is a normal bounce.
    if (cell.type === "cellDoor" && puck.isPlayer && turn === "player" && !cellsToRemove.has(cell)) {
      cell.hp -= 1;
      if (cell.hp <= 0) {
        cellsToRemove.add(cell);
        spawnExplosion(rect.x + rect.w / 2, rect.y + rect.h / 2, Math.min(rect.w, rect.h) / 2);
        if (cell.releases === "beggar") {
          const beggar = pucks.find((p) => p.isNpc);
          if (beggar) beggar.imprisoned = false;
        }
      }
    }

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
    const cellsToRemove = new Set();

    for (const puck of pucks) {
      if (puck.grabbed || puck.imprisoned) continue;

      puck.x += puck.vx;
      puck.y += puck.vy;
      puck.vx *= FRICTION;
      puck.vy *= FRICTION;
      if (Math.hypot(puck.vx, puck.vy) < MIN_SPEED) {
        puck.vx = 0;
        puck.vy = 0;
      }

      for (const cell of wallCells) resolveLevelCellCollision(puck, cell, cellsToRemove);
    }

    if (cellsToRemove.size) {
      for (const cell of cellsToRemove) removeWallCell(cell);
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
    if (a.imprisoned || b.imprisoned) return;

    // Combat: on the player's turn, the player's puck deals damage and
    // bounces back off the impact instead of bouncing normally. On the
    // enemy turn, the moving enemy deals one hit of damage to the player
    // and then both bounce off each other like a normal collision — an
    // enemy hitting another enemy never deals damage either way. A
    // neutral prisoner is never part of combat either way, just a normal
    // bounce like two enemies colliding.
    if (a.isPlayer !== b.isPlayer && !a.isNpc && !b.isNpc) {
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

    if (wallReady) {
      const variant = wallVariantMap[row]?.[col] ?? 0;
      ctx.fillStyle = tiledPattern(wallPatterns[variant], wallImages[variant], cellW, cellH);
    } else {
      // Fallback while the texture is still loading: weathered castle-stone
      // brown, with a little per-brick color variation (deterministic on
      // position) so the wall doesn't read as one flat block of color.
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
    }
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

  const FLOOR_TINTS = [
    "rgba(255,255,255,0.14)",
    "rgba(0,0,0,0.16)",
    "rgba(120,108,90,0.14)",
    "rgba(0,0,0,0.08)",
  ];

  function drawFloorTint(row, col) {
    const cx = col * cellW + cellW / 2;
    const cy = row * cellH + cellH / 2;
    const r = Math.max(cellW, cellH) * 0.95;
    const tint = FLOOR_TINTS[floorTintMap[row]?.[col] ?? 0];
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, tint);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // A torch mounted on the inner face of a border wall cell. `dir` is +1 on
  // the left wall (flame reaches rightward into the floor) or -1 on the
  // right wall. Flicker is driven off the clock, no extra state needed.
  function drawTorch(x, y, dir) {
    const s = cellW;
    const t = performance.now() / 150 + x * 0.01 + y * 0.01;
    const flicker = Math.sin(t) * 0.12 + Math.sin(t * 2.3) * 0.06;

    const armLen = s * 0.32;
    ctx.fillStyle = "#2b2723";
    ctx.fillRect(x, y - s * 0.05, dir * armLen, s * 0.1);

    const flameX = x + dir * armLen;
    const flameY = y - s * 0.06;
    const stickTop = flameY - s * 0.22;

    ctx.strokeStyle = "#4a3421";
    ctx.lineWidth = Math.max(1, s * 0.09);
    ctx.beginPath();
    ctx.moveTo(flameX, flameY + s * 0.08);
    ctx.lineTo(flameX, stickTop);
    ctx.stroke();

    const glowR = s * (0.55 + flicker);
    const glow = ctx.createRadialGradient(flameX, stickTop, 0, flameX, stickTop, glowR);
    glow.addColorStop(0, "rgba(255,170,70,0.4)");
    glow.addColorStop(1, "rgba(255,140,40,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(flameX, stickTop, glowR, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(flameX, stickTop - s * (0.34 + flicker));
    ctx.quadraticCurveTo(flameX + s * 0.17, stickTop - s * 0.1, flameX, stickTop + s * 0.1);
    ctx.quadraticCurveTo(flameX - s * 0.17, stickTop - s * 0.1, flameX, stickTop - s * (0.34 + flicker));
    ctx.closePath();
    ctx.fillStyle = "#ff7a1a";
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(flameX, stickTop - s * (0.18 + flicker * 0.6));
    ctx.quadraticCurveTo(flameX + s * 0.08, stickTop - s * 0.05, flameX, stickTop + s * 0.05);
    ctx.quadraticCurveTo(flameX - s * 0.08, stickTop - s * 0.05, flameX, stickTop - s * (0.18 + flicker * 0.6));
    ctx.closePath();
    ctx.fillStyle = "#ffd23f";
    ctx.fill();
  }

  function torchRows() {
    const innerRows = gridRows - 2;
    if (innerRows < 3) return [];
    return [0.16, 0.5, 0.84].map((f) => 1 + Math.round(f * (innerRows - 1)));
  }

  // A wooden cell door or the grander main gate — visually distinct from
  // the brick walls so it reads as something breakable/openable.
  function drawDoorCell(cell) {
    const { row, col, type } = cell;
    const x = col * cellW;
    const y = row * cellH;
    const isMain = type === "mainDoor";

    const grad = ctx.createLinearGradient(x, y, x, y + cellH);
    grad.addColorStop(0, isMain ? "#6b4423" : "#5c4028");
    grad.addColorStop(1, isMain ? "#3d2814" : "#3a2818");
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, cellW, cellH);

    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = Math.max(1, scale);
    const planks = isMain ? 4 : 3;
    for (let i = 1; i < planks; i++) {
      const px = x + (cellW / planks) * i;
      ctx.beginPath();
      ctx.moveTo(px, y + 2);
      ctx.lineTo(px, y + cellH - 2);
      ctx.stroke();
    }

    ctx.strokeStyle = "#8a8a8a";
    ctx.lineWidth = Math.max(2, cellH * 0.06);
    const bandYs = isMain ? [y + cellH * 0.25, y + cellH * 0.75] : [y + cellH * 0.5];
    for (const by of bandYs) {
      ctx.beginPath();
      ctx.moveTo(x + 2, by);
      ctx.lineTo(x + cellW - 2, by);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(x + cellW * 0.5, y + cellH * 0.55, cellW * 0.09, 0, Math.PI * 2);
    ctx.strokeStyle = "#c9a227";
    ctx.lineWidth = Math.max(1.5, cellW * 0.025);
    ctx.stroke();

    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = Math.max(1, scale);
    ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
  }

  // Once the guard falls, the main door is gone from wallCells — draw an
  // inviting warm glow there instead, so the exit reads as "go here".
  function drawOpenMainDoor() {
    const r = mainDoorRect;
    const cx = r.x + r.w / 2;
    const glow = ctx.createRadialGradient(cx, r.y + r.h * 0.3, 0, cx, r.y + r.h * 0.3, r.w * 2.2);
    glow.addColorStop(0, "rgba(255,235,190,0.9)");
    glow.addColorStop(0.5, "rgba(255,200,120,0.35)");
    glow.addColorStop(1, "rgba(255,200,120,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(cx - r.w * 2, 0, r.w * 4, r.h * 3);

    ctx.fillStyle = "#f4e6c8";
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }

  function drawField() {
    ctx.clearRect(0, 0, W, H);

    // floor
    const floorTop = cellH;
    const floorBottom = H - cellH;
    if (floorReady) {
      // Each generated stone texture already has its own natural variation
      // baked in, so a randomly assigned variant per cell is used as-is —
      // no extra per-tile tinting needed.
      for (let row = 1; row < gridRows - 1; row++) {
        for (let col = 1; col < GRID_COLS - 1; col++) {
          const variant = floorVariantMap[row]?.[col] ?? 0;
          ctx.fillStyle = tiledPattern(floorPatterns[variant], floorImages[variant], cellW, cellH);
          ctx.fillRect(col * cellW, row * cellH, cellW, cellH);
        }
      }
    } else {
      // Fallback while the texture is still loading: a flat stone gradient
      // with soft per-tile mottling — each tile is a radial gradient fading
      // all the way to transparent, so it blends into its neighbors by
      // construction, unlike the walls' crisp bordered bricks.
      const floorGrad = ctx.createLinearGradient(0, floorTop, 0, floorBottom);
      floorGrad.addColorStop(0, "#a19c93");
      floorGrad.addColorStop(1, "#6e6a62");
      ctx.fillStyle = floorGrad;
      ctx.fillRect(cellW, floorTop, W - cellW * 2, floorBottom - floorTop);

      for (let row = 1; row < gridRows - 1; row++) {
        for (let col = 1; col < GRID_COLS - 1; col++) {
          drawFloorTint(row, col);
        }
      }
    }

    // every currently-solid cell: border, the player's starting cell, and
    // whichever doors haven't broken/opened yet
    for (const cell of wallCells) {
      if (cell.type === "cellDoor" || cell.type === "mainDoor") {
        drawDoorCell(cell);
      } else {
        drawWallCell(cell.row, cell.col);
      }
    }
    if (mainDoorOpen) drawOpenMainDoor();

    // torches mounted on the side walls
    for (const row of torchRows()) {
      const y = row * cellH + cellH / 2;
      drawTorch(cellW, y, 1);
      drawTorch(W - cellW, y, -1);
    }
  }

  function drawPuck(puck) {
    const grad = ctx.createRadialGradient(
      puck.x - puck.r * 0.3, puck.y - puck.r * 0.3, puck.r * 0.2,
      puck.x, puck.y, puck.r
    );
    if (puck.isPlayer) {
      grad.addColorStop(0, "#f3caa0");
      grad.addColorStop(1, "#c98f60");
    } else if (puck.isNpc) {
      grad.addColorStop(0, "#a89a82");
      grad.addColorStop(1, "#6f6350");
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
    } else if (puck.isNpc) {
      drawBeggarFace(puck, lookX, lookY);
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

    // full white mane covering the crown, with two long locks framing the
    // face down past the temples
    ctx.fillStyle = "#f4f1ea";
    ctx.beginPath();
    ctx.moveTo(puck.x - r * 0.88, puck.y - r * 0.22);
    ctx.quadraticCurveTo(puck.x - r * 0.78, puck.y - r * 0.95, puck.x, puck.y - r * 1.18);
    ctx.quadraticCurveTo(puck.x + r * 0.78, puck.y - r * 0.95, puck.x + r * 0.88, puck.y - r * 0.22);
    ctx.quadraticCurveTo(puck.x + r * 0.55, puck.y - r * 0.42, puck.x + r * 0.22, puck.y - r * 0.38);
    ctx.quadraticCurveTo(puck.x, puck.y - r * 0.5, puck.x - r * 0.22, puck.y - r * 0.38);
    ctx.quadraticCurveTo(puck.x - r * 0.55, puck.y - r * 0.42, puck.x - r * 0.88, puck.y - r * 0.22);
    ctx.closePath();
    ctx.fill();

    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(puck.x + side * r * 0.85, puck.y - r * 0.2);
      ctx.quadraticCurveTo(puck.x + side * r * 1.05, puck.y + r * 0.15, puck.x + side * r * 0.8, puck.y + r * 0.5);
      ctx.quadraticCurveTo(puck.x + side * r * 0.68, puck.y + r * 0.2, puck.x + side * r * 0.62, puck.y - r * 0.05);
      ctx.closePath();
      ctx.fill();
    }

    // soft strand lines for a bit of texture in the mane
    ctx.strokeStyle = "rgba(190,186,176,0.5)";
    ctx.lineWidth = Math.max(1, r * 0.02);
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(puck.x + i * r * 0.3, puck.y - r * 1.02);
      ctx.lineTo(puck.x + i * r * 0.24, puck.y - r * 0.42);
      ctx.stroke();
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

  // The other prisoner: not a threat, just a scruffy, worried beggar with
  // a patched headwrap, raised pleading eyebrows and a wavering mouth.
  function drawBeggarFace(puck, lookX, lookY) {
    const r = puck.r;
    const eyeR = r * 0.22;
    const eyeOffsetX = r * 0.32;
    const eyeOffsetY = r * -0.05;
    const eyes = [
      { x: puck.x - eyeOffsetX, y: puck.y + eyeOffsetY },
      { x: puck.x + eyeOffsetX, y: puck.y + eyeOffsetY },
    ];

    // patched headwrap
    ctx.fillStyle = "#8a7358";
    ctx.beginPath();
    ctx.moveTo(puck.x - r * 0.85, puck.y - r * 0.15);
    ctx.quadraticCurveTo(puck.x - r * 0.7, puck.y - r * 0.85, puck.x, puck.y - r * 0.95);
    ctx.quadraticCurveTo(puck.x + r * 0.7, puck.y - r * 0.85, puck.x + r * 0.85, puck.y - r * 0.15);
    ctx.quadraticCurveTo(puck.x, puck.y - r * 0.5, puck.x - r * 0.85, puck.y - r * 0.15);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.3)";
    ctx.lineWidth = Math.max(1, r * 0.03);
    ctx.beginPath();
    ctx.moveTo(puck.x - r * 0.3, puck.y - r * 0.78);
    ctx.lineTo(puck.x - r * 0.15, puck.y - r * 0.55);
    ctx.stroke();

    // worried, raised eyebrows
    ctx.strokeStyle = "#3a3226";
    ctx.lineWidth = Math.max(1.5, r * 0.055);
    ctx.lineCap = "round";
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(puck.x + side * (eyeOffsetX - eyeR * 0.7), puck.y + eyeOffsetY - eyeR * 1.1);
      ctx.lineTo(puck.x + side * (eyeOffsetX + eyeR * 1.1), puck.y + eyeOffsetY - eyeR * 0.3);
      ctx.stroke();
    }

    // round, worried eyes
    for (const eye of eyes) {
      ctx.beginPath();
      ctx.arc(eye.x, eye.y, eyeR, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.lineWidth = Math.max(1, r * 0.025);
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(eye.x + lookX, eye.y + lookY, eyeR * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = "#3a2e22";
      ctx.fill();
    }

    // stubble flecks
    ctx.fillStyle = "rgba(70,60,48,0.4)";
    for (let i = 0; i < 8; i++) {
      const a = Math.PI * 0.15 + (i / 7) * Math.PI * 0.7;
      const px = puck.x + Math.cos(a) * r * 0.55;
      const py = puck.y + Math.sin(a) * r * 0.4 + r * 0.28;
      ctx.beginPath();
      ctx.arc(px, py, r * 0.02, 0, Math.PI * 2);
      ctx.fill();
    }

    // small wavering, anxious mouth
    ctx.beginPath();
    ctx.moveTo(puck.x - r * 0.16, puck.y + r * 0.42);
    ctx.quadraticCurveTo(puck.x - r * 0.05, puck.y + r * 0.48, puck.x + r * 0.02, puck.y + r * 0.4);
    ctx.quadraticCurveTo(puck.x + r * 0.1, puck.y + r * 0.46, puck.x + r * 0.18, puck.y + r * 0.4);
    ctx.lineWidth = Math.max(1.2, r * 0.05);
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.stroke();
  }

  const HELP_CYCLE_MS = 3400;
  const HELP_VISIBLE_MS = 1500;

  function speechBubbleVisible() {
    return performance.now() % HELP_CYCLE_MS < HELP_VISIBLE_MS;
  }

  function drawSpeechBubble(puck, text) {
    const r = puck.r;
    const bw = r * 2.3;
    const bh = r * 1.05;
    const bx = puck.x - bw / 2;
    const by = puck.y - r * 1.85 - bh;
    const radius = r * 0.28;

    ctx.beginPath();
    ctx.moveTo(bx + radius, by);
    ctx.lineTo(bx + bw - radius, by);
    ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + radius);
    ctx.lineTo(bx + bw, by + bh - radius);
    ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - radius, by + bh);
    ctx.lineTo(bx + radius, by + bh);
    ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - radius);
    ctx.lineTo(bx, by + radius);
    ctx.quadraticCurveTo(bx, by, bx + radius, by);
    ctx.closePath();
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = Math.max(1, r * 0.04);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(puck.x - r * 0.16, by + bh - 1);
    ctx.lineTo(puck.x, by + bh + r * 0.32);
    ctx.lineTo(puck.x + r * 0.08, by + bh - 1);
    ctx.closePath();
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fill();

    ctx.fillStyle = "#1a1a1a";
    ctx.font = `bold ${Math.round(r * 0.58)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, bx + bw / 2, by + bh / 2 + r * 0.03);
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
    for (const puck of pucks) {
      if (puck.imprisoned) continue; // hidden behind its (still unbroken) door
      drawPuck(puck);
    }
    if (speechBubbleVisible()) {
      const npc = pucks.find((p) => p.isNpc);
      if (npc) drawSpeechBubble(npc, "Help!");
    }
    updateExplosions();
    drawExplosions();
  }

  let rafId = null;
  let running = true;
  function loop() {
    if (!running) return;
    for (let i = 0; i < SUBSTEPS; i++) step();
    checkExit();
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
