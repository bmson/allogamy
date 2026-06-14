import * as THREE from 'three/webgpu';
import {
  Fn, vec3, vec4, float, mix, smoothstep, uniform,
  cameraPosition, attribute, uv, texture,
  modelViewMatrix, cameraProjectionMatrix, vec2, positionGeometry, length,
} from 'three/tsl';
import { palette } from '../render/palette';

// =============================================================================
// LIVE CLOUDS — a faithful port of the reference CodePen "Live clouds" by
// DenDionigi (https://codepen.io/DenDionigi/pen/GRbGLgy), which is itself a fork
// of the canonical three.js `webgl_clouds` example (mrdoob).
//
// The reference is NOT a raymarched volume — it is a field of THOUSANDS of soft
// cloud-sprite BILLBOARDS (a 64x64 quad textured with a fuzzy cumulus puff,
// `cloud10.png`), scattered low and deep, that the camera FLIES FORWARD THROUGH
// continuously. Its look comes from three things, all reproduced here:
//
//   1. heaps of overlapping translucent puffs → a soft, billowing layered bank;
//   2. a fragment shader that fades each sprite's alpha as it gets very close to
//      the camera ( alpha *= pow(depth, 20) ) so you melt INTO clouds without
//      seeing hard quad intersections as you pass through them;
//   3. the whole field dissolving into the sky/fog colour with distance
//      ( mix(col, fog, smoothstep(near,far,depth)) ) so the bank reads as endless.
//
// Behaviour: the reference moves the camera through a static field and loops it.
// Here the BIRD already flies freely through the world, so instead we keep a fixed
// pool of billboards and RECYCLE them around the bird — any puff that falls behind
// is wrapped to the front of a box centred on the camera. The net effect is the
// same: you perpetually fly through a fresh, drifting cloud bank, from any heading,
// with real parallax. A slow wind also drifts the whole field so the clouds sail
// even when you hover.
//
// This is FAR cheaper than the previous raymarch (no per-pixel marching at all —
// just alpha-blended instanced quads), which suits this fill-rate-bound engine.
// House style: instanced MeshBasicNodeMaterial, TSL Fn/uniforms, billboarded in the
// vertex node, ported reference math in the colour node.
// =============================================================================

export interface VolumetricCloudsOpts {
  count?: number;       // number of cloud sprites in the recycled pool
  radius?: number;      // horizontal half-extent of the field around the bird (world u)
  depth?: number;       // how far ahead/behind the field reaches (the fly-through axis)
  baseY?: number;       // centre height of the cloud band (world Y)
  spreadY?: number;     // vertical thickness of the band
  size?: number;        // base sprite size (world u); scaled per-instance
  fogNear?: number;     // distance where puffs begin dissolving into the sky
  fogFar?: number;      // distance where puffs are fully sky (gone)
  windSpeed?: number;   // world u/s the whole field sails (with the scene wind)
  seed?: number;        // RNG seed for the scatter (reproducible)
}

const DEFAULTS: Required<VolumetricCloudsOpts> = {
  count: 320,
  radius: 1700,
  depth: 3000,
  baseY: 300,        // band centre a little above the bird's start (y~158) so the
  spreadY: 230,      // bank sits low across the horizon and the bird flies INTO it
  size: 440,         // big soft puffs — the reference look is a few large billows
  fogNear: 700,      // hold puffs solid out to here, then dissolve into the haze
  fogFar: 2900,
  windSpeed: 7.0,
  seed: 1337,
};

export interface VolumetricClouds {
  mesh: THREE.Mesh;
  update(dt: number, t: number, camPos: THREE.Vector3): void;
  uniforms: {
    opacity: ReturnType<typeof uniform>;
    fogNear: ReturnType<typeof uniform>;
    fogFar: ReturnType<typeof uniform>;
  };
}

// Tiny deterministic LCG so the scatter is reproducible across runs/machines.
function makeRng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a * 1103515245 + 12345) & 0x7fffffff;
    return a / 0x7fffffff;
  };
}

/**
 * Build the live cloud layer: a recycled pool of camera-facing soft-cumulus
 * billboards the bird flies through. Returns the mesh plus an `update(dt,t,camPos)`
 * that drifts the field on the wind and wraps puffs that fall behind the bird back
 * around to the front, so the bank is effectively infinite from any heading.
 */
