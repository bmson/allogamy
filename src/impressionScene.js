import * as THREE from 'three';

/* =====================================================================
   Allogamy — a crane over a watercolor meadow
   A therapeutic flight piece: you are a red-crowned crane gliding over an
   endless Monet-leaning watercolor landscape. Skim low and your wake stirs
   golden pollen off the meadow; where the grains settle, new flowers,
   grasses and lilies grow. There is nothing to win — only a landscape to
   slowly fill with bloom.

   The scene is split into modules:
     scene/config.js       world + GPU layout constants, Monet light
     scene/terrain.js      the endless height/biome field (seedable)
     scene/tileBuilder.js  paints one tile of strokes straight into its slot
     scene/crane.js        the crane's dabs + flight animation
     scene/blooms.js       pollen -> growing plants
     scene/shaders.js      splat / sky / watercolor post GLSL

   Performance architecture (why it stays smooth):
   · One shared interleaved layout (f32 pos+size+angle, u8 color+params) —
     ~27 bytes per stroke instead of 48, two uploads instead of eight.
   · Tiles build DIRECTLY into a persistent slot of the big buffers using a
     cached per-tile height grid (no per-stroke fbm stacks, no rebuild copy
     of the whole world when a tile streams in).
   · The depth sort is an O(n) counting sort over only the strokes that can
     matter: radius-culled AND behind-camera-culled, run every few frames.
   ===================================================================== */

import {
  TILE, GRID_R, FADE_OUT, FADE_IN, SORT_CULL_RADIUS, PER_TILE_CAP, NSLOTS, CAP,
  F_STRIDE, U_STRIDE, WATER_LEVEL,
  T_LEAF, T_FLY, LIGHT,
} from './scene/config.js';
import { mulberry32 } from './scene/noise.js';
import {
  heightAt, surfaceAt, setWorldSeed,
} from './scene/terrain.js';
import { buildTile } from './scene/tileBuilder.js';
import { buildCrane, initCraneStatic, updateCrane } from './scene/crane.js';
import { createBloomSystem } from './scene/blooms.js';
import { makeSplatGeometry, writeSplat } from './scene/splatBuffers.js';
import { splatVert, splatFrag, skyVert, skyFrag, quadVert, paintFrag } from './scene/shaders.js';

let DENSITY = 0.86;
buildTile.density = DENSITY;

// ---------------- renderer / pipeline ----------------
const renderer = new THREE.WebGLRenderer({
  antialias: false,
  alpha: false,
  stencil: false,
  powerPreference: 'high-performance',
});
const DPR = Math.min(devicePixelRatio, 1.0);
renderer.setPixelRatio(DPR);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 1400);

const skyMat = new THREE.ShaderMaterial({
  vertexShader: skyVert, fragmentShader: skyFrag,
  uniforms: {
    uSunDir: { value: LIGHT.clone() },
    uTime: { value: 0 },
    uDrift: { value: new THREE.Vector2(0, 0) },
  },
  side: THREE.BackSide, depthWrite: false,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(700, 28, 18), skyMat);
sky.frustumCulled = false;
scene.add(sky);

const windAngle = Math.PI * 0.22;
const uniforms = {
  uScale: { value: 1 },
  uTime: { value: 0 },
  uWind: { value: 1 },
  uWindDir: { value: new THREE.Vector2(Math.cos(windAngle), Math.sin(windAngle)) },
  uBirdXZ: { value: new THREE.Vector2(0, 0) },
  uBirdDir: { value: new THREE.Vector2(0, 1) },
  uBirdWake: { value: 0 },
  uCamXZ: { value: new THREE.Vector2(0, 0) },
  uFadeIn: { value: FADE_IN },
  uFadeOut: { value: FADE_OUT },
};
const splatMat = new THREE.ShaderMaterial({
  uniforms, vertexShader: splatVert, fragmentShader: splatFrag,
  transparent: true, depthWrite: false, depthTest: true,
});

let rtScene;
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const paintMat = new THREE.ShaderMaterial({
  vertexShader: quadVert, fragmentShader: paintFrag,
  uniforms: {
    tDiffuse: { value: null },
    uPx: { value: new THREE.Vector2() },
    uGrain: { value: 0.85 },
    uGlow: { value: 0.9 },
  },
  depthTest: false, depthWrite: false,
});
const paintScene = new THREE.Scene();
paintScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), paintMat));

function makeTargets() {
  const w = (innerWidth * DPR) | 0, h = (innerHeight * DPR) | 0;
  if (rtScene) rtScene.dispose();
  rtScene = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat,
  });
  paintMat.uniforms.uPx.value.set(1 / w, 1 / h);
}

// ---------------- world stroke pool: slots + sorted draw copy ----------------
// MF/MU hold every loaded tile in place (written once at build time). RF/RU
// (inside the geometry) receive the depth-sorted, culled copy for drawing.
const MF = new Float32Array(CAP * F_STRIDE);
const MU = new Uint8Array(CAP * U_STRIDE);
const MU32 = new Uint32Array(MU.buffer);          // 8 bytes -> 2 words per splat

const world = makeSplatGeometry(CAP, { dynamicF: true, dynamicU: true });
const RF = world.F;
const RU32 = new Uint32Array(world.U.buffer);
const points = new THREE.Points(world.geo, splatMat);
points.frustumCulled = false;
points.renderOrder = 1;
world.geo.setDrawRange(0, 0);
scene.add(points);

