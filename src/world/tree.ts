import * as THREE from 'three/webgpu';
import { mulberry32, hash2 } from '../core/rng';
import { palette } from '../render/palette';
import { TerrainField } from './TerrainField';
import { CHUNK_SIZE, WORLD_SEED } from '../config';

// Procedural tree generator. Each tree is a recursive branching skeleton built
// from tapered cylinders (a real trunk + boughs) topped with a canopy of splat
// dabs — keeping foliage in the same painterly point-cloud language as the
// terrain while the trunk stays solid geometry.
//
// To stay cheap we generate a handful of seeded PROTOTYPES once (stored in
// local space, base at the origin). Chunks then scatter instances by rotating /
// scaling / tinting the prototype arrays directly — no per-tree geometry
// allocation, no repetition (variation comes from instance transform + which of
// many prototypes is picked).

export type TreeType = 'deciduous' | 'conifer' | 'bush';

export interface TreeProto {
  type: TreeType;
  trunkPos: Float32Array;
  trunkNor: Float32Array;
  trunkCol: Float32Array;
  folPos: Float32Array; // xyz per canopy dab (local)
  folScale: Float32Array;
  folCol: Float32Array;
  folWind: Float32Array; // per-dab sway strength
  folAngle: Float32Array; // per-dab stroke orientation
  folAspect: Float32Array; // per-dab stroke width/length
  height: number;
  canopyR: number; // for spacing
}

// ---- scratch ----
const _dir = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _up = new THREE.Vector3();
const _col = new THREE.Color();
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);

// Precomputed unit-ring trig for cylinder cross-sections. Built lazily per
// segment count and cached, so emitCylinder never recomputes cos/sin nor
// allocates per-vertex Vector3s in the (hot) prototype-build loop.
const _ringCache = new Map<number, { cx: Float32Array; sx: Float32Array }>();
function ringTrig(segs: number) {
  let r = _ringCache.get(segs);
  if (!r) {
    const cx = new Float32Array(segs + 1);
    const sx = new Float32Array(segs + 1);
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      cx[i] = Math.cos(a);
      sx[i] = Math.sin(a);
    }
    r = { cx, sx };
    _ringCache.set(segs, r);
  }
  return r;
}

// Extra bark tones for gnarlier, less uniform trunks — a grey-lichen cast and a
// warmer russet so not every trunk is the same chocolate brown.
const BARK_GREY = new THREE.Color('#6e6a5a');
const BARK_RUST = new THREE.Color('#7a5230');

