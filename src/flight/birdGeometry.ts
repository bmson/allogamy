import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ===========================================================================
// THE PELICAN — procedural geometry, rebuilt for COHERENCE.
//
// The whole bird is now ONE continuous, welded skin. Instead of bolting a dozen
// independently-capped tubes and membranes together (which left visible normal
// seams at every joint — body/neck/head/tail each reading as a separate primitive),
// the body + neck + head + bill + tail are swept as a SINGLE uninterrupted surface
// along ONE long master spline: rump → belly → breast → up the S-neck → head →
// down the bill, with the tail and a soft tail-fan grown out of the same surface.
// There are NO interior caps along that run, so the normal field flows unbroken
// from nose to tail — the silhouette and shading are continuous by construction.
//
// The wings are each ONE cambered membrane whose ROOT is buried inside the body
// (a shoulder fairing) so there is no hard seam where wing meets back.
//
// Articulation without tearing: every vertex of the unified skin is given smooth
// SKIN WEIGHTS against a small bone chain (tail, body, 4 neck bones, head, jaw,
// and per-wing shoulder/elbow/wrist/hand). Because weights blend across each
// joint, bending a bone smoothly drags the shared surface with it — the skin
// stretches at the joint instead of opening a gap. One SkinnedMesh, one material,
// one draw call for the whole body; one SkinnedMesh per wing. A genuine single
// organic form that bends like a supple animal.
//
// Stylisation: a smooth, carved, slightly-Ghibli sculpture. Soft confident curves,
// a clean planar read, gentle baked light + a quiet painterly broken-colour wash
// so it sits in the pencil/splat world without looking like CAD plastic.
//
// Convention (matches Bird.ts): nose +Z, up +Y, wings along ±X.
// ===========================================================================

// ---------------------------------------------------------------------------
// Bone indices for the unified body skeleton. Shared between geometry weighting
// and the animator so they never drift out of sync.
// ---------------------------------------------------------------------------
export const BONE = {
  TAIL: 0,
  BODY: 1, // the torso anchor (also the skeleton root child the body hangs from)
  NECK0: 2,
  NECK1: 3,
  NECK2: 4,
  NECK3: 5,
  HEAD: 6,
  JAW: 7, // lower mandible
  COUNT: 8,
} as const;

// ---------------------------------------------------------------------------
// Palette — a soft pearl-grey pelican warming to ochre at the bill, cooling to
// slate beneath. Tuned to sit quietly in the misty meadow.
// ---------------------------------------------------------------------------
export const C_BODY_TOP = new THREE.Color('#eef1f3'); // sunlit pearl back
export const C_BODY = new THREE.Color('#dbe0e5'); // body grey
export const C_BODY_LOW = new THREE.Color('#a7b0bb'); // cool slate underside / soft AO
export const C_NECK = new THREE.Color('#e9ecee'); // pale nape
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
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// Cheap value noise → a few octaves of subtle displacement so the smooth sweep
// reads as a soft-feathered animal, never a chrome shell. Tiny amplitudes only.
// ---------------------------------------------------------------------------
function hash3(x: number, y: number, z: number): number {
  let h = x * 374761393 + y * 668265263 + z * 1274126177;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) / 4294967295) * 2 - 1;
}
function vnoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), u), x10 = lerp(c(0, 1, 0), c(1, 1, 0), u);
  const x01 = lerp(c(0, 0, 1), c(1, 0, 1), u), x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}
function fbm(x: number, y: number, z: number): number {
  return 0.66 * vnoise(x, y, z) + 0.34 * vnoise(x * 2.1 + 11, y * 2.1 + 5, z * 2.1 + 3);
}

// Where the wing roots into the back (bob-space). Declared here so the body's
// shoulder fairing and the wing geometry agree on the exact emergence point.
// Pulled INTO the flank (low x, on the upper flank) so the wing root is buried in
// the body rather than perched beside it.
export const WING_ATTACH = new THREE.Vector3(0.045, 0.18, 0.42);

