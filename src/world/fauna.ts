import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, hash2 } from '../core/rng';
import { palette } from '../render/palette';
import { TerrainField } from './TerrainField';
import { CHUNK_SIZE, WORLD_SEED, SUN_DIR } from '../config';

// Sparse distant life: an occasional grazing deer or sheep standing on open
// meadow, and — rarer still — a lone bird wheeling slowly far overhead. Life
// glimpsed, not a petting zoo. MOST CHUNKS HAVE NONE (this protects both the
// quiet mood and performance).
//
// Animals are SMOOTH, carved low-poly forms, built in the same language as the
// hero pelican (birdGeometry.ts): rounded volumes SWEPT along short splines
// rather than bolted-together axis-aligned boxes — so a deer reads as one supple
// fawn silhouette and a sheep as one soft wool cloud, not a stack of cubes. Light
// is BAKED into per-vertex colour (a sun term + a top/under temperature split →
// warm lit, cool-shaded, never near-black), drawn with a shared vertex-colour
// MeshStandardMaterial.
//
// They are STATIC geometry except for a tiny, cheap group-transform animation
// (grazing head-bob, breathing, tail flick, slow wing) ticked once per frame —
// NO skinning, no per-vertex CPU work.
//
// PERFORMANCE: every animal's geometry is built ONCE per session as a small set
// of cached VARIANT prototypes (a few deer / sheep / bird builds) and shared by
// reference across all chunks and all instances. Placing fauna in a chunk now
// allocates only a handful of Groups + Meshes (cheap) — no geometry is built or
// disposed per chunk. Per-instance variety comes from picking a variant, a scale
// and a yaw; the baked colour jitter lives in the variants themselves.

const _sun = new THREE.Vector3(...SUN_DIR).normalize();

// ---- Ghibli fauna palette (derived from / harmonised with palette.ts) ----
const C_DEER = new THREE.Color('#b07644'); // warm fawn (between bark & pathEarthDry)
const C_DEER_BELLY = new THREE.Color('#e8d3b0'); // pale cream underside
const C_SHEEP = new THREE.Color('#f1ede2'); // warm off-white fleece
const C_SHEEP_SHADE = new THREE.Color('#cfc6b6'); // fleece in shade
const C_LEG = new THREE.Color('#3c2a19'); // barkDark — dark legs/face
const C_NOSE = new THREE.Color('#241712'); // near-black muzzle/eye
const C_BIRD = palette.shadow.clone().lerp(new THREE.Color('#3a4150'), 0.6); // cool blue-grey speck

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---- baking helpers (mirrors birdGeometry.ts) ----
const _c = new THREE.Color();

/** Soft sun term used to brighten faces turned toward the light. */
function sunlit(nx: number, ny: number, nz: number, amt: number): number {
  return 1 + amt * Math.max(0, nx * _sun.x + ny * _sun.y + nz * _sun.z);
}

/**
 * Per-vertex paint callback: given a position + normal, write a colour. Reused
 * across every limb so the whole creature shares one continuous shading rule.
 */
type PaintFn = (c: THREE.Color, x: number, y: number, z: number, nx: number, ny: number, nz: number) => void;

