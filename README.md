# Sand Tetris

Tetris crossed with a falling-sand automaton. Tetromino pieces are made of loose
grains: you steer them like normal Tetris, but the moment one lands it shatters
into sand that slumps, spreads and piles up. A row clears when every grain
position across its width is packed.

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

The field is a 60 × 120 grid of grains (`Uint8Array` of colour ids plus a
parallel array of brightness variants). One tetromino block is a 6 × 6 cluster
of grains, so the field is 10 blocks wide and 20 tall.

- **Piece phase** — the active piece stays rigid and is never written to the
  grid; it moves in grain units and collision-tests its blocks against the grid.
  Movement is half-block steps with DAS/ARR auto-repeat, plus wall kicks on
  rotation and a short lock delay so you can slide a piece after it touches down.
- **Sand phase** — on lock the piece's grains are stamped into the grid.
  `stepSand()` scans bottom-up, moving each grain down, or diagonally when the
  cell beside it is open too. That side check is what lets piles hold a slope
  instead of leaking through one-wide gaps. Scan direction alternates each tick
  to avoid a left/right drift bias.
- **Clearing** — full grain rows are found and removed every tick, and the rows
  above slide down. Because it runs continuously, settling sand produces
  cascading clears.
- **Rendering** — grains are written into an `ImageData` buffer at 1 grain per
  pixel, then scaled up with smoothing off. That is one `drawImage` per frame
  instead of thousands of `fillRect` calls.

The simulation runs on a fixed 1/120 s timestep decoupled from the render loop,
capped at 4 catch-up steps per frame. Measured at a steady 60fps in Chromium.
