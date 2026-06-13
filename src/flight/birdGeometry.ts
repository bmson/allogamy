import * as THREE from 'three/webgpu';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

// Procedural geometry for the hero pelican. The guiding rule of this module is
// that NOTHING is a primitive and NOTHING has a straight edge: every form is a
// smooth surface SWEPT along a curved Catmull-Rom spine, with the cross-section
// radius easing continuously from station to station. Body, neck and tail are
// built so their joins are radius-matched and sunk together — at rest they read
// as ONE sinuous, continuous animal, not a kit of stuck-together parts. The bill
// down-curves along its own spline; the gular pouch is a soft swollen volume; the
// wings are single CONTINUOUS cambered airfoil membranes with curved leading and
// trailing edges (the primary "fingers" are a smoothly-scalloped trailing edge,
// NOT stacked flat cards); legs and webbed feet are tapering swept tubes with a
// soft curved web. Colour is baked per-vertex with a gentle broken-colour wash so
// the surface harmonises with the painterly splat world, then lit by the real
// scene sun + hemisphere via MeshStandardMaterial.
//
// Convention (matches Bird.ts): nose +Z, up +Y, wings along ±X.

// ---------------------------------------------------------------------------
// Palette — a heron/crane-grey pelican: soft pearl-grey back cooling to slate,
// near-charcoal primaries with a faint cool sheen, a warm ochre bill. Tuned to
// sit quietly against the meadow's misty cool greens while the soulful, sculpted
// form reads cleanly close to the chase camera.
// ---------------------------------------------------------------------------
export const C_BODY_TOP = new THREE.Color('#eef1f3'); // sunlit pearl back
export const C_BODY = new THREE.Color('#d8dde2'); // body grey
export const C_BODY_LOW = new THREE.Color('#a9b2bd'); // cool slate underside / soft AO
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
export const C_FEATHER_EDGE = new THREE.Color('#f3f5f6'); // pale plumage lip (highlight)
export const C_FEATHER_SHADE = new THREE.Color('#8b95a2'); // plumage overlap shadow

const SUN = new THREE.Vector3(-0.5, 0.55, -0.62).normalize();

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// Cheap value noise (hash-lattice, trilinear) used to break the geometry off its
// perfect mathematical surfaces — a few octaves of subtle displacement so the
// body, head and neck read as a soft-feathered animal rather than a chrome shell.
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
 * Push every vertex along its normal by layered noise so a smooth sweep gains an
 * organic, feathered softness. Tiny amplitudes only — enough to kill the perfect
 * mathematical sheen, never enough to break the silhouette. Recomputes normals.
 */
