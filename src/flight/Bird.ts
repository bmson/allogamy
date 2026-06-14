import * as THREE from 'three/webgpu';
import { Updatable } from '../core/Engine';
import { FlightController } from './FlightController';
import {
  buildBodySkin, buildWingSkin, buildLeg, buildFoot,
  BONE, WBONE, WING_JOINTS, WING_ATTACH, TARSUS_LEN, C_EYE,
} from './birdGeometry';
import { makeBirdMaterial } from './birdMaterial';

// THE PELICAN — the soul of the piece. The player IS this bird, gliding alone
// over the painted meadow.
//
// COHERENCE BY CONSTRUCTION. The bird is no longer a kit of capped tubes stuck
// together. The entire body + neck + head + bill + tail is ONE welded, smooth,
// continuously-normalled skin swept along a single master spline (see
// birdGeometry.buildBodySkin). It is a SkinnedMesh: every vertex carries blended
// skin weights against a small bone chain, so when a bone bends, the shared
// surface stretches with it — the silhouette never opens a seam. The wings are
// one continuous cambered membrane each (also SkinnedMesh, weighted across
// shoulder→elbow→wrist→hand) whose root is faired into the back, so there's no
// hard shoulder join. ONE body material, ONE wing material. A single graceful
// sculpted creature — stylised, organic, alive — that belongs in the painterly
// world, not a CAD assembly.
//
// Motion is the soul: a large bird mostly GLIDES on a held dihedral and only now
// and then drives a slow, weighty, asymmetric beat (loaded downstroke, lingering
// recovery) with a proximal→distal lag so the wing unrolls and the tips trail on
// underdamped springs. Layered on: a heaving/breathing torso, a travelling-wave
// S-neck (each bone lags the last), feet that trail and paddle, and a tail with
// the longest follow-through that steers into turns. Everything SLOW, WEIGHTY,
// eased, calm. Because it all drives BONES of the welded skin, the form flexes
// like a supple animal and never tears.
//
// Contract with the engine (unchanged): `new Bird(scene, flight)` adds its root
// to the scene; `update(dt, t)` copies flight.position and sets
// root.rotation.set(pitch, yaw, roll, 'YXZ'). Nose +Z, up +Y, wings ±X.

const TAU = Math.PI * 2;

// --- flap timing/feel ---
const FLAP_FREQ = 0.42; // Hz — slow & deliberate (a big bird's unhurried beat)
const DOWN_BIAS = 0.32; // asymmetry: loaded downstroke, lighter slower recovery
const ELBOW_LAG = 0.85; // proximal→distal phase lag (radians of the flap cycle)
const WRIST_LAG = 1.55;
const BOB_LAG = 0.55;
const TAIL_LAG = 1.1;

// --- primary-tip spring (underdamped → trail & settle, the weighty overshoot) ---
const STIFF_K = 46;
const DAMP_C = 11.0;

// --- rest pose (radians) ---
const REST_DIHEDRAL = 0.16; // shoulders held in a soft soaring V
const REST_ELBOW = -0.2;
const REST_WRIST = -0.16;

const SCALE = 3.0;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function smooth01(s: number): number {
  const x = s * 0.5 + 0.5;
  return x * x * (3 - 2 * x);
}

interface Wing {
  shoulder: THREE.Bone;
  elbow: THREE.Bone;
  wrist: THREE.Bone;
  hand: THREE.Bone;
  sgn: number;
  springPos: number;
  springVel: number;
}

export class Bird implements Updatable {
  private flight: FlightController;
  private root = new THREE.Group();
  private bob = new THREE.Group(); // whole-body heave / surge / sway
  // body skeleton bones (the welded skin bends to these)
  private bTorso!: THREE.Bone;
  private bTail!: THREE.Bone;
  private bNeck: THREE.Bone[] = [];
  private bHead!: THREE.Bone;
  private bJaw!: THREE.Bone;
  private bodyMesh!: THREE.SkinnedMesh;
  private legs: { hip: THREE.Group; ankle: THREE.Group; sgn: number }[] = [];
  private wings: Wing[] = [];
  private phase = 0;
  private flapEnergy = 0;
  // eased body-morph state: the supple form lags the controller a touch, so the
  // creature pours into a bank / arcs through a climb with weighty follow-through
  // instead of snapping. These are smoothed each frame toward flight.roll/pitch.
  private morphRoll = 0;
  private morphPitch = 0;
  private morphRollVel = 0; // for an extra overshoot on the leading bend
  private bankRate = 0; // d(roll)/dt, smoothed — drives "lean into the new turn"
  // eased GAZE state: the head looks WHERE THE BIRD IS GOING. These lag the
  // controller's pitch/roll on their own springs so the gaze LEADS smoothly into a
  // climb/dive/bank a beat behind the body — the head tips and turns to follow the
  // flight path rather than snapping. Separate from morphPitch/Roll (which drive the
  // whole-body arc) so the gaze can ease on its own, soulful timing.
  private gazePitch = 0; // eased toward flight.pitch → head tips up climbing / down diving
  private gazeYaw = 0;   // eased toward flight.roll  → head leads into the bank
  // neck flex spring: an organic extend/compress + vertical bob that ripples down the
  // S-neck. A second-order spring driven by the heave gives it weight (no jitter).
  private neckFlex = 0;
  private neckFlexVel = 0;

