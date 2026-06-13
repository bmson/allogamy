import * as THREE from 'three/webgpu';
import { mulberry32, hash2 } from '../core/rng';
import { palette } from '../render/palette';
import { TerrainField } from './TerrainField';
import { CHUNK_SIZE, WORLD_SEED, SUN_DIR } from '../config';

// Sparse distant life: an occasional grazing deer or sheep standing on open
// meadow, and — rarer still — a lone bird wheeling slowly far overhead. Life
// glimpsed, not a petting zoo. MOST CHUNKS HAVE NONE (this protects both the
// quiet mood and performance).
//
// Animals are simple low-poly SOLID meshes, built procedurally in the same
// language as the boulders & the hero bird: flat-ish forms, lighting BAKED into
// per-vertex colour (a sun term + a top/under split → warm lit, cool-shaded,
// never near-black), drawn with a shared vertex-colour MeshStandardMaterial.
// They are STATIC except for a tiny, cheap group-transform animation (grazing
// head-bob, tail flick, slow wing) ticked once per frame — NO skinning, no
// per-vertex CPU work.

const _sun = new THREE.Vector3(...SUN_DIR).normalize();

// ---- Ghibli fauna palette (derived from / harmonised with palette.ts) ----
const C_DEER = new THREE.Color('#b07644'); // warm fawn (between bark & pathEarthDry)
const C_DEER_BELLY = new THREE.Color('#e8d3b0'); // pale cream underside
const C_SHEEP = new THREE.Color('#f1ede2'); // warm off-white fleece
const C_SHEEP_SHADE = new THREE.Color('#cfc6b6'); // fleece in shade
const C_LEG = new THREE.Color('#3c2a19'); // barkDark — dark legs/face
const C_BIRD = new THREE.Color('#4a4f5e'); // cool blue-grey distant bird

// ---- baking helpers (mirrors Bird.ts) ----
const _c = new THREE.Color();

/** Soft sun term used to brighten faces turned toward the light. */
function sunlit(nx: number, ny: number, nz: number, amt: number): number {
  return 1 + amt * Math.max(0, nx * _sun.x + ny * _sun.y + nz * _sun.z);
}

/**
 * Bake a flat Ghibli colour into a geometry's vertex colours: warm where the
 * normal faces the sun, cooled & darkened on the underside, never black. The
 * `base`/`under` pair lets each part read as a lit solid form.
 */
function paint(geo: THREE.BufferGeometry, base: THREE.Color, under: THREE.Color): THREE.BufferGeometry {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const ny = nrm.getY(i);
    // upward-facing → base, downward-facing → under (mix on the normal's y)
    const t = THREE.MathUtils.clamp(ny * 0.5 + 0.5, 0, 1);
    _c.copy(under).lerp(base, t);
    _c.multiplyScalar(sunlit(nrm.getX(i), ny, nrm.getZ(i), 0.14) * 0.96);
    col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.deleteAttribute('uv'); // not needed; keeps the merged buffer lean
  return geo;
}

/** Merge non-indexed position/normal/color geometries into one (disposes inputs). */
function mergeColored(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const P = new Float32Array(total * 3);
  const N = new Float32Array(total * 3);
  const C = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) {
    const gp = g.attributes.position.array as Float32Array;
    const gn = g.attributes.normal.array as Float32Array;
    const gc = g.attributes.color.array as Float32Array;
    P.set(gp, o); N.set(gn, o); C.set(gc, o);
    o += gp.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  out.setAttribute('color', new THREE.BufferAttribute(C, 3));
  return out;
}

/** A flat-shaded box part, transformed into place, then sun-baked. */
function box(
  w: number, h: number, d: number,
  x: number, y: number, z: number,
  base: THREE.Color, under: THREE.Color,
  rotX = 0, rotZ = 0,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotX) g.rotateX(rotX);
  if (rotZ) g.rotateZ(rotZ);
  g.translate(x, y, z);
  g.computeVertexNormals();
  return paint(g, base, under);
}

// ---- deer: a low, alert silhouette built from a few boxes ----
// Body long axis +Z (nose forward). Built at "real" metres, scaled when placed.
// The head/neck and tail are SEPARATE meshes parented to pivots so they can
// gently animate; the static body+legs merge into one geometry/draw.
interface DeerParts {
  body: THREE.BufferGeometry; // legs + torso (static)
  head: THREE.BufferGeometry; // neck + head + ears (animated: grazing bob)
  tail: THREE.BufferGeometry; // little tail (animated: flick)
  headPivot: THREE.Vector3; // where the neck meets the shoulders
  tailPivot: THREE.Vector3;
}

