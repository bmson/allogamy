# allogamy

An art-installation flight over a living, splat-painted landscape. You are a
large, deliberate bird gliding across endless lush hills rendered in a
Gaussian-splat / point-cloud style — bold saturated greens, a wide cyan sky,
wildflowers, and wind. Cross-pollination is the theme: later you'll spread
flora across the world by breathing onto it.

**Art direction:** *Ghibli Verdant* — see `style.png` reference. Bright clean
midday light, painterly clustered splats, rounded canopies, theatrical wind.

## Tech

- **Three.js + WebGPURenderer** (WebGPU only), TypeScript, Vite.
- Terrain = a **solid colour-matched mesh** (you can never see through the
  ground) under a **dense point-splat layer** + wildflower speckle.
- **Seamless infinite streaming**: chunks are generated on the fly, nearest
  first, well beyond the fog wall, so terrain never visibly changes on screen.
- **Weighty banking flight**: tilt to turn, climb/dive trades for speed, all
  eased so the bird feels heavy and gliding.

## Run

```bash
pnpm install
pnpm dev      # http://localhost:5173  (also exposed on your LAN for the phone)
```

Requires a WebGPU-capable browser (Chrome recommended) for the best path.

## Controls

- **← / →** — tilt & bank into a turn
- **↑ / ↓** — climb & dive

## Roadmap

- **M1 ✅** Splat terrain, streaming, sky, weighty flight.
- **M2** Procedural tree generator (trunks + detailed non-repetitive canopies),
  bushes with flowers & berries, plush wind-driven grass, GPU wind field.
- **M3** Hyper-real pelican-derived bird mesh with spring-driven weighty flap.
- **M4** iPhone gyroscope control + sound-based WebRTC pairing (ggwave chirp) +
  blow-to-spread-pollen.

## Layout

```
src/
  core/      engine loop, input, rng, noise
  render/    palette, sky, procedural textures
  world/     terrain field, chunk builder, streaming manager
  flight/    flight controller + chase camera
  config.ts  world tunables
```
