import * as THREE from 'three/webgpu';
import { mulberry32, hash2 } from '../core/rng';
import { palette } from '../render/palette';
import { TerrainField } from './TerrainField';
import { CHUNK_SIZE, WORLD_SEED, SUN_DIR } from '../config';

// Undergrowth & ground texture — the plush layer between the turf carpet and the
// bushes. Tall-grass tufts, weeds, clover, ferns, and (in low damp hollows) reeds,
// scattered as painterly splats sitting just above the turf. MOSTLY round raised
// flecks (aspect ≈ 1) so the ground reads as lush and densely planted, PLUS a
// minority of upright stems/blades/fronds with mild elongation (aspect ~1.5..2.5)
// swaying in the wind for vertical interest — never a wall of blades.
//
// Like tree.ts, lighting is BAKED into per-splat HSL: a `lit` term from the
// surface normal·sun (matching the turf in Chunk.ts) warms sunlit cover toward
// lime and deepens shade toward saturated blue-green, with occasional warm dry
// seed-head tips. Output mirrors the foliage attribute contract so Chunk.ts can
// feed it straight into buildSplatGeometry + the shared splat material.
//
// Cost control: heavy field.surface() (does the normal central-difference) is
// evaluated ONCE per placement candidate on a coarse grid — never per dab — and a
// tuft expands into several cheap dabs around that point. Counts are bounded by
// the grid resolution, so a chunk's weed budget is fixed regardless of density.

// Normalised sun direction, matching Chunk.ts so weeds shade identically to turf.
const _sun = new THREE.Vector3(...SUN_DIR).normalize();
const SUNX = _sun.x, SUNY = _sun.y, SUNZ = _sun.z;

const clamp = THREE.MathUtils.clamp;
const smoothstep = THREE.MathUtils.smoothstep;
const _col = new THREE.Color();

// Ground shadows fall away from the sun (cf. tree.ts): drag a few flat dabs along
// this azimuth so upright tufts feel rooted, not floating.
const SHADOW_ANGLE = Math.atan2(0.778, 0.627);

export interface ChunkWeeds {
  centers: Float32Array;
  scales: Float32Array;
  colors: Float32Array;
  winds: Float32Array;
  angles: Float32Array;
  aspects: Float32Array;
}

/**
 * Light-coupled undergrowth green. `lit` (0 deep shade .. 1 full sun) drives hue
 * AND lightness exactly like tree.ts foliage, so weeds sit in the same family as
 * the turf and canopies: sunlit warm lime → shaded deep blue-green, never black.
 * `damp` cools/saturates the green a touch for reeds & hollow growth; `dry` warms
 * it toward seed-head straw.
 */
function weedGreen(rnd: () => number, lit: number, damp: number, dry: number): THREE.Color {
  const h = 0.33 - lit * 0.11 - damp * 0.02 + dry * 0.06 + (rnd() - 0.5) * 0.03;
  const s = 0.56 + (1 - lit) * 0.12 + damp * 0.05 + rnd() * 0.06;
  const l = 0.16 + lit * 0.44 + (rnd() - 0.5) * 0.07;
  return _col.setHSL(clamp(h, 0, 1), clamp(s, 0, 1), clamp(l, 0.05, 0.95)).clone();
}

/** Warm dry seed-head / dead-tip straw, lifted by light. */
function seedHead(rnd: () => number, lit: number): THREE.Color {
  // hot lime-straw between fresh grass and the dry-patch override in Chunk.ts
  const h = 0.16 + (rnd() - 0.5) * 0.03;
  const s = 0.62 + rnd() * 0.16;
  const l = 0.5 + lit * 0.16 + (rnd() - 0.5) * 0.06;
  return _col.setHSL(clamp(h, 0, 1), clamp(s, 0, 1), clamp(l, 0.1, 0.95)).clone();
}

