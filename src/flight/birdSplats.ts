import * as THREE from 'three/webgpu';
import {
  attribute, uv, vec2, vec3, vec4, float, smoothstep, mix, modelViewMatrix,
  cameraProjectionMatrix, positionGeometry, time, sin, cos, fract,
} from 'three/tsl';

// ===========================================================================
// THE BIRD'S SPLAT COAT — a SUBTLE painterly dab-coat over the whole pelican.
//
// GOAL: make the bird read as part of the SAME painting as the meadow. The meadow,
// trees and foliage are soft gaussian-splat dabs (see render/SplatMaterial); the
// bird was a smooth solid SkinnedMesh, so it sat in the world like a different
// medium. This module lays a LIGHT coat of the same feathered dabs over the body,
// both wings and the tail — same soft stamp, same broken-colour shimmer — so the
// silhouette softens and the surface shimmers with brushwork, WITHOUT obscuring the
// readable pelican form. The solid bird stays underneath; this is purely additive.
//
// APPROACH (B — per-bone rigid clusters). The bird flaps and folds, so the coat has
// to deform with it. Rather than skin every dab in the shader, we exploit the
// scene graph: each dab is assigned to the bird BONE it sits closest to (the bone
// carrying the largest skin weight at the sampled surface vertex), converted into
// that bone's LOCAL rest frame, and packed into one instanced-splat mesh PARENTED
// to that bone. When the bone moves (flap / neck-fold / tail-steer / breathe), its
// child cluster rides along — the modelViewMatrix already carries the bone's world
// transform, so the existing world-space-centre billboard maths just works, with no
// custom skinning. It is piecewise-rigid per bone, but at this subtle density (and
// with the dabs hugging the surface) the per-bone facets are invisible; the coat
// reads as a soft continuous shimmer that flaps and folds with the creature.
//
// Sampling: walk each source mesh's triangles, scatter a few barycentric points per
// triangle (count ∝ area so density is even), and inherit each point's interpolated
// vertex COLOUR + NORMAL + skin binding. Tint = the sampled body/wing vertex colour
// (which is already mixed from the birdGeometry palette — C_BODY / C_PRIMARY / …)
// with a small per-dab jitter. Dabs are small relative to the bird, and carry only a
// FAINT shimmer (near-zero wind sway) — the bird is not grass.
// ===========================================================================

// --- tunables -------------------------------------------------------------
// Subtlety lives here. DENSITY is dabs per unit AREA of source surface (bird-local
// units, pre-SCALE). DAB_SCALE is the dab half-size in those same local units. A
// light coat: enough overlap to soften edges + shimmer, sparse enough that the solid
// pelican reads clearly through it.
const DENSITY = 1050;       // dabs per unit² — dense enough that the soft-feathered marks
//                             BLEND into a continuous painted surface (like the meadow),
//                             not sparse opaque patches.
const DAB_SCALE = 0.155;    // dab world half-size — kept small so dabs sit as brush marks
//                             ON the form and don't puff off the silhouette into fuzz.
const DAB_ASPECT = 2.0;     // elongate each dab into an oval STROKE (like the meadow splats), not a circle
const DAB_SIZE_JITTER = 0.35; // ± fraction of per-dab size variation
const COAT_OPACITY = 0.9;   // near-opaque CORE with a soft feathered RIM that blends, so the
//                             surface reads as one painted skin (not see-through, not foam).
const SHIMMER = 0.16;       // faint animated dab wobble amplitude (NOT wind sway)
const SEED = 0x9e3779b9;

// deterministic PRNG so the coat is identical every load (no flicker between runs)
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A growing typed-array accumulator (positions/colours/scales) per bone cluster.
interface Cluster {
  centers: number[];
  scales: number[];
  colors: number[];
  angles: number[];
}
const newCluster = (): Cluster => ({ centers: [], scales: [], colors: [], angles: [] });

