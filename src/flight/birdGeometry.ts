import * as THREE from 'three/webgpu';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

// Procedural geometry builders for the hero bird. The whole point of this module
// is to make the bird read as a *sculpted, solid animal* rather than a fan of flat
// cards: every part here is a closed, lofted volume with smoothed normals, so the
// silhouette stays clean and the surface catches the scene's sun softly instead of
// faceting. Colours are baked per-vertex (see paint()) over MeshStandardMaterial,
// so the bird is still lit by the real hemisphere + sun.
//
// Convention (matches Bird.ts): nose +Z, up +Y, wings along ±X. All lengths are in
// local "real-ish" metres; Bird scales the assembled rig up for the chase cam.

// ---------------------------------------------------------------------------
// Palette — a heron/crane-grey pelican: soft pearl-grey body that cools into
// slate, near-charcoal primaries with a faint cool sheen, a warm ochre bill.
// Chosen to sit *quietly* against the misty cool greens of the meadow while the
// crisp solid form contrasts the soft painted world.
// ---------------------------------------------------------------------------
export const C_BODY_TOP = new THREE.Color('#eef1f3'); // sunlit pearl back
export const C_BODY = new THREE.Color('#d8dde2'); // body grey
export const C_BODY_LOW = new THREE.Color('#a9b2bd'); // cool slate underside/AO
export const C_NECK = new THREE.Color('#e7eaec'); // pale nape
export const C_COVERT = new THREE.Color('#c2c9d1'); // inner wing
export const C_COVERT_LOW = new THREE.Color('#97a0ac'); // wing underside
export const C_PRIMARY = new THREE.Color('#2b2f38'); // charcoal flight feathers
export const C_PRIMARY_EDGE = new THREE.Color('#4a5364'); // cool slate sheen on tips
export const C_BILL = new THREE.Color('#e8b04a'); // warm ochre bill
export const C_BILL_TIP = new THREE.Color('#d98b39');
export const C_BILL_RIDGE = new THREE.Color('#caa24a');
export const C_FACE = new THREE.Color('#cdd2d6'); // pale lores
export const C_CROWN = new THREE.Color('#3b414c'); // dusky crown smudge
export const C_EYE = new THREE.Color('#171310');

const SUN = new THREE.Vector3(-0.5, 0.55, -0.62).normalize();

// ---- vertex-colour baking -------------------------------------------------
export type PaintFn = (
  c: THREE.Color, x: number, y: number, z: number,
  nx: number, ny: number, nz: number, bb: THREE.Box3,
) => void;