function buildDeer(rnd: () => number): DeerParts {
  const fawn = _c.copy(C_DEER).offsetHSL((rnd() - 0.5) * 0.02, (rnd() - 0.5) * 0.05, (rnd() - 0.5) * 0.06).clone();
  const belly = C_DEER_BELLY;

  // ---- static: torso + four legs ----
  const parts: THREE.BufferGeometry[] = [];
  // torso: a slightly tapered box, lifted to standing height
  parts.push(box(0.5, 0.55, 1.2, 0, 1.05, 0, fawn, belly));
  // haunch a touch taller at the back
  parts.push(box(0.52, 0.58, 0.5, 0, 1.12, -0.45, fawn, belly));
  // legs (front/back, left/right), thin dark posts
  const legY = 0.5;
  for (const sx of [-1, 1]) {
    parts.push(box(0.12, 1.0, 0.14, sx * 0.18, legY, 0.42, C_LEG, C_LEG)); // front
    parts.push(box(0.13, 1.0, 0.15, sx * 0.18, legY, -0.42, C_LEG, C_LEG)); // back
  }
  const body = mergeColored(parts);

  // ---- animated: neck + head + ears, built around a local pivot at origin ----
  const headPivot = new THREE.Vector3(0, 1.35, 0.6);
  const hParts: THREE.BufferGeometry[] = [];
  // neck angles up-forward from the pivot
  hParts.push(box(0.22, 0.6, 0.24, 0, 0.22, 0.12, fawn, belly, -0.5));
  // head at the neck's end
  hParts.push(box(0.24, 0.26, 0.42, 0, 0.5, 0.34, fawn, belly, 0.15));
  // dark muzzle tip
  hParts.push(box(0.15, 0.16, 0.18, 0, 0.44, 0.55, C_LEG, C_LEG));
  // two upright ears
  for (const sx of [-1, 1]) {
    hParts.push(box(0.05, 0.2, 0.12, sx * 0.12, 0.66, 0.26, fawn, belly, 0, sx * 0.3));
  }
  const head = mergeColored(hParts);

  // ---- animated: short tail, pivot at the rump ----
  const tailPivot = new THREE.Vector3(0, 1.2, -0.68);
  const tail = box(0.1, 0.26, 0.1, 0, -0.1, -0.02, fawn, belly);

  return { body, head, tail, headPivot, tailPivot };
}