// Sample one source skinned geometry into per-bone clusters. For each dab we pick the
// dominant bone and convert its centre into that bone's local REST frame, matching the
// GPU skinning formula `boneMatrixWorld · boneInverse · bindMatrix · position`: at rest
// `boneInverse · bindMatrix · position` is the point in the bone's local frame, so a
// cluster parented to that bone reproduces the surface position and rides the bone.
function sampleGeometry(
  geo: THREE.BufferGeometry,
  boneInverses: THREE.Matrix4[],
  bindMatrix: THREE.Matrix4,
  clusters: Map<number, Cluster>,
  rng: () => number,
): void {
  const pos = geo.attributes.position.array as ArrayLike<number>;
  const col = (geo.attributes.color?.array ?? null) as ArrayLike<number> | null;
  const si = geo.attributes.skinIndex.array as ArrayLike<number>;
  const sw = geo.attributes.skinWeight.array as ArrayLike<number>;
  const index = geo.index;
  if (!index) return;
  const ix = index.array as ArrayLike<number>;
  const triCount = ix.length / 3;

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), cross = new THREE.Vector3();
  const p = new THREE.Vector3();

  for (let t = 0; t < triCount; t++) {
    const i0 = ix[t * 3], i1 = ix[t * 3 + 1], i2 = ix[t * 3 + 2];
    a.set(pos[i0 * 3], pos[i0 * 3 + 1], pos[i0 * 3 + 2]);
    b.set(pos[i1 * 3], pos[i1 * 3 + 1], pos[i1 * 3 + 2]);
    c.set(pos[i2 * 3], pos[i2 * 3 + 1], pos[i2 * 3 + 2]);
    ab.subVectors(b, a); ac.subVectors(c, a);
    const area = cross.crossVectors(ab, ac).length() * 0.5;
    // Poisson-ish: expected count = area*DENSITY, drawn by flooring + fractional dice.
    const expected = area * DENSITY;
    let n = Math.floor(expected);
    if (rng() < expected - n) n += 1;
    for (let k = 0; k < n; k++) {
      // uniform barycentric sample on the triangle
      let u = rng(), v = rng();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const w0 = 1 - u - v, w1 = u, w2 = v;
      p.set(
        a.x * w0 + b.x * w1 + c.x * w2,
        a.y * w0 + b.y * w1 + c.y * w2,
        a.z * w0 + b.z * w1 + c.z * w2,
      );
      // BILL FADE: `p` is still in bird-local space (nose +Z; the bill runs z≈1.2→2.1).
      // The pelican's signature bill must read SMOOTH, not foamed — so we fade the coat
      // out across the forehead (z~1.05) and place NO dabs on the bill proper (z>1.22).
      const localZ = p.z;
      if (localZ > 1.22) continue; // bare smooth bill
      let billShrink = 1;
      if (localZ > 1.05) {
        billShrink = Math.max(0, 1 - (localZ - 1.05) / 0.17); // 1 at the forehead → 0 at the bill base
        if (rng() > billShrink) continue; // thin the dabs out approaching the bill
      }
      // dominant bone = the source vertex (of this triangle's corners) with the
      // single largest skin weight. Picking per-vertex (not per-interpolated) keeps
      // a clean integer bone choice; the nearest corner by barycentric weight wins
      // so the dab inherits the binding of the surface it actually sits on.
      const corner = w0 >= w1 && w0 >= w2 ? i0 : (w1 >= w2 ? i1 : i2);
      let bone = si[corner * 4], best = sw[corner * 4];
      for (let s = 1; s < 4; s++) {
        if (sw[corner * 4 + s] > best) { best = sw[corner * 4 + s]; bone = si[corner * 4 + s]; }
      }
      // convert the centre into this bone's local rest frame so that re-parenting
      // the cluster under the (moving) bone reproduces the surface position at rest.
      p.applyMatrix4(bindMatrix).applyMatrix4(boneInverses[bone]);

      let cl = clusters.get(bone);
      if (!cl) { cl = newCluster(); clusters.set(bone, cl); }
      cl.centers.push(p.x, p.y, p.z);
      // size: small, jittered per dab; shrunk further across the bill-fade transition
      // so the few dabs near the bill base taper away rather than ending in a hard line.
      cl.scales.push(DAB_SCALE * (0.55 + 0.45 * billShrink) * (1 + (rng() * 2 - 1) * DAB_SIZE_JITTER));
      // colour: sampled vertex colour (already palette-mixed) + tiny per-dab jitter so
      // the coat shimmers in temperature like the meadow's broken colour, never flat.
      const cr = col ? col[corner * 3] : 0.85;
      const cg = col ? col[corner * 3 + 1] : 0.86;
      const cb = col ? col[corner * 3 + 2] : 0.88;
      // OPAQUE broken-colour dabs: each dab is a SOLID flat patch in a different SHADE
      // of the sampled hue — some darker, some lighter — so the coat reads as hand-laid
      // paint marks (varied tones) rather than transparent specks. A small warm↔cool
      // temperature tilt on top keeps it from looking like a flat greyscale value ramp.
      const warm = (rng() * 2 - 1) * 0.035;
      const shade = 0.88 + rng() * 0.2; // per-dab value 0.88..1.08 → varied shades, but COHESIVE (not speckled)
      const cl2 = (v: number) => Math.min(1, Math.max(0, v));
      cl.colors.push(
        cl2(cr * shade + warm),
        cl2(cg * shade),
        cl2(cb * shade - warm),
      );
      cl.angles.push(rng() * Math.PI * 2);
    }
  }
}

