import * as THREE from 'three/webgpu';
import { mulberry32, hash2 } from '../core/rng';
import { palette } from '../render/palette';
import { TerrainField, SurfacePoint } from './TerrainField';
import { CHUNK_SIZE, WORLD_SEED } from '../config';

// Wild flower patches — the meadow's quiet colour punctuation. Clusters of small
// bright blooms scatter across open, low-slope grass. Several recognisable wild-
// flower archetypes share the field so a meadow reads with real botanical variety
// rather than one repeated daisy: ox-eye daisies (white ring + gold disc), sunny
// buttercups, violet/lavender asters, scarlet poppies (dark heart), sky-blue
// cornflowers, plus VERTICAL accents — spire blooms (a stacked foxglove-like
// column of bells) and lacy umbels (a yarrow-like cap of tiny dabs) — and the odd
// closed bud. Each flower still rises on one short thin green stem.
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
// the stem is a single mild-aspect upright green dab that stays put. A patch keeps
// a DOMINANT species so blooms drift in coherent colour families (painterly), with
// occasional companions mixed in. Tasteful punctuation across the turf — clustered,
// never a wall-to-wall carpet.

const clamp = THREE.MathUtils.clamp;
const _col = new THREE.Color();
// Reused HSL scratch so the per-petal colour maths never allocates in the hot loop.
const _hsl = { h: 0, s: 0, l: 0 };

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

// ---- bloom archetypes ------------------------------------------------------
// Each species fixes the petal colour family, its disc/eye, and a coarse FORM so
// the meadow carries genuine variety. Colours are authored as base THREE.Colors
// (mostly from the palette; poppy-red and cornflower-blue are derived locally so
// no new palette keys are needed) and then light-coupled per petal at stamp time.
enum Form {
  Ray, // classic flat daisy: a ring of ray petals around a disc eye
  Cup, // a few broad overlapping petals forming a shallow cup (buttercup/poppy)
  Spire, // a vertical column of small bells climbing the stem (foxglove-like)
  Umbel, // a flat lacy cap of many tiny florets (yarrow / cow-parsley)
}

interface Species {
  form: Form;
  petal: THREE.Color; // ray / cup / floret base colour
  eye: THREE.Color; // central disc
  weight: number; // relative likelihood of being a patch's dominant species
}

// Derived hues the palette doesn't carry (kept local so palette.ts is untouched).
const POPPY_RED = new THREE.Color('#e03521'); // scarlet field-poppy ray
const CORNFLOWER = new THREE.Color('#5a78d8'); // true cornflower blue
const POPPY_HEART = new THREE.Color('#241410'); // near-black poppy centre
const BUTTERCUP = new THREE.Color('#ffd21a'); // glossy deep-yellow cup

// DENSITY/CALM: the catalog is leaned on FEWER, simpler species so drifts read as
// calm colour rather than a botanical confetti of nine forms. The cheap, legible
// ray daisies and buttercup/poppy cups dominate; the expensive many-dab Spire and
// Umbel forms are kept as rare accents (low weight) so they barely appear. Colours
// are untouched.
const SPECIES: Species[] = [
  { form: Form.Ray, petal: palette.flowerWhite, eye: palette.goldenEye, weight: 1.2 }, // ox-eye daisy
  { form: Form.Ray, petal: palette.flowerYellow, eye: palette.orangeEye, weight: 0.8 }, // yellow daisy
  { form: Form.Ray, petal: palette.flowerViolet, eye: palette.goldenEye, weight: 0.5 }, // violet aster
  { form: Form.Ray, petal: palette.flowerLavender, eye: palette.goldenEye, weight: 0.25 }, // lavender aster
  { form: Form.Cup, petal: BUTTERCUP, eye: palette.goldenEye, weight: 0.7 }, // buttercup
  { form: Form.Cup, petal: POPPY_RED, eye: POPPY_HEART, weight: 0.4 }, // scarlet poppy
  { form: Form.Ray, petal: CORNFLOWER, eye: palette.goldenEye, weight: 0.3 }, // cornflower
  { form: Form.Spire, petal: palette.flowerViolet, eye: palette.flowerLavender, weight: 0.12 }, // foxglove spire (rare)
  { form: Form.Umbel, petal: palette.flowerWhite, eye: palette.flowerWhite, weight: 0.1 }, // yarrow umbel (rare)
];
const SPECIES_TOTAL = SPECIES.reduce((s, sp) => s + sp.weight, 0);

/** Pick a species by weight from the patch's rng (deterministic). */
function pickSpecies(rnd: () => number): Species {
  let t = rnd() * SPECIES_TOTAL;
  for (const sp of SPECIES) {
    t -= sp.weight;
    if (t <= 0) return sp;
  }
  return SPECIES[0];
}

