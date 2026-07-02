import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import {
  F_STRIDE, WATER_LEVEL,
  T_GROUND, T_FOLIAGE, T_GRASS, T_FLY, T_WATER,
} from './config.js';
import { heightAt } from './terrain.js';
import { makeSplatGeometry, writeSplat } from './splatBuffers.js';

// Allogamy itself: pollen the crane stirs up settles on the ground and GROWS.
// Each settled grain becomes a plant — flower clusters, grass tufts, ferns,
// flowering shrubs, little saplings, and water lilies when it lands on a pond.
// Plants live in a fixed ring of dab slots (oldest quietly recycled far behind
// you) and sprout with a soft overshoot ease, rising out of the ground.

const PLANTS = 720;
const DABS_PER = 10;
const TOTAL = PLANTS * DABS_PER;
const GROW_SECONDS = 1.6;

// petal watercolor set: poppy rose, buttercup, cornflower, lavender, white, blush
const PETALS = [
  [0.85, 0.3, 0.26], [0.96, 0.82, 0.3], [0.45, 0.56, 0.86],
  [0.75, 0.64, 0.9], [0.97, 0.96, 0.9], [0.94, 0.66, 0.72],
];

function easeOutBack(k) {
  const c1 = 1.70158, c3 = c1 + 1;
  const p = k - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
}
function easeOut(k) { return 1 - (1 - k) * (1 - k); }