// A unit quad template shared by every cluster geometry (copied per cluster).
const QUAD = {
  position: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
  uv: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  index: new Uint16Array([0, 1, 2, 0, 2, 3]),
};

// The coat's dab material. A pared-down sibling of render/SplatMaterial: the SAME
// soft feathered gaussian stamp + broken-colour tooth, but billboarded around a
// bird-local centre (modelViewMatrix carries the parent bone's transform), with NO
// wind sway and NO aerial-perspective grade (the bird is near the camera and shaded
// by its own palette, not the meadow's fog). A faint shimmer keeps it alive.
function makeCoatMaterial(): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.fog = false;
  // Like the meadow splats: near-opaque CORES that write depth (so the coat self-occludes
  // and isn't see-through), with soft FEATHERED RIMS that blend — so dense overlapping
  // marks melt into one continuous painted skin instead of reading as separate patches or
  // foam. alphaTest discards the empty outer rim so the cores still lay down clean depth.
  mat.transparent = true;
  mat.depthWrite = true;
  mat.depthTest = true;
  mat.alphaTest = 0.34; // discard the faint outer rim → soft feathered overlap, cores blend

  const aCenter = attribute('aCenter', 'vec3');
  const aScale = attribute('aScale', 'float');
  const aColor = attribute('aColor', 'vec3');
  const aAngle = attribute('aAngle', 'float');

  // Billboard: bone-local centre → view space (modelViewMatrix = camera · bone),
  // then offset the rotated quad corner in view space so the dab always faces camera.
  const centerView = modelViewMatrix.mul(vec4(aCenter, 1.0));
  // faint shimmer: a tiny per-dab animated rotation wobble (NOT a positional sway —
  // the bird isn't grass), so the brushwork breathes a little.
  const j = fract(sin(aCenter.x.mul(91.3).add(aCenter.z.mul(47.1)).add(aCenter.y.mul(13.7))).mul(4137.5));
  const ang = aAngle.add(sin(time.mul(0.6).add(j.mul(6.2831))).mul(SHIMMER));
  const csA = cos(ang), snA = sin(ang);
  // elongate along the stroke's length (y) into an OVAL, like the meadow brushstrokes —
  // a round dab reads as a scale/bubble; an oriented oval reads as a paint mark.
  const cl = vec2(positionGeometry.x, positionGeometry.y.mul(DAB_ASPECT));
  const rot = vec2(cl.x.mul(csA).sub(cl.y.mul(snA)), cl.x.mul(snA).add(cl.y.mul(csA)));
  const corner = rot.mul(aScale);
  const viewPos = vec4(centerView.xyz.add(vec3(corner, 0.0)), 1.0);
  mat.vertexNode = cameraProjectionMatrix.mul(viewPos);

  // Soft feathered gaussian dab + a touch of dry-media bristle, ported from the
  // meadow splat so the marks read as the SAME brush.
  const r = uv().sub(0.5).mul(2.0);
  const seed = fract(sin(aCenter.x.mul(12.9898).add(aCenter.z.mul(78.233)).add(aCenter.y.mul(37.7))).mul(43758.5453));
  const bristle = fract(
    sin(r.y.mul(6.0).floor().mul(127.1).add(seed.mul(91.0).floor().mul(311.7))).mul(43758.5453),
  );
  const d = r.dot(r).mul(float(1.0).add(bristle.sub(0.5).mul(0.2)));
  // Soft feathered gaussian (meadow-matched): opaque core melting to a wide blended rim,
  // so dense marks fuse into a painted surface. alphaTest culls the empty rim (d≳1).
  mat.opacityNode = smoothstep(float(1.0), float(0.45), d).mul(COAT_OPACITY);

  // loaded-brush tooth (rides the colour, fades to the rim) — same as the meadow.
  const streak = sin(r.x.mul(9.0).add(seed.mul(6.2831)));
  const body = float(1.0).sub(d).max(0.0);
  const tooth = streak.mul(0.6).add(bristle.sub(0.5)).mul(0.085).mul(body);
  mat.colorNode = aColor.mul(float(1.0).add(tooth));

  return mat;
}