/**
 * Bake a petal colour from a species base: warm & lift in sun, cool & deepen in
 * shade, with petals facing the sun azimuth (`facing`, the dab's outward dot with
 * the sun) catching a touch more light. Lightness stays high — these are the
 * meadow's highlights and must never crush to near-black. Writes into `_col`.
 */
function bakePetal(
  base: THREE.Color, lit: number, facing: number, rnd: () => number,
  litFloor = 0.4, litMax = 0.97,
): void {
  base.getHSL(_hsl);
  // Sun-driven value: shaded blooms sit lower, sunlit ones glow; the outward
  // facing term gives a soft directional sheen across a single flower's petals.
  const l = clamp(_hsl.l * 0.5 + 0.34 + lit * 0.3 + facing * 0.05 + (rnd() - 0.5) * 0.06, litFloor, litMax);
  _col.setHSL(
    _hsl.h + (rnd() - 0.5) * 0.02,
    clamp(_hsl.s * (0.9 + (1 - lit) * 0.18) + (rnd() - 0.5) * 0.04, 0, 1),
    l,
  );
}

/** Stamp the short, still green stem that every bloom rises on. Returns its top. */
function emitStem(
  acc: Acc, x: number, y: number, z: number, size: number, stemH: number,
  lit: number, rnd: () => number,
): void {
  // A muted shaded green so it reads as a stalk, not a leaf fleck. STILL — only
  // the head sways — so the bloom feels rooted while its petals catch the gust.
  _col.copy(palette.foliage).lerp(palette.foliageDark, 0.35 + rnd() * 0.3)
    .offsetHSL((rnd() - 0.5) * 0.02, (rnd() - 0.5) * 0.05, (lit - 0.5) * 0.12);
  acc.cen.push(x, y + stemH * 0.5, z);
  acc.scl.push(size * (0.5 + rnd() * 0.18));
  acc.col.push(_col.r, _col.g, _col.b);
  acc.wnd.push(0); // stems stay put — only the head sways
  acc.ang.push(0); // upright
  acc.asp.push(1.4 + rnd() * 0.6); // mild elongation → reads as a stalk
}

/** A small, warm, still-ish central disc/eye dab. */
function emitEye(
  acc: Acc, x: number, y: number, z: number, size: number, eye: THREE.Color,
  lit: number, wind: number, rnd: () => number,
): void {
  _col.copy(eye).offsetHSL((rnd() - 0.5) * 0.02, 0, (lit - 0.5) * 0.1 + (rnd() - 0.5) * 0.05);
  acc.cen.push(x, y + size * 0.04, z);
  acc.scl.push(size * (0.34 + rnd() * 0.14));
  acc.col.push(_col.r, _col.g, _col.b);
  acc.wnd.push(wind * 0.7);
  acc.ang.push(rnd() * Math.PI); // round dab
  acc.asp.push(0.94 + rnd() * 0.14);
}

/**
 * Stamp one bloom of `sp` at (x,z) on the turf. The whole flower's exposure
 * (`lit`, 0 shade .. 1 full sun) is baked into every petal so it sits in the same
 * light as the surrounding turf. `bud` produces a closed green-tipped bloom (a
 * still-furled head) for a touch of life-cycle variety.
 */
