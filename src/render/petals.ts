import * as THREE from 'three/webgpu';
import {
  attribute, uv, vec2, vec3, vec4, float, smoothstep, mix, modelViewMatrix,
  cameraProjectionMatrix, positionGeometry, time, sin, cos, fract, mod,
  uniform, max, clamp, abs,
} from 'three/tsl';
import { palette } from './palette';
import { mulberry32 } from '../core/rng';
import { FOG_NEAR, FOG_FAR } from '../config';

// ── Drift ─────────────────────────────────────────────────────────────────
// The emotional centrepiece: a quiet, ever-present weather of airborne life that
// surrounds the bird wherever it flies. Petals, tiny leaves, luminous pollen
// motes and a few butterflies — the literal sense of "allogamy", life crossing
// the air. It is camera-anchored: a wrapping box (~120 m) centred on the camera,
// so the field is seamless and never seen to begin or end.
//
// ART: flat painterly brush-stamps, ALL light baked into per-instance colour,
// soft feathered dabs (the same language as the terrain/foliage splats). Sparse
// and unhurried — emotion over quantity.
//
// PERFORMANCE: one instanced draw for the whole motes/petals field and one tiny
// instanced draw for the butterflies. ALL motion lives in the VERTEX shader via
// the `time` node + a `uCamPos` uniform — no per-element CPU work per frame, the
// CPU only writes two vec3 uniforms. Counts are bounded.

// Half-extent of the wrap box around the camera (full box = 2 * HALF metres).
const BOX_HALF = 60;
const BOX = BOX_HALF * 2;

// Bounded population. Kept deliberately sparse — this should feel like the air
// is gently alive, not a blizzard.
const N_PETALS = 220; // flower petals (mild elongation, warm flora colours)
const N_LEAVES = 150; // tiny tumbling leaves (greens)
const N_POLLEN = 520; // luminous motes (small, faintly bright → catch the bloom)
const N_BUTTERFLIES = 7; // a handful, larger & brighter, wing-flap

export interface DriftOptions {
  /** Override the per-stream counts (e.g. to thin out on weak GPUs). */
  petals?: number;
  leaves?: number;
  pollen?: number;
  butterflies?: number;
  /** Master seed so the field is deterministic. */
  seed?: number;
}

export interface Drift {
  object: THREE.Object3D;
  update(camPos: THREE.Vector3, time: number): void;
  /** Scaffold: inject a puff of pollen near `pos` (future blow-to-spread gesture). */
  burst(pos: THREE.Vector3): void;
}

// A unit quad (corners in [-0.5, 0.5], uv in [0, 1]) — same template the splats
// use, copied per geometry so disposal is independent.
const QUAD = {
  position: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
  uv: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  index: new Uint16Array([0, 1, 2, 0, 2, 3]),
};

// Per-instance kind codes (drive flutter style + dab shape in the shader).
const KIND_PETAL = 0;
const KIND_LEAF = 1;
const KIND_POLLEN = 2;

// Shared uniforms (one set; both materials read them).
interface DriftUniforms {
  uCamPos: ReturnType<typeof uniform>;
  uBurst: ReturnType<typeof uniform>; // xyz = puff centre, w = strength (decays)
  uBurstT: ReturnType<typeof uniform>; // elapsed time captured at burst()
}

/**
 * Wrap an animated world position into the box centred on the camera, so the
 * field tiles seamlessly: as the bird flies, instances that fall out the back
 * reappear ahead. Returns a vec3 node (world space).
 */
function wrapToCamera(animated: any, uCamPos: any): any {
  // (animated - cam + HALF) mod BOX  →  [0, BOX); shift back to [-HALF, HALF)
  const rel = animated.sub(uCamPos).add(BOX_HALF);
  const wrapped = mod(mod(rel, BOX).add(BOX), BOX).sub(BOX_HALF); // positive modulo
  return wrapped.add(uCamPos);
}

