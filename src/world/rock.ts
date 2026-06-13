import * as THREE from 'three/webgpu';
import { palette } from '../render/palette';
import { CHUNK_SIZE, SUN_DIR } from '../config';
import { TerrainField } from './TerrainField';

// Faceted painterly boulders — weathered, characterful procedural stone, flat-shaded
// for a crisp carved read, settled (partly embedded) into the ground. Two shapes:
// scattered lone stones and clustered outcrops where several boulders heap together.
// Forms get bedding strata, fractured planar facets and lumpy mass so silhouettes
// vary; colour bakes a warm sunlit face / cool shaded crevice / mossy crown gradient
// plus cavity AO so the stone reads with depth even before the scene light hits it.
// All boulders in a chunk merge into one geometry → a single draw call.

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _base = new THREE.Color();
const _moss = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _t = new THREE.Vector3();
const _c = new THREE.Color();
const _nrm = new THREE.Vector3();

// Local stone tones layered on top of the palette greys — warm sunlit faces, cool
// blue-violet crevice shade, and a desaturated lichen/moss green for crowns. Kept
// local (palette.ts is owned by another agent); only palette.rock/rockShadow read.
const SUN = new THREE.Vector3(SUN_DIR[0], SUN_DIR[1], SUN_DIR[2]).normalize();
const STONE_WARM = new THREE.Color('#cdbf9e'); // sun-warmed sandstone highlight
const STONE_COOL = new THREE.Color('#5d6275'); // cool blue-violet shadow stone
const STONE_IRON = new THREE.Color('#9a6b4a'); // rust / iron-stain streaks
const MOSS_A = new THREE.Color('#6f8a3e'); // sunlit lichen green
const MOSS_B = new THREE.Color('#3d5a2c'); // shaded moss

// fract helper for cheap value-noise.
function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

interface BoulderResult {
  pos: Float32Array;
  nor: Float32Array;
  col: Float32Array;
  count: number;
}

