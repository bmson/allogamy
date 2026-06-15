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
// seed-head tips. Each tuft is moulded as a small SQUASHED DOME (cf. tree.ts
// emitBlob): dabs sit on a rounded cushion, brighter on the lit crown/rim and
// deepened toward a shaded core, so the cover reads as plush rounded clumps of
// growth rather than a flat disc of flecks. Output mirrors the foliage attribute
// contract so Chunk.ts can feed it straight into buildSplatGeometry + the shared
// splat material.
//
// Cost control: heavy field.surface() (does the normal central-difference) is
// evaluated ONCE per placement candidate on a coarse grid — never per dab — and a
// tuft expands into several cheap dabs around that point. A cheap path probe
// rejects worn-track cells BEFORE the expensive normal is taken. Counts are
// bounded by the grid resolution, so a chunk's weed budget is fixed regardless of
// density.

// Normalised sun direction, matching Chunk.ts so weeds shade identically to turf.
const _sun = new THREE.Vector3(...SUN_DIR).normalize();
const SUNX = _sun.x, SUNY = _sun.y, SUNZ = _sun.z;
// Sun azimuth (xz) — dabs on the sun-facing flank of a tuft catch a little extra
// light, the way real plush ground cover does.
const SUN_AZX = SUNX, SUN_AZZ = SUNZ;
const SUN_AZL = Math.hypot(SUN_AZX, SUN_AZZ) || 1;

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
 * it toward seed-head straw. `fresh` is a per-tuft personality (−1 deep mossy
 * clover .. +1 bright fresh blade) so neighbouring clumps read as different
 * plants instead of one flat green wash.
 */