export function createBloomSystem(material, onPlant) {
  const { geo, F, U, fb, ub } = makeSplatGeometry(TOTAL, { dynamicF: true, dynamicU: true });
  geo.setDrawRange(0, TOTAL);
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;

  const rnd = mulberry32(0xb100f5);
  const targetSize = new Float32Array(TOTAL); // final dab size after growth
  const y0 = new Float32Array(TOTAL);         // sprout start height
  const y1 = new Float32Array(TOTAL);         // final height
  const pending = [];                          // seeds waiting to sprout
  const active = [];                           // plants currently growing
  let cursor = 0;
  let total = 0;

  const col = new THREE.Color();
  const dab = (i, x, y, z, size, angle, aspect, type, flex, rise) => {
    // written with size 0 — growth animates toward targetSize from y0 up to y
    writeSplat(F, U, i, x, y, z, col.r, col.g, col.b, 0, angle, aspect, type, rnd(), flex);
    targetSize[i] = size;
    y1[i] = y;
    y0[i] = y - rise;
    F[i * F_STRIDE + 1] = y0[i];
  };
  const tint = (arr, dl = 0) => {
    col.setRGB(arr[0], arr[1], arr[2]);
    col.offsetHSL((rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.06 + dl);
    return col;
  };

  function plant(x, z) {
    const h = heightAt(x, z);
    const onWater = h < WATER_LEVEL - 0.12;
    const ground = Math.max(h, WATER_LEVEL);
    const slot = cursor++ % PLANTS;
    const base = slot * DABS_PER;

    // if this slot is still growing from a previous life, retire that record
    for (let a = active.length - 1; a >= 0; a--) {
      if (active[a].base === base) active.splice(a, 1);
    }
    for (let j = 0; j < DABS_PER; j++) {
      targetSize[base + j] = 0;
      F[(base + j) * F_STRIDE + 3] = 0;
    }

    let n = 0;
    const petal = PETALS[(rnd() * PETALS.length) | 0];

    if (onWater) {
      // ---- water lily ----
      const pads = 1 + (rnd() * 2 | 0);
      for (let p = 0; p < pads; p++) {
        const px = x + (rnd() - 0.5) * 0.9, pz = z + (rnd() - 0.5) * 0.9;
        tint([0.3, 0.5, 0.3], rnd() * 0.08);
        dab(base + n++, px, ground + 0.07, pz, 0.5 + rnd() * 0.4,
          rnd() * 0.4 - 0.2, 0.28, T_WATER, 0.1, 0.02);
      }
      tint(rnd() < 0.5 ? [0.97, 0.93, 0.95] : [0.95, 0.7, 0.78]);
      dab(base + n++, x, ground + 0.16, z, 0.34 + rnd() * 0.14, rnd() * Math.PI, 0.6, T_GROUND, 0, 0.1);
      col.setRGB(0.99, 0.85, 0.4);
      dab(base + n++, x, ground + 0.21, z, 0.11, 0, 0.8, T_GROUND, 0, 0.1);
    } else {
      const kind = rnd();
      if (kind < 0.5) {
        // ---- wildflower cluster ----
        const stems = 2 + (rnd() * 2 | 0);
        for (let s = 0; s < stems && n < DABS_PER - 1; s++) {
          const px = x + (rnd() - 0.5) * 0.8, pz = z + (rnd() - 0.5) * 0.8;
          const tallness = 0.6 + rnd() * 0.45;
          tint([0.3, 0.55, 0.3], -0.05);
          dab(base + n++, px, ground + tallness * 0.55, pz, 0.55 + rnd() * 0.25,
            Math.PI / 2 + (rnd() - 0.5) * 0.3, 0.12, T_GRASS, 0.4 + rnd() * 0.3, tallness * 0.5);
          tint(petal);
          dab(base + n++, px + (rnd() - 0.5) * 0.06, ground + tallness, pz + (rnd() - 0.5) * 0.06,
            0.36 + rnd() * 0.18, rnd() * Math.PI, 0.82, T_GRASS, 0.3, tallness * 0.7);
          if (s === 0 && n < DABS_PER) {
            col.setRGB(0.98, 0.85, 0.3);
            dab(base + n++, px, ground + tallness + 0.02, pz, 0.11, 0, 0.85, T_GRASS, 0.3, tallness * 0.7);
          }
        }
      } else if (kind < 0.68) {
        // ---- grass tuft ----
        for (let s = 0; s < 6 && n < DABS_PER; s++) {
          tint([0.45, 0.62, 0.28], rnd() * 0.1);
          dab(base + n++, x + (rnd() - 0.5) * 0.5, ground + 0.35 + rnd() * 0.3, z + (rnd() - 0.5) * 0.5,
            0.6 + rnd() * 0.5, Math.PI / 2 + (rnd() - 0.5) * 0.8, 0.13, T_GRASS,
            0.55 + rnd() * 0.4, 0.4);
        }
      } else if (kind < 0.8) {
        // ---- fern sprig ----
        for (let s = 0; s < 5 && n < DABS_PER; s++) {
          const a = rnd() * Math.PI * 2, len = 0.4 + rnd() * 0.4;
          tint([0.28, 0.48, 0.3], rnd() * 0.06);
          dab(base + n++, x + Math.cos(a) * len * 0.6, ground + 0.28 + rnd() * 0.2, z + Math.sin(a) * len * 0.6,
            0.7 + rnd() * 0.4, Math.PI / 2 + (rnd() - 0.5) * 1.4, 0.15, T_GRASS, 0.5, 0.3);
        }
      } else if (kind < 0.93) {
        // ---- flowering shrub ----
        for (let s = 0; s < 4 && n < DABS_PER; s++) {
          const a = rnd() * Math.PI * 2, rr = rnd() * 0.4;
          tint([0.3, 0.52, 0.28], rnd() * 0.08);
          dab(base + n++, x + Math.cos(a) * rr, ground + 0.35 + rnd() * 0.3, z + Math.sin(a) * rr,
            0.55 + rnd() * 0.35, rnd() * Math.PI, 0.5, T_FOLIAGE, 0.4, 0.35);
        }
        for (let s = 0; s < 4 && n < DABS_PER; s++) {
          const a = rnd() * Math.PI * 2, rr = 0.25 + rnd() * 0.3;
          tint(petal, 0.06);
          dab(base + n++, x + Math.cos(a) * rr, ground + 0.5 + rnd() * 0.3, z + Math.sin(a) * rr,
            0.2 + rnd() * 0.12, rnd() * Math.PI, 0.7, T_FOLIAGE, 0.5, 0.4);
        }
      } else {
        // ---- little sapling ----
        tint([0.42, 0.3, 0.2]);
        dab(base + n++, x, ground + 0.35, z, 0.5, Math.PI / 2, 0.16, T_GROUND, 0.05, 0.35);
        dab(base + n++, x + (rnd() - 0.5) * 0.05, ground + 0.75, z + (rnd() - 0.5) * 0.05,
          0.4, Math.PI / 2 + (rnd() - 0.5) * 0.2, 0.14, T_GROUND, 0.1, 0.6);
        for (let s = 0; s < 5 && n < DABS_PER; s++) {
          const a = rnd() * Math.PI * 2, rr = rnd() * 0.45;
          tint([0.34, 0.56, 0.3], rnd() * 0.08);
          dab(base + n++, x + Math.cos(a) * rr, ground + 1.0 + rnd() * 0.4, z + Math.sin(a) * rr,
            0.5 + rnd() * 0.3, rnd() * Math.PI, 0.55, T_FOLIAGE, 0.55, 0.9);
        }
        for (let s = 0; s < 2 && n < DABS_PER; s++) {
          tint(petal, 0.08);
          dab(base + n++, x + (rnd() - 0.5) * 0.7, ground + 1.1 + rnd() * 0.35, z + (rnd() - 0.5) * 0.7,
            0.18, rnd() * Math.PI, 0.7, T_FOLIAGE, 0.6, 0.9);
        }
      }
      // sometimes a butterfly finds the new flowers
      if (rnd() < 0.08 && n < DABS_PER) {
        col.setRGB(0.97, 0.9, 0.55);
        if (rnd() < 0.4) col.setRGB(0.96, 0.96, 0.98);
        dab(base + n++, x, ground + 1.1, z, 0.22, rnd() * Math.PI, 0.55, T_FLY, 0.6, 0.6);
      }
    }

    // mark the whole slot for upload (u8 side just changed too)
    fb.addUpdateRange(base * F_STRIDE, DABS_PER * F_STRIDE);
    ub.addUpdateRange(base * 8, DABS_PER * 8);
    fb.needsUpdate = true;
    ub.needsUpdate = true;

    active.push({ base, n, birth: performance.now() * 0.001 });
    total++;
    if (onPlant) onPlant(x, ground, z, onWater);
  }

  return {
    points,
    get total() { return total; },
    queueSeed(x, z) {
      if (pending.length < 64) pending.push(x, z);
    },
    update(now) {
      fb.clearUpdateRanges();
      ub.clearUpdateRanges();
      let planted = 0;
      while (pending.length && planted < 2) {
        const z = pending.pop(), x = pending.pop();
        plant(x, z);
        planted++;
      }
      let dirty = planted > 0;
      for (let a = active.length - 1; a >= 0; a--) {
        const p = active[a];
        const k = (now - p.birth) / GROW_SECONDS;
        const done = k >= 1;
        const es = done ? 1 : easeOutBack(Math.max(0, k));
        const ey = done ? 1 : easeOut(Math.max(0, Math.min(1, k * 1.15)));
        for (let j = 0; j < p.n; j++) {
          const i = p.base + j;
          const fo = i * F_STRIDE;
          F[fo + 3] = targetSize[i] * es;
          F[fo + 1] = y0[i] + (y1[i] - y0[i]) * ey;
        }
        fb.addUpdateRange(p.base * F_STRIDE, DABS_PER * F_STRIDE);
        dirty = true;
        if (done) active.splice(a, 1);
      }
      if (dirty) fb.needsUpdate = true;
    },
    reset() {
      pending.length = 0;
      active.length = 0;
      targetSize.fill(0);
      for (let i = 0; i < TOTAL; i++) F[i * F_STRIDE + 3] = 0;
      fb.clearUpdateRanges();
      fb.needsUpdate = true;
      total = 0;
    },
  };
}