// One boulder, authored at the origin then transformed by the caller. radius sets
// the rough size; `angular` (0..1) biases the silhouette from rounded river-stone
// toward jagged fractured rock.
function makeBoulder(rnd: () => number, radius: number, angular: number): BoulderResult {
  // Detail 2 → enough triangles for believable facets without bloating the merge.
  const g = new THREE.IcosahedronGeometry(radius, 2);
  const pos = g.attributes.position as THREE.BufferAttribute;

  // --- form parameters -----------------------------------------------------
  // Non-uniform mass: boulders are wider than tall (settled) and asymmetric.
  const sx = 0.86 + rnd() * 0.55;
  const sy = 0.5 + rnd() * 0.32; // squashed vertically → sits low
  const sz = 0.86 + rnd() * 0.55;
  // A lateral lean so it doesn't read axis-aligned.
  const leanX = (rnd() - 0.5) * 0.3;
  const leanZ = (rnd() - 0.5) * 0.3;
  // Big directional lobes give a coherent lumpy mass (a few bumps, not noise).
  const l1 = rnd() * 6.28, l2 = rnd() * 6.28, l3 = rnd() * 6.28;
  const lf1 = 1.6 + rnd() * 1.4, lf2 = 1.8 + rnd() * 1.6, lf3 = 2.0 + rnd() * 1.8;
  // Bedding / stratification: horizontal layers that the rock fractured along.
  const strataFreq = 2.5 + rnd() * 4.5;
  const strataPhase = rnd() * 6.28;
  const strataAmt = 0.05 + rnd() * 0.12;
  // Fracture: snap each facet toward a few discrete planar orientations so angular
  // stones get flat chiselled faces instead of a smooth blob.
  const fractCells = 3 + Math.floor(rnd() * 3);
  const fractSeed = rnd() * 100;

  for (let k = 0; k < pos.count; k++) {
    _v.fromBufferAttribute(pos, k);
    _dir.copy(_v).normalize();

    // Coherent lobes (shared across vertices in a direction → no cracks).
    const lobe =
      0.5 * Math.sin(_dir.x * lf1 + l1) +
      0.42 * Math.sin(_dir.y * lf2 + l2) +
      0.4 * Math.sin(_dir.z * lf3 + l3);

    // Bedding planes: ripple radius by world-up band so layers read on the sides.
    const strata = Math.sin(_dir.y * strataFreq + strataPhase) * strataAmt;

    // Fracture facets: quantise the direction onto a small set of cells, then pull
    // the vertex toward that cell's plane. Strength scales with `angular`.
    const fa = Math.floor((_dir.x * 0.5 + 0.5) * fractCells + fractSeed);
    const fb = Math.floor((_dir.y * 0.5 + 0.5) * fractCells + fractSeed * 1.7);
    const fc = Math.floor((_dir.z * 0.5 + 0.5) * fractCells + fractSeed * 2.3);
    const fr = (hash3(fa, fb, fc) - 0.5) * 0.32 * angular;

    // Fine grit so even flat faces aren't dead-smooth (tiny, keeps facets crisp).
    const grit = (hash3(_dir.x * 9.1, _dir.y * 9.1, _dir.z * 9.1) - 0.5) * 0.05;

    const r = radius * (1 + 0.2 * lobe + strata + fr + grit);
    _v.copy(_dir).multiplyScalar(r);

    // Non-uniform squash + shear (lean grows with height).
    _v.x = _v.x * sx + _v.y * leanX;
    _v.z = _v.z * sz + _v.y * leanZ;
    _v.y *= sy;

    // Flatten the underside slightly so it sits, not floats.
    if (_v.y < 0) _v.y *= 0.7;

    pos.setXYZ(k, _v.x, _v.y, _v.z);
  }
  g.computeVertexNormals(); // recomputed below per-triangle for flat read

  // Flat shading wants per-face normals; the material is flat-shaded so vertex
  // normals are ignored for lighting, but we still ship correct ones.
  const nor = g.attributes.normal as THREE.BufferAttribute;

  // --- colour: warm sun face → cool crevice, mossy crown, cavity AO ----------
  // Per-boulder base value/temperature so a cluster isn't monochrome.
  _base.copy(palette.rock).lerp(palette.rockShadow, rnd() * 0.6);
  _base.lerp(STONE_WARM, rnd() * 0.25);
  _base.offsetHSL((rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.1);
  // Iron staining on some stones.
  const iron = rnd() < 0.4 ? rnd() * 0.18 : 0;
  if (iron > 0) _base.lerp(STONE_IRON, iron);
  // Moss tendency: damp/shaded boulders get a green crown; dry ones almost none.
  const mossy = Math.max(0, rnd() * 1.4 - 0.35); // 0..~1, many near 0
  _moss.copy(MOSS_A).lerp(MOSS_B, rnd() * 0.6);

  const topY = radius * sy;
  const col = new Float32Array(pos.count * 3);
  for (let k = 0; k < pos.count; k++) {
    const y = pos.getY(k);
    _nrm.fromBufferAttribute(nor, k);

    // Sun term baked in: warm where the face catches the sun, cool where it turns
    // away. This is in object space; the boulder's yaw is random so it averages to
    // a believable directional read even though the scene light does the real job.
    const sunDot = _nrm.dot(SUN); // -1..1
    const up = _nrm.y; // -1..1

    _c.copy(_base);
    // Warm sunlit faces, cool shaded faces — gentle so the scene light still leads.
    if (sunDot > 0) _c.lerp(STONE_WARM, sunDot * 0.22);
    else _c.lerp(STONE_COOL, -sunDot * 0.3);

    // Cavity / contact AO: darken low + downward-facing geometry (crevices, base).
    const hn = THREE.MathUtils.clamp(y / topY * 0.5 + 0.5, 0, 1); // 0 base .. 1 crown
    const ao = THREE.MathUtils.clamp(0.55 + hn * 0.4 + Math.max(0, up) * 0.18, 0.45, 1.12);
    _c.multiplyScalar(ao);
    // Deepen true undersides into the blue-violet crevice tone.
    if (up < -0.1) _c.lerp(STONE_COOL, (-up) * 0.4 * (1 - hn));

    // Moss settles on upward, sun-shadowed crowns and ledges.
    const ledge = THREE.MathUtils.smoothstep(up, 0.15, 0.85);
    const mossHere = mossy * ledge * (0.6 + 0.4 * hn);
    if (mossHere > 0.01) {
      // patchy, not a flat coat
      const patch = hash3(pos.getX(k) * 1.7, y * 1.7, k * 0.31);
      _c.lerp(_moss, Math.min(0.85, mossHere * (0.4 + patch * 0.9)));
    }

    col[k * 3] = _c.r; col[k * 3 + 1] = _c.g; col[k * 3 + 2] = _c.b;
  }

  const result: BoulderResult = {
    pos: pos.array as Float32Array,
    nor: nor.array as Float32Array,
    col,
    count: pos.count,
  };
  // detach arrays before disposing the geometry buffers
  g.dispose();
  return result;
}

// Place a single boulder into the accumulator: makes geometry, embeds it, applies
// a random transform, and pushes the world-space arrays.
function placeBoulder(
  field: TerrainField,
  rnd: () => number,
  x: number,
  z: number,
  radius: number,
  angular: number,
  acc: { pos: Float32Array[]; nor: Float32Array[]; col: Float32Array[] },
): number {
  const b = makeBoulder(rnd, radius, angular);

  // Embed deeper for big boulders so they look bedded, not dropped.
  const embed = radius * (0.34 + rnd() * 0.22);
  const y = field.height(x, z) - embed;

  // Random yaw + a little tilt so it follows no axis.
  _e.set((rnd() - 0.5) * 0.5, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.5);
  _q.setFromEuler(_e);
  _s.setScalar(1);
  _t.set(x, y, z);
  _m.compose(_t, _q, _s);

  // Transform positions; normals get the rotation only (uniform scale → fine).
  const nm = new THREE.Matrix3().getNormalMatrix(_m);
  const P = new Float32Array(b.count * 3);
  const N = new Float32Array(b.count * 3);
  for (let k = 0; k < b.count; k++) {
    _v.set(b.pos[k * 3], b.pos[k * 3 + 1], b.pos[k * 3 + 2]).applyMatrix4(_m);
    P[k * 3] = _v.x; P[k * 3 + 1] = _v.y; P[k * 3 + 2] = _v.z;
    _v.set(b.nor[k * 3], b.nor[k * 3 + 1], b.nor[k * 3 + 2]).applyMatrix3(nm).normalize();
    N[k * 3] = _v.x; N[k * 3 + 1] = _v.y; N[k * 3 + 2] = _v.z;
  }
  acc.pos.push(P);
  acc.nor.push(N);
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

  const acc = { pos: [] as Float32Array[], nor: [] as Float32Array[], col: [] as Float32Array[] };
  let total = 0;

  // ---- scattered lone stones -----------------------------------------------
  // Many candidates, gated by terrain: dense on rocky/steep ground, rare on grass.
  const scatter = 7 + Math.floor(rnd() * 7);
  for (let i = 0; i < scatter; i++) {
    const x = ox + rnd() * S;
    const z = oz + rnd() * S;
    const surf = field.surface(x, z);
    const p = 0.07 + surf.rock * 0.85 + surf.slope * 0.4;
    if (rnd() > p) continue;

    // Squared bias → mostly pebbles & small stones, the occasional larger boulder.
    const radius = 0.7 + rnd() * rnd() * 5.5;
    // Smaller stones rounder (tumbled); bigger ones more fractured/angular.
    const angular = THREE.MathUtils.clamp(0.25 + radius * 0.12 + (rnd() - 0.5) * 0.4, 0, 1);
    total += placeBoulder(field, rnd, x, z, radius, angular, acc);
  }

  // ---- clustered outcrops --------------------------------------------------
  // On rocky ground, occasionally heap a tight cluster of boulders into an
  // outcrop — varied sizes around a centre, overlapping so they read as one mass.
  const ax = ox + rnd() * S;
  const az = oz + rnd() * S;
  const csurf = field.surface(ax, az);
  const clusterP = 0.18 + csurf.rock * 0.9 + csurf.slope * 0.5;
  if (rnd() < clusterP) {
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
      total += placeBoulder(field, rnd, bx, bz, radius, angular, acc);
    }
  }

  if (total === 0) return null;

  const P = new Float32Array(total * 3);
  const Nn = new Float32Array(total * 3);
  const C = new Float32Array(total * 3);
  let off = 0;
  for (let i = 0; i < acc.pos.length; i++) {
    P.set(acc.pos[i], off);
    Nn.set(acc.nor[i], off);
    C.set(acc.col[i], off);
    off += acc.pos[i].length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(Nn, 3));
  out.setAttribute('color', new THREE.BufferAttribute(C, 3));
  out.computeBoundingSphere();
  return out;
}
