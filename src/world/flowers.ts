import * as THREE from 'three/webgpu';
import { mulberry32, hash2 } from '../core/rng';
import { palette } from '../render/palette';
import { TerrainField } from './TerrainField';
import { CHUNK_SIZE, WORLD_SEED } from '../config';

// Wild flower patches — the meadow's quiet colour punctuation. Clusters of small
// bright blooms scatter across open, low-slope grass: daisy-like rings (a circle
// of white / yellow / violet petals around a golden or orange eye) plus loose
// drifts of single blooms, each lifted on one short thin green stem.
//
// Everything lives in the SAME splat attribute layout as foliage (aCenter world
// pos, aScale world size, aColor BAKED colour, aWind sway, aAngle stroke
// rotation, aAspect 1=round / >1=length) so a chunk can draw it with the shared
// pointMat in one more instanced billboard pass — no new material, no per-frame
// CPU. Generation is SEEDED from (cx, cz, WORLD_SEED) so patches are deterministic
// and seamless across chunk borders.
//
// Art intent: petals are round dabs that catch the light (warm sunlit, faintly
// cool in shade) and sway gently on the wind; the eye is a small still warm dot;
// the stem is a single mild-aspect upright green dab that stays put. Tasteful
// punctuation across the turf — clustered, never a wall-to-wall carpet.

const clamp = THREE.MathUtils.clamp;
const _col = new THREE.Color();

// Normalised sun for baking petal light (same convention as the turf/foliage:
// shade deepens & cools, sunlit warms & lifts). Kept analytic — no normals here.
const SUNX = -0.5, SUNZ = -0.62;

interface Acc {
  cen: number[];
  scl: number[];
  col: number[];
  wnd: number[];
  ang: number[];
  asp: number[];
}

/**
 * Stamp one bloom: a thin upright green stem topped by a ring of petals around a
 * small warm eye. The whole flower's exposure (`lit`, 0 shade .. 1 full sun) is
 * baked into every petal so it sits in the same light as the surrounding turf.
 */
function emitFlower(
  acc: Acc, x: number, y: number, z: number,
  size: number, lit: number, rnd: () => number,
) {
  // ---- stem: one mild-aspect upright dab, sitting just under the head, STILL.
  // A muted shaded green so it reads as a stalk, not a leaf fleck.
  const stemH = size * (1.4 + rnd() * 0.8);
  _col.copy(palette.foliage).lerp(palette.foliageDark, 0.35 + rnd() * 0.3)
    .offsetHSL((rnd() - 0.5) * 0.02, (rnd() - 0.5) * 0.05, (lit - 0.5) * 0.12);
  acc.cen.push(x, y + stemH * 0.5, z);
  acc.scl.push(size * (0.5 + rnd() * 0.18));
  acc.col.push(_col.r, _col.g, _col.b);
  acc.wnd.push(0); // stems stay put — only the head sways
  acc.ang.push(0); // upright
  acc.asp.push(1.4 + rnd() * 0.6); // mild elongation → reads as a stalk

  const hx = x, hy = y + stemH, hz = z;

  // ---- petal colour family for this bloom ----
  // white / yellow / violet, with a faint light coupling so sunlit blooms warm
  // and brighten while shaded ones cool and deepen. Never near-black.
  const f = rnd();
  let pBase: THREE.Color;
  let eye: THREE.Color;
  if (f < 0.46) {
    pBase = palette.flowerWhite;
    eye = palette.goldenEye; // classic ox-eye daisy
  } else if (f < 0.78) {
    pBase = palette.flowerYellow;
    eye = rnd() < 0.5 ? palette.orangeEye : palette.goldenEye;
  } else {
    pBase = rnd() < 0.5 ? palette.flowerViolet : palette.flowerLavender;
    eye = palette.goldenEye; // violet ray-petals, gold disc
  }

  // ---- petal ring ----
  const petals = 5 + Math.floor(rnd() * 4); // 5..8 ray petals
  const headR = size * (0.62 + rnd() * 0.3);
  const phase = rnd() * Math.PI * 2;
  const wind = 0.55 + rnd() * 0.2; // heads catch the gust
  for (let i = 0; i < petals; i++) {
    const a = phase + (i / petals) * Math.PI * 2 + (rnd() - 0.5) * 0.25;
    const rr = headR * (0.86 + rnd() * 0.22);
    const px = hx + Math.cos(a) * rr;
    const pz = hz + Math.sin(a) * rr;
    const py = hy + (rnd() - 0.5) * size * 0.12;
    // baked light: warm & lift in sun, cool & deepen in shade; petals facing the
    // sun azimuth catch a touch more. Lightness stays high — these are highlights.
    const sun = (Math.cos(a) * SUNX + Math.sin(a) * SUNZ);
    const l = clamp(0.55 + lit * 0.32 + sun * 0.05 + (rnd() - 0.5) * 0.06, 0.4, 0.97);
    _col.copy(pBase);
    const hsl = { h: 0, s: 0, l: 0 };
    _col.getHSL(hsl);
    _col.setHSL(
      hsl.h + (rnd() - 0.5) * 0.02,
      clamp(hsl.s * (0.9 + (1 - lit) * 0.18) + (rnd() - 0.5) * 0.04, 0, 1),
      l,
    );
    acc.cen.push(px, py, pz);
    acc.scl.push(size * (0.42 + rnd() * 0.22));
    acc.col.push(_col.r, _col.g, _col.b);
    acc.wnd.push(wind);
    acc.ang.push(a + Math.PI / 2 + (rnd() - 0.5) * 0.4); // petals radiate from the eye
    acc.asp.push(1.15 + rnd() * 0.35); // gently oval ray-petal (stays leaf/petal-ish)
  }

  // ---- eye: a small, warm, still-ish dot at the centre ----
  _col.copy(eye).offsetHSL((rnd() - 0.5) * 0.02, 0, (lit - 0.5) * 0.1 + (rnd() - 0.5) * 0.05);
  acc.cen.push(hx, hy + size * 0.04, hz);
  acc.scl.push(size * (0.34 + rnd() * 0.14));
  acc.col.push(_col.r, _col.g, _col.b);
  acc.wnd.push(wind * 0.7);
  acc.ang.push(rnd() * Math.PI); // round dab
  acc.asp.push(0.94 + rnd() * 0.14);
}

