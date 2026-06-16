import * as THREE from 'three';

/* =====================================================================
   Impression — endless edition
   The painting pipeline is unchanged from the original (detail-preserving
   Kuwahara + halation glow + impasto relief + a no-blacks Monet grade).
   What changed:

   · NO CLOUDS, no origin-anchored ridge rings — they only made sense for
     one fixed scene.
   · The terrain is now a single continuous height field with no island
     falloff, so the hills roll on forever.
   · The world is cut into deterministic TILES generated from one global
     noise field. A grid of tiles follows the stork; as you fly forward
     the trailing tiles are recycled into fresh ground ahead, so you can
     navigate endlessly. Strokes dissolve into the atmosphere at the
     loaded edge, so the boundary is never a visible wall.
   · The camera is a soft chase rig around the bird: keyboard input banks
     and climbs the stork, scroll trims speed, and dragging eases the frame.
   ===================================================================== */

// ---------------- seeded RNG + gradient noise ----------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeNoise(seed) {
  const rand = mulberry32(seed);
  const perm = new Uint8Array(512);
  const gxA = new Float32Array(512), gyA = new Float32Array(512);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  for (let i = 0; i < 512; i++) {
    perm[i] = perm[i & 255];
    const a = rand() * Math.PI * 2;
    gxA[i] = Math.cos(a); gyA[i] = Math.sin(a);
  }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  function noise2(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);
    const h = (X, Y) => perm[(X & 255) + perm[Y & 255]];
    const d = (i, dx, dy) => gxA[i] * dx + gyA[i] * dy;
    const n00 = d(h(xi, yi), xf, yf);
    const n10 = d(h(xi + 1, yi), xf - 1, yf);
    const n01 = d(h(xi, yi + 1), xf, yf - 1);
    const n11 = d(h(xi + 1, yi + 1), xf - 1, yf - 1);
    const x1 = n00 + u * (n10 - n00);
    const x2 = n01 + u * (n11 - n01);
    return x1 + v * (x2 - x1);
  }
  function fbm(x, y, oct = 5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      sum += amp * noise2(x * freq, y * freq);
      norm += amp; amp *= 0.52; freq *= 2.07;
    }
    return sum / norm;
  }
  function ridge(x, y, oct = 4) {
    let amp = 0.6, freq = 1, sum = 0;
    for (let o = 0; o < oct; o++) {
      sum += amp * (0.7 - Math.abs(noise2(x * freq, y * freq)));
      amp *= 0.5; freq *= 2.1;
    }
    return sum;
  }
  return { noise2, fbm, ridge, rand };
}

// ---------------- world config ----------------
const TILE = 58;                 // world units per tile
const GRID_R = 2;                 // tiles kept each side of camera -> (2R+1)^2 active
const ACTIVE = 2 * GRID_R + 1;    // 5x5 = 25 live tiles
const FADE_OUT = GRID_R * TILE - 14;   // strokes fully gone by here
const FADE_IN  = FADE_OUT - 44;       // start dissolving here
const SORT_CULL_RADIUS = FADE_OUT + 2; // only sort/upload strokes that can still contribute after edge fade
const PER_TILE_CAP = 20000;       // hard ceiling on splats per tile
const CAP = ACTIVE * ACTIVE * PER_TILE_CAP;  // total GPU buffer capacity

let WORLD_SEED = 20260612;
let DENSITY = 0.86;               // user-tunable stroke density
let N = makeNoise(WORLD_SEED);    // ONE global noise -> seamless terrain & biomes

const T_GROUND = 0, T_FOLIAGE = 1, T_GRASS = 3, T_LEAF = 4, T_FLY = 5, T_BIRD = 6, T_SMOKE = 7;

// Monet light: continuous modelling, violet shadows that stay LUMINOUS
const SUN = new THREE.Color(1.0, 0.94, 0.8);
const SHADOW = new THREE.Color(0.55, 0.52, 0.78);
const LIGHT = new THREE.Vector3(0.62, 0.72, 0.32).normalize();
function paintLight(color, lambert) {
  const lit = color.clone().multiply(SUN).multiplyScalar(0.72 + 0.55 * lambert);
  const shd = color.clone().lerp(SHADOW, 0.55).multiplyScalar(0.78);
  return shd.lerp(lit, Math.pow(lambert, 0.8));
}

// ---------------- global terrain + biome fields (pure functions of N) ----------------
const EP = 1.2;
function heightAt(x, z) {
  const s = 0.013;
  const broad  = N.fbm(x * s * 0.32 + 31, z * s * 0.32 + 31, 3) * 22;
  const hills  = N.fbm(x * s, z * s, 5) * 9;
  const crest  = N.ridge(x * s * 1.7 + 12, z * s * 1.7 + 12, 4) * 7;
  const detail = N.fbm(x * 0.06 + 5, z * 0.06 + 5, 3) * 1.4;
  return 7 + broad + hills + crest + detail;   // no falloff -> endless rolling hills
}
function normalAt(x, z) {
  return new THREE.Vector3(
    heightAt(x - EP, z) - heightAt(x + EP, z), 2 * EP,
    heightAt(x, z - EP) - heightAt(x, z + EP)
  ).normalize();
}
function slopeAt(x, z) {
  return Math.hypot(heightAt(x + EP, z) - heightAt(x - EP, z), heightAt(x, z + EP) - heightAt(x, z - EP)) / (2 * EP);
}
function pathMask(x, z) {
  const w = N.fbm(x * 0.006 + 70, z * 0.006 + 70, 3);
  return THREE.MathUtils.smoothstep(0.045 - Math.abs(w - 0.02), 0.0, 0.045);
}
const groveField = (x, z) => N.fbm(x * 0.025 + 7, z * 0.025 + 7, 3);
const dryness = (x, z, h) =>
  THREE.MathUtils.clamp((h - 18) / 12 + N.fbm(x * 0.03 + 55, z * 0.03 + 55, 2) * 0.4, 0, 1);
const poppyField = (x, z) =>
  THREE.MathUtils.clamp(N.fbm(x * 0.014 + 300, z * 0.014 + 300, 3) * 2.2 - 0.45, 0, 1);

function tileSeed(tx, tz) {
  let h = ((tx | 0) * 374761393 + (tz | 0) * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) ^ WORLD_SEED) >>> 0;
}