// Returns the SHARED `_col` scratch (no allocation) — every caller reads
// `.r/.g/.b` immediately, before the next colour is computed, so a clone would
// be pure churn across thousands of trunk segments during prototype build.
function barkColor(rnd: () => number, tone = 0): THREE.Color {
  // `tone` (a per-tree personality, 0..1) biases the whole trunk toward grey
  // lichen or warm russet so trees don't all share one bark.
  _col.copy(palette.bark).lerp(palette.barkDark, rnd() * 0.6);
  if (tone < 0.33) _col.lerp(BARK_GREY, 0.18 + rnd() * 0.22);
  else if (tone > 0.66) _col.lerp(BARK_RUST, 0.15 + rnd() * 0.2);
  return _col.offsetHSL((rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.1);
}

const clamp = THREE.MathUtils.clamp;

// Light-coupled foliage colour — the same technique that made the turf read:
// the canopy's baked lighting (`lit`, 0 deep interior shade .. 1 sunlit crown)
// drives hue AND lightness, so sunlit leaves warm toward lime and shaded leaves
// deepen toward saturated blue-green. Nothing here multiplies by a separate
// shade term (the light is baked in), so no near-black dabs stick out.
//
// `warmth` is a per-tree personality term (−1 cool blue-green .. +1 warm
// golden-green): it shifts the whole canopy's hue/saturation/lightness so a wood
// reads as MANY distinct trees — deep emerald, cool blue-green, bright lime, and
// the odd golden-turning tree — instead of one flat green. It's set once per
// prototype (not per dab), and it now swings WIDE (see the prototype builders).
//
// CONTRAST: the canopy is pitched deliberately DEEPER, RICHER and COOLER than the
// meadow turf (turf base hue ≈ 0.21–0.31, lighter & a touch less saturated) so the
// crowns read as distinct masses against the bright chartreuse grass rather than
// melting into it. A negative `warmth` pushes a tree cool/emerald (hue → ~0.40);
// a strong positive `warmth` can carry a tree all the way to a golden turning
// hue (down toward ~0.13), the rare autumn note.
function foliageColor(rnd: () => number, type: TreeType, lit: number, warmth = 0): THREE.Color {
  let h: number, s: number, l: number;
  // A golden-turning tree (strong positive warmth): swing hard toward amber/ochre
  // and drop the green entirely — the rare standout in the wood.
  const golden = Math.max(0, warmth - 0.55) / 0.45; // 0 until warmth>0.55, →1 by 1.0
  if (type === 'conifer') {
    // deep spruce blue-green; stays cool, saturated and DARK so the conifers anchor
    // the wood as the deepest masses, lit tips lift a little toward teal-green.
    h = 0.40 - lit * 0.04 - warmth * 0.03 + (rnd() - 0.5) * 0.03; // cool spruce, distinct from turf
    s = 0.52 + (1 - lit) * 0.12 + rnd() * 0.06; // rich (not muddy)
    l = 0.22 + lit * 0.24 + (rnd() - 0.5) * 0.05; // deepest masses but no near-black
  } else if (type === 'bush') {
    // warmer, brighter yellow-greens for low foliage catching light — but pulled a
    // touch deeper/cooler than before so even ground cover separates from turf.
    h = 0.34 - lit * 0.05 - warmth * 0.04 + (rnd() - 0.5) * 0.035;
    s = 0.55 + (1 - lit) * 0.1 + rnd() * 0.06; // lush
    l = 0.30 + lit * 0.26 + warmth * 0.02 + (rnd() - 0.5) * 0.06; // no near-black
  } else {
    // broadleaf: deep cool emerald in shade → richer green crowns in sun, swung by
    // per-tree warmth across emerald (cool) ↔ chartreuse ↔ the odd golden turning
    // tree. Base hue sits cooler (~0.36) and lightness lower than the turf for pop.
    h = 0.37 - lit * 0.05 - warmth * 0.08 + (rnd() - 0.5) * 0.03; // a touch cooler than turf → separates
    s = 0.58 + (1 - lit) * 0.1 + warmth * 0.05 + rnd() * 0.05; // lush, clean (not muddy)
    l = 0.26 + lit * 0.28 + warmth * 0.04 + (rnd() - 0.5) * 0.07; // deeper than turf, no black
  }
  // Golden-turning override (broadleaf/bush only): blend the whole dab toward a
  // warm autumn ochre as `golden` rises, so a handful of trees clearly turn.
  if (golden > 0 && type !== 'conifer') {
    h = h * (1 - golden) + (0.115 + lit * 0.02) * golden; // → amber/gold
    s = s * (1 - golden) + (0.74 + lit * 0.1) * golden;
    l = l * (1 - golden) + (0.32 + lit * 0.28) * golden;
  }
  // Returns the SHARED `_col` (no clone): the result is read straight into the
  // colour buffer before the next dab is computed.
  return _col.setHSL(clamp(h, 0, 1), clamp(s, 0, 1), clamp(l, 0.18, 0.95)); // floor 0.18 → no near-black foliage
}

/** Append a tapered cylinder between a→b into the trunk arrays.
 *
 * Normals point outward along the (slightly cone-tilted) side so the bark
 * catches the sun smoothly instead of reading as hard flat facets — and the
 * whole ring is built from a cached trig table with NO per-vertex allocation,
 * which is the bulk of the prototype-build cost. */
function emitCylinder(
  tp: number[], tn: number[], tc: number[],
  a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number,
  color: THREE.Color, segs = 6,
) {
  _dir.subVectors(b, a);
  const len = _dir.length();
  if (len < 1e-4) return;
  _dir.divideScalar(len);
  _up.copy(Math.abs(_dir.y) > 0.99 ? X : Y);
  _t1.crossVectors(_dir, _up).normalize();
  _t2.crossVectors(_dir, _t1).normalize();
  const t1x = _t1.x, t1y = _t1.y, t1z = _t1.z;
  const t2x = _t2.x, t2y = _t2.y, t2z = _t2.z;
  const ax = a.x, ay = a.y, az = a.z;
  const bx = b.x, by = b.y, bz = b.z;
  // Side slope: the surface normal tilts along the axis as the radius tapers, so
  // it isn't purely radial (a true cone normal) — subtle, but it keeps the
  // taper from looking like a stack of rings under the directional light.
  const slope = (ra - rb) / len;
  const adx = _dir.x * slope, ady = _dir.y * slope, adz = _dir.z * slope;
  const { cx: rc, sx: rs } = ringTrig(segs);
  const cr = color.r, cg = color.g, cb = color.b;

  for (let i = 0; i < segs; i++) {
    const d0x = rc[i], d0y = rs[i];
    const d1x = rc[i + 1], d1y = rs[i + 1];
    // outward ring directions (radial), then add the axial tilt for the normal
    const r0x = t1x * d0x + t2x * d0y, r0y = t1y * d0x + t2y * d0y, r0z = t1z * d0x + t2z * d0y;
    const r1x = t1x * d1x + t2x * d1y, r1y = t1y * d1x + t2y * d1y, r1z = t1z * d1x + t2z * d1y;
    let n0x = r0x + adx, n0y = r0y + ady, n0z = r0z + adz;
    let n1x = r1x + adx, n1y = r1y + ady, n1z = r1z + adz;
    const il0 = 1 / Math.hypot(n0x, n0y, n0z); n0x *= il0; n0y *= il0; n0z *= il0;
    const il1 = 1 / Math.hypot(n1x, n1y, n1z); n1x *= il1; n1y *= il1; n1z *= il1;
    // ring vertices
    const A0x = ax + r0x * ra, A0y = ay + r0y * ra, A0z = az + r0z * ra;
    const A1x = ax + r1x * ra, A1y = ay + r1y * ra, A1z = az + r1z * ra;
    const B0x = bx + r0x * rb, B0y = by + r0y * rb, B0z = bz + r0z * rb;
    const B1x = bx + r1x * rb, B1y = by + r1y * rb, B1z = bz + r1z * rb;
    tp.push(A0x, A0y, A0z, B0x, B0y, B0z, B1x, B1y, B1z);
    tn.push(n0x, n0y, n0z, n0x, n0y, n0z, n1x, n1y, n1z);
    tp.push(A0x, A0y, A0z, B1x, B1y, B1z, A1x, A1y, A1z);
    tn.push(n0x, n0y, n0z, n1x, n1y, n1z, n1x, n1y, n1z);
    for (let k = 0; k < 6; k++) tc.push(cr, cg, cb);
  }
}

/** Tilt a direction by `angle` around a random azimuth, with an upward bias. */
function perturb(out: THREE.Vector3, dir: THREE.Vector3, angle: number, upBias: number, rnd: () => number) {
  _up.copy(Math.abs(dir.y) > 0.99 ? X : Y);
  _t1.crossVectors(dir, _up).normalize();
  _t2.crossVectors(dir, _t1).normalize();
  const az = rnd() * Math.PI * 2;
  const tiltx = Math.cos(az), tilty = Math.sin(az);
  out.copy(dir).multiplyScalar(Math.cos(angle));
  out.addScaledVector(_t1, Math.sin(angle) * tiltx);
  out.addScaledVector(_t2, Math.sin(angle) * tilty);
  out.y += upBias;
  return out.normalize();
}

interface BlobOpts {
  warmth?: number; // per-tree colour personality, passed to foliageColor
  squash?: number; // vertical squash of the cluster (1 = round, <1 = flatter)
  droop?: number; // leaves sag downward at the rim (weeping/old crowns)
  litBias?: number; // shift overall canopy light (deep shade interiors go negative)
  scaleVar?: number; // extra randomness in dab size for a rougher silhouette
}

function emitBlob(
  fp: number[], fs: number[], fc: number[], fw: number[], fa: number[], fasp: number[],
  cx: number, cy: number, cz: number, radius: number, count: number,
  baseScale: number, windBase: number, type: TreeType, rnd: () => number,
  opts: BlobOpts = {},
) {
  const warmth = opts.warmth ?? 0;
  const squash = opts.squash ?? 0.85;
  const droop = opts.droop ?? 0;
  const litBias = opts.litBias ?? 0;
  const scaleVar = opts.scaleVar ?? 0.7;
  const inv = 1 / (radius + 1e-3);
  for (let i = 0; i < count; i++) {
    // random point in a squashed sphere; bias toward the shell (more mass on the
    // lit outer crown, hollower interior → reads as real foliage, not a fog ball)
    const u = rnd() * 2 - 1;
    const phi = rnd() * Math.PI * 2;
    const r = radius * (0.45 + 0.55 * Math.cbrt(rnd()));
    const s = Math.sqrt(1 - u * u);
    let ox = Math.cos(phi) * s * r;
    let oy = u * r * squash;
    let oz = Math.sin(phi) * s * r;
    // organic lumps: pull a few percent of dabs outward along their azimuth so
    // the silhouette bulges and dents instead of being a perfect ball
    if (rnd() < 0.22) {
      const bulge = 1 + rnd() * 0.5;
      ox *= bulge; oz *= bulge;
    }
    // rim droop: outer leaves sag, strongest on the lower hemisphere
    if (droop > 0) {
      const rimAo = Math.sqrt(ox * ox + oz * oz) * inv;
      oy -= droop * radius * rimAo * rimAo * (oy < 0 ? 1.4 : 0.5);
    }
    fp.push(cx + ox, cy + oy, cz + oz);
    // Size couples weakly to depth in the canopy: the lit shell carries slightly
    // bigger, bolder leaf-strokes while the shaded interior fills with smaller,
    // denser dabs — a layered crown rather than uniform-sized confetti.
    const shell = Math.sqrt(ox * ox + oy * oy + oz * oz) * inv; // 0 core .. 1 rim
    fs.push(baseScale * (0.7 + rnd() * scaleVar) * (0.86 + 0.24 * shell));
    // Leaf-clump dabs read as loose brush-marks: mostly round, but a fraction
    // are pulled into short oval strokes (aspect up to ~1.5) with a free
    // screen-space orientation so the crown shimmers as painted dabs, not discs.
    // (aAngle is a 2-D billboard rotation, so a random angle is correct here.)
    fa.push(rnd() * Math.PI);
    fasp.push(rnd() < 0.35 ? 1.12 + rnd() * 0.4 : 0.86 + rnd() * 0.26);
    // Baked canopy light → drives the colour: top-lit, sun-facing brightened,
    // rim catching light, interior in shade. No separate shade multiply.
    const topness = oy * inv * 0.5 + 0.5;
    const aoR = shell; // distance-from-core, already computed above
    const sun = (ox * -0.5 + oz * -0.62) * inv;
    const lit = clamp(0.32 + litBias + 0.42 * topness + 0.18 * aoR + 0.12 * sun, 0, 1);
    const c = foliageColor(rnd, type, lit, warmth);
    fc.push(c.r, c.g, c.b);
    // outer/upper leaves sway most
    fw.push(windBase * (0.5 + 0.5 * topness) * (0.7 + 0.5 * aoR));
  }
}

// Per-tree shape personality, set once per prototype and threaded through the
// recursion so a whole tree shares a coherent character (warmth, gnarliness,
// droop, how deep it branches) rather than every branch being independent.
interface TreeChar {
  warmth: number; // colour temperature, −1 cool .. +1 warm
  tone: number; // bark tone bias 0..1
  gnarl: number; // 0 straight .. 1 very crooked branches
  droop: number; // canopy rim sag
  maxDepth: number; // recursion depth (3 tidy .. 5 sprawling)
}

function growBranch(
  tp: number[], tn: number[], tc: number[],
  fp: number[], fs: number[], fc: number[], fw: number[], fa: number[], fasp: number[],
  a: THREE.Vector3, dir: THREE.Vector3, len: number, rad: number, depth: number,
  ch: TreeChar, rnd: () => number,
) {
  // Grow the limb as 2 short curving sub-segments so boughs bend & wander
  // (gnarlier trees curve more) instead of being dead-straight sticks.
  const segs = 2;
  let p = a.clone();
  const d = dir.clone();
  for (let s = 0; s < segs; s++) {
    const segLen = len / segs;
    const t = (s + 1) / segs;
    const next = p.clone().addScaledVector(d, segLen);
    emitCylinder(tp, tn, tc, p, next, rad * (1 - 0.14 * (s / segs)), rad * (1 - 0.14 * t) * 0.86, barkColor(rnd, ch.tone), 6);
    p = next;
    // bend the heading a touch — gravity pull + crooked wander
    perturb(d, d, ch.gnarl * (0.12 + rnd() * 0.28), -0.04 + rnd() * 0.06, rnd);
  }
  const b = p;

  if (depth >= ch.maxDepth || rad < 0.085) {
    // a tip leaf-cluster; weeping/old trees let it droop, warmth carries through
    emitBlob(
      fp, fs, fc, fw, fa, fasp, b.x, b.y, b.z, 1.7 + rad * 3.2,
      16 + Math.floor(rnd() * 16), 2.0, 0.85, 'deciduous', rnd,
      { warmth: ch.warmth, droop: ch.droop, squash: 0.82, litBias: -0.04 },
    );
    return;
  }
  // irregular splitting: usually fork, often a single wandering extension,
  // rarely a wide three-way — keeps the crown from looking dichotomous/tidy while
  // holding the exponential tip count in check.
  const roll = rnd();
  const n = roll < 0.32 ? 1 : roll < 0.9 ? 2 : 3;
  const nd = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    // wider, more varied splay on gnarlier trees
    perturb(nd, d, 0.4 + rnd() * (0.5 + ch.gnarl * 0.4), 0.14 + rnd() * 0.1, rnd);
    growBranch(
      tp, tn, tc, fp, fs, fc, fw, fa, fasp, b, nd.clone(),
      len * (0.66 + rnd() * 0.18), rad * (0.6 + rnd() * 0.12), depth + 1, ch, rnd,
    );
  }
}

