import * as THREE from 'three/webgpu';
import { Updatable } from '../core/Engine';
import { FlightController } from './FlightController';
import {
  buildBody, buildNeckSeg, buildHead, buildBill, buildTail,
  buildWingBone, buildPrimary, toCreasedNormals, C_EYE,
} from './birdGeometry';

// The hero bird — a heron-grey, pelican-lineage soaring creature, built as a
// hierarchy of *solid, smooth-shaded lofted volumes* (no skinning) so it reads as
// a sculpted animal, not a fan of flat cards. Articulation is a small bone tree:
//   root → bob → { body, S-neck → head → bill, tail, wing.L, wing.R }
// each wing being shoulder → elbow → wrist → primary-fan groups.
//
// Motion is the soul of the piece: a large bird mostly GLIDES on a held dihedral
// and only occasionally drives a deep, weighty flap — a slow loaded downstroke and
// a lighter, slower-feeling recovery, with a proximal→distal phase lag so the
// wing unrolls and the tips trail on underdamped springs. The body heaves up on
// the downstroke and settles on recovery; the neck and tail counter-swing with
// inertia. Flap intensity rises gently with climb. Nose +Z, up +Y, wings ±X.
//
// Contract with the engine (unchanged): constructed as `new Bird(scene, flight)`,
// adds its root to the scene, and `update(dt, t)` copies flight.position and sets
// root.rotation(pitch, yaw, roll, 'YXZ'). FlightController owns the transform; the
// Bird owns only its internal articulation.

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

export class Bird implements Updatable {
  private flight: FlightController;
  private root = new THREE.Group();
  private bob = new THREE.Group(); // body heave + pitch nod
  private neck1!: THREE.Group;
  private neck2!: THREE.Group;
  private neck3!: THREE.Group;
  private head!: THREE.Group;
  private billLower!: THREE.Group;
  private tail!: THREE.Group;
  private wings: Wing[] = [];
  private phase = 0;
  private flapEnergy = 0; // eased flap intensity (climb-coupled)