const order = new Uint32Array(CAP), sourceOrder = new Uint32Array(CAP), keys = new Float32Array(CAP);

const perfStats = {
  strokes: 0,
  visible: 0,
  tiles: 0,
  queued: 0,
  blooms: 0,
  pollenSpawned: 0,
  pollenSettled: 0,
  avgFrameMs: 16.7,
  lastTileMs: 0,
  lastSortMs: 0,
  sortInterval: 0,
  trailPower: 0,
};
window.__allogamyStats = perfStats;
// tiny debug hook for tests / tinkering (not used by the game itself)
window.__allogamyDebug = {
  heightAt, surfaceAt,
  teleport(x, z, clearance) {
    flight.x = x; flight.z = z;
    flight.y = surfaceAt(x, z) + (clearance ?? START_CLEARANCE);
  },
  sow(x, z) { blooms.queueSeed(x, z); },
  get flight() { return flight; },
};

// ---------------- tile manager ----------------
const loaded = new Map();      // key -> { slot, count, leafSources }
const genQueue = [];
const freeSlots = [];
for (let s = NSLOTS - 1; s >= 0; s--) freeSlots.push(s);
let curTX = NaN, curTZ = NaN;
let forceSort = false;
let leafDirty = false;
let strokeTotal = 0;
const key = (tx, tz) => tx + ',' + tz;

const activeLeafSources = [];

function setDesired(ctx, ctz) {
  const want = new Set();
  for (let dx = -GRID_R; dx <= GRID_R; dx++)
    for (let dz = -GRID_R; dz <= GRID_R; dz++)
      want.add(key(ctx + dx, ctz + dz));

  for (const [k, t] of loaded) {
    if (!want.has(k)) {
      freeSlots.push(t.slot);
      strokeTotal -= t.count;
      loaded.delete(k);
      leafDirty = true;
      forceSort = true;
    }
  }
  const queued = new Set(genQueue);
  const toAdd = [];
  for (const k of want) {
    if (loaded.has(k) || queued.has(k)) continue;
    const [tx, tz] = k.split(',').map(Number);
    toAdd.push({ k, d: Math.abs(tx - ctx) + Math.abs(tz - ctz) });
  }
  toAdd.sort((a, b) => a.d - b.d);
  for (const t of toAdd) genQueue.push(t.k);
}

function processQueue() {
  let made = 0;
  while (genQueue.length && made < 1) {
    const k = genQueue.shift();
    if (loaded.has(k)) continue;
    const [stx, stz] = k.split(',').map(Number);
    // stale entry: the crane has moved on since this was queued
    if (Math.max(Math.abs(stx - curTX), Math.abs(stz - curTZ)) > GRID_R) continue;
    const slot = freeSlots.pop();
    if (slot === undefined) { genQueue.unshift(k); break; }
    const buildStart = performance.now();
    const tile = buildTile(stx, stz, MF, MU, slot * PER_TILE_CAP);
    perfStats.lastTileMs = performance.now() - buildStart;
    loaded.set(k, { slot, count: tile.count, leafSources: tile.leafSources });
    strokeTotal += tile.count;
    leafDirty = true;
    forceSort = true;
    made++;
  }
  perfStats.queued = genQueue.length;
  if (leafDirty) {
    activeLeafSources.length = 0;
    for (const t of loaded.values()) {
      for (const s of t.leafSources) activeLeafSources.push(s);
    }
    leafDirty = false;
    perfStats.strokes = strokeTotal;
    perfStats.tiles = loaded.size;
    const stat = document.getElementById('stat');
    if (stat) stat.textContent = `${strokeTotal.toLocaleString()} strokes · ${loaded.size} tiles`;
  }
}

// ---------------- O(n) counting sort over the culled live set ----------------
const BUCKETS = 512;
const SORT_INTERVAL_ACTIVE = 6;
const SORT_INTERVAL_CALM = 10;
const counts = new Uint32Array(BUCKETS);
const starts = new Uint32Array(BUCKETS);
const viewDir = new THREE.Vector3();

