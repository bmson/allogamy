import * as THREE from 'three/webgpu';
import { Updatable } from '../core/Engine';
import { FlightController } from './FlightController';
import {
  buildBody, buildHead, buildBill, buildTail, buildGular, buildMantle,
  buildWingSection, buildLeg, buildFoot,
  buildNeckSegment, NECK_SPINE,
  TARSUS_LEN, toCreasedNormals, C_EYE,
} from './birdGeometry';

// THE PELICAN — the soul of the piece. The player IS this bird, gliding alone
// over the painted meadow. Every form is a SMOOTH, CONTINUOUS, CURVED surface
// swept along a spline (see birdGeometry.ts): there is not one straight edge,
// flat card or primitive anywhere on it. Body, neck and tail flow as a single
// sinuous form; the wings are single cambered airfoil membranes with curved
// leading/trailing edges; the bill down-curves along its own spline; the feet are
// soft tubes joined by a curved web. It reads as a sculpted living animal that
// belongs in the splat-painted world, not a CAD model dropped into a painting.
//
// Articulation is a small bone tree (NO skinning):
//   root → bob → torso(breathes) ,
//                neck chain (a continuous S, sliced onto 4 bones for a travelling
//                            wave) → head → bill ,
//                tail , 2× leg→foot , 2× wing(shoulder→elbow→wrist).
// The neck/body/tail joints are radius-matched and overlap so the silhouette
// stays continuous even as each bone moves.
//
// Motion is the soul: a large bird mostly GLIDES on a held dihedral and only now
// and then drives a slow, weighty, asymmetric beat (loaded downstroke, lingering
// recovery) with a proximal→distal lag so the wing unrolls and the tips trail on
// underdamped springs. Layered on top: a heaving/breathing torso that never goes
// still, a travelling-wave S-neck whose joints each lag the last, feet that trail
// and paddle with per-leg phase offsets and inertia, and a tail with the longest
// follow-through that steers into turns. Everything SLOW, WEIGHTY, eased, calm.
//
// Contract with the engine (unchanged): `new Bird(scene, flight)` adds its root to
// the scene; `update(dt, t)` copies flight.position and sets
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
const DAMP_C = 11.0; // ~2·√K·0.81 → tips overshoot a little then settle

// --- rest pose (radians) ---
const REST_DIHEDRAL = 0.16; // shoulders held in a soft soaring V
const REST_ELBOW = -0.2;
const REST_WRIST = -0.16;

const SCALE = 3.0;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// Smooth 0..1 envelope from a -1..1 signal, used to shape the glide/flap blend so
// the bird hangs on long glides and only now and then commits to beating.
function smooth01(s: number): number {
  const x = s * 0.5 + 0.5;
  return x * x * (3 - 2 * x);
}

interface Wing {
  shoulder: THREE.Group;
  elbow: THREE.Group;
  wrist: THREE.Group;
  fan: THREE.Group;
  sgn: number;
  springPos: number;
  springVel: number;
}

interface NeckJoint {
  group: THREE.Group;
  restX: number; // rest rotation about X (the S-curve at rest)
}

export class Bird implements Updatable {
  private flight: FlightController;
  private root = new THREE.Group();
  private bob = new THREE.Group(); // whole-body heave / surge / sway
  private torso = new THREE.Group(); // the body skin: breathes & flexes on its own
  private neck: NeckJoint[] = []; // 4-bone chain reconstructing the continuous S
  private head!: THREE.Group;
  private billLower!: THREE.Group;
  private tail!: THREE.Group;
  private legs: { hip: THREE.Group; ankle: THREE.Group; sgn: number }[] = [];
  private wings: Wing[] = [];
  private phase = 0;
  private flapEnergy = 0; // eased flap intensity (climb-coupled)