// Deciduous archetypes — four distinct silhouettes so a wood is a mix of forms,
// not one shape rescaled: a broad spreading oak, a tall slim birch-ish tree, a
// low gnarled old-timer, and a weeping/drooping crown.
type Decid = 'spread' | 'tall' | 'gnarled' | 'weeping';

function buildDeciduous(rnd: () => number): TreeProto {
  const tp: number[] = [], tn: number[] = [], tc: number[] = [];
  const fp: number[] = [], fs: number[] = [], fc: number[] = [], fw: number[] = [], fa: number[] = [], fasp: number[] = [];

  const kindRoll = rnd();
  const kind: Decid = kindRoll < 0.4 ? 'spread' : kindRoll < 0.68 ? 'tall' : kindRoll < 0.86 ? 'gnarled' : 'weeping';

  // per-tree personality. Warmth swings WIDE so the wood spans deep cool emerald,
  // blue-green, bright lime, and the odd golden-turning tree. Biased toward the
  // cool/neutral half (most trees deep green), with a long warm tail: cubing a
  // signed [-1,1] keeps the bulk near neutral while letting the rare tree reach
  // the golden override (warmth > 0.55) — tasteful Ghibli spread, not uniform neon.
  const wRoll = rnd() * 2 - 1; // [-1,1]
  const ch: TreeChar = {
    warmth: clamp(wRoll * wRoll * wRoll * 0.6 + wRoll * 0.5 - 0.18, -1, 1),
    tone: rnd(),
    gnarl: kind === 'gnarled' ? 0.7 + rnd() * 0.3 : kind === 'weeping' ? 0.45 + rnd() * 0.3 : 0.2 + rnd() * 0.35,
    droop: kind === 'weeping' ? 0.4 + rnd() * 0.25 : kind === 'gnarled' ? 0.12 + rnd() * 0.12 : rnd() * 0.08,
    // depth 3..4 — branch tips fan out exponentially, so this is the main lever
    // on per-tree cost; the wild look comes from the lobed canopy + warmth, not
    // from a deeper, heavier branch tree.
    maxDepth: kind === 'tall' ? 3 : kind === 'gnarled' ? 4 : 3 + (rnd() < 0.45 ? 1 : 0),
  };

  let trunkH: number, trunkR: number, leanAmt: number;
  if (kind === 'tall') { trunkH = 12 + rnd() * 7; trunkR = 0.34 + rnd() * 0.22; leanAmt = rnd() * 0.1; }
  else if (kind === 'gnarled') { trunkH = 6 + rnd() * 3.5; trunkR = 0.55 + rnd() * 0.4; leanAmt = 0.14 + rnd() * 0.22; }
  else if (kind === 'spread') { trunkH = 7 + rnd() * 4; trunkR = 0.46 + rnd() * 0.34; leanAmt = rnd() * 0.16; }
  else { trunkH = 8 + rnd() * 4; trunkR = 0.4 + rnd() * 0.26; leanAmt = rnd() * 0.14; }

  // a curved trunk in 3 segments — bends as it rises so even the bole wanders
  const tsegs = 3;
  const heading = perturb(new THREE.Vector3(), Y, leanAmt, 0, rnd);
  let prev = new THREE.Vector3(0, 0, 0);
  const top = prev.clone();
  for (let s = 0; s < tsegs; s++) {
    const segLen = trunkH / tsegs;
    const next = prev.clone().addScaledVector(heading, segLen);
    const r0 = trunkR * (1 - 0.22 * (s / tsegs));
    const r1 = trunkR * (1 - 0.22 * ((s + 1) / tsegs));
    emitCylinder(tp, tn, tc, prev, next, r0, r1, barkColor(rnd, ch.tone), 8);
    prev = next;
    top.copy(next);
    // lean grows / wanders up the trunk (gnarled trees curve most)
    perturb(heading, heading, ch.gnarl * (0.06 + rnd() * 0.12), 0.02, rnd);
  }

  // boughs spreading from the crown — count & splay vary by archetype
  const boughs =
    kind === 'spread' ? 4 + Math.floor(rnd() * 3) :
    kind === 'gnarled' ? 3 + Math.floor(rnd() * 3) :
    kind === 'tall' ? 2 + Math.floor(rnd() * 2) : 3 + Math.floor(rnd() * 3);
  const splay = kind === 'spread' ? 0.85 : kind === 'gnarled' ? 1.0 : 0.5;
  const nd = new THREE.Vector3();
  for (let i = 0; i < boughs; i++) {
    perturb(nd, heading, splay * (0.5 + rnd() * 0.6), kind === 'tall' ? 0.22 : 0.1, rnd);
    growBranch(
      tp, tn, tc, fp, fs, fc, fw, fa, fasp, top, nd.clone(),
      trunkH * (0.34 + rnd() * 0.24), trunkR * (0.5 + rnd() * 0.16), 1, ch, rnd,
    );
  }

  // Asymmetric canopy: a cluster of overlapping blobs of different size, with a
  // dim deeply-shaded core and brighter lobes around it, the whole thing pushed
  // off-centre so no two trees crown the same. Tall trees keep a tighter column,
  // spread trees a wide flattened parasol.
  const canopyR = trunkH * (kind === 'tall' ? 0.34 + rnd() * 0.12 : kind === 'spread' ? 0.6 + rnd() * 0.22 : 0.48 + rnd() * 0.18);
  const cTop = top.clone();
  const cBase = canopyR * (kind === 'spread' ? 0.32 : kind === 'weeping' ? 0.5 : 0.42);
  const lobes = 3 + Math.floor(rnd() * 3);
  // shaded inner mass first (deep core)
  emitBlob(
    fp, fs, fc, fw, fa, fasp, cTop.x, cTop.y + cBase, cTop.z, canopyR * 0.78,
    140 + Math.floor(rnd() * 80), 2.6, 0.85, 'deciduous', rnd,
    { warmth: ch.warmth, droop: ch.droop * 0.5, squash: kind === 'spread' ? 0.7 : 0.9, litBias: -0.16, scaleVar: 0.6 },
  );
  // surrounding lit lobes, offset around and above
  for (let i = 0; i < lobes; i++) {
    const ang = (i / lobes) * Math.PI * 2 + rnd() * 1.2;
    const off = canopyR * (0.35 + rnd() * 0.4);
    const lr = canopyR * (0.5 + rnd() * 0.42);
    const lx = cTop.x + Math.cos(ang) * off;
    const lz = cTop.z + Math.sin(ang) * off;
    const ly = cTop.y + cBase + canopyR * (0.15 + rnd() * 0.5);
    emitBlob(
      fp, fs, fc, fw, fa, fasp, lx, ly, lz, lr,
      70 + Math.floor(rnd() * 70), 2.5, 0.95, 'deciduous', rnd,
      { warmth: ch.warmth, droop: ch.droop, squash: kind === 'spread' ? 0.72 : 0.86, litBias: 0.04, scaleVar: 0.75 },
    );
  }

  const fullH = trunkH + canopyR * 1.6;
  return finalize('deciduous', tp, tn, tc, fp, fs, fc, fw, fa, fasp, fullH, canopyR * 1.15);
}