// ---------------------------------------------------------------------------
// SHOULDER FAIRING — swell the body surface laterally where each wing emerges, so
// the wing grows OUT of a fleshy shoulder shelf instead of being a card glued to a
// smooth egg. We push body vertices that lie in the shoulder region outward along
// ±X (and slightly up) by a smooth bump centred on the wing-attach point. Because
// it deforms the SAME welded body skin, the wing root (buried in this swell) shares
// the body's surface and shading — the seam at the root disappears.
// ---------------------------------------------------------------------------
function shoulderFairing(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geo.attributes.position.array as Float32Array;
  const count = geo.attributes.position.count;
  const cz = WING_ATTACH.z, cy = WING_ATTACH.y;
  // A BIG, generous HAUNCH — a fleshy ridge the wing is grown from, NOT a pimple.
  // It must be large enough that the wing's whole buried root (the inner ~40% of
  // span, see buildWingSkin) sits solidly INSIDE this swell at rest AND stays inside
  // it through the entire flap arc (the root rotates about the shoulder pivot which
  // lives at the heart of this haunch). So the swell is: wide (long fore-and-aft so
  // it covers the wing's broad root chord), deep (pushed well outboard so the wing's
  // span tucks under it), and TALL (the section centre is raised so the haunch rises
  // up the flank, giving body flesh both above and below the root through its swing).
  //   • Verified by construction (a standalone overlap test reasoning about the body
  //     envelope vs the wing membrane): at rest the wing only emerges past ~30% span,
  //     and across the realistic flap+bank extremes the inner ≤18% span stays buried
  //     inside this haunch — so the overlap never opens a gap. (See buildWingSkin and
  //     the reduced shoulder-flap share in Bird.update.)
  // The gaussian falloff stays smooth so the haunch melts back into the egg of the
  // body with no rim. The haunch is built TALL rather than wide: it leans on lifting
  // the flank into a fleshy crown the wing sinks DOWN into, with only a modest
  // sideways bulge — so the shoulders don't read as over-broad. Larger sigmas
  // widen/lengthen the ridge.
  const izz = 1 / (2 * 0.58 * 0.58), iyy = 1 / (2 * 0.62 * 0.62);
  for (let i = 0; i < count; i++) {
    const k = i * 3;
    const x = pos[k], y = pos[k + 1], z = pos[k + 2];
    const dz = z - cz, dy = y - cy;
    const env = Math.exp(-(dz * dz) * izz - (dy * dy) * iyy);
    if (env < 1e-3) continue;
    const s = x < 0 ? -1 : 1;
    // push the flank outward to form the shelf — KEPT MODEST so the bird doesn't get
    // too wide; the burial comes mostly from height + the wing sinking in, not girth.
    const outward = 0.17 * env;
    // RAISE the whole swell so the haunch rises up the flank (the section centre
    // lifts, not just the top edge): this is what gives the wing root body flesh
    // both below it and capping over it, so an up-flap can't lift the root clear of
    // the body. More lift on the upper flank builds a tall crown the root tucks under.
    const lift = env * (0.13 + 0.07 * smoothstep(0.0, 0.16, Math.abs(x)));
    // ease the top of the shelf forward a hair so it caps over the wing root (the
    // haunch overhangs the fillet, hiding the join line as the wing flexes).
    const cap = 0.02 * env * smoothstep(0.06, 0.18, Math.abs(x));
    pos[k] = x + s * outward; pos[k + 1] = y + lift; pos[k + 2] = z + cap;
  }
  geo.attributes.position.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Push every vertex along its normal by layered noise for organic softness. */
function roughen(geo: THREE.BufferGeometry, amp: number, freq: number, biasDown = 0): THREE.BufferGeometry {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  // Direct typed-array access (no per-vertex accessor dispatch / bounds checks):
  // these bakes run once at build time but over thousands of vertices, so the
  // tight loop keeps geometry construction snappy on first chunk load.
  const pos = geo.attributes.position.array as Float32Array;
  const nrm = geo.attributes.normal.array as Float32Array;
  const count = geo.attributes.position.count;
  for (let i = 0; i < count; i++) {
    const k = i * 3;
    const x = pos[k], y = pos[k + 1], z = pos[k + 2];
    const ny = nrm[k + 1];
    let d = fbm(x * freq, y * freq, z * freq) * amp;
    if (biasDown > 0 && ny < 0) d += biasDown * amp * -ny;
    pos[k] = x + nrm[k] * d; pos[k + 1] = y + ny * d; pos[k + 2] = z + nrm[k + 2] * d;
  }
  geo.attributes.position.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

// ---- vertex-colour baking -------------------------------------------------
export type PaintFn = (
  c: THREE.Color, x: number, y: number, z: number,
  nx: number, ny: number, nz: number, bb: THREE.Box3,
) => void;

function paint(geo: THREE.BufferGeometry, fn: PaintFn): THREE.BufferGeometry {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const pos = geo.attributes.position.array as Float32Array;
  const nrm = geo.attributes.normal.array as Float32Array;
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const k = i * 3;
    fn(c, pos[k], pos[k + 1], pos[k + 2], nrm[k], nrm[k + 1], nrm[k + 2], bb);
    col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

export const sunlit = (nx: number, ny: number, nz: number, amt = 0.12) =>
  1 + amt * Math.max(0, nx * SUN.x + ny * SUN.y + nz * SUN.z);

// A quiet painterly broken-colour wash so the smooth surface shimmers with
// subtle temperature variation instead of reading as flat plastic.
const C_WARM = new THREE.Color('#f3e6cf');
const C_COOL = new THREE.Color('#8fa0bf');
function brokenColour(geo: THREE.BufferGeometry, strength: number, freq: number): THREE.BufferGeometry {
  const posAttr = geo.attributes.position;
  const colAttr = geo.attributes.color as THREE.BufferAttribute | undefined;
  if (!colAttr) return geo;
  const pos = posAttr.array as Float32Array;
  const col = colAttr.array as Float32Array;
  const count = posAttr.count;
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const k = i * 3;
    const n = fbm(pos[k] * freq, pos[k + 1] * freq + 3.1, pos[k + 2] * freq + 7.7);
    // raw read (no colour-management transform — these are already working-space)
    c.r = col[k]; c.g = col[k + 1]; c.b = col[k + 2];
    if (n > 0) c.lerp(C_WARM, n * strength);
    else c.lerp(C_COOL, -n * strength);
    col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
  }
  colAttr.needsUpdate = true;
  return geo;
}

// ===========================================================================
// THE MASTER SPINE — ONE continuous centre-line for the entire body.
//
// It runs: tail tip (−Z, low) → rump → belly → breast → shoulders → UP the
// S-curve of the neck → head → forward & down along the bill to the tip. The
// whole creature is swept along THIS, so by construction it is one flowing form.
//
// Each station carries its cross-section profile AND the bone it primarily
// belongs to, so we can weight the swept vertices smoothly between bones.
// ===========================================================================
interface Station {
  p: THREE.Vector3; // centre point of the ring
  rx: number; // half-width (lateral)
  ry: number; // half-height (vertical, in the spine frame)
  yOff: number; // teardrop bias: pushes the lower half down (heavier belly)
  bone: number; // primary bone for vertices on this ring
  blend: number; // 0..1 how much this ring blends toward the NEXT station's bone
  flatten: number; // 0..1 squash the section toward a flat horizontal lens (bill)
}

const S = (
  p: THREE.Vector3, rx: number, ry: number, yOff: number,
  bone: number, blend = 0, flatten = 0,
): Station => ({ p, rx, ry, yOff, bone, blend, flatten });

// The body spine. Tuned so the neck folds back in the soaring pelican "S" and the
// bill droops off the head — all as ONE curve. Radii ease continuously.
function bodySpine(): Station[] {
  return [
    // ---- tail (grows straight out of the rump, low and trailing) ----
    // The rump is kept fleshy and broad right up to where the tail fan roots, so
    // the fan springs from a solid base of body rather than off a thin spike — no
    // gap opens between rump and rectrices. The TAIL ring radii stay generous and
    // ease (not collapse) toward the fan root.
    S(new THREE.Vector3(0, 0.052, -1.18), 0.052, 0.03, 0.05, BONE.TAIL),
    S(new THREE.Vector3(0, 0.052, -1.06), 0.074, 0.058, 0.12, BONE.TAIL, 0.5),
    S(new THREE.Vector3(0, 0.05, -0.95), 0.09, 0.082, 0.2, BONE.TAIL, 1.0), // rump shoulder (fan springs here)
    // ---- body teardrop (narrowed laterally — rx only; ry kept so the side
    // profile stays full and the bird reads sleek, not deflated) ----
    S(new THREE.Vector3(0, 0.04, -0.82), 0.115, 0.13, 0.28, BONE.BODY, 0.0),
    S(new THREE.Vector3(0, -0.01, -0.5), 0.162, 0.215, 0.4, BONE.BODY),
    S(new THREE.Vector3(0, -0.02, -0.12), 0.192, 0.262, 0.48, BONE.BODY), // heaviest belly
    S(new THREE.Vector3(0, 0.0, 0.22), 0.176, 0.238, 0.42, BONE.BODY), // breast
    S(new THREE.Vector3(0, 0.07, 0.52), 0.122, 0.17, 0.26, BONE.BODY, 0.4),
    S(new THREE.Vector3(0, 0.16, 0.72), 0.08, 0.102, 0.12, BONE.BODY, 1.0), // shoulder / neck root
    // ---- S-neck (folds up & back, then forward) ----
    S(new THREE.Vector3(0, 0.3, 0.74), 0.078, 0.086, 0.06, BONE.NECK0, 0.6),
    S(new THREE.Vector3(0, 0.44, 0.69), 0.068, 0.076, 0.0, BONE.NECK1, 0.5),
    S(new THREE.Vector3(0, 0.56, 0.62), 0.062, 0.07, 0.0, BONE.NECK1, 1.0),
    S(new THREE.Vector3(0, 0.64, 0.62), 0.06, 0.068, 0.0, BONE.NECK2, 0.6),
    S(new THREE.Vector3(0, 0.69, 0.69), 0.058, 0.066, 0.0, BONE.NECK3, 0.6),
    S(new THREE.Vector3(0, 0.71, 0.8), 0.058, 0.064, 0.0, BONE.NECK3, 1.0), // nape into head
    // ---- head ----
    S(new THREE.Vector3(0, 0.71, 0.9), 0.082, 0.09, 0.0, BONE.HEAD, 0.3),
    S(new THREE.Vector3(0, 0.7, 0.99), 0.095, 0.1, 0.0, BONE.HEAD), // crown
    S(new THREE.Vector3(0, 0.675, 1.07), 0.082, 0.085, 0.0, BONE.HEAD),
    S(new THREE.Vector3(0, 0.645, 1.13), 0.055, 0.05, 0.0, BONE.HEAD, 0.0), // lores → bill base
    // ---- bill (droops, flattens to a broad lens, tip hooks down) ----
    S(new THREE.Vector3(0, 0.628, 1.2), 0.05, 0.034, 0.0, BONE.HEAD, 0.4, 0.45),
    S(new THREE.Vector3(0, 0.6, 1.34), 0.044, 0.024, 0.0, BONE.HEAD, 1.0, 0.7),
    S(new THREE.Vector3(0, 0.566, 1.48), 0.034, 0.018, 0.0, BONE.HEAD, 1.0, 0.8),
    S(new THREE.Vector3(0, 0.527, 1.6), 0.02, 0.014, 0.0, BONE.HEAD, 1.0, 0.85),
    S(new THREE.Vector3(0, 0.5, 1.66), 0.008, 0.012, 0.0, BONE.HEAD, 1.0, 0.6), // hooked nail
  ];
}

// ===========================================================================
// SWEEP the master spine into ONE skin, computing skin weights per ring.
//
// Returns geometry with position/normal/color AND skinIndex/skinWeight, ready
// to be a SkinnedMesh. Parallel-transport frames keep the tube from twisting
// through the vertical S-bend — the secret to a continuous surface.
// ===========================================================================
const SEG = 28; // radial segments around the body (clean, smooth ring)

interface SweptSkin {
  geo: THREE.BufferGeometry;
  // local-space anchor of each bone (its rest head position) so Bird can place bones
  boneRest: THREE.Vector3[];
}

function sweepBodySkin(stations: Station[]): SweptSkin {
  const n = stations.length;
  const pts = stations.map((s) => s.p);
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);

  // Sample one ring per station (use the station points directly so profiles &
  // bone tags line up exactly with the geometry). Tangents from the curve.
  const tan: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    tan.push(curve.getTangentAt(clamp01(t)).normalize());
  }
  // parallel-transport frames
  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  let nrm = new THREE.Vector3(0, 1, 0);
  if (Math.abs(tan[0].dot(nrm)) > 0.92) nrm.set(1, 0, 0);
  nrm.sub(tan[0].clone().multiplyScalar(tan[0].dot(nrm))).normalize();
  const q = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      axis.crossVectors(tan[i - 1], tan[i]);
      const len = axis.length();
      if (len > 1e-6) {
        axis.divideScalar(len);
        const dot = clamp01((tan[i - 1].dot(tan[i]) + 1) / 2) * 2 - 1;
        const ang = Math.acos(dot);
        q.setFromAxisAngle(axis, ang);
        nrm.applyQuaternion(q);
      }
      nrm.sub(tan[i].clone().multiplyScalar(tan[i].dot(nrm))).normalize();
    }
    const bin = new THREE.Vector3().crossVectors(tan[i], nrm).normalize();
    normals.push(nrm.clone());
    binormals.push(bin);
  }

  const verts: number[] = [];
  const skinIdx: number[] = [];
  const skinWgt: number[] = [];

  for (let i = 0; i < n; i++) {
    const st = stations[i];
    const c = pts[i], nA = normals[i], bA = binormals[i];
    // bone weighting: this ring belongs to `bone`, blending toward the next
    // station's bone by `blend` so the skin straddles each joint smoothly.
    const boneA = st.bone;
    const boneB = i < n - 1 ? stations[i + 1].bone : st.bone;
    const wB = boneA === boneB ? 0 : st.blend;
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      let ex = Math.cos(a), ey = Math.sin(a);
      const yb = ey < 0 ? ey * (1 + st.yOff) : ey;
      // flatten toward a broad horizontal lens for the bill (wide & shallow)
      const fx = ex * lerp(1, 1.35, st.flatten);
      const fy = yb * lerp(1, 0.5, st.flatten);
      const ux = fx * st.rx, uy = fy * st.ry;
      verts.push(
        c.x + bA.x * ux + nA.x * uy,
        c.y + bA.y * ux + nA.y * uy,
        c.z + bA.z * ux + nA.z * uy,
      );
      skinIdx.push(boneA, boneB, 0, 0);
      skinWgt.push(1 - wB, wB, 0, 0);
    }
  }

  // index the tube + cap the two true ends (tail tip & bill tip) only
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * SEG, b = (i + 1) * SEG;
    for (let s = 0; s < SEG; s++) {
      const j = (s + 1) % SEG;
      idx.push(a + s, a + j, b + j);
      idx.push(a + s, b + j, b + s);
    }
  }
  // cap start (tail tip)
  {
    const ci = verts.length / 3;
    verts.push(pts[0].x, pts[0].y, pts[0].z);
    skinIdx.push(stations[0].bone, 0, 0, 0); skinWgt.push(1, 0, 0, 0);
    for (let s = 0; s < SEG; s++) idx.push(ci, ((s + 1) % SEG), s);
  }
  // cap end (bill tip)
  {
    const base = (n - 1) * SEG;
    const ci = verts.length / 3;
    const e = pts[n - 1];
    verts.push(e.x, e.y, e.z);
    skinIdx.push(stations[n - 1].bone, 0, 0, 0); skinWgt.push(1, 0, 0, 0);
    for (let s = 0; s < SEG; s++) idx.push(ci, base + s, base + ((s + 1) % SEG));
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(skinIdx), 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(skinWgt), 4));
  g.setIndex(idx);
  g.computeVertexNormals();

  // Bone rest anchors = each bone's PIVOT point. These only set where a bone
  // rotates/scales from (the rest inverse cancels the offset for the undeformed
  // skin), so we choose anatomically sensible pivots rather than the first tagged
  // ring: torso pivots at the belly centre, tail at the rump (so it swings like a
  // rudder from the body, not from its own tip), neck/head/jaw at their joints.
  const boneRest: THREE.Vector3[] = new Array(BONE.COUNT);
  // The tail bone pivots at the actual rump joint — where body flesh meets the
  // fan root — so the whole rump+fan swings from the body and never detaches.
  boneRest[BONE.TAIL] = new THREE.Vector3(0, 0.045, -0.86); // rump joint (at the fan root)
  boneRest[BONE.BODY] = new THREE.Vector3(0, -0.02, -0.12); // belly centre
  boneRest[BONE.NECK0] = new THREE.Vector3(0, 0.18, 0.73); // shoulder/neck root
  boneRest[BONE.NECK1] = new THREE.Vector3(0, 0.42, 0.7);
  boneRest[BONE.NECK2] = new THREE.Vector3(0, 0.6, 0.62);
  boneRest[BONE.NECK3] = new THREE.Vector3(0, 0.69, 0.69);
  boneRest[BONE.HEAD] = new THREE.Vector3(0, 0.71, 0.86); // nape/head joint
  // The mandible hinges at the JAW joint UNDER the head — not out at the bill base.
  // Seating the pivot back at the jaw ROOT (z≈0.96, up at the skull underside where
  // the trough's buried rings live) means those root rings barely move while the jaw
  // gapes about the hinge — they stay welded into the head underside, so the jaw can
  // never swing free of the face and the back/root stays closed through any motion.
  boneRest[BONE.JAW] = new THREE.Vector3(0, 0.62, 0.96); // jaw hinge (jaw root, under the skull)
  for (let b = 0; b < BONE.COUNT; b++) if (!boneRest[b]) boneRest[b] = new THREE.Vector3();

  return { geo: g, boneRest };
}