/** Build the painterly drift material for petals / leaves / pollen motes. */
function makeMotesMaterial(u: DriftUniforms): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.fog = false; // fogged manually below (matches SplatMaterial)
  mat.transparent = false; // OPAQUE cutout → early-Z, cheap fill
  mat.depthWrite = true;
  mat.depthTest = true;
  mat.alphaTest = 0.4;

  const aHome = attribute('aHome', 'vec3'); // home offset inside the box
  const aScale = attribute('aScale', 'float'); // world size
  const aColor = attribute('aColor', 'vec3'); // baked colour
  const aSeed = attribute('aSeed', 'float'); // per-instance phase (0..1)
  const aKind = attribute('aKind', 'float'); // KIND_*
  const aAspect = attribute('aAspect', 'float'); // 1 = round; >1 = petal/leaf length

  const ph = aSeed.mul(6.2831); // per-instance phase
  const seedB = fract(aSeed.mul(91.7)).mul(6.2831);

  // ── motion (all in the vertex shader) ──────────────────────────────────
  // Gentle fall + lateral drift + a slow spiral, each instance on its own phase
  // and speed so nothing reads as a grid. Speeds are slow → unhurried.
  const fallSpeed = float(1.1).add(fract(aSeed.mul(13.1)).mul(0.9)); // m/s, varied
  const driftAmp = float(2.2).add(fract(aSeed.mul(7.3)).mul(2.0));
  const spiralR = float(0.9).add(fract(aSeed.mul(5.1)).mul(1.3));

  const tt = time;
  // descend (wrap handles the recycle); pollen drifts almost weightless
  const isPollen = aKind.equal(float(KIND_POLLEN));
  const fall = mix(fallSpeed, fallSpeed.mul(0.35), float(isPollen)); // pollen hangs
  const dy = tt.mul(fall).negate();

  // lateral wander: two slow sines on independent phases → a soft figure path
  const dx = sin(tt.mul(0.31).add(ph)).mul(driftAmp)
    .add(sin(tt.mul(0.17).add(seedB)).mul(driftAmp.mul(0.5)));
  const dz = cos(tt.mul(0.27).add(ph)).mul(driftAmp)
    .add(cos(tt.mul(0.13).add(seedB)).mul(driftAmp.mul(0.5)));

  // slow spiral (gives each mote a quiet orbit on top of the wander)
  const spin = tt.mul(0.6).add(ph);
  const sx = cos(spin).mul(spiralR);
  const sz = sin(spin).mul(spiralR);

  let animated: any = vec3(
    aHome.x.add(dx).add(sx),
    aHome.y.add(dy),
    aHome.z.add(dz).add(sz),
  );

  // ── burst scaffold: radial puff of pollen ──────────────────────────────
  // A decaying outward push from uBurst.xyz; only meaningfully affects pollen
  // (others get a faint nudge). Cost is a few ALU ops; off when strength = 0.
  const burstAge = max(tt.sub(u.uBurstT), float(0.0));
  const burstFade = clamp(float(1.0).sub(burstAge.mul(0.55)), 0.0, 1.0).mul(u.uBurst.w);
  // direction from puff centre to this instance's *home* (stable, cheap)
  const homeWorld = aHome.add(u.uCamPos); // approx world home (pre-wrap)
  const toI = homeWorld.sub(u.uBurst.xyz);
  const dist = toI.length().add(0.001);
  const within = smoothstep(float(14.0), float(2.0), dist); // near the puff only
  const pushAmt = burstFade.mul(within).mul(mix(float(2.0), float(7.0), float(isPollen)));
  const push = toI.div(dist).mul(pushAmt);
  // lift the puff slightly (pollen rises on a breath)
  animated = animated.add(vec3(push.x, push.y.add(pushAmt.mul(0.4)), push.z));

  // wrap the animated position into the camera-centred box
  const worldPos = wrapToCamera(animated, u.uCamPos);

  // ── flutter / spin of the stamp itself ─────────────────────────────────
  // petals & leaves tumble (oscillating screen-rotation + a width "flip" so they
  // read as flat things turning edge-on); pollen barely rotates.
  const flutter = sin(tt.mul(2.3).add(ph)).mul(0.9).add(tt.mul(0.7));
  const angle = mix(flutter, flutter.mul(0.15), float(isPollen));
  // edge-on flip: aspect width breathes with the tumble (flat-paper feel)
  const flip = abs(sin(tt.mul(1.7).add(seedB))).mul(0.7).add(0.3);
  const widthScale = mix(flip, float(1.0), float(isPollen));

  // ── billboard (camera-facing quad), matching SplatMaterial's construction ─
  const centerView = modelViewMatrix.mul(vec4(worldPos, 1.0));
  const cl = vec2(positionGeometry.x.mul(widthScale), positionGeometry.y.mul(aAspect));
  const csA = cos(angle);
  const snA = sin(angle);
  const rot = vec2(cl.x.mul(csA).sub(cl.y.mul(snA)), cl.x.mul(snA).add(cl.y.mul(csA)));
  const corner = rot.mul(aScale);
  const viewPos = vec4(centerView.xyz.add(vec3(corner, 0.0)), 1.0);
  mat.vertexNode = cameraProjectionMatrix.mul(viewPos);

  // ── soft analytic dab (round, feathered) — same look as the terrain splats ─
  const p = uv().sub(vec2(0.5, 0.5)).mul(2.0); // -1..1
  const rad = p.length();
  const wob = float(0.86)
    .add(sin(p.x.mul(8.0).add(ph)).mul(0.05))
    .add(sin(p.y.mul(6.0).sub(seedB)).mul(0.05));
  const edge = smoothstep(wob.sub(0.3), wob, rad);

  // ── baked colour + a fade as motes approach the camera so none "pop" in the
  // lens, plus the same aerial-perspective wash the splats use at distance. ──
  const dab = float(1.0).sub(edge.mul(0.18));
  const depth = centerView.z.negate();
  // soft near fade: hide the closest few metres so things appear out of the haze
  const nearFade = smoothstep(float(1.5), float(7.0), depth);
  // far wash into the air tone
  const fogF = smoothstep(float(FOG_NEAR), float(FOG_FAR), depth);
  const air = vec3(palette.air.r, palette.air.g, palette.air.b);
  const shaded = aColor.mul(dab);
  mat.colorNode = mix(shaded, air, fogF.mul(0.5));
  // fold the near fade into opacity so close motes dissolve (alphaTest culls them)
  mat.opacityNode = float(1.0).sub(edge).mul(nearFade);

  return mat;
}

