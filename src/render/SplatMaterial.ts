import * as THREE from 'three/webgpu';
import {
  attribute, uv, vec2, vec3, vec4, float, smoothstep, mix, modelViewMatrix,
  cameraProjectionMatrix, positionGeometry, time, sin, cos, fract, vertexStage,
} from 'three/tsl';
import { palette } from './palette';
import { uFogNear, uFogFar, uWind, uStrokeBias, uSizeFloor, uSizeJitter, uAngleJitter } from '../core/settings';

// Splats are camera-facing instanced quads. Each instance carries a world centre,
// a world-space size, a baked colour, a sway weight, and an orientation/elongation
// (round by default; >1 stretches into a blade/stem). The fragment paints a SOFT,
// slightly-irregular dab with a wide feathered edge and blends it — so dense
// overlapping strokes melt into a continuous painted surface rather than reading
// as a mosaic of separate dabs. Works on the WebGPU and WebGL2 backends.

export function makeSplatMaterial(): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.fog = false; // we fog manually below
  // Transparent brush-stamps that BLEND at their feathered rims, but with depthWrite
  // ON and a real alphaTest — so each dab's near-opaque CORE writes depth. That does
  // two big jobs at once:
  //   1) CORRECTNESS: the solid trunks/rocks (drawn first as opaque meshes) keep their
  //      depth, and foliage dabs that fall behind them are depth-rejected instead of
  //      painting OVER them — no more green-washed trunks.
  //   2) PERF: writing depth from the cores restores early-Z, so the mountain of
  //      overlapping carpet/foliage dabs no longer ALL shade every covered pixel —
  //      a near dab's core occludes the dabs behind it, collapsing the worst of the
  //      overdraw (the single biggest fill-rate sink in this scene).
  // alphaTest ≈ 0.45 keeps the soft feathered rim where it overlaps the core in front
  // (still blends, since transparent+blend stays on) but discards the empty/low-alpha
  // rim BEFORE it writes depth, so dabs don't punch hard depth holes around their
  // edges. Trade-off accepted: stamps read a touch more defined than the ultra-soft
  // version — correctness + framerate now outweigh the last bit of blend.
  // 6.html uses depthWrite:false + a per-frame sort; our no-sort pipeline can't afford
  // that, so this is the cheap, correct equivalent.
  mat.transparent = true;
  mat.depthWrite = true;
  mat.depthTest = true;
  mat.alphaTest = 0.45; // core writes depth (early-Z + occludes trunks); rim still blends

  const aCenter = attribute('aCenter', 'vec3');
  const aScale = attribute('aScale', 'float');
  const aColor = attribute('aColor', 'vec3');
  const aWind = attribute('aWind', 'float');
  const aAngle = attribute('aAngle', 'float'); // orientation (matters when elongated)
  const aAspect = attribute('aAspect', 'float'); // 1 = round; >1 stretches length (blades/stems)

  // Wind: two-octave travelling gust, +X dominant (half on Z), scaled per-instance
  // by aWind so grass/leaves sway and dirt/stone/trunks stay put.
  const gust = sin(aCenter.x.mul(0.13).add(aCenter.z.mul(0.1)).add(time.mul(0.9)))
    .add(sin(aCenter.x.mul(0.05).sub(aCenter.z.mul(0.04)).add(time.mul(0.5))).mul(0.5));
  const amp = aWind.mul(uWind);
  // Hoist the swayed X displacement so the dominant axis is evaluated once and the
  // Z component is just a scaled copy (Z = X*0.5) — same gust, one fewer multiply.
  const swayX = gust.mul(amp);
  const wind = vec3(swayX, float(0.0), swayX.mul(0.5));

  // Billboard: place the swayed centre in view space, then build the quad corner —
  // stretched along its length by aAspect, rotated by aAngle, sized by aScale.
  const centerView = modelViewMatrix.mul(vec4(aCenter.add(wind), 1.0));
  const depth = centerView.z.negate();
  // Gaussian-splat size FLOOR (the reference's signature trait): a dab never
  // projects below a minimum apparent size, so distant dabs grow just enough to
  // keep overlapping into a solid, plush carpet instead of thinning into
  // see-through gaps. The floor scales with depth (≈ constant pixels); near dabs
  // (small depth) keep their authored world size untouched.
  // Per-stamp pseudo-random values (hashed from the world centre) that break up the
  // mechanical regularity — each dab gets its OWN size and direction so the field
  // reads hand-made and organic, not a grid of identical marks.
  const j1 = fract(sin(aCenter.x.mul(34.21).add(aCenter.z.mul(11.13))).mul(7219.17));
  const j2 = fract(sin(aCenter.x.mul(73.99).add(aCenter.z.mul(41.07))).mul(3137.51));
  const sizeJit = float(1.0).add(j1.sub(0.5).mul(2.0).mul(uSizeJitter)); // 1 ± uSizeJitter
  // Gaussian-splat size FLOOR (distant dabs never shrink below a min apparent size →
  // a solid, plush carpet), then jittered so dab sizes vary irregularly.
  const effScale = aScale.max(depth.mul(uSizeFloor)).mul(sizeJit);
  // Oval, not round, so dabs read as paint/pencil STROKES; large-aspect blades/stems
  // change negligibly so flora/foliage silhouettes are preserved.
  const lenAspect = aAspect.add(uStrokeBias);
  const cl = vec2(positionGeometry.x, positionGeometry.y.mul(lenAspect));
  // Direction irregularity, gated by aWind so the wind/wave moves only the LEAVES
  // and grass — never the road, water, or rocks. Still things (aWind=0) get a FIXED
  // per-stamp offset (varied directions, no motion); vegetation (aWind>0) gets an
  // animated wobble that slowly oscillates so the brushwork shimmers and stays alive.
  const windGate = aWind.clamp(0.0, 1.0);
  const wobble = sin(time.mul(0.5).add(j2.mul(6.2831))); // -1..1 animated
  const staticOff = j2.sub(0.5).mul(2.0); // -1..1 fixed per-stamp
  const jAngle = aAngle.add(mix(staticOff, wobble, windGate).mul(uAngleJitter));
  const csA = cos(jAngle);
  const snA = sin(jAngle);
  const rot = vec2(cl.x.mul(csA).sub(cl.y.mul(snA)), cl.x.mul(snA).add(cl.y.mul(csA)));
  const corner = rot.mul(effScale);
  const viewPos = vec4(centerView.xyz.add(vec3(corner, 0.0)), 1.0);
  mat.vertexNode = cameraProjectionMatrix.mul(viewPos);

  // Bristly DRY-MEDIA / PENCIL dab, ported from 6.html's splatFrag (~748-765). The
  // quad uv is already rotated by aAngle and stretched along its length in the vertex
  // stage, so the local coordinate `r = uv*2-1` is exactly the reference's rotated,
  // aspect-corrected `r` — r.y runs along the stroke's LENGTH. d = dot(r,r) is the
  // squared radius; the stamp is a soft gaussian feather rather than a hard disc.
  const r = uv().sub(0.5).mul(2.0); // -1..1 in the stroke's own frame
  const seed = fract(sin(aCenter.x.mul(12.9898).add(aCenter.z.mul(78.233))).mul(43758.5453));
  // Dry-media banding: hash bands ACROSS the stroke length (floor(r.y*6)) per stamp
  // (floor(seed*91)) and modulate the squared radius — this is what makes a mark read
  // as a bristly pencil/chalk stroke, not a clean blob. Exactly 6.html lines 756-757.
  const bristle = fract(
    sin(r.y.mul(6.0).floor().mul(127.1).add(seed.mul(91.0).floor().mul(311.7))).mul(43758.5453),
  );
  const d = r.dot(r).mul(float(1.0).add(bristle.sub(0.5).mul(0.2)));

  // Fuller gaussian feather (6.html: smoothstep(1.0, 0.5, d) * 0.94). d>1 is the
  // implicit discard; smoothstep from 1→0.5 melts the edge so dense strokes blend
  // like drawn marks. alphaTest culls the empty rim (d≳1) so cores write clean depth.
  mat.opacityNode = smoothstep(float(1.0), float(0.5), d).mul(0.94);

  // Aerial perspective, two-step like 6.html (lines 768-771): first desaturate toward
  // grey (luminance), then wash toward the pale blue-violet aerial colour, so distant
  // strokes dissolve into luminous airy paper rather than a hard edge or grey soup.
  // The aerial colour matches palette.fog (= the linear value vec3(0.72,0.75,0.89)).
  // This depends ONLY on per-instance quantities (aColor and depth — depth is the
  // un-cornered centre Z, identical at all four quad corners), so the whole grade is
  // constant across the dab. Compute it once per VERTEX (4×/instance) and interpolate
  // a flat constant rather than re-evaluating the two mixes for every covered pixel —
  // the carpet is heavy overdraw, so this moves real ALU off the hot per-fragment path
  // while producing a bit-identical result.
  const fogCol = vec3(palette.fog.r, palette.fog.g, palette.fog.b);
  const air = smoothstep(uFogNear, uFogFar, depth);
  const lum = aColor.dot(vec3(0.299, 0.587, 0.114));
  const greyed = mix(aColor, vec3(lum, lum, lum), air.mul(0.35));
  mat.colorNode = vertexStage(mix(greyed, fogCol, air.mul(0.72)));

  return mat;
}