/** Bake vertex colours into a geometry from a per-vertex rule. */
function paint(geo: THREE.BufferGeometry, fn: PaintFn): THREE.BufferGeometry {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    fn(_c, pos.getX(i), pos.getY(i), pos.getZ(i), nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.deleteAttribute('uv'); // not needed; keeps the merged buffer lean
  return geo;
}

/**
 * A simple top/under temperature-split shading rule: warm lit `base` toward the
 * sky, cooled & darkened `under` beneath, brightened where the normal faces the
 * sun, never black. Returns a PaintFn closed over the two tones.
 */
function flatLit(base: THREE.Color, under: THREE.Color, sun = 0.14): PaintFn {
  return (c, _x, _y, _z, nx, ny, nz) => {
    const t = clamp01(ny * 0.5 + 0.5); // up → base, down → under
    c.copy(under).lerp(base, t);
    c.multiplyScalar(sunlit(nx, ny, nz, sun) * 0.96);
  };
}

// ---------------------------------------------------------------------------
// SWEEP — a short rounded tube along a poly-spine, the workhorse for every limb.
// A lighter cousin of birdGeometry.sweepTube: a low radial count, parallel-frame
// sweep that turns a few centre points + radii into one smooth capped volume.
// Body long axis +Z (nose forward); built at "real" metres, scaled when placed.
// ---------------------------------------------------------------------------
function sweepTube(spine: THREE.Vector3[], radii: number[], seg: number, ovality = 1): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(spine, false, 'catmullrom', 0.5);
  const n = spine.length;
  const tan: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) tan.push(curve.getTangentAt(clamp01(i / (n - 1))).normalize());
  // parallel-transport frames keep the section from twisting along the bend
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
      const ux = Math.cos(a) * r * ovality, uy = Math.sin(a) * r; // ovality widens laterally
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
  // cap both true ends so the volume is closed
  const ci = verts.length / 3;
  verts.push(spine[0].x, spine[0].y, spine[0].z);
  for (let s = 0; s < seg; s++) idx.push(ci, (s + 1) % seg, s);
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

/** A tapered four-station leg post, slightly bent at the knee, painted dark. */
function legGeo(len: number, topR: number, botR: number, bend: number): THREE.BufferGeometry {
  const spine = [
    new THREE.Vector3(0, len, 0),
    new THREE.Vector3(0, len * 0.62, bend * 0.4),
    new THREE.Vector3(0, len * 0.3, bend),
    new THREE.Vector3(0, 0, bend * 0.9),
  ];
  const radii = [topR, topR * 0.78, botR * 1.25, botR];
  return paint(sweepTube(spine, radii, 6), (c, _x, _y, _z, nx, ny, nz) => {
    c.copy(C_LEG).multiplyScalar(sunlit(nx, ny, nz, 0.1) * 0.95);
  });
}

/** Merge parts into one geometry, disposing the inputs (one draw call per group). */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  out.computeVertexNormals();
  return out;
}

// ---- the three animated parts every grazer shares (built around local pivots) -
interface FaunaParts {
  body: THREE.BufferGeometry; // legs + torso (static)
  head: THREE.BufferGeometry; // neck + head (animated: grazing bob)
  tail: THREE.BufferGeometry; // little tail (animated: flick)
  headPivot: THREE.Vector3; // where the neck meets the shoulders
  tailPivot: THREE.Vector3;
  baseScale: number; // species nominal scale
}