  constructor(scene: THREE.Scene, flight: FlightController) {
    this.flight = flight;

    // Smooth single-sided MeshStandard materials (every part is a closed/curved
    // surface, so no DoubleSide / flatShading). One body material, one feather
    // material with a whisper of cool emissive for the dark primaries, a glossier
    // bill material, a leg material.
    const plumeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.66, metalness: 0 });
    const featherMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.54, metalness: 0,
      emissive: new THREE.Color('#3a4150'), emissiveIntensity: 0.03,
    });
    const billMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0 });
    const legMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 });
    const pouchMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 });

    this.root.add(this.bob);
    // The torso skin lives on its own group so it can breathe and flex (stretch on
    // the upstroke, compress & lift the breast on the downstroke) independently of
    // the whole-body heave — that relative motion reads as a living body.
    this.bob.add(this.torso);

    // ---- body (one continuous swept teardrop) ----
    this.torso.add(new THREE.Mesh(toCreasedNormals(buildBody(), Math.PI), plumeMat));

    // ---- scapular mantle: a single soft swept cape over the back/shoulders that
    // blends the body into the wing roots (no hard seam, no rows of cards) ----
    this.torso.add(new THREE.Mesh(toCreasedNormals(buildMantle(), Math.PI * 0.7), featherMat));

    // ---- retracted S-neck → head ----
    // The neck is ONE continuous S-spine (NECK_SPINE) sliced onto 4 bones so a
    // travelling wave can animate it while the surface stays seamless. We build
    // each bone from a sub-arc of that spine and compute its rest X-rotation from
    // the curve's tangents, so the assembled chain reconstructs the exact S — but
    // can now flex. Each bone is placed at the end of the previous segment.
    this.buildNeck(plumeMat);
    const headBone = this.neck[this.neck.length - 1].group;

    // head — seats at the local end of the last neck segment
    this.head = new THREE.Group();
    this.head.position.copy(this.neckHeadOffset());
    headBone.add(this.head);
    this.head.add(new THREE.Mesh(toCreasedNormals(buildHead(), Math.PI), plumeMat));

    // eyes — small glossy beads set into a pale eye-ring, with a tiny catch-light
    const eyeGeo = new THREE.SphereGeometry(0.018, 12, 10);
    eyeGeo.scale(1, 1, 0.72);
    const eyeMatGlossy = new THREE.MeshStandardMaterial({ color: C_EYE, roughness: 0.12, metalness: 0.05 });
    const ringGeo = new THREE.SphereGeometry(0.026, 12, 8);
    ringGeo.scale(1, 0.85, 0.4);
    const ringMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#b9c0c6'), roughness: 0.7, metalness: 0 });
    const glintGeo = new THREE.SphereGeometry(0.005, 6, 5);
    const glintMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#ffffff'), roughness: 0.2, metalness: 0,
      emissive: new THREE.Color('#dfe7ee'), emissiveIntensity: 0.5,
    });
    for (const sx of [-1, 1]) {
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(sx * 0.07, 0.03, 0.07);
      this.head.add(ring);
      const eye = new THREE.Mesh(eyeGeo, eyeMatGlossy);
      eye.position.set(sx * 0.072, 0.03, 0.076);
      this.head.add(eye);
      const glint = new THREE.Mesh(glintGeo, glintMat);
      glint.position.set(sx * 0.078, 0.038, 0.088);
      this.head.add(glint);
    }

    // bill — upper fixed to the head, lower on a tiny jaw pivot. Down-curved sweeps.
    const upperBill = new THREE.Mesh(toCreasedNormals(buildBill(0.52, true), Math.PI * 0.55), billMat);
    upperBill.position.set(0, -0.01, 0.18);
    upperBill.rotation.x = 0.02;
    this.head.add(upperBill);

    this.billLower = new THREE.Group();
    this.billLower.position.set(0, -0.04, 0.18);
    this.billLower.rotation.x = 0.04;
    this.head.add(this.billLower);
    this.billLower.add(new THREE.Mesh(toCreasedNormals(buildBill(0.5, false), Math.PI * 0.55), billMat));
    // the signature pelican gular pouch slung under the lower mandible
    const pouch = new THREE.Mesh(toCreasedNormals(buildGular(0.42, 0.07), Math.PI * 0.8), pouchMat);
    pouch.position.set(0, 0.004, 0.0);
    this.billLower.add(pouch);

    // ---- tail: one continuous swept fan-wedge (curved, scalloped trailing edge) ----
    this.tail = new THREE.Group();
    this.tail.position.set(0, 0.04, -0.9);
    this.tail.rotation.x = -0.04;
    this.bob.add(this.tail);
    this.tail.add(new THREE.Mesh(toCreasedNormals(buildTail(0.5, 0.2), Math.PI * 0.6), featherMat));

    // ---- legs: tucked & trailing back the way a soaring pelican streams them.
    // hip → tarsus; a separate ankle group carries the webbed foot so the toes
    // and web can paddle/flex. The tarsus tip is at −Z·TARSUS_LEN (slight drop). ----
    for (const sx of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(sx * 0.08, -0.16, -0.5);
      hip.rotation.x = -0.35; // streams up toward the tail line
      this.bob.add(hip);
      hip.add(new THREE.Mesh(toCreasedNormals(buildLeg(sx), Math.PI * 0.6), legMat));

      const ankle = new THREE.Group();
      ankle.position.set(0, -0.05, -TARSUS_LEN);
      ankle.rotation.x = 0.5; // foot trails back, toes relaxed
      hip.add(ankle);
      ankle.add(new THREE.Mesh(toCreasedNormals(buildFoot(sx), Math.PI * 0.6), legMat));

      this.legs.push({ hip, ankle, sgn: sx });
    }

    // ---- wings ----
    this.wings.push(this.buildWing(+1, featherMat));
    this.wings.push(this.buildWing(-1, featherMat));

    this.root.scale.setScalar(SCALE);
    this.root.traverse((o) => { o.frustumCulled = false; });
    scene.add(this.root);
  }

  // Build the 4-bone neck chain from the continuous master S-spine. Each bone's
  // mesh is a swept sub-arc built in BODY orientation (so the assembled meshes tile
  // the exact S-curve when no rotations are applied). At rest every bone rotation
  // is therefore 0; each bone is simply placed at the previous segment's end. The
  // animator then adds a travelling-wave rotation about each bone's pivot, bending
  // the continuous S like a real supple neck. restX is 0 by construction.
  private buildNeck(mat: THREE.Material) {
    const curve = new THREE.CatmullRomCurve3(NECK_SPINE, false, 'catmullrom', 0.5);
    const cuts = [0, 0.3, 0.55, 0.8, 1.0]; // 4 segments
    // seat the whole neck on the body's shoulder/neck join; the spine's own base is
    // baked into the first mesh, so we offset by (shoulder − spineBase).
    const spineBase = curve.getPointAt(0).clone();
    const shoulder = new THREE.Vector3(0, 0.16, 0.74); // sits in the body's neck join
    let parent: THREE.Object3D = this.bob;
    let prevStart = spineBase.clone();
    let firstSeated = false;
    for (let k = 0; k < cuts.length - 1; k++) {
      const t0 = cuts[k], t1 = cuts[k + 1];
      const g = new THREE.Group();
      const start = curve.getPointAt(t0).clone();
      // No rest rotation accumulates, so the parent's local frame == body frame:
      // the child sits at the body-space delta from the parent segment's start.
      if (!firstSeated) {
        g.position.copy(shoulder); // base bone seated on the shoulders
        firstSeated = true;
      } else {
        g.position.copy(start).sub(prevStart);
      }
      parent.add(g);
      g.add(new THREE.Mesh(toCreasedNormals(buildNeckSegment(t0, t1), Math.PI), mat));
      this.neck.push({ group: g, restX: 0 });
      parent = g;
      prevStart = start;
    }
  }

  /** Local-space end delta of the last neck segment (where the head seats). */
  private neckHeadOffset(): THREE.Vector3 {
    const curve = new THREE.CatmullRomCurve3(NECK_SPINE, false, 'catmullrom', 0.5);
    return curve.getPointAt(1.0).clone().sub(curve.getPointAt(0.8));
  }

  // A wing: shoulder (inner arm membrane) → elbow (forearm membrane) → wrist
  // (hand) → fan (the fingered tip membrane that trails on the spring). Each
  // bone-region is ONE continuous cambered airfoil membrane with curved edges —
  // there are no feather cards anywhere. The sections overlap a hair at the
  // joints so the wing reads as one flowing skin through the whole flap.
  private buildWing(side: number, featherMat: THREE.Material): Wing {
    // SHOULDER / inner arm — broad cambered membrane from the body out to the elbow
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.16, 0.07, 0.06);
    this.bob.add(shoulder);
    const arm = buildWingSection(side, 0.0, 0.52, 0.58, 0.5, 0.18, 0.12, 0.05, 0.04, false, true);
    shoulder.add(new THREE.Mesh(toCreasedNormals(arm, Math.PI * 0.6), featherMat));

    // ELBOW / forearm — narrower cambered membrane carrying the secondaries (as a
    // smoothly scalloped trailing edge, not cards)
    const elbow = new THREE.Group();
    elbow.position.set(side * 0.5, 0, 0);
    shoulder.add(elbow);
    const fore = buildWingSection(side, 0.0, 0.5, 0.5, 0.4, 0.1, 0.04, 0.04, 0.028, false, false);
    elbow.add(new THREE.Mesh(toCreasedNormals(fore, Math.PI * 0.6), featherMat));

    // WRIST / hand — slim outer membrane bridging into the fingered tip
    const wrist = new THREE.Group();
    wrist.position.set(side * 0.5, 0, 0);
    elbow.add(wrist);
    const hand = buildWingSection(side, 0.0, 0.3, 0.4, 0.34, 0.04, -0.02, 0.028, 0.02, false, false);
    wrist.add(new THREE.Mesh(toCreasedNormals(hand, Math.PI * 0.6), featherMat));

    // FAN — the long primaries as ONE continuous membrane with a curved, deeply
    // scalloped trailing edge: the emarginated "fingers" of a soaring wingtip are
    // suggested by smooth cosine slots, never separate blades. This is the part
    // that trails and bends on the underdamped spring.
    const fan = new THREE.Group();
    fan.position.set(side * 0.3, 0, 0);
    wrist.add(fan);
    const tip = buildWingSection(side, 0.0, 0.62, 0.34, 0.12, -0.02, -0.16, 0.02, 0.006, true, false);
    fan.add(new THREE.Mesh(toCreasedNormals(tip, Math.PI * 0.45), featherMat));

    return { shoulder, elbow, wrist, fan, sgn: side, springPos: 0, springVel: 0 };
  }

  update(dt: number, t: number) {
    // --- transform (the controller's contract) ---
    // The controller's `pitch` is +ve for a climb. A positive X-rotation pitches
    // the nose *down*, so we negate it on X so a climb tips the nose up. Yaw/roll
    // unchanged → the controller still owns heading and bank.
    this.root.position.copy(this.flight.position);
    this.root.rotation.set(-this.flight.pitch, this.flight.yaw, this.flight.roll, 'YXZ');

    this.phase += TAU * FLAP_FREQ * dt;
    const ph = this.phase;

    // --- glide vs. flap: mostly soaring, occasionally a run of deep beats ---
    const wantClimb = clamp(this.flight.pitch, 0, 0.42) / 0.42;
    const cycleGate = smooth01(Math.sin(TAU * 0.05 * t) + 0.25); // 0 glide … 1 beat
    const targetEnergy = clamp(0.12 + 0.7 * cycleGate + 0.45 * wantClimb, 0, 1.15);
    this.flapEnergy += (targetEnergy - this.flapEnergy) * Math.min(1, dt * 0.8);
    const amp = this.flapEnergy;

    // --- asymmetric drive: sharp loaded downstroke, slower lifted recovery ---
    const drive = Math.sin(ph) - DOWN_BIAS * Math.sin(2 * ph);
    const driveDown = Math.max(0, drive); // 1 at full downstroke

    // shoulder: held dihedral + deep beat; small fore/aft sweep
    const shoulderZ = REST_DIHEDRAL + 0.7 * drive * amp;
    const sweep = 0.12 * Math.sin(ph - 0.4) * amp;

    // elbow & wrist lag the shoulder and flex extra on the downstroke → the wing
    // visibly unrolls: extended on the powerful down, tucked on recovery.
    const dl = Math.sin(ph - ELBOW_LAG) - DOWN_BIAS * Math.sin(2 * (ph - ELBOW_LAG));
    const elbowZ = REST_ELBOW + 0.5 * dl * amp + 0.34 * Math.max(0, -drive) * amp;
    const wl = Math.sin(ph - WRIST_LAG);
    const wristZ = REST_WRIST + 0.44 * wl * amp + 0.2 * Math.max(0, -drive) * amp;

    for (const w of this.wings) {
      const s = w.sgn;
      // bank: the inside wing tucks a little lower into the turn for character.
      w.shoulder.rotation.z = s * shoulderZ + 0.14 * this.flight.roll * s;
      w.shoulder.rotation.y = s * sweep;
      w.elbow.rotation.z = s * elbowZ;
      w.wrist.rotation.z = s * wristZ;

      // primary-tip spring: an underdamped chase of the wrist angle so the long
      // outer feathers trail the hand and overshoot, then settle — the weight.
      const a = STIFF_K * (wristZ - w.springPos) - DAMP_C * w.springVel;
      w.springVel += a * dt;
      w.springPos += w.springVel * dt;
      if (!isFinite(w.springPos)) { w.springPos = 0; w.springVel = 0; }
      w.fan.rotation.z = s * (w.springPos * 0.7);
      w.fan.rotation.x = -0.05 + 0.5 * w.springVel; // feathering twist on reversal
    }

    // --- whole-body motion: never rigid. Flap-coupled heave + a small fore/aft
    // surge + a lateral sway + a slow idle breathing drift that persists even on a
    // dead glide, so the mass always feels alive and carried by the air. ---
    const idle = t * 0.9; // slow idle clock, independent of the flap energy
    this.bob.position.y = 0.075 * driveDown * amp - 0.028 * Math.cos(ph - BOB_LAG) * amp
      + 0.012 * Math.sin(idle * 0.8);
    this.bob.position.z = 0.035 * Math.sin(ph - 0.5) * amp;
    this.bob.position.x = 0.02 * Math.sin(idle * 0.6) - 0.03 * this.flight.roll;
    this.bob.rotation.x = 0.05 * Math.sin(ph - 0.35) * amp + 0.02 * Math.sin(idle * 0.7);
    this.bob.rotation.z = 0.06 * Math.sin(ph - 1.2) * amp - 0.08 * this.flight.roll;
    this.bob.rotation.y = 0.03 * Math.sin(idle * 0.5) + 0.04 * Math.sin(ph * 0.5 - 0.8) * amp;

    // --- torso flex: the body skin breathes against the wingbeat. On the loaded
    // downstroke the chest widens & the breast lifts; on recovery it stretches long
    // and slim. A gentle non-uniform scale + a tuck/extend pitch, lagged a hair
    // behind the wings so the flesh follows the bones. ---
    const flex = Math.sin(ph - 0.3);
    const breath = 0.5 + 0.5 * Math.sin(idle * 1.1);
    this.torso.scale.set(
      1 + (0.05 * driveDown + 0.012 * breath) * amp + 0.006 * breath,
      1 - 0.035 * driveDown * amp + 0.01 * breath,
      1 + 0.05 * Math.max(0, -flex) * amp,
    );
    this.torso.rotation.x = 0.03 * flex * amp;

    // --- neck: a travelling wave runs down the continuous S (each joint lags the
    // one before it), so the neck undulates and breathes like a real supple neck.
    // The wave persists on a glide (idle) and deepens with the flap; a slow lateral
    // drift + bank-coupled yaw lets the head glance into turns. Keyed off each
    // bone's stored rest angle so the S is preserved. ---
    const n = this.neck;
    for (let i = 0; i < n.length; i++) {
      const lag = i * 0.5;
      const wave = 0.05 * Math.sin(ph - lag) * amp + 0.03 * Math.sin(idle * 0.6 - lag * 0.5);
      const yaw = 0.03 * Math.sin(idle * 0.45 - lag) * (0.5 + 0.5 * (i / n.length));
      n[i].group.rotation.x = n[i].restX + wave * (0.7 + 0.3 * (i / n.length));
      n[i].group.rotation.y = yaw + (i >= 2 ? 0.03 * this.flight.roll : 0);
    }
    this.head.rotation.x = -0.04 * Math.sin(ph - 1.9) * amp + 0.02 * Math.sin(idle * 0.9);
    this.head.rotation.y = -0.06 * this.flight.roll + 0.025 * Math.sin(idle * 0.55); // glances into turns
    this.head.rotation.z = 0.04 * this.flight.roll; // slight head tilt into the bank
    this.billLower.rotation.x = 0.04 + 0.018 * driveDown; // bill cracks open under load

    // --- tail: the biggest follow-through lag (steers + counter-balances), fanning
    // into the bank as a rudder. ---
    this.tail.rotation.x = -0.04 + 0.08 * Math.sin(ph - TAIL_LAG) * amp;
    this.tail.rotation.y = -0.22 * this.flight.roll;
    this.tail.rotation.z = 0.12 * this.flight.roll;

    // --- trailing legs & feet: the legs stream loosely behind, dangling lower on
    // the heave and swinging with the bank; the ankles add a second, lagged sway
    // and the webbed feet relax/paddle gently. Each leg has its own slow phase so
    // they're never in lockstep. ---
    for (let i = 0; i < this.legs.length; i++) {
      const { hip, ankle, sgn } = this.legs[i];
      const lp = idle * 0.7 + i * 1.3; // per-leg slow clock
      hip.rotation.x = -0.35 + 0.05 * Math.cos(ph - BOB_LAG) * amp + 0.04 * driveDown * amp
        + 0.03 * Math.sin(lp);
      hip.rotation.z = 0.16 * this.flight.roll + sgn * (0.035 * Math.sin(lp * 0.8) + 0.02);
      ankle.rotation.x = 0.5 + 0.09 * Math.sin(lp - 0.7) + 0.05 * driveDown * amp;
      ankle.rotation.y = sgn * 0.05 * Math.sin(lp * 0.9 + 0.5);
      ankle.rotation.z = sgn * 0.04 * Math.sin(lp * 0.6);
    }
  }
}