// A unit quad (corners in [-0.5, 0.5], uv in [0, 1]) shared as a template; each
// chunk copies these into its InstancedBufferGeometry so disposal is safe.
const QUAD = {
  position: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
  uv: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  index: new Uint16Array([0, 1, 2, 0, 2, 3]),
};

/**
 * Build an instanced-billboard geometry from per-instance centre/scale/colour
 * arrays. Used for both the terrain splat carpet and tree foliage. The caller
 * should set `.boundingSphere` to cover the instances (the quad template is tiny).
 */
export function buildSplatGeometry(
  centers: Float32Array,
  scales: Float32Array,
  colors: Float32Array,
  winds: Float32Array,
  angles: Float32Array,
  aspects: Float32Array,
): THREE.InstancedBufferGeometry {
  const ig = new THREE.InstancedBufferGeometry();
  ig.setAttribute('position', new THREE.BufferAttribute(QUAD.position.slice(), 3));
  ig.setAttribute('uv', new THREE.BufferAttribute(QUAD.uv.slice(), 2));
  ig.setIndex(new THREE.BufferAttribute(QUAD.index.slice(), 1));
  ig.setAttribute('aCenter', new THREE.InstancedBufferAttribute(centers, 3));
  ig.setAttribute('aScale', new THREE.InstancedBufferAttribute(scales, 1));
  ig.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
  ig.setAttribute('aWind', new THREE.InstancedBufferAttribute(winds, 1));
  ig.setAttribute('aAngle', new THREE.InstancedBufferAttribute(angles, 1));
  ig.setAttribute('aAspect', new THREE.InstancedBufferAttribute(aspects, 1));
  ig.instanceCount = scales.length;
  return ig;
}

