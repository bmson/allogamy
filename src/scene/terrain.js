import { makeNoise } from './noise.js';
import { WATER_LEVEL } from './config.js';

// One global noise field -> seamless endless terrain & biomes. The seed can be
// swapped at runtime (new world); every consumer reads through these wrappers
// so they always see the live field.

let WORLD_SEED = 20260612;
let N = makeNoise(WORLD_SEED);

export function setWorldSeed(seed) {
  WORLD_SEED = seed | 0;
  N = makeNoise(WORLD_SEED);
}
export const getWorldSeed = () => WORLD_SEED;
export const noise = {
  fbm: (x, y, o) => N.fbm(x, y, o),
  ridge: (x, y, o) => N.ridge(x, y, o),
  noise2: (x, y) => N.noise2(x, y),
};

const EP = 1.2;

export function heightAt(x, z) {
  const s = 0.013;
  const broad = N.fbm(x * s * 0.32 + 31, z * s * 0.32 + 31, 3) * 22;
  const hills = N.fbm(x * s, z * s, 5) * 9;
  const crest = N.ridge(x * s * 1.7 + 12, z * s * 1.7 + 12, 4) * 7;
  const detail = N.fbm(x * 0.06 + 5, z * 0.06 + 5, 3) * 1.4;
  return 7 + broad + hills + crest + detail; // no falloff -> endless rolling hills
}

/** Ground level clamped to the pond surface — what flight & pollen settle on. */
export function surfaceAt(x, z) {
  const h = heightAt(x, z);
  return h > WATER_LEVEL ? h : WATER_LEVEL;
}

export function slopeAt(x, z) {
  return Math.hypot(
    heightAt(x + EP, z) - heightAt(x - EP, z),
    heightAt(x, z + EP) - heightAt(x, z - EP)
  ) / (2 * EP);
}

export function pathMask(x, z) {
  const w = N.fbm(x * 0.006 + 70, z * 0.006 + 70, 3);
  const d = 0.045 - Math.abs(w - 0.02);
  if (d <= 0) return 0;
  if (d >= 0.045) return 1;
  const t = d / 0.045;
  return t * t * (3 - 2 * t);
}

export const groveField = (x, z) => N.fbm(x * 0.025 + 7, z * 0.025 + 7, 3);
export const dryness = (x, z, h) =>
  Math.min(1, Math.max(0, (h - 18) / 12 + N.fbm(x * 0.03 + 55, z * 0.03 + 55, 2) * 0.4));
export const poppyField = (x, z) =>
  Math.min(1, Math.max(0, N.fbm(x * 0.014 + 300, z * 0.014 + 300, 3) * 2.2 - 0.45));

export function tileSeed(tx, tz) {
  let h = ((tx | 0) * 374761393 + (tz | 0) * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) ^ WORLD_SEED) >>> 0;
}