// ---------------- build one tile of strokes ----------------
function buildTile(tx, tz) {
  const ox = tx * TILE, oz = tz * TILE;
  const rng = mulberry32(tileSeed(tx, tz));
  const area = TILE * TILE;
  const K = DENSITY * area / 22500;
  const cnt = (b) => Math.max(0, Math.round(b * K));

  const pos = [], col = [], size = [], angle = [], aspect = [], type = [], phase = [], flex = [];
  const c = new THREE.Color();
  let n = 0;
  const full = () => n >= PER_TILE_CAP;
  const push = (x, y, z, color, sz, ang, asp, ty, fx = 0) => {
    if (n >= PER_TILE_CAP) return;
    pos.push(x, y, z); col.push(color.r, color.g, color.b);
    size.push(sz); angle.push(ang); aspect.push(asp); type.push(ty);
    phase.push(rng()); flex.push(fx); n++;
  };
  const jitter = (v, h = 0.02, s = 0.08, l = 0.06) => {
    const hsl = {}; v.getHSL(hsl);
    v.setHSL(
      (hsl.h + (rng() - 0.5) * 2 * h + 1) % 1,
      THREE.MathUtils.clamp(hsl.s + (rng() - 0.5) * 2 * s, 0, 1),
      THREE.MathUtils.clamp(hsl.l + (rng() - 0.5) * 2 * l, 0.04, 0.97)
    );
    return v;
  };

  function groundColor(x, z, h, slope, soilN) {
    const path = pathMask(x, z);
    if (path > 0.5 && slope < 0.6) c.setHSL(0.075, 0.42, 0.52);
    else if (slope > 0.7) c.setHSL(0.07 + rng() * 0.02, 0.18, 0.46);
    else if (soilN < -0.22) c.setHSL(0.07, 0.3, 0.36 + rng() * 0.05);
    else {
      const meadow = N.fbm(x * 0.04 + 99, z * 0.04, 3);
      const dry = dryness(x, z, h);
      const hue = THREE.MathUtils.lerp(0.27 + meadow * 0.06, 0.11, dry);
      c.setHSL(hue, THREE.MathUtils.lerp(0.55, 0.46, dry), THREE.MathUtils.lerp(0.42, 0.5, dry));
      c.lerp(new THREE.Color(0.65, 0.3, 0.18), poppyField(x, z) * 0.25);
    }
    return c;
  }

  // -------- 1) underpainting: contour strokes (grid aligned to world for seamless tiling) --------
  {
    const GS = 0.885;
    const GR = Math.max(6, Math.round(TILE / GS));
    const cell = TILE / GR;
    for (let gx = 0; gx < GR && !full(); gx++) {
      for (let gz = 0; gz < GR; gz++) {
        const x = ox + (gx + 0.5) * cell + (rng() - 0.5) * cell * 1.1;
        const z = oz + (gz + 0.5) * cell + (rng() - 0.5) * cell * 1.1;
        const h = heightAt(x, z);
        const nrm = normalAt(x, z);
        const lambert = Math.max(0, nrm.dot(LIGHT));
        groundColor(x, z, h, 1 - nrm.y > 0.36 ? 1 : slopeAt(x, z), N.fbm(x * 0.045 + 200, z * 0.045 + 200, 3));
        const painted = paintLight(jitter(c), lambert);
        const ang = Math.atan2(nrm.z, nrm.x) + Math.PI / 2 + (rng() - 0.5) * 0.4;
        push(x, h - 0.1, z, painted, cell * (3.0 + rng() * 1.4), ang, 0.32 + rng() * 0.14, T_GROUND);
      }
    }
  }

  // -------- 2) broken-color texture strokes --------
  for (let i = cnt(14000); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const h = heightAt(x, z);
    const nrm = normalAt(x, z);
    const lambert = Math.max(0, nrm.dot(LIGHT));
    groundColor(x, z, h, slopeAt(x, z), N.fbm(x * 0.045 + 200, z * 0.045 + 200, 3));
    const painted = paintLight(jitter(c, 0.045, 0.14, 0.12), lambert);
    const ang = Math.atan2(nrm.z, nrm.x) + Math.PI / 2 + (rng() - 0.5) * 0.9;
    push(x, h + 0.05, z, painted, 1.1 + rng() * 1.4, ang, 0.26 + rng() * 0.2, T_GROUND);
  }

  // -------- 3) grass --------
  for (let i = cnt(28000); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const h = heightAt(x, z);
    if (h > 32) continue;
    if (slopeAt(x, z) > 0.55) continue;
    if (pathMask(x, z) > 0.55) continue;
    const lambert = Math.max(0, 0.72 + (rng() - 0.5) * 0.3);
    const dry = dryness(x, z, h);
    const hue = THREE.MathUtils.lerp(0.25 + N.fbm(x * 0.05 + 99, z * 0.05, 3) * 0.07, 0.11, dry);
    c.setHSL(hue, THREE.MathUtils.lerp(0.58, 0.5, dry), 0.44 + rng() * 0.14 + dry * 0.06);
    c.lerp(new THREE.Color(0.7, 0.35, 0.2), poppyField(x, z) * 0.2);
    const painted = paintLight(jitter(c, 0.03, 0.12, 0.1), lambert);
    const ang = Math.PI / 2 + (rng() - 0.5) * 0.7;
    const tall = 0.8 + rng() * 1.0 + dry * 0.4;
    push(x, h + 0.25 + rng() * 0.3, z, painted, tall, ang, 0.16, T_GRASS, 0.6 + rng() * 0.4);
  }

  // -------- 4) poppies + other wildflowers --------
  for (let i = cnt(8000); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const h = heightAt(x, z);
    if (h > 24) continue;
    if (slopeAt(x, z) > 0.45) continue;
    const pf = poppyField(x, z);
    if (rng() > pf * 0.95) continue;
    c.setHSL(0.005 + rng() * 0.025, 0.85, 0.5 + rng() * 0.12);
    push(x, h + 0.4 + rng() * 0.25, z, jitter(c, 0.012, 0.05, 0.06),
         0.28 + rng() * 0.2, rng() * Math.PI, 0.8, T_GRASS, 0.3 + rng() * 0.3);
    if (rng() < 0.2) {
      c.setHSL(0.95, 0.5, 0.2);
      push(x, h + 0.42, z, c.clone(), 0.1, 0, 0.9, T_GRASS, 0.3);
    }
  }
  for (let i = cnt(2600); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const h = heightAt(x, z);
    if (h > 22) continue;
    if (slopeAt(x, z) > 0.4) continue;
    if (N.fbm(x * 0.07 + 17, z * 0.07 + 17, 2) < 0.08) continue;
    const p = rng();
    if (p < 0.4) c.setHSL(0.12, 0.9, 0.64);
    else if (p < 0.7) c.setHSL(0.75, 0.45, 0.68);
    else c.setHSL(0.0, 0.0, 0.95);
    push(x, h + 0.45, z, jitter(c), 0.3 + rng() * 0.22, rng() * Math.PI, 0.85, T_GRASS, 0.3 + rng() * 0.3);
  }

  // -------- 5) path detail --------
  for (let i = cnt(2800); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const m = pathMask(x, z);
    if (m < 0.25) continue;
    const h = heightAt(x, z);
    if (slopeAt(x, z) > 0.5) continue;
    if (m > 0.6 && rng() < 0.5) {
      c.setHSL(0.08 + rng() * 0.03, 0.16, 0.46 + rng() * 0.22);
      push(x, h + 0.12, z, jitter(c, 0.01, 0.03, 0.06), 0.25 + rng() * 0.3, rng() * Math.PI, 0.7, T_GROUND);
    } else {
      c.setHSL(0.085, 0.32, 0.48);
      push(x, h + 0.08, z, jitter(c), 0.8 + rng() * 0.8, rng() * Math.PI, 0.34, T_GROUND);
    }
  }

  // -------- 6) boulders --------
  for (let r = cnt(26); r > 0 && !full(); r--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const h = heightAt(x, z);
    if (h < 2) continue;
    if (slopeAt(x, z) < 0.25 && rng() < 0.7) continue;
    const R = 0.8 + rng() * 2.4;
    const dabs = (10 + R * 9) | 0;
    const baseHue = 0.08 + rng() * 0.04;
    for (let i = 0; i < dabs && !full(); i++) {
      const a = rng() * Math.PI * 2;
      const rr = Math.pow(rng(), 0.6) * R;
      const dy = (rng() * 0.9) * R * 0.7;
      const topness = dy / (R * 0.7);
      if (topness < 0.25 && rng() < 0.4) c.setHSL(0.3, 0.36, 0.32);
      else {
        c.setHSL(baseHue, 0.12 + rng() * 0.05, 0.42 + topness * 0.3);
        c.lerp(SUN, topness * 0.3);
        c.lerp(SHADOW, (1 - topness) * 0.32);
      }
      push(x + Math.cos(a) * rr, h + dy, z + Math.sin(a) * rr, jitter(c, 0.01, 0.04, 0.05),
           0.6 + rng() * 0.8 * R * 0.5, rng() * Math.PI, 0.55 + rng() * 0.3, T_GROUND);
    }
  }

  // -------- 7) forest --------
  function shadowPool(x, z, R) {
    const dabs = (5 + R * 4) | 0;
    for (let i = 0; i < dabs && !full(); i++) {
      const a = rng() * Math.PI * 2;
      const rr = Math.sqrt(rng()) * R;
      const px = x + Math.cos(a) * rr - LIGHT.x * R * 0.4;
      const pz = z + Math.sin(a) * rr - LIGHT.z * R * 0.4;
      const ph = heightAt(px, pz);
      c.setHSL(0.68, 0.3, 0.3 + rng() * 0.06);
      c.lerp(new THREE.Color(0.2, 0.32, 0.24), 0.45);
      push(px, ph + 0.06, pz, c.clone(), 1.4 + rng() * 1.5, rng() * Math.PI, 0.4, T_GROUND);
    }
  }
  function trunkRun(x, z, h, height, leanA, leanM, hue, sat, lum, fleck) {
    for (let i = 0; i < 3 && !full(); i++) {
      const a = rng() * Math.PI * 2;
      c.setHSL(hue, sat, lum * 0.7);
      push(x + Math.cos(a) * 0.35, h + 0.15, z + Math.sin(a) * 0.35, jitter(c, 0.01, 0.04, 0.02), 0.5, a, 0.4, T_GROUND);
    }
    const segs = (6 + height) | 0;
    for (let i = 0; i < segs && !full(); i++) {
      const t = i / segs;
      const lx = Math.cos(leanA) * leanM * t * t;
      const lz = Math.sin(leanA) * leanM * t * t;
      c.setHSL(hue, sat, lum + t * 0.1);
      c.lerp(SUN, t * 0.15);
      push(x + lx + (rng() - 0.5) * 0.1, h + t * height, z + lz + (rng() - 0.5) * 0.1,
           jitter(c, 0.01, 0.05, 0.03), 0.55 - t * 0.22, Math.PI / 2 + (rng() - 0.5) * 0.25, 0.28, T_GROUND, t * 0.15);
      if (fleck && rng() < 0.5) {
        c.setHSL(0.07, 0.2, 0.16);
        push(x + lx + (rng() - 0.5) * 0.15, h + t * height + (rng() - 0.5) * 0.3, z + lz + (rng() - 0.5) * 0.15,
             c.clone(), 0.16, (rng() - 0.5) * 0.4, 0.4, T_GROUND);
      }
    }
    return { tipX: x + Math.cos(leanA) * leanM, tipZ: z + Math.sin(leanA) * leanM };
  }
  function canopyClump(cx, cy, cz, R, hueBase, count, flexBase, airy) {
    const core = (count * 0.45) | 0;
    for (let i = 0; i < core && !full(); i++) {
      const u = rng() * 2 - 1, a = rng() * Math.PI * 2;
      const rr = Math.pow(rng(), 0.6) * R * 0.62;
      const sq = Math.sqrt(1 - u * u);
      c.setHSL(hueBase + 0.04, 0.45, 0.2 + rng() * 0.05);
      c.lerp(SHADOW, 0.35);
      push(cx + sq * Math.cos(a) * rr, cy + u * rr * 0.8, cz + sq * Math.sin(a) * rr,
           jitter(c, 0.015, 0.06, 0.04), 0.9 + rng() * 0.9, rng() * Math.PI,
           0.55 + rng() * 0.3, T_FOLIAGE, flexBase * 0.3);
    }
    for (let i = 0; i < count && !full(); i++) {
      const u = rng() * 2 - 1, a = rng() * Math.PI * 2;
      const rr = (0.55 + 0.45 * Math.pow(rng(), 0.35)) * R;
      const sq = Math.sqrt(1 - u * u);
      const dx = sq * Math.cos(a) * rr, dz = sq * Math.sin(a) * rr, dy = u * rr * 0.8;
      const lam = THREE.MathUtils.clamp((dx * LIGHT.x + dy * LIGHT.y + dz * LIGHT.z) / (rr + 0.001) * 0.5 + 0.55, 0, 1);
      c.setHSL(hueBase + (rng() - 0.5) * 0.04, airy ? 0.55 : 0.5, airy ? 0.4 : 0.34);
      const painted = paintLight(jitter(c, 0.03, 0.1, 0.08), lam);
      const edge = rr / (R + 0.001);
      const tangent = Math.atan2(dz, dx) + Math.PI / 2;
      push(cx + dx, cy + dy, cz + dz, painted, 0.7 + rng() * 0.9, tangent + (rng() - 0.5) * 0.8,
           0.4 + rng() * 0.3, T_FOLIAGE, flexBase * (0.4 + 0.6 * edge));
      if (lam > 0.8 && rng() < 0.18) {
        c.setHSL(0.13, 0.9, 0.74);
        push(cx + dx * 1.04, cy + dy * 1.04, cz + dz * 1.04, c.clone(),
             0.3 + rng() * 0.2, tangent, 0.7, T_FOLIAGE, flexBase);
      }
    }
  }
  function fern(x, z, h) {
    const fronds = (4 + rng() * 3) | 0;
    for (let i = 0; i < fronds && !full(); i++) {
      const a = rng() * Math.PI * 2;
      const len = 0.5 + rng() * 0.5;
      c.setHSL(0.34, 0.48, 0.26 + rng() * 0.08);
      push(x + Math.cos(a) * len * 0.6, h + 0.3 + rng() * 0.25, z + Math.sin(a) * len * 0.6,
           jitter(c, 0.015, 0.06, 0.04), 0.8 + rng() * 0.5,
           Math.PI / 2 + (rng() - 0.5) * 1.4, 0.16, T_GRASS, 0.5 + rng() * 0.3);
    }
  }

  let trees = 0;
  const leafSpots = [];
  const wakeLeafSources = [];
  const treeTarget = cnt(150), treeAttempts = cnt(1500);
  for (let attempt = 0; attempt < treeAttempts && trees < treeTarget && !full(); attempt++) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const h = heightAt(x, z);
    if (h > 24) continue;
    if (slopeAt(x, z) > 0.6) continue;
    if (pathMask(x, z) > 0.4) continue;
    const grove = groveField(x, z);
    if (grove < 0.06 && rng() < 0.75) continue;
    trees++;

    const species = rng();
    if (species < 0.42) {
      const height = 4.5 + rng() * 3.5;
      const leanA = rng() * Math.PI * 2, leanM = rng() * 1.2;
      shadowPool(x, z, height * 0.55);
      const { tipX, tipZ } = trunkRun(x, z, h, height, leanA, leanM, 0.07, 0.38, 0.2, false);
      const hueBase = 0.27 + rng() * 0.07;
      const clumps = (4 + rng() * 3) | 0;
      for (let k = 0; k < clumps; k++) {
        const ca = rng() * Math.PI * 2;
        const cr = rng() * height * 0.32;
        canopyClump(tipX + Math.cos(ca) * cr, h + height * (0.85 + rng() * 0.35), tipZ + Math.sin(ca) * cr,
                    height * (0.28 + rng() * 0.14), hueBase, (11 + rng() * 8) | 0, 0.7 + rng() * 0.3, false);
      }
      wakeLeafSources.push({ x: tipX, z: tipZ, y: h + height * 1.02, hue: hueBase });
      if (rng() < 0.6) leafSpots.push({ x, z, y: h + height, hue: hueBase });
    } else if (species < 0.72) {
      const height = 6 + rng() * 5;
      shadowPool(x, z, height * 0.32);
      trunkRun(x, z, h, height * 0.5, 0, 0, 0.05, 0.38, 0.18, false);
      const hueBase = 0.36 + rng() * 0.05;
      const tiers = (5 + rng() * 3) | 0;
      for (let k = 0; k < tiers; k++) {
        const t = k / tiers;
        canopyClump(x + (rng() - 0.5) * 0.2, h + height * (0.3 + t * 0.72), z + (rng() - 0.5) * 0.2,
                    (1 - t * 0.82) * (1.5 + rng() * 0.5), hueBase, (7 + (1 - t) * 7) | 0, 0.35 + t * 0.4, false);
      }
      c.setHSL(hueBase, 0.45, 0.46); c.lerp(SUN, 0.25);
      push(x, h + height * 1.04, z, c.clone(), 0.6, Math.PI / 2, 0.35, T_FOLIAGE, 0.9);
      wakeLeafSources.push({ x, z, y: h + height * 0.78, hue: hueBase });
    } else {
      const height = 5 + rng() * 3.5;
      shadowPool(x, z, height * 0.4);
      const leanA = rng() * Math.PI * 2, leanM = rng() * 0.8;
      const { tipX, tipZ } = trunkRun(x, z, h, height, leanA, leanM, 0.1, 0.06, 0.8, true);
      const hueBase = 0.2 + rng() * 0.05;
      const clumps = (3 + rng() * 2) | 0;
      for (let k = 0; k < clumps; k++) {
        const ca = rng() * Math.PI * 2;
        const cr = rng() * height * 0.26;
        canopyClump(tipX + Math.cos(ca) * cr, h + height * (0.9 + rng() * 0.3), tipZ + Math.sin(ca) * cr,
                    height * (0.22 + rng() * 0.1), hueBase, (8 + rng() * 6) | 0, 0.85 + rng() * 0.15, true);
      }
      wakeLeafSources.push({ x: tipX, z: tipZ, y: h + height * 1.04, hue: hueBase });
      if (rng() < 0.75) leafSpots.push({ x, z, y: h + height, hue: hueBase });
    }

    const under = (1 + rng() * 3) | 0;
    for (let u = 0; u < under && !full(); u++) {
      const a = rng() * Math.PI * 2;
      const rr = 1.5 + rng() * 3.5;
      const ux = x + Math.cos(a) * rr, uz = z + Math.sin(a) * rr;
      const uh = heightAt(ux, uz);
      if (rng() < 0.7) fern(ux, uz, uh);
      else {
        const sh = 1 + rng() * 1.2;
        c.setHSL(0.07, 0.38, 0.18);
        push(ux, uh + sh * 0.3, uz, c.clone(), 0.3, Math.PI / 2, 0.25, T_GROUND);
        canopyClump(ux, uh + sh, uz, 0.5 + rng() * 0.3, 0.28 + rng() * 0.06, 6, 0.9, false);
      }
    }
  }

  // a few loose ferns + falling leaves to soften the meadow
  for (let i = cnt(420); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    if (groveField(x, z) < 0.12) continue;
    const h = heightAt(x, z);
    if (h > 24 || slopeAt(x, z) > 0.5) continue;
    fern(x, z, h);
  }
  for (const spot of leafSpots) {
    const count = (3 + rng() * 4) | 0;
    for (let i = 0; i < count && !full(); i++) {
      c.setHSL(spot.hue + 0.04 - rng() * 0.2, 0.62, 0.48 + rng() * 0.15);
      push(spot.x + (rng() - 0.5) * 9, spot.y - rng() * spot.y * 0.5, spot.z + (rng() - 0.5) * 9,
           jitter(c, 0.02, 0.08, 0.06), 0.28 + rng() * 0.24, rng() * Math.PI, 0.45, T_LEAF, 0.5 + rng() * 0.5);
    }
  }

  // -------- 8) shrubs --------
  for (let i = cnt(92); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const h = heightAt(x, z);
    if (h > 26) continue;
    if (slopeAt(x, z) > 0.5 || pathMask(x, z) > 0.4) continue;
    const R = 0.7 + rng() * 1.0;
    shadowPool(x, z, R * 0.8);
    const hueBase = 0.25 + rng() * 0.1;
    canopyClump(x, h + R * 0.6, z, R, hueBase, (7 + R * 6) | 0, 0.5, false);
    wakeLeafSources.push({ x, z, y: h + R * 1.1, hue: hueBase });
  }

  // -------- 9) the occasional cottage --------
  if (rng() < 0.1 && !full()) {
    let bx = 0, bz = 0, found = false;
    for (let i = 0; i < 1200 && !found; i++) {
      const x = ox + rng() * TILE, z = oz + rng() * TILE;
      const m = pathMask(x, z);
      if (m > 0.15 && m < 0.45 && slopeAt(x, z) < 0.18) {
        const h = heightAt(x, z);
        if (h > 2 && h < 22) { bx = x; bz = z; found = true; }
      }
    }
    if (found) {
      const h = heightAt(bx, bz);
      const W = 3.2, D = 2.6, WH = 2.2;
      const faceLam = (nx, nz) => Math.max(0.2, nx * LIGHT.x + nz * LIGHT.z + 0.45);
      for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const lam = faceLam(nx, nz);
        for (let i = 0; i < 26 && !full(); i++) {
          const t = rng() * 2 - 1, y = rng() * WH;
          const px = bx + nx * W * 0.5 + (nz !== 0 ? t * W * 0.5 : 0);
          const pz = bz + nz * D * 0.5 + (nx !== 0 ? t * D * 0.5 : 0);
          c.setHSL(0.09, 0.3, 0.66);
          push(px, h + 0.3 + y, pz, paintLight(jitter(c, 0.01, 0.04, 0.05), lam),
               0.55 + rng() * 0.4, (rng() - 0.5) * 0.4, 0.45, T_GROUND);
        }
      }
      for (let sgn = -1; sgn <= 1; sgn += 2) {
        const lam = Math.max(0.25, sgn * 0.4 * LIGHT.x + 0.7 * LIGHT.y);
        for (let i = 0; i < 30 && !full(); i++) {
          const t = rng(), u = rng() * 2 - 1;
          c.setHSL(0.02, 0.48, 0.36);
          push(bx + sgn * (1 - t) * W * 0.32, h + WH + 0.2 + t * 1.5, bz + u * D * 0.55,
               paintLight(jitter(c, 0.012, 0.06, 0.05), lam),
               0.7 + rng() * 0.5, 0.15 * sgn + (rng() - 0.5) * 0.3, 0.4, T_GROUND);
        }
      }
      c.setRGB(1.0, 0.8, 0.35);
      push(bx + W * 0.51, h + 1.3, bz - D * 0.12, c.clone(), 0.45, 0, 0.7, T_GROUND);
      for (let i = 0; i < 14 && !full(); i++) {
        c.setHSL(0.08, 0.14, 0.85);
        push(bx - W * 0.2, h + WH + 2.4, bz + D * 0.2, c.clone(), 0.7 + rng() * 0.5,
             rng() * Math.PI, 0.55, T_SMOKE, 0.5 + rng() * 0.5);
      }
    }
  }

  // -------- 10) deer --------
  let deerCount = 0;
  for (let attempt = 0; attempt < cnt(60) && deerCount < 2 && !full(); attempt++) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const g = groveField(x, z);
    if (g < 0.0 || g > 0.12) continue;
    const h = heightAt(x, z);
    if (h < 1 || h > 20 || slopeAt(x, z) > 0.25) continue;
    deerCount++;
    const facing = rng() * Math.PI * 2;
    const fx = Math.cos(facing), fz = Math.sin(facing);
    const tan = new THREE.Color().setHSL(0.07, 0.42, 0.42 + rng() * 0.08);
    for (let i = 0; i < 5; i++) {
      const t = (i / 4 - 0.5) * 1.3;
      push(x + fx * t, h + 1.05 + Math.sin(t * 2) * 0.06, z + fz * t,
           paintLight(jitter(tan.clone(), 0.01, 0.05, 0.05), 0.75),
           0.62 - Math.abs(t) * 0.15, facing, 0.5, T_GROUND);
    }
    push(x + fx * 0.85, h + 0.95, z + fz * 0.85, paintLight(tan.clone(), 0.7), 0.4, facing + 0.9, 0.32, T_GROUND);
    push(x + fx * 1.15, h + 0.55, z + fz * 1.15, paintLight(tan.clone(), 0.65), 0.3, facing + 0.6, 0.45, T_GROUND);
    const dark = new THREE.Color().setHSL(0.07, 0.38, 0.24);
    for (const [lt, ls] of [[-0.5, -0.18], [-0.5, 0.18], [0.45, -0.18], [0.45, 0.18]]) {
      push(x + fx * lt - fz * ls, h + 0.5, z + fz * lt + fx * ls, dark.clone(), 0.55, Math.PI / 2, 0.1, T_GROUND);
    }
    c.setRGB(0.94, 0.92, 0.88);
    push(x - fx * 0.75, h + 1.15, z - fz * 0.75, c.clone(), 0.16, facing, 0.6, T_GROUND);
  }

  // -------- 11) butterflies + swallows --------
  for (let i = cnt(24); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const h = heightAt(x, z);
    if (h > 20 || groveField(x, z) > 0.15) continue;
    if (rng() < 0.5) c.setHSL(0.12, 0.85, 0.72);
    else c.setHSL(0.0, 0.0, 0.96);
    push(x, h + 1.2 + rng() * 1.6, z, jitter(c, 0.02, 0.05, 0.04),
         0.22 + rng() * 0.14, rng() * Math.PI, 0.55, T_FLY, 0.5 + rng() * 0.5);
  }
  for (let i = cnt(3); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    c.setHSL(0.64, 0.22, 0.28);
    push(x, heightAt(x, z) + 26 + rng() * 14, z, c.clone(), 0.5 + rng() * 0.25,
         rng() * Math.PI, 0.22, T_BIRD, 0.4 + rng() * 0.6);
  }

  return {
    pos: new Float32Array(pos), col: new Float32Array(col),
    size: new Float32Array(size), angle: new Float32Array(angle),
    aspect: new Float32Array(aspect), type: new Float32Array(type),
    phase: new Float32Array(phase), flex: new Float32Array(flex),
    count: n,
    leafSources: wakeLeafSources
  };
}

