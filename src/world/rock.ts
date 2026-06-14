import * as THREE from 'three/webgpu';
import { palette } from '../render/palette';
import { CHUNK_SIZE, SUN_DIR } from '../config';
import { TerrainField } from './TerrainField';

// Faceted painterly boulders — weathered, characterful procedural stone, flat-shaded
// for a crisp carved read, settled (partly embedded) into the ground. Two shapes:
// scattered lone stones and clustered outcrops where several boulders heap together.
// Forms get bedding strata, fractured planar facets and lumpy mass so silhouettes
// vary, with an optional flat-topped TABULAR slab archetype mixed in (broad low
// resting stones) so a field reads as varied rock rather than repeated round lumps.
// Stones bed into the terrain SLOPE — tilted back into the hillside and sunk deeper
// on steep ground so they nestle in rather than perch on their downhill rim.
// Colour bakes a warm sunlit face / cool shaded crevice / mossy crown gradient
// plus cavity AO so the stone reads with depth even before the scene light hits it.
// All boulders in a chunk merge into one geometry → a single draw call.
//
// PERF: the rock material is flat-shaded (World.ts), so the GPU derives per-face
// normals from screen-space derivatives and never reads the shipped normal
// attribute for lighting. We exploit that twice: (1) the cooked geometry omits the
// normal attribute entirely (a third of the per-vertex bandwidth & memory gone),
// and (2) the base icosahedron *direction* template is built ONCE per detail level
// and cached, so each boulder is a cheap deform of a shared unit-sphere buffer
// instead of allocating + disposing a THREE geometry per stone. Pebbles (the great
// majority) drop to detail 1 — a quarter of the triangles — with no visible loss,
// while only the rare large boulder keeps detail 2 for a believable faceted mass.

const _v = new THREE.Vector3();
const _base = new THREE.Color();
const _moss = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _t = new THREE.Vector3();
const _c = new THREE.Color();
// Scratch for per-face flat-normal computation (color bake matches the lit facet).
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _cc = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _fn = new THREE.Vector3();

// Local stone tones layered on top of the palette greys — warm sunlit faces, cool
// blue-violet crevice shade, and a desaturated lichen/moss green for crowns. Kept
// local (palette.ts is owned by another agent); only palette.rock/rockShadow read.
const SUN = new THREE.Vector3(SUN_DIR[0], SUN_DIR[1], SUN_DIR[2]).normalize();
const STONE_WARM = new THREE.Color('#cdbf9e'); // sun-warmed sandstone highlight
const STONE_COOL = new THREE.Color('#5d6275'); // cool blue-violet shadow stone
const STONE_IRON = new THREE.Color('#9a6b4a'); // rust / iron-stain streaks
const MOSS_A = new THREE.Color('#6f8a3e'); // sunlit lichen green
const MOSS_B = new THREE.Color('#3d5a2c'); // shaded moss
// A couple of extra rock characters so a field isn't all one grey granite: a warm
// honey sandstone and a pale near-white quartz/limestone. Per-boulder tint only.
const STONE_SAND = new THREE.Color('#b89466'); // warm honey sandstone
const STONE_PALE = new THREE.Color('#d8d4c4'); // pale quartz / weathered limestone
const LICHEN_RUST = new THREE.Color('#b08a4a'); // ochre crustose lichen on crowns

// fract helper for cheap value-noise.
function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

// Unit-sphere direction template for one icosahedron subdivision level, built once
// and reused for every boulder. Non-indexed (each triangle's 3 verts contiguous),
// so duplicated verts share a direction → the direction-only deform leaves no
// cracks. We cache the bare Float32Array of normalized vertex directions; per
// boulder we read these, deform, and never touch a THREE geometry object.
const _dirCache = new Map<number, Float32Array>();
function dirTemplate(detail: number): Float32Array {
  const cached = _dirCache.get(detail);
  if (cached) return cached;
  const g = new THREE.IcosahedronGeometry(1, detail); // radius 1 → already unit dirs
  const pos = g.attributes.position as THREE.BufferAttribute;
  const arr = new Float32Array(pos.count * 3);
  for (let k = 0; k < pos.count; k++) {
    _v.fromBufferAttribute(pos, k).normalize(); // PolyhedronGeometry projects to sphere
    arr[k * 3] = _v.x; arr[k * 3 + 1] = _v.y; arr[k * 3 + 2] = _v.z;
  }
  g.dispose();
  _dirCache.set(detail, arr);
  return arr;
}

