import * as THREE from 'three/webgpu';
import {
  attribute, uv, vec2, vec3, vec4, float, smoothstep, mix, modelViewMatrix,
  cameraProjectionMatrix, positionGeometry, time, sin, cos, fract, mod,
  uniform, max, clamp, abs, pow, oneMinus,
} from 'three/tsl';
import { palette } from './palette';
import { mulberry32 } from '../core/rng';
import { uFogNear, uFogFar } from '../core/settings';

// ── Drift ─────────────────────────────────────────────────────────────────
// The emotional centrepiece: a quiet, ever-present weather of airborne life that
// surrounds the bird wherever it flies. Petals, tiny leaves, luminous pollen
// motes and a few butterflies — the literal sense of "allogamy", life crossing
// the air. It is camera-anchored: a wrapping box centred on the camera, so the
// field is seamless and never seen to begin or end.
//
// CURRENTLY UNWIRED: the sky drift was removed; this stays as a ready-to-enable
// GROUND-LEVEL drift (a meadow-height weather of petals/pollen rather than a
// full-height sky box) — hence the flattened vertical band below. `createDrift`
// / `Drift` keep their shape so a caller can re-add `.object` + `.update()`.
//
// ART: flat painterly brush-stamps, ALL light baked into per-instance colour,
// soft feathered dabs (the same language as the terrain/foliage splats). Sparse
// and unhurried — emotion over quantity.
//
// PERFORMANCE: one instanced draw for the whole motes/petals field and one tiny
// instanced draw for the butterflies. ALL motion lives in the VERTEX shader via
// the `time` node + a `uCamPos` uniform — no per-element CPU work per frame, the
// CPU only writes the uniforms. Counts are bounded; shared sub-expressions are
// computed once and reused so the per-vertex ALU stays lean.

// Half-extent of the wrap box around the camera, on the horizontal plane (full
// box = 2 * HALF metres). The field wraps in X/Z as the bird flies.
const BOX_HALF = 60;
const BOX = BOX_HALF * 2;
// Vertical band: ground-level drift lives in a SHALLOW slab around the camera
// instead of the full 120 m cube — petals and pollen ride the meadow air, not
// the sky. The slab still wraps so nothing is ever seen to begin or end.
const BAND_HALF = 14; // metres above/below the camera the drift occupies
const BAND = BAND_HALF * 2;

// Bounded population. Kept deliberately sparse — this should feel like the air
// is gently alive, not a blizzard.
// Deliberately few — the drift should add to the calm of the landscape, a
// barely-there weather of airborne life, never a snowstorm of confetti.
const N_PETALS = 170; // flower petals (mild elongation, warm flora colours)
const N_LEAVES = 130; // tumbling/spinning leaves (greens + a few autumn warms)
const N_POLLEN = 460; // luminous motes (small, faintly bright → catch the bloom)
const N_BUTTERFLIES = 7; // a handful, larger & brighter, wing-flap

// A couple of warm autumnal leaf tones (local — palette.ts is read-only). Rare,
// just enough to break the green into something painted rather than uniform.
const LEAF_AMBER = new THREE.Color('#d98a2b'); // sun-dried amber
const LEAF_RUST = new THREE.Color('#b8521f'); // turning rust

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

// Shared uniforms (one set; both materials read them). Typed against the
// concrete `UniformNode<type, value>` (Vector3 / Vector4 / number) rather than
// the bare `ReturnType<typeof uniform>`, which collapses to an unusable overload
// — the explicit node types are what keep the `.xyz` / `.w` swizzles available
// in the shader graph below.
interface DriftUniforms {
  uCamPos: THREE.UniformNode<'vec3', THREE.Vector3>; // camera world position
  uBurst: THREE.UniformNode<'vec4', THREE.Vector4>; // xyz = puff centre, w = strength (decays)
  uBurstT: THREE.UniformNode<'float', number>; // elapsed time captured at burst()
}

// Terse aliases for the two TSL node shapes the wrap helper passes around — a
// scalar (float) node and a vec3 node. Typing these (instead of `any`) keeps the
// fluent vector math available and lets the helper read like the rest of the
// graph.
type FNode = THREE.Node<'float'>;
type V3Node = THREE.Node<'vec3'>;