export function roughen(geo: THREE.BufferGeometry, amp: number, freq: number, biasDown = 0): THREE.BufferGeometry {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let d = fbm(x * freq, y * freq, z * freq) * amp;
    if (biasDown > 0 && nrm.getY(i) < 0) d += biasDown * amp * -nrm.getY(i);
    pos.setXYZ(i, x + nrm.getX(i) * d, y + nrm.getY(i) * d, z + nrm.getZ(i) * d);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
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

/**
 * A gentle painterly broken-colour wash, applied to a finished vertex-colour
 * buffer. Each vertex is nudged warm/cool by low-frequency noise so the surface
 * shimmers with subtle temperature variation like a Monet brushstroke — the
 * thing that lets the smooth bird sit in the splat-painted world instead of
 * looking like flat CAD plastic. Kept very subtle so the bird stays elegant.
 */
const C_WARM = new THREE.Color('#f3e6cf');
const C_COOL = new THREE.Color('#8fa0bf');
export function brokenColour(geo: THREE.BufferGeometry, strength: number, freq: number): THREE.BufferGeometry {
  const pos = geo.attributes.position;
  const col = geo.attributes.color as THREE.BufferAttribute;
  if (!col) return geo;
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = fbm(x * freq, y * freq + 3.1, z * freq + 7.7); // -1..1
    c.fromBufferAttribute(col, i);
    if (n > 0) c.lerp(C_WARM, n * strength);
    else c.lerp(C_COOL, -n * strength);
    col.setXYZ(i, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
  return geo;
}

// ===========================================================================
// SWEPT SURFACE CORE
// The single workhorse: sweep a closed elliptical cross-section along a smooth
// Catmull-Rom spine using parallel-transport frames (no twist flips, no kinks),
// with the half-width / half-height / centre easing continuously from station to
// station. This single primitive builds the body, neck, tail, bill, legs and
// toes — so every form on the bird is, by construction, a smooth curved tube with
// no straight edges and no hard primitive anywhere.
// ===========================================================================
export interface Profile {
  rx: number; // half-width  (lateral)
  ry: number; // half-height (vertical, in the spine's frame)
  yOff?: number; // pear/teardrop bias: pushes the lower half down (>0 = heavier belly)
  roll?: number; // optional roll of the section about the spine tangent (radians)
}

/**
 * Sweep `seg`-point ellipse rings along the spline through `spine` (world-ish
 * points), interpolating `profiles` (one per spine point) across `samples` rings.
 * Returns a watertight, smooth-normalled BufferGeometry. The frame is built by
 * parallel transport so the tube never pinches or twists at a bend — the secret
 * to a continuous, flowing surface through an S-curve.
 */
export function sweep(
  spine: THREE.Vector3[],
  profiles: Profile[],
  seg: number,
  samples: number,
  capStart = true,
  capEnd = true,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(spine, false, 'catmullrom', 0.5);
  const pts = curve.getSpacedPoints(samples - 1); // samples points
  // tangents
  const tan: THREE.Vector3[] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    tan.push(curve.getTangentAt(clamp01(t)).normalize());
  }
  // parallel-transport frames: start with a reference up, rotate it minimally to
  // stay perpendicular to each successive tangent. This avoids the wild twisting
  // a naive cross-product frame gives through a near-vertical S-bend.
  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  let nrm = new THREE.Vector3(0, 1, 0);
  // seed: make the first normal perpendicular to the first tangent
  if (Math.abs(tan[0].dot(nrm)) > 0.92) nrm.set(1, 0, 0);
  nrm.sub(tan[0].clone().multiplyScalar(tan[0].dot(nrm))).normalize();
  const q = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  for (let i = 0; i < samples; i++) {
    if (i > 0) {
      axis.crossVectors(tan[i - 1], tan[i]);
      const len = axis.length();
      if (len > 1e-6) {
        axis.divideScalar(len);
        const dot = tan[i - 1].dot(tan[i]);
        const ang = Math.acos(dot < -1 ? -1 : dot > 1 ? 1 : dot);
        q.setFromAxisAngle(axis, ang);
        nrm.applyQuaternion(q);
      }
      // re-orthogonalise against drift
      nrm.sub(tan[i].clone().multiplyScalar(tan[i].dot(nrm))).normalize();
    }
    const bin = new THREE.Vector3().crossVectors(tan[i], nrm).normalize();
    normals.push(nrm.clone());
    binormals.push(bin);
  }

  // resample the profile array across the ring samples
  const prof = (i: number): Profile => {
    const f = (i / (samples - 1)) * (profiles.length - 1);
    const a = Math.floor(f), b = Math.min(profiles.length - 1, a + 1), k = f - a;
    const pa = profiles[a], pb = profiles[b];
    return {
      rx: pa.rx + (pb.rx - pa.rx) * k,
      ry: pa.ry + (pb.ry - pa.ry) * k,
      yOff: (pa.yOff ?? 0) + ((pb.yOff ?? 0) - (pa.yOff ?? 0)) * k,
      roll: (pa.roll ?? 0) + ((pb.roll ?? 0) - (pa.roll ?? 0)) * k,
    };
  };

  const verts: number[] = [];
  for (let i = 0; i < samples; i++) {
    const c = pts[i], nA = normals[i], bA = binormals[i];
    const p = prof(i);
    const cr = Math.cos(p.roll ?? 0), sr = Math.sin(p.roll ?? 0);
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      let ex = Math.cos(a), ey = Math.sin(a);
      // pear/teardrop: drop the lower half a touch for belly weight
      const yb = ey < 0 ? ey * (1 + (p.yOff ?? 0)) : ey;
      // local roll of the section
      const lx = ex * cr - yb * sr;
      const ly = ex * sr + yb * cr;
      const ux = lx * p.rx, uy = ly * p.ry;
      verts.push(
        c.x + bA.x * ux + nA.x * uy,
        c.y + bA.y * ux + nA.y * uy,
        c.z + bA.z * ux + nA.z * uy,
      );
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < samples - 1; i++) {
    const a = i * seg, b = (i + 1) * seg;
    for (let s = 0; s < seg; s++) {
      const j = (s + 1) % seg;
      idx.push(a + s, a + j, b + j);
      idx.push(a + s, b + j, b + s);
    }
  }
  if (capStart) {
    const ci = verts.length / 3;
    verts.push(pts[0].x, pts[0].y, pts[0].z);
    for (let s = 0; s < seg; s++) idx.push(ci, ((s + 1) % seg), s);
  }
  if (capEnd) {
    const base = (samples - 1) * seg;
    const ci = verts.length / 3;
    const e = pts[samples - 1];
    verts.push(e.x, e.y, e.z);
    for (let s = 0; s < seg; s++) idx.push(ci, base + s, base + ((s + 1) % seg));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ===========================================================================
// BODY — one continuous swept teardrop. The spine arcs gently (rump dips, breast
// rises toward the shoulders) so the body is already a curve, never a straight
// barrel. Cross-section eases slim rump → heavy breast/belly → narrowing toward
// the neck join, where the radius is matched to the neck base so the seam reads
// continuous once articulated.
// ===========================================================================
export function buildBody(): THREE.BufferGeometry {
  // spine from tail-root (−Z) forward to the shoulder/neck join (+Z), curving up
  const spine = [
    new THREE.Vector3(0, 0.02, -0.96),
    new THREE.Vector3(0, 0.0, -0.7),
    new THREE.Vector3(0, -0.02, -0.4),
    new THREE.Vector3(0, -0.02, -0.05),
    new THREE.Vector3(0, 0.0, 0.3),
    new THREE.Vector3(0, 0.06, 0.58),
    new THREE.Vector3(0, 0.12, 0.78), // rises into the shoulders
  ];
  const profiles: Profile[] = [
    { rx: 0.02, ry: 0.02 }, // tail root
    { rx: 0.12, ry: 0.115, yOff: 0.18 },
    { rx: 0.2, ry: 0.215, yOff: 0.38 },
    { rx: 0.235, ry: 0.255, yOff: 0.46 }, // heaviest belly
    { rx: 0.215, ry: 0.235, yOff: 0.4 }, // breast
    { rx: 0.145, ry: 0.165, yOff: 0.24 },
    { rx: 0.082, ry: 0.092, yOff: 0.1 }, // neck join (matches buildNeck base)
  ];
  const g = sweep(spine, profiles, 40, 30, true, true);
  roughen(g, 0.013, 9, 0.55);
  paint(g, (c, _x, y, _z, nx, ny, nz, bb) => {
    const top = (y - bb.min.y) / Math.max(1e-3, bb.max.y - bb.min.y);
    c.copy(C_BODY_LOW).lerp(C_BODY, smoothstep(0.18, 0.55, top))
      .lerp(C_BODY_TOP, smoothstep(0.6, 1.0, top) * 0.85);
    // soft ambient occlusion gathering under the belly
    c.multiplyScalar(0.9 + 0.1 * smoothstep(0.1, 0.5, top));
    c.multiplyScalar(sunlit(nx, ny, nz, 0.14));
  });
  return brokenColour(g, 0.05, 7);
}

// ===========================================================================
// NECK — built as ONE continuous swept S-curve (the retracted soaring pelican
// neck), then sliced internally onto four bones by Bird so a travelling wave can
// animate it. Here we just build the resting S as a single smooth surface; Bird
// splits the SAME spine into segment meshes that line up seamlessly. We expose
// the resting spine so Bird can rebuild matching segment surfaces and place its
// joint pivots exactly on the curve — no seams, no separate "neck bricks".
// ===========================================================================
export const NECK_SPINE: THREE.Vector3[] = [
  new THREE.Vector3(0, 0.1, 0.0), // base, on the shoulders
  new THREE.Vector3(0, 0.26, 0.04),
  new THREE.Vector3(0, 0.4, -0.02), // folds back (the S)
  new THREE.Vector3(0, 0.5, -0.14),
  new THREE.Vector3(0, 0.55, -0.1),
  new THREE.Vector3(0, 0.58, 0.04), // sweeps forward again
  new THREE.Vector3(0, 0.6, 0.18), // head join, looking forward
];
export const NECK_PROFILES: Profile[] = [
  { rx: 0.082, ry: 0.09, yOff: 0.08 }, // matches body neck-join
  { rx: 0.07, ry: 0.078 },
  { rx: 0.062, ry: 0.07 },
  { rx: 0.058, ry: 0.066 },
  { rx: 0.056, ry: 0.064 },
  { rx: 0.052, ry: 0.06 },
  { rx: 0.05, ry: 0.058 }, // head join
];

/**
 * Build ONE neck segment as a swept sub-arc of the master S-spine, in the LOCAL
 * frame of its bone (so Bird can hinge it). `t0..t1` is the fraction of the spine
 * this segment covers; the segment is built starting at the origin pointing along
 * its own initial tangent, so consecutive bones, hinged at the resting angles,
 * reconstruct the exact continuous S — but can now flex. Overlapping a hair at
 * the joints keeps the surface watertight to the eye.
 */
export function buildNeckSegment(t0: number, t1: number): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(NECK_SPINE, false, 'catmullrom', 0.5);
  const N = 8;
  const pts: THREE.Vector3[] = [];
  const profs: Profile[] = [];
  const origin = curve.getPointAt(t0).clone();
  // local frame: align the segment's start tangent to +Y-ish but we keep it in the
  // bone's own space by translating to origin (Bird sets the bone's rotation).
  for (let i = 0; i < N; i++) {
    const t = t0 + (t1 - t0) * (i / (N - 1));
    pts.push(curve.getPointAt(clamp01(t)).clone().sub(origin));
    // sample profile along the master profile list
    const f = clamp01(t) * (NECK_PROFILES.length - 1);
    const a = Math.floor(f), b = Math.min(NECK_PROFILES.length - 1, a + 1), k = f - a;
    profs.push({
      rx: NECK_PROFILES[a].rx + (NECK_PROFILES[b].rx - NECK_PROFILES[a].rx) * k,
      ry: NECK_PROFILES[a].ry + (NECK_PROFILES[b].ry - NECK_PROFILES[a].ry) * k,
      yOff: (NECK_PROFILES[a].yOff ?? 0) + ((NECK_PROFILES[b].yOff ?? 0) - (NECK_PROFILES[a].yOff ?? 0)) * k,
    });
  }
  const g = sweep(pts, profs, 22, N, true, true);
  roughen(g, 0.005, 16);
  paint(g, (c, _x, _y, _z, nx, ny, nz) => {
    c.copy(C_NECK).multiplyScalar(sunlit(nx, ny, nz, 0.12) * 0.99);
  });
  return brokenColour(g, 0.04, 9);
}

// ===========================================================================
// HEAD — a smooth swept ovoid that tapers down the lores into the bill base, so
// the head→bill transition is continuous (no socketed prism). Dusky crown smudge.
// ===========================================================================
export function buildHead(): THREE.BufferGeometry {
  const spine = [
    new THREE.Vector3(0, 0.0, -0.07),
    new THREE.Vector3(0, 0.012, -0.02),
    new THREE.Vector3(0, 0.016, 0.04),
    new THREE.Vector3(0, 0.008, 0.1),
    new THREE.Vector3(0, -0.006, 0.16),
    new THREE.Vector3(0, -0.016, 0.21), // tapers to the bill base
  ];
  const profiles: Profile[] = [
    { rx: 0.025, ry: 0.025 },
    { rx: 0.082, ry: 0.088 },
    { rx: 0.096, ry: 0.1 },
    { rx: 0.086, ry: 0.09 },
    { rx: 0.056, ry: 0.054 },
    { rx: 0.034, ry: 0.03 },
  ];
  const g = sweep(spine, profiles, 26, 16, true, false);
  roughen(g, 0.0035, 22);
  return paint(g, (c, _x, y, z, nx, ny, nz, bb) => {
    const top = (y - bb.min.y) / Math.max(1e-3, bb.max.y - bb.min.y);
    const crown = smoothstep(0.55, 0.95, top) * smoothstep(0.18, -0.02, z);
    c.copy(C_FACE).lerp(C_CROWN, crown * 0.8);
    c.multiplyScalar(sunlit(nx, ny, nz, 0.12));
  });
}

// ===========================================================================
// BILL — a long, gently DOWN-CURVED sweep. The spine itself droops (quadratic),
// so the down-curve is real curvature of the centre-line, not a fake offset on a
// straight prism. Cross-section eases from a broad, flatish base to a slim tip
// with a subtle culmen ridge. Built for the upper or lower mandible.
// ===========================================================================
export function buildBill(len: number, upper: boolean): THREE.BufferGeometry {
  const N = 9;
  const spine: THREE.Vector3[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const z = t * len;
    const droop = -0.16 * t * t * len * 0.5; // curved centre-line
    spine.push(new THREE.Vector3(0, droop, z));
  }
  const profiles: Profile[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const w = (upper ? 0.072 : 0.062) * (1 - 0.78 * t) + 0.006;
    const h = (upper ? 0.05 : 0.03) * (1 - 0.82 * t) + 0.004;
    profiles.push({ rx: w, ry: h });
  }
  const g = sweep(spine, profiles, 16, N, true, true);
  roughen(g, 0.0015, 30);
  return paint(g, (c, x, y, z, nx, ny, nz, bb) => {
    const f = (z - bb.min.z) / Math.max(1e-3, bb.max.z - bb.min.z);
    const top = (y - bb.min.y) / Math.max(1e-3, bb.max.y - bb.min.y);
    c.copy(C_BILL).lerp(C_BILL_TIP, f * 0.9);
    if (top > 0.7) c.lerp(C_BILL_RIDGE, (top - 0.7) / 0.3 * 0.5); // culmen ridge
    if (upper) {
      const groove = smoothstep(0.06, 0.0, Math.abs(Math.abs(x) - 0.022))
        * smoothstep(0.05, 0.12, f) * smoothstep(0.34, 0.2, f) * (top > 0.55 ? 1 : 0);
      c.lerp(C_BILL_RIDGE.clone().multiplyScalar(0.55), groove * 0.8);
    }
    if (f > 0.9) c.lerp(C_BILL_TIP.clone().multiplyScalar(0.7), (f - 0.9) / 0.1 * 0.7); // hooked nail
    c.multiplyScalar(sunlit(nx, ny, nz, 0.16) * (top < 0.25 ? 0.9 : 1.0));
  });
}

// ===========================================================================
// GULAR POUCH — the signature pelican throat sac: a soft swollen volume slung
// under the lower mandible, swept along the bill's down-curve and bulging
// downward in the middle. A fleshy curved counterpoint to the bill, no prism.
// ===========================================================================
export function buildGular(len: number, sag: number): THREE.BufferGeometry {
  const N = 12;
  const spine: THREE.Vector3[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const z = t * len;
    const env = Math.sin(Math.PI * clamp01(t * 1.05));
    const droop = -0.16 * t * t * len * 0.5 - sag * env; // follows the bill + sags
    spine.push(new THREE.Vector3(0, droop - 0.01, z));
  }
  const profiles: Profile[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const env = Math.sin(Math.PI * clamp01(t * 1.05));
    profiles.push({ rx: 0.012 + 0.062 * env, ry: 0.01 + 0.05 * env, yOff: 0.5 * env });
  }
  const g = sweep(spine, profiles, 16, N, true, true);
  roughen(g, 0.003, 24);
  return paint(g, (c, _x, y, _z, nx, ny, nz) => {
    c.copy(C_BILL).lerp(C_BILL_TIP, 0.2);
    c.multiplyScalar((y < -0.03 ? 1.05 : 0.92) * sunlit(nx, ny, nz, 0.12));
  });
}

// ===========================================================================
// TAIL — a single smooth swept fan-wedge whose trailing edge is gently scalloped
// (a soft cosine ripple across the span) so it suggests rectrices WITHOUT being a
// stack of flat cards. Wide, thin, tapering; central feathers longest.
// ===========================================================================
export function buildTail(len: number, halfSpan: number): THREE.BufferGeometry {
  // Build directly as a cambered membrane: a grid (span × chord) with a curved
  // leading & trailing edge and a thin solid thickness, then smooth normals.
  const NSPAN = 17, NCHORD = 5;
  const top: number[] = [];
  const bot: number[] = [];
  for (let i = 0; i < NSPAN; i++) {
    const u = (i / (NSPAN - 1)) * 2 - 1; // -1..1 across the span
    const x = u * halfSpan;
    // central feathers longest, soft rounded fan; scalloped trailing edge
    const reach = len * (1 - 0.32 * u * u) * (1 + 0.04 * Math.cos(u * Math.PI * 6));
    const lift = 0.02 + 0.03 * Math.abs(u); // outer edges lift a touch (dihedral)
    for (let j = 0; j < NCHORD; j++) {
      const v = j / (NCHORD - 1); // 0 root → 1 trailing tip
      const z = -reach * v;
      const th = (0.02 * (1 - v) + 0.003) * (1 - 0.4 * Math.abs(u)); // thins to the edge
      const y = lift * v * v;
      top.push(x, y + th, z);
      bot.push(x, y - th, z);
    }
  }
  return membraneFromGrids(top, bot, NSPAN, NCHORD, (c, _x, _y, z, nx, ny, nz, bb) => {
    const f = (bb.max.z - z) / Math.max(1e-3, bb.max.z - bb.min.z);
    c.copy(C_COVERT).lerp(C_PRIMARY, smoothstep(0.45, 1.0, f) * 0.8);
    c.lerp(C_FEATHER_SHADE, smoothstep(0.0, 0.3, 1 - f) * 0.18);
    c.multiplyScalar(sunlit(nx, ny, nz, 0.12));
  });
}

// ===========================================================================
// MEMBRANE — a continuous double-sided cambered surface from a top grid and a
// bottom grid (same indexing, NSPAN×NCHORD). Seams the rims so it's watertight,
// smooth-normalled, and reads as one flowing skin. This is the basis for the
// tail and the wing — NO flat cards, NO straight chords (the caller curves the
// edges), one draw surface per wing.
// ===========================================================================
function membraneFromGrids(
  top: number[], bot: number[], NSPAN: number, NCHORD: number, fn: PaintFn, flip = false,
): THREE.BufferGeometry {
  const nTop = top.length / 3;
  const verts = top.concat(bot);
  const idx: number[] = [];
  const at = (i: number, j: number) => i * NCHORD + j; // top index
  const ab = (i: number, j: number) => nTop + i * NCHORD + j; // bottom index
  // push a triangle, flipping winding when the i-axis is mirrored (left wing) so
  // the closed shell's front faces always point outward for single-sided shading.
  const tri = (a: number, b: number, c: number) => {
    if (flip) idx.push(a, c, b); else idx.push(a, b, c);
  };
  // top sheet
  for (let i = 0; i < NSPAN - 1; i++) {
    for (let j = 0; j < NCHORD - 1; j++) {
      tri(at(i, j), at(i, j + 1), at(i + 1, j + 1));
      tri(at(i, j), at(i + 1, j + 1), at(i + 1, j));
    }
  }
  // bottom sheet (reversed winding)
  for (let i = 0; i < NSPAN - 1; i++) {
    for (let j = 0; j < NCHORD - 1; j++) {
      tri(ab(i, j), ab(i + 1, j + 1), ab(i, j + 1));
      tri(ab(i, j), ab(i + 1, j), ab(i + 1, j + 1));
    }
  }
  // seam the leading edge (j=0), trailing edge (j=NCHORD-1) and both wingtips
  for (let i = 0; i < NSPAN - 1; i++) {
    // leading edge
    tri(at(i, 0), ab(i, 0), ab(i + 1, 0));
    tri(at(i, 0), ab(i + 1, 0), at(i + 1, 0));
    // trailing edge
    const j = NCHORD - 1;
    tri(at(i, j), at(i + 1, j), ab(i + 1, j));
    tri(at(i, j), ab(i + 1, j), ab(i, j));
  }
  for (let j = 0; j < NCHORD - 1; j++) {
    // root tip (i=0)
    tri(at(0, j), at(0, j + 1), ab(0, j + 1));
    tri(at(0, j), ab(0, j + 1), ab(0, j));
    // outer tip (i=NSPAN-1)
    const i = NSPAN - 1;
    tri(at(i, j), ab(i, j + 1), at(i, j + 1));
    tri(at(i, j), ab(i, j), ab(i, j + 1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return paint(g, fn);
}

// ===========================================================================
// WING — ONE continuous cambered airfoil membrane per wing, root at x=0 reaching
// out along side·X. The whole thing is a single flowing skin: a CURVED leading
// edge (swept back and bowed), a CURVED trailing edge that develops soft
// scalloped "fingers" toward the tip (the emarginated primaries — suggested by a
// smooth cosine ripple, NOT by separate cards), gentle camber and real thickness
// tapering to a soft tip. The planform sweeps and tapers like a soaring bird's
// wing. Built once per side and bent only at the shoulder/elbow/wrist bones in
// Bird (the membrane itself is one mesh per bone-region: arm, fore, hand).
//
// `span0..span1` is the X extent of this section; `rootChord`/`tipChord` the
// fore-aft depth at each end; `le0`/`le1` how far forward (+Z) the leading edge
// sits; `fingers` enables the scalloped primary slots on the trailing edge
// (true for the hand section only). All edges are curves.
// ===========================================================================
export function buildWingSection(
  side: number,
  span0: number, span1: number,
  rootChord: number, tipChord: number,
  le0: number, le1: number,
  rootThick: number, tipThick: number,
  fingers: boolean,
  inner: boolean,
): THREE.BufferGeometry {
  const NSPAN = fingers ? 26 : 14;
  const NCHORD = 7;
  const top: number[] = [];
  const bot: number[] = [];
  for (let i = 0; i < NSPAN; i++) {
    const t = i / (NSPAN - 1); // 0 root → 1 tip
    const x = side * (span0 + (span1 - span0) * t);
    const chord = rootChord + (tipChord - rootChord) * t;
    const thick = rootThick + (tipThick - rootThick) * t;
    // leading edge bows forward then sweeps back — a smooth curve, never straight
    const le = le0 + (le1 - le0) * t + 0.04 * Math.sin(t * Math.PI);
    for (let j = 0; j < NCHORD; j++) {
      const v = j / (NCHORD - 1); // 0 leading → 1 trailing
      // trailing-edge envelope: rounded at the wrist, scalloped into soft fingers
      // toward the tip if `fingers`. The scallop is a smooth cosine, so the slots
      // are curves — emarginated tips suggested, not stamped cards.
      let trail = chord;
      if (fingers) {
        const finger = 0.5 + 0.5 * Math.cos((t * 4.5 - 0.2) * Math.PI * 2); // 0..1 ripple
        const depth = smoothstep(0.45, 1.0, t); // fingers only develop toward the tip
        trail = chord * (1 - 0.42 * depth * (1 - finger));
        // outer fingers also reach further back (longer primaries)
        trail += chord * 0.5 * smoothstep(0.5, 1.0, t) * finger;
      }
      const z = le - trail * v;
      // camber: the surface bows up; thicker near the leading edge (teardrop)
      const camberShape = Math.sin(Math.PI * v); // 0 at edges, 1 mid-chord
      const thFactor = (1 - v) * 0.7 + 0.3; // fuller leading edge
      const th = thick * thFactor * (0.4 + 0.6 * camberShape);
      const camber = 0.55 * thick * camberShape * (1 - 0.3 * t);
      // gentle whole-wing droop and a soft downward bow at the tip (gull curve)
      const droop = -0.06 * t * t - 0.02 * v * t;
      const y = camber + droop;
      top.push(x, y + th, z);
      bot.push(x, y - th * 0.7, z); // underside a touch flatter (airfoil)
    }
  }
  return membraneFromGrids(top, bot, NSPAN, NCHORD, (c, _x, y, z, nx, ny, nz, bb) => {
    const t = Math.abs(_x) / Math.max(1e-3, Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x)));
    const top01 = (y - bb.min.y) / Math.max(1e-3, bb.max.y - bb.min.y);
    const trail01 = (bb.max.z - z) / Math.max(1e-3, bb.max.z - bb.min.z); // 0 LE → 1 TE
    // inner wing pale covert grey; the primaries (outer + trailing) go charcoal
    const primary = fingers ? smoothstep(0.35, 0.95, Math.max(t, trail01 * 0.7)) : (inner ? 0 : 0.3 * t);
    const base = C_COVERT.clone().lerp(C_PRIMARY, primary);
    c.copy(C_COVERT_LOW).lerp(base, smoothstep(0.2, 0.7, top01));
    // a pale lip along the very trailing edge (sunlit feather rim)
    c.lerp(C_FEATHER_EDGE, smoothstep(0.86, 1.0, trail01) * 0.4 * (1 - primary));
    // cool sheen highlight on the dark primary tips
    if (primary > 0.5) c.lerp(C_PRIMARY_EDGE, smoothstep(0.6, 1.0, t) * 0.4);
    c.multiplyScalar(sunlit(nx, ny, nz, 0.13));
  }, side < 0); // mirror the winding for the left wing so faces point outward
}

// ===========================================================================
// SCAPULAR MANTLE — a soft, continuous swept cape laid over the shoulders/back,
// blending the body into the wing roots so there's no hard seam where the wings
// meet the torso. A single smooth surface (NOT rows of covert cards), gently
// scalloped at its trailing edge to whisper "folded plumage". Sits on the back.
// ===========================================================================
export function buildMantle(): THREE.BufferGeometry {
  const NSPAN = 19, NCHORD = 5;
  const top: number[] = [];
  const bot: number[] = [];
  for (let i = 0; i < NSPAN; i++) {
    const u = (i / (NSPAN - 1)) * 2 - 1; // -1..1 across the back
    const x = u * 0.22;
    // the cape drapes down the flanks: y drops with |u|
    const drape = -0.16 * u * u;
    // front (over shoulders) to back (toward rump)
    const z0 = 0.55 - 0.06 * u * u; // leading edge near the shoulders
    const reach = 0.95 * (1 - 0.25 * u * u) * (1 + 0.03 * Math.cos(u * Math.PI * 5)); // scalloped hem
    for (let j = 0; j < NCHORD; j++) {
      const v = j / (NCHORD - 1); // 0 shoulders → 1 rump
      const z = z0 - reach * v;
      const lift = 0.16 + drape - 0.05 * v; // sits just above the back
      const th = 0.012 * (1 - 0.5 * v) + 0.002;
      top.push(x, lift + th, z);
      bot.push(x, lift - th, z);
    }
  }
  return membraneFromGrids(top, bot, NSPAN, NCHORD, (c, x, _y, z, nx, ny, nz, bb) => {
    const f = (bb.max.z - z) / Math.max(1e-3, bb.max.z - bb.min.z);
    const lat = Math.abs(x) / 0.22;
    c.copy(C_BODY_TOP).lerp(C_COVERT, smoothstep(0.3, 0.9, f) * 0.7);
    c.lerp(C_FEATHER_SHADE, lat * 0.25 + smoothstep(0.6, 1.0, f) * 0.15);
    c.lerp(C_FEATHER_EDGE, smoothstep(0.9, 1.0, f) * 0.3);
    c.multiplyScalar(sunlit(nx, ny, nz, 0.13));
  });
}

/** Length of the tarsus bone — Bird places the ankle/foot group at this −Z reach. */
export const TARSUS_LEN = 0.26;

// ===========================================================================
// LEG (tarsus) — a slim swept tube, faint knee swelling at the top tapering to
// the ankle, gently curved (not a straight cylinder). Hip at the origin, trailing
// toward −Z and dropping a little.
// ===========================================================================
export function buildLeg(_side: number): THREE.BufferGeometry {
  const N = 7;
  const spine: THREE.Vector3[] = [];
  const profiles: Profile[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const z = -TARSUS_LEN * t;
    const drop = -0.05 * t - 0.015 * Math.sin(t * Math.PI); // slight curve
    spine.push(new THREE.Vector3(0, drop, z));
    const r = (0.03 - 0.012 * t) * (1 + 0.4 * Math.exp(-((t - 0.05) ** 2) / 0.02)) + 0.004;
    profiles.push({ rx: r, ry: r * 1.05 });
  }
  const g = sweep(spine, profiles, 12, N, true, true);
  roughen(g, 0.0016, 40);
  return paint(g, (c, _x, y, _z, nx, ny, nz) => {
    c.copy(C_LEG).lerp(C_LEG_DARK, Math.max(0, -ny) * 0.3 + smoothstep(0.0, -0.05, y) * 0.2);
    c.multiplyScalar(sunlit(nx, ny, nz, 0.1));
  });
}

// ===========================================================================
// WEBBED FOOT — three forward toes as slim swept tapering tubes, joined by a soft
// CURVED web membrane (a cambered sheet, dipping between the toes), ankle at the
// origin, toes reaching −Z. No flat triangles, no prisms: tubes + a curved skin.
// ===========================================================================
export function buildFoot(side: number): THREE.BufferGeometry {
  const toeLen = 0.17;
  const toeAngles = [-0.4, 0, 0.4];
  const ankle = new THREE.Vector3(0, 0, 0);
  const tips = toeAngles.map((a) =>
    new THREE.Vector3(side * Math.sin(a) * toeLen, -0.014, -Math.cos(a) * toeLen));

  // toe digits — slim swept tubes with a soft dip
  const parts: THREE.BufferGeometry[] = [];
  for (const tip of tips) {
    const N = 5;
    const spine: THREE.Vector3[] = [];
    const profs: Profile[] = [];
    for (let s = 0; s < N; s++) {
      const t = s / (N - 1);
      spine.push(new THREE.Vector3(
        ankle.x + (tip.x - ankle.x) * t,
        ankle.y + (tip.y - ankle.y) * t - 0.01 * Math.sin(Math.PI * t),
        ankle.z + (tip.z - ankle.z) * t,
      ));
      const r = 0.013 * (1 - 0.75 * t) + 0.0025;
      profs.push({ rx: r, ry: r });
    }
    parts.push(sweep(spine, profs, 8, N, true, true));
  }

  // web membrane — a curved cambered sheet spanning the three toes, dipping
  // (scalloped) between adjacent toes so the membrane reads as soft webbing.
  const NU = 13, NV = 5;
  const top: number[] = [];
  const bot: number[] = [];
  for (let i = 0; i < NU; i++) {
    const u = i / (NU - 1); // 0 → outer toe, 1 → other outer toe, across the splay
    const ang = toeAngles[0] + (toeAngles[2] - toeAngles[0]) * u;
    // dip between toes: minimal at the toe rays, deepest midway between them
    const between = Math.sin(u * Math.PI * 2); // ±1 between the three rays
    for (let j = 0; j < NV; j++) {
      const v = j / (NV - 1); // 0 ankle → 1 toe-tip line
      const reach = toeLen * v;
      const x = side * Math.sin(ang) * reach;
      const z = -Math.cos(ang) * reach;
      const dip = -0.016 * Math.abs(between) * v; // membrane sags between the toes
      const y = -0.012 * v + dip;
      const th = 0.0035;
      top.push(x, y + th, z);
      bot.push(x, y - th, z);
    }
  }
  const web = membraneFromGrids(top, bot, NU, NV, (c) => { c.copy(C_WEB); }, side < 0);
  parts.push(web);

  // merge toe-tubes + web into one mesh
  const merged = mergeGeos(parts);
  return paint(merged, (c, _x, y, _z, nx, ny, nz) => {
    const onWeb = Math.abs(y) < 0.008;
    c.copy(onWeb ? C_WEB : C_LEG).lerp(C_LEG_DARK, Math.max(0, -ny) * 0.3);
    c.multiplyScalar(sunlit(nx, ny, nz, 0.1));
  });
}

/** Minimal indexed merge of position/normal attributes (colour rebaked by caller). */
function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vT = 0, iT = 0;
  for (const g of geos) { vT += g.attributes.position.count; iT += g.index!.count; }
  const P = new Float32Array(vT * 3), Nn = new Float32Array(vT * 3);
  const I = new Uint32Array(iT);
  let vo = 0, io = 0, base = 0;
  for (const g of geos) {
    P.set(g.attributes.position.array as Float32Array, vo * 3);
    if (g.attributes.normal) Nn.set(g.attributes.normal.array as Float32Array, vo * 3);
    const gi = g.index!;
    for (let k = 0; k < gi.count; k++) I[io + k] = gi.getX(k) + base;
    vo += g.attributes.position.count; io += gi.count; base += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(Nn, 3));
  out.setIndex(new THREE.BufferAttribute(I, 1));
  out.computeVertexNormals();
  return out;
}

// Re-export the smooth-normal helper so Bird.ts can finish each part with a
// clean, crease-aware shading pass before assembly.
export { toCreasedNormals };
