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
// DISTRIBUTION (the cover refinement): a uniform scatter reads as a flat hazy veil.
// Real skies clump into a few cumulus banks with open blue between, so we instead
// pull most puffs into a handful of CLUSTERS (bell falloff around group centres →
// dense core, soft fringe), leave a few lone STRAYS drifting in the gaps, and lift
// a fraction into a higher/smaller/fainter WISP layer for depth + parallax. Cover
// thus comes from CLUSTERING, not from cranking opacity — the blue still dominates.
// Recycling wraps the GROUP CENTRES (not individual puffs) so a formation rides as
// a rigid clump and never tears into a veil as it wraps around the bird.
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
  baseY?: number;       // centre height of the LOW cumulus band (world Y)
  spreadY?: number;     // vertical thickness of the low band
  size?: number;        // base sprite size (world u); scaled per-instance
  fogNear?: number;     // distance where puffs begin dissolving into the sky
  fogFar?: number;      // distance where puffs are fully sky (gone)
  windSpeed?: number;   // world u/s the whole field sails (with the scene wind)
  seed?: number;        // RNG seed for the scatter (reproducible)
  opacity?: number;     // per-puff alpha multiplier — keep low so blue dominates

  // --- distribution into discrete cumulus FORMATIONS -------------------------
  groups?: number;      // number of cumulus clusters scattered across the field
  clusterSpread?: number; // horizontal radius a group's puffs huddle within (world u)
  clusterSpreadY?: number; // vertical jitter of puffs within a group (world u)
  strays?: number;      // 0..1 fraction of puffs scattered loosely BETWEEN groups
                        // (a few lone wisps so gaps aren't perfectly empty)

  // --- a second, higher WISP layer for depth/parallax ------------------------
  highFrac?: number;    // 0..1 fraction of puffs lifted into the high wisp layer
  highY?: number;       // centre height of the high band (world Y)
  highSpreadY?: number; // vertical thickness of the high band
  highSize?: number;    // base sprite size for the high wisps (smaller, thinner)
  highOpacity?: number; // alpha multiplier for the high layer (fainter than the low)
}