function sortSplats() {
  const sortStart = performance.now();
  camera.getWorldDirection(viewDir);
  const vx = viewDir.x, vy = viewDir.y, vz = viewDir.z;
  const cx = uniforms.uCamXZ.value.x, cz = uniforms.uCamXZ.value.y;
  const camK = camera.position.x * vx + camera.position.y * vy + camera.position.z * vz;
  const cullSq = SORT_CULL_RADIUS * SORT_CULL_RADIUS;
  let min = Infinity, max = -Infinity;
  let visible = 0;
  for (const tile of loaded.values()) {
    const start = tile.slot * PER_TILE_CAP;
    const end = start + tile.count;
    for (let i = start; i < end; i++) {
      const j = i * F_STRIDE;
      const dx = MF[j] - cx, dz = MF[j + 2] - cz;
      if (dx * dx + dz * dz > cullSq) continue;
      const k = MF[j] * vx + MF[j + 1] * vy + MF[j + 2] * vz;
      if (k - camK < -26.0) continue;      // safely behind the camera
      keys[visible] = k;
      sourceOrder[visible] = i;
      visible++;
      if (k < min) min = k;
      if (k > max) max = k;
    }
  }
  if (visible === 0) {
    world.geo.setDrawRange(0, 0);
    perfStats.visible = 0;
    perfStats.lastSortMs = performance.now() - sortStart;
    return;
  }
  const inv = (BUCKETS - 1) / Math.max(max - min, 1e-6);
  counts.fill(0);
  for (let i = 0; i < visible; i++) counts[((keys[i] - min) * inv) | 0]++;
  let acc = 0;
  for (let b = BUCKETS - 1; b >= 0; b--) { starts[b] = acc; acc += counts[b]; }
  for (let i = 0; i < visible; i++) {
    const b = ((keys[i] - min) * inv) | 0;
    order[starts[b]++] = sourceOrder[i];
  }
  for (let i = 0; i < visible; i++) {
    const s = order[i];
    const sf = s * F_STRIDE, df = i * F_STRIDE;
    RF[df] = MF[sf]; RF[df + 1] = MF[sf + 1]; RF[df + 2] = MF[sf + 2];
    RF[df + 3] = MF[sf + 3]; RF[df + 4] = MF[sf + 4];
    const su = s * 2, du = i * 2;
    RU32[du] = MU32[su]; RU32[du + 1] = MU32[su + 1];
  }
  world.fb.clearUpdateRanges();
  world.fb.addUpdateRange(0, visible * F_STRIDE);
  world.fb.needsUpdate = true;
  world.ub.clearUpdateRanges();
  world.ub.addUpdateRange(0, visible * U_STRIDE);
  world.ub.needsUpdate = true;
  world.geo.setDrawRange(0, visible);
  perfStats.visible = visible;
  perfStats.lastSortMs = performance.now() - sortStart;
}

// ---------------- crane wake: shed leaves + stirred pollen ----------------
const WAKE_LEAF_COUNT = 120;
const WAKE_POLLEN_COUNT = 240;

function makeParticlePool(count) {
  const buf = makeSplatGeometry(count, { dynamicF: true, dynamicU: true });
  buf.geo.setDrawRange(0, count);
  const pts = new THREE.Points(buf.geo, splatMat);
  pts.frustumCulled = false;
  const state = [];
  for (let i = 0; i < count; i++) {
    state.push({
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      age: 0, life: 0, maxLife: 1, baseSize: 0.2, spin: 0, angle: 0,
      seed: false, settled: false,
    });
  }
  return { ...buf, pts, state };
}

const leafPool = makeParticlePool(WAKE_LEAF_COUNT);
leafPool.pts.renderOrder = 4;
scene.add(leafPool.pts);
const pollenPool = makeParticlePool(WAKE_POLLEN_COUNT);
pollenPool.pts.renderOrder = 5;
scene.add(pollenPool.pts);

const wakeRnd = mulberry32(0x7eaf1eaf);
const pollenRnd = mulberry32(0x90f10a11);
const wakeColor = new THREE.Color();
let leafCursor = 0;
let pollenCursor = 0;
let leafProbeCursor = 0;
let leafProbeTimer = 0;
let landscapeWake = 0;
let birdTrailAccumulator = 0;

function spawnWakeLeaf(source, power) {
  const i = leafCursor++ % WAKE_LEAF_COUNT;
  const s = leafPool.state[i];
  const side = wakeRnd() < 0.5 ? -1 : 1;
  const lateralX = -flight.flatForward.z;
  const lateralZ = flight.flatForward.x;
  const gust = 0.75 + power * 1.35;

  s.x = source.x + (wakeRnd() - 0.5) * 1.5;
  s.y = source.y + (wakeRnd() - 0.5) * 1.0;
  s.z = source.z + (wakeRnd() - 0.5) * 1.5;
  s.vx = flight.flatForward.x * (2.2 + wakeRnd() * 2.2) * gust
    + lateralX * side * (0.9 + wakeRnd() * 1.8) * gust
    + uniforms.uWindDir.value.x * (0.7 + wakeRnd() * 1.2);
  s.vy = 0.4 + wakeRnd() * 1.2 + power * 0.8;
  s.vz = flight.flatForward.z * (2.2 + wakeRnd() * 2.2) * gust
    + lateralZ * side * (0.9 + wakeRnd() * 1.8) * gust
    + uniforms.uWindDir.value.y * (0.7 + wakeRnd() * 1.2);
  s.age = 0;
  s.maxLife = 1.7 + wakeRnd() * 1.4 + power * 0.8;
  s.life = s.maxLife;
  s.baseSize = 0.24 + wakeRnd() * 0.28;
  s.spin = (wakeRnd() < 0.5 ? -1 : 1) * (2.8 + wakeRnd() * 5.5);
  s.angle = wakeRnd() * Math.PI;
  s.seed = false;
  s.settled = false;

  const hue = (source.hue + (wakeRnd() - 0.5) * 0.08 + 1) % 1;
  wakeColor.setHSL(hue, 0.46 + wakeRnd() * 0.22, 0.34 + wakeRnd() * 0.22);
  if (wakeRnd() < 0.32) wakeColor.lerp(new THREE.Color(0.78, 0.52, 0.18), 0.35 + wakeRnd() * 0.35);
  writeSplat(leafPool.F, leafPool.U, i, s.x, s.y, s.z,
    wakeColor.r, wakeColor.g, wakeColor.b, 0, s.angle,
    0.32 + wakeRnd() * 0.26, T_LEAF, wakeRnd(), 0.55 + wakeRnd() * 0.45);
  leafPool.ub.needsUpdate = true;
}