// ---- deer: a low, alert, supple silhouette swept from rounded volumes ----
// A spindle torso that swells at the chest and tapers to the haunch, four slim
// tapered legs, and a separate neck+head that lifts to look or dips to graze.
function buildDeer(rnd: () => number): FaunaParts {
  const fawn = C_DEER.clone().offsetHSL((rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.07);
  const belly = C_DEER_BELLY.clone().offsetHSL(0, 0, (rnd() - 0.5) * 0.04);
  const litBody = flatLit(fawn, belly, 0.15);

  const parts: THREE.BufferGeometry[] = [];
  // torso: a deep-chested spindle, back gently arched, dropping to the rump
  const torso = sweepTube(
    [
      new THREE.Vector3(0, 1.04, -0.62),
      new THREE.Vector3(0, 1.16, -0.3),
      new THREE.Vector3(0, 1.2, 0.05),
      new THREE.Vector3(0, 1.16, 0.42),
      new THREE.Vector3(0, 1.08, 0.66),
    ],
    [0.18, 0.27, 0.3, 0.26, 0.18],
    9, 0.82, // a touch slab-sided so it reads as a deer flank, not a sausage
  );
  parts.push(paint(torso, litBody));
  // four slim legs, fronts reaching slightly forward, backs angled back
  for (const sx of [-1, 1]) {
    const fl = legGeo(1.0, 0.075, 0.05, -0.04); fl.translate(sx * 0.16, 0, 0.4); parts.push(fl);
    const bl = legGeo(1.04, 0.085, 0.05, 0.08); bl.translate(sx * 0.16, 0, -0.42); parts.push(bl);
  }
  const body = merge(parts);

  // neck + head built around a local pivot at the shoulders, angled up-forward
  const headPivot = new THREE.Vector3(0, 1.32, 0.52);
  const neck = sweepTube(
    [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0.18, 0.16),
      new THREE.Vector3(0, 0.34, 0.34),
      new THREE.Vector3(0, 0.46, 0.5), // poll
      new THREE.Vector3(0, 0.44, 0.66), // brow
      new THREE.Vector3(0, 0.36, 0.84), // muzzle tip
    ],
    [0.13, 0.115, 0.1, 0.105, 0.09, 0.045],
    8,
  );
  const hParts = [paint(neck, litBody)];
  // dark nose dab at the muzzle tip
  const nose = new THREE.SphereGeometry(0.05, 6, 5);
  nose.scale(1, 0.85, 1.15); nose.translate(0, 0.35, 0.88);
  hParts.push(paint(nose, (c) => c.copy(C_NOSE)));
  // two upright ears (thin tapered leaves angled out)
  for (const sx of [-1, 1]) {
    const ear = sweepTube(
      [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.1, -0.01), new THREE.Vector3(0, 0.2, -0.03)],
      [0.045, 0.05, 0.012], 5, 1.6,
    );
    ear.rotateZ(sx * 0.32); ear.translate(sx * 0.11, 0.5, 0.46);
    hParts.push(paint(ear, litBody));
  }
  const head = merge(hParts);

  // short upright tail, pivot at the rump
  const tailPivot = new THREE.Vector3(0, 1.18, -0.66);
  const tail = sweepTube(
    [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -0.12, -0.04), new THREE.Vector3(0, -0.22, -0.04)],
    [0.06, 0.055, 0.02], 6,
  );
  // pale flash under the tail (white-tail deer signal)
  const flag = paint(tail, (c, _x, y, _z, nx, ny, nz) => {
    c.copy(fawn).lerp(C_DEER_BELLY, smoothstep(-0.05, -0.18, y));
    c.multiplyScalar(sunlit(nx, ny, nz, 0.14) * 0.96);
  });

  return { body, head, tail: flag, headPivot, tailPivot, baseScale: 1.15 };
}

