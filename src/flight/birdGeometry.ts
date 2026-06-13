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

export const C_LEG = new THREE.Color('#caa05a'); // warm ochre-grey leg
export const C_LEG_DARK = new THREE.Color('#8f7038'); // joint / scute shadow
export const C_WEB = new THREE.Color('#d9b56a'); // pale web
export const C_FEATHER_EDGE = new THREE.Color('#f3f5f6'); // pale feather lip (highlight)
export const C_FEATHER_SHADE = new THREE.Color('#8b95a2'); // feather-overlap shadow

const SUN = new THREE.Vector3(-0.5, 0.55, -0.62).normalize();

// ---------------------------------------------------------------------------
// Cheap value noise (hash-lattice, trilinear) used to break the geometry off its
// perfect mathematical surfaces — a few octaves of subtle displacement so the
// body, head and neck read as a soft-feathered animal, not a chrome ellipsoid.
// ---------------------------------------------------------------------------
function hash3(x: number, y: number, z: number): number {
  let h = x * 374761393 + y * 668265263 + z * 1274126177;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) / 4294967295) * 2 - 1; // -1..1
}
function vnoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), u), x10 = lerp(c(0, 1, 0), c(1, 1, 0), u);
  const x01 = lerp(c(0, 0, 1), c(1, 0, 1), u), x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}
/** Fractal noise, ~2 octaves, returned in -1..1. */
function fbm(x: number, y: number, z: number): number {
  return 0.66 * vnoise(x, y, z) + 0.34 * vnoise(x * 2.1 + 11, y * 2.1 + 5, z * 2.1 + 3);
}

/**
 * Push every vertex along its normal by layered noise so a smooth loft gains an
 * organic, feathered lumpiness. `amp` scales the displacement; `freq` the lattice
 * density. Re-runs normals afterwards. Mutates and returns the geometry.
 */