/** Bake a per-vertex colour buffer; normals must already be present & smooth. */
export function paint(geo: THREE.BufferGeometry, fn: PaintFn): THREE.BufferGeometry {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    fn(c, pos.getX(i), pos.getY(i), pos.getZ(i), nrm.getX(i), nrm.getY(i), nrm.getZ(i), bb);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Soft directional term so baked colour already carries a hint of the sun. */
export const sunlit = (nx: number, ny: number, nz: number, amt = 0.12) =>
  1 + amt * Math.max(0, nx * SUN.x + ny * SUN.y + nz * SUN.z);

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// Loft: sweep a sequence of closed cross-section rings into a smooth tube. Each
// ring is an array of points in its own local frame (x = side, y = up); we place
// it at a centre along +Z and scale it. Produces an indexed, watertight surface
// with end caps, then smooth normals. This is the workhorse for body, neck, bill.
// ---------------------------------------------------------------------------
interface Station {
  z: number; // position along the spine
  cx?: number; // lateral centre offset (for curves) — default 0
  cy?: number; // vertical centre offset — default 0
  rx: number; // half-width
  ry: number; // half-height
  yOff?: number; // asymmetric vertical bias (belly heavier than back)
}

/** A unit ellipse outline of `seg` points (x right, y up), CCW. */
function ellipseRing(seg: number): THREE.Vector2[] {
  const r: THREE.Vector2[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    r.push(new THREE.Vector2(Math.cos(a), Math.sin(a)));
  }
  return r;
}

/**
 * Loft a tapered, optionally curved tube through `stations` (ordered by z).
 * `seg` = points per ring. Belly bias (`yOff`) lets the body hang fuller below.
 */
export function loft(stations: Station[], seg: number, capStart = true, capEnd = true): THREE.BufferGeometry {
  const ring = ellipseRing(seg);
  const rings = stations.length;
  const verts: number[] = [];
  for (const s of stations) {
    const cx = s.cx ?? 0, cy = s.cy ?? 0, yOff = s.yOff ?? 0;
    for (const p of ring) {
      // squash the lower half downward a touch for a pear/teardrop section
      const yb = p.y < 0 ? p.y * (1 + yOff) : p.y;
      verts.push(cx + p.x * s.rx, cy + yb * s.ry, s.z);
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < rings - 1; r++) {
    const a = r * seg, b = (r + 1) * seg;
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      idx.push(a + i, a + j, b + j);
      idx.push(a + i, b + j, b + i);
    }
  }
  // caps as fans to a centre vertex
  if (capStart) {
    const s = stations[0];
    const ci = verts.length / 3;
    verts.push(s.cx ?? 0, s.cy ?? 0, s.z);
    for (let i = 0; i < seg; i++) idx.push(ci, ((i + 1) % seg), i);
  }
  if (capEnd) {
    const s = stations[rings - 1];
    const base = (rings - 1) * seg;
    const ci = verts.length / 3;
    verts.push(s.cx ?? 0, s.cy ?? 0, s.z);
    for (let i = 0; i < seg; i++) idx.push(ci, base + i, base + ((i + 1) % seg));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Body — a single lofted teardrop with a heavy breast and a tapering rump, the
// great-bird gravitas. Belly bias + a top/bottom value split give it volume.
// ---------------------------------------------------------------------------
export function buildBody(): THREE.BufferGeometry {
  const stations: Station[] = [
    { z: -0.95, rx: 0.015, ry: 0.015 }, // tail root
    { z: -0.78, rx: 0.085, ry: 0.075, yOff: 0.1 },
    { z: -0.55, rx: 0.155, ry: 0.16, yOff: 0.25 },
    { z: -0.28, rx: 0.215, ry: 0.235, yOff: 0.4 }, // heaviest belly
    { z: 0.0, rx: 0.235, ry: 0.255, yOff: 0.45 },
    { z: 0.28, rx: 0.215, ry: 0.235, yOff: 0.4 }, // breast
    { z: 0.52, rx: 0.165, ry: 0.185, yOff: 0.28, cy: 0.02 },
    { z: 0.7, rx: 0.11, ry: 0.13, yOff: 0.15, cy: 0.05 }, // shoulders rising to neck
    { z: 0.82, rx: 0.075, ry: 0.09, cy: 0.08 },
  ];
  const g = loft(stations, 28);
  return paint(g, (c, _x, y, _z, nx, ny, nz, bb) => {
    const top = (y - bb.min.y) / Math.max(1e-3, bb.max.y - bb.min.y);
    // pearl back → grey flanks → cool slate belly (soft baked AO underneath)
    c.copy(C_BODY_LOW).lerp(C_BODY, smoothstep(0.18, 0.55, top))
      .lerp(C_BODY_TOP, smoothstep(0.6, 1.0, top) * 0.85);
    c.multiplyScalar(sunlit(nx, ny, nz, 0.14));
  });
}

// ---------------------------------------------------------------------------
// Neck segment — a smooth lofted tube, slightly tapered, used per S-curve joint
// so the retracted neck reads as one continuous sinuous form once articulated.
// ---------------------------------------------------------------------------
export function buildNeckSeg(rStart: number, rEnd: number, len: number): THREE.BufferGeometry {
  const N = 6;
  const stations: Station[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const r = rStart + (rEnd - rStart) * t;
    stations.push({ z: t * len, rx: r, ry: r * 1.05 });
  }
  const g = loft(stations, 18, true, true);
  return paint(g, (c, _x, _y, _z, nx, ny, nz) => {
    c.copy(C_NECK).multiplyScalar(sunlit(nx, ny, nz, 0.12) * 0.99);
  });
}

// ---------------------------------------------------------------------------
// Head — a lofted ovoid blending into the bill base, with a dusky crown smudge.
// ---------------------------------------------------------------------------
export function buildHead(): THREE.BufferGeometry {
  const stations: Station[] = [
    { z: -0.06, rx: 0.02, ry: 0.02 },
    { z: -0.02, rx: 0.075, ry: 0.082, cy: 0.005 },
    { z: 0.04, rx: 0.095, ry: 0.1, cy: 0.008 },
    { z: 0.1, rx: 0.088, ry: 0.092, cy: 0.004 },
    { z: 0.15, rx: 0.06, ry: 0.058, cy: -0.004 },
    { z: 0.19, rx: 0.035, ry: 0.03, cy: -0.012 }, // tapers to the bill base
  ];
  const g = loft(stations, 22, true, false);
  return paint(g, (c, _x, y, z, nx, ny, nz, bb) => {
    const top = (y - bb.min.y) / Math.max(1e-3, bb.max.y - bb.min.y);
    // dusky crown on the upper-rear, pale face toward the bill
    const crown = smoothstep(0.55, 0.95, top) * smoothstep(0.16, -0.02, z);
    c.copy(C_FACE).lerp(C_CROWN, crown * 0.8);
    c.multiplyScalar(sunlit(nx, ny, nz, 0.12));
  });
}

// ---------------------------------------------------------------------------
// Bill — a long, gently down-curved pelican wedge. Lofted from a wide, flat-ish
// base into a slim tip, with the centre-line dropping (droop) toward the end and
// a subtle culmen ridge. A separate lower mandible is built the same way.
// ---------------------------------------------------------------------------
export function buildBill(len: number, upper: boolean): THREE.BufferGeometry {
  const N = 9;
  const stations: Station[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const z = t * len;
    // width tapers near-linearly; height is shallow & flatter toward the tip
    const w = (upper ? 0.072 : 0.062) * (1 - 0.78 * t) + 0.006;
    const h = (upper ? 0.05 : 0.032) * (1 - 0.82 * t) + 0.004;
    const droop = -0.085 * t * t * len * 0.55; // quadratic down-curve
    stations.push({ z, rx: w, ry: h, cy: droop });
  }
  const g = loft(stations, 14, true, true);
  return paint(g, (c, _x, y, z, nx, ny, nz, bb) => {
    const f = (z - bb.min.z) / Math.max(1e-3, bb.max.z - bb.min.z);
    const top = (y - bb.min.y) / Math.max(1e-3, bb.max.y - bb.min.y);
    c.copy(C_BILL).lerp(C_BILL_TIP, f * 0.9);
    if (top > 0.7) c.lerp(C_BILL_RIDGE, (top - 0.7) / 0.3 * 0.5); // culmen ridge
    c.multiplyScalar(sunlit(nx, ny, nz, 0.16) * (top < 0.25 ? 0.9 : 1.0));
  });
}

// ---------------------------------------------------------------------------
// Tail — a short, solid lofted fan-wedge (one piece, no z-fighting cards): wide
// flat triangle that tapers and thins toward the trailing edge.
// ---------------------------------------------------------------------------
export function buildTail(len: number, halfSpan: number): THREE.BufferGeometry {
  const N = 6;
  const stations: Station[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const w = halfSpan * (0.35 + 0.65 * t); // widens to the trailing fan
    const h = 0.028 * (1 - 0.7 * t) + 0.004; // thins out
    stations.push({ z: -t * len, rx: w, ry: h });
  }
  const g = loft(stations, 12, true, true);
  return paint(g, (c, _x, _y, z, nx, ny, nz, bb) => {
    const f = (bb.max.z - z) / Math.max(1e-3, bb.max.z - bb.min.z); // 0 root → 1 tip
    c.copy(C_COVERT).lerp(C_PRIMARY, smoothstep(0.45, 1.0, f) * 0.85);
    c.multiplyScalar(sunlit(nx, ny, nz, 0.12));
  });
}

// ---------------------------------------------------------------------------
// Wing bone — a smooth lofted airfoil section (arm or hand) with real thickness,
// camber (top fuller than bottom) and a tapering planform. Root at x=0, extends
// along side·X. Chord runs along ±Z; the leading edge (+Z) is rounder, trailing
// edge (-Z) is thin. This replaces the old paper-thin DoubleSide quads — it's a
// solid blade that holds its silhouette through the whole flap.
// ---------------------------------------------------------------------------
export function buildWingBone(
  side: number, span: number, rootChord: number, tipChord: number,
  rootThick: number, tipThick: number, inner: boolean,
): THREE.BufferGeometry {
  const NS = 7; // stations along the span
  const NP = 12; // points around each airfoil section
  const verts: number[] = [];
  for (let s = 0; s < NS; s++) {
    const t = s / (NS - 1);
    const x = side * span * t;
    const chord = rootChord + (tipChord - rootChord) * t;
    const thick = rootThick + (tipThick - rootThick) * t;
    // small backward sweep of the chord centre so the planform rakes back
    const cz = -0.12 * chord * t;
    for (let p = 0; p < NP; p++) {
      const a = (p / NP) * Math.PI * 2;
      // airfoil: chord along z, thickness along y; camber lifts the section
      const zc = Math.cos(a);
      const yc = Math.sin(a);
      // leading edge (+z) rounder, trailing edge thinner → teardrop section
      const taperZ = zc > 0 ? 1.0 : 0.92;
      const z = cz + zc * chord * 0.5 * taperZ;
      const camber = 0.18 * thick * (1 - zc * zc); // gentle upper camber
      const y = yc * thick * (yc > 0 ? 1.0 : 0.65) + camber;
      verts.push(x, y, z);
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < NS - 1; s++) {
    const a = s * NP, b = (s + 1) * NP;
    for (let p = 0; p < NP; p++) {
      const q = (p + 1) % NP;
      if (side > 0) { idx.push(a + p, a + q, b + q); idx.push(a + p, b + q, b + p); }
      else { idx.push(a + p, b + q, a + q); idx.push(a + p, b + p, b + q); }
    }
  }
  // cap the root only (tip flows into feathers / next bone)
  const ci = verts.length / 3;
  verts.push(0, 0, 0);
  for (let p = 0; p < NP; p++) {
    const q = (p + 1) % NP;
    if (side > 0) idx.push(ci, q, p); else idx.push(ci, p, q);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return paint(g, (c, _x, y, _z, nx, ny, nz, bb) => {
    const top = (y - bb.min.y) / Math.max(1e-3, bb.max.y - bb.min.y);
    const base = inner ? C_COVERT : C_COVERT.clone().lerp(C_PRIMARY, 0.25);
    c.copy(C_COVERT_LOW).lerp(base, smoothstep(0.25, 0.7, top));
    c.multiplyScalar(sunlit(nx, ny, nz, 0.13));
  });
}

// ---------------------------------------------------------------------------
// Primary feather — a slim, solid, gently curved blade (a thin lofted lens, not
// a flat card). Suggests a single long flight feather; several are fanned at the
// hand. Tapers and thins to a soft point, with a charcoal body and cool tip.
// ---------------------------------------------------------------------------
export function buildPrimary(side: number, len: number, width: number, dark: boolean): THREE.BufferGeometry {
  const NS = 6, NP = 8;
  const verts: number[] = [];
  for (let s = 0; s < NS; s++) {
    const t = s / (NS - 1);
    const x = side * len * t;
    // lens-shaped chord that swells then tapers to a point
    const w = width * (0.6 + 0.4 * Math.sin(Math.PI * Math.min(1, t * 1.2))) * (1 - 0.85 * t * t);
    const th = width * 0.16 * (1 - 0.7 * t) + 0.0015;
    const droop = -0.06 * t * t * len; // tips bend down at rest
    for (let p = 0; p < NP; p++) {
      const a = (p / NP) * Math.PI * 2;
      const z = Math.cos(a) * Math.max(0.003, w * 0.5);
      const y = Math.sin(a) * th + droop;
      verts.push(x, y, z);
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < NS - 1; s++) {
    const a = s * NP, b = (s + 1) * NP;
    for (let p = 0; p < NP; p++) {
      const q = (p + 1) % NP;
      if (side > 0) { idx.push(a + p, a + q, b + q); idx.push(a + p, b + q, b + p); }
      else { idx.push(a + p, b + q, a + q); idx.push(a + p, b + p, b + q); }
    }
  }
  const ci = verts.length / 3; verts.push(0, 0, 0);
  for (let p = 0; p < NP; p++) { const q = (p + 1) % NP; if (side > 0) idx.push(ci, q, p); else idx.push(ci, p, q); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return paint(g, (c, x, _y, _z, nx, ny, nz) => {
    const f = Math.min(1, Math.abs(x) / len);
    if (dark) c.copy(C_PRIMARY).lerp(C_PRIMARY_EDGE, f * 0.55);
    else c.copy(C_COVERT).lerp(C_PRIMARY, smoothstep(0.5, 1.0, f) * 0.7);
    c.multiplyScalar(sunlit(nx, ny, nz, 0.12));
  });
}

// Re-export the smooth-normal helper so Bird.ts can finish each lofted part with
// a clean, crease-aware shading pass before assembly.
export { toCreasedNormals };