// ---------------- splat shaders ----------------
const splatVert = `
  attribute vec3 splatColor;
  attribute float splatSize;
  attribute float splatAngle;
  attribute float splatAspect;
  attribute float splatType;
  attribute float splatPhase;
  attribute float splatFlex;
  uniform float uScale;
  uniform float uTime;
  uniform float uWind;
  uniform vec2 uWindDir;
  uniform vec2 uBirdXZ;
  uniform vec2 uBirdDir;
  uniform float uBirdWake;
  uniform vec2 uCamXZ;
  uniform float uFadeIn;
  uniform float uFadeOut;
  varying vec3 vColor;
  varying float vType;
  varying float vAir;
  varying float vAngle;
  varying float vAspect;
  varying float vSeed;
  varying float vPuff;
  varying float vEdge;

  void main() {
    vColor = splatColor;
    vType = splatType;
    vAspect = splatAspect;
    vSeed = fract(position.x * 12.9898 + position.z * 78.233);
    vPuff = 1.0;
    // dissolve strokes into the air at the edge of the loaded world (any direction)
    vEdge = 1.0 - smoothstep(uFadeIn, uFadeOut, length(position.xz - uCamXZ));
    if (splatSize <= 0.0 || vEdge <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }

    vec3 p = position;
    float ang = splatAngle;
    float ph = splatPhase * 6.28318;
    float sizeMul = 1.0;

    float front = dot(p.xz, uWindDir);
    float gust = sin(front * 0.045 - uTime * 1.5) * 0.5 + 0.5;
    gust *= gust;
    float swell = 0.65 + 0.35 * sin(uTime * 0.37);
    float windAmp = uWind * swell * (0.3 + 0.9 * gust);
    vec2 birdDelta = vec2(0.0);
    float birdDist = 9999.0;
    vec2 birdAway = vec2(0.0);
    float birdWake = 0.0;
    if (uBirdWake > 0.001 && splatType > 0.5 && splatType < 4.5) {
      birdDelta = p.xz - uBirdXZ;
      birdDist = length(birdDelta);
      birdAway = birdDelta / max(birdDist, 0.001);
      float trailBack = -dot(birdDelta, uBirdDir);
      float trailSide = abs(dot(birdDelta, vec2(-uBirdDir.y, uBirdDir.x)));
      float radialWake = 1.0 - smoothstep(4.0, 18.0, birdDist);
      float trailWake = (1.0 - smoothstep(1.5, 11.0, trailSide))
                      * smoothstep(0.0, 18.0, trailBack)
                      * (1.0 - smoothstep(18.0, 38.0, trailBack));
      birdWake = clamp(uBirdWake * (radialWake + trailWake * 0.6), 0.0, 1.35);
    }

    if (splatType > 0.5 && splatType < 1.5) {
      vec2 lean = uWindDir * windAmp * splatFlex * 0.55;
      p.x += lean.x + sin(uTime * 3.1 + ph) * 0.1 * splatFlex * (0.4 + windAmp);
      p.z += lean.y + cos(uTime * 2.6 + ph * 1.3) * 0.08 * splatFlex * (0.4 + windAmp);
      p.y -= windAmp * splatFlex * 0.12;
      ang += sin(uTime * 2.2 + ph) * 0.2 * splatFlex * windAmp;
      float foliageWake = birdWake * splatFlex;
      float shake = sin(uTime * 13.0 + ph * 1.7 + birdDist * 0.32);
      p.xz += (birdAway * 2.1 + uBirdDir * 0.7) * foliageWake;
      p.y += shake * foliageWake * 0.25 - foliageWake * 0.12;
      ang += shake * foliageWake * 0.9;
    }
    else if (splatType > 2.5 && splatType < 3.5) {
      float bend = windAmp * splatFlex;
      p.x += uWindDir.x * bend * 0.5 + sin(uTime * 2.3 + ph + front * 0.2) * 0.05 * splatFlex;
      p.z += uWindDir.y * bend * 0.5;
      p.y -= bend * 0.1;
      ang += uWindDir.x * bend * 0.45;
      float grassWake = birdWake * splatFlex;
      p.xz += (birdAway * 0.8 + uBirdDir * 0.45) * grassWake * 1.25;
      p.y -= grassWake * 0.28;
      ang += (birdAway.x * 0.65 + sin(uTime * 10.5 + ph) * 0.35) * grassWake;
      sizeMul *= 1.0 + grassWake * 0.12;
    }
    else if (splatType > 3.5 && splatType < 4.5) {
      vec2 perp = vec2(-uWindDir.y, uWindDir.x);
      float t = uTime * (0.25 + splatPhase * 0.25);
      p.x += (uWindDir.x * sin(t + ph) * 5.0 + perp.x * cos(t * 1.4 + ph) * 2.5) * (0.4 + uWind * 0.5);
      p.z += (uWindDir.y * sin(t + ph) * 5.0 + perp.y * cos(t * 1.4 + ph) * 2.5) * (0.4 + uWind * 0.5);
      p.y += sin(uTime * 1.2 + ph * 1.7) * 1.1;
      ang += uTime * (1.5 + splatPhase * 2.0);
      float leafWake = birdWake * (0.55 + splatFlex);
      p.xz += (uBirdDir * 4.2 + birdAway * 2.2) * leafWake;
      p.y += (0.25 + sin(uTime * 8.5 + ph) * 0.65) * leafWake;
      ang += leafWake * (2.0 + sin(uTime * 6.0 + ph));
      sizeMul *= 1.0 + leafWake * 0.22;
    }
    else if (splatType > 4.5 && splatType < 5.5) {
      float t = uTime * (0.6 + splatPhase * 0.5);
      p.x += sin(t + ph) * 2.2 + sin(t * 3.7 + ph) * 0.5;
      p.z += cos(t * 0.8 + ph * 2.0) * 2.2;
      p.y += abs(sin(t * 5.0 + ph)) * 0.5 + sin(t * 0.9) * 0.4;
      ang += sin(uTime * 14.0 + ph) * 0.9;
    }
    else if (splatType > 5.5 && splatType < 6.5) {
      float t = uTime * (0.18 + splatPhase * 0.12);
      float R = 6.0 + splatFlex * 14.0;
      p.x += cos(t + ph) * R;
      p.z += sin(t + ph) * R;
      p.y += sin(t * 2.3 + ph) * 1.6;
      ang = t + ph + 1.57;
    }
    else if (splatType > 6.5) {
      float t = fract(uTime * 0.07 * (0.6 + splatPhase * 0.8) + splatPhase);
      p.y += t * 10.0;
      p.x += uWindDir.x * t * t * 7.0 * (0.5 + uWind * 0.5) + sin(uTime + ph) * 0.3 * t;
      p.z += uWindDir.y * t * t * 7.0 * (0.5 + uWind * 0.5);
      sizeMul = 0.5 + t * 2.6;
      vPuff = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.55, 1.0, t));
    }

    vAngle = ang;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = -mv.z;
    gl_PointSize = clamp(splatSize * sizeMul * uScale / dist, 1.0, 350.0);
    vAir = smoothstep(25.0, 100.0, dist);          // aerial perspective, tuned to the loaded radius
    gl_Position = projectionMatrix * mv;
  }
`;

const splatFrag = `
  precision highp float;
  varying vec3 vColor;
  varying float vType;
  varying float vAir;
  varying float vAngle;
  varying float vAspect;
  varying float vSeed;
  varying float vPuff;
  varying float vEdge;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    uv.y = -uv.y;
    float ca = cos(vAngle), sa = sin(vAngle);
    vec2 r = vec2(ca * uv.x + sa * uv.y, -sa * uv.x + ca * uv.y);
    r.y /= max(vAspect, 0.08);
    float d = dot(r, r);

    float bristle = hash(vec2(floor(r.y * 6.0), floor(vSeed * 91.0)));
    d *= 1.0 + (bristle - 0.5) * 0.2;
    if (d > 1.0) discard;

    float alpha;
    if (vType > 6.5) {
      alpha = exp(-d * 2.8) * 0.3 * vPuff;
    } else {
      alpha = smoothstep(1.0, 0.5, d) * 0.94;
    }

    vec3 color = vColor;
    float lum = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(color, vec3(lum), vAir * 0.35);
    color = mix(color, vec3(0.72, 0.75, 0.89), vAir * 0.72);
    alpha *= (1.0 - vAir * 0.25);
    alpha *= vEdge;                                 // fade out at the world's loaded edge

    gl_FragColor = vec4(color, alpha);
  }
`;