function spawnPollen(x, y, z, power, golden, seedChance) {
  const i = pollenCursor++ % WAKE_POLLEN_COUNT;
  const s = pollenPool.state[i];
  const side = pollenRnd() < 0.5 ? -1 : 1;
  const lateralX = -flight.flatForward.z;
  const lateralZ = flight.flatForward.x;

  s.x = x + (pollenRnd() - 0.5) * 2.1;
  s.y = y + (pollenRnd() - 0.5) * 0.8;
  s.z = z + (pollenRnd() - 0.5) * 2.1;
  s.vx = flight.flatForward.x * (1.1 + pollenRnd() * 2.0) * power
    + lateralX * side * (0.8 + pollenRnd() * 1.7)
    + uniforms.uWindDir.value.x * (1.2 + pollenRnd() * 1.8);
  s.vy = 0.2 + power * 0.35 + pollenRnd() * 0.3;
  s.vz = flight.flatForward.z * (1.1 + pollenRnd() * 2.0) * power
    + lateralZ * side * (0.8 + pollenRnd() * 1.7)
    + uniforms.uWindDir.value.y * (1.2 + pollenRnd() * 1.8);
  s.age = 0;
  s.maxLife = 3.2 + pollenRnd() * 1.6 + power * 0.5; // long enough to come back down
  s.life = s.maxLife;
  s.baseSize = 0.2 + pollenRnd() * 0.28 + power * 0.12;
  s.spin = (pollenRnd() < 0.5 ? -1 : 1) * (4.5 + pollenRnd() * 7.0);
  s.angle = pollenRnd() * Math.PI;
  s.seed = pollenRnd() < seedChance;
  s.settled = false;
  perfStats.pollenSpawned++;

  const mood = pollenRnd();
  if (golden || mood < 0.62) wakeColor.setHSL(0.128 + pollenRnd() * 0.035, 0.9, 0.62 + pollenRnd() * 0.16);
  else if (mood < 0.85) wakeColor.setHSL(0.07 + pollenRnd() * 0.035, 0.8, 0.58 + pollenRnd() * 0.12);
  else wakeColor.setHSL(0.985 + pollenRnd() * 0.025, 0.66, 0.54 + pollenRnd() * 0.12);
  wakeColor.lerp(new THREE.Color(0.92, 0.87, 0.6), 0.15);
  writeSplat(pollenPool.F, pollenPool.U, i, s.x, s.y, s.z,
    wakeColor.r, wakeColor.g, wakeColor.b, 0, s.angle,
    0.5 + pollenRnd() * 0.4, T_FLY, pollenRnd(), 0.1 + pollenRnd() * 0.3);
  pollenPool.ub.needsUpdate = true;
}

// pollen kicked straight off the meadow beneath the crane's wake — it rises
// out of the grass itself, swirls, and (usually) carries a viable grain
function spawnMeadowPollen(power, groundPower) {
  const side = pollenRnd() < 0.5 ? -1 : 1;
  const lateralX = -flight.flatForward.z;
  const lateralZ = flight.flatForward.x;
  const back = 1.6 + pollenRnd() * (3.6 + groundPower * 4.2);
  const wing = side * (0.3 + pollenRnd() * (1.6 + power * 1.3));
  const px = flight.x - flight.flatForward.x * back + lateralX * wing;
  const pz = flight.z - flight.flatForward.z * back + lateralZ * wing;
  const ground = surfaceAt(px, pz);
  spawnPollen(px, ground + 0.4 + pollenRnd() * 0.9, pz, 0.4 + power * 0.8, true, 0.75);
}

function emitBirdTrail(dt, clearance, groundPower) {
  if (reducedMotion) {
    birdTrailAccumulator = 0;
    return;
  }
  const turnEnergy = Math.min(1, Math.abs(flight.roll) / MAX_ROLL);
  const climbEnergy = Math.min(1, Math.abs(flight.pitch) / MAX_PITCH);
  const trailPower = THREE.MathUtils.clamp(0.18 + groundPower * 0.82 + turnEnergy * 0.16 + climbEnergy * 0.08, 0, 1);
  const rate = 4 + groundPower * groundPower * 52 + turnEnergy * 4;
  birdTrailAccumulator += dt * rate;
  perfStats.trailPower = trailPower;
  let emitted = 0;
  while (birdTrailAccumulator >= 1 && emitted < 5) {
    spawnMeadowPollen(trailPower, groundPower);
    birdTrailAccumulator -= 1;
    emitted++;
  }
  if (clearance > 82) birdTrailAccumulator = Math.min(birdTrailAccumulator, 0.35);
}