/**
 * Scatter wild flower patches over one chunk. Returns null when the chunk holds
 * no flowers (so the caller can skip building an empty mesh). Placement: only on
 * grassy, low-slope ground (no path / rock / steep), denser in clearings (low
 * forest density) and sparse under woodland. Patches are clumps of blooms with a
 * looser drift of singles around them — colour punctuation, not a carpet.
 */
export function scatterFlowers(
  field: TerrainField, cx: number, cz: number,
): {
  centers: Float32Array;
  scales: Float32Array;
  colors: Float32Array;
  winds: Float32Array;
  angles: Float32Array;
  aspects: Float32Array;
} | null {
  const S = CHUNK_SIZE;
  const ox = cx * S;
  const oz = cz * S;
  // Own rng stream (distinct salt) so flower placement can't shift the terrain
  // splat / tree / rock layouts, and stays seamless across chunk borders.
  const rnd = mulberry32(hash2(cx, cz, (WORLD_SEED ^ 0xf10e2) >>> 0));

  const acc: Acc = { cen: [], scl: [], col: [], wnd: [], ang: [], asp: [] };

  // Is this spot suitable for flowers? Grassy, gentle, not a track or rock.
  const grassy = (x: number, z: number): boolean => {
    const s = field.surface(x, z);
    return s.path < 0.18 && s.rock < 0.32 && s.slope < 0.4;
  };

  // Bake exposure for a flower at (x,z): meadow sun term from the surface normal,
  // matching the turf so blooms share the landscape's light.
  const exposure = (x: number, z: number): number => {
    const s = field.surface(x, z);
    const ny = Math.sqrt(Math.max(0, 1 - s.nx * s.nx - s.nz * s.nz));
    const ndotl = s.nx * SUNX + ny * 0.55 + s.nz * SUNZ;
    return clamp(0.5 + 0.5 * ndotl, 0, 1);
  };

  // ---- clustered patches: a coarse grid of candidate patch centres ----
  // Each cell may seed one patch; patches are denser in clearings (low forest).
  const cells = 6;
  const cs = S / cells;
  for (let gz = 0; gz < cells; gz++) {
    for (let gx = 0; gx < cells; gx++) {
      const px = ox + (gx + rnd()) * cs;
      const pz = oz + (gz + rnd()) * cs;
      if (!grassy(px, pz)) continue;

      // Clearings (low forest) bloom; woodland is sparse. forest ~0 open .. 1 dense.
      const open = 1 - field.forest(px, pz);
      // dry/lime meadows favour flowers a touch more (sunny open turf).
      const sun = field.dry(px, pz);
      const chance = 0.16 + open * 0.5 + sun * 0.12;
      if (rnd() > chance) continue;

      const patchR = 3 + rnd() * 7;
      const blooms = 5 + Math.floor(rnd() * (10 + open * 14)); // fuller in the open
      for (let i = 0; i < blooms; i++) {
        // clustered toward the patch centre (sqrt for a soft falloff)
        const a = rnd() * Math.PI * 2;
        const rr = patchR * Math.sqrt(rnd());
        const fx = px + Math.cos(a) * rr;
        const fz = pz + Math.sin(a) * rr;
        if (!grassy(fx, fz)) continue; // respect edges (paths/rock/slope)
        const y = field.height(fx, fz);
        const size = 0.7 + rnd() * 0.7;
        emitFlower(acc, fx, y + 0.06, fz, size, exposure(fx, fz), rnd);
      }
    }
  }

  // ---- loose drift of singles: thin scatter of lone blooms between patches ----
  // Keeps the punctuation from clumping into islands; very sparse, open-biased.
  const dcells = 9;
  const dcs = S / dcells;
  for (let gz = 0; gz < dcells; gz++) {
    for (let gx = 0; gx < dcells; gx++) {
      const fx = ox + (gx + rnd()) * dcs;
      const fz = oz + (gz + rnd()) * dcs;
      if (!grassy(fx, fz)) continue;
      const open = 1 - field.forest(fx, fz);
      if (rnd() > 0.06 + open * 0.16) continue; // tasteful, not a carpet
      const y = field.height(fx, fz);
      const size = 0.65 + rnd() * 0.6;
      emitFlower(acc, fx, y + 0.06, fz, size, exposure(fx, fz), rnd);
    }
  }

  if (acc.scl.length === 0) return null;
  return {
    centers: Float32Array.from(acc.cen),
    scales: Float32Array.from(acc.scl),
    colors: Float32Array.from(acc.col),
    winds: Float32Array.from(acc.wnd),
    angles: Float32Array.from(acc.ang),
    aspects: Float32Array.from(acc.asp),
  };
}