// ===========================================================================
// THE LOWER MANDIBLE + GULAR POUCH — a small separate skin weighted entirely to
// the JAW bone, faired up under the upper bill so it reads as part of the head.
// (Kept as a sub-skin of the SAME body mesh via merge, sharing the skeleton, so
// it is still one draw call and one material — it just answers to the jaw bone.)
// ===========================================================================
function buildLowerJawSkin(): { geo: THREE.BufferGeometry } {
  // THE LOWER MANDIBLE + GULAR POUCH, anchored so it can NEVER detach AND so its TOP
  // EDGE meets (slightly overlaps) the upper bill's underside along the WHOLE length —
  // a closed beak, not a jaw floating below the bill. It is a down-curved trough whose
  // ROOT begins BACK under the skull (at the jaw hinge, z≈0.94) — not out at the bill
  // base — with the first rings fat and lifted so they sink UP INTO the head's
  // underside and overlap the upper-bill base. From the hinge it runs forward; rather
  // than drooping its TOP away from the bill, the top edge TRACKS the upper bill's
  // underside (which itself curves down toward the tip) so the two mandibles stay
  // parallel and shut. The gular sac is carried as a bulge of the UNDERSIDE only
  // (`sag` swells the lower half down), so the pouch volume reads while the top stays
  // welded against the bill. Every vertex is weighted to the JAW bone, which hinges at
  // z≈1.0 under the skull, so the whole trough gapes/closes about that hinge without
  // ever floating free of the head.
  //
  // CLOSURE MATH (verified by construction against the bill stations):
  //   We model the upper bill's UNDERSIDE as a function of z (sampled below), then for
  //   each ring set the top vertex to ride `OVERLAP` ABOVE that underside (a touch
  //   higher still over the buried root so the root sinks into the face). The ring
  //   centre is then `topTarget − ry`, so cY+ry == the bill underside + OVERLAP at
  //   every z → the lower beak's top edge always overlaps the upper bill, no gap opens
  //   along the length, and the root buries up into the skull underside.
  // Upper-bill underside the top edge must meet (incl. the head/skull root region):
  //   head/skull underside ≈ y 0.60 (z 0.94..1.10)
  //   bill base underside  ≈ y 0.595 (z 1.13)  rising slightly to ≈0.60 (z 1.20)
  //   then dropping        ≈ y 0.584 (1.34) → 0.555 (1.48) → 0.519 (1.60) → 0.492 (1.66 nail)
  const billUnder: { z: number; y: number }[] = [
    { z: 0.94, y: 0.605 }, { z: 1.06, y: 0.600 }, { z: 1.13, y: 0.595 },
    { z: 1.20, y: 0.602 }, { z: 1.34, y: 0.584 }, { z: 1.48, y: 0.555 },
    { z: 1.60, y: 0.519 }, { z: 1.66, y: 0.492 },
  ];
  const upperUnderAt = (z: number): number => {
    if (z <= billUnder[0].z) return billUnder[0].y;
    const last = billUnder[billUnder.length - 1];
    if (z >= last.z) return last.y;
    for (let i = 0; i < billUnder.length - 1; i++) {
      const a = billUnder[i], b = billUnder[i + 1];
      if (z >= a.z && z <= b.z) return lerp(a.y, b.y, (z - a.z) / (b.z - a.z));
    }
    return last.y;
  };
  const OVERLAP = 0.016;     // top edge sits this far ABOVE the bill underside → shut

  const hingeZ = 0.94;       // root starts further back under the skull
  const N = 16;
  const len = 0.74;          // reaches forward to the bill tip (0.94 + 0.74 = 1.68)
  const pts: THREE.Vector3[] = [];
  const profs: { rx: number; ry: number; sag: number; buried: number }[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const z = hingeZ + t * len;
    // BURIAL: the first ~20% of the trough is sunk up inside the head underside so its
    // surface coincides with the face (no seam). `buried` ramps 1 → 0 by ~20%.
    const buried = smoothstep(0.2, 0.0, t);
    // pouch bulge envelope — fullest about a third along (the swollen gular sac)
    const env = Math.sin(Math.PI * clamp01(t * 0.95));
    // ring half-heights: fat & buried at root, swelling with the gular sac, slim tip.
    const ry = 0.016 + 0.045 * env + 0.055 * buried;
    // TARGET TOP EDGE: ride the bill underside + overlap; the root rides a touch
    // higher so it sinks up into the head underside. The centre is then targetTop−ry,
    // so cY+ry == the bill underside everywhere → the beak is closed along its length.
    const targetTop = upperUnderAt(z) + OVERLAP + 0.02 * buried;
    const y = targetTop - ry;
    pts.push(new THREE.Vector3(0, y, z));
    profs.push({
      // root is FAT (fills the head underside so it welds in); the body of the
      // trough swells with the gular sac; the tip narrows to meet the bill.
      rx: 0.026 + 0.055 * env + 0.05 * buried,
      ry,
      // the gular sac hangs the UNDERSIDE down (lower half only) — the swollen pouch —
      // without ever lowering the top edge away from the bill.
      sag: 0.7 * env,
      buried,
    });
  }
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
  const tan: THREE.Vector3[] = [];
  for (let i = 0; i < N; i++) tan.push(curve.getTangentAt(clamp01(i / (N - 1))).normalize());
  // simple frames (this short arc barely twists)
  const verts: number[] = [];
  const skinIdx: number[] = [];
  const skinWgt: number[] = [];
  const seg = 18;
  for (let i = 0; i < N; i++) {
    const c = pts[i];
    const tg = tan[i];
    const nA = new THREE.Vector3(0, 1, 0).sub(tg.clone().multiplyScalar(tg.dot(new THREE.Vector3(0, 1, 0)))).normalize();
    const bA = new THREE.Vector3().crossVectors(tg, nA).normalize();
    const p = profs[i];
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const ex = Math.cos(a), ey = Math.sin(a);
      const yb = ey < 0 ? ey * (1 + p.sag) : ey; // sag the underside
      const ux = ex * p.rx, uy = yb * p.ry;
      verts.push(
        c.x + bA.x * ux + nA.x * uy,
        c.y + bA.y * ux + nA.y * uy,
        c.z + bA.z * ux + nA.z * uy,
      );
      skinIdx.push(BONE.JAW, 0, 0, 0);
      skinWgt.push(1, 0, 0, 0);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < N - 1; i++) {
    const a = i * seg, b = (i + 1) * seg;
    for (let s = 0; s < seg; s++) {
      const j = (s + 1) % seg;
      idx.push(a + s, a + j, b + j);
      idx.push(a + s, b + j, b + s);
    }
  }
  // cap both ends
  for (const [end, atStart] of [[0, true], [N - 1, false]] as [number, boolean][]) {
    const ci = verts.length / 3;
    verts.push(pts[end].x, pts[end].y, pts[end].z);
    skinIdx.push(BONE.JAW, 0, 0, 0); skinWgt.push(1, 0, 0, 0);
    const baseRing = end * seg;
    for (let s = 0; s < seg; s++) {
      if (atStart) idx.push(ci, ((s + 1) % seg), s);
      else idx.push(ci, baseRing + s, baseRing + ((s + 1) % seg));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(skinIdx), 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(skinWgt), 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geo: g };
}

// ===========================================================================
// THE TAIL FAN — a soft cambered membrane that grows out of the rump, weighted to
// the TAIL bone so it steers and follows through with the rump. Faired into the
// body run (its leading edge tucks inside the rump rings) so no hard seam shows.
// ===========================================================================
// The tail reads as a FAN OF RECTRICES: a wide, thin membrane whose trailing edge
// is cut into ~7 distinct feather lobes by a strong cosine ripple, each feather
// dropping a little so the fan overlaps like real tail feathers. Central feathers
// are longest. The leading edge sinks inside the rump rings so there's no seam.
const TAIL_FEATHERS = 7;
function buildTailFanSkin(): THREE.BufferGeometry {
  // Add an extra chord row at the very root (v<0) that is BURIED INSIDE the rump
  // rings: it is wide, fat-thick and forward of the body's rump surface, so the
  // fan's leading edge merges into the body skin with no visible gap or seam. The
  // fan then fans out from there into the overlapping rectrices.
  const NSPAN = TAIL_FEATHERS * 4 + 1, NCHORD = 7;
  const halfSpan = 0.26, len = 0.62;
  const top: number[] = [], bot: number[] = [];
  // Root well INSIDE the rump (the rump rings reach back to z≈-1.06); the fan's
  // first row sits at z≈-0.86, deep in the body, so it grows out of the flesh.
  const rootZ = -0.86;
  for (let i = 0; i < NSPAN; i++) {
    const u = (i / (NSPAN - 1)) * 2 - 1; // -1..1 across the span
    const x = u * halfSpan;
    // feather lobes: each rectrix reaches its own length; deep notches between them
    const lobe = Math.cos(u * Math.PI * TAIL_FEATHERS); // ripple across the fan
    const notch = 0.16 * (0.5 - 0.5 * lobe); // pull the trailing edge back at notches
    const reach = len * (1 - 0.34 * u * u) - len * notch;
    const lift = 0.025 + 0.04 * Math.abs(u); // outer feathers lift (dihedral)
    // alternate feathers ride slightly above/below for an overlapped read
    const stagger = 0.012 * Math.sin(u * Math.PI * TAIL_FEATHERS);
    // the root half-span narrows so the buried leading edge fits inside the rump
    const rootPinch = 0.62; // chord-0 row sits within the rump silhouette laterally
    for (let j = 0; j < NCHORD; j++) {
      const v = j / (NCHORD - 1);
      const buried = smoothstep(0.2, 0.0, v); // 1 at root row → 0 by 20% chord
      // root row tucked FORWARD into the rump (buried*0.16 ahead of rootZ) so its
      // leading edge sinks inside the body rings; the fan then reaches aft from there.
      const z = rootZ - reach * v + buried * 0.16;
      const xx = x * lerp(1, rootPinch, buried); // narrow the buried root laterally
      // fatten the buried root in thickness so it fills the body silhouette (meets
      // the rump skin) and tapers to thin feather membrane out at the fan tips.
      const th = (0.016 * (1 - v) + 0.0022) * (1 - 0.35 * Math.abs(u)) + buried * 0.055;
      const y = 0.05 + lift * v * v + stagger * v;
      top.push(xx, y + th, z);
      bot.push(xx, y - th, z);
    }
  }
  const g = membraneFromGrids(top, bot, NSPAN, NCHORD);
  applyConstantSkin(g, BONE.TAIL);
  return g;
}

// ===========================================================================
// MEMBRANE — a continuous double-sided cambered surface from a top + bottom grid.
// Watertight, smooth-normalled, one flowing skin. Basis for tail-fan and wings.
// ===========================================================================
function membraneFromGrids(
  top: number[], bot: number[], NSPAN: number, NCHORD: number, flip = false,
): THREE.BufferGeometry {
  const nTop = top.length / 3;
  const verts = top.concat(bot);
  const idx: number[] = [];
  const at = (i: number, j: number) => i * NCHORD + j;
  const ab = (i: number, j: number) => nTop + i * NCHORD + j;
  const tri = (a: number, b: number, c: number) => {
    if (flip) idx.push(a, c, b); else idx.push(a, b, c);
  };
  for (let i = 0; i < NSPAN - 1; i++) {
    for (let j = 0; j < NCHORD - 1; j++) {
      tri(at(i, j), at(i, j + 1), at(i + 1, j + 1));
      tri(at(i, j), at(i + 1, j + 1), at(i + 1, j));
    }
  }
  for (let i = 0; i < NSPAN - 1; i++) {
    for (let j = 0; j < NCHORD - 1; j++) {
      tri(ab(i, j), ab(i + 1, j + 1), ab(i, j + 1));
      tri(ab(i, j), ab(i + 1, j), ab(i + 1, j + 1));
    }
  }
  for (let i = 0; i < NSPAN - 1; i++) {
    tri(at(i, 0), ab(i, 0), ab(i + 1, 0));
    tri(at(i, 0), ab(i + 1, 0), at(i + 1, 0));
    const j = NCHORD - 1;
    tri(at(i, j), at(i + 1, j), ab(i + 1, j));
    tri(at(i, j), ab(i + 1, j), ab(i, j));
  }
  for (let j = 0; j < NCHORD - 1; j++) {
    tri(at(0, j), at(0, j + 1), ab(0, j + 1));
    tri(at(0, j), ab(0, j + 1), ab(0, j));
    const i = NSPAN - 1;
    tri(at(i, j), ab(i, j + 1), at(i, j + 1));
    tri(at(i, j), ab(i, j), ab(i, j + 1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Weight every vertex of a geometry entirely to a single bone. */
function applyConstantSkin(g: THREE.BufferGeometry, bone: number) {
  const n = g.attributes.position.count;
  const idx = new Uint16Array(n * 4);
  const wgt = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { idx[i * 4] = bone; wgt[i * 4] = 1; }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(wgt, 4));
}

// ===========================================================================
// THE UNIFIED BODY SKIN — body + neck + head + bill + lower jaw + tail fan,
// merged into ONE geometry sharing ONE skeleton. Painted as one continuous
// surface so colour and shading flow unbroken across every former "joint".
// ===========================================================================
export interface BodyBuild {
  geo: THREE.BufferGeometry;
  boneRest: THREE.Vector3[]; // rest world(local-root)-space head of each bone
}

export function buildBodySkin(): BodyBuild {
  const stations = bodySpine();
  const { geo: bodyGeo, boneRest } = sweepBodySkin(stations);
  // swell the shoulders so each wing grows out of a fleshy shelf of body, then add
  // the fine organic noise. Order matters: fair first, then roughen over the result.
  shoulderFairing(bodyGeo);
  roughen(bodyGeo, 0.01, 9, 0.4);

  const jaw = buildLowerJawSkin().geo;
  const tailFan = buildTailFanSkin();

  // merge the three skinned parts into ONE geometry (one draw call, one material).
  // mergeGeometries keeps the matching attributes (position/normal/skinIndex/
  // skinWeight); we recompute colour over the whole merged surface so the wash is
  // continuous.
  const merged = mergeGeometries([bodyGeo, jaw, tailFan], false)!;
  bodyGeo.dispose(); jaw.dispose(); tailFan.dispose();
  merged.computeVertexNormals();

  // ---- paint the whole unified skin in one pass ----
  paint(merged, (c, x, y, z, nx, ny, nz, bb) => {
    const top = (y - bb.min.y) / Math.max(1e-3, bb.max.y - bb.min.y);
    // base body gradient: slate underside → grey → pearl back
    c.copy(C_BODY_LOW).lerp(C_BODY, smoothstep(0.2, 0.55, top))
      .lerp(C_BODY_TOP, smoothstep(0.58, 1.0, top) * 0.85);
    // pale nape over the neck/head region (keyed to absolute z so it's robust to
    // the bounding box stretching with the tail fan)
    c.lerp(C_NECK, smoothstep(0.62, 0.78, top) * smoothstep(0.3, 0.6, z) * 0.5);
    // dusky crown smudge on the very top of the head (z ≈ 0.86 → 1.05)
    const crown = smoothstep(0.86, 1.0, top) * smoothstep(0.82, 0.92, z) * smoothstep(1.12, 1.0, z);
    c.lerp(C_CROWN, crown * 0.7);
    // ---- bill: warm ochre, forward of the head (z ≳ 1.13) ----
    const billT = smoothstep(1.1, 1.18, z);
    if (billT > 0) {
      const along = smoothstep(1.13, 1.66, z); // 0 base → 1 tip
      const bill = C_BILL.clone().lerp(C_BILL_TIP, along * 0.9);
      if (top > 0.55) bill.lerp(C_BILL_RIDGE, (top - 0.55) / 0.45 * 0.4); // culmen ridge
      if (along > 0.85) bill.lerp(C_BILL_TIP.clone().multiplyScalar(0.7), (along - 0.85) / 0.15 * 0.8); // nail
      c.lerp(bill, billT);
    }
    // ---- tail feathers: the rear fan (z behind the rump) reads as overlapping
    // rectrices — alternating light/shadow bands across the span + a pale feather
    // lip toward the trailing tips, so it looks like plumage, not a flat flap. ----
    const tailReg = smoothstep(-0.95, -1.05, z); // 0 rump → 1 well into the fan
    if (tailReg > 0) {
      const band = 0.5 + 0.5 * Math.cos(x * Math.PI * TAIL_FEATHERS * 2); // per-feather ripple
      const along = smoothstep(-1.0, -1.55, z); // 0 root → 1 trailing tip
      const tcol = C_COVERT.clone().lerp(C_PRIMARY, smoothstep(0.35, 1.0, along) * 0.75);
      tcol.lerp(C_FEATHER_SHADE, (1 - band) * (0.18 + 0.2 * along)); // shadowed feather gaps
      tcol.lerp(C_FEATHER_EDGE, smoothstep(0.82, 1.0, along) * band * 0.5); // sunlit feather lips
      c.lerp(tcol, tailReg);
    }
    // soft AO gathering under the belly
    c.multiplyScalar(0.9 + 0.1 * smoothstep(0.12, 0.5, top));
    c.multiplyScalar(sunlit(nx, ny, nz, 0.13));
  });
  brokenColour(merged, 0.045, 7);

  return { geo: merged, boneRest };
}

// ===========================================================================
// WING — ONE continuous cambered airfoil membrane per side, ROOT BURIED IN THE
// BODY so there's no hard shoulder seam. The membrane is weighted across four
// bones along the span (shoulder→elbow→wrist→hand), so flapping bends one
// continuous skin instead of swinging four cards. Built once per side as a
// SkinnedMesh geometry; the per-wing skeleton lives in Bird.
//
// Bone layout for the wing skeleton (separate from the body skeleton):
//   0 = shoulder, 1 = elbow, 2 = wrist, 3 = hand/primaries
// ===========================================================================
export const WBONE = { SHOULDER: 0, ELBOW: 1, WRIST: 2, HAND: 3, COUNT: 4 } as const;

// Spanwise X of each wing bone joint (local wing space, side·X applied by caller).
export const WING_JOINTS = [0.0, 0.5, 0.94, 1.28]; // shoulder, elbow, wrist, hand-root
export const WING_TIP = 1.78; // primaries reach to here

// (WING_ATTACH is declared near the shoulder-fairing helper above, so the body
// swell and the wing geometry agree on the exact emergence point.)

// number of distinct primary "fingers" cut into the wingtip's trailing edge.
const WING_PRIMARIES = 6;
export function buildWingSkin(side: number): THREE.BufferGeometry {
  // dense span so the feather notches in the trailing edge read crisply
  const NSPAN = 56, NCHORD = 9;
  const top: number[] = [], bot: number[] = [];
  const skinIdx: number[] = [], skinWgt: number[] = [];

  // map a spanwise position x (0..WING_TIP) to (boneA,boneB,wB) blending weight
  const weightAt = (xspan: number): [number, number, number] => {
    // find the joint span we're in
    if (xspan <= WING_JOINTS[1]) {
      const t = smoothstep(WING_JOINTS[0], WING_JOINTS[1], xspan);
      return [WBONE.SHOULDER, WBONE.ELBOW, t * 0.5]; // shoulder-dominant inner arm
    }
    if (xspan <= WING_JOINTS[2]) {
      const t = smoothstep(WING_JOINTS[1], WING_JOINTS[2], xspan);
      return [WBONE.ELBOW, WBONE.WRIST, t];
    }
    if (xspan <= WING_JOINTS[3]) {
      const t = smoothstep(WING_JOINTS[2], WING_JOINTS[3], xspan);
      return [WBONE.WRIST, WBONE.HAND, t];
    }
    return [WBONE.HAND, WBONE.HAND, 0];
  };

  for (let i = 0; i < NSPAN; i++) {
    const t = i / (NSPAN - 1); // 0 root → 1 tip
    const xspan = t * WING_TIP;
    const x = side * xspan;
    // chord (fore-aft depth): broad at the arm, tapering to slim primaries. The
    // root chord is broadened (rootFair) so the membrane fairs into the body as a
    // wide fillet rather than a narrow blade.
    // ROOT FAIRING now spans the inner ~46% of span: a long, gradual fillet so the
    // wing melts into the haunch over a generous run. `rootFair0` ramps 1 → 0 across
    // that span. The inner ~30% is genuinely BURIED inside the body's shoulder
    // haunch (verified by an overlap test against the body envelope), and it only
    // emerges as a clear membrane past there — so a thin flat root edge never butts
    // the flank; the surfaces overlap solidly.
    const rootFair0 = smoothstep(0.46, 0.0, t);
    const chord = lerp(0.6, 0.12, smoothstep(0.0, 1.0, t)) * (1 - 0.18 * smoothstep(0.7, 1.0, t))
      * (1 + 0.42 * rootFair0); // broaden the root chord → a wide fillet of overlap
    const thick = lerp(0.05, 0.006, t);
    // leading edge sweeps back & bows forward (a smooth curve)
    const le = lerp(0.2, -0.18, t) + 0.05 * Math.sin(t * Math.PI);
    // whole-wing droop + gull bow at the tip
    const droopBase = -0.05 * t * t;
    // ROOT FAIRING: blend the inner membrane INTO the shoulder haunch of the body.
    // Over the inner span the root is pulled HARD toward the body centre-line (so its
    // span collapses onto the shoulder pivot — the deepest, fattest root sits AT the
    // pivot and barely translates as the wing beats, carrying the visible swing
    // outboard), its chord broadened (above), it is fattened in thickness, and its
    // surface sunk down into the flank — so it disappears into the haunch as a
    // continuous fillet instead of meeting the body at a hard card edge.
    const rootFair = rootFair0;
    const rootFair2 = rootFair * rootFair; // sharper falloff for the deepest burial
    const [bA, bB, wB] = weightAt(xspan);
    // TRAILING EDGE as feathers:
    //  - inner wing (secondaries): a fine shallow scallop, one notch per feather
    //  - outer wing (primaries): deep notches cut WING_PRIMARIES long fingers, the
    //    emarginated soaring tip — each finger reaches back, with a gap between.
    const secScallop = 0.04 * (0.5 - 0.5 * Math.cos(t * Math.PI * 16)); // fine inner ripple
    const primPhase = smoothstep(0.45, 1.0, t) * WING_PRIMARIES; // count up the fingers
    const primRipple = 0.5 - 0.5 * Math.cos(primPhase * Math.PI * 2); // 0 gap … 1 finger
    const primDepth = smoothstep(0.5, 1.0, t);
    for (let j = 0; j < NCHORD; j++) {
      const v = j / (NCHORD - 1); // 0 leading → 1 trailing
      let trail = chord * (1 - secScallop);
      // primaries: deep notch (pull edge in at gaps) + long reach at finger crests
      trail = trail * (1 - 0.5 * primDepth * (1 - primRipple))
        + chord * 0.7 * smoothstep(0.5, 1.0, t) * primRipple;
      const z = le - trail * v;
      const camberShape = Math.sin(Math.PI * v);
      const thFactor = (1 - v) * 0.7 + 0.3;
      // FLESHY INNER ARM — the single biggest "stop reading as a sheet" lever. The
      // inner ~half of the span is built as a ROUNDED 3D LIMB, not a thin membrane,
      // so it reads as an arm growing out of the shoulder. (A thin sheet sits at a
      // grazing angle to the eye across its WHOLE area, so the NPR fresnel contour
      // inks its entire perimeter → a cut-out card; a fat rounded limb only inks its
      // true silhouette, exactly like the body does.) Rounded across the chord
      // (fattest at mid-chord via camberShape) and faded out by ~half-span, where the
      // wing thins to the genuine flight-feather blade past the wrist.
      const armBulk = (0.04 + 0.055 * camberShape) * smoothstep(0.5, 0.0, t);
      // THICKEN the buried root: a fat wad of flesh (not a thin wafer) so even where
      // the root surface sits near the body surface there is solid overlap and no
      // thin membrane edge can show against the flank. Tapers out to the thin flight
      // feathers by the time the wing emerges.
      const th = thick * thFactor * (0.4 + 0.6 * camberShape) + rootFair2 * 0.05 + armBulk;
      const camber = 0.55 * thick * camberShape * (1 - 0.3 * t);
      let y = camber + droopBase - 0.02 * v * t;
      // fair the root DOWN into the flank so the membrane sinks deep into the haunch
      // (it disappears into the swell rather than meeting it at a hard line). The
      // burial leans on this downward sink — the wing dives into a tall haunch —
      // rather than on bulging the body wide. A single smooth ramp, no rim.
      y += -rootFair * 0.17;
      // curl the root edges down (chord-wise) so the fillet wraps the flank instead
      // of poking out as a flat shelf — the leading and trailing root corners tuck
      // under the haunch.
      y += -rootFair2 * 0.04 * (v - 0.5) * 2;
      // keep the buried chord roughly centred in the haunch (only a small forward
      // nudge) so the long root chord stays inside the fore-aft span of the swell.
      const zr = z + rootFair * 0.04;
      // pull the root spanwise X HARD toward the body centre-line so its span
      // collapses onto the shoulder pivot — the buried fillet tucks deep under the
      // haunch and barely moves through the flap (rotation radius ≈ 0 near the
      // pivot), which is what keeps the overlap closed as the wing beats. Linear in
      // rootFair so the collapse reaches all the way to the pivot at the root row.
      const xFair = 1 - 0.86 * rootFair;
      const xx = WING_ATTACH.x * side + x * xFair;
      // bake the body attachment so bone pivots == geometry joints in span-X
      top.push(xx, WING_ATTACH.y + y + th, WING_ATTACH.z + zr);
      bot.push(xx, WING_ATTACH.y + y - th * 0.7, WING_ATTACH.z + zr);
      // skin weights (same for top & bottom vertex of this station/chord)
      skinIdx.push(bA, bB, 0, 0); skinWgt.push(1 - wB, wB, 0, 0);
    }
  }
  // bottom grid skin weights mirror the top (appended in membraneFromGrids order)
  const topCount = skinIdx.length / 4;
  for (let k = 0; k < topCount; k++) {
    skinIdx.push(skinIdx[k * 4], skinIdx[k * 4 + 1], 0, 0);
    skinWgt.push(skinWgt[k * 4], skinWgt[k * 4 + 1], 0, 0);
  }

  const g = membraneFromGrids(top, bot, NSPAN, NCHORD, side < 0);
  g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(skinIdx), 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(skinWgt), 4));
  g.computeVertexNormals();

  // paint the wing — built to read as FEATHERED plumage, not a smooth flap.
  paint(g, (c, x, y, z, nx, ny, nz, bb) => {
    const tspan = clamp01((Math.abs(x) - Math.abs(WING_ATTACH.x)) / WING_TIP);
    const top01 = (y - bb.min.y) / Math.max(1e-3, bb.max.y - bb.min.y);
    const trail01 = (bb.max.z - z) / Math.max(1e-3, bb.max.z - bb.min.z); // 0 LE → 1 TE
    const primary = smoothstep(0.4, 0.95, Math.max(tspan, trail01 * 0.6));
    const base = C_COVERT.clone().lerp(C_PRIMARY, primary);
    c.copy(C_COVERT_LOW).lerp(base, smoothstep(0.25, 0.7, top01));
    // at the buried root the wing shares the body's colour, so the fairing reads as
    // body skin flowing into wing rather than a coloured flap stuck on the flank.
    // The blend matches the deeper fillet: full body colour over the buried root,
    // easing to wing colour only PAST the emergence (~28% of the collapsed span) —
    // so there is no colour seam where the fillet emerges, only a soft gradient from
    // flank-grey to covert-grey. (tspan is small over the inboard-collapsed root, so
    // this keys cleanly onto exactly the buried + emerging region.)
    const rootBlend = smoothstep(0.28, 0.05, tspan); // 1 over the buried root → 0 by ~28% span
    if (rootBlend > 0) {
      // match the body flank's own top→pearl gradient at this height so the colour
      // agrees with the haunch the wing emerges from (no hue/value step at the join).
      const bodyHere = C_BODY.clone().lerp(C_BODY_TOP, smoothstep(0.4, 0.95, top01));
      c.lerp(bodyHere, rootBlend * 0.95);
    }

    // --- secondary covert rows: gentle chordwise feather bands across the inner
    // wing (rows of overlapping coverts) — light shaft, shadow at each overlap ---
    const covertBands = 0.5 + 0.5 * Math.cos(trail01 * Math.PI * 6 - tspan * 2.0);
    c.lerp(C_FEATHER_SHADE, (1 - covertBands) * 0.14 * (1 - primary) * smoothstep(0.15, 0.6, trail01));

    // --- primary feather stripes: along the outer wing each primary is a long
    // shaft separated by a shadowed gap; pale sunlit lip on the trailing rim ---
    const primBand = 0.5 + 0.5 * Math.cos(tspan * Math.PI * 2 * WING_PRIMARIES);
    if (primary > 0.2) {
      c.lerp(C_FEATHER_SHADE.clone().multiplyScalar(0.8), (1 - primBand) * primary * 0.35); // gaps
      c.lerp(C_PRIMARY_EDGE, primBand * smoothstep(0.5, 1.0, tspan) * 0.35); // shaft sheen
    }

    // pale feather lip along the very trailing edge (catches the sun)
    c.lerp(C_FEATHER_EDGE, smoothstep(0.85, 1.0, trail01) * 0.45 * (1 - primary * 0.6));
    c.multiplyScalar(sunlit(nx, ny, nz, 0.13));
  });
  brokenColour(g, 0.04, 7);
  return g;
}

// ---------------------------------------------------------------------------
// LEGS & FEET — slim trailing tubes + webbed feet, kept simple and parented to
// the body so they stream behind. One merged mesh per leg.
// ---------------------------------------------------------------------------
export const TARSUS_LEN = 0.26;

function sweepTube(spine: THREE.Vector3[], radii: number[], seg: number): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(spine, false, 'catmullrom', 0.5);
  const n = spine.length;
  const tan: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) tan.push(curve.getTangentAt(clamp01(i / (n - 1))).normalize());
  let nrm = new THREE.Vector3(0, 1, 0);
  if (Math.abs(tan[0].dot(nrm)) > 0.92) nrm.set(1, 0, 0);
  nrm.sub(tan[0].clone().multiplyScalar(tan[0].dot(nrm))).normalize();
  const q = new THREE.Quaternion(), axis = new THREE.Vector3();
  const normals: THREE.Vector3[] = [], binormals: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      axis.crossVectors(tan[i - 1], tan[i]);
      const len = axis.length();
      if (len > 1e-6) {
        axis.divideScalar(len);
        const dot = clamp01((tan[i - 1].dot(tan[i]) + 1) / 2) * 2 - 1;
        q.setFromAxisAngle(axis, Math.acos(dot));
        nrm.applyQuaternion(q);
      }
      nrm.sub(tan[i].clone().multiplyScalar(tan[i].dot(nrm))).normalize();
    }
    normals.push(nrm.clone());
    binormals.push(new THREE.Vector3().crossVectors(tan[i], nrm).normalize());
  }
  const verts: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = spine[i], nA = normals[i], bA = binormals[i], r = radii[i];
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const ux = Math.cos(a) * r, uy = Math.sin(a) * r;
      verts.push(c.x + bA.x * ux + nA.x * uy, c.y + bA.y * ux + nA.y * uy, c.z + bA.z * ux + nA.z * uy);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * seg, b = (i + 1) * seg;
    for (let s = 0; s < seg; s++) {
      const j = (s + 1) % seg;
      idx.push(a + s, a + j, b + j, a + s, b + j, b + s);
    }
  }
  const ci = verts.length / 3;
  verts.push(spine[0].x, spine[0].y, spine[0].z);
  for (let s = 0; s < seg; s++) idx.push(ci, ((s + 1) % seg), s);
  const ce = verts.length / 3;
  const e = spine[n - 1]; verts.push(e.x, e.y, e.z);
  const baseE = (n - 1) * seg;
  for (let s = 0; s < seg; s++) idx.push(ce, baseE + s, baseE + ((s + 1) % seg));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildLeg(): THREE.BufferGeometry {
  const N = 7;
  const spine: THREE.Vector3[] = [], radii: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    spine.push(new THREE.Vector3(0, -0.05 * t - 0.015 * Math.sin(t * Math.PI), -TARSUS_LEN * t));
    radii.push((0.03 - 0.012 * t) * (1 + 0.4 * Math.exp(-((t - 0.05) ** 2) / 0.02)) + 0.004);
  }
  const g = sweepTube(spine, radii, 12);
  roughen(g, 0.0016, 40);
  return paint(g, (c, _x, y, _z, nx, ny, nz) => {
    c.copy(C_LEG).lerp(C_LEG_DARK, Math.max(0, -ny) * 0.3 + smoothstep(0.0, -0.05, y) * 0.2);
    c.multiplyScalar(sunlit(nx, ny, nz, 0.1));
  });
}