function emitFlower(
  acc: Acc, sp: Species, x: number, y: number, z: number,
  size: number, lit: number, rnd: () => number, bud = false,
): void {
  // Spires & umbels stand a little taller; cups & rays keep a short daisy stalk.
  const tall = sp.form === Form.Spire ? 1.9 + rnd() * 1.1 : 1.4 + rnd() * 0.8;
  const stemH = size * tall;
  emitStem(acc, x, y, z, size, stemH, lit, rnd);

  const hx = x, hy = y + stemH, hz = z;
  const wind = 0.55 + rnd() * 0.2; // heads catch the gust

  // ---- closed bud: a tight furled head, mostly green with a hint of its colour.
  if (bud) {
    _col.copy(palette.foliageLight).lerp(sp.petal, 0.22 + rnd() * 0.18)
      .offsetHSL(0, -0.05, (lit - 0.5) * 0.12);
    acc.cen.push(hx, hy, hz);
    acc.scl.push(size * (0.42 + rnd() * 0.16));
    acc.col.push(_col.r, _col.g, _col.b);
    acc.wnd.push(wind);
    acc.ang.push(rnd() * Math.PI);
    acc.asp.push(1.25 + rnd() * 0.35); // slightly egg-shaped, vertical
    return;
  }

  switch (sp.form) {
    case Form.Spire: {
      // A vertical column of small bells climbing the upper stem — read top to
      // bottom as opening flowers. Bells alternate side to side and the lowest are
      // largest (fully open), shrinking to buds at the tip.
      const bells = 4 + Math.floor(rnd() * 3); // 4..6 bells
      const colH = stemH * 0.55;
      for (let i = 0; i < bells; i++) {
        const t = i / (bells - 1); // 0 bottom .. 1 tip
        const by = hy - colH * (1 - t); // climb the stem
        const side = (i & 1 ? 1 : -1) * (0.5 + rnd() * 0.4);
        const bx = hx + side * size * 0.5;
        const bz = hz + (rnd() - 0.5) * size * 0.35;
        // tip florets are smaller, paler buds; lower ones open & saturated
        bakePetal(sp.petal, lit, 0.0, rnd, 0.4 + t * 0.1, 0.95);
        if (t > 0.7) _col.lerp(palette.foliageLight, (t - 0.7) * 0.6); // furled tip
        acc.cen.push(bx, by, bz);
        acc.scl.push(size * (0.5 - t * 0.22 + rnd() * 0.12));
        acc.col.push(_col.r, _col.g, _col.b);
        acc.wnd.push(wind);
        acc.ang.push((rnd() - 0.5) * 0.5);
        acc.asp.push(1.2 + rnd() * 0.4); // bell-ish ovals
      }
      return;
    }
    case Form.Umbel: {
      // A flat lacy cap of many tiny florets (yarrow / cow-parsley): a dense disc
      // of small round dabs rather than distinct rays. Reads as a soft cloud.
      const florets = 6 + Math.floor(rnd() * 4); // 6..9 tiny dabs (was 9..15)
      const capR = size * (0.66 + rnd() * 0.3);
      for (let i = 0; i < florets; i++) {
        const a = rnd() * Math.PI * 2;
        const rr = capR * Math.sqrt(rnd());
        const fx = hx + Math.cos(a) * rr;
        const fz = hz + Math.sin(a) * rr;
        const facing = Math.cos(a) * SUNX + Math.sin(a) * SUNZ;
        bakePetal(sp.petal, lit, facing, rnd, 0.5, 0.98);
        acc.cen.push(fx, hy + (rnd() - 0.5) * size * 0.06, fz);
        acc.scl.push(size * (0.2 + rnd() * 0.14)); // tiny florets
        acc.col.push(_col.r, _col.g, _col.b);
        acc.wnd.push(wind);
        acc.ang.push(rnd() * Math.PI);
        acc.asp.push(0.9 + rnd() * 0.2); // round
      }
      return;
    }
    case Form.Cup: {
      // A few broad overlapping petals forming a shallow cup (buttercup / poppy):
      // fewer, larger, rounder dabs that overlap into one glossy bloom, with a
      // small dark or gold heart. Poppy-style hearts are near-black; gold otherwise.
      const petals = 4 + Math.floor(rnd() * 2); // 4..5 broad petals
      const headR = size * (0.5 + rnd() * 0.22);
      const phase = rnd() * Math.PI * 2;
      for (let i = 0; i < petals; i++) {
        const a = phase + (i / petals) * Math.PI * 2 + (rnd() - 0.5) * 0.3;
        const rr = headR * (0.7 + rnd() * 0.2);
        const px = hx + Math.cos(a) * rr;
        const pz = hz + Math.sin(a) * rr;
        const facing = Math.cos(a) * SUNX + Math.sin(a) * SUNZ;
        bakePetal(sp.petal, lit, facing, rnd, 0.42, 0.97);
        acc.cen.push(px, hy + (rnd() - 0.5) * size * 0.1, pz);
        acc.scl.push(size * (0.5 + rnd() * 0.24)); // broad petals
        acc.col.push(_col.r, _col.g, _col.b);
        acc.wnd.push(wind);
        acc.ang.push(a + Math.PI / 2 + (rnd() - 0.5) * 0.4);
        acc.asp.push(1.05 + rnd() * 0.25); // nearly round, overlapping
      }
      emitEye(acc, hx, hy, hz, size, sp.eye, lit, wind, rnd);
      return;
    }
    default: {
      // Ray: classic flat daisy / aster — a ring of slender ray petals radiating
      // from a central disc eye. The signature meadow form.
      const petals = 5 + Math.floor(rnd() * 3); // 5..7 ray petals (was 6..9)
      const headR = size * (0.62 + rnd() * 0.3);
      const phase = rnd() * Math.PI * 2;
      for (let i = 0; i < petals; i++) {
        const a = phase + (i / petals) * Math.PI * 2 + (rnd() - 0.5) * 0.25;
        const rr = headR * (0.86 + rnd() * 0.22);
        const px = hx + Math.cos(a) * rr;
        const pz = hz + Math.sin(a) * rr;
        const py = hy + (rnd() - 0.5) * size * 0.12;
        const facing = Math.cos(a) * SUNX + Math.sin(a) * SUNZ;
        bakePetal(sp.petal, lit, facing, rnd);
        acc.cen.push(px, py, pz);
        acc.scl.push(size * (0.42 + rnd() * 0.22));
        acc.col.push(_col.r, _col.g, _col.b);
        acc.wnd.push(wind);
        acc.ang.push(a + Math.PI / 2 + (rnd() - 0.5) * 0.4); // petals radiate from the eye
        acc.asp.push(1.25 + rnd() * 0.45); // slender oval ray-petal
      }
      emitEye(acc, hx, hy, hz, size, sp.eye, lit, wind, rnd);
      return;
    }
  }
}