/**
 * Scatter undergrowth across one chunk and bake it into merged splat arrays.
 * Denser near low elevations, path edges, and the woodland floor; reads as lush
 * plush ground cover. Returns null when a chunk ends up empty (e.g. all rock).
 * SEEDED & deterministic — same chunk regenerates identically.
 */
export function scatterWeeds(field: TerrainField, cx: number, cz: number): ChunkWeeds | null {
  const S = CHUNK_SIZE;
  const ox = cx * S;
  const oz = cz * S;
  // Own rng stream (unique XOR) so weed layout can't shift turf / tree / rock layout.
  const rnd = mulberry32(hash2(cx, cz, (WORLD_SEED ^ 0x5eed1e) >>> 0));

  const cen: number[] = [], scl: number[] = [], col: number[] = [];
  const wnd: number[] = [], ang: number[] = [], asp: number[] = [];
  let placed = 0;

  // Stamp a small cluster of round raised flecks (a leafy tuft / clover patch)
  // hugging the turf — the bulk of the cover, all near aspect 1.
  const tuft = (
    x: number, y: number, z: number, baseScale: number, spread: number,
    count: number, lit: number, damp: number, dry: number, windBase: number,
  ) => {
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = spread * Math.sqrt(rnd());
      const px = x + Math.cos(a) * rr;
      const pz = z + Math.sin(a) * rr;
      cen.push(px, y + 0.18 + rnd() * 0.5, pz);
      scl.push(baseScale * (0.7 + rnd() * 0.7));
      const dryTip = dry > 0.6 && rnd() < 0.16;
      const c = dryTip ? seedHead(rnd, lit) : weedGreen(rnd, lit, damp, dry);
      col.push(c.r, c.g, c.b);
      wnd.push(windBase * (0.55 + rnd() * 0.5)); // raised flecks sway gently
      ang.push(rnd() * Math.PI); // round → orientation only jitters the silhouette
      asp.push(0.9 + rnd() * 0.2); // ROUND fleck
    }
  };

  // Stamp an upright spray: a few mildly-elongated blades/stems/fronds standing
  // out of the tuft, swaying. aAngle≈0 keeps the long (local-Y) axis vertical on
  // screen; small jitter gives a natural fan. These are the MINORITY accent.
  const upright = (
    x: number, y: number, z: number, height: number, blades: number,
    lit: number, damp: number, dry: number, reed: boolean,
  ) => {
    for (let i = 0; i < blades; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = (reed ? 0.9 : 0.55) * Math.sqrt(rnd());
      const px = x + Math.cos(a) * rr;
      const pz = z + Math.sin(a) * rr;
      const h = height * (0.7 + rnd() * 0.6);
      cen.push(px, y + h * 0.5 + 0.2, pz); // centre at mid-height so base ≈ ground
      scl.push(h * 0.5); // half-height; aspect then stretches the length
      // dry straw seed-heads more likely on tall grass tips; reeds stay green/cool
      const dryTip = !reed && dry > 0.55 && rnd() < 0.28;
      const c = dryTip ? seedHead(rnd, lit) : weedGreen(rnd, lit + 0.08, damp + (reed ? 0.25 : 0), dry);
      col.push(c.r, c.g, c.b);
      wnd.push(reed ? 0.6 + rnd() * 0.3 : 0.85 + rnd() * 0.45); // tips sway most
      ang.push((rnd() - 0.5) * (reed ? 0.28 : 0.5)); // near-vertical fan
      asp.push(reed ? 2.0 + rnd() * 0.6 : 1.5 + rnd() * 0.7); // MILD elongation only
    }
  };

  // A small grounding shadow smear under an upright clump (flat, still, offset
  // away from the sun) so vertical accents read as rooted.
  const rootShadow = (x: number, y: number, z: number, r: number) => {
    const n = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = r * Math.sqrt(rnd());
      cen.push(x + 0.627 * r * 0.4 + Math.cos(a) * rr, y + 0.12, z + 0.778 * r * 0.4 + Math.sin(a) * rr);
      scl.push(0.7 + rnd() * 0.7);
      col.push(palette.grassDeep.r * 0.5, palette.grassDeep.g * 0.5, palette.grassDeep.b * 0.5);
      wnd.push(0);
      ang.push(SHADOW_ANGLE + (rnd() - 0.5) * 0.4);
      asp.push(0.95 + rnd() * 0.2);
    }
  };

  // Coarse scatter grid: finer than trees, like the bush grid, so cover is dense
  // but the candidate count (and thus cost) stays bounded.
  const cells = 26;
  const cs = S / cells;
  for (let gz = 0; gz < cells; gz++) {
    for (let gx = 0; gx < cells; gx++) {
      const x = ox + (gx + rnd()) * cs;
      const z = oz + (gz + rnd()) * cs;
      const surf = field.surface(x, z);
      // No undergrowth on tracks, rock faces, or steep ground.
      if (surf.path > 0.32 || surf.rock > 0.45 || surf.slope > 0.6) continue;

      const y = field.height(x, z);
      const forest = field.forest(x, z);
      const dry = field.dry(x, z);

      // Light-coupled term (same recipe as the turf splats in Chunk.ts), so weeds
      // shade in lockstep with the ground they grow from.
      const ny = Math.sqrt(Math.max(0, 1 - surf.nx * surf.nx - surf.nz * surf.nz));
      const ndotl = surf.nx * SUNX + ny * SUNY + surf.nz * SUNZ;
      const lit = clamp(0.5 + 0.5 * ndotl, 0, 1);

      // Damp hollows: low elevation favours lusher, cooler growth & reeds.
      const lowness = 1 - smoothstep(y, -18, 70); // 1 in valleys .. 0 on ridges
      const damp = clamp(lowness * (0.6 + 0.4 * (1 - dry)), 0, 1);

      // Density: lush near low ground, path edges (worn-track fringe), and the
      // woodland floor; sparse on bright open ridge tops.
      const edge = smoothstep(surf.path, 0.06, 0.24) * (1 - smoothstep(surf.path, 0.24, 0.4));
      const want = clamp(0.28 + 0.5 * forest + 0.4 * lowness + 0.5 * edge, 0, 1);
      if (rnd() > want) continue;

      // The bulk: a plush round-fleck tuft (clover / weeds / leafy ground cover).
      const tuftScale = 0.55 + rnd() * 0.6;
      const spread = cs * (0.4 + rnd() * 0.5);
      const cnt = 5 + Math.floor(rnd() * 7 + want * 6);
      tuft(x, y, z, tuftScale, spread, cnt, lit, damp, dry, 0.5 + rnd() * 0.2);

      // The minority accent: only some tufts throw up upright blades/stems/fronds.
      const r = rnd();
      if (damp > 0.55 && r < 0.34) {
        // reeds in damp hollows — taller, cooler, stiffer
        const blades = 3 + Math.floor(rnd() * 4);
        upright(x, y, z, 3.2 + rnd() * 2.6, blades, lit, damp, dry, true);
        rootShadow(x, y, z, 1.4);
      } else if (r < 0.4) {
        // tall-grass / weed spray — the main vertical interest
        const blades = 3 + Math.floor(rnd() * 4 + forest * 2);
        upright(x, y, z, 1.6 + rnd() * 1.6, blades, lit, damp, dry, false);
        rootShadow(x, y, z, 1.0);
      } else if (forest > 0.45 && r < 0.55) {
        // fern frond on the shaded woodland floor — a couple of arching blades
        const blades = 2 + Math.floor(rnd() * 3);
        upright(x, y, z, 1.4 + rnd() * 1.2, blades, lit * 0.7, damp + 0.15, 0, false);
      }
      placed++;
    }
  }

  if (placed === 0) return null;
  return {
    centers: Float32Array.from(cen),
    scales: Float32Array.from(scl),
    colors: Float32Array.from(col),
    winds: Float32Array.from(wnd),
    angles: Float32Array.from(ang),
    aspects: Float32Array.from(asp),
  };
}