function buildConifer(rnd: () => number): TreeProto {
  const tp: number[] = [], tn: number[] = [], tc: number[] = [];
  const fp: number[] = [], fs: number[] = [], fc: number[] = [], fw: number[] = [], fa: number[] = [], fasp: number[] = [];

  // per-tree personality: cool spruce vs. a slightly warmer fir; some spindly &
  // tall, some squat & broad; the odd crooked, weather-bent old spire. Conifers
  // stay firmly cool (deepest masses in the wood) but spread a little wider now so
  // the stand isn't one flat spruce-blue — never warm enough to "turn".
  const warmth = (rnd() - 0.62) * 1.15; // skews cool, ~[-0.71, +0.44]
  const tone = rnd();
  const slender = 0.7 + rnd() * 0.6; // <1 squat .. >1 spindly
  const bent = rnd() < 0.35 ? 0.1 + rnd() * 0.12 : rnd() * 0.05;

  const H = 11 + rnd() * 10;
  const R = 0.32 + rnd() * 0.24;
  // a slightly leaning, gently curving spire (weather-bent on some)
  const heading = perturb(new THREE.Vector3(), Y, bent, 0, rnd);
  let prev = new THREE.Vector3(0, 0, 0);
  const apex = prev.clone();
  for (let s = 1; s <= 3; s++) {
    const next = prev.clone().addScaledVector(heading, H / 3);
    emitCylinder(tp, tn, tc, prev, next, R * (1 - (s - 1) / 3) + 0.04, R * (1 - s / 3) + 0.03, barkColor(rnd, tone), 6);
    prev = next;
    apex.copy(next);
    perturb(heading, heading, bent * (0.4 + rnd() * 0.6), 0.01, rnd);
  }
  // axis offset at a given height (the spire isn't vertical)
  const axisAt = (cy: number) => {
    const f = clamp(cy / H, 0, 1);
    return { x: apex.x * f, z: apex.z * f };
  };

  // conical tiered foliage: rings shrinking toward a pointed top, but with the
  // tier heights/radii jittered and a couple of lopsided gaps so the cone isn't
  // a stamped Christmas-tree. Skirt tiers droop & overhang.
  const baseR = H * (0.24 + rnd() * 0.12) / slender;
  const tiers = 6 + Math.floor(rnd() * 4);
  for (let t = 0; t < tiers; t++) {
    const f = (t + (rnd() - 0.5) * 0.5) / (tiers - 1); // 0 base .. 1 top, jittered
    const ff = clamp(f, 0, 1);
    const cy = H * (0.16 + ff * 0.8);
    const ringR = (baseR * Math.pow(1 - ff, 1.15) + 0.4);
    const ax = axisAt(cy);
    // lopsided fullness: each tier favours one side a little
    const lop = rnd() * Math.PI * 2;
    const lopAmt = 0.2 + rnd() * 0.35;
    const dabs = Math.round(14 + (1 - ff) * 40);
    for (let i = 0; i < dabs; i++) {
      const ang = rnd() * Math.PI * 2;
      const sideBias = 1 + Math.cos(ang - lop) * lopAmt;
      const rr = ringR * (0.35 + rnd() * 0.65) * sideBias;
      const droop = (1 - ff) * ringR * 0.18; // skirts hang
      fp.push(
        Math.cos(ang) * rr + ax.x,
        cy + (rnd() - 0.5) * ringR * 0.3 - droop,
        Math.sin(ang) * rr + ax.z,
      );
      fs.push((1.2 + rnd() * 1.0) * (0.7 + (1 - ff) * 0.7));
      // baked light: lower skirts in shadow, top tiers lit, sun-facing brightened,
      // deep interior near the trunk goes darkest (richer, layered cone)
      const aoR = rr / (ringR + 1e-3);
      const sun = Math.cos(ang) * -0.5 + Math.sin(ang) * -0.62;
      const lit = clamp(0.24 + 0.44 * ff + 0.2 * aoR + 0.12 * sun, 0, 1);
      const c = foliageColor(rnd, 'conifer', lit, warmth);
      fc.push(c.r, c.g, c.b);
      fw.push(0.5 * (0.3 + 0.7 * ff)); // conifers are stiffer; tips sway a little
      fa.push(ang + Math.PI / 2 + (rnd() - 0.5) * 0.6); // sprays radiate from the spire
      fasp.push(1.0 + rnd() * 0.28); // mild elongation → needle-spray feel
    }
  }
  return finalize('conifer', tp, tn, tc, fp, fs, fc, fw, fa, fasp, H, baseR);
}

