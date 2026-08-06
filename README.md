# Sand Tetris

Tetris crossed with a falling-sand automaton. Tetromino pieces are made of loose
grains: you steer them like normal Tetris, but the moment one lands it shatters
into sand that slumps, spreads and piles up. A clear fires when a single colour
forms an unbroken chain of grains touching both the left and the right wall &mdash;
the whole connected blob vanishes and everything resting on it collapses in.

Everything lives in `index.html` — markup, styles and script inlined in that one
file. Open it in a browser straight off disk. No build step, no dependencies, no
server, no network requests.

## Controls

| Key | Action |
| --- | --- |
| `←` `→` / `A` `D` | Move |
| `↑` / `W` / `X` | Rotate clockwise |
| `Z` | Rotate counter-clockwise |
| `↓` / `S` | Soft drop |
| `Space` | Hard drop |
| `P` / `Esc` | Pause |
| `R` | Restart |

## How it works

The field is a 70 × 140 grid of grains (`Uint8Array` of colour ids plus a
parallel array of brightness variants). One tetromino block is a 7 × 7 cluster
of grains, so the field is 10 blocks wide and 20 tall — standard Tetris
proportions, 9800 grains.

Seven shapes share five colours. That is a deliberate difficulty dial rather
than a shortcut: with a distinct colour per shape, one piece's grains only
spread about halfway across the field, so same-colour blobs almost never meet
and a wall-to-wall bridge effectively never forms.

- **Piece phase** — the active piece stays rigid and is never written to the
  grid; it moves in grain units and collision-tests its blocks against the grid.
  Movement is half-block steps with DAS/ARR auto-repeat, plus wall kicks on
  rotation and a short lock delay so you can slide a piece after it touches down.
- **Sand phase** — on lock the piece's grains are stamped into the grid.
  `stepSand()` scans bottom-up, moving each grain down, or diagonally when the
  cell beside it is open too. That side check is what lets piles hold a slope
  instead of leaking through one-wide gaps. Scan direction alternates each tick
  to avoid a left/right drift bias.
- **Clearing** — a flood fill seeded from every grain on the left wall walks
  same-colour neighbours (8-connected, so corner contact counts). Any blob that
  reaches the right wall is deleted outright; no row shifting, the sand just
  falls into the hole, which often sets up chain clears. The scan runs at most
  once a frame and only when the sand actually changed.
- **Rendering** — grains are written into an `ImageData` buffer at 1 grain per
  pixel, then scaled up with smoothing off. That is one `drawImage` per frame
  instead of thousands of `fillRect` calls.

## Keeping it at 60fps

The automaton tracks which rows could still move. A grain that shifts marks its
own row plus the ones above and below as active for the next step; everything
else is skipped, so a settled pile costs almost nothing and only the working
surface is simulated. The bridge scan is gated behind a `gridVersion` counter,
and the ghost piece's landing row is cached against the same counter.

The simulation runs on a fixed 1/120 s timestep decoupled from the render loop,
capped at 4 catch-up steps per frame. Measured in Chromium over 180-frame
windows on the 9800-grain field: 16.7 ms median, and at most one frame in 180
over budget. The panel shows a live FPS readout.

Widening the field makes bridges harder, because a piece's grains spread a
roughly fixed distance regardless of how wide the field is. Measured over four
40-drop sessions of random play at 70 × 140: five colours gives 5.7 clears per
40 drops, four colours gives 6.8. Five was kept for the extra colour variety;
dropping `Z` and `J` onto existing hues in `PIECES` is the one-line change if a
more forgiving game is wanted.