// One splat layer: the six per-instance attribute arrays (the same contract
// buildSplatGeometry expects). `centers`/`colors` hold 3 floats per instance,
// the rest 1; all are consistent in implied instance count.
export interface SplatLayer {
  centers: Float32Array;
  scales: Float32Array;
  colors: Float32Array;
  winds: Float32Array;
  angles: Float32Array;
  aspects: Float32Array;
}

/**
 * Concatenate several splat layers into ONE InstancedBufferGeometry so a chunk's
 * whole painted field (terrain carpet + foliage + flowers + weeds + shore) draws
 * in a SINGLE draw call instead of one per layer. The attribute layout is byte-
 * for-byte identical to buildSplatGeometry — every instance keeps its exact
 * centre/scale/colour/wind/angle/aspect — so the render is visually unchanged;
 * this only collapses draw calls. Skips empty layers. Caller sets boundingSphere.
 */
export function buildSplatGeometryMerged(layers: SplatLayer[]): THREE.InstancedBufferGeometry {
  let total = 0;
  for (const l of layers) total += l.scales.length;

  const centers = new Float32Array(total * 3);
  const scales = new Float32Array(total);
  const colors = new Float32Array(total * 3);
  const winds = new Float32Array(total);
  const angles = new Float32Array(total);
  const aspects = new Float32Array(total);

  let o1 = 0; // running instance offset (scalar attributes)
  let o3 = 0; // running offset for the vec3 attributes
  for (const l of layers) {
    const n = l.scales.length;
    if (n === 0) continue;
    centers.set(l.centers, o3);
    colors.set(l.colors, o3);
    scales.set(l.scales, o1);
    winds.set(l.winds, o1);
    angles.set(l.angles, o1);
    aspects.set(l.aspects, o1);
    o1 += n;
    o3 += n * 3;
  }

  return buildSplatGeometry(centers, scales, colors, winds, angles, aspects);
}