/**
 * Wrap an animated world position into the slab centred on the camera, so the
 * field tiles seamlessly: as the bird flies, instances that fall out the back
 * (or below) reappear ahead (or above). X/Z wrap on the wide BOX; Y wraps on the
 * shallow ground-level BAND. Returns a vec3 node (world space).
 */
function wrapToCamera(animated: V3Node, uCamPos: DriftUniforms['uCamPos']): V3Node {
  const rel = animated.sub(uCamPos); // position relative to the camera
  // positive modulo per axis: (rel + half) mod size → [0,size); shift to centre.
  const wrapAxis = (v: FNode, half: number, size: number): FNode =>
    mod(mod(v.add(half), size).add(size), size).sub(half);
  const wrapped = vec3(
    wrapAxis(rel.x, BOX_HALF, BOX),
    wrapAxis(rel.y, BAND_HALF, BAND),
    wrapAxis(rel.z, BOX_HALF, BOX),
  );
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

  // Explicit `<'vec3'>` / `<'float'>` type args: `attribute(name, type)` infers
  // its node type from the string param, which TS widens to `string` — losing the
  // `.x` / `.mul` fluent API. Pinning the literal restores the vector node type.
  const aHome = attribute<'vec3'>('aHome', 'vec3'); // home offset inside the box
  const aScale = attribute<'float'>('aScale', 'float'); // world size
  const aColor = attribute<'vec3'>('aColor', 'vec3'); // baked colour
  const aSeed = attribute<'float'>('aSeed', 'float'); // per-instance phase (0..1)
  const aKind = attribute<'float'>('aKind', 'float'); // KIND_*
  const aAspect = attribute<'float'>('aAspect', 'float'); // 1 = round; >1 = petal/leaf length

  // Per-instance phases — several decorrelated seeds so no two motes share a
  // gait. (fract of a big multiple is a cheap independent random in the shader.)
  const ph = aSeed.mul(6.2831); // primary phase
  const seedB = fract(aSeed.mul(91.7)).mul(6.2831); // secondary phase
  const seedC = fract(aSeed.mul(57.3)).mul(6.2831); // tertiary phase
  const hand = fract(aSeed.mul(311.7)).sub(0.5).sign(); // +1/-1 tumble handedness

  // Kind selectors (0/1 floats for branch-free mixing).
  const isPollen = float(aKind.equal(float(KIND_POLLEN)));
  const isLeaf = float(aKind.equal(float(KIND_LEAF)));
  const isPetal = float(aKind.equal(float(KIND_PETAL)));

  const tt = time;

  // ── shared wind field ───────────────────────────────────────────────────
  // One slow, low-frequency breeze that EVERYTHING leans into together, so the
  // drift reads as a single body of moving air rather than independent confetti.
  // Two octaves: a long swell + a quicker gust riding on it, plus a faint spatial
  // term (home.x/z) so distant motes lag the near ones — the wind has a front.
  const windPhase = aHome.x.mul(0.018).add(aHome.z.mul(0.013));
  const gust = sin(tt.mul(0.21).add(windPhase))
    .add(sin(tt.mul(0.071).add(windPhase.mul(0.5))).mul(0.6))
    .mul(0.6); // -ish [-1,1] breeze strength
  // prevailing direction (gentle, mostly +x with a little +z) modulated by gust
  const windX = gust.mul(3.0).add(0.6);
  const windZ = sin(tt.mul(0.053).add(windPhase.mul(0.7))).mul(1.6);

  // ── per-kind fall + buoyancy ─────────────────────────────────────────────
  // Petals sink lazily, leaves a touch faster (heavier, more positive tumble),
  // pollen is near-weightless and even rises a little on the breath of the gust.
  const fallBase = float(0.85).add(fract(aSeed.mul(13.1)).mul(0.7)); // m/s, varied
  const fall = fallBase
    .mul(mix(float(1.0), float(1.25), isLeaf)) // leaves fall a little faster
    .mul(mix(float(1.0), float(0.18), isPollen)); // pollen barely descends
  // leaves & petals "flutter-fall": vertical speed pulses as they pitch, so they
  // hang and dive instead of sinking at a constant rate (the classic leaf gait).
  const flutterFall = sin(tt.mul(1.6).add(ph)).mul(0.55).mul(oneMinus(isPollen));
  const buoy = isPollen.mul(sin(tt.mul(0.2).add(seedB)).mul(0.4)); // pollen rides air
  const dy = tt.mul(fall).negate().add(flutterFall.div(1.6)).add(buoy);

  // ── lateral wander: gust + two decorrelated swirls ────────────────────────
  // The breeze carries everyone; on top, each mote traces its own slow loop so
  // the field shimmers with independent life inside the shared current.
  const driftAmp = float(1.6).add(fract(aSeed.mul(7.3)).mul(1.8));
  const dx = windX
    .add(sin(tt.mul(0.33).add(ph)).mul(driftAmp))
    .add(sin(tt.mul(0.19).add(seedB)).mul(driftAmp.mul(0.5)));
  const dz = windZ
    .add(cos(tt.mul(0.29).add(ph)).mul(driftAmp))
    .add(cos(tt.mul(0.15).add(seedC)).mul(driftAmp.mul(0.5)));

  // ── helical drift: a quiet orbit on top, tighter & faster for leaves which
  // corkscrew as they spin, looser for lazy petals. ─────────────────────────
  const spiralR = float(0.6).add(fract(aSeed.mul(5.1)).mul(0.9))
    .mul(mix(float(1.0), float(1.5), isLeaf));
  const spin = tt.mul(mix(float(0.5), float(0.95), isLeaf)).mul(hand).add(ph);
  const sx = cos(spin).mul(spiralR);
  const sz = sin(spin).mul(spiralR);

  const base = vec3(
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
  const pushAmt = burstFade.mul(within).mul(mix(float(2.0), float(7.0), isPollen));
  const push = toI.div(dist).mul(pushAmt);
  // lift the puff slightly (pollen rises on a breath)
  const animated = base.add(vec3(push.x, push.y.add(pushAmt.mul(0.4)), push.z));

  // wrap the animated position into the camera-centred slab
  const worldPos = wrapToCamera(animated, u.uCamPos);

  // ── flutter / tumble of the stamp itself ───────────────────────────────
  // A flat thing turning in the air reads from two motions on the billboard:
  //   • spin  — the dab rotates in the screen plane (its silhouette turns).
  //   • pitch — its projected WIDTH breathes through zero as it goes edge-on,
  //             so it appears to flip face↔edge like real paper.
  // Leaves do this hard and fast (end-over-end tumble); petals only sway and
  // flutter lazily; pollen is a near-still round speck.
  //
  // continuous screen-spin: leaves whirl, petals merely rock back and forth.
  const leafSpin = tt.mul(2.1).mul(hand).add(ph) // leaves keep turning
    .add(sin(tt.mul(3.3).add(seedB)).mul(0.4)); // with a jittery wobble
  const petalSway = sin(tt.mul(1.3).add(ph)).mul(0.7) // petals just sway
    .add(sin(tt.mul(0.5).add(seedC)).mul(0.4));
  const angle = mix(petalSway, leafSpin, isLeaf).mul(oneMinus(isPollen));

  // pitch flip: the width factor swings through ~0 so the dab goes edge-on.
  // signed cosine for petals/leaves so they momentarily vanish at the edge
  // (a flat plane seen edge-on has no area) — leaves flip fastest.
  const pitchRate = mix(float(1.4), float(2.6), isLeaf);
  const pitch = cos(tt.mul(pitchRate).add(seedB));
  // keep a sliver of width at the edge (0.12) so it never fully disappears and
  // the alpha-test cutout doesn't strobe; pollen stays perfectly round (1.0).
  const flatWidth = abs(pitch).mul(0.88).add(0.12);
  const widthScale = mix(flatWidth, float(1.0), isPollen);
  // face-on factor → drives a brightness catch-the-light below (face glints).
  const faceOn = abs(pitch);

  // ── billboard (camera-facing quad), matching SplatMaterial's construction ─
  const centerView = modelViewMatrix.mul(vec4(worldPos, 1.0));
  const cl = vec2(positionGeometry.x.mul(widthScale), positionGeometry.y.mul(aAspect));
  const csA = cos(angle);
  const snA = sin(angle);
  const rot = vec2(cl.x.mul(csA).sub(cl.y.mul(snA)), cl.x.mul(snA).add(cl.y.mul(csA)));
  const corner = rot.mul(aScale);
  const viewPos = vec4(centerView.xyz.add(vec3(corner, 0.0)), 1.0);
  mat.vertexNode = cameraProjectionMatrix.mul(viewPos);

  // ── soft analytic dab — a painterly brush-stamp, shaped per kind ──────────
  // Pollen: a round feathered speck. Petal: a soft teardrop, fuller at the base.
  // Leaf: a pointed ovoid (tapered to a tip), so its silhouette reads as a leaf
  // even at a glance. All built from the same -1..1 uv, branch-free via mixes.
  const p = uv().sub(vec2(0.5, 0.5)).mul(2.0); // -1..1
  // brush wobble — a little hand-painted irregularity on the rim
  const wob = float(0.84)
    .add(sin(p.x.mul(7.0).add(ph)).mul(0.05))
    .add(sin(p.y.mul(5.0).sub(seedB)).mul(0.05));
  // tip taper for petal/leaf: narrow the dab toward the +y end (the "tip"), more
  // for leaves than petals; pollen keeps full width (taper = 0).
  const along = p.y.mul(0.5).add(0.5); // 0 at base .. 1 at tip
  const taperAmt = mix(mix(float(0.0), float(0.35), isPetal), float(0.7), isLeaf);
  const widthAtY = oneMinus(along.mul(taperAmt));
  const px = abs(p.x).div(max(widthAtY, float(0.05)));
  const rad = vec2(px, p.y).length();
  const edge = smoothstep(wob.sub(0.34), wob, rad);
  // leaf midrib: a faint darker crease down the centre line (painted, not lit).
  const midrib = oneMinus(smoothstep(float(0.0), float(0.16), abs(p.x))).mul(isLeaf).mul(0.18);

  // ── baked colour + a fade as motes approach the camera so none "pop" in the
  // lens, plus the same aerial-perspective wash the splats use at distance. ──
  // catch-the-light: when a flat dab swings face-on (faceOn → 1) it briefly
  // glints; edge-on it dims. A quiet shimmer that makes the tumble feel sunlit.
  // Pollen gets a small steady self-glow instead (it should always catch bloom).
  const tumbleGlint = mix(float(0.6), float(1.22), pow(faceOn, float(1.5)));
  const glint = mix(float(1.12), tumbleGlint, oneMinus(isPollen));
  const dab = oneMinus(edge.mul(0.18)).sub(midrib);
  const depth = centerView.z.negate();
  // soft near fade: hide the closest few metres so things appear out of the air
  // rather than snapping into the lens (close billboards read as ugly streaks).
  const nearFade = smoothstep(float(1.5), float(7.0), depth);
  // soft far fade: dissolve instances at the back of the wrap box so the seam at
  // the slab edge melts into the air instead of popping as the bird flies. Tied
  // to the horizontal box extent (a touch under BOX_HALF) so it's always covered.
  const farFade = oneMinus(smoothstep(float(BOX_HALF * 0.72), float(BOX_HALF), depth));
  // far wash toward the air tone (live fog uniforms, same graph the splats use).
  const fogF = smoothstep(uFogNear, uFogFar, depth);
  const air = vec3(palette.air.r, palette.air.g, palette.air.b);
  const shaded = aColor.mul(dab).mul(glint);
  mat.colorNode = mix(shaded, air, fogF.mul(0.5));
  // fold both fades into opacity so close + far motes dissolve (alphaTest culls
  // them once they drop below the cutout — no hard edges, no per-frame sort).
  mat.opacityNode = oneMinus(edge).mul(nearFade).mul(farFade);

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

  const aHome = attribute<'vec3'>('aHome', 'vec3');
  const aScale = attribute<'float'>('aScale', 'float');
  const aColor = attribute<'vec3'>('aColor', 'vec3');
  const aSeed = attribute<'float'>('aSeed', 'float');
  const aWing = attribute<'float'>('aWing', 'float'); // -1 = left wing, +1 = right wing

  const ph = aSeed.mul(6.2831);
  const tt = time;

  // ── wandering path: a gentle, looping flight (bigger & slower than motes) ──
  const wanderR = float(8.0).add(fract(aSeed.mul(3.7)).mul(6.0));
  const wx = sin(tt.mul(0.23).add(ph)).mul(wanderR)
    .add(sin(tt.mul(0.11).add(ph.mul(1.7))).mul(wanderR.mul(0.4)));
  const wz = cos(tt.mul(0.19).add(ph)).mul(wanderR)
    .add(cos(tt.mul(0.09).add(ph.mul(1.3))).mul(wanderR.mul(0.4)));
  // slow vertical bob — kept inside the shallow ground band so butterflies stay
  // at meadow height rather than climbing out of the slab (the wrap handles the
  // rest, but a smaller bob keeps them visibly skimming the flowers).
  const wy = sin(tt.mul(0.37).add(ph)).mul(BAND_HALF * 0.55);

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

  // baked colour, brighter toward the wing root (catch the bloom), with fog wash
  const lit = float(1.0).sub(px.mul(0.25));
  const depth = centerView.z.negate();
  // same near/far dissolve as the motes so butterflies fade in/out of the slab
  // edges instead of popping, and never streak right in the lens.
  const nearFade = smoothstep(float(2.0), float(8.0), depth);
  const farFade = oneMinus(smoothstep(float(BOX_HALF * 0.72), float(BOX_HALF), depth));
  const fogF = smoothstep(uFogNear, uFogFar, depth);
  const air = vec3(palette.air.r, palette.air.g, palette.air.b);
  const shaded = aColor.mul(lit);
  mat.colorNode = mix(shaded, air, fogF.mul(0.5));
  mat.opacityNode = wingMask.mul(nearFade).mul(farFade);

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
    // home offset relative to the camera; the wrap keeps it tiling seamlessly.
    // X/Z fill the wide box, Y fills only the shallow ground-level band so the
    // drift hugs meadow height instead of a full-height sky cube.
    homes[w * 3] = (rnd() - 0.5) * BOX;
    homes[w * 3 + 1] = (rnd() - 0.5) * BAND;
    homes[w * 3 + 2] = (rnd() - 0.5) * BOX;
    seeds[w] = rnd();
    kinds[w] = kind;

    if (kind === KIND_PETAL) {
      // warm flora petals — white / blossom-pink / soft violet / pale yellow, plus
      // an occasional warm coral and a cool sky-blue so the drift carries a fuller
      // wildflower spectrum rather than three repeated tints.
      const r = rnd();
      if (r < 0.34) c.copy(palette.flowerWhite);
      else if (r < 0.56) c.copy(palette.blossom);
      else if (r < 0.74) c.copy(palette.flowerLavender);
      else if (r < 0.86) c.copy(palette.flowerYellow);
      else if (r < 0.94) c.copy(palette.orangeEye).lerp(palette.blossom, 0.45); // soft coral
      else c.copy(palette.flowerLavender).lerp(palette.skyHorizon, 0.5); // pale cornflower blue
      c.offsetHSL((rnd() - 0.5) * 0.025, (rnd() - 0.5) * 0.07, (rnd() - 0.5) * 0.07);
      scales[w] = 0.5 + rnd() * 0.45;
      aspects[w] = 1.2 + rnd() * 0.35; // mild petal elongation (soft teardrop)
    } else if (kind === KIND_LEAF) {
      // tumbling leaves — mostly light-coupled greens (sunlit lime → cool green),
      // with a rare warm one (amber/rust) so the field reads painted, not uniform.
      const warm = rnd();
      if (warm < 0.12) {
        // a few turning leaves: amber or rust, with a touch of variation
        c.copy(warm < 0.07 ? LEAF_AMBER : LEAF_RUST);
        c.offsetHSL((rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.1);
      } else {
        const lit = rnd();
        const h = 0.30 - lit * 0.09 + (rnd() - 0.5) * 0.02;
        const s = 0.55 + (1 - lit) * 0.12;
        const l = 0.30 + lit * 0.34 + (rnd() - 0.5) * 0.06;
        c.setHSL(THREE.MathUtils.clamp(h, 0, 1), THREE.MathUtils.clamp(s, 0, 1),
          THREE.MathUtils.clamp(l, 0.1, 0.85));
      }
      scales[w] = 0.45 + rnd() * 0.4;
      aspects[w] = 1.3 + rnd() * 0.5; // leaves longer than petals (tapered ovoid)
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
    // (X/Z across the wide box, Y within the shallow ground band).
    const hx = (rnd() - 0.5) * BOX;
    const hy = (rnd() - 0.5) * BAND;
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