function updateParticles(pool, dt, isPollen, wakePower) {
  const wind = uniforms.uWindDir.value;
  const F = pool.F;
  let any = false;
  for (let i = 0; i < pool.state.length; i++) {
    const s = pool.state[i];
    const fo = i * F_STRIDE;
    if (s.life <= 0) {
      if (F[fo + 3] !== 0) { F[fo + 3] = 0; any = true; }
      continue;
    }
    any = true;
    s.age += dt;
    s.life -= dt;
    if (isPollen) {
      const flutter = Math.sin(s.age * 9.0 + s.spin);
      s.vx += (wind.x * 0.45 + flight.flatForward.x * wakePower * 0.28) * dt;
      s.vz += (wind.y * 0.45 + flight.flatForward.z * wakePower * 0.28) * dt;
      s.vy -= (0.85 + s.age * 0.3) * dt; // grains arc up, then truly come down
      s.x += (s.vx + flutter * 0.34) * dt;
      s.y += s.vy * dt;
      s.z += (s.vz + Math.cos(s.age * 7.0 + s.spin * 0.7) * 0.28) * dt;
      const ground = surfaceAt(s.x, s.z) + 0.5;
      if (s.y < ground) {
        s.y = ground;
        if (s.seed && !s.settled) {
          s.settled = true;
          perfStats.pollenSettled++;
          blooms.queueSeed(s.x, s.z);
        }
        s.life = Math.min(s.life, 0.26);
        s.vx *= 0.6; s.vz *= 0.6; s.vy = 0.04;
      }
    } else {
      s.vx += (wind.x * 0.75 + flight.flatForward.x * wakePower * 0.55) * dt;
      s.vz += (wind.y * 0.75 + flight.flatForward.z * wakePower * 0.55) * dt;
      s.vy -= (0.58 + s.age * 0.12) * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      const ground = surfaceAt(s.x, s.z) + 0.35;
      if (s.y < ground) {
        s.y = ground;
        s.vx *= 0.82; s.vz *= 0.82;
        s.vy = Math.max(0, -s.vy * 0.12);
        s.life = Math.min(s.life, 0.42);
      }
    }
    const inFade = THREE.MathUtils.smoothstep(s.age, 0, isPollen ? 0.12 : 0.18);
    const outFade = THREE.MathUtils.smoothstep(s.life, 0, isPollen ? 0.36 : 0.42);
    s.angle += s.spin * dt;
    F[fo] = s.x; F[fo + 1] = s.y; F[fo + 2] = s.z;
    F[fo + 3] = s.baseSize * inFade * outFade;
    F[fo + 4] = s.angle;
  }
  if (any) pool.fb.needsUpdate = true;
}

function updateLandscapeWake(dt) {
  const ground = surfaceAt(flight.x, flight.z);
  const clearance = flight.y - ground;
  const lowPass = 1 - THREE.MathUtils.smoothstep(clearance, 16, 46);
  const bankPush = 0.72 + Math.min(1, Math.abs(flight.roll) / MAX_ROLL) * 0.28;
  const targetWake = THREE.MathUtils.clamp(lowPass * bankPush, 0, 1);
  landscapeWake += (targetWake - landscapeWake) * (1 - Math.exp(-dt * 5.5));

  uniforms.uBirdXZ.value.set(flight.x, flight.z);
  uniforms.uBirdDir.value.set(flight.flatForward.x, flight.flatForward.z).normalize();
  uniforms.uBirdWake.value = landscapeWake;
  emitBirdTrail(dt, clearance, lowPass);

  leafProbeTimer -= dt;
  if (!reducedMotion && landscapeWake > 0.18 && leafProbeTimer <= 0 && activeLeafSources.length) {
    leafProbeTimer = 0.07 + wakeRnd() * 0.08;
    const radius = 15 + landscapeWake * 9;
    const radiusSq = radius * radius;
    const len = activeLeafSources.length;
    const start = leafProbeCursor % len;
    leafProbeCursor = (leafProbeCursor + 17) % len;
    let spawned = 0;
    for (let step = 0; step < len && spawned < 4; step++) {
      const source = activeLeafSources[(start + step * 13) % len];
      const dx = source.x - flight.x;
      const dz = source.z - flight.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > radiusSq) continue;
      const dy = Math.abs(source.y - flight.y);
      if (dy > 34) continue;
      const near = (1 - THREE.MathUtils.smoothstep(Math.sqrt(d2), 4, radius))
        * (1 - THREE.MathUtils.smoothstep(dy, 7, 34));
      if (near > 0.12 && wakeRnd() < near * 0.95) {
        spawnWakeLeaf(source, near * landscapeWake);
        spawned++;
      }
      const pollenChance = near * (0.6 + landscapeWake * 0.5);
      if (near > 0.08 && pollenRnd() < pollenChance) {
        spawnPollen(source.x, source.y, source.z, near * landscapeWake, false, 0.35);
      }
    }
  }

  updateParticles(leafPool, dt, false, landscapeWake);
  updateParticles(pollenPool, dt, true, landscapeWake);
}

// ---------------- the crane ----------------
const craneDabs = buildCrane();
const craneBuf = makeSplatGeometry(craneDabs.length, { dynamicF: true });
craneBuf.geo.setDrawRange(0, craneDabs.length);
initCraneStatic(craneDabs, craneBuf.F, craneBuf.U);
const cranePts = new THREE.Points(craneBuf.geo, splatMat);
cranePts.frustumCulled = false;
cranePts.renderOrder = 3;
scene.add(cranePts);