/** Build the butterfly material: a 2-quad wing pair with a flapping fold. */
function makeButterflyMaterial(u: DriftUniforms): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.fog = false;
  mat.transparent = false;
  mat.depthWrite = true;
  mat.depthTest = true;
  mat.alphaTest = 0.4;
  mat.side = THREE.DoubleSide;

  const aHome = attribute('aHome', 'vec3');
  const aScale = attribute('aScale', 'float');
  const aColor = attribute('aColor', 'vec3');
  const aSeed = attribute('aSeed', 'float');
  const aWing = attribute('aWing', 'float'); // -1 = left wing, +1 = right wing

  const ph = aSeed.mul(6.2831);
  const tt = time;

  // ── wandering path: a gentle, looping flight (bigger & slower than motes) ──
  const wanderR = float(8.0).add(fract(aSeed.mul(3.7)).mul(6.0));
  const wx = sin(tt.mul(0.23).add(ph)).mul(wanderR)
    .add(sin(tt.mul(0.11).add(ph.mul(1.7))).mul(wanderR.mul(0.4)));
  const wz = cos(tt.mul(0.19).add(ph)).mul(wanderR)
    .add(cos(tt.mul(0.09).add(ph.mul(1.3))).mul(wanderR.mul(0.4)));
  // slow vertical bob + a very gentle settle so they never sink out of the box
  const wy = sin(tt.mul(0.37).add(ph)).mul(3.0);

  const animated = vec3(aHome.x.add(wx), aHome.y.add(wy), aHome.z.add(wz));
  const worldPos = wrapToCamera(animated, u.uCamPos);

  // ── wing flap: fold the outer edge of each wing up/down quickly ───────────
  const flap = sin(tt.mul(11.0).add(ph)); // fast wingbeat
  const fold = flap.mul(0.6); // how far the wing tips fold toward vertical

  // Build the wing quad in view space so it billboards toward the camera, then
  // bend the outer edge (positionGeometry.x on the far side of the hinge) by the
  // flap. aWing places the wing to one side of the body hinge.
  const centerView = modelViewMatrix.mul(vec4(worldPos, 1.0));
  // local quad: x spans 0..1 outward (hinge at x=-0.5), y is wing chord
  const lx = positionGeometry.x.add(0.5); // 0 at hinge .. 1 at wing tip
  const wingX = lx.mul(aWing); // mirror per wing
  const chord = positionGeometry.y;
  // fold: tip rises/falls in view-Y as it flaps (paper-wing turning)
  const liftY = lx.mul(fold);
  const corner = vec3(
    wingX.mul(aScale),
    chord.mul(aScale).add(liftY.mul(aScale)),
    liftY.mul(aScale).mul(0.6).negate(), // a little depth so the flap reads
  );
  const viewPos = vec4(centerView.xyz.add(corner), 1.0);
  mat.vertexNode = cameraProjectionMatrix.mul(viewPos);

  // ── soft wing dab: a rounded triangle-ish wing via uv falloff ────────────
  const pq = uv();
  // distance from the inner-bottom hinge, feathered outer edge
  const px = pq.x; // 0..1 across the wing length
  const py = pq.y.sub(0.5).mul(2.0); // -1..1 chord
  const wingMask = float(1.0)
    .sub(smoothstep(float(0.55), float(1.0), px)) // taper to the tip
    .mul(float(1.0).sub(smoothstep(float(0.5), float(1.0), abs(py)))); // chord falloff
  mat.opacityNode = wingMask;

  // baked colour, brighter toward the wing root (catch the bloom), with fog wash
  const lit = float(1.0).sub(px.mul(0.25));
  const depth = centerView.z.negate();
  const fogF = smoothstep(float(FOG_NEAR), float(FOG_FAR), depth);
  const air = vec3(palette.air.r, palette.air.g, palette.air.b);
  const shaded = aColor.mul(lit);
  mat.colorNode = mix(shaded, air, fogF.mul(0.5));

  return mat;
}

