import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import {
  TILE, PER_TILE_CAP, WATER_LEVEL, F_STRIDE, U_STRIDE,
  T_GROUND, T_FOLIAGE, T_GRASS, T_LEAF, T_FLY, T_BIRD, T_SMOKE, T_WATER,
  SUN, SHADOW, LIGHT,
} from './config.js';
import { heightAt, pathMask, groveField, dryness, poppyField, tileSeed, noise } from './terrain.js';

// Builds one tile of strokes, writing DIRECTLY into its slot of the shared
// interleaved buffers — no intermediate arrays, no per-tile allocation, no
// whole-world rebuild afterwards.
//
// The old builder re-derived terrain (heightAt + slopeAt + normalAt ≈ nine
// fbm stacks) for every one of ~15k strokes: ~2.5M noise evaluations per tile
// and a visible hitch at every tile crossing. We now sample the height field
// once into a small padded grid (~1.5k evaluations) and every stroke reads
// bilinear height / finite-difference slope+normal from it. Grid nodes land
// exactly on tile borders, so neighbouring tiles agree and there are no seams.

const GRES = 36;                 // grid cells across a tile (~1.6 m)
const GPAD = 2;                  // margin cells for gradients at the border
const GN = GRES + 2 * GPAD + 1;
const gridH = new Float32Array(GN * GN);
const STEP = TILE / GRES;

let gox = 0, goz = 0;            // world origin of gridH[0,0]

function fillGrid(ox, oz) {
  gox = ox - GPAD * STEP;
  goz = oz - GPAD * STEP;
  for (let j = 0; j < GN; j++) {
    const z = goz + j * STEP;
    for (let i = 0; i < GN; i++) {
      gridH[j * GN + i] = heightAt(gox + i * STEP, z);
    }
  }
}

function gh(x, z) {
  let fx = (x - gox) / STEP;
  let fz = (z - goz) / STEP;
  if (fx < 0) fx = 0; else if (fx > GN - 1.001) fx = GN - 1.001;
  if (fz < 0) fz = 0; else if (fz > GN - 1.001) fz = GN - 1.001;
  const i = fx | 0, j = fz | 0;
  const u = fx - i, v = fz - j;
  const k = j * GN + i;
  const h00 = gridH[k], h10 = gridH[k + 1];
  const h01 = gridH[k + GN], h11 = gridH[k + GN + 1];
  return (h00 + u * (h10 - h00)) * (1 - v) + (h01 + u * (h11 - h01)) * v;
}

const GEP = STEP * 0.75;
function gslope(x, z) {
  return Math.hypot(gh(x + GEP, z) - gh(x - GEP, z), gh(x, z + GEP) - gh(x, z - GEP)) / (2 * GEP);
}
const _n = new THREE.Vector3();
function gnormal(x, z) {
  return _n.set(
    gh(x - GEP, z) - gh(x + GEP, z), 2 * GEP,
    gh(x, z - GEP) - gh(x, z + GEP)
  ).normalize();
}

// ---- allocation-free color helpers ----
const _c = new THREE.Color();
const _lit = new THREE.Color();
const _shd = new THREE.Color();
const _hsl = { h: 0, s: 0, l: 0 };
const _tint = new THREE.Color();

/** Watercolor light: warm wash in sun, luminous violet in shade — never mud. */
function paintLight(color, lambert) {
  _lit.copy(color).multiply(SUN).multiplyScalar(0.74 + 0.52 * lambert);
  _shd.copy(color).lerp(SHADOW, 0.5).multiplyScalar(0.86);
  color.copy(_shd).lerp(_lit, Math.pow(lambert, 0.8));
  return color;
}