// ---------------- blooms: settled pollen becomes plants ----------------
const bloomsEl = () => document.getElementById('blooms');
let bloomsShown = -1;
const blooms = createBloomSystem(splatMat, (x, y, z, onWater) => {
  // a small golden shimmer where life takes root (seedChance 0 — celebration
  // sparkles must never seed again, or one grain would cascade forever)
  for (let i = 0; i < (onWater ? 2 : 3); i++) {
    spawnPollen(x, y + 0.4, z, 0.25, true, 0);
  }
});
blooms.points.renderOrder = 2;
scene.add(blooms.points);

// ---------------- flight + chase camera ----------------
const UP = new THREE.Vector3(0, 1, 0);
const MAX_ROLL = 0.62;
const MAX_PITCH = 0.42;
const MIN_CLEARANCE = 14;
const SOFT_FLOOR_CLEARANCE = 24;
const SOFT_CEILING_CLEARANCE = 96;
const MAX_CLEARANCE = 128;
const BASE_SPEED = 18;
const START_CLEARANCE = 38;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const flight = {
  x: 0,
  z: 18,
  y: surfaceAt(0, 18) + START_CLEARANCE,
  yaw: 0.12,
  pitch: -0.03,
  roll: 0,
  forward: new THREE.Vector3(),
  right: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0),
  flatForward: new THREE.Vector3(),
  flatRight: new THREE.Vector3(1, 0, 0),
  camPos: new THREE.Vector3(),
  lookTarget: new THREE.Vector3(),
  swing: 0,
  turnLead: 0,
  speedCue: 0,
  fovOffset: 0,
  clock: 0,
  motion: 1,
  wingPhase: 0,
  wingCadence: 0.34,
  wingPower: 0.4,
  wingFlex: 0.5,
  airSpeed: BASE_SPEED,
  speedTrim: 0,
  camYawOffset: 0,
  camYawTarget: 0,
  camPitchOffset: 0,
  camPitchTarget: 0,
};
const rollQuat = new THREE.Quaternion();
const cameraBack = new THREE.Vector3();
const cameraSide = new THREE.Vector3();
let cameraPrimed = false;

let lastInput = performance.now();
const keyState = { climb: false, dive: false, left: false, right: false };
const hasFlightInput = () => keyState.climb || keyState.dive || keyState.left || keyState.right;
function clearFlightKeys() {
  keyState.climb = false;
  keyState.dive = false;
  keyState.left = false;
  keyState.right = false;
}

function updateFlightBasis() {
  const cp = Math.cos(flight.pitch);
  flight.forward.set(
    Math.sin(flight.yaw) * cp,
    Math.sin(flight.pitch),
    Math.cos(flight.yaw) * cp
  ).normalize();
  flight.flatForward.set(Math.sin(flight.yaw), 0, Math.cos(flight.yaw)).normalize();
  flight.flatRight.set(Math.cos(flight.yaw), 0, -Math.sin(flight.yaw)).normalize();
  flight.right.copy(flight.flatRight);
  flight.up.copy(flight.forward).cross(flight.right).normalize();
  rollQuat.setFromAxisAngle(flight.forward, flight.roll);
  flight.right.applyQuaternion(rollQuat).normalize();
  flight.up.applyQuaternion(rollQuat).normalize();
}
updateFlightBasis();

const el = renderer.domElement;
el.style.touchAction = 'none';
let dragging = false, lastX = 0, lastY = 0;

el.addEventListener('pointerdown', (e) => {
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  lastInput = performance.now();
  el.setPointerCapture(e.pointerId);
});
el.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  flight.camYawTarget = THREE.MathUtils.clamp(flight.camYawTarget + (e.clientX - lastX) * 0.0032, -0.72, 0.72);
  flight.camPitchTarget = THREE.MathUtils.clamp(flight.camPitchTarget + (e.clientY - lastY) * 0.0024, -0.32, 0.34);
  lastX = e.clientX; lastY = e.clientY;
  lastInput = performance.now();
});
el.addEventListener('pointerup', () => { dragging = false; });
el.addEventListener('pointercancel', () => { dragging = false; });

// Scroll trims cruise speed without zooming the lens.
el.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey) return;
  flight.speedTrim = THREE.MathUtils.clamp(flight.speedTrim + (-e.deltaY) * 0.006, -5, 9);
  flight.camYawTarget = THREE.MathUtils.clamp(flight.camYawTarget + e.deltaX * 0.00045, -0.72, 0.72);
  lastInput = performance.now();
}, { passive: false });

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'arrowup') keyState.climb = true;
  else if (k === 's' || k === 'arrowdown') keyState.dive = true;
  else if (k === 'a' || k === 'arrowleft') keyState.right = true;
  else if (k === 'd' || k === 'arrowright') keyState.left = true;
  else return;
  e.preventDefault();
  lastInput = performance.now();
});
addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'arrowup') keyState.climb = false;
  else if (k === 's' || k === 'arrowdown') keyState.dive = false;
  else if (k === 'a' || k === 'arrowleft') keyState.right = false;
  else if (k === 'd' || k === 'arrowright') keyState.left = false;
  else return;
  e.preventDefault();
});
addEventListener('blur', clearFlightKeys);