function finalize(
  type: TreeType,
  tp: number[], tn: number[], tc: number[],
  fp: number[], fs: number[], fc: number[], fw: number[], fa: number[], fasp: number[],
  height: number, canopyR: number,
): TreeProto {
  return {
    type,
    trunkPos: Float32Array.from(tp),
    trunkNor: Float32Array.from(tn),
    trunkCol: Float32Array.from(tc),
    folPos: Float32Array.from(fp),
    folScale: Float32Array.from(fs),
    folCol: Float32Array.from(fc),
    folWind: Float32Array.from(fw),
    folAngle: Float32Array.from(fa),
    folAspect: Float32Array.from(fasp),
    height,
    canopyR,
  };
}

/**
 * A bush. Two kinds: flowering shrubs (rounded, carry blossoms + berries) and
 * low wide scrub (flatter, leafier, sparse flowers) — together they fill the
 * landscape with varied ground cover.
 */
function buildBush(rnd: () => number, scrub: boolean): TreeProto {
  const fp: number[] = [], fs: number[] = [], fc: number[] = [], fw: number[] = [], fa: number[] = [], fasp: number[] = [];
  const warmth = (rnd() - 0.38) * 1.5; // bushes skew warm/bright, wider spread now (~[-0.57, +0.93])
  const R = scrub ? 1.9 + rnd() * 2.6 : 1.2 + rnd() * 1.6;
  const cy = R * (scrub ? 0.42 : 0.7); // scrub sits lower & wider
  // overlapping leafy mounds — scrub spreads into 2-5 clumps of varied size,
  // shrubs are sometimes a single mound, sometimes a lumpy pair
  const mounds = scrub ? 2 + Math.floor(rnd() * 4) : 1 + (rnd() < 0.55 ? 1 : 0);
  for (let m = 0; m < mounds; m++) {
    const spread = scrub ? 1.2 : 0.8;
    const mx = (rnd() - 0.5) * R * spread;
    const mz = (rnd() - 0.5) * R * spread;
    const mr = scrub ? R * (0.45 + rnd() * 0.45) : R * (0.8 + rnd() * 0.3);
    emitBlob(
      fp, fs, fc, fw, fa, fasp, mx, cy + (rnd() - 0.5) * R * 0.3, mz, mr,
      40 + Math.floor(rnd() * 45), 1.4, 0.42, 'bush', rnd,
      { warmth, squash: scrub ? 0.6 : 0.8, droop: scrub ? 0.18 : rnd() * 0.1, litBias: -0.04, scaleVar: 0.8 },
    );
  }
  // blossoms + berries scattered over the crown (scrub gets far fewer)
  const decor = scrub ? 3 + Math.floor(rnd() * 6) : 14 + Math.floor(rnd() * 18);
  for (let i = 0; i < decor; i++) {
    const u = rnd() * 2 - 1;
    const phi = rnd() * Math.PI * 2;
    const rr = R * (0.6 + rnd() * 0.45);
    const s = Math.sqrt(1 - u * u);
    const px = Math.cos(phi) * s * rr;
    const py = cy + Math.abs(u) * rr * 0.7; // bias to the upper surface
    const pz = Math.sin(phi) * s * rr;
    const r = rnd();
    if (r < 0.30) _col.copy(palette.blossom);
    else if (r < 0.52) _col.copy(palette.flowerViolet); // ~22% violet punctuation
    else if (r < 0.66) _col.copy(palette.flowerYellow);
    else if (r < 0.85) _col.copy(palette.berryRed);
    else _col.copy(palette.berryDeep);
    _col.offsetHSL((rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.06);
    fp.push(px, py, pz);
    fs.push(0.7 + rnd() * 0.7); // small bright accents
    fc.push(_col.r, _col.g, _col.b);
    fw.push(0.3 + rnd() * 0.2);
    fa.push(rnd() * Math.PI); // blossoms/berries are round dabs
    fasp.push(0.92 + rnd() * 0.16);
  }
  return finalize('bush', [], [], [], fp, fs, fc, fw, fa, fasp, R * 1.6, R);
}

/** Build the tree prototype library once. A bigger, more varied library means a
 * wood reads as many individuals — far less obvious repetition than before. */
export function createTreePrototypes(seed: number): TreeProto[] {
  const protos: TreeProto[] = [];
  for (let i = 0; i < 11; i++) protos.push(buildDeciduous(mulberry32((seed * 131 + i * 17 + 1) >>> 0)));
  for (let i = 0; i < 7; i++) protos.push(buildConifer(mulberry32((seed * 197 + i * 23 + 7) >>> 0)));
  return protos;
}

/** Build the bush prototype library once — a mix of flowering shrubs and scrub. */
export function createBushPrototypes(seed: number): TreeProto[] {
  const protos: TreeProto[] = [];
  for (let i = 0; i < 9; i++) protos.push(buildBush(mulberry32((seed * 251 + i * 29 + 3) >>> 0), false));
  for (let i = 0; i < 9; i++) protos.push(buildBush(mulberry32((seed * 311 + i * 37 + 9) >>> 0), true));
  return protos;
}

export interface ChunkTrees {
  trunkPos: Float32Array;
  trunkNor: Float32Array;
  trunkCol: Float32Array;
  folCenter: Float32Array;
  folScale: Float32Array;
  folCol: Float32Array;
  folWind: Float32Array;
  folAngle: Float32Array;
  folAspect: Float32Array;
  bound: THREE.Sphere;
}

/**
 * Scatter trees and bushes across a chunk and bake them into merged arrays by
 * transforming the chosen prototypes (yaw + uniform scale + translate, plus a
 * colour tint). Trees contribute trunk geometry + foliage; bushes only foliage.
 */
export function scatterTrees(
  field: TerrainField, cx: number, cz: number,
  treeProtos: TreeProto[], bushProtos: TreeProto[],
): ChunkTrees | null {
  const S = CHUNK_SIZE;
  const ox = cx * S;
  const oz = cz * S;
  const rnd = mulberry32(hash2(cx, cz, (WORLD_SEED ^ 0x77ee) >>> 0));

  const tp: number[] = [], tn: number[] = [], tc: number[] = [];
  const fcen: number[] = [], fsc: number[] = [], fcol: number[] = [], fwd: number[] = [], fang: number[] = [], fasp: number[] = [];
  let minY = Infinity, maxY = -Infinity;
  let placed = 0;
  // Ground shadows fall away from the sun (sun ≈ [-0.5,0.55,-0.62]).
  const sdx = 0.627, sdz = 0.778;
  const shadowAngle = Math.atan2(sdz, sdx); // strokes dragged along the shadow

  // Stamp a prototype's foliage into the chunk arrays at a transform.
  const stampFoliage = (
    proto: TreeProto, x: number, y: number, z: number,
    scale: number, cyaw: number, syaw: number, tint: number,
  ) => {
    const fpos = proto.folPos, fscl = proto.folScale, fc = proto.folCol, fwi = proto.folWind;
    const fan = proto.folAngle, fas = proto.folAspect;
    for (let k = 0; k < fpos.length; k += 3) {
      const kk = k / 3;
      const lx = fpos[k] * scale, ly = fpos[k + 1] * scale, lz = fpos[k + 2] * scale;
      const wx = lx * cyaw + lz * syaw + x;
      const wz = -lx * syaw + lz * cyaw + z;
      const wy = ly + y;
      fcen.push(wx, wy, wz);
      fsc.push(fscl[kk] * scale);
      fcol.push(fc[k] * tint, fc[k + 1] * tint, fc[k + 2] * tint);
      fwd.push(fwi[kk]);
      fang.push(fan[kk]); // screen-space stroke angle — independent of world yaw
      fasp.push(fas[kk]);
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
    }
  };

  // ---- trees: trunk geometry + foliage + contact shadow ----
  const cells = 13; // finer scatter grid → more, better-spaced trees
  const cellSize = S / cells;
  for (let gz = 0; gz < cells; gz++) {
    for (let gx = 0; gx < cells; gx++) {
      const x = ox + (gx + rnd()) * cellSize;
      const z = oz + (gz + rnd()) * cellSize;
      const surf = field.surface(x, z);
      if (surf.path > 0.2 || surf.rock > 0.4 || surf.slope > 0.46) continue;
      const dens = field.forest(x, z);
      // clumped into woodland (dense), clearings stay open
      if (rnd() > 0.42 * (0.35 + dens)) continue;

      const proto = treeProtos[Math.floor(rnd() * treeProtos.length)];
      // Long-tailed size: most trees mid-sized, many smaller, but the odd
      // towering elder and the occasional sapling — a wild, uneven canopy line
      // instead of one uniform height band.
      const sr = rnd();
      const scale = sr < 0.12 ? 0.55 + rnd() * 0.3        // saplings / undergrowth
        : sr > 0.92 ? 1.7 + rnd() * 1.0                    // rare giants
        : 0.85 + rnd() * 0.85;                             // the common range
      const yaw = rnd() * Math.PI * 2;
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const y = field.height(x, z) - 0.3;
      const tint = 0.88 + rnd() * 0.22;

      const tpos = proto.trunkPos, tnor = proto.trunkNor, tcol = proto.trunkCol;
      for (let k = 0; k < tpos.length; k += 3) {
        const lx = tpos[k] * scale, ly = tpos[k + 1] * scale, lz = tpos[k + 2] * scale;
        const wx = lx * cy + lz * sy + x;
        const wz = -lx * sy + lz * cy + z;
        const wy = ly + y;
        tp.push(wx, wy, wz);
        const nx = tnor[k], nz = tnor[k + 2];
        tn.push(nx * cy + nz * sy, tnor[k + 1], -nx * sy + nz * cy);
        tc.push(tcol[k] * tint, tcol[k + 1] * tint, tcol[k + 2] * tint);
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
      }
      stampFoliage(proto, x, y, z, scale, cy, sy, tint);

      // soft cast-shadow pool, offset & elongated away from the sun
      const shN = 18 + Math.floor(rnd() * 14);
      const shR = proto.canopyR * scale * 0.85;
      const scx = x + sdx * shR * 0.7;
      const scz = z + sdz * shR * 0.7;
      for (let i = 0; i < shN; i++) {
        const ang = rnd() * Math.PI * 2;
        const rr = shR * Math.sqrt(rnd());
        fcen.push(scx + Math.cos(ang) * rr + sdx * rr * 0.5, y + 0.35, scz + Math.sin(ang) * rr + sdz * rr * 0.5);
        fsc.push((2.6 + rnd() * 2.6) * scale);
        fcol.push(palette.foliageDark.r * 0.3, palette.foliageDark.g * 0.3, palette.foliageDark.b * 0.3);
        fwd.push(0);
        fang.push(shadowAngle + (rnd() - 0.5) * 0.5);
        fasp.push(0.92 + rnd() * 0.22);
      }
      placed++;
    }
  }

  // ---- bushes + scrub: foliage-only ground cover, dense everywhere ----
  const bcells = 22; // finer grid → far more ground-cover flora
  const bcs = S / bcells;
  for (let gz = 0; gz < bcells; gz++) {
    for (let gx = 0; gx < bcells; gx++) {
      const x = ox + (gx + rnd()) * bcs;
      const z = oz + (gz + rnd()) * bcs;
      const surf = field.surface(x, z);
      if (surf.path > 0.24 || surf.rock > 0.5 || surf.slope > 0.55) continue;
      const dens = field.forest(x, z);
      // scrub scatters broadly even in the open; thicker toward woodland
      if (rnd() > 0.42 * (0.35 + dens)) continue;

      const proto = bushProtos[Math.floor(rnd() * bushProtos.length)];
      const scale = 0.75 + rnd() * 0.75;
      const yaw = rnd() * Math.PI * 2;
      const y = field.height(x, z) - 0.2;
      const tint = 0.92 + rnd() * 0.16;
      stampFoliage(proto, x, y, z, scale, Math.cos(yaw), Math.sin(yaw), tint);

      // small ground shadow under the bush, offset from the sun
      const bShR = proto.canopyR * scale * 0.8;
      const bN = 5 + Math.floor(rnd() * 5);
      for (let i = 0; i < bN; i++) {
        const ang = rnd() * Math.PI * 2;
        const rr = bShR * Math.sqrt(rnd());
        fcen.push(x + sdx * bShR * 0.5 + Math.cos(ang) * rr, y + 0.25, z + sdz * bShR * 0.5 + Math.sin(ang) * rr);
        fsc.push((1.5 + rnd() * 1.5) * scale);
        fcol.push(palette.bushDark.r * 0.34, palette.bushDark.g * 0.34, palette.bushDark.b * 0.34);
        fwd.push(0);
        fang.push(shadowAngle + (rnd() - 0.5) * 0.5);
        fasp.push(0.92 + rnd() * 0.22);
      }
      placed++;
    }
  }

  if (placed === 0) return null;
  return {
    trunkPos: Float32Array.from(tp),
    trunkNor: Float32Array.from(tn),
    trunkCol: Float32Array.from(tc),
    folCenter: Float32Array.from(fcen),
    folScale: Float32Array.from(fsc),
    folCol: Float32Array.from(fcol),
    folWind: Float32Array.from(fwd),
    folAngle: Float32Array.from(fang),
    folAspect: Float32Array.from(fasp),
    bound: new THREE.Sphere(
      new THREE.Vector3(ox + S / 2, (minY + maxY) / 2, oz + S / 2),
      Math.hypot(S * 0.75, (maxY - minY) / 2) + 6,
    ),
  };
}