export function roughen(geo: THREE.BufferGeometry, amp: number, freq: number, biasDown = 0): THREE.BufferGeometry {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let d = fbm(x * freq, y * freq, z * freq) * amp;
    // bias the displacement to puff the underside (loose belly down) a touch
    if (biasDown > 0 && nrm.getY(i) < 0) d += biasDown * amp * -nrm.getY(i);
    pos.setXYZ(i, x + nrm.getX(i) * d, y + nrm.getY(i) * d, z + nrm.getZ(i) * d);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Bake a fine feather-tract texture into the vertex colour: stacked rows of
 * contour feathers flowing tail-ward, each with a darker overlap shadow at its
 * leading edge and a pale lip — a subtle vermiculation that reads as plumage
 * rather than painted plastic. `flow` orients the rows; call after paint().
 */
export function featherTexture(
  geo: THREE.BufferGeometry, rowFreq: number, strength: number,
): THREE.BufferGeometry {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const col = geo.attributes.color as THREE.BufferAttribute;
  if (!col) return geo;
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // rows run across the body (vary with z), broken up laterally by noise so
    // they're not perfect stripes; saw-tooth gives each feather a hard leading lip
    const phase = z * rowFreq + 0.6 * fbm(x * 7, y * 7, z * 7) + 0.4 * Math.abs(x) * rowFreq;
    const saw = phase - Math.floor(phase); // 0..1 within a feather
    const lip = smoothstep(0.0, 0.12, saw); // dark→pale across the leading edge
    const tip = smoothstep(0.78, 1.0, saw); // pale lip at the trailing tip
    c.fromBufferAttribute(col, i);
    // overlap shadow at the feather root, faint highlight at its lip
    c.lerp(C_FEATHER_SHADE, (1 - lip) * strength * 0.7);
    c.lerp(C_FEATHER_EDGE, tip * strength * 0.5);
    // dorsal feathers a touch crisper than ventral down
    const up = Math.max(0, nrm.getY(i));
    c.multiplyScalar(1 - 0.04 * strength * (1 - up));
    col.setXYZ(i, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
  return geo;
}

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
  const g = loft(stations, 40);
  // organic lumpiness: soft feathered swells, with the loose belly puffed down
  roughen(g, 0.014, 9, 0.6);
  paint(g, (c, _x, y, _z, nx, ny, nz, bb) => {
    const top = (y - bb.min.y) / Math.max(1e-3, bb.max.y - bb.min.y);
    // pearl back → grey flanks → cool slate belly (soft baked AO underneath)
    c.copy(C_BODY_LOW).lerp(C_BODY, smoothstep(0.18, 0.55, top))
      .lerp(C_BODY_TOP, smoothstep(0.6, 1.0, top) * 0.85);
    c.multiplyScalar(sunlit(nx, ny, nz, 0.14));
  });
  // contour-feather tracts flowing tail-ward
  return featherTexture(g, 26, 0.5);
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
  const g = loft(stations, 22, true, true);
  roughen(g, 0.006, 16); // fine down ripple
  paint(g, (c, _x, _y, _z, nx, ny, nz) => {
    c.copy(C_NECK).multiplyScalar(sunlit(nx, ny, nz, 0.12) * 0.99);
  });
  return featherTexture(g, 34, 0.4);
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
  const g = loft(stations, 26, true, false);
  roughen(g, 0.004, 22); // fine head feathering
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
  roughen(g, 0.0018, 30); // faint horny texture, keeps the bill from looking plastic
  return paint(g, (c, x, y, z, nx, ny, nz, bb) => {
    const f = (z - bb.min.z) / Math.max(1e-3, bb.max.z - bb.min.z);
    const top = (y - bb.min.y) / Math.max(1e-3, bb.max.y - bb.min.y);
    c.copy(C_BILL).lerp(C_BILL_TIP, f * 0.9);
    if (top > 0.7) c.lerp(C_BILL_RIDGE, (top - 0.7) / 0.3 * 0.5); // culmen ridge
    // nostril groove: a short dark slit along the upper bill near the base
    if (upper) {
      const groove = smoothstep(0.06, 0.0, Math.abs(Math.abs(x) - 0.024))
        * smoothstep(0.05, 0.12, f) * smoothstep(0.34, 0.2, f) * (top > 0.55 ? 1 : 0);
      c.lerp(C_BILL_RIDGE.clone().multiplyScalar(0.55), groove * 0.8);
    }
    // a darker hooked nail at the very tip
    if (f > 0.9) c.lerp(C_BILL_TIP.clone().multiplyScalar(0.7), (f - 0.9) / 0.1 * 0.7);
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

// ---------------------------------------------------------------------------
// Covert feather — a small, rounded, solid scale-like feather used in overlapping
// rows over the back, shoulders and wing roots so the plumage has real layered
// silhouette and self-shadowing, not just a painted gradient. Length along +Z
// (tail-ward), curling down at the tip; built thin but solid.
// ---------------------------------------------------------------------------
export function buildCovert(len: number, width: number, tone: number): THREE.BufferGeometry {
  const NS = 5, NP = 7;
  const verts: number[] = [];
  for (let s = 0; s < NS; s++) {
    const t = s / (NS - 1);
    const z = -len * t; // trails tail-ward (−Z)
    const w = width * Math.sin(Math.PI * Math.min(1, 0.2 + t * 0.85)) * (1 - 0.5 * t);
    const th = width * 0.12 * (1 - 0.6 * t) + 0.001;
    const drop = -0.18 * t * t * len; // curls down over the body
    for (let p = 0; p < NP; p++) {
      const a = (p / NP) * Math.PI * 2;
      verts.push(Math.cos(a) * Math.max(0.002, w * 0.5), Math.sin(a) * th + drop, z);
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < NS - 1; s++) {
    const a = s * NP, b = (s + 1) * NP;
    for (let p = 0; p < NP; p++) {
      const q = (p + 1) % NP;
      idx.push(a + p, a + q, b + q); idx.push(a + p, b + q, b + p);
    }
  }
  const ci = verts.length / 3; verts.push(0, 0, 0);
  for (let p = 0; p < NP; p++) { const q = (p + 1) % NP; idx.push(ci, q, p); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return paint(g, (c, _x, _y, z, nx, ny, nz, bb) => {
    const f = (bb.max.z - z) / Math.max(1e-3, bb.max.z - bb.min.z); // 0 root → 1 tip
    c.copy(C_BODY).lerp(C_BODY_TOP, tone);
    c.lerp(C_FEATHER_SHADE, smoothstep(0.0, 0.25, 1 - f) * 0.4); // shaded root
    c.lerp(C_FEATHER_EDGE, smoothstep(0.7, 1.0, f) * 0.5); // pale lip
    c.multiplyScalar(sunlit(nx, ny, nz, 0.13));
  });
}

// ---------------------------------------------------------------------------
// Gular pouch — the soft, slightly slack throat sac slung under the lower
// mandible. A smooth lofted half-trough that hangs a little, swelling toward the
// base; gives the bird its unmistakable pelican character and an organic, fleshy
// counterpoint to the hard bill. Built along +Z under the jaw.
// ---------------------------------------------------------------------------
export function buildGular(len: number, sag: number): THREE.BufferGeometry {
  const N = 11, NP = 14;
  const verts: number[] = [];
  for (let s = 0; s < N; s++) {
    const t = s / (N - 1);
    const z = t * len;
    const env = Math.sin(Math.PI * Math.min(1, t * 1.05)); // 0 at ends, full mid
    const hw = 0.01 + 0.066 * env;
    const drop = -sag * env;
    const topY = -0.012;
    for (let p = 0; p < NP; p++) {
      const a = (p / NP) * Math.PI * 2;
      // only the lower ~2/3 of the ring is the soft sac; the top is the jaw line
      const ya = Math.sin(a), xa = Math.cos(a);
      const y = ya < 0 ? topY + ya * (-drop) : topY + ya * 0.006;
      verts.push(xa * hw, y, z);
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < N - 1; s++) {
    const a = s * NP, b = (s + 1) * NP;
    for (let p = 0; p < NP; p++) { const q = (p + 1) % NP; idx.push(a + p, a + q, b + q); idx.push(a + p, b + q, b + p); }
  }
  for (const cap of [0, N - 1]) {
    const base = cap * NP; const ci = verts.length / 3;
    verts.push(0, -0.012, cap === 0 ? 0 : len);
    for (let p = 0; p < NP; p++) { const q = (p + 1) % NP; if (cap === 0) idx.push(ci, q, p); else idx.push(ci, p, q); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  roughen(g, 0.003, 24); // soft fleshy ripple
  return paint(g, (c, _x, y, _z, nx, ny, nz) => {
    // warm fleshy ochre, brighter where it bulges down (slack-skin translucence)
    c.copy(C_BILL).lerp(C_BILL_TIP, 0.2);
    c.multiplyScalar((y < -0.03 ? 1.05 : 0.92) * sunlit(nx, ny, nz, 0.12));
  });
}

/** Length of the tarsus bone — Bird places the ankle/foot group at this −Z reach. */
export const TARSUS_LEN = 0.26;

// ---------------------------------------------------------------------------
// Tarsus — the slim bare lower-leg bone, hip at the origin, trailing toward −Z
// and angling down a touch. Built as its own piece so Bird can hinge a separate
// webbed foot at the ankle and curl the toes organically in flight.
// ---------------------------------------------------------------------------
export function buildLeg(_side: number): THREE.BufferGeometry {
  const NS = 6, NP = 9;
  const tlen = TARSUS_LEN;
  const verts: number[] = [];
  for (let s = 0; s < NS; s++) {
    const t = s / (NS - 1);
    // a faint knee swelling near the top, tapering to the ankle
    const r = (0.03 - 0.012 * t) * (1 + 0.4 * Math.exp(-((t - 0.05) ** 2) / 0.02)) + 0.004;
    const z = -tlen * t;
    const drop = -0.05 * t;
    for (let p = 0; p < NP; p++) {
      const a = (p / NP) * Math.PI * 2;
      verts.push(Math.cos(a) * r, Math.sin(a) * r + drop, z);
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < NS - 1; s++) {
    const a = s * NP, b = (s + 1) * NP;
    for (let p = 0; p < NP; p++) { const q = (p + 1) % NP; idx.push(a + p, a + q, b + q); idx.push(a + p, b + q, b + p); }
  }
  for (const cap of [0, NS - 1]) {
    const base = cap * NP; const ci = verts.length / 3;
    verts.push(0, cap === 0 ? 0 : -0.05, -tlen * (cap / (NS - 1)));
    for (let p = 0; p < NP; p++) { const q = (p + 1) % NP; if (cap === 0) idx.push(ci, q, p); else idx.push(ci, base + p, base + q); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  roughen(g, 0.0016, 40); // faint scaly tarsus texture
  return paint(g, (c, _x, y, _z, nx, ny, nz) => {
    c.copy(C_LEG).lerp(C_LEG_DARK, Math.max(0, -ny) * 0.3 + smoothstep(0.0, -0.05, y) * 0.2);
    c.multiplyScalar(sunlit(nx, ny, nz, 0.1));
  });
}

// ---------------------------------------------------------------------------
// Webbed foot — three forward toes joined by a thin web, splayed flat. Built with
// the ankle at the ORIGIN and the toes reaching toward −Z, so Bird can hinge it
// off the tarsus tip and flex/curl it. Toes are solid slim digits along the web's
// outer edges with the membrane stretched between them.
// ---------------------------------------------------------------------------
export function buildFoot(side: number): THREE.BufferGeometry {
  const toeLen = 0.17;
  const toeAngles = [-0.36, 0, 0.36];
  const fv: number[] = []; const fi: number[] = [];
  const ankle = new THREE.Vector3(0, 0, 0);
  const tips = toeAngles.map((a) =>
    new THREE.Vector3(side * Math.sin(a) * toeLen, -0.012, -Math.cos(a) * toeLen));
  // web membrane — a thin solid sheet (top + bottom) spanning the toes
  const pushTri = (A: THREE.Vector3, B: THREE.Vector3, C: THREE.Vector3) => {
    const o = fv.length / 3;
    fv.push(A.x, A.y + 0.004, A.z, B.x, B.y + 0.004, B.z, C.x, C.y + 0.004, C.z);
    fv.push(A.x, A.y - 0.004, A.z, B.x, B.y - 0.004, B.z, C.x, C.y - 0.004, C.z);
    fi.push(o, o + 1, o + 2, o + 3, o + 5, o + 4);
  };
  pushTri(ankle, tips[0], tips[1]);
  pushTri(ankle, tips[1], tips[2]);
  // solid toe digits — slim tapered prisms along each toe ray
  const NP = 6;
  const toeGeos: THREE.BufferGeometry[] = [];
  for (const tip of tips) {
    const verts: number[] = []; const idx: number[] = [];
    const STN = 4;
    for (let s = 0; s < STN; s++) {
      const t = s / (STN - 1);
      const px = ankle.x + (tip.x - ankle.x) * t;
      const py = ankle.y + (tip.y - ankle.y) * t - 0.006 * Math.sin(Math.PI * t);
      const pz = ankle.z + (tip.z - ankle.z) * t;
      const r = 0.012 * (1 - 0.8 * t) + 0.002;
      for (let p = 0; p < NP; p++) {
        const a = (p / NP) * Math.PI * 2;
        verts.push(px + Math.cos(a) * r, py + Math.sin(a) * r, pz);
      }
    }
    for (let s = 0; s < STN - 1; s++) {
      const a = s * NP, b = (s + 1) * NP;
      for (let p = 0; p < NP; p++) { const q = (p + 1) % NP; idx.push(a + p, a + q, b + q); idx.push(a + p, b + q, b + p); }
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    tg.setIndex(idx); tg.computeVertexNormals();
    toeGeos.push(tg);
  }
  const web = new THREE.BufferGeometry();
  web.setAttribute('position', new THREE.BufferAttribute(new Float32Array(fv), 3));
  web.setIndex(fi); web.computeVertexNormals();

  // merge web + toes
  const all = [web, ...toeGeos];
  let vT = 0, iT = 0;
  for (const g of all) { vT += g.attributes.position.count; iT += g.index!.count; }
  const P = new Float32Array(vT * 3), Nn = new Float32Array(vT * 3); const I = new Uint32Array(iT);
  let vo = 0, io = 0, bse = 0;
  for (const g of all) {
    P.set(g.attributes.position.array as Float32Array, vo * 3);
    Nn.set(g.attributes.normal.array as Float32Array, vo * 3);
    const gi = g.index!; for (let k = 0; k < gi.count; k++) I[io + k] = gi.getX(k) + bse;
    vo += g.attributes.position.count; io += gi.count; bse += g.attributes.position.count; g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(Nn, 3));
  out.setIndex(new THREE.BufferAttribute(I, 1));
  return paint(out, (c, _x, y, _z, nx, ny, nz) => {
    const onWeb = Math.abs(y) < 0.006; // the thin membrane
    c.copy(onWeb ? C_WEB : C_LEG).lerp(C_LEG_DARK, Math.max(0, -ny) * 0.3);
    c.multiplyScalar(sunlit(nx, ny, nz, 0.1));
  });
}

// Re-export the smooth-normal helper so Bird.ts can finish each lofted part with
// a clean, crease-aware shading pass before assembly.
export { toCreasedNormals };