/**
 * Create the camera-anchored drift field. Instantiate once; add `.object` to the
 * scene and call `.update(camera.position, elapsed)` each frame.
 */
export function createDrift(opts: DriftOptions = {}): Drift {
  const nPetals = opts.petals ?? N_PETALS;
  const nLeaves = opts.leaves ?? N_LEAVES;
  const nPollen = opts.pollen ?? N_POLLEN;
  const nButter = opts.butterflies ?? N_BUTTERFLIES;
  const rnd = mulberry32((opts.seed ?? 0x9e3779b1) >>> 0);

  const group = new THREE.Group();
  group.frustumCulled = false; // it's always around the camera; never cull it

  // Shared uniforms.
  const u: DriftUniforms = {
    uCamPos: uniform(new THREE.Vector3()),
    uBurst: uniform(new THREE.Vector4(0, 0, 0, 0)),
    uBurstT: uniform(-1000),
  };

  // ── motes/petals/leaves: one merged instanced buffer ─────────────────────
  const total = nPetals + nLeaves + nPollen;
  const homes = new Float32Array(total * 3);
  const scales = new Float32Array(total);
  const colors = new Float32Array(total * 3);
  const seeds = new Float32Array(total);
  const kinds = new Float32Array(total);
  const aspects = new Float32Array(total);

  const c = new THREE.Color();
  let w = 0;
  const place = (kind: number) => {
    // home offset anywhere in the box (relative to camera; wrap keeps it tiling)
    homes[w * 3] = (rnd() - 0.5) * BOX;
    homes[w * 3 + 1] = (rnd() - 0.5) * BOX;
    homes[w * 3 + 2] = (rnd() - 0.5) * BOX;
    seeds[w] = rnd();
    kinds[w] = kind;

    if (kind === KIND_PETAL) {
      // warm flora petals — white / blossom-pink / soft violet / pale yellow
      const r = rnd();
      if (r < 0.4) c.copy(palette.flowerWhite);
      else if (r < 0.66) c.copy(palette.blossom);
      else if (r < 0.85) c.copy(palette.flowerLavender);
      else c.copy(palette.flowerYellow);
      c.offsetHSL((rnd() - 0.5) * 0.02, (rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.06);
      scales[w] = 0.5 + rnd() * 0.45;
      aspects[w] = 1.15 + rnd() * 0.25; // mild petal elongation
    } else if (kind === KIND_LEAF) {
      // tiny tumbling leaves — light-coupled greens (sunlit lime → cool green)
      const lit = rnd();
      const h = 0.30 - lit * 0.09 + (rnd() - 0.5) * 0.02;
      const s = 0.55 + (1 - lit) * 0.12;
      const l = 0.30 + lit * 0.34 + (rnd() - 0.5) * 0.06;
      c.setHSL(THREE.MathUtils.clamp(h, 0, 1), THREE.MathUtils.clamp(s, 0, 1),
        THREE.MathUtils.clamp(l, 0.1, 0.85));
      scales[w] = 0.45 + rnd() * 0.4;
      aspects[w] = 1.1 + rnd() * 0.3;
    } else {
      // luminous pollen mote — small & faintly bright so it just catches bloom
      c.copy(palette.flowerYellow).lerp(palette.flowerWhite, rnd() * 0.5);
      c.offsetHSL(0, 0, rnd() * 0.12); // a few lift toward white-gold
      scales[w] = 0.16 + rnd() * 0.16;
      aspects[w] = 1.0; // round
    }
    colors[w * 3] = c.r; colors[w * 3 + 1] = c.g; colors[w * 3 + 2] = c.b;
    w++;
  };
  for (let i = 0; i < nPetals; i++) place(KIND_PETAL);
  for (let i = 0; i < nLeaves; i++) place(KIND_LEAF);
  for (let i = 0; i < nPollen; i++) place(KIND_POLLEN);

  const motesGeo = new THREE.InstancedBufferGeometry();
  motesGeo.setAttribute('position', new THREE.BufferAttribute(QUAD.position.slice(), 3));
  motesGeo.setAttribute('uv', new THREE.BufferAttribute(QUAD.uv.slice(), 2));
  motesGeo.setIndex(new THREE.BufferAttribute(QUAD.index.slice(), 1));
  motesGeo.setAttribute('aHome', new THREE.InstancedBufferAttribute(homes, 3));
  motesGeo.setAttribute('aScale', new THREE.InstancedBufferAttribute(scales, 1));
  motesGeo.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
  motesGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  motesGeo.setAttribute('aKind', new THREE.InstancedBufferAttribute(kinds, 1));
  motesGeo.setAttribute('aAspect', new THREE.InstancedBufferAttribute(aspects, 1));
  motesGeo.instanceCount = total;
  // The quad template is tiny; give a huge bound so it's never frustum-culled
  // (the wrap keeps instances around the camera at all times anyway).
  motesGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const motesMesh = new THREE.Mesh(motesGeo, makeMotesMaterial(u));
  motesMesh.frustumCulled = false;
  motesMesh.renderOrder = 2; // after opaque world; alpha-tested so order is loose
  group.add(motesMesh);

  // ── butterflies: 2 wing-quads each, one merged instanced buffer ──────────
  const bCount = nButter * 2; // two wings per butterfly
  const bHomes = new Float32Array(bCount * 3);
  const bScales = new Float32Array(bCount);
  const bColors = new Float32Array(bCount * 3);
  const bSeeds = new Float32Array(bCount);
  const bWing = new Float32Array(bCount);

  let bw = 0;
  for (let i = 0; i < nButter; i++) {
    // a shared body home + seed for the pair, so both wings track together
    const hx = (rnd() - 0.5) * BOX;
    const hy = (rnd() - 0.5) * BOX;
    const hz = (rnd() - 0.5) * BOX;
    const seed = rnd();
    const scale = 1.4 + rnd() * 1.1; // larger than motes
    // bright wing colour — warm flora accents (orange / violet / blossom)
    const r = rnd();
    if (r < 0.4) c.copy(palette.orangeEye);
    else if (r < 0.7) c.copy(palette.flowerViolet);
    else c.copy(palette.blossom);
    c.offsetHSL((rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.05, rnd() * 0.06);
    for (let s = 0; s < 2; s++) {
      bHomes[bw * 3] = hx; bHomes[bw * 3 + 1] = hy; bHomes[bw * 3 + 2] = hz;
      bScales[bw] = scale;
      bColors[bw * 3] = c.r; bColors[bw * 3 + 1] = c.g; bColors[bw * 3 + 2] = c.b;
      bSeeds[bw] = seed;
      bWing[bw] = s === 0 ? -1 : 1; // left / right
      bw++;
    }
  }

  const bGeo = new THREE.InstancedBufferGeometry();
  bGeo.setAttribute('position', new THREE.BufferAttribute(QUAD.position.slice(), 3));
  bGeo.setAttribute('uv', new THREE.BufferAttribute(QUAD.uv.slice(), 2));
  bGeo.setIndex(new THREE.BufferAttribute(QUAD.index.slice(), 1));
  bGeo.setAttribute('aHome', new THREE.InstancedBufferAttribute(bHomes, 3));
  bGeo.setAttribute('aScale', new THREE.InstancedBufferAttribute(bScales, 1));
  bGeo.setAttribute('aColor', new THREE.InstancedBufferAttribute(bColors, 3));
  bGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(bSeeds, 1));
  bGeo.setAttribute('aWing', new THREE.InstancedBufferAttribute(bWing, 1));
  bGeo.instanceCount = bCount;
  bGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const bMesh = new THREE.Mesh(bGeo, makeButterflyMaterial(u));
  bMesh.frustumCulled = false;
  bMesh.renderOrder = 3;
  group.add(bMesh);

  // ── per-frame update: the ONLY CPU work is writing the camera-pos uniform ──
  // We also remember the latest engine `time` so burst() can timestamp itself on
  // the SAME clock the shader's `time` node reads — otherwise the puff's decay
  // (driven by time - uBurstT in the shader) would be wrong.
  let lastTime = 0;
  const update = (camPos: THREE.Vector3, t: number) => {
    (u.uCamPos.value as THREE.Vector3).copy(camPos);
    lastTime = t;
  };

  // ── burst scaffold: snapshot a puff so the shader animates it out + decays ──
  // Future "blow-to-spread-pollen" gesture calls this with a world position; the
  // shader pushes nearby pollen radially outward, fading over ~2 s. Strength is
  // stored in uBurst.w (a new burst simply overwrites the previous one).
  const burst = (pos: THREE.Vector3) => {
    const v = u.uBurst.value as THREE.Vector4;
    v.set(pos.x, pos.y, pos.z, 1.0); // strength 1 → decays in the shader
    (u.uBurstT as any).value = lastTime; // same clock as the shader's time node
  };

  const dispose = () => {
    motesGeo.dispose();
    (motesMesh.material as THREE.Material).dispose();
    bGeo.dispose();
    (bMesh.material as THREE.Material).dispose();
  };
  (group as any).dispose = dispose;

  return { object: group, update, burst };
}