// ---- sheep: a rounder, lower, woollier silhouette — one soft wool cloud ----
function buildSheep(rnd: () => number, resting: boolean): FaunaParts {
  const fleece = C_SHEEP.clone().offsetHSL(0, (rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.06);
  const shade = C_SHEEP_SHADE.clone();
  const litFleece = flatLit(fleece, shade, 0.12);
  const lift = resting ? 0.34 : 0.0; // a couched ewe sits its fleece low to the ground

  const parts: THREE.BufferGeometry[] = [];
  // a fat, almost-round fleece body — a wide low spindle, wide laterally
  const wool = sweepTube(
    [
      new THREE.Vector3(0, 0.78 - lift, -0.5),
      new THREE.Vector3(0, 0.9 - lift, -0.18),
      new THREE.Vector3(0, 0.92 - lift, 0.14),
      new THREE.Vector3(0, 0.86 - lift, 0.42),
    ],
    [0.26, 0.4, 0.39, 0.28],
    10, 1.18, // wide ovality → a cloudy block, not a tube
  );
  parts.push(paint(wool, litFleece));
  // two offset wool lumps for a soft, cumulus silhouette
  for (const [lx, lz, lr, ls] of [[0.04, 0.18, 0.27, 1], [-0.05, -0.22, 0.25, -1]] as const) {
    const lump = new THREE.SphereGeometry(lr, 7, 6);
    lump.scale(1.15, 0.85, 1); lump.rotateY(ls * 0.2);
    lump.translate(lx, 1.02 - lift, lz);
    parts.push(paint(lump, litFleece));
  }
  if (!resting) {
    // four short stubby dark legs (standing); a resting ewe folds them away
    for (const sx of [-1, 1]) {
      const fl = legGeo(0.56, 0.072, 0.05, 0); fl.translate(sx * 0.18, 0, 0.3); parts.push(fl);
      const bl = legGeo(0.56, 0.072, 0.05, 0); bl.translate(sx * 0.18, 0, -0.3); parts.push(bl);
    }
  }
  const body = merge(parts);

  // head: a small dark face on a stubby fleece neck
  const headPivot = new THREE.Vector3(0, 0.92 - lift, 0.46);
  const hParts: THREE.BufferGeometry[] = [];
  const poll = new THREE.SphereGeometry(0.15, 7, 6);
  poll.scale(1, 1, 1.05); poll.translate(0, 0.04, 0.06);
  hParts.push(paint(poll, litFleece)); // fleece poll
  const face = sweepTube(
    [new THREE.Vector3(0, 0, 0.04), new THREE.Vector3(0, -0.02, 0.2), new THREE.Vector3(0, -0.05, 0.34)],
    [0.1, 0.085, 0.05], 7,
  );
  hParts.push(paint(face, (c, _x, _y, _z, nx, ny, nz) => c.copy(C_LEG).multiplyScalar(sunlit(nx, ny, nz, 0.1)))); // dark face
  for (const sx of [-1, 1]) {
    const ear = new THREE.SphereGeometry(0.055, 5, 4);
    ear.scale(0.5, 0.7, 1.6); ear.rotateZ(sx * 0.5); ear.translate(sx * 0.13, 0.06, 0.1);
    hParts.push(paint(ear, (c, _x, _y, _z, nx, ny, nz) => c.copy(C_LEG).multiplyScalar(sunlit(nx, ny, nz, 0.1))));
  }
  const head = merge(hParts);

  // a tiny fleece tail
  const tailPivot = new THREE.Vector3(0, 0.82 - lift, -0.52);
  const tail = new THREE.SphereGeometry(0.08, 5, 4);
  tail.scale(0.8, 1.1, 0.8); tail.translate(0, -0.06, 0);
  const tailG = paint(tail, litFleece);

  return { body, head, tail: tailG, headPivot, tailPivot, baseScale: resting ? 1.05 : 1.0 };
}

// ---- distant wheeling bird: a slim body with two softly cambered gull wings ----
// It only ever reads as a far speck against the bright sky, so it stays simple —
// but the wings are gently bowed membranes (a shallow gull "M"), not flat planks,
// so the silhouette feels alive. Wings live on pivots for a slow flap.
interface SoarBird {
  body: THREE.BufferGeometry;
  wingL: THREE.BufferGeometry;
  wingR: THREE.BufferGeometry;
}
function buildSoarBird(rnd: () => number): SoarBird {
  const col = C_BIRD.clone().offsetHSL(0, 0, (rnd() - 0.5) * 0.07);
  const dark = col.clone().multiplyScalar(0.7);
  const litBird = flatLit(col, dark, 0.1);

  // slim tapered body along +Z (head forward, tail aft)
  const body = sweepTube(
    [
      new THREE.Vector3(0, 0, -1.1),
      new THREE.Vector3(0, 0.02, -0.3),
      new THREE.Vector3(0, 0.05, 0.4),
      new THREE.Vector3(0, 0.04, 0.95),
      new THREE.Vector3(0, 0, 1.15),
    ],
    [0.06, 0.2, 0.24, 0.12, 0.05],
    7,
  );
  const bodyG = paint(body, litBird);

  // one cambered wing per side: a triangular membrane that sweeps back and bows
  // up at the tip (a gull's lifted hand), thinning to the primaries.
  const wing = (side: number): THREE.BufferGeometry => {
    const NSPAN = 9, NCHORD = 4;
    const span = 3.4, rootChord = 1.0;
    const top: number[] = [], bot: number[] = [];
    const at = (i: number, j: number) => i * NCHORD + j;
    for (let i = 0; i < NSPAN; i++) {
      const t = i / (NSPAN - 1); // 0 root → 1 tip
      const x = side * t * span;
      const chord = lerp(rootChord, 0.22, smoothstep(0, 1, t)); // taper to slim primaries
      const le = -0.18 - 0.5 * t; // leading edge sweeps back
      const dihedral = 0.1 * t + 0.45 * smoothstep(0.55, 1, t); // gull lift at the hand
      for (let j = 0; j < NCHORD; j++) {
        const v = j / (NCHORD - 1);
        const z = le - chord * v;
        const camber = 0.12 * Math.sin(Math.PI * v) * (1 - 0.4 * t);
        const y = dihedral + camber;
        const th = 0.05 * (1 - 0.7 * t) * (0.5 + 0.5 * Math.sin(Math.PI * v));
        top.push(x, y + th, z);
        bot.push(x, y - th, z);
      }
    }
    const nTop = top.length / 3;
    const verts = top.concat(bot);
    const idx: number[] = [];
    const ab = (i: number, j: number) => nTop + at(i, j);
    const tri = (a: number, b: number, cc: number) => { if (side < 0) idx.push(a, cc, b); else idx.push(a, b, cc); };
    for (let i = 0; i < NSPAN - 1; i++) {
      for (let j = 0; j < NCHORD - 1; j++) {
        tri(at(i, j), at(i, j + 1), at(i + 1, j + 1)); tri(at(i, j), at(i + 1, j + 1), at(i + 1, j));
        tri(ab(i, j), ab(i + 1, j + 1), ab(i, j + 1)); tri(ab(i, j), ab(i + 1, j), ab(i + 1, j + 1));
      }
    }
    // seal the leading & trailing edges so the membrane is a closed shell
    for (let i = 0; i < NSPAN - 1; i++) {
      tri(at(i, 0), ab(i, 0), ab(i + 1, 0)); tri(at(i, 0), ab(i + 1, 0), at(i + 1, 0));
      const j = NCHORD - 1;
      tri(at(i, j), at(i + 1, j), ab(i + 1, j)); tri(at(i, j), ab(i + 1, j), ab(i, j));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return paint(g, (c, _x, _y, _z, nx, ny, nz) => {
      // darker, cool toward the primary tips so the wingtips read against the sky
      const tip = clamp01((Math.abs(_x)) / span);
      c.copy(col).lerp(dark, smoothstep(0.45, 1, tip) * 0.85);
      const t2 = clamp01(ny * 0.5 + 0.5);
      c.lerp(dark, (1 - t2) * 0.3);
      c.multiplyScalar(sunlit(nx, ny, nz, 0.1) * 0.96);
    });
  };

  return { body: bodyG, wingL: wing(-1), wingR: wing(1) };
}

// ---------------------------------------------------------------------------
// SESSION-CACHED VARIANT PROTOTYPES. Each variant's geometry is built ONCE and
// shared by reference across every chunk + instance, so placing fauna allocates
// no geometry and disposes none per chunk (these live for the session like the
// materials). Determinism is preserved: a chunk picks variants by index from its
// own seeded rng, and the variants themselves are stable.
// ---------------------------------------------------------------------------
const DEER_VARIANTS = 4;
const SHEEP_VARIANTS = 4; // last one is a resting ewe
let _deerCache: FaunaParts[] | null = null;
let _sheepCache: FaunaParts[] | null = null;
let _birdCache: SoarBird | null = null;

function deerVariants(): FaunaParts[] {
  if (!_deerCache) {
    _deerCache = [];
    for (let i = 0; i < DEER_VARIANTS; i++) _deerCache.push(buildDeer(mulberry32(0xdee0 + i)));
  }
  return _deerCache;
}
function sheepVariants(): FaunaParts[] {
  if (!_sheepCache) {
    _sheepCache = [];
    for (let i = 0; i < SHEEP_VARIANTS; i++) {
      _sheepCache.push(buildSheep(mulberry32(0x5ee0 + i), i === SHEEP_VARIANTS - 1));
    }
  }
  return _sheepCache;
}
function birdProto(): SoarBird {
  if (!_birdCache) _birdCache = buildSoarBird(mulberry32(0xb1d0));
  return _birdCache;
}

// ---- the per-chunk fauna handle ----
export interface ChunkFauna {
  object: THREE.Object3D;
  update?(time: number): void;
  /** Free anything this chunk owns (Chunk.dispose calls this). */
  dispose(): void;
}

// One shared material for every grazing animal (vertex-coloured, flat-ish). It is
// created lazily and reused across chunks; never disposed (it lives for the
// session like the splat material). Geometries are shared prototypes (also never
// disposed) — so a chunk's fauna is just a tree of Groups + Meshes referencing
// them, and dispose() only has to drop those references.
let _grazeMat: THREE.MeshStandardMaterial | null = null;
function grazeMat(): THREE.MeshStandardMaterial {
  if (!_grazeMat) {
    _grazeMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.92, metalness: 0, flatShading: true,
    });
  }
  return _grazeMat;
}
let _birdMat: THREE.MeshStandardMaterial | null = null;
function birdMat(): THREE.MeshStandardMaterial {
  if (!_birdMat) {
    _birdMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.7, metalness: 0, flatShading: true, side: THREE.DoubleSide,
    });
  }
  return _birdMat;
}