export function makeVolumetricClouds(opts: VolumetricCloudsOpts = {}): VolumetricClouds {
  const o = { ...DEFAULTS, ...opts };
  const rng = makeRng(o.seed);

  const uOpacity = uniform(0.3); // thin, wispy drifts — not a solid bank
  const uFogNear = uniform(o.fogNear);
  const uFogFar = uniform(o.fogFar);

  // --- per-instance scatter ---------------------------------------------------
  // The reference scatters x in ±500, y biased LOW (-rand*rand*200-15), z 0..8000,
  // random roll, scale rand*rand*1.5+0.5 (mostly small puffs, a few big ones). We
  // keep that distribution shape, scaled to this world. aOffset holds an ABSOLUTE
  // WORLD position (the mesh stays at the origin), so `positionWorld` and the
  // camera→puff distance in the fragment node are true world quantities. update()
  // wraps the horizontal components into a box re-centred on the bird each frame.
  const N = o.count;
  const offsets = new Float32Array(N * 3); // ABSOLUTE world x,y,z of each puff
  const params = new Float32Array(N * 2);  // scale, roll

  for (let i = 0; i < N; i++) {
    const x = (rng() * 2 - 1) * o.radius;
    const z = (rng() * 2 - 1) * o.depth;
    // y spread around the band centre with a gentle downward bias (rand*rand skews
    // low), echoing the reference's -r*r*200 lean while still straddling baseY so the
    // bird flies THROUGH the band rather than always under it.
    const y = o.baseY + (0.5 - rng() * rng()) * o.spreadY * 2.0;
    const scale = (rng() * rng() * 1.6 + 0.5); // mostly small, a few big billows
    const roll = rng() * Math.PI * 2;
    offsets[i * 3] = x;
    offsets[i * 3 + 1] = y;
    offsets[i * 3 + 2] = z;
    params[i * 2] = scale;
    params[i * 2 + 1] = roll;
  }

  // A single quad; instanced N times. We billboard it in the vertex node.
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geo.index = quad.index;
  geo.attributes.position = quad.attributes.position;
  geo.attributes.uv = quad.attributes.uv;
  geo.instanceCount = N;
  const offAttr = new THREE.InstancedBufferAttribute(offsets, 3);
  offAttr.setUsage(THREE.DynamicDrawUsage); // updated each frame as the field wraps
  geo.setAttribute('aOffset', offAttr);
  geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(params, 2));

  // --- material ---------------------------------------------------------------
  // The ACTUAL CodePen/three.js sprite asset — mrdoob's `cloud10.png` fuzzy cumulus
  // puff — vendored to public/textures/. Base-URL aware so it resolves in dev ("/")
  // and in the GitHub-Pages build ("/allogamy/").
  const cloudTex = new THREE.TextureLoader().load(
    `${import.meta.env.BASE_URL}textures/cloud10.png`,
  );
  cloudTex.colorSpace = THREE.SRGBColorSpace;
  cloudTex.minFilter = THREE.LinearMipmapLinearFilter;
  cloudTex.magFilter = THREE.LinearFilter;
  cloudTex.generateMipmaps = true;

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = true; // sit behind solid terrain/bird, blend among themselves
  mat.fog = false;      // we do our own sky-blend (the painterly world has fog off)
  mat.side = THREE.DoubleSide;
  mat.blending = THREE.NormalBlending;

  // The sky tone the clouds dissolve into at distance — the project's luminous pale
  // horizon (NOT the reference's darker blue): keeps the bank married to this world's
  // bright Ghibli sky instead of importing the CodePen's cooler palette.
  const skyTone = vec3(palette.skyHorizon.r, palette.skyHorizon.g, palette.skyHorizon.b);

  // --- VERTEX: build a camera-facing billboard at the instance world position ---
  // aOffset is the puff's absolute world position (mesh sits at the origin). We build
  // the quad in VIEW space (camera-facing) at that point, rolled by aParam.y and
  // sized by aParam.x, then project. This is the equivalent of the reference's
  // per-plane matrix bake, but always facing the camera so it reads from any flight
  // heading (the reference's planes only ever faced +z toward its forward-flying cam).
  const off = attribute('aOffset', 'vec3');
  const prm = attribute('aParam', 'vec2');
  const scl = prm.x.mul(float(o.size));
  const roll = prm.y;
  const cr = roll.cos();
  const sr = roll.sin();
  // rolled quad corner in the sprite's own plane
  const corner = vec2(
    positionGeometry.x.mul(cr).sub(positionGeometry.y.mul(sr)),
    positionGeometry.x.mul(sr).add(positionGeometry.y.mul(cr)),
  ).mul(scl);
  // instance centre in view space, then offset along view-space x/y → faces camera.
  const centreView = modelViewMatrix.mul(vec4(off, 1.0));
  const billboardView = vec4(
    centreView.x.add(corner.x),
    centreView.y.add(corner.y),
    centreView.z,
    1.0,
  );
  mat.vertexNode = cameraProjectionMatrix.mul(billboardView);

  // --- FRAGMENT: reference cloud shader, ported to TSL -------------------------
  // distance from camera to this puff's CENTRE (world space). The reference used
  // gl_FragCoord.z/.w (eye-space depth, ~per-sprite); camera→puff-centre distance is
  // the equivalent per-sprite quantity and is robust under WebGPU. We read aOffset
  // (the puff's world position) rather than positionWorld because the billboard is
  // assembled in a custom vertexNode, so positionWorld wouldn't track it.

  const cloud = Fn(() => {
    const dist = length(attribute('aOffset', 'vec3').sub(cameraPosition)).toVar();
    const tex4 = texture(cloudTex, uv());
    const col = tex4.rgb.toVar();
    const alpha = tex4.a.toVar();

    // (2) DEPTH FADE near the camera. The reference does alpha *= pow(z,20) where z
    // is the (0..1) NDC depth, which crushes alpha for sprites very close to the
    // near plane. We reproduce the EFFECT — melt into clouds without hard quad
    // intersections — by fading alpha to 0 for puffs within ~one sprite of the
    // camera and ramping to full a little further out.
    const near = smoothstep(float(o.size * 0.08), float(o.size * 0.5), dist);
    alpha.mulAssign(near);

    // (3) SKY DISSOLVE with distance: mix the cloud toward the sky tone and let it
    // fade out, so the bank recedes into the luminous haze and never shows an edge.
    const fog = smoothstep(uFogNear, uFogFar, dist);
    col.assign(mix(col, skyTone, fog));
    alpha.mulAssign(float(1.0).sub(fog));

    return vec4(col, alpha.mul(uOpacity));
  });
  mat.colorNode = cloud();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1; // over the gradient dome (-2), the world (default 0) draws on top
  mesh.frustumCulled = false; // the field wraps the camera; never cull it

  // --- recycling --------------------------------------------------------------
  // Puffs live at ABSOLUTE world positions. Each frame we (a) drift them on the
  // wind, then (b) wrap their HORIZONTAL position into a box of half-extent
  // (radius, depth) re-centred on the bird — any puff that has fallen more than
  // `radius`/`depth` behind is teleported the same span ahead, so the bird always
  // has a full field around it no matter how far or which way it flies. Y is kept
  // absolute (the band stays at world `baseY`), wrapped within ±spreadY of it. The
  // bird thus perpetually flies into fresh puffs with true parallax — the same
  // endless fly-through the reference gets by looping a static field, but heading-
  // agnostic. The mesh stays at the origin; aOffset carries the world position.
  const wind = new THREE.Vector3(-1, 0, -0.35).normalize();

  // wrap v into [centre-half, centre+half) by adding/subtracting whole spans.
  function wrapAround(v: number, centre: number, half: number): number {
    const span = half * 2;
    return v - span * Math.round((v - centre) / span);
  }

  return {
    mesh,
    update(dt, _t, camPos) {
      const wx = wind.x * o.windSpeed * dt;
      const wy = wind.y * o.windSpeed * dt;
      const wz = wind.z * o.windSpeed * dt;
      for (let i = 0; i < N; i++) {
        const ix = i * 3;
        const x = wrapAround(offsets[ix] + wx, camPos.x, o.radius);
        const z = wrapAround(offsets[ix + 2] + wz, camPos.z, o.depth);
        // Y stays anchored to the world band at baseY (independent of camera height).
        const y = wrapAround(offsets[ix + 1] + wy, o.baseY, o.spreadY);
        offsets[ix] = x; offsets[ix + 1] = y; offsets[ix + 2] = z;
      }
      offAttr.needsUpdate = true;
    },
    uniforms: { opacity: uOpacity, fogNear: uFogNear, fogFar: uFogFar },
  };
}