const DEFAULTS: Required<VolumetricCloudsOpts> = {
  count: 360,
  radius: 1900,
  depth: 3200,
  baseY: 360,        // low band centre well above the bird's start (y~158) so the
  spreadY: 150,      // banks sit as billows over the horizon, not a smear on it
  size: 470,         // big soft puffs — the reference look is a few large billows
  fogNear: 950,      // hold puffs solid out to here, then dissolve into the haze
  fogFar: 3100,
  windSpeed: 6.5,
  seed: 1337,
  opacity: 0.36,     // thin: coverage comes from CLUSTERING, not from a flat veil

  groups: 8,         // a handful of distinct cumulus banks with open blue between
  clusterSpread: 330, // puffs huddle this tight → reads as one billowing formation
  clusterSpreadY: 110,
  strays: 0.14,      // a few lone wisps drifting in the gaps

  highFrac: 0.26,    // a quarter of the field lifted high for depth + parallax
  highY: 620,
  highSpreadY: 150,
  highSize: 360,     // smaller, thinner wisps up high
  highOpacity: 0.22, // fainter so the high layer reads as distant haze-cloud
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

// gaussian-ish [-1,1] from two uniforms — tighter packing toward a cluster centre
// than a flat random, so a group reads as a dense core with a soft falloff edge.
function bell(rng: () => number): number {
  return (rng() + rng() - 1);
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

  const uOpacity = uniform(o.opacity); // thin, wispy drifts — not a solid bank
  const uFogNear = uniform(o.fogNear);
  const uFogFar = uniform(o.fogFar);

  // --- per-instance scatter: discrete cumulus FORMATIONS ----------------------
  // The reference scatters puffs uniformly, which reads as a flat veil. Real skies
  // clump into a few cumulus banks with open blue between, so we instead:
  //   1. pick `groups` cluster CENTRES spread across the field (low band);
  //   2. huddle most puffs tightly around a centre (bell falloff → dense core,
  //      soft edge) so each group reads as one billowing formation;
  //   3. leave `strays` of them loose between groups (lone drifting wisps);
  //   4. lift `highFrac` of them into a higher, smaller, fainter WISP layer for
  //      depth + parallax.
  // Coverage thus comes from CLUSTERING, not from cranking opacity — the blue sky
  // still dominates in the gaps. Each puff carries a LOCAL offset from its group
  // centre (cgx/cgz) so recycling can wrap whole formations coherently (see update):
  // world pos = wrap(groupCentre) + localOffset.
  const N = o.count;
  const offsets = new Float32Array(N * 3);  // ABSOLUTE world x,y,z (rebuilt each frame)
  const local = new Float32Array(N * 3);    // per-puff offset from its group centre
  const params = new Float32Array(N * 3);   // scale, roll, opacityMul
  const groupOf = new Int32Array(N);        // which group each puff belongs to (-1 = stray)

  // group centres, in ABSOLUTE world space (wrapped around the bird each frame).
  const G = Math.max(1, o.groups);
  const gx = new Float32Array(G);
  const gz = new Float32Array(G);
  for (let g = 0; g < G; g++) {
    gx[g] = (rng() * 2 - 1) * o.radius;
    gz[g] = (rng() * 2 - 1) * o.depth;
  }

  for (let i = 0; i < N; i++) {
    const high = rng() < o.highFrac;
    const stray = rng() < o.strays;
    const bandY = high ? o.highY : o.baseY;
    const bandSpread = high ? o.highSpreadY : o.spreadY;

    // `local` holds, for grouped puffs, the OFFSET from the group centre; for
    // strays it holds an ABSOLUTE field position (group -1). Y is always absolute.
    let ox: number, oz: number, ay: number, g = -1;
    if (stray) {
      // a lone wisp: scattered loosely anywhere in the field (no group)
      ox = (rng() * 2 - 1) * o.radius;
      oz = (rng() * 2 - 1) * o.depth;
      ay = bandY + bell(rng) * bandSpread;
    } else {
      // huddle around a group centre; bell falloff → dense core, soft fringe.
      g = (rng() * G) | 0;
      const sp = high ? o.clusterSpread * 1.4 : o.clusterSpread; // high wisps spread wider/thinner
      ox = bell(rng) * sp;
      oz = bell(rng) * sp;
      ay = bandY + bell(rng) * (high ? o.highSpreadY : o.clusterSpreadY);
    }

    // size: mostly mid, a few big billows (rng*rng skews small). High wisps run smaller.
    const baseSize = high ? o.highSize : o.size;
    const scale = (rng() * rng() * 1.4 + 0.55) * (baseSize / o.size);
    const roll = rng() * Math.PI * 2;
    const opMul = high ? o.highOpacity / o.opacity : 1.0;

    local[i * 3] = ox; local[i * 3 + 1] = ay; local[i * 3 + 2] = oz;
    groupOf[i] = g;
    params[i * 3] = scale;
    params[i * 3 + 1] = roll;
    params[i * 3 + 2] = opMul;
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
  geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(params, 3));

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
  const prm = attribute('aParam', 'vec3');
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

    // per-instance opacity multiplier (high wisp layer is fainter than the low bank)
    const opMul = attribute('aParam', 'vec3').z;
    return vec4(col, alpha.mul(uOpacity).mul(opMul));
  });
  mat.colorNode = cloud();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1; // over the gradient dome (-2), the world (default 0) draws on top
  mesh.frustumCulled = false; // the field wraps the camera; never cull it

  // --- recycling --------------------------------------------------------------
  // Coherent-formation recycling. The whole field drifts on the wind, then we wrap
  // it around the bird so the flight is endless from any heading. To keep cumulus
  // banks INTACT (rather than tearing a group apart when one edge puff wraps), we
  // wrap the GROUP CENTRES, not the individual puffs: each group's puffs ride along
  // as a rigid clump (world pos = wrapped centre + the puff's fixed local offset).
  // Strays (group -1) carry an absolute position and wrap individually — they're
  // lone wisps so there's nothing to tear. Y is anchored to the world bands.
  const wind = new THREE.Vector3(-1, 0, -0.35).normalize();
  const wgx = new Float32Array(G); // wrapped group centre x this frame
  const wgz = new Float32Array(G);

  // wrap v into [centre-half, centre+half) by adding/subtracting whole spans.
  function wrapAround(v: number, centre: number, half: number): number {
    const span = half * 2;
    return v - span * Math.round((v - centre) / span);
  }

  return {
    mesh,
    update(dt, _t, camPos) {
      const wx = wind.x * o.windSpeed * dt;
      const wz = wind.z * o.windSpeed * dt;
      // drift + wrap each group centre around the bird (keeps a wide spread of banks)
      for (let g = 0; g < G; g++) {
        gx[g] = wrapAround(gx[g] + wx, camPos.x, o.radius);
        gz[g] = wrapAround(gz[g] + wz, camPos.z, o.depth);
        wgx[g] = gx[g];
        wgz[g] = gz[g];
      }
      for (let i = 0; i < N; i++) {
        const ix = i * 3;
        const g = groupOf[i];
        let x: number, z: number;
        if (g < 0) {
          // stray wisp: local[] is absolute; drift + wrap it on its own.
          x = wrapAround(local[ix] + wx, camPos.x, o.radius);
          z = wrapAround(local[ix + 2] + wz, camPos.z, o.depth);
          local[ix] = x; local[ix + 2] = z;
        } else {
          // grouped puff: rides its (already-wrapped) centre + fixed local offset.
          x = wgx[g] + local[ix];
          z = wgz[g] + local[ix + 2];
        }
        offsets[ix] = x;
        offsets[ix + 1] = local[ix + 1]; // Y stays anchored to its world band
        offsets[ix + 2] = z;
      }
      offAttr.needsUpdate = true;
    },
    uniforms: { opacity: uOpacity, fogNear: uFogNear, fogFar: uFogFar },
  };
}