  constructor(scene: THREE.Scene, flight: FlightController) {
    this.flight = flight;

    // FLAT 2D-ILLUSTRATION NPR SHADING — not PBR, and deliberately NOT a lit 3D look.
    // The smooth n·sun gradient that used to sculpt the body as a solid is QUANTIZED
    // into a couple of hard FLAT ink-wash fills (light / mid / shadow); the boundary
    // between them is warped by object-space fbm NOISE so the shadow edge wavers like a
    // hand-painted line, the fills are mottled by the same noise into a dry watercolour
    // wash, and the whole shape is bounded by a wobbly hand-inked CONTOUR. So the
    // pelican reads as a FLAT hand-drawn illustration moving through the painted world,
    // not a 3D model. The baked per-vertex wash is reused only to tint the fills to the
    // creature's identity (grey body / charcoal primaries / warm bill). World-space
    // normals keep the (quantized) light flipping light↔shadow as the bird banks and
    // the sun tracks across it. (See birdMaterial.makeBirdMaterial.)
    const bodyMat = makeBirdMaterial();
    // Wings share the BODY material exactly — same flat fills + wash + contour + tint —
    // so the wing reads continuous with the flank with no extra inked seam. (The user
    // wanted the wing↔body contrast gone.)
    const wingMat = bodyMat;
    // legs are small & thin — a finer wash and a lighter outline so the slim tarsi keep
    // a clean drawn edge instead of clotting into solid ink.
    const legMat = makeBirdMaterial({ noiseScale: 9.0, outline: 0.85, hatch: 0.0 });

    this.root.add(this.bob);

    // ---- the unified body skin + its skeleton ----
    this.buildBody(bodyMat);

    // ---- eyes: small glossy beads in a pale ring, parented to the head bone ----
    this.buildEyes();

    // ---- wings: one continuous skinned membrane each, root faired into the back ----
    this.wings.push(this.buildWing(+1, wingMat));
    this.wings.push(this.buildWing(-1, wingMat));

    // ---- legs: trailing, parented to the body bone so they stream behind ----
    this.buildLegs(legMat);

    this.root.scale.setScalar(SCALE);
    this.root.traverse((o) => { o.frustumCulled = false; });
    scene.add(this.root);
  }

  // Build the welded body skin as a SkinnedMesh driven by a small bone hierarchy.
  // The skeleton mirrors the bones tagged into the geometry; each bone's rest head
  // is read from buildBodySkin's boneRest so the skin maps 1:1 to its rest pose.
  private buildBody(mat: THREE.Material) {
    const { geo, boneRest } = buildBodySkin();

    // bone hierarchy:
    //   bob → torso(BODY) → tail(TAIL)
    //                     → neck0 → neck1 → neck2 → neck3 → head(HEAD) → jaw(JAW)
    // Each child bone sits at the delta between its rest head and its parent's, so
    // at rest the chain reconstructs the skeleton exactly and the skin is undeformed.
    this.bTorso = new THREE.Bone();
    this.bTorso.position.copy(boneRest[BONE.BODY]);

    // tail hangs off the torso (rump)
    this.bTail = new THREE.Bone();
    this.bTail.position.copy(boneRest[BONE.TAIL]).sub(boneRest[BONE.BODY]);
    this.bTorso.add(this.bTail);

    // neck chain off the torso
    const neckBones = [BONE.NECK0, BONE.NECK1, BONE.NECK2, BONE.NECK3];
    let parent: THREE.Bone = this.bTorso;
    let prevRest = boneRest[BONE.BODY];
    for (const nb of neckBones) {
      const b = new THREE.Bone();
      b.position.copy(boneRest[nb]).sub(prevRest);
      parent.add(b);
      this.bNeck.push(b);
      parent = b;
      prevRest = boneRest[nb];
    }
    // head off the last neck bone
    this.bHead = new THREE.Bone();
    this.bHead.position.copy(boneRest[BONE.HEAD]).sub(prevRest);
    parent.add(this.bHead);
    // jaw off the head
    this.bJaw = new THREE.Bone();
    this.bJaw.position.copy(boneRest[BONE.JAW]).sub(boneRest[BONE.HEAD]);
    this.bHead.add(this.bJaw);

    // assemble the skeleton in BONE-index order so geo.skinIndex maps correctly
    const bonesByIndex: THREE.Bone[] = new Array(BONE.COUNT);
    bonesByIndex[BONE.TAIL] = this.bTail;
    bonesByIndex[BONE.BODY] = this.bTorso;
    bonesByIndex[BONE.NECK0] = this.bNeck[0];
    bonesByIndex[BONE.NECK1] = this.bNeck[1];
    bonesByIndex[BONE.NECK2] = this.bNeck[2];
    bonesByIndex[BONE.NECK3] = this.bNeck[3];
    bonesByIndex[BONE.HEAD] = this.bHead;
    bonesByIndex[BONE.JAW] = this.bJaw;

    const mesh = new THREE.SkinnedMesh(geo, mat);
    const skeleton = new THREE.Skeleton(bonesByIndex);
    // The skeleton root (torso bone) lives under the mesh; the mesh's own transform
    // stays identity, so the geometry's bob-space spine coordinates map 1:1 to the
    // bones at rest. bind() updates the bone world matrices and computes the rest
    // inverses, so the welded skin is undeformed at the rest pose.
    mesh.add(this.bTorso);
    this.bob.add(mesh);
    mesh.bind(skeleton);
    this.bodyMesh = mesh;
  }