const skyVert = `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const skyFrag = `
  precision highp float;
  varying vec3 vDir;
  uniform vec3 uSunDir;
  void main() {
    float t = smoothstep(-0.12, 0.55, vDir.y);
    vec3 zenith = vec3(0.55, 0.67, 0.86);
    vec3 horizon = vec3(0.93, 0.87, 0.8);
    vec3 col = mix(horizon, zenith, t);
    float sun = pow(max(dot(vDir, uSunDir), 0.0), 5.0);
    col += vec3(1.0, 0.8, 0.5) * sun * 0.4;
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ---------------- single post pass: cohesion + glow + canvas + grade ----------------
const quadVert = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const paintFrag = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform vec2 uPx;
  uniform float uImpasto;
  uniform float uGlow;

  float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    vec3 raw = texture2D(tDiffuse, vUv).rgb;

    vec3 bestMean = raw;
    float bestVar = 1e9;
    for (int q = 0; q < 4; q++) {
      vec2 s = vec2(q == 0 || q == 3 ? 1.0 : -1.0, q < 2 ? 1.0 : -1.0);
      vec3 mean = vec3(0.0);
      float m2 = 0.0;
      for (int i = 0; i <= 1; i++) {
        for (int j = 0; j <= 1; j++) {
          vec3 cc = texture2D(tDiffuse, vUv + vec2(float(i), float(j)) * s * uPx * 1.4).rgb;
          mean += cc;
          float l = lum(cc);
          m2 += l * l;
        }
      }
      mean *= 0.25;
      float ml = lum(mean);
      float v = m2 * 0.25 - ml * ml;
      if (v < bestVar) { bestVar = v; bestMean = mean; }
    }
    vec3 col = mix(raw, bestMean, 0.45);

    vec3 g1 = texture2D(tDiffuse, vUv + vec2( 5.0,  3.0) * uPx).rgb;
    vec3 g2 = texture2D(tDiffuse, vUv + vec2(-5.0,  3.0) * uPx).rgb;
    vec3 g3 = texture2D(tDiffuse, vUv + vec2( 3.0, -5.0) * uPx).rgb;
    vec3 g4 = texture2D(tDiffuse, vUv + vec2(-3.0, -5.0) * uPx).rgb;
    vec3 glow = (g1 + g2 + g3 + g4) * 0.25;
    col += glow * glow * 0.22 * uGlow;

    float lx1 = lum(texture2D(tDiffuse, vUv + vec2(uPx.x, 0.0) * 1.5).rgb);
    float lx0 = lum(texture2D(tDiffuse, vUv - vec2(uPx.x, 0.0) * 1.5).rgb);
    float ly1 = lum(texture2D(tDiffuse, vUv + vec2(0.0, uPx.y) * 1.5).rgb);
    float ly0 = lum(texture2D(tDiffuse, vUv - vec2(0.0, uPx.y) * 1.5).rgb);
    vec2 grad = vec2(lx1 - lx0, ly1 - ly0);
    vec2 fc = vUv / uPx;
    vec2 canvasGrad = vec2(cos(fc.x * 1.55), cos(fc.y * 1.55)) * 0.01;
    float k = uImpasto;
    vec3 nrm = normalize(vec3(-(grad * 2.6 * k + canvasGrad * k), 1.0));
    vec3 L = normalize(vec3(-0.45, 0.55, 0.78));
    float diff = max(dot(nrm, L), 0.0);
    col *= 0.86 + 0.24 * diff;
    float spec = pow(max(dot(reflect(-L, nrm), vec3(0.0, 0.0, 1.0)), 0.0), 30.0);
    col += vec3(1.0, 0.97, 0.9) * spec * lum(col) * 0.2 * k;

    col = col * 0.93 + 0.055;
    float l1 = lum(col);
    col = mix(vec3(l1), col, 1.14);
    col += vec3(0.05, 0.025, -0.015) * l1;
    col += vec3(-0.01, 0.0, 0.035) * (1.0 - l1);
    vec2 vg = vUv - 0.5;
    col *= 1.0 - dot(vg, vg) * 0.28;

    gl_FragColor = vec4(col, 1.0);
  }
