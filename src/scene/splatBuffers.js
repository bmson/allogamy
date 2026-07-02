import * as THREE from 'three';
import { F_STRIDE, U_STRIDE } from './config.js';

// Every splat buffer shares one interleaved layout:
//   float32, stride 5:  x, y, z, size, angle
//   uint8,  stride 8:  r, g, b, aspect, type, phase, flex, pad
// Two buffers per geometry instead of eight — half the upload bandwidth of
// the old one-attribute-per-property layout, and one memcpy per stream when
// the depth sort rewrites the draw order.

export function makeSplatGeometry(count, { dynamicF = false, dynamicU = false } = {}) {
  const F = new Float32Array(count * F_STRIDE);
  const U = new Uint8Array(count * U_STRIDE);
  const fb = new THREE.InterleavedBuffer(F, F_STRIDE);
  const ub = new THREE.InterleavedBuffer(U, U_STRIDE);
  if (dynamicF) fb.setUsage(THREE.DynamicDrawUsage);
  if (dynamicU) ub.setUsage(THREE.DynamicDrawUsage);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.InterleavedBufferAttribute(fb, 3, 0));
  geo.setAttribute('splatSize', new THREE.InterleavedBufferAttribute(fb, 1, 3));
  geo.setAttribute('splatAngle', new THREE.InterleavedBufferAttribute(fb, 1, 4));
  geo.setAttribute('splatColor', new THREE.InterleavedBufferAttribute(ub, 3, 0, true));
  geo.setAttribute('splatAspect', new THREE.InterleavedBufferAttribute(ub, 1, 3, true));
  geo.setAttribute('splatType', new THREE.InterleavedBufferAttribute(ub, 1, 4, false));
  geo.setAttribute('splatPhase', new THREE.InterleavedBufferAttribute(ub, 1, 5, true));
  geo.setAttribute('splatFlex', new THREE.InterleavedBufferAttribute(ub, 1, 6, true));
  return { geo, F, U, fb, ub };
}

/** Write one splat into interleaved arrays. Color channels are 0..1 floats. */
export function writeSplat(F, U, i, x, y, z, r, g, b, size, angle, aspect, type, phase, flex) {
  const fo = i * F_STRIDE;
  F[fo] = x; F[fo + 1] = y; F[fo + 2] = z; F[fo + 3] = size; F[fo + 4] = angle;
  const uo = i * U_STRIDE;
  U[uo] = Math.min(255, Math.max(0, r * 255) | 0);
  U[uo + 1] = Math.min(255, Math.max(0, g * 255) | 0);
  U[uo + 2] = Math.min(255, Math.max(0, b * 255) | 0);
  U[uo + 3] = Math.min(255, Math.max(0, aspect * 255) | 0);
  U[uo + 4] = type;
  U[uo + 5] = (phase * 255) & 255;
  U[uo + 6] = Math.min(255, Math.max(0, flex * 255) | 0);
}