function updateFlight(dt, now) {
  const inputActive = hasFlightInput();
  const rollIntent = (keyState.left ? 1 : 0) - (keyState.right ? 1 : 0);
  const pitchIntent = (keyState.climb ? 1 : 0) - (keyState.dive ? 1 : 0);
  let targetRoll = rollIntent * MAX_ROLL;
  let targetPitch = pitchIntent * MAX_PITCH;

  const currentGround = surfaceAt(flight.x, flight.z);
  const clearance = flight.y - currentGround;

  if (clearance < SOFT_FLOOR_CLEARANCE) {
    const lift = 1 - THREE.MathUtils.clamp(
      (clearance - MIN_CLEARANCE) / (SOFT_FLOOR_CLEARANCE - MIN_CLEARANCE),
      0, 1
    );
    targetPitch = Math.max(targetPitch, THREE.MathUtils.lerp(0.04, 0.18, lift));
  } else if (clearance > SOFT_CEILING_CLEARANCE) {
    const descend = THREE.MathUtils.clamp(
      (clearance - SOFT_CEILING_CLEARANCE) / (MAX_CLEARANCE - SOFT_CEILING_CLEARANCE),
      0, 1
    );
    targetPitch = Math.min(targetPitch, THREE.MathUtils.lerp(-0.04, -0.2, descend));
  }

  flight.roll += (targetRoll - flight.roll) * (1 - Math.exp(-dt * 2.15));
  flight.pitch += (targetPitch - flight.pitch) * (1 - Math.exp(-dt * 1.85));
  flight.yaw -= flight.roll * 0.95 * dt;
  updateFlightBasis();

  const cruise = BASE_SPEED + flight.speedTrim;
  const trade = flight.pitch < 0 ? 0.72 : 0.2;
  const targetAirSpeed = inputActive ? cruise : cruise * 0.62;
  const speedEase = targetAirSpeed > flight.airSpeed ? 1.85 : 1.45;
  flight.airSpeed += (targetAirSpeed - flight.airSpeed) * (1 - Math.exp(-dt * speedEase));
  const speed = flight.airSpeed * (1 - flight.pitch * trade);
  flight.x += flight.forward.x * speed * dt;
  flight.y += flight.forward.y * speed * dt;
  flight.z += flight.forward.z * speed * dt;
  flight.motion = THREE.MathUtils.clamp(flight.airSpeed / Math.max(cruise, 1), 0, 1);

  const ground = surfaceAt(flight.x, flight.z);
  const floor = ground + MIN_CLEARANCE;
  if (flight.y < floor) {
    flight.y = floor;
    flight.pitch = Math.max(flight.pitch, 0.04);
  } else if (inputActive && clearance < MIN_CLEARANCE + 4) {
    flight.y += (ground + MIN_CLEARANCE - flight.y) * (1 - Math.exp(-dt * 1.2));
    flight.pitch = Math.max(flight.pitch, 0.13);
  }
  const ceiling = ground + MAX_CLEARANCE;
  if (flight.y > ceiling) {
    flight.y = ceiling;
    flight.pitch = Math.min(flight.pitch, -0.06);
  }
  updateFlightBasis();

  flight.clock += dt;
  updateCamera(dt, now);
}

function updateCamera(dt, now) {
  const swingTarget = flight.roll / MAX_ROLL;
  flight.swing += (swingTarget - flight.swing) * (1 - Math.exp(-dt * 2.0));
  const s = flight.swing;
  const a = Math.min(1, Math.abs(s));

  const leadEase = Math.abs(swingTarget) > Math.abs(flight.turnLead) ? 2.4 : 1.45;
  flight.turnLead += (swingTarget - flight.turnLead) * (1 - Math.exp(-dt * leadEase));
  flight.speedCue += (flight.pitch / MAX_PITCH - flight.speedCue) * (1 - Math.exp(-dt * 1.35));
  const dive = Math.max(0, -flight.speedCue);
  const climb = Math.max(0, flight.speedCue);

  if (!dragging && now - lastInput > 1200) {
    flight.camYawTarget *= Math.exp(-dt * 0.35);
    flight.camPitchTarget *= Math.exp(-dt * 0.35);
  }
  flight.camYawOffset += (flight.camYawTarget - flight.camYawOffset) * (1 - Math.exp(-dt * 5.5));
  flight.camPitchOffset += (flight.camPitchTarget - flight.camPitchOffset) * (1 - Math.exp(-dt * 5.5));

  cameraBack.copy(flight.flatForward).multiplyScalar(-1).applyAxisAngle(UP, flight.camYawOffset).normalize();
  cameraSide.copy(flight.flatRight).applyAxisAngle(UP, flight.camYawOffset).normalize();

  const calm = 1 - Math.max(a, Math.abs(flight.speedCue));
  const breath = calm * 0.55;
  const bob = Math.sin(flight.clock * 0.62) * 0.8 * breath;
  const sway = Math.sin(flight.clock * 0.41 + 1.3) * 0.55 * breath;

  const lateral = -s * 5.8 + sway * 0.45;
  const backDist = 16.8 - a * 2.8 + dive * 2.8 - climb * 1.2;
  const rise = 19.5 - a * 0.8 + bob * 0.45 + dive * 0.6 - flight.camPitchOffset * 12;

  flight.camPos.set(flight.x, flight.y, flight.z)
    .addScaledVector(cameraBack, backDist)
    .addScaledVector(cameraSide, lateral)
    .addScaledVector(UP, rise);
  if (cameraPrimed) camera.position.lerp(flight.camPos, 1 - Math.exp(-dt * 3.8));
  else {
    camera.position.copy(flight.camPos);
    cameraPrimed = true;
  }

  const ahead = 11.2 - a * 2.9 + climb * 1.4;
  flight.lookTarget.set(flight.x, flight.y, flight.z)
    .addScaledVector(flight.forward, ahead)
    .addScaledVector(cameraSide, flight.turnLead * 2.2)
    .addScaledVector(UP, -1.0 + flight.camPitchOffset * 4.5);
  camera.up.copy(UP);
  camera.lookAt(flight.lookTarget);

  const fovTarget = dive * 5.0 - climb * 1.7;
  flight.fovOffset += (fovTarget - flight.fovOffset) * (1 - Math.exp(-dt * 2.0));
  const baseFov = camera.baseFov ?? (camera.baseFov = camera.fov);
  camera.fov = baseFov + flight.fovOffset;
  camera.updateProjectionMatrix();
  camera.rotateZ(flight.roll * 0.12);
  // point sizes must track the live fov, or strokes shrink during dives
  uniforms.uScale.value =
    renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));

  sky.position.copy(camera.position);
  skyMat.uniforms.uDrift.value.set(flight.x * 0.0011, flight.z * 0.0011);
  uniforms.uCamXZ.value.set(camera.position.x, camera.position.z);
}