  constructor(scene: THREE.Scene, flight: FlightController) {
    this.flight = flight;

    // One body material (smooth) and one feather material (smooth, single-sided —
    // every part is now a closed volume, so no DoubleSide / flatShading needed).
    const plumeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.66, metalness: 0 });
    const featherMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.54, metalness: 0,
      emissive: new THREE.Color('#3a4150'), emissiveIntensity: 0.03,
    });
    const billMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0 });
    const eyeMat = new THREE.MeshStandardMaterial({ color: C_EYE, roughness: 0.25, metalness: 0 });

    this.root.add(this.bob);

    // ---- body (single lofted teardrop) ----
    const bodyGeo = toCreasedNormals(buildBody(), Math.PI); // fully smooth
    this.bob.add(new THREE.Mesh(bodyGeo, plumeMat));

    // ---- retracted S-neck → head ----
    // neckBase sits on the shoulders, kinked back; successive segments fold the
    // neck into the gentle resting S of a soaring pelican (head tucked low).
    const neckBase = new THREE.Group();
    neckBase.position.set(0, 0.13, 0.74);
    neckBase.rotation.x = 0.85;
    this.bob.add(neckBase);
    neckBase.add(new THREE.Mesh(buildNeckSeg(0.1, 0.085, 0.2), plumeMat));

    this.neck1 = new THREE.Group();
    this.neck1.position.set(0, 0, 0.2);
    this.neck1.rotation.x = -1.05;
    neckBase.add(this.neck1);
    this.neck1.add(new THREE.Mesh(buildNeckSeg(0.085, 0.072, 0.2), plumeMat));

    this.neck2 = new THREE.Group();
    this.neck2.position.set(0, 0, 0.2);
    this.neck2.rotation.x = -0.55;
    this.neck1.add(this.neck2);
    this.neck2.add(new THREE.Mesh(buildNeckSeg(0.072, 0.062, 0.16), plumeMat));

    this.neck3 = new THREE.Group();
    this.neck3.position.set(0, 0, 0.16);
    this.neck3.rotation.x = 0.9; // the head levels out to look forward
    this.neck2.add(this.neck3);
    this.neck3.add(new THREE.Mesh(buildNeckSeg(0.062, 0.05, 0.1), plumeMat));

    // head
    this.head = new THREE.Group();
    this.head.position.set(0, 0, 0.1);
    this.neck3.add(this.head);
    const headGeo = toCreasedNormals(buildHead(), Math.PI);
    this.head.add(new THREE.Mesh(headGeo, plumeMat));

    // eyes — small dark spheres set into the lores
    const eyeGeo = new THREE.SphereGeometry(0.02, 10, 8);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(sx * 0.072, 0.03, 0.07);
      this.head.add(eye);
    }

    // bill — upper fixed to the head, lower on a tiny jaw pivot
    const upperBill = new THREE.Mesh(toCreasedNormals(buildBill(0.52, true), Math.PI * 0.55), billMat);
    upperBill.position.set(0, 0.0, 0.16);
    upperBill.rotation.x = 0.04;
    this.head.add(upperBill);

    this.billLower = new THREE.Group();
    this.billLower.position.set(0, -0.028, 0.16);
    this.billLower.rotation.x = 0.05;
    this.head.add(this.billLower);
    this.billLower.add(new THREE.Mesh(toCreasedNormals(buildBill(0.5, false), Math.PI * 0.55), billMat));

    // ---- tail (single solid fan-wedge) ----
    this.tail = new THREE.Group();
    this.tail.position.set(0, 0.02, -0.9);
    this.tail.rotation.x = -0.04;
    this.bob.add(this.tail);
    this.tail.add(new THREE.Mesh(toCreasedNormals(buildTail(0.34, 0.16), Math.PI * 0.7), featherMat));

    // ---- wings ----
    this.wings.push(this.buildWing(+1, featherMat));
    this.wings.push(this.buildWing(-1, featherMat));

    this.root.scale.setScalar(SCALE);
    this.root.traverse((o) => { o.frustumCulled = false; });
    scene.add(this.root);
  }

  // A wing: shoulder (arm, broad) → elbow (forearm + suggested secondaries) →
  // wrist (hand) → fan of solid primary feathers. The arm/hand are solid lofted
  // airfoil blades; the secondaries are merged into the forearm so the trailing
  // edge reads as one continuous feathered plane (one draw call per group).
  private buildWing(side: number, featherMat: THREE.Material): Wing {
    // SHOULDER / arm — broad inner blade
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.16, 0.07, 0.08);
    this.bob.add(shoulder);
    const armGeo = toCreasedNormals(buildWingBone(side, 0.5, 0.56, 0.46, 0.05, 0.04, true), Math.PI * 0.6);
    shoulder.add(new THREE.Mesh(armGeo, featherMat));

    // ELBOW / forearm — narrower blade carrying the secondary feathers
    const elbow = new THREE.Group();
    elbow.position.set(side * 0.5, 0, 0);
    shoulder.add(elbow);
    const foreGeo = buildWingBone(side, 0.5, 0.46, 0.3, 0.04, 0.028, true);
    // suggested secondaries: a soft scalloped trailing plane built as slim blades
    // merged into the forearm so they smooth-shade together (no card seams).
    const secGeos: THREE.BufferGeometry[] = [foreGeo];
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      const fe = buildPrimary(side, 0.3 - 0.06 * t, 0.13, false);
      fe.rotateX(-0.22); // lay back along the trailing edge
      fe.translate(side * (0.06 + t * 0.4), -0.01, -0.16 - 0.02 * t);
      secGeos.push(fe);
    }
    const elbowGeo = toCreasedNormals(this.mergeIndexed(secGeos), Math.PI * 0.5);
    elbow.add(new THREE.Mesh(elbowGeo, featherMat));

    // WRIST / hand — slim outer blade
    const wrist = new THREE.Group();
    wrist.position.set(side * 0.5, 0, 0);
    elbow.add(wrist);
    const handGeo = toCreasedNormals(buildWingBone(side, 0.34, 0.3, 0.16, 0.028, 0.016, false), Math.PI * 0.55);
    wrist.add(new THREE.Mesh(handGeo, featherMat));

    // FAN — long charcoal primaries splayed from the hand; these are the tips
    // that trail and bend on the spring. Each is a solid slim blade.
    const fan = new THREE.Group();
    fan.position.set(side * 0.32, 0, 0);
    wrist.add(fan);
    const fanGeos: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 8; i++) {
      const t = i / 7;
      const len = 0.5 - 0.16 * t; // outer primaries longest at the leading group
      const blade = buildPrimary(side, len, 0.085, true);
      blade.rotateZ(side * (-0.04 + t * 0.02));
      blade.rotateY(side * (-0.32 + t * 0.62)); // splay back into a fan
      blade.rotateX(-0.04);
      blade.translate(side * 0.01 * i, 0, 0.02 - t * 0.16);
      fanGeos.push(blade);
    }
    const fanGeo = toCreasedNormals(this.mergeIndexed(fanGeos), Math.PI * 0.5);
    fan.add(new THREE.Mesh(fanGeo, featherMat));

    return { shoulder, elbow, wrist, fan, sgn: side, springPos: 0, springVel: 0 };
  }

  /** Minimal indexed merge for position/normal/color attributes into one geo. */
  private mergeIndexed(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
    if (geos.length === 1) return geos[0];
    let vTotal = 0, iTotal = 0;
    for (const g of geos) {
      vTotal += g.attributes.position.count;
      iTotal += g.index ? g.index.count : 0;
    }
    const P = new Float32Array(vTotal * 3);
    const N = new Float32Array(vTotal * 3);
    const C = new Float32Array(vTotal * 3);
    const I = new Uint32Array(iTotal);
    let vo = 0, io = 0, base = 0;
    for (const g of geos) {
      const pa = g.attributes.position.array as ArrayLike<number>;
      const na = (g.attributes.normal?.array ?? new Float32Array(g.attributes.position.count * 3)) as ArrayLike<number>;
      const ca = (g.attributes.color?.array ?? new Float32Array(g.attributes.position.count * 3).fill(1)) as ArrayLike<number>;
      P.set(pa as Float32Array, vo * 3);
      N.set(na as Float32Array, vo * 3);
      C.set(ca as Float32Array, vo * 3);
      const idx = g.index!;
      for (let k = 0; k < idx.count; k++) I[io + k] = idx.getX(k) + base;
      vo += g.attributes.position.count;
      io += idx.count;
      base += g.attributes.position.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(P, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    out.setAttribute('color', new THREE.BufferAttribute(C, 3));
    out.setIndex(new THREE.BufferAttribute(I, 1));
    return out;
  }

  update(dt: number, t: number) {
    // --- transform (the controller's contract — unchanged) ---
    this.root.position.copy(this.flight.position);
    this.root.rotation.set(this.flight.pitch, this.flight.yaw, this.flight.roll, 'YXZ');

    this.phase += TAU * FLAP_FREQ * dt;
    const ph = this.phase;

    // --- glide vs. flap: mostly soaring, occasionally a run of deep beats ---
    // A slow secondary rhythm decides when the bird commits to flapping; climbing
    // (nose-up pitch) asks for more lift, so it beats a touch harder.
    const wantClimb = clamp(this.flight.pitch, 0, 0.42) / 0.42;
    const cycleGate = smooth01(Math.sin(TAU * 0.05 * t) + 0.25); // 0 glide … 1 beat
    const targetEnergy = clamp(0.12 + 0.7 * cycleGate + 0.45 * wantClimb, 0, 1.15);
    // ease the energy so flapping fades in/out — never a sudden metronome.
    this.flapEnergy += (targetEnergy - this.flapEnergy) * Math.min(1, dt * 0.8);
    const amp = this.flapEnergy;

    // --- asymmetric drive: sharp loaded downstroke, slower lifted recovery ---
    // sin − DOWN_BIAS·sin(2φ) skews the waveform so the down phase is quicker &
    // deeper-feeling and the recovery lingers, the signature of a heavy bird.
    const drive = Math.sin(ph) - DOWN_BIAS * Math.sin(2 * ph);
    const driveDown = Math.max(0, drive); // 1 at full downstroke

    // shoulder: held dihedral + deep beat (down = wings sweep down past level)
    const shoulderZ = REST_DIHEDRAL + 0.7 * drive * amp;
    const sweep = 0.12 * Math.sin(ph - 0.4) * amp; // small fore/aft sweep

    // elbow & wrist lag behind the shoulder, and flex extra on the downstroke so
    // the wing visibly *unrolls*: extended on the powerful down, tucked on recovery.
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

    // --- body heave: rises as the wings drive down (lift), settles on recovery,
    // with a small forward pitch nod. Lagged so the mass feels carried along. ---
    this.bob.position.y = 0.07 * driveDown * amp - 0.025 * Math.cos(ph - BOB_LAG) * amp;
    this.bob.rotation.x = 0.04 * Math.sin(ph - 0.35) * amp;

    // --- neck/head counter-motion: the heavy head lags the body heave, so the
    // S-neck breathes and the head bobs slightly against the flap (inertia). ---
    this.neck1.rotation.x = -1.05 + 0.06 * Math.sin(ph - 0.6) * amp;
    this.neck2.rotation.x = -0.55 + 0.05 * Math.sin(ph - 1.0) * amp;
    this.head.rotation.x = -0.045 * Math.sin(ph - 0.9) * amp;
    this.billLower.rotation.x = 0.05 + 0.018 * driveDown; // bill cracks open under load

    // --- tail: biggest follow-through lag (steers + counter-balances) and acts
    // as a rudder, fanning into the bank. ---
    this.tail.rotation.x = -0.04 + 0.08 * Math.sin(ph - TAIL_LAG) * amp;
    this.tail.rotation.y = -0.22 * this.flight.roll;
    this.tail.rotation.z = 0.12 * this.flight.roll;
  }
}