  private buildEyes() {
    const eyeGeo = new THREE.SphereGeometry(0.018, 12, 10);
    eyeGeo.scale(1, 1, 0.72);
    const eyeMat = new THREE.MeshStandardMaterial({ color: C_EYE, roughness: 0.12, metalness: 0.05 });
    const ringGeo = new THREE.SphereGeometry(0.026, 12, 8);
    ringGeo.scale(1, 0.85, 0.4);
    const ringMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#b9c0c6'), roughness: 0.7, metalness: 0 });
    const glintGeo = new THREE.SphereGeometry(0.005, 6, 5);
    const glintMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#ffffff'), roughness: 0.2, metalness: 0,
      emissive: new THREE.Color('#dfe7ee'), emissiveIntensity: 0.5,
    });
    // The HEAD bone pivots at the nape (≈ z 0.86 in bob-space); the head ovoid is
    // centred ~0.1 ahead and ~0.71 up. Seat the eyes on the sides of that ovoid,
    // expressed in the bone's local frame (subtract the bone anchor).
    for (const sx of [-1, 1]) {
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(sx * 0.082, 0.022, 0.122);
      ring.rotation.y = sx * 0.22; // sit the lid-ring flush on the curved cheek
      this.bHead.add(ring);
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(sx * 0.086, 0.022, 0.128);
      eye.rotation.y = sx * 0.22;
      this.bHead.add(eye);
      // the catch-light sits toward the sun (up-and-inboard of the sun vector) so
      // both eyes carry the same warm glint — the single detail that makes a stylised
      // creature read as ALIVE rather than a decoy.
      const glint = new THREE.Mesh(glintGeo, glintMat);
      glint.position.set(sx * 0.09 - 0.006, 0.032, 0.14);
      this.bHead.add(glint);
    }
  }

  // A wing: one continuous skinned membrane bent at four bones. The bones sit at
  // the spanwise joints (WING_JOINTS); flexing them bends one flowing skin.
  private buildWing(side: number, wingMat: THREE.Material): Wing {
    const geo = buildWingSkin(side);

    // wing skeleton: shoulder → elbow → wrist → hand. The bone joints coincide
    // exactly with the geometry's spanwise joints (WING_JOINTS, measured from the
    // baked-in WING_ATTACH root), so rotating a bone pivots its faired region of
    // the one continuous skin precisely — no shear at the joints.
    const shoulder = new THREE.Bone();
    const elbow = new THREE.Bone();
    const wrist = new THREE.Bone();
    const hand = new THREE.Bone();
    elbow.position.set(side * (WING_JOINTS[1] - WING_JOINTS[0]), 0, 0);
    wrist.position.set(side * (WING_JOINTS[2] - WING_JOINTS[1]), 0, 0);
    hand.position.set(side * (WING_JOINTS[3] - WING_JOINTS[2]), 0, 0);
    shoulder.add(elbow); elbow.add(wrist); wrist.add(hand);

    // seat the shoulder at the baked attachment (x mirrored per side)
    shoulder.position.set(side * WING_ATTACH.x, WING_ATTACH.y, WING_ATTACH.z);

    const bonesByIndex: THREE.Bone[] = new Array(WBONE.COUNT);
    bonesByIndex[WBONE.SHOULDER] = shoulder;
    bonesByIndex[WBONE.ELBOW] = elbow;
    bonesByIndex[WBONE.WRIST] = wrist;
    bonesByIndex[WBONE.HAND] = hand;

    const mesh = new THREE.SkinnedMesh(geo, wingMat);
    const skeleton = new THREE.Skeleton(bonesByIndex);
    mesh.add(shoulder);
    this.bob.add(mesh);
    mesh.bind(skeleton);

    return { shoulder, elbow, wrist, hand, sgn: side, springPos: 0, springVel: 0 };
  }

  private buildLegs(legMat: THREE.Material) {
    for (const sx of [-1, 1]) {
      const hip = new THREE.Group();
      // bob-space hip ≈ (±0.08, -0.16, -0.5); torso bone pivots at (0,-0.02,-0.12),
      // so subtract that anchor to seat the legs correctly under the rear belly.
      hip.position.set(sx * 0.08, -0.14, -0.38);
      hip.rotation.x = -0.35;
      // parent to the torso bone so legs stream with the body's motion
      this.bTorso.add(hip);
      hip.add(new THREE.Mesh(buildLeg(), legMat));

      const ankle = new THREE.Group();
      ankle.position.set(0, -0.05, -TARSUS_LEN);
      ankle.rotation.x = 0.5;
      hip.add(ankle);
      ankle.add(new THREE.Mesh(buildFoot(sx), legMat));

      this.legs.push({ hip, ankle, sgn: sx });
    }
  }

  update(dt: number, t: number) {
    // --- transform (the controller's contract) ---
    this.root.position.copy(this.flight.position);
    this.root.rotation.set(-this.flight.pitch, this.flight.yaw, this.flight.roll, 'YXZ');

    this.phase += TAU * FLAP_FREQ * dt;
    const ph = this.phase;

    // --- eased body-morph drivers: a supple creature pours into the bank and arcs
    // through the climb/dive with weight, lagging the (already-eased) controller so
    // the FORM follows the intent a beat behind. The whole welded spine bows to
    // these via its bone chain, so the surface reshapes seamlessly (no joint gap). ---
    const kRoll = 1 - Math.exp(-dt * 4.0);
    const kPitch = 1 - Math.exp(-dt * 3.2);
    const prevMorphRoll = this.morphRoll;
    this.morphRoll += (this.flight.roll - this.morphRoll) * kRoll;
    this.morphPitch += (this.flight.pitch - this.morphPitch) * kPitch;
    // rate of bank (smoothed) — the body leans harder while *entering* a turn
    const rawRate = dt > 1e-5 ? (this.morphRoll - prevMorphRoll) / dt : 0;
    this.bankRate += (rawRate - this.bankRate) * (1 - Math.exp(-dt * 3.0));
    // a touch of velocity-spring on the lateral bend for organic overshoot
    this.morphRollVel += (this.bankRate * 0.18 - this.morphRollVel) * (1 - Math.exp(-dt * 5.0));
    const mRoll = this.morphRoll;   // lateral (X) body-arc driver  (±~0.62)
    const mPitch = this.morphPitch; // vertical (Y) body-arc driver (±~0.42)
    const lead = clamp(this.morphRollVel, -0.5, 0.5); // extra lean entering a turn

    // --- GAZE drivers: the head looks WHERE IT'S GOING. Ease the raw flight pitch &
    // roll on their own (slightly slower than the body morph) so the gaze LEADS into
    // the path a beat behind the body — tipping up into a climb, down into a dive,
    // and turning into a bank — all smooth and soulful, never snapping rigid. ---
    const kGaze = 1 - Math.exp(-dt * 2.6);
    this.gazePitch += (this.flight.pitch - this.gazePitch) * kGaze;
    this.gazeYaw += (this.flight.roll - this.gazeYaw) * kGaze;
    const gPitch = clamp(this.gazePitch, -0.6, 0.6); // travel-direction pitch (up climb / down dive)
    const gYaw = clamp(this.gazeYaw, -0.7, 0.7);      // lean the gaze into the bank

    // --- BANKING TURN, the signature move: a bird WHEELS, it doesn't yaw flat. ---
    // Sign of the bank (controller contract, verified): +roll rolls the +X (right)
    // wing UP and the -X (left) wing DOWN. The LOW wing is always the INSIDE of the
    // turn — it drops, tucks and sweeps; the HIGH wing is the OUTSIDE — it rises and
    // reaches. We carve the turn with the whole body: weight rolls into the bank,
    // the inside wing collapses while the outside wing extends (asymmetric dihedral),
    // the head/neck lead and tip into it, the tail twists & fans as a rudder. These
    // scalars (0..1-ish) let every part read off ONE coherent turn intent, eased so
    // the creature pours into the wheel and unwinds out of it with follow-through.
    const bankMag = clamp(Math.abs(mRoll) / 0.62, 0, 1);     // 0 level → 1 hard bank
    const bankMagSoft = bankMag * bankMag * (3 - 2 * bankMag); // smooth ramp for cosmetics

    // --- glide vs. flap: mostly soaring, occasionally a run of deep beats ---
    const wantClimb = clamp(this.flight.pitch, 0, 0.42) / 0.42;
    const cycleGate = smooth01(Math.sin(TAU * 0.05 * t) + 0.25);
    const targetEnergy = clamp(0.12 + 0.7 * cycleGate + 0.45 * wantClimb, 0, 1.15);
    this.flapEnergy += (targetEnergy - this.flapEnergy) * Math.min(1, dt * 0.8);
    const amp = this.flapEnergy;

    // --- asymmetric drive: sharp loaded downstroke, slower lifted recovery ---
    const drive = Math.sin(ph) - DOWN_BIAS * Math.sin(2 * ph);
    const driveDown = Math.max(0, drive);

    // Flap shares: the SHOULDER carries only a SMALL part of the raw swing now, so
    // the big visible beat happens OUTBOARD of the buried wing root. The buried
    // fillet sits at the shoulder pivot and barely moves through the cycle (the
    // geometry's overlap test was tuned to stay closed for shoulder swings up to
    // ~0.4–0.45 rad), which is what keeps the shoulder haunch welded shut as the wing
    // flaps — no seam opens at the flank. The lost shoulder amplitude is handed to
    // the ELBOW so the wingtip still travels the full beat: the arm leads
    // proximal→distal and the wing unrolls like a whip from a near-still root.
    const shoulderZ = REST_DIHEDRAL + 0.22 * drive * amp;
    const sweep = 0.10 * Math.sin(ph - 0.4) * amp;

    const dl = Math.sin(ph - ELBOW_LAG) - DOWN_BIAS * Math.sin(2 * (ph - ELBOW_LAG));
    const elbowZ = REST_ELBOW + 0.82 * dl * amp + 0.34 * Math.max(0, -drive) * amp;
    const wl = Math.sin(ph - WRIST_LAG);
    const wristZ = REST_WRIST + 0.52 * wl * amp + 0.2 * Math.max(0, -drive) * amp;
    // feathering wash: the outboard membrane twists nose-down on the loaded
    // downstroke to bite air, and eases flat (even nose-up) on the recovery so the
    // primaries spill — this washout is the gesture that makes a flap read as WORK,
    // not a flat paddle. A small spanwise twist on the wrist, mirrored per side below.
    const washTwist = (0.12 * driveDown - 0.05 * Math.max(0, -drive)) * amp;

    for (const w of this.wings) {
      const s = w.sgn;
      // The wing bones lie along ±X, so a rotation about Z raises/lowers the tip
      // (the dihedral / flap), a rotation about Y sweeps the wing fore/aft, and a
      // rotation about X twists it spanwise (washout / feathering). Each bone bends
      // its faired region of the ONE continuous membrane, so the wing unrolls as a
      // single flowing skin through the whole beat.
      //
      // ASYMMETRIC AVIAN BANK. The LOW wing (inside of the turn) and the HIGH wing
      // (outside) do OPPOSITE things, the gesture that makes a bank read as a bird
      // wheeling rather than a model tilting:
      //   lowness  > 0 → this is the inside/low wing  → DROP further, TUCK (flex
      //                  elbow+wrist so the span shortens), SWEEP back, twist to spill
      //   highness > 0 → this is the outside/high wing → RISE, EXTEND (open the elbow
      //                  /wrist so it reaches long), sweep forward, twist to bite
      // Both are eased through `mRoll`, so the wings morph WITH the rolling body and
      // settle as the turn unwinds.
      // tuck > 0 only on the inside/low wing, reach > 0 only on the outside/high
      // wing. EVERY banking term below carries the side factor `s` so that "drop /
      // fold / sweep-aft" map to the correct rotation sense on each mirrored wing —
      // +roll drops the −X wing, −roll drops the +X wing, and the maths is identical.
      const tuck = Math.max(0, -s * mRoll / 0.62);  // inside/low wing → tuck
      const reach = Math.max(0, s * mRoll / 0.62);   // outside/high wing → reach

      // SHOULDER (about Z = dihedral): DROP the low wing, LIFT the high wing — the
      // split-dihedral that is the heart of the wheel. Kept MODEST at the shoulder so
      // the buried root stays inside the haunch (the bank's big span asymmetry is
      // carried by the elbow/wrist below, outboard of the fillet). (`-s` drops, `+s`
      // raises, for whichever physical wing this is.)
      w.shoulder.rotation.z = s * shoulderZ - s * 0.30 * tuck + s * 0.18 * reach;
      // SHOULDER (about Y = sweep): the inside wing sweeps AFT (trailing, shorter
      // moment arm), the outside wing sweeps slightly FORWARD as it reaches around.
      w.shoulder.rotation.y = s * sweep + s * (0.16 * tuck - 0.08 * reach);

      // ELBOW (about Z): the low wing FLEXES hard (folds, shortening the span — the
      // classic tucked inner wing of a banking bird); the high wing EXTENDS (opens
      // flat to reach long). This span asymmetry is what really sells the wheel, and
      // it lives OUTBOARD of the buried root so it can be bold without opening a seam.
      w.elbow.rotation.z = s * elbowZ - s * 0.50 * tuck + s * 0.28 * reach;
      // WRIST (about Z): continue the fold on the inside, the stretch on the outside.
      w.wrist.rotation.z = s * wristZ - s * 0.28 * tuck + s * 0.14 * reach;
      // spanwise washout twist (about the wing's ±X axis): nose-down to grab air on
      // the downstroke, spilling on recovery. Mirrored by `s` so both wings wash the
      // same way relative to airflow, never tearing the continuous membrane. In a
      // bank, the inside wing washes out further (spills lift so that wing sinks)
      // while the outside wing bites (holds lift to lever it up) — coordinated trim.
      w.wrist.rotation.x = s * washTwist + s * (0.18 * tuck - 0.12 * reach);

      // primary-tip spring: the hand bone trails the wrist and overshoots, then
      // settles — the long primaries' weight read on the continuous skin. A
      // sub-stepped semi-implicit integrator keeps the stiff spring stable at any
      // frame rate (no blow-up on a long dt hitch), so the trail/settle stays smooth.
      const sub = dt > 1 / 90 ? 2 : 1; // extra step only when frames are long
      const h = dt / sub;
      for (let k = 0; k < sub; k++) {
        const a = STIFF_K * (wristZ - w.springPos) - DAMP_C * w.springVel;
        w.springVel += a * h;
        w.springPos += w.springVel * h;
      }
      if (!isFinite(w.springPos)) { w.springPos = 0; w.springVel = 0; }
      // the long primaries of the tucked inner wing fold in further; the outstretched
      // outer wing splays its fingers — the hand completes the asymmetry at the tips.
      w.hand.rotation.z = s * (w.springPos * 0.7) - s * 0.22 * tuck + s * 0.10 * reach;
      // feathering twist on reversal: the long primaries flare open as the wing
      // changes direction. Driven by the spring's *velocity* but clamped so a stiff
      // overshoot can't snap the tip — it stays a supple flick, never a jitter. The
      // inside wing's tip washes out a touch more in the turn (spilling air).
      w.hand.rotation.x = -0.05 + clamp(0.5 * w.springVel, -0.32, 0.32) + s * 0.12 * tuck;
    }

    // --- whole-body motion: never rigid. `bob` carries the body AND both wings as
    // one unit, so leaning/arcing it reshapes the whole creature with ZERO seam risk
    // at the shoulders. This is where the strongest X (lateral) and Y (vertical)
    // body morph lives: the bird slips inboard and banks its whole mass into a turn,
    // and rises/sinks and tips through climbs and dives — a living arc, not a slide. ---
    const idle = t * 0.9;
    const bankSink = -0.045 * bankMagSoft; // settle into a hard bank
    this.bob.position.y = 0.075 * driveDown * amp - 0.028 * Math.cos(ph - BOB_LAG) * amp
      + 0.012 * Math.sin(idle * 0.8)
      + 0.05 * mPitch                                   // whole mass rises in a climb
      + bankSink;                                       // and settles down into a wheel
    this.bob.position.z = 0.035 * Math.sin(ph - 0.5) * amp;
    // slip the whole body INBOARD of the turn (banking birds carve toward the inside
    // /low wing) and pull harder while rolling IN — the mass swings into the wheel.
    this.bob.position.x = 0.02 * Math.sin(idle * 0.6) - 0.085 * mRoll - 0.06 * lead;
    // tip the whole creature head-up/down through climbs & dives (Y-axis arc), with
    // a gentle wingbeat porpoise and idle drift layered in.
    this.bob.rotation.x = 0.05 * Math.sin(ph - 0.35) * amp + 0.02 * Math.sin(idle * 0.7)
      + 0.12 * mPitch;
    // the body's roll EASES behind the root's hard bank (a slight counter-roll that
    // lags the frame for weight), then the leading-edge term lets it SURGE into the
    // bank as it enters a turn and settle after — so the bank reads weighty and alive,
    // a mass rolling into the wheel, not a rigid model snapping to an angle.
    this.bob.rotation.z = 0.06 * Math.sin(ph - 1.2) * amp - 0.09 * mRoll + 0.14 * lead;
    // yaw the whole body into the new heading (the body commits to the turn, leading
    // it with the chest), enhanced while rolling in.
    this.bob.rotation.y = 0.03 * Math.sin(idle * 0.5) + 0.04 * Math.sin(ph * 0.5 - 0.8) * amp
      + 0.07 * mRoll + 0.04 * lead;

    // --- torso bone: the body breathes against the wingbeat AND arcs with flight.
    // On the loaded downstroke the chest lifts & widens; on recovery it stretches
    // long. Layered on top: an ORGANIC squash/stretch that pulses on a slow idle
    // breath, a VERTICAL arc from pitch (climb → chest tips up, dive → tips down),
    // and a LATERAL lean from the bank. A gentle non-uniform scale + a 3-axis bend
    // on the torso bone, which the whole welded skin (and every bone hung off it)
    // follows — so the flesh reshapes with the bones without any seam opening. ---
    const flex = Math.sin(ph - 0.3);
    const breath = 0.5 + 0.5 * Math.sin(idle * 1.1);
    const breath2 = 0.5 + 0.5 * Math.sin(idle * 0.63 + 1.7); // a second slower swell
    // organic squash/stretch: belly fills & flank widens on the breath/downstroke,
    // body lengthens on the recovery. Small, supple, always alive.
    const fill = 0.05 * driveDown * amp + 0.018 * breath + 0.01 * breath2;
    const lengthen = 0.05 * Math.max(0, -flex) * amp + 0.012 * breath2;
    this.bTorso.scale.set(
      1 + fill + 0.006 * breath,            // widen (X)
      1 - 0.5 * fill + 0.012 * breath,      // flatten as it widens (Y) — volume-ish
      1 + lengthen,                          // stretch fore-aft on recovery (Z)
    );
    // The torso bone moves the body skin RELATIVE to the wing meshes (the wings
    // live under `bob`, not under this bone), so its arc is kept GENTLE — just
    // enough belly/chest flex to feel supple — while the big lateral/vertical body
    // arcs are carried either by `bob` (which moves body + wings together) or by the
    // tail/neck chains (extremities, far from the shoulders). This keeps the welded
    // shoulder fairing locked to the wing root: no gap opens as the body morphs.
    this.bTorso.rotation.x = 0.03 * flex * amp        // wingbeat tuck/extend
      + 0.08 * mPitch                                 // mild chest tip with climb/dive
      + 0.02 * Math.sin(idle * 0.7);                  // idle drift
    this.bTorso.rotation.y = 0.04 * mRoll + 0.04 * lead; // mild waist yaw into the turn
    this.bTorso.rotation.z = -0.03 * mRoll;            // subtle waist roll-with-bank

    // --- NECK FLEX: the neck is no longer static. A second-order spring drives an
    // organic EXTEND/COMPRESS + vertical BOB, coupled to the heave/wingbeat (the
    // neck lengthens as the chest lifts on the downstroke, gathers back on recovery)
    // plus a faint idle pulse so it's alive even on a held glide. The spring gives it
    // WEIGHT — slow and soulful, never a jitter — and we ripple it down the S with a
    // per-joint lag so the flex travels along the neck instead of bending as one rod. ---
    const flexTarget = 0.55 * driveDown * amp           // heave-coupled extend on the downstroke
      + 0.18 * mPitch                                   // reach up into a climb / gather in a dive
      + 0.12 * Math.sin(idle * 0.5)                     // faint idle breath so a glide stays alive
      - 0.20 * Math.max(0, -flex) * amp;                // compress as the chest stretches on recovery
    // critically-ish damped spring → weighty, no jitter (sub-stepped for stability)
    {
      const sub = dt > 1 / 90 ? 2 : 1;
      const h = dt / sub;
      for (let k = 0; k < sub; k++) {
        const a = 30 * (flexTarget - this.neckFlex) - 9.5 * this.neckFlexVel;
        this.neckFlexVel += a * h;
        this.neckFlex += this.neckFlexVel * h;
      }
      if (!isFinite(this.neckFlex)) { this.neckFlex = 0; this.neckFlexVel = 0; }
    }
    const neckFlex = this.neckFlex;

    // --- neck: a travelling wave runs down the welded S (each bone lags the one
    // before), so the neck undulates like a real supple neck. Because the skin is
    // weighted smoothly across these bones, it bends as one continuous surface.
    // Layered on the wave: the SPRING-DRIVEN flex above (vertical up-down) AND a
    // LATERAL sway (sideways), both rippled down the chain with per-joint lag so the
    // neck flexes up-down and side-to-side as the bird flies, eased for weight. It
    // also CONTINUES the body's lateral arc — each bone curving a little more into
    // the turn so the front half sweeps into the bank — and counter-bends vertically
    // against the torso so a climb bows the body into a gentle C. The cumulative bend
    // is spread thinly across four joints, keeping the welded surface smooth (no kink). ---
    const n = this.bNeck;
    const nLen = n.length;
    let neckPitchSum = 0; // running sum of the neck's X bend (the gaze inherits this)
    for (let i = 0; i < nLen; i++) {
      const lag = i * 0.6;              // per-joint phase lag → the flex ripples down the S
      const f = (i + 1) / nLen;         // 0..1 outward along the neck
      const ease = 0.55 + 0.45 * f;     // outer joints flex more (the head end is loosest)
      // VERTICAL flex (up-down): the travelling wingbeat wave + the weighty spring
      // flex, both lagged down the chain. Negative X tips this bone's run upward, so
      // a positive `neckFlex` extends/lifts the neck (reaches up into the climb).
      const wave = 0.05 * Math.sin(ph - lag) * amp + 0.03 * Math.sin(idle * 0.6 - lag * 0.5);
      n[i].rotation.x = wave * (0.7 + 0.3 * f)
        - 0.16 * neckFlex * ease        // spring-driven up-down flex, rippling outward
        - 0.05 * mPitch * f;            // counter-arc vs the chest tip (smooth C through climb)
      neckPitchSum += n[i].rotation.x;
      // SIDEWAYS sway (lateral): a slow lateral undulation with the per-joint lag so
      // the neck weaves gently side to side as it flies (alive on a glide), coupled
      // to the roll/heave, PLUS the progressive curve into the turn so the front half
      // sweeps toward the new heading. Spread across four joints → a smooth welded
      // curve, never a kink.
      const sway = 0.045 * Math.sin(idle * 0.55 - lag * 0.7) * (0.5 + 0.5 * f)
        + 0.02 * Math.sin(ph * 0.5 - lag) * amp;       // a faint wing-driven side weave
      n[i].rotation.y = sway + 0.11 * mRoll * f + 0.05 * lead * f;
      // axial roll: the neck progressively counter-rolls toward level (each bone
      // unwinds a little of the body's bank) so by the head the gaze is near
      // horizontal — the supple neck does the levelling, not a snap at the skull.
      n[i].rotation.z = -0.07 * mRoll * f;
    }
    // HEAD GAZE — the head LOOKS WHERE THE BIRD IS GOING. Instead of locking level on
    // the horizon, the head aims along the FLIGHT/TRAVEL direction: it tips UP when
    // climbing and DOWN when diving (eased `gPitch`), turning/leading slightly into a
    // bank (`gYaw`). We first cancel most of the pitch the head inherited down the
    // chain (chest tip + the neck's wave/flex) so the gaze starts from a stable datum,
    // THEN add the travel-direction aim on top — so the head actively points along the
    // path rather than nodding with the body or staying rigidly level. The faint
    // wingbeat/idle nod keeps it alive.
    const inheritedPitch = this.bTorso.rotation.x + neckPitchSum;
    // bird convention: head.rotation.x is applied as part of the body frame where a
    // NEGATIVE x pitches the nose/gaze UP. Climbing (gPitch > 0) → look up → negative.
    this.bHead.rotation.x = -0.85 * inheritedPitch     // settle out the inherited nod first
      - 0.55 * gPitch                                  // then AIM along travel: up climb / down dive
      - 0.018 * Math.sin(ph - 1.9) * amp + 0.018 * Math.sin(idle * 0.9); // alive, not rigid
    // The head LEADS the wheel: it turns to point along the new heading (the bird
    // looks where it is going), and the neck already swept it most of the way there,
    // so this finishes the gaze pointing into the turn. (+roll → heading +X → nose
    // toward +X, which is +head.y.) Driven by the eased gaze so it leads smoothly.
    this.bHead.rotation.y = 0.16 * gYaw + 0.025 * Math.sin(idle * 0.55);
    // GAZE LEVELLING in roll: while the body rolls into the wheel, the head counter-
    // rolls so the eyes stay near horizontal, locked on the world — the steady,
    // soulful eye-line of a living animal carving a turn, even as it looks ahead.
    this.bHead.rotation.z = -0.34 * mRoll - 0.04 * this.bTorso.rotation.z + 0.05 * lead;
    // JAW: the beak stays SHUT at rest. The lower mandible's top edge is built to
    // overlap the upper bill's underside by ~0.016 along the whole length (see
    // buildLowerJawSkin), so at rest (rotation 0) the beak reads fully closed with no
    // gap. We allow only a tiny load-driven crack on the loaded downstroke — small
    // enough that the built-in overlap is never fully consumed (max gape ≈0.014 rad
    // drops the worst forward point <0.011, still inside the 0.016 overlap) — and NO
    // idle baseline, so the resting/closed state is genuinely closed.
    this.bJaw.rotation.x = 0.014 * driveDown; // faint crack under load only; closed at rest

    // --- tail: the rear extremity, with the biggest follow-through lag (steers +
    // counter-balances), fanning into the bank as a rudder and completing the body
    // arc at the back. The tail bone now pivots at the actual rump joint and bends
    // the rear of the welded skin + the rump tube + the faired tail fan AS ONE — so
    // the fan springs from the body and follows it without detaching. ---
    this.bTail.rotation.x = 0.08 * Math.sin(ph - TAIL_LAG) * amp
      + 0.22 * mPitch;                                   // VERTICAL arc: tail lifts in a climb (body bows into a C)
    this.bTail.rotation.y = -0.30 * mRoll - 0.08 * lead; // swing the fan as a rudder, coordinated with the yaw
    this.bTail.rotation.z = 0.18 * mRoll;                // twist/bank the fan with the body (rudder rolled into the wheel)
    // the rectrices FAN OPEN in a turn — the tail spreads to bite as a rudder/airbrake,
    // widening the fan laterally as the bank deepens, then folding back as it unwinds.
    // Kept modest so the (TAIL-weighted) rump flesh only flares subtly while the fan,
    // which is the widest, lightest part of that bone's region, reads as spreading.
    this.bTail.scale.set(1 + 0.16 * bankMagSoft, 1, 1 + 0.04 * bankMagSoft);

    // --- trailing legs & feet ---
    for (let i = 0; i < this.legs.length; i++) {
      const { hip, ankle, sgn } = this.legs[i];
      const lp = idle * 0.7 + i * 1.3;
      hip.rotation.x = -0.35 + 0.05 * Math.cos(ph - BOB_LAG) * amp + 0.04 * driveDown * amp
        + 0.03 * Math.sin(lp);
      hip.rotation.z = 0.16 * mRoll + sgn * (0.035 * Math.sin(lp * 0.8) + 0.02);
      ankle.rotation.x = 0.5 + 0.09 * Math.sin(lp - 0.7) + 0.05 * driveDown * amp;
      ankle.rotation.y = sgn * 0.05 * Math.sin(lp * 0.9 + 0.5);
      ankle.rotation.z = sgn * 0.04 * Math.sin(lp * 0.6);
    }
  }
}