/**
 * Scatter wild flower patches over one chunk. Returns null when the chunk holds
 * no flowers (so the caller can skip building an empty mesh). Placement: only on
 * grassy, low-slope ground (no path / rock / steep), denser in clearings (low
 * forest density) and sparse under woodland. Patches are clumps of blooms with a
 * looser drift of singles around them — colour punctuation, not a carpet. Each
 * patch keeps a DOMINANT species so blooms drift in coherent colour families.
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

  // Single field.surface() call answers BOTH "is this grassy?" and the baked sun
  // exposure (was two full surface evals — each does a 4-sample normal). Returns
  // -1 for unsuitable spots (path / rock / steep), else the exposure in [0,1].
  const probe = (x: number, z: number): number => {
    const s: SurfacePoint = field.surface(x, z);
    if (s.path >= 0.18 || s.rock >= 0.32 || s.slope >= 0.4) return -1;
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
      if (probe(px, pz) < 0) continue;

      // Clearings (low forest) bloom; woodland is sparse. forest ~0 open .. 1 dense.
      const open = 1 - field.forest(px, pz);
      // dry/lime meadows favour flowers a touch more (sunny open turf).
      const sun = field.dry(px, pz);
      // DENSITY: ~halved patch frequency so blooms punctuate the turf rather than
      // carpet it — calm colour drifts, not a meadow of confetti.
      const chance = 0.08 + open * 0.26 + sun * 0.06;
      if (rnd() > chance) continue;

      // This patch's dominant species → coherent colour drifts, not confetti. A
      // minority of blooms swap to a random companion so a stand stays painterly
      // but not monotone.
      const dominant = pickSpecies(rnd);
      const purity = 0.7 + rnd() * 0.25; // fraction of blooms that match the dominant

      const patchR = 3 + rnd() * 7;
      // DENSITY: ~halved blooms per patch (was 5 + 10..24) — a few blooms read as a
      // coherent drift; a dense clump just costs instances and looks busy.
      const blooms = 3 + Math.floor(rnd() * (5 + open * 7)); // fuller in the open
      for (let i = 0; i < blooms; i++) {
        // clustered toward the patch centre (sqrt for a soft falloff)
        const a = rnd() * Math.PI * 2;
        const rr = patchR * Math.sqrt(rnd());
        const fx = px + Math.cos(a) * rr;
        const fz = pz + Math.sin(a) * rr;
        const lit = probe(fx, fz);
        if (lit < 0) continue; // respect edges (paths/rock/slope)
        const y = field.height(fx, fz);
        const size = 0.7 + rnd() * 0.7;
        const sp = rnd() < purity ? dominant : pickSpecies(rnd);
        const bud = rnd() < 0.1; // the odd closed bud for life-cycle variety
        emitFlower(acc, sp, fx, y + 0.06, fz, size, lit, rnd, bud);
      }
    }
  }

  // ---- loose drift of singles: thin scatter of lone blooms between patches ----
  // Keeps the punctuation from clumping into islands; very sparse, open-biased.
  // DENSITY: coarser grid (was 9) and a lower chance — just the odd stray bloom.
  const dcells = 6;
  const dcs = S / dcells;
  for (let gz = 0; gz < dcells; gz++) {
    for (let gx = 0; gx < dcells; gx++) {
      const fx = ox + (gx + rnd()) * dcs;
      const fz = oz + (gz + rnd()) * dcs;
      const lit = probe(fx, fz);
      if (lit < 0) continue;
      const open = 1 - field.forest(fx, fz);
      if (rnd() > 0.03 + open * 0.09) continue; // tasteful, not a carpet
      const y = field.height(fx, fz);
      const size = 0.65 + rnd() * 0.6;
      // Lone blooms pick freely from the catalog — a stray poppy or cornflower
      // among the daisies reads as a happy accident, never a planted row.
      emitFlower(acc, pickSpecies(rnd), fx, y + 0.06, fz, size, lit, rnd, rnd() < 0.08);
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
