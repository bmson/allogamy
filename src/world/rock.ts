import * as THREE from 'three/webgpu';
import { palette } from '../render/palette';
import { CHUNK_SIZE } from '../config';
import { TerrainField } from './TerrainField';

// Faceted low-poly boulders — a deformed icosahedron, flat-shaded for a stylized
// stone read, embedded into the ground. Denser on rocky/steep terrain, sparse on
// grass (matching the reference). All boulders in a chunk merge into one geometry
// so it costs a single draw call.

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _base = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _t = new THREE.Vector3();

function makeBoulder(rnd: () => number, radius: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(radius, 1); // already non-indexed → flat-shaded
  const pos = g.attributes.position as THREE.BufferAttribute;

  // Non-uniform squash + a few directional lobes → lumpy, coherent across shared
  // directions so no cracks despite being non-indexed.
  const sx = 0.82 + rnd() * 0.5;
  const sy = 0.55 + rnd() * 0.4;
  const sz = 0.82 + rnd() * 0.5;
  const s1 = rnd() * 6.28;
  const s2 = rnd() * 6.28;
  for (let k = 0; k < pos.count; k++) {
    _v.fromBufferAttribute(pos, k);
    _dir.copy(_v).normalize();
    const lobe =
      0.5 * Math.sin(_dir.x * 4 + s1) +
      0.45 * Math.sin(_dir.y * 5 + s2) +
      0.4 * Math.sin(_dir.z * 6 + s1 * 0.6);
    const r = radius * (1 + 0.18 * lobe);
    _v.copy(_dir).multiplyScalar(r);
    _v.x *= sx; _v.y *= sy; _v.z *= sz;
    pos.setXYZ(k, _v.x, _v.y, _v.z);
  }
  g.computeVertexNormals();

  // Vertex colour: a varied grey, lighter on top faces, darker toward the base.
  _base.copy(palette.rock).lerp(palette.rockShadow, rnd() * 0.55);
  _base.offsetHSL((rnd() - 0.5) * 0.02, (rnd() - 0.5) * 0.05, (rnd() - 0.5) * 0.08);
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let k = 0; k < pos.count; k++) {
    const y = pos.getY(k);
    const shade = THREE.MathUtils.clamp((y / (radius * sy)) * 0.45 + 0.7, 0.5, 1.08);
    c.copy(_base).multiplyScalar(shade);
    col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
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

  const posList: Float32Array[] = [];
  const norList: Float32Array[] = [];
  const colList: Float32Array[] = [];
  let total = 0;

  const candidates = 6 + Math.floor(rnd() * 6);
  for (let i = 0; i < candidates; i++) {
    const x = ox + rnd() * S;
    const z = oz + rnd() * S;
    const surf = field.surface(x, z);
    // Likely on rock/steep ground, occasional lone boulder on grass.
    const p = 0.08 + surf.rock * 0.8 + surf.slope * 0.35;
    if (rnd() > p) continue;

    // Mostly small stones, the rare large boulder (squared rnd biases small).
    const radius = 1.0 + rnd() * rnd() * 6.0;
    const y = field.height(x, z) - radius * 0.38; // embed into the ground

    const g = makeBoulder(rnd, radius);
    _e.set((rnd() - 0.5) * 0.4, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.4);
    _q.setFromEuler(_e);
    _s.setScalar(1);
    _t.set(x, y, z);
    _m.compose(_t, _q, _s);
    g.applyMatrix4(_m); // transforms positions and normals

    posList.push(g.attributes.position.array as Float32Array);
    norList.push(g.attributes.normal.array as Float32Array);
    colList.push(g.attributes.color.array as Float32Array);
    total += g.attributes.position.count;
    g.dispose();
  }

  if (total === 0) return null;

  const P = new Float32Array(total * 3);
  const Nn = new Float32Array(total * 3);
  const C = new Float32Array(total * 3);
  let off = 0;
  for (let i = 0; i < posList.length; i++) {
    P.set(posList[i], off);
    Nn.set(norList[i], off);
    C.set(colList[i], off);
    off += posList[i].length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(Nn, 3));
  out.setAttribute('color', new THREE.BufferAttribute(C, 3));
  out.computeBoundingSphere();
  return out;
}