export function buildTile(tx, tz, F, U, base) {
  const ox = tx * TILE, oz = tz * TILE;
  const rng = mulberry32(tileSeed(tx, tz));
  fillGrid(ox, oz);

  const K = buildTile.density * TILE * TILE / 22500;
  const cnt = (b) => Math.max(0, Math.round(b * K));

  let n = 0;
  const leafSources = [];
  const full = () => n >= PER_TILE_CAP;
  const push = (x, y, z, color, sz, ang, asp, ty, ph, fx = 0) => {
    if (n >= PER_TILE_CAP) return;
    const fo = (base + n) * F_STRIDE;
    F[fo] = x; F[fo + 1] = y; F[fo + 2] = z; F[fo + 3] = sz; F[fo + 4] = ang;
    const uo = (base + n) * U_STRIDE;
    U[uo] = Math.min(255, Math.max(0, color.r * 255) | 0);
    U[uo + 1] = Math.min(255, Math.max(0, color.g * 255) | 0);
    U[uo + 2] = Math.min(255, Math.max(0, color.b * 255) | 0);
    U[uo + 3] = Math.min(255, Math.max(0, asp * 255) | 0);
    U[uo + 4] = ty;
    U[uo + 5] = (ph * 255) & 255;
    U[uo + 6] = Math.min(255, Math.max(0, fx * 255) | 0);
    n++;
  };
  const jitter = (v, h = 0.02, s = 0.08, l = 0.06) => {
    v.getHSL(_hsl);
    v.setHSL(
      (_hsl.h + (rng() - 0.5) * 2 * h + 1) % 1,
      THREE.MathUtils.clamp(_hsl.s + (rng() - 0.5) * 2 * s, 0, 1),
      THREE.MathUtils.clamp(_hsl.l + (rng() - 0.5) * 2 * l, 0.05, 0.97)
    );
    return v;
  };

  const c = _c;
  function groundColor(x, z, h, slope, soilN) {
    if (h < WATER_LEVEL + 0.15) {
      // lakebed / waterline turf: cool teal wash deepening with submersion
      const depth = THREE.MathUtils.clamp((WATER_LEVEL + 0.15 - h) / 2.2, 0, 1);
      c.setHSL(0.45 + depth * 0.06, 0.3 + depth * 0.12, 0.4 - depth * 0.18);
      return c;
    }
    const path = pathMask(x, z);
    if (path > 0.5 && slope < 0.6) c.setHSL(0.075, 0.4, 0.54);
    else if (slope > 0.7) c.setHSL(0.07 + rng() * 0.02, 0.18, 0.48);
    else if (soilN < -0.22) c.setHSL(0.07, 0.28, 0.38 + rng() * 0.05);
    else {
      const meadow = noise.fbm(x * 0.04 + 99, z * 0.04, 3);
      const dry = dryness(x, z, h);
      const hue = THREE.MathUtils.lerp(0.27 + meadow * 0.06, 0.11, dry);
      c.setHSL(hue, THREE.MathUtils.lerp(0.52, 0.44, dry), THREE.MathUtils.lerp(0.44, 0.52, dry));
      c.lerp(_tint.setRGB(0.68, 0.32, 0.22), poppyField(x, z) * 0.25);
    }
    return c;
  }

  // -------- 1) underpainting: contour strokes (grid aligned for seamless tiling) --------
  {
    const GS = 0.885;
    const GR = Math.max(6, Math.round(TILE / GS));
    const cell = TILE / GR;
    for (let gx = 0; gx < GR && !full(); gx++) {
      for (let gz = 0; gz < GR; gz++) {
        const x = ox + (gx + 0.5) * cell + (rng() - 0.5) * cell * 1.1;
        const z = oz + (gz + 0.5) * cell + (rng() - 0.5) * cell * 1.1;
        const h = gh(x, z);
        const nrm = gnormal(x, z);
        const lambert = Math.max(0, nrm.dot(LIGHT));
        groundColor(x, z, h, 1 - nrm.y > 0.36 ? 1 : gslope(x, z), noise.fbm(x * 0.045 + 200, z * 0.045 + 200, 3));
        paintLight(jitter(c), lambert);
        const ang = Math.atan2(nrm.z, nrm.x) + Math.PI / 2 + (rng() - 0.5) * 0.4;
        push(x, h - 0.1, z, c, cell * (3.0 + rng() * 1.4), ang, 0.32 + rng() * 0.14, T_GROUND, rng());
      }
    }
  }

  // -------- 2) broken-color texture strokes --------
  for (let i = cnt(14000); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const h = gh(x, z);
    if (h < WATER_LEVEL - 1.6) continue; // deep water: the pond pass paints it
    const nrm = gnormal(x, z);
    const lambert = Math.max(0, nrm.dot(LIGHT));
    groundColor(x, z, h, gslope(x, z), noise.fbm(x * 0.045 + 200, z * 0.045 + 200, 3));
    jitter(c, 0.045, 0.14, 0.12);
    paintLight(c, lambert);
    const ang = Math.atan2(nrm.z, nrm.x) + Math.PI / 2 + (rng() - 0.5) * 0.9;
    push(x, h + 0.05, z, c, 1.1 + rng() * 1.4, ang, 0.26 + rng() * 0.2, T_GROUND, rng());
  }

  // -------- 3) ponds: water washes, glints, lilies, shore rim --------
  for (let i = cnt(5600); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const h = gh(x, z);
    const depth = WATER_LEVEL - h;
    if (depth < 0.05) continue;
    const dNorm = THREE.MathUtils.smoothstep(depth, 0.05, 2.6);
    const y = WATER_LEVEL + 0.04;

    if (depth < 0.5 && rng() < 0.3) {
      // wet mud rim where pond meets turf
      c.setHSL(0.08, 0.24, 0.3 + rng() * 0.08);
      push(x, WATER_LEVEL + 0.015, z, jitter(c, 0.01, 0.04, 0.05),
        0.5 + rng() * 0.7, rng() * 0.5 - 0.25, 0.3, T_GROUND, rng());
      continue;
    }

    const r = rng();
    if (r < 0.05) {
      // sun glints — small warm sparks that breathe (T_WATER pulses size)
      c.setRGB(1.0, 0.92, 0.66);
      push(x, y + 0.02, z, jitter(c, 0.008, 0.04, 0.05),
        0.18 + rng() * 0.3, rng() * 0.3 - 0.15, 0.5, T_WATER, rng(), 0.85 + rng() * 0.15);
    } else if (r < 0.17) {
      // lavender ripple streak — the sky's violet drinking into the water
      c.setRGB(0.7, 0.7, 0.88);
      push(x, y, z, jitter(c, 0.012, 0.05, 0.06),
        1.2 + rng() * 2.2, rng() * 0.24 - 0.12, 0.09 + rng() * 0.07, T_WATER, rng(), 0.5 + rng() * 0.5);
    } else {
      // body of the water: sky sheen in the shallows, clear cobalt-teal in the
      // middle, green tree reflections near wooded banks
      c.setRGB(0.76, 0.84, 0.9).lerp(_tint.setRGB(0.3, 0.52, 0.62), dNorm * (0.7 + rng() * 0.2));
      const grove = groveField(x, z);
      if (grove > 0.05) c.lerp(_tint.setRGB(0.34, 0.52, 0.42), Math.min(0.35, grove * 1.1) * (1 - dNorm * 0.4));
      push(x, y, z, jitter(c, 0.015, 0.06, 0.05),
        1.3 + rng() * 2.4, rng() * 0.3 - 0.15, 0.1 + rng() * 0.12, T_WATER, rng(), 0.35 + rng() * 0.6);
    }

    // lily pads with occasional blossoms drift in the calm shallows
    if (depth > 0.25 && depth < 1.9 && rng() < 0.16 && !full()) {
      const pads = 1 + (rng() * 2.4 | 0);
      for (let p = 0; p < pads && !full(); p++) {
        const px = x + (rng() - 0.5) * 2.2, pz = z + (rng() - 0.5) * 2.2;
        if (WATER_LEVEL - gh(px, pz) < 0.2) continue;
        c.setHSL(0.31 + rng() * 0.05, 0.4, 0.3 + rng() * 0.12);
        if (rng() < 0.4) c.lerp(_tint.setRGB(0.62, 0.7, 0.5), 0.3); // sunlit pad
        push(px, WATER_LEVEL + 0.07, pz, jitter(c, 0.012, 0.05, 0.05),
          0.42 + rng() * 0.5, rng() * 0.4 - 0.2, 0.26 + rng() * 0.1, T_WATER, rng(), 0.1);
        if (rng() < 0.34 && !full()) {
          const blush = rng();
          if (blush < 0.55) c.setRGB(0.98, 0.92, 0.94); else c.setRGB(0.95, 0.7, 0.78);
          push(px + (rng() - 0.5) * 0.2, WATER_LEVEL + 0.14, pz + (rng() - 0.5) * 0.2,
            jitter(c, 0.01, 0.05, 0.03), 0.2 + rng() * 0.14, rng() * Math.PI, 0.62, T_GROUND, rng());
          c.setRGB(0.99, 0.85, 0.4);
          push(px, WATER_LEVEL + 0.18, pz, c, 0.08, 0, 0.8, T_GROUND, rng());
        }
      }
    }
  }

  // reeds & irises along the banks
  for (let i = cnt(760); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const h = gh(x, z);
    if (h < WATER_LEVEL - 0.55 || h > WATER_LEVEL + 0.75) continue;
    const yBase = Math.max(h, WATER_LEVEL);
    c.setHSL(0.26 + rng() * 0.08, 0.4, 0.3 + rng() * 0.14);
    push(x, yBase + 0.55 + rng() * 0.35, z, jitter(c, 0.02, 0.08, 0.07),
      1.0 + rng() * 0.9, Math.PI / 2 + (rng() - 0.5) * 0.4, 0.11, T_GRASS, rng(), 0.55 + rng() * 0.4);
    if (rng() < 0.16 && !full()) {
      // Monet's irises: violet flags at the waterline
      c.setHSL(0.74 + rng() * 0.04, 0.5, 0.52 + rng() * 0.1);
      push(x + (rng() - 0.5) * 0.3, yBase + 0.95 + rng() * 0.3, z + (rng() - 0.5) * 0.3,
        jitter(c, 0.012, 0.06, 0.06), 0.22 + rng() * 0.16, rng() * Math.PI, 0.7, T_GRASS, rng(), 0.4);
    }
  }

  // -------- 4) grass --------
  for (let i = cnt(28000); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const h = gh(x, z);
    if (h > 32 || h < WATER_LEVEL + 0.12) continue;
    if (gslope(x, z) > 0.55) continue;
    if (pathMask(x, z) > 0.55) continue;
    const lambert = Math.max(0, 0.72 + (rng() - 0.5) * 0.3);
    const dry = dryness(x, z, h);
    const hue = THREE.MathUtils.lerp(0.25 + noise.fbm(x * 0.05 + 99, z * 0.05, 3) * 0.07, 0.11, dry);
    c.setHSL(hue, THREE.MathUtils.lerp(0.55, 0.48, dry), 0.45 + rng() * 0.14 + dry * 0.06);
    c.lerp(_tint.setRGB(0.72, 0.38, 0.24), poppyField(x, z) * 0.2);
    jitter(c, 0.03, 0.12, 0.1);
    paintLight(c, lambert);
    const ang = Math.PI / 2 + (rng() - 0.5) * 0.7;
    const tall = 0.8 + rng() * 1.0 + dry * 0.4;
    push(x, h + 0.25 + rng() * 0.3, z, c, tall, ang, 0.16, T_GRASS, rng(), 0.6 + rng() * 0.4);
  }

  // -------- 5) poppies + wildflowers (with Monet's cornflower blue) --------
  for (let i = cnt(8000); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const h = gh(x, z);
    if (h > 24 || h < WATER_LEVEL + 0.2) continue;
    if (gslope(x, z) > 0.45) continue;
    const pf = poppyField(x, z);
    if (rng() > pf * 0.95) continue;
    c.setHSL(0.005 + rng() * 0.03, 0.78, 0.52 + rng() * 0.12);
    push(x, h + 0.4 + rng() * 0.25, z, jitter(c, 0.012, 0.05, 0.06),
      0.28 + rng() * 0.2, rng() * Math.PI, 0.8, T_GRASS, rng(), 0.3 + rng() * 0.3);
    if (rng() < 0.2) {
      c.setHSL(0.95, 0.45, 0.22);
      push(x, h + 0.42, z, c, 0.1, 0, 0.9, T_GRASS, rng(), 0.3);
    }
  }
  for (let i = cnt(2600); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const h = gh(x, z);
    if (h > 22 || h < WATER_LEVEL + 0.2) continue;
    if (gslope(x, z) > 0.4) continue;
    if (noise.fbm(x * 0.07 + 17, z * 0.07 + 17, 2) < 0.08) continue;
    const p = rng();
    if (p < 0.3) c.setHSL(0.12, 0.85, 0.64);
    else if (p < 0.52) c.setHSL(0.6 + rng() * 0.03, 0.55, 0.6);   // cornflower
    else if (p < 0.76) c.setHSL(0.75, 0.42, 0.68);
    else c.setHSL(0.0, 0.0, 0.95);
    push(x, h + 0.45, z, jitter(c), 0.3 + rng() * 0.22, rng() * Math.PI, 0.85, T_GRASS, rng(), 0.3 + rng() * 0.3);
  }

  // -------- 6) path detail --------
  for (let i = cnt(2800); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const m = pathMask(x, z);
    if (m < 0.25) continue;
    const h = gh(x, z);
    if (h < WATER_LEVEL + 0.15 || gslope(x, z) > 0.5) continue;
    if (m > 0.6 && rng() < 0.5) {
      c.setHSL(0.08 + rng() * 0.03, 0.16, 0.48 + rng() * 0.22);
      push(x, h + 0.12, z, jitter(c, 0.01, 0.03, 0.06), 0.25 + rng() * 0.3, rng() * Math.PI, 0.7, T_GROUND, rng());
    } else {
      c.setHSL(0.085, 0.3, 0.5);
      push(x, h + 0.08, z, jitter(c), 0.8 + rng() * 0.8, rng() * Math.PI, 0.34, T_GROUND, rng());
    }
  }

  // -------- 7) boulders --------
  for (let r = cnt(26); r > 0 && !full(); r--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const h = gh(x, z);
    if (h < WATER_LEVEL + 0.3) continue;
    if (gslope(x, z) < 0.25 && rng() < 0.7) continue;
    const R = 0.8 + rng() * 2.4;
    const dabs = (10 + R * 9) | 0;
    const baseHue = 0.08 + rng() * 0.04;
    for (let i = 0; i < dabs && !full(); i++) {
      const a = rng() * Math.PI * 2;
      const rr = Math.pow(rng(), 0.6) * R;
      const dy = (rng() * 0.9) * R * 0.7;
      const topness = dy / (R * 0.7);
      if (topness < 0.25 && rng() < 0.4) c.setHSL(0.3, 0.32, 0.34);
      else {
        c.setHSL(baseHue, 0.12 + rng() * 0.05, 0.44 + topness * 0.3);
        c.lerp(SUN, topness * 0.3);
        c.lerp(SHADOW, (1 - topness) * 0.3);
      }
      push(x + Math.cos(a) * rr, h + dy, z + Math.sin(a) * rr, jitter(c, 0.01, 0.04, 0.05),
        0.6 + rng() * 0.8 * R * 0.5, rng() * Math.PI, 0.55 + rng() * 0.3, T_GROUND, rng());
    }
  }

  // -------- 8) forest --------
  function shadowPool(x, z, R) {
    const dabs = (5 + R * 4) | 0;
    for (let i = 0; i < dabs && !full(); i++) {
      const a = rng() * Math.PI * 2;
      const rr = Math.sqrt(rng()) * R;
      const px = x + Math.cos(a) * rr - LIGHT.x * R * 0.4;
      const pz = z + Math.sin(a) * rr - LIGHT.z * R * 0.4;
      const ph = gh(px, pz);
      c.setHSL(0.68, 0.28, 0.34 + rng() * 0.06);
      c.lerp(_tint.setRGB(0.24, 0.36, 0.3), 0.42);
      push(px, ph + 0.06, pz, c, 1.4 + rng() * 1.5, rng() * Math.PI, 0.4, T_GROUND, rng());
    }
  }
  function trunkRun(x, z, h, height, leanA, leanM, hue, sat, lum, fleck) {
    for (let i = 0; i < 3 && !full(); i++) {
      const a = rng() * Math.PI * 2;
      c.setHSL(hue, sat, lum * 0.7);
      push(x + Math.cos(a) * 0.35, h + 0.15, z + Math.sin(a) * 0.35, jitter(c, 0.01, 0.04, 0.02), 0.5, a, 0.4, T_GROUND, rng());
    }
    const segs = (6 + height) | 0;
    for (let i = 0; i < segs && !full(); i++) {
      const t = i / segs;
      const lx = Math.cos(leanA) * leanM * t * t;
      const lz = Math.sin(leanA) * leanM * t * t;
      c.setHSL(hue, sat, lum + t * 0.1);
      c.lerp(SUN, t * 0.15);
      jitter(c, 0.01, 0.05, 0.03);
      push(x + lx + (rng() - 0.5) * 0.1, h + t * height, z + lz + (rng() - 0.5) * 0.1,
        c, 0.55 - t * 0.22, Math.PI / 2 + (rng() - 0.5) * 0.25, 0.28, T_GROUND, rng(), t * 0.15);
      if (fleck && rng() < 0.5) {
        c.setHSL(0.07, 0.2, 0.18);
        push(x + lx + (rng() - 0.5) * 0.15, h + t * height + (rng() - 0.5) * 0.3, z + lz + (rng() - 0.5) * 0.15,
          c, 0.16, (rng() - 0.5) * 0.4, 0.4, T_GROUND, rng());
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
      c.setHSL(hueBase + 0.04, 0.46, 0.27 + rng() * 0.05);
      c.lerp(SHADOW, 0.26);
      push(cx + sq * Math.cos(a) * rr, cy + u * rr * 0.8, cz + sq * Math.sin(a) * rr,
        jitter(c, 0.015, 0.06, 0.04), 0.9 + rng() * 0.9, rng() * Math.PI,
        0.55 + rng() * 0.3, T_FOLIAGE, rng(), flexBase * 0.3);
    }
    for (let i = 0; i < count && !full(); i++) {
      const u = rng() * 2 - 1, a = rng() * Math.PI * 2;
      const rr = (0.55 + 0.45 * Math.pow(rng(), 0.35)) * R;
      const sq = Math.sqrt(1 - u * u);
      const dx = sq * Math.cos(a) * rr, dz = sq * Math.sin(a) * rr, dy = u * rr * 0.8;
      const lam = THREE.MathUtils.clamp((dx * LIGHT.x + dy * LIGHT.y + dz * LIGHT.z) / (rr + 0.001) * 0.5 + 0.55, 0, 1);
      c.setHSL(hueBase + (rng() - 0.5) * 0.04, airy ? 0.56 : 0.5, airy ? 0.45 : 0.39);
      jitter(c, 0.03, 0.1, 0.08);
      paintLight(c, lam);
      const edge = rr / (R + 0.001);
      const tangent = Math.atan2(dz, dx) + Math.PI / 2;
      push(cx + dx, cy + dy, cz + dz, c, 0.7 + rng() * 0.9, tangent + (rng() - 0.5) * 0.8,
        0.4 + rng() * 0.3, T_FOLIAGE, rng(), Math.min(1, flexBase * (0.4 + 0.6 * edge)));
      if (lam > 0.8 && rng() < 0.18) {
        c.setHSL(0.13, 0.85, 0.75);
        push(cx + dx * 1.04, cy + dy * 1.04, cz + dz * 1.04, c,
          0.3 + rng() * 0.2, tangent, 0.7, T_FOLIAGE, rng(), Math.min(1, flexBase));
      }
    }
  }
  function fern(x, z, h) {
    const fronds = (4 + rng() * 3) | 0;
    for (let i = 0; i < fronds && !full(); i++) {
      const a = rng() * Math.PI * 2;
      const len = 0.5 + rng() * 0.5;
      c.setHSL(0.34, 0.45, 0.28 + rng() * 0.08);
      push(x + Math.cos(a) * len * 0.6, h + 0.3 + rng() * 0.25, z + Math.sin(a) * len * 0.6,
        jitter(c, 0.015, 0.06, 0.04), 0.8 + rng() * 0.5,
        Math.PI / 2 + (rng() - 0.5) * 1.4, 0.16, T_GRASS, rng(), 0.5 + rng() * 0.3);
    }
  }

  let trees = 0;
  const leafSpots = [];
  const treeTarget = cnt(150), treeAttempts = cnt(1500);
  for (let attempt = 0; attempt < treeAttempts && trees < treeTarget && !full(); attempt++) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const h = gh(x, z);
    if (h > 24 || h < WATER_LEVEL + 0.6) continue;
    if (gslope(x, z) > 0.6) continue;
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
      leafSources.push({ x: tipX, z: tipZ, y: h + height * 1.02, hue: hueBase });
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
      c.setHSL(hueBase, 0.42, 0.48); c.lerp(SUN, 0.25);
      push(x, h + height * 1.04, z, c, 0.6, Math.PI / 2, 0.35, T_FOLIAGE, rng(), 0.9);
      leafSources.push({ x, z, y: h + height * 0.78, hue: hueBase });
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
      leafSources.push({ x: tipX, z: tipZ, y: h + height * 1.04, hue: hueBase });
      if (rng() < 0.75) leafSpots.push({ x, z, y: h + height, hue: hueBase });
    }

    const under = (1 + rng() * 3) | 0;
    for (let u = 0; u < under && !full(); u++) {
      const a = rng() * Math.PI * 2;
      const rr = 1.5 + rng() * 3.5;
      const ux = x + Math.cos(a) * rr, uz = z + Math.sin(a) * rr;
      const uh = gh(ux, uz);
      if (uh < WATER_LEVEL + 0.2) continue;
      if (rng() < 0.7) fern(ux, uz, uh);
      else {
        const sh = 1 + rng() * 1.2;
        c.setHSL(0.07, 0.38, 0.2);
        push(ux, uh + sh * 0.3, uz, c, 0.3, Math.PI / 2, 0.25, T_GROUND, rng());
        canopyClump(ux, uh + sh, uz, 0.5 + rng() * 0.3, 0.28 + rng() * 0.06, 6, 0.9, false);
      }
    }
  }

  // loose ferns + settled leaves soften the meadow
  for (let i = cnt(420); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    if (groveField(x, z) < 0.12) continue;
    const h = gh(x, z);
    if (h > 24 || h < WATER_LEVEL + 0.2 || gslope(x, z) > 0.5) continue;
    fern(x, z, h);
  }
  for (const spot of leafSpots) {
    const count = (3 + rng() * 4) | 0;
    for (let i = 0; i < count && !full(); i++) {
      c.setHSL((spot.hue + 0.04 - rng() * 0.2 + 1) % 1, 0.58, 0.5 + rng() * 0.15);
      push(spot.x + (rng() - 0.5) * 9, spot.y - rng() * spot.y * 0.5, spot.z + (rng() - 0.5) * 9,
        jitter(c, 0.02, 0.08, 0.06), 0.28 + rng() * 0.24, rng() * Math.PI, 0.45, T_LEAF, rng(), 0.5 + rng() * 0.5);
    }
  }

  // -------- 9) shrubs --------
  for (let i = cnt(92); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const h = gh(x, z);
    if (h > 26 || h < WATER_LEVEL + 0.4) continue;
    if (gslope(x, z) > 0.5 || pathMask(x, z) > 0.4) continue;
    const R = 0.7 + rng() * 1.0;
    shadowPool(x, z, R * 0.8);
    const hueBase = 0.25 + rng() * 0.1;
    canopyClump(x, h + R * 0.6, z, R, hueBase, (7 + R * 6) | 0, 0.5, false);
    leafSources.push({ x, z, y: h + R * 1.1, hue: hueBase });
  }

  // -------- 10) the occasional cottage --------
  if (rng() < 0.1 && !full()) {
    let bx = 0, bz = 0, found = false;
    for (let i = 0; i < 1200 && !found; i++) {
      const x = ox + rng() * TILE, z = oz + rng() * TILE;
      const m = pathMask(x, z);
      if (m > 0.15 && m < 0.45 && gslope(x, z) < 0.18) {
        const h = gh(x, z);
        if (h > 2 && h < 22) { bx = x; bz = z; found = true; }
      }
    }
    if (found) {
      const h = gh(bx, bz);
      const W = 3.2, D = 2.6, WH = 2.2;
      const faceLam = (nx, nz) => Math.max(0.2, nx * LIGHT.x + nz * LIGHT.z + 0.45);
      for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const lam = faceLam(nx, nz);
        for (let i = 0; i < 26 && !full(); i++) {
          const t = rng() * 2 - 1, y = rng() * WH;
          const px = bx + nx * W * 0.5 + (nz !== 0 ? t * W * 0.5 : 0);
          const pz = bz + nz * D * 0.5 + (nx !== 0 ? t * D * 0.5 : 0);
          c.setHSL(0.09, 0.28, 0.68);
          jitter(c, 0.01, 0.04, 0.05);
          paintLight(c, lam);
          push(px, h + 0.3 + y, pz, c, 0.55 + rng() * 0.4, (rng() - 0.5) * 0.4, 0.45, T_GROUND, rng());
        }
      }
      for (let sgn = -1; sgn <= 1; sgn += 2) {
        const lam = Math.max(0.25, sgn * 0.4 * LIGHT.x + 0.7 * LIGHT.y);
        for (let i = 0; i < 30 && !full(); i++) {
          const t = rng(), u = rng() * 2 - 1;
          c.setHSL(0.015, 0.42, 0.4); // madder-rose roof
          jitter(c, 0.012, 0.06, 0.05);
          paintLight(c, lam);
          push(bx + sgn * (1 - t) * W * 0.32, h + WH + 0.2 + t * 1.5, bz + u * D * 0.55,
            c, 0.7 + rng() * 0.5, 0.15 * sgn + (rng() - 0.5) * 0.3, 0.4, T_GROUND, rng());
        }
      }
      c.setRGB(1.0, 0.8, 0.35);
      push(bx + W * 0.51, h + 1.3, bz - D * 0.12, c, 0.45, 0, 0.7, T_GROUND, rng());
      for (let i = 0; i < 14 && !full(); i++) {
        c.setHSL(0.08, 0.14, 0.85);
        push(bx - W * 0.2, h + WH + 2.4, bz + D * 0.2, c, 0.7 + rng() * 0.5,
          rng() * Math.PI, 0.55, T_SMOKE, rng(), 0.5 + rng() * 0.5);
      }
    }
  }

  // -------- 11) deer --------
  let deerCount = 0;
  for (let attempt = 0; attempt < cnt(60) && deerCount < 2 && !full(); attempt++) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const g = groveField(x, z);
    if (g < 0.0 || g > 0.12) continue;
    const h = gh(x, z);
    if (h < WATER_LEVEL + 0.8 || h > 20 || gslope(x, z) > 0.25) continue;
    deerCount++;
    const facing = rng() * Math.PI * 2;
    const fx = Math.cos(facing), fz = Math.sin(facing);
    _tint.setHSL(0.07, 0.4, 0.44 + rng() * 0.08);
    for (let i = 0; i < 5; i++) {
      const t = (i / 4 - 0.5) * 1.3;
      c.copy(_tint); jitter(c, 0.01, 0.05, 0.05); paintLight(c, 0.75);
      push(x + fx * t, h + 1.05 + Math.sin(t * 2) * 0.06, z + fz * t,
        c, 0.62 - Math.abs(t) * 0.15, facing, 0.5, T_GROUND, rng());
    }
    c.copy(_tint); paintLight(c, 0.7);
    push(x + fx * 0.85, h + 0.95, z + fz * 0.85, c, 0.4, facing + 0.9, 0.32, T_GROUND, rng());
    c.copy(_tint); paintLight(c, 0.65);
    push(x + fx * 1.15, h + 0.55, z + fz * 1.15, c, 0.3, facing + 0.6, 0.45, T_GROUND, rng());
    c.setHSL(0.07, 0.36, 0.26);
    for (const [lt, ls] of [[-0.5, -0.18], [-0.5, 0.18], [0.45, -0.18], [0.45, 0.18]]) {
      push(x + fx * lt - fz * ls, h + 0.5, z + fz * lt + fx * ls, c, 0.55, Math.PI / 2, 0.1, T_GROUND, rng());
    }
    c.setRGB(0.94, 0.92, 0.88);
    push(x - fx * 0.75, h + 1.15, z - fz * 0.75, c, 0.16, facing, 0.6, T_GROUND, rng());
  }

  // -------- 12) butterflies, dragonflies + swallows --------
  for (let i = cnt(24); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    const h = gh(x, z);
    if (h > 20 || groveField(x, z) > 0.15) continue;
    const overWater = h < WATER_LEVEL + 0.4;
    if (overWater) c.setHSL(0.5 + rng() * 0.05, 0.55, 0.62); // dragonfly over the pond
    else if (rng() < 0.5) c.setHSL(0.12, 0.8, 0.72);
    else c.setHSL(0.0, 0.0, 0.96);
    const yBase = Math.max(h, WATER_LEVEL);
    push(x, yBase + (overWater ? 0.9 : 1.2) + rng() * 1.6, z, jitter(c, 0.02, 0.05, 0.04),
      0.22 + rng() * 0.14, rng() * Math.PI, overWater ? 0.3 : 0.55, T_FLY, rng(), 0.5 + rng() * 0.5);
  }
  for (let i = cnt(3); i > 0 && !full(); i--) {
    const x = ox + rng() * TILE, z = oz + rng() * TILE;
    c.setHSL(0.64, 0.2, 0.32);
    push(x, gh(x, z) + 26 + rng() * 14, z, c, 0.5 + rng() * 0.25,
      rng() * Math.PI, 0.22, T_BIRD, rng(), 0.4 + rng() * 0.6);
  }

  return { count: n, leafSources };
}

// User-tunable stroke density (the orchestrator may adjust it live).
buildTile.density = 0.86;
