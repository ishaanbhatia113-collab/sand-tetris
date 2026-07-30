(() => {
  'use strict';

  // ---------------------------------------------------------------- constants
  const GRID_W = 60;          // play field width, in sand particles
  const GRID_H = 120;         // play field height, in sand particles
  const CELL = 6;             // particles per tetromino block (6x6 grains)
  const PX = 6;               // screen pixels per particle
  const MOVE_STEP = 3;        // horizontal nudge, in particles
  const DAS = 0.15;           // delay before auto-repeat, seconds
  const ARR = 0.03;           // auto-repeat interval, seconds
  const LOCK_DELAY = 0.22;    // grace period once the piece touches down
  const LOCK_RESETS = 6;
  const SAND_DT = 1 / 120;    // fixed timestep for the sand automaton
  const SAND_MAX_STEPS = 4;   // catch-up cap so a stalled tab can't spiral

  const PIECES = [
    { name: 'I', rgb: [ 34, 211, 238], mat: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]] },
    { name: 'O', rgb: [250, 204,  21], mat: [[1,1],[1,1]] },
    { name: 'T', rgb: [168,  85, 247], mat: [[0,1,0],[1,1,1],[0,0,0]] },
    { name: 'S', rgb: [ 74, 222, 128], mat: [[0,1,1],[1,1,0],[0,0,0]] },
    { name: 'Z', rgb: [248,  86,  86], mat: [[1,1,0],[0,1,1],[0,0,0]] },
    { name: 'J', rgb: [ 96, 140, 255], mat: [[1,0,0],[1,1,1],[0,0,0]] },
    { name: 'L', rgb: [251, 146,  60], mat: [[0,0,1],[1,1,1],[0,0,0]] },
  ];

  // Four brightness variants per colour give the sand a grainy texture.
  const SHADE_MUL = [0.72, 0.86, 1.0, 1.16];
  const SHADES = [null].concat(PIECES.map(p =>
    SHADE_MUL.map(m => p.rgb.map(v => Math.min(255, Math.round(v * m))))
  ));

  // ------------------------------------------------------------------ canvas
  const canvas = document.getElementById('board');
  canvas.width = GRID_W * PX;
  canvas.height = GRID_H * PX;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  // Particles are rasterised 1:1 into an offscreen buffer, then blown up.
  const off = document.createElement('canvas');
  off.width = GRID_W;
  off.height = GRID_H;
  const offCtx = off.getContext('2d');
  const img = offCtx.createImageData(GRID_W, GRID_H);
  const px = img.data;

  const bgData = new Uint8ClampedArray(GRID_W * GRID_H * 4);
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const o = (y * GRID_W + x) * 4;
      let r = 12, g = 15, b = 23;
      if (x % CELL === 0) { r = 19; g = 24; b = 35; }
      if (y % CELL === 0) { r += 3; g += 4; b += 6; }
      bgData[o] = r; bgData[o + 1] = g; bgData[o + 2] = b; bgData[o + 3] = 255;
    }
  }

  const preview = document.getElementById('preview');
  const pctx = preview.getContext('2d');
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlayTitle');
  const overlayText = document.getElementById('overlayText');
  const scoreEl = document.getElementById('score');
  const levelEl = document.getElementById('level');
  const linesEl = document.getElementById('lines');

  // ------------------------------------------------------------------- state
  const grid = new Uint8Array(GRID_W * GRID_H);   // 0 = empty, else colour id
  const shade = new Uint8Array(GRID_W * GRID_H);
  const flashes = [];

  let piece = null;
  let nextId = 0;
  let bag = [];
  let score = 0, lines = 0, level = 1;
  let fallAcc = 0, sandAcc = 0;
  let lockTimer = 0, lockResets = 0, grounded = false;
  let softDrop = false;
  let scanFlip = false;
  let running = false, paused = false;

  // ------------------------------------------------------------- sand engine
  function stepSand() {
    scanFlip = !scanFlip;
    for (let y = GRID_H - 2; y >= 0; y--) {
      const row = y * GRID_W;
      const under = row + GRID_W;
      if (scanFlip) {
        for (let x = 0; x < GRID_W; x++) settle(x, row, under);
      } else {
        for (let x = GRID_W - 1; x >= 0; x--) settle(x, row, under);
      }
    }
  }

  function settle(x, row, under) {
    const i = row + x;
    const c = grid[i];
    if (!c) return;

    let t = -1;
    if (!grid[under + x]) {
      t = under + x;
    } else {
      // A grain only slides diagonally when the cell beside it is open too,
      // so piles hold a slope instead of leaking through one-wide gaps.
      const l = x > 0 && !grid[under + x - 1] && !grid[row + x - 1];
      const r = x < GRID_W - 1 && !grid[under + x + 1] && !grid[row + x + 1];
      if (l && r) t = Math.random() < 0.5 ? under + x - 1 : under + x + 1;
      else if (l) t = under + x - 1;
      else if (r) t = under + x + 1;
    }

    if (t >= 0) {
      grid[t] = c;
      shade[t] = shade[i];
      grid[i] = 0;
    }
  }

  function clearRows() {
    const full = [];
    for (let y = GRID_H - 1; y >= 0; y--) {
      const o = y * GRID_W;
      let packed = true;
      for (let x = 0; x < GRID_W; x++) {
        if (!grid[o + x]) { packed = false; break; }
      }
      if (packed) full.push(y);
    }
    if (!full.length) return 0;

    for (const y of full) flashes.push({ y, t: 1 });

    // Compact downwards: rows that survive slide into the freed space.
    let write = GRID_H - 1;
    let cursor = 0; // `full` is ordered bottom-to-top, same as this scan
    for (let y = GRID_H - 1; y >= 0; y--) {
      if (cursor < full.length && full[cursor] === y) { cursor++; continue; }
      if (write !== y) {
        grid.copyWithin(write * GRID_W, y * GRID_W, y * GRID_W + GRID_W);
        shade.copyWithin(write * GRID_W, y * GRID_W, y * GRID_W + GRID_W);
      }
      write--;
    }
    grid.fill(0, 0, (write + 1) * GRID_W);
    shade.fill(0, 0, (write + 1) * GRID_W);

    const n = full.length;
    score += (n * 20 + n * n * 5) * level;
    lines += n;
    level = 1 + Math.floor(lines / 40);
    return n;
  }

  // ----------------------------------------------------------------- pieces
  function nextFromBag() {
    if (!bag.length) {
      bag = [0, 1, 2, 3, 4, 5, 6];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    return bag.pop();
  }

  function makeShades(n) {
    const s = new Uint8Array(n * CELL * n * CELL);
    for (let i = 0; i < s.length; i++) s[i] = (Math.random() * 4) | 0;
    return s;
  }

  function spawn(id) {
    const mat = PIECES[id].mat.map(r => r.slice());
    const n = mat.length;
    let top = n;
    for (let r = 0; r < n; r++) {
      if (mat[r].some(Boolean)) { top = r; break; }
    }
    const p = {
      id,
      mat,
      n,
      x: Math.floor((GRID_W / CELL - n) / 2) * CELL,
      y: -top * CELL,
      shade: makeShades(n),
    };
    piece = p;
    grounded = false;
    lockTimer = 0;
    lockResets = 0;
    fallAcc = 0;

    if (collides(p.mat, p.x, p.y)) endGame();
  }

  function collides(mat, ox, oy) {
    const n = mat.length;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!mat[r][c]) continue;
        const bx = ox + c * CELL;
        const by = oy + r * CELL;
        if (bx < 0 || bx + CELL > GRID_W || by + CELL > GRID_H) return true;
        for (let y = Math.max(by, 0); y < by + CELL; y++) {
          const row = y * GRID_W;
          for (let x = bx; x < bx + CELL; x++) {
            if (grid[row + x]) return true;
          }
        }
      }
    }
    return false;
  }

  function rotated(mat, cw) {
    const n = mat.length;
    const out = [];
    for (let r = 0; r < n; r++) {
      out.push(new Array(n));
      for (let c = 0; c < n; c++) {
        out[r][c] = cw ? mat[n - 1 - c][r] : mat[c][n - 1 - r];
      }
    }
    return out;
  }

  function move(dx) {
    if (!piece || collides(piece.mat, piece.x + dx, piece.y)) return false;
    piece.x += dx;
    touchLock();
    return true;
  }

  function rotate(cw) {
    if (!piece) return;
    const mat = rotated(piece.mat, cw);
    const kicks = [0, MOVE_STEP, -MOVE_STEP, CELL, -CELL, CELL * 2, -CELL * 2];
    for (const dy of [0, -MOVE_STEP, -CELL]) {
      for (const dx of kicks) {
        if (!collides(mat, piece.x + dx, piece.y + dy)) {
          piece.mat = mat;
          piece.x += dx;
          piece.y += dy;
          piece.shade = makeShades(piece.n);
          touchLock();
          return;
        }
      }
    }
  }

  function touchLock() {
    if (grounded && lockResets < LOCK_RESETS) {
      lockResets++;
      lockTimer = 0;
      grounded = false;
    }
  }

  function hardDrop() {
    if (!piece) return;
    let dist = 0;
    while (!collides(piece.mat, piece.x, piece.y + 1)) { piece.y++; dist++; }
    score += Math.floor(dist / 2);
    lockPiece();
  }

  function ghostY() {
    let y = piece.y;
    while (!collides(piece.mat, piece.x, y + 1)) y++;
    return y;
  }

  function lockPiece() {
    const p = piece;
    const span = p.n * CELL;
    const id = p.id + 1;
    for (let r = 0; r < p.n; r++) {
      for (let c = 0; c < p.n; c++) {
        if (!p.mat[r][c]) continue;
        for (let yy = 0; yy < CELL; yy++) {
          const gy = p.y + r * CELL + yy;
          if (gy < 0 || gy >= GRID_H) continue;
          const row = gy * GRID_W;
          const srow = (r * CELL + yy) * span;
          for (let xx = 0; xx < CELL; xx++) {
            const gx = p.x + c * CELL + xx;
            grid[row + gx] = id;
            shade[row + gx] = p.shade[srow + c * CELL + xx];
          }
        }
      }
    }
    piece = null;
    const id2 = nextId;
    nextId = nextFromBag();
    drawPreview(nextId);
    spawn(id2);
  }

  // ------------------------------------------------------------------- input
  const held = new Set();
  let dasDir = 0, dasTimer = 0, arrTimer = 0;

  const KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowDown: 'down', KeyS: 'down',
    ArrowUp: 'cw', KeyW: 'cw', KeyX: 'cw',
    KeyZ: 'ccw', ControlLeft: 'ccw',
    Space: 'drop',
    KeyP: 'pause', Escape: 'pause',
    KeyR: 'restart', Enter: 'restart',
  };

  addEventListener('keydown', e => {
    const a = KEYMAP[e.code];
    if (!a) return;
    e.preventDefault();

    if (a === 'restart') {
      if (e.code === 'Enter' && running) return;
      reset();
      return;
    }
    if (a === 'pause') { togglePause(); return; }
    if (!running || paused || e.repeat) return;

    if (a === 'left' || a === 'right') {
      const dir = a === 'left' ? -MOVE_STEP : MOVE_STEP;
      move(dir);
      dasDir = dir;
      dasTimer = DAS;
      arrTimer = 0;
      held.add(a);
    } else if (a === 'down') {
      softDrop = true;
      held.add(a);
    } else if (a === 'cw' || a === 'ccw') {
      rotate(a === 'cw');
    } else if (a === 'drop') {
      hardDrop();
    }
  });

  addEventListener('keyup', e => {
    const a = KEYMAP[e.code];
    if (!a) return;
    held.delete(a);
    if (a === 'down') softDrop = false;
    if ((a === 'left' && dasDir < 0) || (a === 'right' && dasDir > 0)) dasDir = 0;
  });

  addEventListener('blur', () => {
    held.clear();
    dasDir = 0;
    softDrop = false;
    if (running && !paused) togglePause();
  });

  document.getElementById('restart').addEventListener('click', reset);

  function togglePause() {
    if (!running) return;
    paused = !paused;
    overlay.classList.toggle('hidden', !paused);
    if (paused) {
      overlayTitle.textContent = 'Paused';
      overlayText.textContent = 'Press P to resume';
    }
  }

  // ------------------------------------------------------------------ update
  function update(dt) {
    if (dasDir && (held.has('left') || held.has('right'))) {
      dasTimer -= dt;
      if (dasTimer <= 0) {
        arrTimer -= dt;
        while (arrTimer <= 0) {
          if (!move(dasDir)) { arrTimer = ARR; break; }
          arrTimer += ARR;
        }
      }
    }

    if (piece) {
      const base = Math.min(9 + (level - 1) * 2.5, 42);
      const speed = softDrop ? base * 12 : base;
      fallAcc += speed * dt;
      let steps = Math.min(fallAcc | 0, GRID_H);
      fallAcc -= steps;
      while (steps-- > 0) {
        if (collides(piece.mat, piece.x, piece.y + 1)) break;
        piece.y++;
      }

      if (piece && collides(piece.mat, piece.x, piece.y + 1)) {
        grounded = true;
        lockTimer += dt;
        if (lockTimer >= LOCK_DELAY) lockPiece();
      } else {
        lockTimer = 0;
      }
    }

    sandAcc += dt;
    let sandSteps = 0;
    while (sandAcc >= SAND_DT && sandSteps < SAND_MAX_STEPS) {
      stepSand();
      clearRows();
      sandAcc -= SAND_DT;
      sandSteps++;
    }
    if (sandAcc > SAND_DT * SAND_MAX_STEPS) sandAcc = 0;

    for (let i = flashes.length - 1; i >= 0; i--) {
      flashes[i].t -= dt * 4;
      if (flashes[i].t <= 0) flashes.splice(i, 1);
    }
  }

  // ------------------------------------------------------------------ render
  function stampPiece(p, oy, alpha) {
    const span = p.n * CELL;
    const rgbs = SHADES[p.id + 1];
    for (let r = 0; r < p.n; r++) {
      for (let c = 0; c < p.n; c++) {
        if (!p.mat[r][c]) continue;
        for (let yy = 0; yy < CELL; yy++) {
          const gy = oy + r * CELL + yy;
          if (gy < 0 || gy >= GRID_H) continue;
          const row = gy * GRID_W;
          const srow = (r * CELL + yy) * span;
          for (let xx = 0; xx < CELL; xx++) {
            const gx = p.x + c * CELL + xx;
            const rgb = rgbs[p.shade[srow + c * CELL + xx]];
            const o = (row + gx) * 4;
            if (alpha >= 1) {
              px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2];
            } else {
              px[o] += (rgb[0] - px[o]) * alpha;
              px[o + 1] += (rgb[1] - px[o + 1]) * alpha;
              px[o + 2] += (rgb[2] - px[o + 2]) * alpha;
            }
          }
        }
      }
    }
  }

  function render() {
    px.set(bgData);

    for (let i = 0; i < grid.length; i++) {
      const c = grid[i];
      if (!c) continue;
      const rgb = SHADES[c][shade[i]];
      const o = i * 4;
      px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2];
    }

    if (piece) {
      stampPiece(piece, ghostY(), 0.22);
      stampPiece(piece, piece.y, 1);
    }

    offCtx.putImageData(img, 0, 0);
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

    for (const f of flashes) {
      ctx.fillStyle = `rgba(255,255,255,${f.t * 0.55})`;
      ctx.fillRect(0, f.y * PX, canvas.width, PX);
    }

    if (scoreEl.textContent !== String(score)) scoreEl.textContent = score;
    if (levelEl.textContent !== String(level)) levelEl.textContent = level;
    if (linesEl.textContent !== String(lines)) linesEl.textContent = lines;
  }

  function drawPreview(id) {
    const p = PIECES[id];
    const n = p.mat.length;
    let minR = n, maxR = -1, minC = n, maxC = -1;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!p.mat[r][c]) continue;
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }
    }
    const w = maxC - minC + 1, h = maxR - minR + 1;
    const s = 3;
    const ox = Math.round((preview.width - w * CELL * s) / 2);
    const oy = Math.round((preview.height - h * CELL * s) / 2);
    const rgbs = SHADES[id + 1];

    pctx.clearRect(0, 0, preview.width, preview.height);
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        if (!p.mat[r][c]) continue;
        for (let yy = 0; yy < CELL; yy++) {
          for (let xx = 0; xx < CELL; xx++) {
            const rgb = rgbs[(Math.random() * 4) | 0];
            pctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
            pctx.fillRect(
              ox + ((c - minC) * CELL + xx) * s,
              oy + ((r - minR) * CELL + yy) * s,
              s, s
            );
          }
        }
      }
    }
  }

  // -------------------------------------------------------------- game flow
  function endGame() {
    running = false;
    piece = null;
    overlayTitle.textContent = 'Game Over';
    overlayText.textContent = `Score ${score} · ${lines} rows · level ${level}`;
    overlay.classList.remove('hidden');
  }

  function reset() {
    grid.fill(0);
    shade.fill(0);
    flashes.length = 0;
    bag = [];
    score = 0; lines = 0; level = 1;
    fallAcc = 0; sandAcc = 0;
    softDrop = false; dasDir = 0;
    held.clear();
    paused = false;
    running = true;
    overlay.classList.add('hidden');
    spawn(nextFromBag());
    nextId = nextFromBag();
    drawPreview(nextId);
  }

  let last = performance.now();
  function loop(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (running && !paused) update(dt);
    render();
    requestAnimationFrame(loop);
  }

  reset();
  requestAnimationFrame(loop);
})();
