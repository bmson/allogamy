# allogamy

A therapeutic flight piece. You are a **red-crowned crane** gliding over an
endless landscape painted in a Monet-leaning **watercolor** style — luminous
washes, violet shadows, paper grain, poppy drifts, calm tarns with water
lilies. There is nothing to win.

**Allogamy is the theme and the loop:** skim low and your wake stirs golden
pollen off the meadow. Where a grain settles, something grows — wildflowers,
grass tufts, ferns, flowering shrubs, little saplings, lilies when it lands
on water. Circle back and the strip you flew is in bloom.

## Run

```bash
pnpm install
pnpm dev      # http://localhost:5173
```

Runs on plain WebGL (no WebGPU required).

## Controls

- **↑ / ↓ or W / S** — climb & dive (diving low is how you pollinate)
- **← / → or A / D** — bank into a turn
- **scroll** — trim cruise speed
- **drag** — ease the camera around

## How it's built

The live game is `src/impressionScene.js` plus the modules in `src/scene/`.
Everything on screen — terrain, trees, water, the crane, pollen, blooms — is
one kind of primitive: a rotated elliptical **watercolor dab** rendered as a
point sprite, depth-sorted and blended, then finished by a single post pass
(wet-edge cohesion, halation, pigment edge-darkening, paper grain, a deckled
border).

```
src/
  impressionScene.js    orchestrator: renderer, streaming, wake, flight, camera
  scene/
    config.js           world + GPU-layout constants, Monet light
    terrain.js          endless seeded height/biome field (ponds below y=4)
    tileBuilder.js      paints one tile of strokes into its buffer slot
    crane.js            the crane's dabs + wingbeat/glide/head animation
    blooms.js           pollen that settled -> growing plants
    shaders.js          splat / sky / watercolor post GLSL
```

### Performance notes

- One shared interleaved layout for every splat buffer (`f32` pos+size+angle,
  `u8` color+params): ~27 bytes/stroke instead of 48, two GPU uploads instead
  of eight.
- Tiles are built **directly into a persistent slot** of the big buffers from
  a cached per-tile height grid (~1.5k noise samples instead of ~2.5M), so
  streaming in a tile neither hitches nor recopies the world.
- The painter's-order sort is an O(n) counting sort over only strokes that
  can matter (radius + behind-camera culled), run every 6–10 frames.
- Live stats: `window.__allogamyStats` (strokes, visible, sort/tile ms,
  blooms…).

The `src/core|world|flight|render` TypeScript tree is an older WebGPU
experiment that is not wired into `index.html`; the game does not use it.