`;

// ---------------- renderer / pipeline ----------------
const renderer = new THREE.WebGLRenderer({
  antialias: false,
  alpha: false,
  stencil: false,
  powerPreference: 'high-performance'
});
const DPR = Math.min(devicePixelRatio, 1.0);
renderer.setPixelRatio(DPR);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 1400);

const skyMat = new THREE.ShaderMaterial({
  vertexShader: skyVert, fragmentShader: skyFrag,
  uniforms: { uSunDir: { value: LIGHT.clone() } },
  side: THREE.BackSide, depthWrite: false
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(700, 24, 16), skyMat);
sky.frustumCulled = false;
scene.add(sky);

const windAngle = Math.PI * 0.22;
const uniforms = {
  uScale: { value: 1 },
  uTime: { value: 0 },
  uWind: { value: 1 },
  uWindDir: { value: new THREE.Vector2(Math.cos(windAngle), Math.sin(windAngle)) },
  uBirdXZ: { value: new THREE.Vector2(0, 0) },
  uBirdDir: { value: new THREE.Vector2(0, 1) },
  uBirdWake: { value: 0 },
  uCamXZ: { value: new THREE.Vector2(0, 0) },
  uFadeIn: { value: FADE_IN },
  uFadeOut: { value: FADE_OUT }
};
const splatMat = new THREE.ShaderMaterial({
  uniforms, vertexShader: splatVert, fragmentShader: splatFrag,
  transparent: true, depthWrite: false, depthTest: true
});

let rtScene;
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const paintMat = new THREE.ShaderMaterial({
  vertexShader: quadVert, fragmentShader: paintFrag,
  uniforms: {
    tDiffuse: { value: null },
    uPx: { value: new THREE.Vector2() },
    uImpasto: { value: 0 },
    uGlow: { value: 0 }
  },
  depthTest: false, depthWrite: false
});
const paintScene = new THREE.Scene();
paintScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), paintMat));

function makeTargets() {
  const w = (innerWidth * DPR) | 0, h = (innerHeight * DPR) | 0;
  if (rtScene) rtScene.dispose();
  rtScene = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat
  });
  paintMat.uniforms.uPx.value.set(1 / w, 1 / h);
}

// ---------------- one big GPU buffer, filled from the active tiles ----------------
const M = {
  pos: new Float32Array(CAP * 3), col: new Float32Array(CAP * 3),
  size: new Float32Array(CAP), angle: new Float32Array(CAP),
  aspect: new Float32Array(CAP), type: new Float32Array(CAP),
  phase: new Float32Array(CAP), flex: new Float32Array(CAP)
};
const rPos = new Float32Array(CAP * 3), rCol = new Float32Array(CAP * 3);
const rSize = new Float32Array(CAP), rAngle = new Float32Array(CAP);
const rAspect = new Float32Array(CAP), rType = new Float32Array(CAP);
const rPhase = new Float32Array(CAP), rFlex = new Float32Array(CAP);
const order = new Uint32Array(CAP), sourceOrder = new Uint32Array(CAP), keys = new Float32Array(CAP);

const geometry = new THREE.BufferGeometry();
const dyn = (arr, n) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
geometry.setAttribute('position', dyn(rPos, 3));
geometry.setAttribute('splatColor', dyn(rCol, 3));
geometry.setAttribute('splatSize', dyn(rSize, 1));
geometry.setAttribute('splatAngle', dyn(rAngle, 1));
geometry.setAttribute('splatAspect', dyn(rAspect, 1));
geometry.setAttribute('splatType', dyn(rType, 1));
geometry.setAttribute('splatPhase', dyn(rPhase, 1));
geometry.setAttribute('splatFlex', dyn(rFlex, 1));
const points = new THREE.Points(geometry, splatMat);
points.frustumCulled = false;
points.renderOrder = 1;
geometry.setDrawRange(0, 0);
scene.add(points);

let count = 0;
const perfStats = {
  strokes: 0,
  visible: 0,
  tiles: 0,
  queued: 0,
  avgFrameMs: 16.7,
  lastTileMs: 0,
  lastRebuildMs: 0,
  lastSortMs: 0,
  sortInterval: 0
};
window.__allogamyStats = perfStats;

// ---------------- heron wake: light leaf pool shed from nearby foliage ----------------
const WAKE_LEAF_COUNT = 120;
const wakeLeafPos = new Float32Array(WAKE_LEAF_COUNT * 3);
const wakeLeafCol = new Float32Array(WAKE_LEAF_COUNT * 3);
const wakeLeafSize = new Float32Array(WAKE_LEAF_COUNT);
const wakeLeafAngle = new Float32Array(WAKE_LEAF_COUNT);
const wakeLeafAspect = new Float32Array(WAKE_LEAF_COUNT);
const wakeLeafType = new Float32Array(WAKE_LEAF_COUNT);
const wakeLeafPhase = new Float32Array(WAKE_LEAF_COUNT);
const wakeLeafFlex = new Float32Array(WAKE_LEAF_COUNT);
const wakeLeafState = [];
const wakeLeafRnd = mulberry32(0x7eaf1eaf);
const wakeLeafColor = new THREE.Color();
const activeLeafSources = [];
let wakeLeafCursor = 0;
let wakeLeafProbeCursor = 0;
let wakeLeafProbeTimer = 0;
let landscapeWake = 0;

for (let i = 0; i < WAKE_LEAF_COUNT; i++) {
  wakeLeafState.push({
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    age: 0, life: 0, maxLife: 1,
    baseSize: 0.3, spin: 0
  });
  wakeLeafType[i] = T_LEAF;
  wakeLeafPhase[i] = wakeLeafRnd();
  wakeLeafAspect[i] = 0.38 + wakeLeafRnd() * 0.22;
  wakeLeafFlex[i] = 0.45 + wakeLeafRnd() * 0.55;
}

const wakeLeafGeo = new THREE.BufferGeometry();
wakeLeafGeo.setAttribute('position', dyn(wakeLeafPos, 3));
wakeLeafGeo.setAttribute('splatColor', dyn(wakeLeafCol, 3));
wakeLeafGeo.setAttribute('splatSize', dyn(wakeLeafSize, 1));
wakeLeafGeo.setAttribute('splatAngle', dyn(wakeLeafAngle, 1));
wakeLeafGeo.setAttribute('splatAspect', dyn(wakeLeafAspect, 1));
wakeLeafGeo.setAttribute('splatType', dyn(wakeLeafType, 1));
wakeLeafGeo.setAttribute('splatPhase', dyn(wakeLeafPhase, 1));
wakeLeafGeo.setAttribute('splatFlex', dyn(wakeLeafFlex, 1));
wakeLeafGeo.setDrawRange(0, WAKE_LEAF_COUNT);
const wakeLeafPoints = new THREE.Points(wakeLeafGeo, splatMat);
wakeLeafPoints.frustumCulled = false;
wakeLeafPoints.renderOrder = 3;
scene.add(wakeLeafPoints);

const WAKE_POLLEN_COUNT = 120;
const wakePollenPos = new Float32Array(WAKE_POLLEN_COUNT * 3);
const wakePollenCol = new Float32Array(WAKE_POLLEN_COUNT * 3);
const wakePollenSize = new Float32Array(WAKE_POLLEN_COUNT);
const wakePollenAngle = new Float32Array(WAKE_POLLEN_COUNT);
const wakePollenAspect = new Float32Array(WAKE_POLLEN_COUNT);
const wakePollenType = new Float32Array(WAKE_POLLEN_COUNT);
const wakePollenPhase = new Float32Array(WAKE_POLLEN_COUNT);
const wakePollenFlex = new Float32Array(WAKE_POLLEN_COUNT);
const wakePollenState = [];
const wakePollenRnd = mulberry32(0x90f10a11);
const wakePollenColor = new THREE.Color();
let wakePollenCursor = 0;

for (let i = 0; i < WAKE_POLLEN_COUNT; i++) {
  wakePollenState.push({
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    age: 0, life: 0, maxLife: 1,
    baseSize: 0.15, spin: 0
  });
  wakePollenType[i] = T_FLY;
  wakePollenPhase[i] = wakePollenRnd();
  wakePollenAspect[i] = 0.62 + wakePollenRnd() * 0.32;
  wakePollenFlex[i] = 0.15 + wakePollenRnd() * 0.35;
}

const wakePollenGeo = new THREE.BufferGeometry();
wakePollenGeo.setAttribute('position', dyn(wakePollenPos, 3));
wakePollenGeo.setAttribute('splatColor', dyn(wakePollenCol, 3));
wakePollenGeo.setAttribute('splatSize', dyn(wakePollenSize, 1));
wakePollenGeo.setAttribute('splatAngle', dyn(wakePollenAngle, 1));
wakePollenGeo.setAttribute('splatAspect', dyn(wakePollenAspect, 1));
wakePollenGeo.setAttribute('splatType', dyn(wakePollenType, 1));
wakePollenGeo.setAttribute('splatPhase', dyn(wakePollenPhase, 1));
wakePollenGeo.setAttribute('splatFlex', dyn(wakePollenFlex, 1));
wakePollenGeo.setDrawRange(0, WAKE_POLLEN_COUNT);
const wakePollenPoints = new THREE.Points(wakePollenGeo, splatMat);
wakePollenPoints.frustumCulled = false;
wakePollenPoints.renderOrder = 4;
scene.add(wakePollenPoints);

function spawnWakeLeaf(source, power) {
  const i = wakeLeafCursor++ % WAKE_LEAF_COUNT;
  const s = wakeLeafState[i];
  const side = wakeLeafRnd() < 0.5 ? -1 : 1;
  const lateralX = -flight.flatForward.z;
  const lateralZ = flight.flatForward.x;
  const gust = 0.75 + power * 1.35;

  s.x = source.x + (wakeLeafRnd() - 0.5) * 1.5;
  s.y = source.y + (wakeLeafRnd() - 0.5) * 1.0;
  s.z = source.z + (wakeLeafRnd() - 0.5) * 1.5;
  s.vx = flight.flatForward.x * (2.2 + wakeLeafRnd() * 2.2) * gust
    + lateralX * side * (0.9 + wakeLeafRnd() * 1.8) * gust
    + uniforms.uWindDir.value.x * (0.7 + wakeLeafRnd() * 1.2);
  s.vy = 0.4 + wakeLeafRnd() * 1.2 + power * 0.8;
  s.vz = flight.flatForward.z * (2.2 + wakeLeafRnd() * 2.2) * gust
    + lateralZ * side * (0.9 + wakeLeafRnd() * 1.8) * gust
    + uniforms.uWindDir.value.y * (0.7 + wakeLeafRnd() * 1.2);
  s.age = 0;
  s.maxLife = 1.7 + wakeLeafRnd() * 1.4 + power * 0.8;
  s.life = s.maxLife;
  s.baseSize = 0.24 + wakeLeafRnd() * 0.28;
  s.spin = (wakeLeafRnd() < 0.5 ? -1 : 1) * (2.8 + wakeLeafRnd() * 5.5);

  const hue = source.hue + (wakeLeafRnd() - 0.5) * 0.08;
  wakeLeafColor.setHSL((hue + 1) % 1, 0.46 + wakeLeafRnd() * 0.22, 0.34 + wakeLeafRnd() * 0.22);
  if (wakeLeafRnd() < 0.32) wakeLeafColor.lerp(new THREE.Color(0.78, 0.52, 0.18), 0.35 + wakeLeafRnd() * 0.35);
  const k = i * 3;
  wakeLeafCol[k] = wakeLeafColor.r;
  wakeLeafCol[k + 1] = wakeLeafColor.g;
  wakeLeafCol[k + 2] = wakeLeafColor.b;
  wakeLeafAngle[i] = wakeLeafRnd() * Math.PI;
  wakeLeafAspect[i] = 0.32 + wakeLeafRnd() * 0.26;
  wakeLeafPhase[i] = wakeLeafRnd();
  wakeLeafFlex[i] = 0.55 + wakeLeafRnd() * 0.45;
}

function spawnWakePollen(source, power) {
  const i = wakePollenCursor++ % WAKE_POLLEN_COUNT;
  const s = wakePollenState[i];
  const side = wakePollenRnd() < 0.5 ? -1 : 1;
  const lateralX = -flight.flatForward.z;
  const lateralZ = flight.flatForward.x;
  const lift = 0.35 + power * 1.15;

  s.x = source.x + (wakePollenRnd() - 0.5) * 2.1;
  s.y = source.y + (wakePollenRnd() - 0.5) * 1.35;
  s.z = source.z + (wakePollenRnd() - 0.5) * 2.1;
  s.vx = flight.flatForward.x * (1.3 + wakePollenRnd() * 2.1) * power
    + lateralX * side * (0.9 + wakePollenRnd() * 1.8)
    + uniforms.uWindDir.value.x * (1.4 + wakePollenRnd() * 1.9);
  s.vy = lift + wakePollenRnd() * 0.75;
  s.vz = flight.flatForward.z * (1.3 + wakePollenRnd() * 2.1) * power
    + lateralZ * side * (0.9 + wakePollenRnd() * 1.8)
    + uniforms.uWindDir.value.y * (1.4 + wakePollenRnd() * 1.9);
  s.age = 0;
  s.maxLife = 1.05 + wakePollenRnd() * 1.1 + power * 0.55;
  s.life = s.maxLife;
  s.baseSize = 0.1 + wakePollenRnd() * 0.17 + power * 0.04;
  s.spin = (wakePollenRnd() < 0.5 ? -1 : 1) * (4.5 + wakePollenRnd() * 7.0);

  const mood = wakePollenRnd();
  if (mood < 0.58) wakePollenColor.setHSL(0.13 + wakePollenRnd() * 0.03, 0.88, 0.64 + wakePollenRnd() * 0.14);
  else if (mood < 0.84) wakePollenColor.setHSL(0.06 + wakePollenRnd() * 0.035, 0.84, 0.55 + wakePollenRnd() * 0.12);
  else wakePollenColor.setHSL(0.985 + wakePollenRnd() * 0.025, 0.72, 0.5 + wakePollenRnd() * 0.12);
  wakePollenColor.lerp(new THREE.Color(0.9, 0.86, 0.58), 0.16);

  const k = i * 3;
  wakePollenCol[k] = wakePollenColor.r;
  wakePollenCol[k + 1] = wakePollenColor.g;
  wakePollenCol[k + 2] = wakePollenColor.b;
  wakePollenAngle[i] = wakePollenRnd() * Math.PI;
  wakePollenAspect[i] = 0.62 + wakePollenRnd() * 0.32;
  wakePollenPhase[i] = wakePollenRnd();
  wakePollenFlex[i] = 0.12 + wakePollenRnd() * 0.38;
}

function updateWakeLeaves(dt, wakePower) {
  const wind = uniforms.uWindDir.value;
  let active = false;
  let changed = false;
  for (let i = 0; i < WAKE_LEAF_COUNT; i++) {
    const s = wakeLeafState[i];
    const k = i * 3;
    if (s.life <= 0) {
      if (wakeLeafSize[i] !== 0) changed = true;
      wakeLeafSize[i] = 0;
      continue;
    }

    s.age += dt;
    s.life -= dt;
    s.vx += (wind.x * 0.75 + flight.flatForward.x * wakePower * 0.55) * dt;
    s.vz += (wind.y * 0.75 + flight.flatForward.z * wakePower * 0.55) * dt;
    s.vy -= (0.58 + s.age * 0.12) * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.z += s.vz * dt;

    const ground = heightAt(s.x, s.z) + 0.35;
    if (s.y < ground) {
      s.y = ground;
      s.vx *= 0.82;
      s.vz *= 0.82;
      s.vy = Math.max(0, -s.vy * 0.12);
      s.life = Math.min(s.life, 0.42);
    }

    const inFade = THREE.MathUtils.smoothstep(s.age, 0, 0.18);
    const outFade = THREE.MathUtils.smoothstep(s.life, 0, 0.42);
    wakeLeafPos[k] = s.x;
    wakeLeafPos[k + 1] = s.y;
    wakeLeafPos[k + 2] = s.z;
    wakeLeafSize[i] = s.life > 0 ? s.baseSize * inFade * outFade : 0;
    wakeLeafAngle[i] += s.spin * dt;
    changed = true;
    active = active || s.life > 0;
  }

  if (!changed && !active && wakePower <= 0.001) return;
  for (const name of ['position', 'splatColor', 'splatSize', 'splatAngle', 'splatAspect', 'splatType', 'splatPhase', 'splatFlex']) {
    const a = wakeLeafGeo.attributes[name];
    a.clearUpdateRanges();
    a.addUpdateRange(0, WAKE_LEAF_COUNT * a.itemSize);
    a.needsUpdate = true;
  }
}

function updateWakePollen(dt, wakePower) {
  const wind = uniforms.uWindDir.value;
  let active = false;
  let changed = false;
  for (let i = 0; i < WAKE_POLLEN_COUNT; i++) {
    const s = wakePollenState[i];
    const k = i * 3;
    if (s.life <= 0) {
      if (wakePollenSize[i] !== 0) changed = true;
      wakePollenSize[i] = 0;
      continue;
    }

    s.age += dt;
    s.life -= dt;
    const flutter = Math.sin(s.age * 9.0 + wakePollenPhase[i] * 6.28318);
    s.vx += (wind.x * 0.45 + flight.flatForward.x * wakePower * 0.28) * dt;
    s.vz += (wind.y * 0.45 + flight.flatForward.z * wakePower * 0.28) * dt;
    s.vy -= (0.2 + s.age * 0.08) * dt;
    s.x += (s.vx + flutter * 0.34) * dt;
    s.y += s.vy * dt;
    s.z += (s.vz + Math.cos(s.age * 7.0 + wakePollenPhase[i] * 5.0) * 0.28) * dt;

    const ground = heightAt(s.x, s.z) + 0.45;
    if (s.y < ground) {
      s.y = ground;
      s.life = Math.min(s.life, 0.24);
      s.vx *= 0.65;
      s.vz *= 0.65;
      s.vy = 0.05;
    }

    const inFade = THREE.MathUtils.smoothstep(s.age, 0, 0.12);
    const outFade = THREE.MathUtils.smoothstep(s.life, 0, 0.36);
    wakePollenPos[k] = s.x;
    wakePollenPos[k + 1] = s.y;
    wakePollenPos[k + 2] = s.z;
    wakePollenSize[i] = s.life > 0 ? s.baseSize * inFade * outFade : 0;
    wakePollenAngle[i] += s.spin * dt;
    changed = true;
    active = active || s.life > 0;
  }

  if (!changed && !active && wakePower <= 0.001) return;
  for (const name of ['position', 'splatColor', 'splatSize', 'splatAngle', 'splatAspect', 'splatType', 'splatPhase', 'splatFlex']) {
    const a = wakePollenGeo.attributes[name];
    a.clearUpdateRanges();
    a.addUpdateRange(0, WAKE_POLLEN_COUNT * a.itemSize);
    a.needsUpdate = true;
  }
}

function updateLandscapeWake(dt) {
  const ground = heightAt(flight.x, flight.z);
  const clearance = flight.y - ground;
  const lowPass = 1 - THREE.MathUtils.smoothstep(clearance, 22, 58);
  const bankPush = 0.72 + Math.min(1, Math.abs(flight.roll) / MAX_ROLL) * 0.28;
  const targetWake = THREE.MathUtils.clamp(lowPass * bankPush, 0, 1);
  landscapeWake += (targetWake - landscapeWake) * (1 - Math.exp(-dt * 5.5));

  uniforms.uBirdXZ.value.set(flight.x, flight.z);
  uniforms.uBirdDir.value.set(flight.flatForward.x, flight.flatForward.z).normalize();
  uniforms.uBirdWake.value = landscapeWake;

  wakeLeafProbeTimer -= dt;
  if (!reducedMotion && landscapeWake > 0.18 && wakeLeafProbeTimer <= 0 && activeLeafSources.length) {
    wakeLeafProbeTimer = 0.07 + wakeLeafRnd() * 0.08;
    const radius = 15 + landscapeWake * 9;
    const radiusSq = radius * radius;
    const len = activeLeafSources.length;
    const start = wakeLeafProbeCursor % len;
    wakeLeafProbeCursor = (wakeLeafProbeCursor + 17) % len;
    let spawned = 0;
    for (let step = 0; step < len && spawned < 4; step++) {
      const source = activeLeafSources[(start + step * 13) % len];
      const dx = source.x - flight.x;
      const dz = source.z - flight.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > radiusSq) continue;
      const dy = Math.abs(source.y - flight.y);
      if (dy > 34) continue;
      const near = (1 - THREE.MathUtils.smoothstep(Math.sqrt(d2), 4, radius))
        * (1 - THREE.MathUtils.smoothstep(dy, 7, 34));
      if (near > 0.12 && wakeLeafRnd() < near * 0.95) {
        spawnWakeLeaf(source, near * landscapeWake);
        spawned++;
      }
      const pollenChance = near * (0.65 + landscapeWake * 0.55);
      if (near > 0.08 && wakePollenRnd() < pollenChance) {
        const flecks = wakePollenRnd() < 0.35 ? 2 : 1;
        for (let j = 0; j < flecks; j++) spawnWakePollen(source, near * landscapeWake);
      }
    }
  }

  updateWakeLeaves(dt, landscapeWake);
  updateWakePollen(dt, landscapeWake);
}



// ---------------- player bird: heron painted with the same splat brush ----------------
const PLAYER_BIRD_COUNT = 1970;
const PLAYER_BIRD_SCALE = 1.14;
const PLAYER_BIRD_SIZE_SCALE = 1.3;
const BIRD_PART_BODY = 0;
const BIRD_PART_NECK = 1;
const BIRD_PART_HEAD = 2;
const BIRD_PART_LEG = 3;
const BIRD_PART_TAIL = 4;
const birdPos = new Float32Array(PLAYER_BIRD_COUNT * 3);
const birdCol = new Float32Array(PLAYER_BIRD_COUNT * 3);
const birdSize = new Float32Array(PLAYER_BIRD_COUNT);
const birdAngle = new Float32Array(PLAYER_BIRD_COUNT);
const birdAspect = new Float32Array(PLAYER_BIRD_COUNT);
const birdType = new Float32Array(PLAYER_BIRD_COUNT);
const birdPhase = new Float32Array(PLAYER_BIRD_COUNT);
const birdFlex = new Float32Array(PLAYER_BIRD_COUNT);
const birdLocal = [];
const birdRnd = mulberry32(0x51a7c0de);
const birdColor = new THREE.Color();

function addBirdDab(x, y, z, color, size, angle, aspect, wingSide = 0, phase = 0, flex = 0, part = BIRD_PART_BODY) {
  birdLocal.push({ x, y, z, color: color.clone(), size, angle, aspect, wingSide, phase, flex, part });
}
function birdJitter(c, h = 0.015, s = 0.035, l = 0.045) {
  const hsl = {}; c.getHSL(hsl);
  c.setHSL(
    (hsl.h + (birdRnd() - 0.5) * 2 * h + 1) % 1,
    THREE.MathUtils.clamp(hsl.s + (birdRnd() - 0.5) * 2 * s, 0, 1),
    THREE.MathUtils.clamp(hsl.l + (birdRnd() - 0.5) * 2 * l, 0.04, 0.98)
  );
  return c;
}
function buildPlayerBird() {
  const slate = new THREE.Color(0.48, 0.58, 0.64);
  const slateDark = new THREE.Color(0.22, 0.32, 0.4);
  const slateLight = new THREE.Color(0.75, 0.8, 0.78);
  const warmGrey = new THREE.Color(0.7, 0.66, 0.56);
  const cream = new THREE.Color(0.88, 0.84, 0.68);
  const faceWhite = new THREE.Color(0.84, 0.82, 0.74);
  const ink = new THREE.Color(0.08, 0.1, 0.12);
  const inkBlue = new THREE.Color(0.14, 0.2, 0.25);
  const bill = new THREE.Color(0.9, 0.58, 0.2);
  const billDark = new THREE.Color(0.48, 0.29, 0.12);
  const leg = new THREE.Color(0.48, 0.34, 0.18);
  const legDark = new THREE.Color(0.24, 0.16, 0.1);

  // Slim blue heron body: tapered chest, darker back, pale belly.
  for (let i = 0; i < 260; i++) {
    const a = birdRnd() * Math.PI * 2;
    const r = Math.sqrt(birdRnd());
    const z = -0.72 + birdRnd() * 1.18;
    const taper = 0.78 - Math.abs((z + 0.12) / 1.2) * 0.28;
    const x = Math.cos(a) * r * 0.34 * taper;
    const y = Math.sin(a) * r * 0.22 * taper + Math.sin((z + 0.48) * 2.2) * 0.035;
    birdColor.copy(slate)
      .lerp(slateLight, Math.max(0, y) * 0.22 + birdRnd() * 0.12)
      .lerp(slateDark, Math.max(0, -y) * 0.28 + Math.max(0, -z - 0.25) * 0.08);
    addBirdDab(x, y, z, birdJitter(birdColor, 0.025, 0.06, 0.055),
      0.13 + birdRnd() * 0.13, birdRnd() * Math.PI, 0.36 + birdRnd() * 0.26, 0, birdRnd(), 0);
  }
  for (let i = 0; i < 170; i++) {
    const a = birdRnd() * Math.PI * 2;
    const r = Math.sqrt(birdRnd()) * 0.78;
    const z = -0.66 + birdRnd() * 1.06;
    const taper = 0.86 - Math.abs((z + 0.1) / 1.16) * 0.24;
    const x = Math.cos(a) * r * 0.32 * taper;
    const y = Math.sin(a) * r * 0.19 * taper + Math.sin((z + 0.5) * 2.1) * 0.028;
    birdColor.copy(slate).lerp(slateLight, Math.max(0, y) * 0.18).lerp(slateDark, Math.max(0, -y) * 0.18);
    addBirdDab(x, y, z, birdJitter(birdColor, 0.018, 0.045, 0.045),
      0.19 + birdRnd() * 0.13, birdRnd() * Math.PI, 0.48 + birdRnd() * 0.22, 0, birdRnd(), 0);
  }
  // Tapered tail fan: root coverts overlap the body so the feathers read as attached.
  for (let i = 0; i < 64; i++) {
    const t = birdRnd();
    const x = (birdRnd() - 0.5) * (0.34 - t * 0.1);
    const y = -0.035 - t * 0.05 + (birdRnd() - 0.5) * 0.085;
    const z = -0.52 - t * 0.42;
    birdColor.copy(slate).lerp(slateDark, 0.25 + t * 0.42).lerp(slateLight, (1 - t) * 0.08);
    addBirdDab(x, y, z, birdJitter(birdColor, 0.018, 0.05, 0.05),
      0.15 + birdRnd() * 0.12, (birdRnd() - 0.5) * 0.28, 0.38 + birdRnd() * 0.18,
      0, birdRnd(), 0, BIRD_PART_TAIL);
  }
  for (let i = 0; i < 70; i++) {
    const t = Math.pow(birdRnd(), 0.78);
    const fan = birdRnd() * 2 - 1;
    const spread = Math.abs(fan);
    const x = fan * (0.04 + t * 0.24 + birdRnd() * 0.04);
    const y = -0.065 - t * 0.05 + (birdRnd() - 0.5) * (0.085 - t * 0.025);
    const z = -0.66 - t * 0.72 + spread * t * 0.06;
    birdColor.copy(slateDark).lerp(slate, 0.28 + (1 - t) * 0.34).lerp(inkBlue, t * 0.22);
    addBirdDab(x, y, z, birdJitter(birdColor, 0.018, 0.05, 0.05),
      0.1 + (1 - t) * 0.11 + birdRnd() * 0.06,
      fan * (0.18 + t * 0.28) + (birdRnd() - 0.5) * 0.22,
      0.18 + (1 - t) * 0.18 + birdRnd() * 0.12,
      0, birdRnd(), 0, BIRD_PART_TAIL);
  }

  // Folded heron neck: pale throat with a slate shoulder and an S-like curve.
  for (let i = 0; i < 170; i++) {
    const t = birdRnd();
    const curve = Math.sin(t * Math.PI);
    const z = 0.24 + t * 1.18;
    const y = 0.03 + curve * 0.18 - t * 0.035;
    const x = (birdRnd() - 0.5) * (0.16 - t * 0.06) + Math.sin(t * Math.PI * 1.45) * 0.035;
    birdColor.copy(faceWhite)
      .lerp(warmGrey, 0.18 + t * 0.25)
      .lerp(slate, (1 - t) * 0.22);
    addBirdDab(x, y + (birdRnd() - 0.5) * 0.055, z, birdJitter(birdColor, 0.018, 0.055, 0.055),
      0.07 + birdRnd() * 0.07, Math.PI / 2 + (birdRnd() - 0.5) * 0.4, 0.18 + birdRnd() * 0.14, 0, birdRnd(), 0, BIRD_PART_NECK);
  }
  for (let i = 0; i < 70; i++) {
    const t = birdRnd();
    const curve = Math.sin(t * Math.PI);
    const z = 0.28 + t * 1.08;
    const y = 0.02 + curve * 0.15 - t * 0.03;
    const x = (birdRnd() - 0.5) * (0.12 - t * 0.045) + Math.sin(t * Math.PI * 1.45) * 0.025;
    birdColor.copy(faceWhite).lerp(warmGrey, 0.22 + t * 0.22).lerp(slate, (1 - t) * 0.16);
    addBirdDab(x, y + (birdRnd() - 0.5) * 0.04, z, birdJitter(birdColor, 0.014, 0.04, 0.04),
      0.11 + birdRnd() * 0.07, Math.PI / 2 + (birdRnd() - 0.5) * 0.28, 0.26 + birdRnd() * 0.12, 0, birdRnd(), 0, BIRD_PART_NECK);
  }
  for (let i = 0; i < 80; i++) {
    const a = birdRnd() * Math.PI * 2;
    const r = Math.sqrt(birdRnd());
    const x = Math.cos(a) * r * 0.15;
    const y = 0.13 + Math.sin(a) * r * 0.1;
    const z = 1.43 + (birdRnd() - 0.5) * 0.18;
    birdColor.copy(faceWhite).lerp(slateLight, 0.16 + birdRnd() * 0.18);
    addBirdDab(x, y, z, birdJitter(birdColor, 0.014, 0.045, 0.045),
      0.065 + birdRnd() * 0.06, birdRnd() * Math.PI, 0.34 + birdRnd() * 0.18, 0, birdRnd(), 0, BIRD_PART_HEAD);
  }
  for (let i = 0; i < 48; i++) {
    const t = birdRnd();
    const side = birdRnd() < 0.5 ? -1 : 1;
    const x = side * (0.02 + t * 0.13) + (birdRnd() - 0.5) * 0.025;
    const y = 0.22 + t * 0.08 + (birdRnd() - 0.5) * 0.035;
    const z = 1.34 - t * 0.18 + (birdRnd() - 0.5) * 0.06;
    birdColor.copy(ink).lerp(inkBlue, birdRnd() * 0.24);
    addBirdDab(x, y, z, birdJitter(birdColor, 0.01, 0.035, 0.035),
      0.05 + birdRnd() * 0.05, side * 0.75 + (birdRnd() - 0.5) * 0.25, 0.12 + birdRnd() * 0.08, 0, birdRnd(), 0, BIRD_PART_HEAD);
  }
  for (let i = 0; i < 76; i++) {
    const t = birdRnd();
    const x = (birdRnd() - 0.5) * (0.078 - t * 0.046);
    const y = 0.1 - t * 0.012 + (birdRnd() - 0.5) * (0.046 - t * 0.018);
    const z = 1.54 + t * 0.74;
    birdColor.copy(bill).lerp(billDark, t * 0.34 + birdRnd() * 0.14).lerp(cream, (1 - t) * 0.08);
    addBirdDab(x, y, z, birdJitter(birdColor, 0.012, 0.05, 0.045),
      0.068 + (1 - t) * 0.018 + birdRnd() * 0.052, Math.PI / 2 + (birdRnd() - 0.5) * 0.22, 0.13 + birdRnd() * 0.08, 0, birdRnd(), 0, BIRD_PART_HEAD);
  }

  // Shoulder bridge: dense overlapping strokes that tie each wing into the torso.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 80; i++) {
      const t = birdRnd();
      const x = side * (0.1 + t * 0.5);
      const z = -0.38 + birdRnd() * 0.78 - t * 0.06;
      const y = -0.035 + Math.sin(t * Math.PI) * 0.08 + (birdRnd() - 0.5) * 0.055;
      birdColor.copy(slate).lerp(slateLight, 0.12 + birdRnd() * 0.18).lerp(slateDark, t * 0.16);
      addBirdDab(x, y, z, birdJitter(birdColor, 0.016, 0.045, 0.045),
        0.2 + birdRnd() * 0.13, side * 0.18 + (birdRnd() - 0.5) * 0.28, 0.42 + birdRnd() * 0.2,
        side, birdRnd(), 0.18 + t * 0.24);
    }
  }

  // Long heron wings: curved slate coverts, darker trailing feathers, tapered tips.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 120; i++) {
      const span = Math.pow(birdRnd(), 0.68);
      const chordWidth = 0.82 * Math.pow(1 - span, 0.62) + 0.08;
      const chord = (birdRnd() - 0.5) * chordWidth - span * span * 0.08;
      const x = side * (0.14 + span * 2.22);
      const z = -0.02 + chord + Math.sin(span * Math.PI) * 0.05;
      const y = -0.005 + Math.sin(span * Math.PI) * 0.07 + (birdRnd() - 0.5) * (0.06 - span * 0.02);
      birdColor.copy(slate).lerp(slateLight, 0.16 + Math.max(0, chord) * 0.14).lerp(slateDark, span * 0.18);
      addBirdDab(x, y, z, birdJitter(birdColor, 0.018, 0.045, 0.045),
        0.25 + birdRnd() * 0.15, side * 0.16 + (birdRnd() - 0.5) * 0.28, 0.42 + birdRnd() * 0.18,
        side, birdRnd(), span * 0.7);
    }
  }
  for (const side of [-1, 1]) {
    for (let i = 0; i < 190; i++) {
      const span = Math.pow(birdRnd(), 0.72);
      const chordWidth = 0.86 * Math.pow(1 - span, 0.64) + 0.06;
      const chord = (birdRnd() - 0.5) * chordWidth - span * span * 0.1;
      const tip = THREE.MathUtils.smoothstep(span, 0.68, 1);
      const x = side * (0.16 + span * 2.38 - tip * 0.16);
      const z = -0.04 + chord + Math.sin(span * Math.PI) * 0.06;
      const y = -0.01 + Math.sin(span * Math.PI) * 0.08 + (birdRnd() - 0.5) * (0.08 - tip * 0.04);
      const primary = span > 0.7 || (span > 0.54 && chord < -0.16);
      const trailing = chord < -0.18;
      birdColor.copy(primary ? inkBlue : slate)
        .lerp(primary || trailing ? slateDark : slateLight, primary ? 0.5 + birdRnd() * 0.25 : 0.18 + birdRnd() * 0.18)
        .lerp(warmGrey, Math.max(0, chord) * 0.08);
      addBirdDab(x, y, z, birdJitter(birdColor, 0.022, 0.06, 0.06),
        primary ? 0.1 + birdRnd() * 0.1 : 0.14 + birdRnd() * 0.12,
        side * 0.18 + (birdRnd() - 0.5) * 0.38, primary ? 0.12 + birdRnd() * 0.1 : 0.28 + birdRnd() * 0.2,
        side, birdRnd(), span);
    }
  }
  for (let i = 0; i < 70; i++) {
    const side = birdRnd() < 0.5 ? -1 : 1;
    const span = 0.22 + birdRnd() * 0.62;
    const chordWidth = 0.38 * (1 - span * 0.7) + 0.06;
    const x = side * (0.48 + span * 1.9);
    const z = -0.24 + (birdRnd() - 0.5) * chordWidth + Math.sin(span * Math.PI) * 0.04;
    const y = 0.04 + span * 0.08 + (birdRnd() - 0.5) * 0.035;
    birdColor.copy(slateLight).lerp(slateDark, 0.42 + span * 0.24);
    addBirdDab(x, y, z, birdJitter(birdColor, 0.016, 0.045, 0.045),
      0.09 + birdRnd() * 0.08, side * 0.12 + (birdRnd() - 0.5) * 0.18, 0.1 + birdRnd() * 0.06,
      side, birdRnd(), span * 0.8);
  }

  // Trailing dark ochre legs and delicate toes.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 32; i++) {
      const t = birdRnd();
      const x = side * (0.11 + (birdRnd() - 0.5) * 0.03);
      const y = -0.21 - t * 0.5;
      const z = -0.4 - t * 0.62;
      birdColor.copy(leg).lerp(legDark, 0.18 + t * 0.46);
      addBirdDab(x, y, z, birdJitter(birdColor, 0.01, 0.04, 0.04),
        0.05 + birdRnd() * 0.045, Math.PI / 2 + (birdRnd() - 0.5) * 0.18, 0.12 + birdRnd() * 0.08, 0, birdRnd(), 0, BIRD_PART_LEG);
    }
    for (let toe = -1; toe <= 1; toe++) {
      for (let i = 0; i < 8; i++) {
        const t = i / 7;
        const x = side * (0.11 + toe * t * 0.09);
        const y = -0.72 - t * 0.035;
        const z = -1.03 - t * (0.16 + Math.abs(toe) * 0.055);
        birdColor.copy(legDark).lerp(leg, 0.16);
        addBirdDab(x, y, z, birdJitter(birdColor, 0.008, 0.035, 0.035),
          0.035, toe * 0.35, 0.12, 0, birdRnd(), 0, BIRD_PART_LEG);
      }
    }
  }
}
buildPlayerBird();

function initPlayerBirdStaticAttributes() {
  for (let i = 0; i < PLAYER_BIRD_COUNT; i++) {
    const d = birdLocal[i];
    const k = i * 3;
    birdCol[k] = d.color.r;
    birdCol[k + 1] = d.color.g;
    birdCol[k + 2] = d.color.b;
    birdSize[i] = d.size * PLAYER_BIRD_SIZE_SCALE;
    birdAspect[i] = d.aspect;
    birdType[i] = T_GROUND;
    birdPhase[i] = d.phase;
    birdFlex[i] = 0;
  }
}
initPlayerBirdStaticAttributes();

const fixed = (arr, n) => new THREE.BufferAttribute(arr, n);
const birdGeo = new THREE.BufferGeometry();
birdGeo.setAttribute('position', dyn(birdPos, 3));
birdGeo.setAttribute('splatColor', fixed(birdCol, 3));
birdGeo.setAttribute('splatSize', fixed(birdSize, 1));
birdGeo.setAttribute('splatAngle', dyn(birdAngle, 1));
birdGeo.setAttribute('splatAspect', fixed(birdAspect, 1));
birdGeo.setAttribute('splatType', fixed(birdType, 1));
birdGeo.setAttribute('splatPhase', fixed(birdPhase, 1));
birdGeo.setAttribute('splatFlex', fixed(birdFlex, 1));
birdGeo.setDrawRange(0, PLAYER_BIRD_COUNT);
const playerBird = new THREE.Points(birdGeo, splatMat);
playerBird.frustumCulled = false;
playerBird.renderOrder = 2;
scene.add(playerBird);

function updatePlayerBird(t, dt) {
  const motion = THREE.MathUtils.clamp(flight.airSpeed / Math.max(BASE_SPEED + flight.speedTrim, 1), 0, 1);
  const fwd = flight.forward;
  const right = flight.right;
  const up = flight.up;
  const cx = flight.x;
  const cy = flight.y + Math.sin(t * 1.1) * 0.16;
  const cz = flight.z;
  const pitchCue = THREE.MathUtils.clamp(flight.speedCue, -1, 1);
  const climbCue = THREE.MathUtils.smoothstep(pitchCue, 0.06, 0.82);
  const glideCue = THREE.MathUtils.smoothstep(-pitchCue, 0.04, 0.78);
  const bankCue = THREE.MathUtils.clamp(flight.swing, -1, 1);

  const cadenceTarget = THREE.MathUtils.clamp(0.18 + motion * 0.06 + climbCue * 0.13 - glideCue * 0.1, 0.08, 0.38);
  const powerTarget = THREE.MathUtils.clamp(0.22 + motion * 0.23 + climbCue * 0.2 - glideCue * 0.32, 0.06, 0.58);
  const flexTarget = THREE.MathUtils.clamp(0.42 + motion * 0.16 + climbCue * 0.22 - glideCue * 0.12, 0.24, 0.78);
  flight.wingCadence += (cadenceTarget - flight.wingCadence) * (1 - Math.exp(-dt * 2.2));
  flight.wingPower += (powerTarget - flight.wingPower) * (1 - Math.exp(-dt * 2.8));
  flight.wingFlex += (flexTarget - flight.wingFlex) * (1 - Math.exp(-dt * 2.6));
  flight.wingPhase = (flight.wingPhase + dt * flight.wingCadence * Math.PI * 2) % (Math.PI * 2);

  const flapWave = Math.sin(flight.wingPhase);
  const flap = flapWave * flight.wingPower;
  const strokeFlex = (0.55 + Math.abs(flapWave) * 0.45) * flight.wingFlex * (1 - glideCue * 0.35);
  const settle = Math.sin(t * (0.78 + motion * 0.22) + 0.6) * 0.08 * (0.35 + motion * 0.65) * (1 - glideCue * 0.7);
  const headYaw = THREE.MathUtils.clamp(-flight.roll * 0.45 + Math.sin(t * 1.25) * 0.045, -0.38, 0.38);
  const headPitch = THREE.MathUtils.clamp(-flight.pitch * 0.42 + Math.sin(t * 1.55 + 0.7) * 0.035, -0.22, 0.22);
  const headRoll = THREE.MathUtils.clamp(-flight.roll * 0.22 + Math.sin(t * 0.95 + 1.2) * 0.025, -0.18, 0.18);
  const headBaseX = 0;
  const headBaseY = 0.08;
  const headBaseZ = 1.08;
  const cyaw = Math.cos(headYaw), syaw = Math.sin(headYaw);
  const cpitch = Math.cos(headPitch), spitch = Math.sin(headPitch);
  const croll = Math.cos(headRoll), sroll = Math.sin(headRoll);

  for (let i = 0; i < PLAYER_BIRD_COUNT; i++) {
    const d = birdLocal[i];
    const span = Math.min(1, Math.abs(d.x) / 2.58);
    let x = d.x * PLAYER_BIRD_SCALE;
    let y = d.y * PLAYER_BIRD_SCALE;
    let z = d.z * PLAYER_BIRD_SCALE;
    if (d.wingSide !== 0) {
      const bankSide = d.wingSide * bankCue;
      const insideTurn = Math.max(0, -bankSide);
      const outsideTurn = Math.max(0, bankSide);
      const lift = (0.16 + span * 0.64 + climbCue * (0.05 + span * 0.14)) * flap + settle;
      const glideLift = (0.07 + span * 0.16) * glideCue;
      const bankLift = bankSide * (0.08 + span * 0.28) * (0.45 + motion * 0.55);
      const tipFlex = Math.pow(span, 1.35) * d.flex * strokeFlex;
      const flapBend = flap * tipFlex * (0.24 + climbCue * 0.12);
      y += (lift + glideLift + bankLift - insideTurn * span * 0.08) * (d.flex + tipFlex * 0.32) + flapBend;
      z -= Math.abs(flap) * span * (0.08 + climbCue * 0.05) * (0.35 + motion * 0.65) * (1 - glideCue * 0.62);
      z += flap * tipFlex * 0.16;
      z -= span * glideCue * 0.08;
      z += insideTurn * span * 0.11 - outsideTurn * span * 0.04;
      x += d.wingSide * span * (glideCue * 0.13 + outsideTurn * 0.08 - insideTurn * 0.14);
      x += d.wingSide * Math.sin(flight.wingPhase + d.phase * 0.7) * span * 0.055 * (0.35 + motion * 0.65) * (1 - glideCue * 0.55);
    } else if (d.part === BIRD_PART_HEAD) {
      let hx = x - headBaseX;
      let hy = y - headBaseY;
      let hz = z - headBaseZ;
      let tx = hx * cyaw + hz * syaw;
      let tz = -hx * syaw + hz * cyaw;
      hx = tx; hz = tz;
      let ty = hy * cpitch - hz * spitch;
      tz = hy * spitch + hz * cpitch;
      hy = ty; hz = tz;
      tx = hx * croll - hy * sroll;
      ty = hx * sroll + hy * croll;
      hx = tx; hy = ty;
      x = headBaseX + hx + Math.sin(t * 2.0 + d.phase * 6.28318) * 0.018;
      y = headBaseY + hy + Math.sin(t * 1.35 + d.phase * 5.0) * 0.018;
      z = headBaseZ + hz + Math.cos(t * 1.1 + d.phase * 4.0) * 0.025;
    } else if (d.part === BIRD_PART_NECK) {
      const neckT = THREE.MathUtils.clamp((d.z - 0.24) / 1.18, 0, 1);
      x += headYaw * 0.13 * neckT + Math.sin(t * 1.8 + d.phase * 6.28318) * 0.015 * neckT;
      y += headPitch * 0.06 * neckT + Math.sin(t * 1.2 + d.phase * 4.5) * 0.012 * neckT;
      z += Math.cos(t * 1.35 + d.phase * 5.1) * 0.018 * neckT;
    } else if (d.part === BIRD_PART_TAIL) {
      const tailT = THREE.MathUtils.clamp((-d.z - 0.5) / 0.86, 0, 1);
      const fan = THREE.MathUtils.clamp(d.x / 0.32, -1, 1);
      x += fan * (Math.abs(flight.roll) * 0.025 + Math.abs(flap) * 0.018) * tailT;
      y += (-flight.pitch * 0.1 + Math.abs(flap) * 0.035) * tailT
        + Math.sin(t * 1.45 + d.phase * 6.28318) * 0.014 * tailT;
      z += Math.cos(t * 1.1 + d.phase * 5.2) * 0.018 * tailT;
    } else {
      y += Math.sin(t * 1.7 + d.phase * 6.28318) * 0.025;
    }

    const k = i * 3;
    birdPos[k] = cx + right.x * x + up.x * y + fwd.x * z;
    birdPos[k + 1] = cy + right.y * x + up.y * y + fwd.y * z;
    birdPos[k + 2] = cz + right.z * x + up.z * y + fwd.z * z;
    birdAngle[i] = d.angle + (d.wingSide ? d.wingSide * (flap * 0.14 + bankCue * (0.06 + span * 0.08) + glideCue * 0.035) : 0);
  }
  for (const name of ['position', 'splatAngle']) {
    const a = birdGeo.attributes[name];
    a.clearUpdateRanges();
    a.addUpdateRange(0, PLAYER_BIRD_COUNT * a.itemSize);
    a.needsUpdate = true;
  }
}

// ---------------- tile manager ----------------
const loaded = new Map();      // key -> tile data
const genQueue = [];           // keys waiting to be generated
let curTX = NaN, curTZ = NaN;
let rebuildDirty = false, forceSort = false;
const key = (tx, tz) => tx + ',' + tz;

function setDesired(ctx, ctz) {
  const want = new Set();
  for (let dx = -GRID_R; dx <= GRID_R; dx++)
    for (let dz = -GRID_R; dz <= GRID_R; dz++)
      want.add(key(ctx + dx, ctz + dz));

  // drop tiles that fell out of range
  for (const k of [...loaded.keys()]) {
    if (!want.has(k)) { loaded.delete(k); rebuildDirty = true; }
  }
  // queue new tiles, nearest first, skipping any already queued/loaded
  const queued = new Set(genQueue);
  const toAdd = [];
  for (const k of want) {
    if (loaded.has(k) || queued.has(k)) continue;
    const [tx, tz] = k.split(',').map(Number);
    toAdd.push({ k, d: Math.abs(tx - ctx) + Math.abs(tz - ctz) });
  }
  toAdd.sort((a, b) => a.d - b.d);
  for (const t of toAdd) genQueue.push(t.k);
}

const GEN_PER_FRAME = 1;
function processQueue() {
  let made = 0;
  while (genQueue.length && made < GEN_PER_FRAME) {
    const k = genQueue.shift();
    if (loaded.has(k)) continue;
    const [tx, tz] = k.split(',').map(Number);
    const buildStart = performance.now();
    loaded.set(k, buildTile(tx, tz));
    perfStats.lastTileMs = performance.now() - buildStart;
    made++; rebuildDirty = true;
  }
  perfStats.queued = genQueue.length;
}

function rebuild() {
  const rebuildStart = performance.now();
  let o3 = 0, o1 = 0;
  activeLeafSources.length = 0;
  for (const t of loaded.values()) {
    if (o1 + t.count > CAP) break;            // safety; should never hit
    M.pos.set(t.pos, o3); M.col.set(t.col, o3);
    M.size.set(t.size, o1); M.angle.set(t.angle, o1);
    M.aspect.set(t.aspect, o1); M.type.set(t.type, o1);
    M.phase.set(t.phase, o1); M.flex.set(t.flex, o1);
    if (t.leafSources) activeLeafSources.push(...t.leafSources);
    o3 += t.count * 3; o1 += t.count;
  }
  count = o1;
  forceSort = true;
  perfStats.strokes = count + PLAYER_BIRD_COUNT + WAKE_LEAF_COUNT + WAKE_POLLEN_COUNT;
  perfStats.tiles = loaded.size;
  perfStats.lastRebuildMs = performance.now() - rebuildStart;
  const stat = document.getElementById('stat');
  if (stat) {
    stat.textContent = `${(count + PLAYER_BIRD_COUNT).toLocaleString()} strokes · ${loaded.size} tiles`;
  }
}

// ---------------- O(n) counting sort over the live set ----------------
const BUCKETS = 512;
const SORT_INTERVAL_ACTIVE = 6;
const SORT_INTERVAL_CALM = 10;
const counts = new Uint32Array(BUCKETS);
const starts = new Uint32Array(BUCKETS);
const viewDir = new THREE.Vector3();

function sortSplats() {
  if (count === 0) { geometry.setDrawRange(0, 0); return; }
  const sortStart = performance.now();
  camera.getWorldDirection(viewDir);
  const vx = viewDir.x, vy = viewDir.y, vz = viewDir.z;
  const cx = uniforms.uCamXZ.value.x, cz = uniforms.uCamXZ.value.y;
  const cullSq = SORT_CULL_RADIUS * SORT_CULL_RADIUS;
  let min = Infinity, max = -Infinity;
  let visible = 0;
  for (let i = 0; i < count; i++) {
    const j = i * 3;
    const dx = M.pos[j] - cx, dz = M.pos[j + 2] - cz;
    if (dx * dx + dz * dz > cullSq) continue;
    const k = M.pos[j] * vx + M.pos[j + 1] * vy + M.pos[j + 2] * vz;
    keys[visible] = k;
    sourceOrder[visible] = i;
    visible++;
    if (k < min) min = k;
    if (k > max) max = k;
  }
  if (visible === 0) {
    geometry.setDrawRange(0, 0);
    perfStats.visible = 0;
    perfStats.lastSortMs = performance.now() - sortStart;
    return;
  }
  const inv = (BUCKETS - 1) / Math.max(max - min, 1e-6);
  counts.fill(0);
  for (let i = 0; i < visible; i++) counts[((keys[i] - min) * inv) | 0]++;
  let acc = 0;
  for (let b = BUCKETS - 1; b >= 0; b--) { starts[b] = acc; acc += counts[b]; }
  for (let i = 0; i < visible; i++) {
    const b = ((keys[i] - min) * inv) | 0;
    order[starts[b]++] = sourceOrder[i];
  }
  for (let i = 0; i < visible; i++) {
    const s = order[i], d3 = i * 3, s3 = s * 3;
    rPos[d3] = M.pos[s3]; rPos[d3 + 1] = M.pos[s3 + 1]; rPos[d3 + 2] = M.pos[s3 + 2];
    rCol[d3] = M.col[s3]; rCol[d3 + 1] = M.col[s3 + 1]; rCol[d3 + 2] = M.col[s3 + 2];
    rSize[i] = M.size[s]; rAngle[i] = M.angle[s]; rAspect[i] = M.aspect[s];
    rType[i] = M.type[s]; rPhase[i] = M.phase[s]; rFlex[i] = M.flex[s];
  }
  for (const name of ['position', 'splatColor', 'splatSize', 'splatAngle', 'splatAspect', 'splatType', 'splatPhase', 'splatFlex']) {
    const a = geometry.attributes[name];
    a.clearUpdateRanges();
    a.addUpdateRange(0, visible * a.itemSize);
    a.needsUpdate = true;
  }
  geometry.setDrawRange(0, visible);
  perfStats.visible = visible + PLAYER_BIRD_COUNT + WAKE_LEAF_COUNT + WAKE_POLLEN_COUNT;
  perfStats.lastSortMs = performance.now() - sortStart;
}

// ---------------- bird flight + chase camera ----------------
const UP = new THREE.Vector3(0, 1, 0);
const MAX_ROLL = 0.62;
const MAX_PITCH = 0.42;
const MIN_CLEARANCE = 14;
const SOFT_FLOOR_CLEARANCE = 24;
const SOFT_CEILING_CLEARANCE = 96;
const MAX_CLEARANCE = 128;
const BASE_SPEED = 18;
const START_CLEARANCE = 38;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const flight = {
  x: 0,
  z: 18,
  y: heightAt(0, 18) + START_CLEARANCE,
  yaw: 0.12,
  pitch: -0.03,
  roll: 0,
  forward: new THREE.Vector3(),
  right: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0),
  flatForward: new THREE.Vector3(),
  flatRight: new THREE.Vector3(1, 0, 0),
  camPos: new THREE.Vector3(),
  lookTarget: new THREE.Vector3(),
  swing: 0,
  turnLead: 0,
  speedCue: 0,
  fovOffset: 0,
  clock: 0,
  wingPhase: 0,
  wingCadence: 0.22,
  wingPower: 0.34,
  wingFlex: 0.5,
  airSpeed: BASE_SPEED,
  speedTrim: 0,
  camYawOffset: 0,
  camYawTarget: 0,
  camPitchOffset: 0,
  camPitchTarget: 0
};
const rollQuat = new THREE.Quaternion();
const cameraBack = new THREE.Vector3();
const cameraSide = new THREE.Vector3();
let cameraPrimed = false;

let lastInput = performance.now();
const keyState = { climb: false, dive: false, left: false, right: false };
const hasFlightInput = () => keyState.climb || keyState.dive || keyState.left || keyState.right;
function clearFlightKeys() {
  keyState.climb = false;
  keyState.dive = false;
  keyState.left = false;
  keyState.right = false;
}

function updateFlightBasis() {
  const cp = Math.cos(flight.pitch);
  flight.forward.set(
    Math.sin(flight.yaw) * cp,
    Math.sin(flight.pitch),
    Math.cos(flight.yaw) * cp
  ).normalize();
  flight.flatForward.set(Math.sin(flight.yaw), 0, Math.cos(flight.yaw)).normalize();
  flight.flatRight.set(Math.cos(flight.yaw), 0, -Math.sin(flight.yaw)).normalize();
  flight.right.copy(flight.flatRight);
  flight.up.copy(flight.forward).cross(flight.right).normalize();
  rollQuat.setFromAxisAngle(flight.forward, flight.roll);
  flight.right.applyQuaternion(rollQuat).normalize();
  flight.up.applyQuaternion(rollQuat).normalize();
}
updateFlightBasis();

const el = renderer.domElement;
el.style.touchAction = 'none';
let dragging = false, lastX = 0, lastY = 0;

el.addEventListener('pointerdown', (e) => {
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  lastInput = performance.now();
  el.setPointerCapture(e.pointerId);
});
el.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  flight.camYawTarget = THREE.MathUtils.clamp(flight.camYawTarget + (e.clientX - lastX) * 0.0032, -0.72, 0.72);
  flight.camPitchTarget = THREE.MathUtils.clamp(flight.camPitchTarget + (e.clientY - lastY) * 0.0024, -0.32, 0.34);
  lastX = e.clientX; lastY = e.clientY;
  lastInput = performance.now();
});
el.addEventListener('pointerup', () => { dragging = false; });
el.addEventListener('pointercancel', () => { dragging = false; });

// Scroll trims cruise speed without zooming the lens.
el.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey) return;
  flight.speedTrim = THREE.MathUtils.clamp(flight.speedTrim + (-e.deltaY) * 0.006, -5, 9);
  flight.camYawTarget = THREE.MathUtils.clamp(flight.camYawTarget + e.deltaX * 0.00045, -0.72, 0.72);
  lastInput = performance.now();
}, { passive: false });

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'arrowup') keyState.climb = true;
  else if (k === 's' || k === 'arrowdown') keyState.dive = true;
  else if (k === 'a' || k === 'arrowleft') keyState.right = true;
  else if (k === 'd' || k === 'arrowright') keyState.left = true;
  else return;
  e.preventDefault();
  lastInput = performance.now();
});
addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'arrowup') keyState.climb = false;
  else if (k === 's' || k === 'arrowdown') keyState.dive = false;
  else if (k === 'a' || k === 'arrowleft') keyState.right = false;
  else if (k === 'd' || k === 'arrowright') keyState.left = false;
  else return;
  e.preventDefault();
});
addEventListener('blur', clearFlightKeys);

function updateFlight(dt, now) {
  const inputActive = hasFlightInput();
  const rollIntent = (keyState.left ? 1 : 0) - (keyState.right ? 1 : 0);
  const pitchIntent = (keyState.climb ? 1 : 0) - (keyState.dive ? 1 : 0);
  let targetRoll = rollIntent * MAX_ROLL;
  let targetPitch = pitchIntent * MAX_PITCH;

  const currentGround = heightAt(flight.x, flight.z);
  const clearance = flight.y - currentGround;

  if (clearance < SOFT_FLOOR_CLEARANCE) {
    const lift = 1 - THREE.MathUtils.clamp(
      (clearance - MIN_CLEARANCE) / (SOFT_FLOOR_CLEARANCE - MIN_CLEARANCE),
      0, 1
    );
    targetPitch = Math.max(targetPitch, THREE.MathUtils.lerp(0.04, 0.18, lift));
  } else if (clearance > SOFT_CEILING_CLEARANCE) {
    const descend = THREE.MathUtils.clamp(
      (clearance - SOFT_CEILING_CLEARANCE) / (MAX_CLEARANCE - SOFT_CEILING_CLEARANCE),
      0, 1
    );
    targetPitch = Math.min(targetPitch, THREE.MathUtils.lerp(-0.04, -0.2, descend));
  }

  flight.roll += (targetRoll - flight.roll) * (1 - Math.exp(-dt * 2.15));
  flight.pitch += (targetPitch - flight.pitch) * (1 - Math.exp(-dt * 1.85));
  flight.yaw -= flight.roll * 0.95 * dt;
  updateFlightBasis();

  const cruise = BASE_SPEED + flight.speedTrim;
  const trade = flight.pitch < 0 ? 0.72 : 0.2;
  const targetAirSpeed = inputActive ? cruise : cruise * 0.62;
  const speedEase = targetAirSpeed > flight.airSpeed ? 1.85 : 1.45;
  flight.airSpeed += (targetAirSpeed - flight.airSpeed) * (1 - Math.exp(-dt * speedEase));
  const speed = flight.airSpeed * (1 - flight.pitch * trade);
  flight.x += flight.forward.x * speed * dt;
  flight.y += flight.forward.y * speed * dt;
  flight.z += flight.forward.z * speed * dt;

  const ground = heightAt(flight.x, flight.z);
  const floor = ground + MIN_CLEARANCE;
  if (flight.y < floor) {
    flight.y = floor;
    flight.pitch = Math.max(flight.pitch, 0.04);
  } else if (inputActive && clearance < MIN_CLEARANCE + 4) {
    flight.y += (ground + MIN_CLEARANCE - flight.y) * (1 - Math.exp(-dt * 1.2));
    flight.pitch = Math.max(flight.pitch, 0.13);
  }
  const ceiling = ground + MAX_CLEARANCE;
  if (flight.y > ceiling) {
    flight.y = ceiling;
    flight.pitch = Math.min(flight.pitch, -0.06);
  }
  updateFlightBasis();

  flight.clock += dt;
  updateCamera(dt, now);
}

function updateCamera(dt, now) {
  const swingTarget = flight.roll / MAX_ROLL;
  flight.swing += (swingTarget - flight.swing) * (1 - Math.exp(-dt * 2.0));
  const s = flight.swing;
  const a = Math.min(1, Math.abs(s));

  const leadEase = Math.abs(swingTarget) > Math.abs(flight.turnLead) ? 2.4 : 1.45;
  flight.turnLead += (swingTarget - flight.turnLead) * (1 - Math.exp(-dt * leadEase));
  flight.speedCue += (flight.pitch / MAX_PITCH - flight.speedCue) * (1 - Math.exp(-dt * 1.35));
  const dive = Math.max(0, -flight.speedCue);
  const climb = Math.max(0, flight.speedCue);

  if (!dragging && now - lastInput > 1200) {
    flight.camYawTarget *= Math.exp(-dt * 0.35);
    flight.camPitchTarget *= Math.exp(-dt * 0.35);
  }
  flight.camYawOffset += (flight.camYawTarget - flight.camYawOffset) * (1 - Math.exp(-dt * 5.5));
  flight.camPitchOffset += (flight.camPitchTarget - flight.camPitchOffset) * (1 - Math.exp(-dt * 5.5));

  cameraBack.copy(flight.flatForward).multiplyScalar(-1).applyAxisAngle(UP, flight.camYawOffset).normalize();
  cameraSide.copy(flight.flatRight).applyAxisAngle(UP, flight.camYawOffset).normalize();

  const calm = 1 - Math.max(a, Math.abs(flight.speedCue));
  const breath = calm * 0.55;
  const bob = Math.sin(flight.clock * 0.62) * 0.8 * breath;
  const sway = Math.sin(flight.clock * 0.41 + 1.3) * 0.55 * breath;

  const lateral = -s * 5.8 + sway * 0.45;
  const backDist = 16.8 - a * 2.8 + dive * 2.8 - climb * 1.2;
  const rise = 19.5 - a * 0.8 + bob * 0.45 + dive * 0.6 - flight.camPitchOffset * 12;

  flight.camPos.set(flight.x, flight.y, flight.z)
    .addScaledVector(cameraBack, backDist)
    .addScaledVector(cameraSide, lateral)
    .addScaledVector(UP, rise);
  if (cameraPrimed) camera.position.lerp(flight.camPos, 1 - Math.exp(-dt * 3.8));
  else {
    camera.position.copy(flight.camPos);
    cameraPrimed = true;
  }

  const ahead = 11.2 - a * 2.9 + climb * 1.4;
  flight.lookTarget.set(flight.x, flight.y, flight.z)
    .addScaledVector(flight.forward, ahead)
    .addScaledVector(cameraSide, flight.turnLead * 2.2)
    .addScaledVector(UP, -1.0 + flight.camPitchOffset * 4.5);
  camera.up.copy(UP);
  camera.lookAt(flight.lookTarget);

  const fovTarget = dive * 5.0 - climb * 1.7;
  flight.fovOffset += (fovTarget - flight.fovOffset) * (1 - Math.exp(-dt * 2.0));
  const baseFov = camera.baseFov ?? (camera.baseFov = camera.fov);
  camera.fov = baseFov + flight.fovOffset;
  camera.updateProjectionMatrix();
  camera.rotateZ(flight.roll * 0.12);

  sky.position.copy(camera.position);
  uniforms.uCamXZ.value.set(camera.position.x, camera.position.z);
}

// ---------------- UI ----------------
function newWorld() {
  WORLD_SEED = (Math.random() * 1e9) | 0;
  N = makeNoise(WORLD_SEED);
  loaded.clear(); genQueue.length = 0;
  activeLeafSources.length = 0;
  curTX = NaN; curTZ = NaN;             // force a fresh desired-set next frame
  flight.y = heightAt(flight.x, flight.z) + START_CLEARANCE;
  flight.pitch = Math.max(flight.pitch, -0.03);
  updateFlightBasis();
  rebuildDirty = true;
}
const regenButton = document.getElementById('regen');
if (regenButton) regenButton.addEventListener('click', newWorld);

const densityInput = document.getElementById('density');
if (densityInput) {
  densityInput.addEventListener('input', (e) => {
    DENSITY = parseFloat(e.target.value);
    // regenerate the loaded tiles at the new density
    loaded.clear(); genQueue.length = 0;
    activeLeafSources.length = 0;
    curTX = NaN; curTZ = NaN;
    rebuildDirty = true;
  });
}

const impastoInput = document.getElementById('impasto');
if (impastoInput) {
  impastoInput.addEventListener('input', (e) => {
    paintMat.uniforms.uImpasto.value = parseFloat(e.target.value);
  });
}

const glowInput = document.getElementById('glow');
if (glowInput) {
  glowInput.addEventListener('input', (e) => {
    paintMat.uniforms.uGlow.value = parseFloat(e.target.value);
  });
}

const windInput = document.getElementById('wind');
if (windInput) {
  windInput.addEventListener('input', (e) => {
    uniforms.uWind.value = parseFloat(e.target.value);
  });
}
function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  makeTargets();
  uniforms.uScale.value =
    renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}
addEventListener('resize', onResize);
onResize();

// ---------------- main loop ----------------
let last = performance.now(), frame = 0;
function loop(now) {
  const frameMs = now - last;
  const dt = Math.min(frameMs / 1000, 0.05);
  last = now;
  perfStats.avgFrameMs += (frameMs - perfStats.avgFrameMs) * 0.04;
  if (!reducedMotion) uniforms.uTime.value += dt;

  updateFlight(dt, now);
  updateLandscapeWake(dt);
  updatePlayerBird(now * 0.001, dt);

  // keep the tile grid centred on the bird
  const ctx = Math.floor(flight.x / TILE), ctz = Math.floor(flight.z / TILE);
  if (ctx !== curTX || ctz !== curTZ) { setDesired(ctx, ctz); curTX = ctx; curTZ = ctz; }
  processQueue();
  if (rebuildDirty) { rebuild(); rebuildDirty = false; }

  const sortInterval = Math.max(Math.abs(flight.swing), Math.abs(flight.speedCue)) > 0.25
    ? SORT_INTERVAL_ACTIVE
    : SORT_INTERVAL_CALM;
  perfStats.sortInterval = sortInterval;
  if (forceSort || frame % sortInterval === 0) { sortSplats(); forceSort = false; }
  if (frame % 60 === 0) renderer.domElement.dataset.perf = JSON.stringify(perfStats);
  frame++;

  renderer.setRenderTarget(rtScene);
  renderer.render(scene, camera);
  paintMat.uniforms.tDiffuse.value = rtScene.texture;
  renderer.setRenderTarget(null);
  renderer.render(paintScene, postCam);

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