interface BoulderResult {
  pos: Float32Array; // object-space, already deformed
  col: Float32Array;
  count: number;
}

// One boulder, authored at the origin then transformed by the caller. radius sets
// the rough size; `angular` (0..1) biases the silhouette from rounded river-stone
// toward jagged fractured rock; `tabular` (0..1) biases the mass from a compact
// lump toward a flat-topped tabular SLAB — the broad, low resting stones that give
// an outcrop its varied silhouette instead of a field of look-alike blobs.
function makeBoulder(
  rnd: () => number,
  radius: number,
  angular: number,
  tabular: number,
): BoulderResult {
  // LOD: pebbles & small stones (the common case, thanks to the squared size bias)
  // get away with detail 1 — a quarter of the triangles — because their facets are
  // tiny on screen. Only larger boulders need detail 2 for a convincing carved mass.
  const detail = radius < 1.5 ? 1 : 2;
  const dirs = dirTemplate(detail);
  const count = dirs.length / 3;
  const pos = new Float32Array(count * 3);

  // --- form parameters -----------------------------------------------------
  // Non-uniform mass: boulders are wider than tall (settled) and asymmetric.
  // `tabular` pushes the stone toward a broad, low slab: wider footprint, much
  // flatter profile. This is the main lever for silhouette VARIETY across a field.
  const sx = (0.86 + rnd() * 0.55) * (1 + tabular * 0.7);
  const sy = (0.5 + rnd() * 0.32) * (1 - tabular * 0.5); // squashed vertically → sits low
  const sz = (0.86 + rnd() * 0.55) * (1 + tabular * 0.7);
  // A lateral lean so it doesn't read axis-aligned.
  const leanX = (rnd() - 0.5) * 0.3;
  const leanZ = (rnd() - 0.5) * 0.3;
  // Big directional lobes give a coherent lumpy mass (a few bumps, not noise).
  const l1 = rnd() * 6.28, l2 = rnd() * 6.28, l3 = rnd() * 6.28;
  const lf1 = 1.6 + rnd() * 1.4, lf2 = 1.8 + rnd() * 1.6, lf3 = 2.0 + rnd() * 1.8;
  // A second, finer lobe set on a tilted axis breaks the bilateral feel so the
  // mass reads hewn and irregular rather than a smooth squashed ellipsoid.
  const l4 = rnd() * 6.28, l5 = rnd() * 6.28;
  const lf4 = 3.1 + rnd() * 2.2, lf5 = 3.6 + rnd() * 2.6;
  // Bedding / stratification: horizontal layers that the rock fractured along.
  const strataFreq = 2.5 + rnd() * 4.5;
  const strataPhase = rnd() * 6.28;
  const strataAmt = 0.05 + rnd() * 0.12;
  // Fracture: snap each facet toward a few discrete planar orientations so angular
  // stones get flat chiselled faces instead of a smooth blob.
  const fractCells = 3 + Math.floor(rnd() * 3);
  const fractSeed = rnd() * 100;
  // A dominant cleavage plane: angular stones shear off a near-flat face on one
  // side, the way real fractured rock splits — a strong directional read.
  const cleaveX = (rnd() - 0.5), cleaveY = (rnd() - 0.5) * 0.6, cleaveZ = (rnd() - 0.5);
  const clInv = 1 / (Math.hypot(cleaveX, cleaveY, cleaveZ) || 1);
  const cnx = cleaveX * clInv, cny = cleaveY * clInv, cnz = cleaveZ * clInv;
  const cleaveAmt = 0.22 * angular * angular; // only the jagged stones cleave
  // Flat resting top: tabular slabs get their crown sheared toward a level plane,
  // the worn upper face of a bedded slab. Strength scales with `tabular`.
  const topFlat = 0.5 * tabular;

  for (let k = 0; k < count; k++) {
    const dx = dirs[k * 3], dy = dirs[k * 3 + 1], dz = dirs[k * 3 + 2];

    // Coherent lobes (shared across vertices in a direction → no cracks).
    const lobe =
      0.5 * Math.sin(dx * lf1 + l1) +
      0.42 * Math.sin(dy * lf2 + l2) +
      0.4 * Math.sin(dz * lf3 + l3) +
      0.16 * Math.sin((dx + dy) * lf4 + l4) +
      0.14 * Math.sin((dz - dy) * lf5 + l5);

    // Bedding planes: ripple radius by world-up band so layers read on the sides.
    const strata = Math.sin(dy * strataFreq + strataPhase) * strataAmt;

    // Fracture facets: quantise the direction onto a small set of cells, then pull
    // the vertex toward that cell's plane. Strength scales with `angular`.
    const fa = Math.floor((dx * 0.5 + 0.5) * fractCells + fractSeed);
    const fb = Math.floor((dy * 0.5 + 0.5) * fractCells + fractSeed * 1.7);
    const fc = Math.floor((dz * 0.5 + 0.5) * fractCells + fractSeed * 2.3);
    const fr = (hash3(fa, fb, fc) - 0.5) * 0.32 * angular;

    // Cleavage: shave the half of the stone facing the cleave normal toward a flat
    // plane — a single big sheared face, the hallmark of split rock.
    const cd = dx * cnx + dy * cny + dz * cnz; // -1..1
    const cleave = cd > 0.25 ? -(cd - 0.25) * cleaveAmt : 0;

    // Fine grit so even flat faces aren't dead-smooth (tiny, keeps facets crisp).
    const grit = (hash3(dx * 9.1, dy * 9.1, dz * 9.1) - 0.5) * 0.05;

    const r = radius * (1 + 0.2 * lobe + strata + fr + cleave + grit);
    let vx = dx * r, vy = dy * r, vz = dz * r;

    // Non-uniform squash + shear (lean grows with height).
    const nx = vx * sx + vy * leanX;
    const nz = vz * sz + vy * leanZ;
    vy *= sy;
    vx = nx; vz = nz;

    // Flatten the underside slightly so it sits, not floats.
    if (vy < 0) vy *= 0.7;
    // Tabular slabs: shear the upper dome down toward a level crown so the stone
    // reads as a flat-topped bedded slab rather than a dome. Pulls only the top
    // half, easing in with height so the flank still rounds over to the edge.
    if (topFlat > 0 && vy > 0) {
      const t = THREE.MathUtils.smoothstep(dy, 0.15, 0.85); // how "up" this vert is
      vy *= 1 - topFlat * t;
    }

    pos[k * 3] = vx; pos[k * 3 + 1] = vy; pos[k * 3 + 2] = vz;
  }

  // --- colour: warm sun face → cool crevice, mossy crown, cavity AO ----------
  // Per-boulder base value/temperature so a cluster isn't monochrome.
  _base.copy(palette.rock).lerp(palette.rockShadow, rnd() * 0.6);
  _base.lerp(STONE_WARM, rnd() * 0.25);
  // Per-boulder ROCK CHARACTER: most stones stay neutral grey granite, but a
  // minority lean toward a warm honey sandstone or a pale quartz/limestone, so a
  // boulder field reads as varied stone rather than one grey lump rescaled.
  const charRoll = rnd();
  if (charRoll < 0.22) _base.lerp(STONE_SAND, 0.3 + rnd() * 0.4);
  else if (charRoll < 0.34) _base.lerp(STONE_PALE, 0.3 + rnd() * 0.45);
  _base.offsetHSL((rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.1);
  // Iron staining on some stones.
  const iron = rnd() < 0.4 ? rnd() * 0.18 : 0;
  if (iron > 0) _base.lerp(STONE_IRON, iron);
  // Moss tendency: damp/shaded boulders get a green crown; dry ones almost none.
  const mossy = Math.max(0, rnd() * 1.4 - 0.35); // 0..~1, many near 0
  // Some stones wear an OCHRE crustose lichen instead of green moss — patchy
  // rust-gold crowns, a different weathering read on a fraction of the rocks.
  const ochreLichen = rnd() < 0.3;
  _moss.copy(ochreLichen ? LICHEN_RUST : MOSS_A).lerp(ochreLichen ? STONE_IRON : MOSS_B, rnd() * 0.6);

  const topY = radius * sy;
  const col = new Float32Array(count * 3);
  // Per-FACE colour: the material is flat-shaded, so we bake the sun/crevice/moss
  // read against the true face normal (same one the GPU derives at runtime). All
  // three verts of a triangle share that colour → the facet read stays crisp and
  // matches the lit shading exactly, instead of smearing across smoothed normals.
  for (let f = 0; f < count; f += 3) {
    const i0 = f * 3, i1 = (f + 1) * 3, i2 = (f + 2) * 3;
    _a.set(pos[i0], pos[i0 + 1], pos[i0 + 2]);
    _b.set(pos[i1], pos[i1 + 1], pos[i1 + 2]);
    _cc.set(pos[i2], pos[i2 + 1], pos[i2 + 2]);
    _ab.subVectors(_b, _a);
    _ac.subVectors(_cc, _a);
    _fn.crossVectors(_ab, _ac).normalize(); // outward (icosa winding is CCW)
    // Face centroid height & a stable per-face hash coordinate.
    const fy = (_a.y + _b.y + _cc.y) * (1 / 3);

    const sunDot = _fn.dot(SUN); // -1..1
    const up = _fn.y; // -1..1

    _c.copy(_base);
    // Warm sunlit faces, cool shaded faces — gentle so the scene light still leads.
    if (sunDot > 0) _c.lerp(STONE_WARM, sunDot * 0.22);
    else _c.lerp(STONE_COOL, -sunDot * 0.3);

    // Cavity / contact AO: darken low + downward-facing geometry (crevices, base).
    // Floor kept high (0.58) so undersides stay OPEN — a luminous painted shade, not
    // a crushed black hole, in keeping with the Ghibli "shadows are never black" feel.
    const hn = THREE.MathUtils.clamp(fy / topY * 0.5 + 0.5, 0, 1); // 0 base .. 1 crown
    const ao = THREE.MathUtils.clamp(0.66 + hn * 0.34 + Math.max(0, up) * 0.16, 0.58, 1.12);
    _c.multiplyScalar(ao);
    // Deepen true undersides into the blue-violet crevice tone.
    if (up < -0.1) _c.lerp(STONE_COOL, (-up) * 0.4 * (1 - hn));

    // Moss settles on upward, sun-shadowed crowns and ledges.
    const ledge = THREE.MathUtils.smoothstep(up, 0.15, 0.85);
    const mossHere = mossy * ledge * (0.6 + 0.4 * hn);
    if (mossHere > 0.01) {
      // patchy, not a flat coat
      const patch = hash3(_a.x * 1.7, fy * 1.7, _cc.z * 1.7);
      _c.lerp(_moss, Math.min(0.85, mossHere * (0.4 + patch * 0.9)));
    }

    const r = _c.r, gg = _c.g, bb = _c.b;
    col[i0] = r; col[i0 + 1] = gg; col[i0 + 2] = bb;
    col[i1] = r; col[i1 + 1] = gg; col[i1 + 2] = bb;
    col[i2] = r; col[i2 + 1] = gg; col[i2 + 2] = bb;
  }

  return { pos, col, count };
}

// Place a single boulder into the accumulator: makes geometry, embeds it, applies
// a random transform, and pushes the world-space arrays. No normals are emitted —
// the rock material is flat-shaded and derives face normals on the GPU.
function placeBoulder(
  field: TerrainField,
  rnd: () => number,
  x: number,
  z: number,
  radius: number,
  angular: number,
  tabular: number,
  acc: { pos: Float32Array[]; col: Float32Array[] },
): number {
  const b = makeBoulder(rnd, radius, angular, tabular);

  // Embed deeper for big boulders so they look bedded, not dropped. On a SLOPE a
  // stone with a level base would perch on its downhill rim, so we sink it further
  // the steeper the ground (its uphill flank buries while the downhill flank shows).
  const surf = field.surface(x, z);
  const embed = radius * (0.34 + rnd() * 0.22 + surf.slope * 0.45);
  // Tabular slabs are flatter, so the same embed fraction would swallow them —
  // ease their sink so the broad top stays proud of the turf.
  const y = field.height(x, z) - embed * (1 - tabular * 0.35);

  // Bed into the hillside: tilt the stone so its "up" leans with the terrain
  // normal (lain stones lie BACK into the slope, never axis-vertical on a hill),
  // then add a little extra random wobble so none reads machine-placed. Tabular
  // slabs lie almost flush with the ground; lumps keep more free wobble.
  const slopeTiltX = surf.nz * (0.9 - tabular * 0.3); // tilt about X follows dz of normal
  const slopeTiltZ = -surf.nx * (0.9 - tabular * 0.3);
  const wob = 0.35 - tabular * 0.22;
  _e.set(
    slopeTiltX + (rnd() - 0.5) * wob,
    rnd() * Math.PI * 2,
    slopeTiltZ + (rnd() - 0.5) * wob,
  );
  _q.setFromEuler(_e);
  _s.setScalar(1);
  _t.set(x, y, z);
  _m.compose(_t, _q, _s);

  // Transform positions into world space (normals are not shipped; see header).
  const P = new Float32Array(b.count * 3);
  for (let k = 0; k < b.count; k++) {
    const i = k * 3;
    _v.set(b.pos[i], b.pos[i + 1], b.pos[i + 2]).applyMatrix4(_m);
    P[i] = _v.x; P[i + 1] = _v.y; P[i + 2] = _v.z;
  }
  acc.pos.push(P);
  acc.col.push(b.col);
  return b.count;
}

/** Build the merged boulder geometry for one chunk, or null if it has none. */
export function buildBoulders(
  field: TerrainField,
  cx: number,
  cz: number,
  rnd: () => number,
): THREE.BufferGeometry | null {
  const S = CHUNK_SIZE;
  const ox = cx * S;
  const oz = cz * S;

  const acc = { pos: [] as Float32Array[], col: [] as Float32Array[] };
  let total = 0;

  // ---- scattered lone stones -----------------------------------------------
  // Many candidates, gated by terrain: dense on rocky/steep ground, rare on grass.
  const scatter = 12 + Math.floor(rnd() * 10);
  for (let i = 0; i < scatter; i++) {
    const x = ox + rnd() * S;
    const z = oz + rnd() * S;
    const surf = field.surface(x, z);
    // Higher base so lone stones dot the open MEADOW too, not just rocky/steep ground.
    const p = 0.22 + surf.rock * 0.7 + surf.slope * 0.35;
    if (rnd() > p) continue;

    // Squared bias → mostly pebbles & small stones, the occasional larger boulder.
    const radius = 0.7 + rnd() * rnd() * 5.5;
    // Smaller stones rounder (tumbled); bigger ones more fractured/angular.
    const angular = THREE.MathUtils.clamp(0.25 + radius * 0.12 + (rnd() - 0.5) * 0.4, 0, 1);
    // Roughly a quarter become flat-topped resting slabs (squared bias keeps most
    // of those modest) — broad low stones break up a field of round lumps.
    const tabular = rnd() < 0.28 ? rnd() * rnd() * 0.9 + 0.1 : 0;
    total += placeBoulder(field, rnd, x, z, radius, angular, tabular, acc);
  }

  // ---- clustered outcrops --------------------------------------------------
  // On rocky ground, occasionally heap a tight cluster of boulders into an
  // outcrop — varied sizes around a centre, overlapping so they read as one mass.
  // Sometimes a second satellite cluster nearby so the stone gathers in family
  // groups (a couple of heaps) rather than one lonely pile per chunk.
  const clusters = 1 + (rnd() < 0.6 ? 1 : 0);
  for (let cI = 0; cI < clusters; cI++) {
    const ax = ox + rnd() * S;
    const az = oz + rnd() * S;
    const csurf = field.surface(ax, az);
    const clusterP = 0.4 + csurf.rock * 0.7 + csurf.slope * 0.4;
    if (rnd() >= clusterP) continue;

    const n = 3 + Math.floor(rnd() * 5); // 3..7 stones
    const big = 2.5 + rnd() * 4.0; // dominant boulder size
    const spread = big * (0.7 + rnd() * 0.8);
    for (let j = 0; j < n; j++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * rnd() * spread; // cluster tightens toward centre
      const bx = ax + Math.cos(a) * d;
      const bz = az + Math.sin(a) * d;
      if (bx < ox || bx >= ox + S || bz < oz || bz >= oz + S) continue;
      // The first stone is the big one; the rest are smaller satellites.
      const radius = j === 0 ? big : big * (0.3 + rnd() * 0.55);
      const angular = THREE.MathUtils.clamp(0.45 + (rnd() - 0.3) * 0.5, 0, 1);
      // Outcrops mix lumps with the odd broad slab tilted across the heap, so the
      // mass reads as fractured strata rather than a pile of identical cobbles.
      const tabular = rnd() < 0.35 ? rnd() * 0.7 + 0.15 : 0;
      total += placeBoulder(field, rnd, bx, bz, radius, angular, tabular, acc);
    }
  }

  if (total === 0) return null;

  const P = new Float32Array(total * 3);
  const C = new Float32Array(total * 3);
  let off = 0;
  for (let i = 0; i < acc.pos.length; i++) {
    P.set(acc.pos[i], off);
    C.set(acc.col[i], off);
    off += acc.pos[i].length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('color', new THREE.BufferAttribute(C, 3));
  out.computeBoundingSphere();
  return out;
}