function weedGreen(rnd: () => number, lit: number, damp: number, dry: number, fresh = 0): THREE.Color {
  const h = 0.33 - lit * 0.11 - damp * 0.02 + dry * 0.06 - fresh * 0.03 + (rnd() - 0.5) * 0.03;
  const s = 0.56 + (1 - lit) * 0.12 + damp * 0.05 - fresh * 0.04 + rnd() * 0.06;
  const l = 0.16 + lit * 0.44 + fresh * 0.06 + (rnd() - 0.5) * 0.07;
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

  // Stamp a small plush clump (a leafy tuft / clover cushion) hugging the turf —
  // the bulk of the cover, all near aspect 1. The dabs are moulded onto a SQUASHED
  // DOME so the clump reads as a rounded raised cushion: each dab's baked light is
  // lifted on the lit crown/rim and on the sun-facing flank, and deepened toward
  // the shaded interior, exactly like tree.ts canopy blobs (just much smaller).
  const tuft = (
    x: number, y: number, z: number, baseScale: number, spread: number,
    count: number, lit: number, damp: number, dry: number, windBase: number,
    fresh: number,
  ) => {
    const dome = spread * (0.7 + rnd() * 0.5); // dome height ≈ a fraction of the spread
    const inv = 1 / (spread + 1e-3);
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2;
      // Bias dabs toward the shell (more mass on the lit rim, hollower middle), so
      // the cushion reads as foliage rather than a solid speckled patch.
      const rn = 0.35 + 0.65 * Math.sqrt(rnd());
      const rr = spread * rn;
      const ca = Math.cos(a), sa = Math.sin(a);
      const px = x + ca * rr;
      const pz = z + sa * rr;
      // Dome profile: the cushion rises in the middle and falls at the rim.
      const domeH = dome * (1 - rn * rn);
      cen.push(px, y + 0.16 + domeH + rnd() * 0.18, pz);
      scl.push(baseScale * (0.7 + rnd() * 0.7));
      // Baked micro-light over the cushion: crown & rim catch light, the sun-facing
      // flank a little more, the shaded skirt goes deepest — never black.
      const crown = (1 - rn) * 0.5; // 0 rim .. 0.5 centre top
      const sunFlank = (ca * SUN_AZX + sa * SUN_AZZ) / SUN_AZL; // -1 away .. +1 toward sun
      const dlit = clamp(lit + crown * 0.22 + sunFlank * 0.12 - 0.05, 0, 1);
      const dryTip = dry > 0.6 && crown > 0.28 && rnd() < 0.22; // straw mostly at the crown
      const c = dryTip ? seedHead(rnd, dlit) : weedGreen(rnd, dlit, damp, dry, fresh);
      col.push(c.r, c.g, c.b);
      // raised flecks sway gently; the loftier crown dabs catch a touch more wind
      wnd.push(windBase * (0.5 + 0.45 * (rr * inv)) * (0.55 + rnd() * 0.5));
      ang.push(rnd() * Math.PI); // round → orientation only jitters the silhouette
      asp.push(0.9 + rnd() * 0.2); // ROUND fleck
    }
  };

  // Stamp an upright spray: a few mildly-elongated blades/stems/fronds standing
  // out of the tuft, swaying. aAngle≈0 keeps the long (local-Y) axis vertical on
  // screen; small jitter gives a natural fan. These are the MINORITY accent.
  // Ferns ARCH: their dabs lean outward and sag with height so the frond curls
  // over instead of standing as a stiff blade.
  const upright = (
    x: number, y: number, z: number, height: number, blades: number,
    lit: number, damp: number, dry: number, kind: 'grass' | 'reed' | 'fern',
  ) => {
    const reed = kind === 'reed';
    const fern = kind === 'fern';
    // Ferns radiate from a common crown; grass/reeds tuft from the base.
    const frondAz = rnd() * Math.PI * 2;
    for (let i = 0; i < blades; i++) {
      const a = fern ? frondAz + (i / blades) * Math.PI * 2 + (rnd() - 0.5) * 0.6 : rnd() * Math.PI * 2;
      const rr = (reed ? 0.9 : fern ? 0.7 : 0.55) * Math.sqrt(rnd());
      const ca = Math.cos(a), sa = Math.sin(a);
      const h = height * (0.7 + rnd() * 0.6);
      // Arching frond: the dab leans out along its azimuth and its top sags, so the
      // mark lies over rather than standing up. Grass/reeds stay near the base.
      const lean = fern ? h * (0.45 + rnd() * 0.3) : 0;
      const sag = fern ? h * 0.18 : 0;
      const px = x + ca * (rr + lean);
      const pz = z + sa * (rr + lean);
      cen.push(px, y + h * 0.5 + 0.2 - sag, pz); // centre near mid-height so base ≈ ground
      scl.push(h * 0.5); // half-height; aspect then stretches the length
      // dry straw seed-heads more likely on tall grass tips; reeds stay green/cool
      const dryTip = kind === 'grass' && dry > 0.55 && rnd() < 0.28;
      const c = dryTip ? seedHead(rnd, lit) : weedGreen(rnd, lit + 0.08, damp + (reed ? 0.25 : 0), dry);
      col.push(c.r, c.g, c.b);
      wnd.push(reed ? 0.6 + rnd() * 0.3 : fern ? 0.7 + rnd() * 0.35 : 0.85 + rnd() * 0.45); // tips sway most
      // Reeds stay near-vertical; grass fans; ferns lie along their arching azimuth
      // (so the stroke follows the frond out from the crown) with a wide jitter.
      ang.push(fern ? a + Math.PI * 0.5 + (rnd() - 0.5) * 0.5 : (rnd() - 0.5) * (reed ? 0.28 : 0.5));
      asp.push(reed ? 2.0 + rnd() * 0.6 : fern ? 1.7 + rnd() * 0.6 : 1.5 + rnd() * 0.7); // MILD elongation only
    }
  };

  // A few tiny bright florets nestled into a cushion — clover heads, daisies,
  // speedwell-blue specks: low ground-level flower colour that lifts the plush
  // cover without competing with the taller wildflower patches (flowers.ts). These
  // are small round dabs sitting just above the cushion crown, drifting in a
  // coherent colour per clump so they read as one little flowering plant.
  const floret = (x: number, y: number, z: number, spread: number, lit: number) => {
    const n = 2 + Math.floor(rnd() * 4);
    const pick = rnd();
    // dominant ground-flower family for this clump
    const base = pick < 0.34 ? palette.flowerWhite
      : pick < 0.58 ? palette.flowerYellow
      : pick < 0.78 ? palette.flowerLavender
      : palette.blossom;
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = spread * (0.2 + rnd() * 0.7);
      _col.copy(base).offsetHSL((rnd() - 0.5) * 0.04, (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.08 + (lit - 0.5) * 0.1);
      cen.push(x + Math.cos(a) * rr, y + 0.34 + rnd() * 0.28, z + Math.sin(a) * rr);
      scl.push(0.34 + rnd() * 0.3); // small bright specks
      col.push(_col.r, _col.g, _col.b);
      wnd.push(0.4 + rnd() * 0.25);
      ang.push(rnd() * Math.PI);
      asp.push(0.92 + rnd() * 0.16); // round
    }
  };

  // A small grounding shadow smear under an upright clump (flat, still, offset
  // away from the sun) so vertical accents read as rooted.
  const rootShadow = (x: number, y: number, z: number, r: number) => {
    const n = 1 + Math.floor(rnd() * 2);
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

  // Scatter grid. DENSITY: coarsened (was 26) so the undergrowth is a light plush
  // hint between the turf and bushes, not a wall-to-wall carpet of cushions.
  const cells = 13;
  const cs = S / cells;
  for (let gz = 0; gz < cells; gz++) {
    for (let gx = 0; gx < cells; gx++) {
      const x = ox + (gx + rnd()) * cs;
      const z = oz + (gz + rnd()) * cs;

      // CHEAP pre-reject on the worn-track mask BEFORE the expensive central-
      // difference normal in surface(): the path is the most common reason a cell
      // is skipped, so probing it first spares ~a third of cells the normal cost.
      if (field.pathMask(x, z) > 0.32) continue;

      const surf = field.surface(x, z);
      // No undergrowth on tracks, rock faces, or steep ground.
      if (surf.rock > 0.45 || surf.slope > 0.6) continue;

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
      // DENSITY: lower baseline so open ground stays mostly clear turf; cover still
      // gathers on the woodland floor, in damp hollows, and along path fringes.
      const want = clamp(0.14 + 0.4 * forest + 0.32 * lowness + 0.4 * edge, 0, 1);
      if (rnd() > want) continue;

      // Per-tuft personality: drier ground & ridges skew toward deep mossy clover
      // cushions, damp hollows & the woodland floor toward fresher bright blades —
      // so adjacent clumps read as genuinely different plants.
      const fresh = clamp((damp * 0.5 + forest * 0.3 - dry * 0.4) * 1.4 + (rnd() - 0.5) * 0.6, -1, 1);

      // The bulk: a plush domed cushion (clover / weeds / leafy ground cover).
      // DENSITY: fewer dabs per cushion (was 5 + 0..6 + want*6) — a lighter plush
      // hint; the shell-biased layout keeps it reading as a rounded clump.
      const tuftScale = 0.55 + rnd() * 0.6;
      const spread = cs * (0.4 + rnd() * 0.5);
      const cnt = 3 + Math.floor(rnd() * 4 + want * 3);
      tuft(x, y, z, tuftScale, spread, cnt, lit, damp, dry, 0.5 + rnd() * 0.2, fresh);

      // Some cushions in open, sunlit grass carry a little knot of ground florets —
      // clover / daisies / speedwell — for low colour. Suppressed in deep shaded
      // woodland (forest floor stays leafy) and on dry ridge straw.
      if (forest < 0.5 && lit > 0.45 && rnd() < 0.16 + lit * 0.12 - dry * 0.1) {
        floret(x, y, z, spread, lit);
      }

      // The minority accent: only some tufts throw up upright blades/stems/fronds.
      // DENSITY: rarer accents and fewer blades each, so verticals stay an
      // occasional flourish rather than a fringe on every cushion.
      const r = rnd();
      if (damp > 0.55 && r < 0.24) {
        // reeds in damp hollows — taller, cooler, stiffer
        const blades = 2 + Math.floor(rnd() * 3);
        upright(x, y, z, 3.2 + rnd() * 2.6, blades, lit, damp, dry, 'reed');
        rootShadow(x, y, z, 1.4);
      } else if (r < 0.26) {
        // tall-grass / weed spray — the main vertical interest
        const blades = 2 + Math.floor(rnd() * 3 + forest * 2);
        upright(x, y, z, 1.6 + rnd() * 1.6, blades, lit, damp, dry, 'grass');
        rootShadow(x, y, z, 1.0);
      } else if (forest > 0.45 && r < 0.38) {
        // fern frond on the shaded woodland floor — a few arching blades fanning
        // out from a common crown
        const blades = 2 + Math.floor(rnd() * 3);
        upright(x, y, z, 1.4 + rnd() * 1.2, blades, lit * 0.7, damp + 0.15, 0, 'fern');
        rootShadow(x, y, z, 0.9);
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