interface Grazer {
  headPivot: THREE.Group;
  tailPivot: THREE.Group;
  body: THREE.Object3D; // for a faint breathing scale
  phase: number; // per-animal phase so they don't graze in lockstep
  bob: number; // grazing head dip amplitude (radians)
  rest: number; // grazing-cycle bias (1 = grazes a lot, 0 = stands alert)
}

/**
 * Scatter (very sparse) fauna across one chunk. Returns null for MOST chunks.
 * `object` holds all animals for the chunk; the orchestrator adds it to the
 * chunk group, calls update(time) each frame if present, and dispose() on free.
 */
export function scatterFauna(field: TerrainField, cx: number, cz: number): ChunkFauna | null {
  const rnd = mulberry32(hash2(cx, cz, (WORLD_SEED ^ 0xfa00a) >>> 0));

  // Gate FIRST and cheaply: only ~1 in 7 chunks holds any grazing animals, and
  // ~1 in 14 a far bird. This single early-out keeps the common case ≈ free.
  const hasGrazers = rnd() < 0.14;
  const hasBird = rnd() < 0.07;
  if (!hasGrazers && !hasBird) return null;

  const S = CHUNK_SIZE;
  const ox = cx * S;
  const oz = cz * S;
  const root = new THREE.Group();
  const grazers: Grazer[] = [];
  let placed = 0;

  if (hasGrazers) {
    // A tiny herd: 1–3 animals, all the same species, clustered loosely so they
    // read as company rather than scattered noise.
    const sheep = rnd() < 0.5;
    const count = 1 + Math.floor(rnd() * 3);
    const variants = sheep ? sheepVariants() : deerVariants();
    // pick a herd centre on open ground; bail the whole herd if we can't find one
    let hx = 0, hz = 0, found = false;
    for (let tries = 0; tries < 6 && !found; tries++) {
      const x = ox + (0.2 + rnd() * 0.6) * S;
      const z = oz + (0.2 + rnd() * 0.6) * S;
      const surf = field.surface(x, z);
      if (surf.slope < 0.16 && surf.path < 0.15 && surf.rock < 0.2) {
        hx = x; hz = z; found = true;
      }
    }
    if (found) {
      const mat = grazeMat();
      for (let i = 0; i < count; i++) {
        // jitter each animal around the herd centre, re-checking the ground
        const x = hx + (rnd() - 0.5) * 14;
        const z = hz + (rnd() - 0.5) * 14;
        const surf = field.surface(x, z);
        if (surf.slope > 0.2 || surf.path > 0.18 || surf.rock > 0.25) continue;
        const y = field.height(x, z);

        // pick a shared variant prototype (no geometry built here)
        const parts = variants[Math.floor(rnd() * variants.length)];
        const scale = parts.baseScale * (0.9 + rnd() * 0.25);

        const animal = new THREE.Group();
        animal.position.set(x, y, z);
        animal.rotation.y = rnd() * Math.PI * 2; // facing anywhere
        animal.scale.setScalar(scale);

        // static body+legs (shared geometry, shared material)
        const bodyMesh = new THREE.Mesh(parts.body, mat);
        animal.add(bodyMesh);

        // animated head on its pivot
        const headPivot = new THREE.Group();
        headPivot.position.copy(parts.headPivot);
        headPivot.add(new THREE.Mesh(parts.head, mat));
        animal.add(headPivot);

        // animated tail on its pivot
        const tailPivot = new THREE.Group();
        tailPivot.position.copy(parts.tailPivot);
        tailPivot.add(new THREE.Mesh(parts.tail, mat));
        animal.add(tailPivot);

        root.add(animal);
        grazers.push({
          headPivot, tailPivot, body: bodyMesh,
          phase: rnd() * Math.PI * 2,
          bob: 0.5 + rnd() * 0.35, // how far the head dips to graze
          rest: 0.25 + rnd() * 0.55, // some heads-down grazing, some heads-up alert
        });
        placed++;
      }
    }
  }

  // ---- a lone bird wheeling slowly, far overhead ----
  let birdYaw: THREE.Group | null = null;
  let birdWingL: THREE.Group | null = null;
  let birdWingR: THREE.Group | null = null;
  let birdSpeed = 0, birdPhase = 0;
  if (hasBird) {
    const bird = birdProto(); // shared, built once
    const bmat = birdMat();

    // a yaw group centred over the chunk; the bird sits at the rim and circles
    birdYaw = new THREE.Group();
    const baseH = field.height(ox + S * 0.5, oz + S * 0.5);
    birdYaw.position.set(ox + S * 0.5, baseH + 120 + rnd() * 90, oz + S * 0.5);
    root.add(birdYaw);

    const offset = new THREE.Group(); // pushes the bird out to the orbit radius
    offset.position.set(60 + rnd() * 60, 0, 0);
    offset.rotation.y = -Math.PI / 2; // face along the tangent of the circle
    birdYaw.add(offset);

    const flier = new THREE.Group();
    flier.scale.setScalar(2.0 + rnd() * 1.0);
    flier.rotation.z = 0.18; // gentle bank into the turn
    offset.add(flier);

    flier.add(new THREE.Mesh(bird.body, bmat));
    birdWingL = new THREE.Group();
    birdWingL.add(new THREE.Mesh(bird.wingL, bmat));
    flier.add(birdWingL);
    birdWingR = new THREE.Group();
    birdWingR.add(new THREE.Mesh(bird.wingR, bmat));
    flier.add(birdWingR);

    birdSpeed = (rnd() < 0.5 ? 1 : -1) * (0.05 + rnd() * 0.05); // rad/s, slow
    birdPhase = rnd() * Math.PI * 2;
    placed++;
  }

  if (placed === 0) {
    // built nothing usable (e.g. herd ground all rejected) — nothing to free
    return null;
  }

  // gentle, cheap per-frame animation: a few group transforms, no per-vertex work
  const hasAnim = grazers.length > 0 || birdYaw !== null;
  const update = hasAnim
    ? (time: number) => {
        for (const g of grazers) {
          const t = time + g.phase;
          // slow grazing cycle: head dips down, lifts to look around, dips again.
          // `rest` biases the cycle so some animals graze deep, others stand alert.
          const graze = (Math.sin(t * 0.5) * 0.5 + 0.5) * g.rest + (1 - g.rest) * 0.15;
          g.headPivot.rotation.x = graze * g.bob;
          g.headPivot.rotation.z = Math.sin(t * 0.37) * 0.06; // idle look-about
          // occasional quick tail flick layered on a slow sway
          g.tailPivot.rotation.x = Math.sin(t * 1.3) * 0.18 + Math.sin(t * 7.0) * 0.12;
          g.tailPivot.rotation.z = Math.sin(t * 0.9) * 0.1;
          // faint breathing: the flank swells a hair (cheap single sin → scalar)
          g.body.scale.y = 1 + Math.sin(t * 1.6) * 0.015;
        }
        if (birdYaw) {
          birdYaw.rotation.y = birdPhase + time * birdSpeed; // wide slow circle
          const flap = Math.sin(time * 1.1 + birdPhase); // slow wingbeat
          if (birdWingL) birdWingL.rotation.z = 0.18 + flap * 0.28;
          if (birdWingR) birdWingR.rotation.z = -0.18 - flap * 0.28;
        }
      }
    : undefined;

  return {
    object: root,
    update,
    // Geometries & materials are shared session prototypes — NOT owned by the
    // chunk — so there is nothing to dispose here. Dropping the chunk group lets
    // the per-chunk Groups/Meshes be GC'd; the protos live on for reuse.
    dispose() {},
  };
}
