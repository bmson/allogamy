import * as THREE from 'three/webgpu';
import {
  attribute, uv, vec2, vec3, vec4, float, smoothstep, mix, modelViewMatrix,
  cameraProjectionMatrix, positionGeometry, time, sin, cos, texture, luminance,
} from 'three/tsl';
import { palette } from './palette';
import { makeSplatShapeTexture } from './textures';
import { FOG_NEAR, FOG_FAR } from '../config';

// Shared organic dab-shape mask (lumpy, non-circular).
const SHAPE_TEX = makeSplatShapeTexture();

// Splats are camera-facing instanced quads (the real Gaussian-splat primitive —
// THREE.Points can't be sized on WebGPU). Each instance carries a world centre,
// a world-space size, and a baked colour. The vertex node billboards the quad in
// view space; the fragment makes a round soft dab and hazes it with the same
// linear fog as the terrain so the horizon stays seamless.
//
// One shared material; per-instance data lives in the geometry. Works on both
// the WebGPU and WebGL2 backends.

export function makeSplatMaterial(): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.fog = false; // we fog manually below
  mat.transparent = false;
  mat.depthWrite = true;
  mat.alphaTest = 0.5;

  const aCenter = attribute('aCenter', 'vec3');
  const aScale = attribute('aScale', 'float');
  const aColor = attribute('aColor', 'vec3');
  const aWind = attribute('aWind', 'float');
  const aAngle = attribute('aAngle', 'float'); // stroke orientation (screen-space)
  const aAspect = attribute('aAspect', 'float'); // stroke width / length

  // Wind: slow traveling gusts ripple across the field, with a faster flutter on
  // top for leaf shimmer. Per-instance `aWind` scales it — ground grass barely
  // moves, canopy leaves move most, dirt/stone not at all.
  const gust = sin(aCenter.x.mul(0.045).add(aCenter.z.mul(0.05)).add(time.mul(0.85)));
  const flutter = sin(aCenter.x.mul(0.5).add(aCenter.y.mul(0.35)).add(time.mul(3.4)));
  const amp = aWind.mul(gust.mul(0.75).add(flutter.mul(0.25)));
  const wind = vec3(amp.mul(0.95), flutter.mul(aWind).mul(0.15), amp.mul(0.6));

  // Billboard brushstroke: place the (wind-swayed) centre in view space, then
  // build the quad corner — narrowed by aAspect (width/length), rotated by aAngle
  // to orient the stroke in the image plane, and sized by aScale. Always faces
  // the camera; distance attenuation is free from the projection.
  const centerView = modelViewMatrix.mul(vec4(aCenter.add(wind), 1.0));
  const cl = vec2(positionGeometry.x.mul(aAspect), positionGeometry.y);
  const csA = cos(aAngle);
  const snA = sin(aAngle);
  const rot = vec2(cl.x.mul(csA).sub(cl.y.mul(snA)), cl.x.mul(snA).add(cl.y.mul(csA)));
  const corner = rot.mul(aScale);
  const viewPos = vec4(centerView.xyz.add(vec3(corner, 0.0)), 1.0);
  mat.vertexNode = cameraProjectionMatrix.mul(viewPos);

  // The lumpy shape mask, stretched across the elongated quad → an organic
  // bristle stroke whose orientation is the quad's aAngle.
  const uvc = uv();
  mat.opacityNode = texture(SHAPE_TEX, uvc).x;
  // Per-dab dimension: each stroke is brighter at its core and darker toward the
  // rim, so the carpet reads as thousands of lit daubs, not flat colour.
  const rimD = uvc.sub(vec2(0.5, 0.5)).length();
  const dab = float(0.72).add(smoothstep(0.5, 0.1, rimD).mul(0.3));

  // Aerial perspective: with distance, desaturate toward grey then dissolve into
  // the pale lavender air — strokes end in atmosphere, never at a hard edge.
  const depth = centerView.z.negate();
  const fogF = smoothstep(float(FOG_NEAR), float(FOG_FAR), depth);
  const air = vec3(palette.air.r, palette.air.g, palette.air.b);
  const shaded = aColor.mul(dab); // per-dab rim shading
  const lum = luminance(shaded);
  const desat = mix(shaded, vec3(lum, lum, lum), fogF.mul(0.2));
  mat.colorNode = mix(desat, air, fogF.mul(0.5));

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