export function buildFoot(side: number): THREE.BufferGeometry {
  const toeLen = 0.17;
  const toeAngles = [-0.4, 0, 0.4];
  const tips = toeAngles.map((a) =>
    new THREE.Vector3(side * Math.sin(a) * toeLen, -0.014, -Math.cos(a) * toeLen));
  const parts: THREE.BufferGeometry[] = [];
  for (const tip of tips) {
    const N = 5;
    const spine: THREE.Vector3[] = [], radii: number[] = [];
    for (let s = 0; s < N; s++) {
      const t = s / (N - 1);
      spine.push(new THREE.Vector3(tip.x * t, tip.y * t - 0.01 * Math.sin(Math.PI * t), tip.z * t));
      radii.push(0.013 * (1 - 0.75 * t) + 0.0025);
    }
    parts.push(sweepTube(spine, radii, 8));
  }
  const NU = 13, NV = 5;
  const top: number[] = [], bot: number[] = [];
  for (let i = 0; i < NU; i++) {
    const u = i / (NU - 1);
    const ang = toeAngles[0] + (toeAngles[2] - toeAngles[0]) * u;
    const between = Math.sin(u * Math.PI * 2);
    for (let j = 0; j < NV; j++) {
      const v = j / (NV - 1);
      const reach = toeLen * v;
      const x = side * Math.sin(ang) * reach;
      const z = -Math.cos(ang) * reach;
      const y = -0.012 * v - 0.016 * Math.abs(between) * v;
      top.push(x, y + 0.0035, z); bot.push(x, y - 0.0035, z);
    }
  }
  parts.push(membraneFromGrids(top, bot, NU, NV, side < 0));
  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  merged.computeVertexNormals();
  return paint(merged, (c, _x, y, _z, nx, ny, nz) => {
    const onWeb = Math.abs(y) < 0.008;
    c.copy(onWeb ? C_WEB : C_LEG).lerp(C_LEG_DARK, Math.max(0, -ny) * 0.3);
    c.multiplyScalar(sunlit(nx, ny, nz, 0.1));
  });
}