// ---------------- UI ----------------
function newWorld() {
  setWorldSeed((Math.random() * 1e9) | 0);
  loaded.clear();
  genQueue.length = 0;
  freeSlots.length = 0;
  for (let s = NSLOTS - 1; s >= 0; s--) freeSlots.push(s);
  activeLeafSources.length = 0;
  strokeTotal = 0;
  curTX = NaN; curTZ = NaN;
  blooms.reset();
  flight.y = surfaceAt(flight.x, flight.z) + START_CLEARANCE;
  flight.pitch = Math.max(flight.pitch, -0.03);
  updateFlightBasis();
  forceSort = true;
}
const regenButton = document.getElementById('regen');
if (regenButton) regenButton.addEventListener('click', newWorld);

const densityInput = document.getElementById('density');
if (densityInput) {
  densityInput.addEventListener('input', (e) => {
    DENSITY = parseFloat(e.target.value);
    buildTile.density = DENSITY;
    loaded.clear();
    genQueue.length = 0;
    freeSlots.length = 0;
    for (let s = NSLOTS - 1; s >= 0; s--) freeSlots.push(s);
    activeLeafSources.length = 0;
    strokeTotal = 0;
    curTX = NaN; curTZ = NaN;
    forceSort = true;
  });
}
const grainInput = document.getElementById('impasto');
if (grainInput) grainInput.addEventListener('input', (e) => { paintMat.uniforms.uGrain.value = parseFloat(e.target.value); });
const glowInput = document.getElementById('glow');
if (glowInput) glowInput.addEventListener('input', (e) => { paintMat.uniforms.uGlow.value = parseFloat(e.target.value); });
const windInput = document.getElementById('wind');
if (windInput) windInput.addEventListener('input', (e) => { uniforms.uWind.value = parseFloat(e.target.value); });

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  makeTargets();
  uniforms.uScale.value =
    renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}
addEventListener('resize', onResize);
onResize();

// ---------------- main loop ----------------
let last = performance.now(), frame = 0;
function loop(now) {
  const frameMs = now - last;
  const dt = Math.min(frameMs / 1000, 0.05);
  last = now;
  perfStats.avgFrameMs += (frameMs - perfStats.avgFrameMs) * 0.04;
  if (!reducedMotion) uniforms.uTime.value += dt;
  skyMat.uniforms.uTime.value = uniforms.uTime.value;

  updateFlight(dt, now);
  updateLandscapeWake(dt);
  updateCrane(craneBuf.F, craneDabs, flight, now * 0.001, dt);
  craneBuf.fb.needsUpdate = true;
  blooms.update(now * 0.001);
  if (blooms.total !== bloomsShown) {
    bloomsShown = blooms.total;
    perfStats.blooms = bloomsShown;
    const elB = bloomsEl();
    if (elB) elB.textContent = bloomsShown === 0 ? '' : `${bloomsShown} bloom${bloomsShown === 1 ? '' : 's'}`;
  }

  // keep the tile grid centred on the crane
  const ctx = Math.floor(flight.x / TILE), ctz = Math.floor(flight.z / TILE);
  if (ctx !== curTX || ctz !== curTZ) { setDesired(ctx, ctz); curTX = ctx; curTZ = ctz; }
  processQueue();

  const sortInterval = Math.max(Math.abs(flight.swing), Math.abs(flight.speedCue)) > 0.25
    ? SORT_INTERVAL_ACTIVE
    : SORT_INTERVAL_CALM;
  perfStats.sortInterval = sortInterval;
  if (forceSort || frame % sortInterval === 0) { sortSplats(); forceSort = false; }
  if (frame % 60 === 0) renderer.domElement.dataset.perf = JSON.stringify(perfStats);
  frame++;

  renderer.setRenderTarget(rtScene);
  renderer.render(scene, camera);
  paintMat.uniforms.tDiffuse.value = rtScene.texture;
  renderer.setRenderTarget(null);
  renderer.render(paintScene, postCam);

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