function buildClusterGeometry(cl: Cluster): THREE.InstancedBufferGeometry {
  const ig = new THREE.InstancedBufferGeometry();
  ig.setAttribute('position', new THREE.BufferAttribute(QUAD.position.slice(), 3));
  ig.setAttribute('uv', new THREE.BufferAttribute(QUAD.uv.slice(), 2));
  ig.setIndex(new THREE.BufferAttribute(QUAD.index.slice(), 1));
  ig.setAttribute('aCenter', new THREE.InstancedBufferAttribute(new Float32Array(cl.centers), 3));
  ig.setAttribute('aScale', new THREE.InstancedBufferAttribute(new Float32Array(cl.scales), 1));
  ig.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(cl.colors), 3));
  ig.setAttribute('aAngle', new THREE.InstancedBufferAttribute(new Float32Array(cl.angles), 1));
  ig.instanceCount = cl.scales.length;
  // a generous bounding sphere so per-bone clusters never get frustum-culled when the
  // bird's parts swing far from the bone origin (we also disable culling on the bird).
  ig.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 4);
  return ig;
}

// One source mesh + the bones its clusters can be parented to.
export interface CoatSource {
  geo: THREE.BufferGeometry;     // the source skinned geometry (sampling source)
  boneInverses: THREE.Matrix4[]; // skeleton.boneInverses (bind-world → bone-local)
  bindMatrix: THREE.Matrix4;     // the skinned mesh's bind matrix (geom → bind-world)
  bones: THREE.Bone[];           // skeleton.bones, indexed by skinIndex
}

/**
 * Build the subtle splat coat. Samples each source mesh's surface into per-bone
 * dab clusters, then creates one instanced-splat mesh per non-empty bone cluster and
 * parents it UNDER that bone, so the coat deforms with the bird. All clusters share
 * ONE material. Returns the created meshes (the caller need not track them — they
 * live under the bird's bones — but they're returned for disposal/visibility control).
 */
export function buildBirdSplatCoat(sources: CoatSource[]): THREE.Mesh[] {
  const rng = mulberry32(SEED);
  const mat = makeCoatMaterial();
  const meshes: THREE.Mesh[] = [];

  for (const src of sources) {
    // gather this source's dabs grouped by bone
    const clusters = new Map<number, Cluster>();
    sampleGeometry(src.geo, src.boneInverses, src.bindMatrix, clusters, rng);
    for (const [boneIdx, cl] of clusters) {
      if (cl.scales.length === 0) continue;
      const bone = src.bones[boneIdx];
      if (!bone) continue;
      const ig = buildClusterGeometry(cl);
      const mesh = new THREE.Mesh(ig, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 2; // draw after the solid bird so it coats over it
      bone.add(mesh);
      meshes.push(mesh);
    }
  }
  return meshes;
}