// ---- sheep: a rounder, lower, woollier silhouette ----
function buildSheep(rnd: () => number): DeerParts {
  const fleece = _c.copy(C_SHEEP).offsetHSL(0, (rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.05).clone();
  const shade = C_SHEEP_SHADE;

  const parts: THREE.BufferGeometry[] = [];
  // big rounded fleece body (a wide box reads as a wool block at distance)
  parts.push(box(0.7, 0.72, 1.05, 0, 0.78, 0, fleece, shade));
  // a couple of offset wool lumps for a cloudy silhouette
  parts.push(box(0.6, 0.5, 0.55, 0.06, 1.0, 0.22, fleece, shade, 0, 0.12));
  parts.push(box(0.58, 0.46, 0.5, -0.05, 1.0, -0.28, fleece, shade, 0, -0.1));
  // short dark legs
  const legY = 0.3;
  for (const sx of [-1, 1]) {
    parts.push(box(0.13, 0.6, 0.15, sx * 0.2, legY, 0.32, C_LEG, C_LEG));
    parts.push(box(0.13, 0.6, 0.15, sx * 0.2, legY, -0.32, C_LEG, C_LEG));
  }
  const body = mergeColored(parts);

  // animated head: a small dark face on a stubby fleece neck
  const headPivot = new THREE.Vector3(0, 0.95, 0.5);
  const hParts: THREE.BufferGeometry[] = [];
  hParts.push(box(0.26, 0.3, 0.28, 0, 0.05, 0.1, fleece, shade)); // fleece poll
  hParts.push(box(0.18, 0.2, 0.3, 0, -0.04, 0.28, C_LEG, C_LEG)); // dark face
  for (const sx of [-1, 1]) {
    hParts.push(box(0.05, 0.12, 0.1, sx * 0.12, 0.12, 0.1, C_LEG, C_LEG)); // little ears
  }
  const head = mergeColored(hParts);

  // tiny tail
  const tailPivot = new THREE.Vector3(0, 0.85, -0.55);
  const tail = box(0.12, 0.18, 0.1, 0, -0.06, 0, fleece, shade);

  return { body, head, tail, headPivot, tailPivot };
}

// ---- distant wheeling bird: a simple shallow-V silhouette, far overhead ----
// Two angled wing quads + a tiny body. It only ever reads as a far speck, so it
// stays crude on purpose. Wings live on pivots for a slow flap; the whole bird
// is parented to a yaw group that turns it in a wide, slow circle.
function buildSoarBird(rnd: () => number): {
  body: THREE.BufferGeometry;
  wingL: THREE.BufferGeometry;
  wingR: THREE.BufferGeometry;
} {
  const col = _c.copy(C_BIRD).offsetHSL(0, 0, (rnd() - 0.5) * 0.06).clone();
  const dark = _c.copy(C_BIRD).multiplyScalar(0.7).clone();

  // slim body along +Z
  const body = box(0.5, 0.4, 2.2, 0, 0, 0, col, dark);
  // one wing per side: a long thin plank reaching out along +X, pivot at root
  const wL = box(3.2, 0.14, 1.0, -1.7, 0, 0, col, dark);
  const wR = box(3.2, 0.14, 1.0, 1.7, 0, 0, col, dark);
  return { body, wingL: wL, wingR: wR };
}

// ---- the per-chunk fauna handle ----
export interface ChunkFauna {
  object: THREE.Object3D;
  update?(time: number): void;
  /** Free all geometries this chunk created (Chunk.dispose calls this). */
  dispose(): void;
}

// One shared material for every grazing animal (vertex-coloured, flat-ish). It
// is created lazily and reused across chunks; never disposed (it lives for the
// session like the splat material). Geometries are per-chunk and ARE disposed.
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
  phase: number; // per-animal phase so they don't graze in lockstep
  bob: number; // grazing head dip amplitude (radians)
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
  const geos: THREE.BufferGeometry[] = []; // everything we must dispose
  const grazers: Grazer[] = [];
  let placed = 0;

  if (hasGrazers) {
    // A tiny herd: 1–3 animals, all the same species, clustered loosely so they
    // read as company rather than scattered noise.
    const sheep = rnd() < 0.5;
    const count = 1 + Math.floor(rnd() * 3);
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

        const parts = sheep ? buildSheep(rnd) : buildDeer(rnd);
        const scale = (sheep ? 1.0 : 1.15) * (0.9 + rnd() * 0.25);

        const animal = new THREE.Group();
        animal.position.set(x, y, z);
        animal.rotation.y = rnd() * Math.PI * 2; // facing anywhere
        animal.scale.setScalar(scale);

        // static body+legs
        animal.add(new THREE.Mesh(parts.body, mat));
        geos.push(parts.body);

        // animated head on its pivot
        const headPivot = new THREE.Group();
        headPivot.position.copy(parts.headPivot);
        headPivot.add(new THREE.Mesh(parts.head, mat));
        animal.add(headPivot);
        geos.push(parts.head);

        // animated tail on its pivot
        const tailPivot = new THREE.Group();
        tailPivot.position.copy(parts.tailPivot);
        tailPivot.add(new THREE.Mesh(parts.tail, mat));
        animal.add(tailPivot);
        geos.push(parts.tail);

        root.add(animal);
        grazers.push({
          headPivot, tailPivot,
          phase: rnd() * Math.PI * 2,
          bob: 0.5 + rnd() * 0.35, // how far the head dips to graze
        });
        placed++;
      }
    }
  }

  // ---- a lone bird wheeling slowly, far overhead ----
  let birdYaw: THREE.Group | null = null;
  let birdWingL: THREE.Group | null = null;
  let birdWingR: THREE.Group | null = null;
  let birdRadius = 0, birdSpeed = 0, birdPhase = 0;
  if (hasBird) {
    const bird = buildSoarBird(rnd);
    const bmat = birdMat();

    // a yaw group centred over the chunk; the bird sits at the rim and circles
    birdYaw = new THREE.Group();
    const baseH = field.height(ox + S * 0.5, oz + S * 0.5);
    birdYaw.position.set(ox + S * 0.5, baseH + 120 + rnd() * 90, oz + S * 0.5);
    root.add(birdYaw);

    const offset = new THREE.Group(); // pushes the bird out to the orbit radius
    birdRadius = 60 + rnd() * 60;
    offset.position.set(birdRadius, 0, 0);
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
    geos.push(bird.body, bird.wingL, bird.wingR);

    birdSpeed = (rnd() < 0.5 ? 1 : -1) * (0.05 + rnd() * 0.05); // rad/s, slow
    birdPhase = rnd() * Math.PI * 2;
    placed++;
  }

  if (placed === 0) {
    // built nothing usable (e.g. herd ground all rejected) — clean up & skip
    for (const g of geos) g.dispose();
    return null;
  }

  // gentle, cheap per-frame animation: a few group transforms, no per-vertex work
  const hasAnim = grazers.length > 0 || birdYaw !== null;
  const update = hasAnim
    ? (time: number) => {
        for (const g of grazers) {
          const t = time + g.phase;
          // slow grazing cycle: head dips down, lifts to look around, dips again
          const graze = Math.sin(t * 0.5) * 0.5 + 0.5; // 0..1
          g.headPivot.rotation.x = graze * g.bob;
          // occasional quick tail flick layered on a slow sway
          g.tailPivot.rotation.x = Math.sin(t * 1.3) * 0.18 + Math.sin(t * 7.0) * 0.12;
          g.tailPivot.rotation.z = Math.sin(t * 0.9) * 0.1;
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
    dispose() {
      for (const g of geos) g.dispose();
    },
  };
}
