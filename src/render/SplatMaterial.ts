import * as THREE from 'three/webgpu';
import {
  attribute, uv, vec2, vec3, vec4, float, smoothstep, mix, modelViewMatrix,
  cameraProjectionMatrix, positionGeometry, time, sin, cos, fract, atan,
} from 'three/tsl';
import { palette } from './palette';
import { FOG_NEAR, FOG_FAR, WIND_STRENGTH } from '../config';

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
  // ON and a tight near-opaque core — so dense overlapping strokes melt into a
  // continuous painted surface without ever needing a per-frame sort (cheap, and
  // exactly how the reference achieves its soft painterly cohesion).
  mat.transparent = true;
  mat.depthWrite = true;
  mat.depthTest = true;
  mat.alphaTest = 0.04; // drop the empty rim so the cores still write clean depth

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
  const amp = aWind.mul(WIND_STRENGTH);
  const wind = vec3(gust.mul(amp), float(0.0), gust.mul(amp).mul(0.5));

  // Billboard: place the swayed centre in view space, then build the quad corner —
  // stretched along its length by aAspect, rotated by aAngle, sized by aScale.
  const centerView = modelViewMatrix.mul(vec4(aCenter.add(wind), 1.0));
  const cl = vec2(positionGeometry.x, positionGeometry.y.mul(aAspect));
  const csA = cos(aAngle);
  const snA = sin(aAngle);
  const rot = vec2(cl.x.mul(csA).sub(cl.y.mul(snA)), cl.x.mul(snA).add(cl.y.mul(csA)));
  const corner = rot.mul(aScale);
  const viewPos = vec4(centerView.xyz.add(vec3(corner, 0.0)), 1.0);
  mat.vertexNode = cameraProjectionMatrix.mul(viewPos);

  // Irregular notched leaf-clump silhouette (matched to the reference): a tight
  // feathered brush-stamp with a near-opaque interior and a thin painted rim that
  // blends. The notch is keyed to a per-stamp seed hashed from world position, so
  // no two stamps repeat and the field never reads as a grid of identical discs.
  const p = uv().sub(vec2(0.5, 0.5)).mul(2.0); // -1..1
  const rad = p.length();
  const ang = atan(p.y, p.x);
  const seed = fract(sin(aCenter.x.mul(12.9898).add(aCenter.z.mul(78.233))).mul(43758.5453)).mul(6.2831);
  const wob = float(0.80)
    .add(sin(ang.mul(5.0).add(seed)).mul(0.17))
    .add(sin(ang.mul(9.0).sub(seed.mul(1.7))).mul(0.07));
  mat.opacityNode = float(1.0).sub(smoothstep(wob.sub(0.12), wob, rad));

  // Flat painterly volume (NO fake sphere shading — the light is baked into aColor):
  // darken toward the rim, plus a grounding shadow across the lower belly of the stamp.
  const edge = smoothstep(wob.sub(0.30), wob, rad);
  const belly = smoothstep(float(0.1), float(1.0), rad).mul(p.y.mul(0.5).add(0.5).clamp(0.0, 1.0));
  const dab = float(1.0).sub(edge.mul(0.20)).mul(float(1.0).sub(belly.mul(0.22)));

  // Aerial perspective: dissolve FULLY into the cool haze with distance, so distant
  // hills, the streaming frontier, and every stroke all end in atmosphere — never a
  // hard edge. This dense, close haze is what unifies the palette into one painting.
  const depth = centerView.z.negate();
  const fogF = smoothstep(float(FOG_NEAR), float(FOG_FAR), depth);
  const fogCol = vec3(palette.fog.r, palette.fog.g, palette.fog.b);
  mat.colorNode = mix(aColor.mul(dab), fogCol, fogF);

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
