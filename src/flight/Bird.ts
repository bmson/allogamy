import * as THREE from 'three/webgpu';
import { Updatable } from '../core/Engine';
import { FlightController } from './FlightController';
import {
  buildBody, buildNeckSeg, buildHead, buildBill, buildTail,
  buildWingBone, buildPrimary, buildCovert, buildLeg, buildFoot, buildGular,
  TARSUS_LEN, toCreasedNormals, C_EYE,
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
  private bob = new THREE.Group(); // whole-body heave / surge / sway
  private torso = new THREE.Group(); // the body skin: breathes & flexes on its own
  private neckBase!: THREE.Group;
  private neck1!: THREE.Group;
  private neck2!: THREE.Group;
  private neck3!: THREE.Group;
  private neckRest: number[] = []; // rest X-rotations for the neck chain
  private head!: THREE.Group;
  private billLower!: THREE.Group;
  private tail!: THREE.Group;
  private legs: { hip: THREE.Group; ankle: THREE.Group; sgn: number }[] = [];
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

    this.root.add(this.bob);
    // The torso skin lives on its own group so it can breathe and flex (stretch on
    // the upstroke, compress & lift the breast on the downstroke) independently of
    // the whole-body heave — that relative motion is what reads as a living body.
    this.bob.add(this.torso);

    // ---- body (single lofted teardrop) ----
    const bodyGeo = toCreasedNormals(buildBody(), Math.PI); // fully smooth
    this.torso.add(new THREE.Mesh(bodyGeo, plumeMat));

    // ---- scapular / back plumage: overlapping rows of solid covert feathers laid
    // over the back and flanks so the dorsal silhouette is feathered (real layered
    // self-shadow), not a bare gradient. Merged into one mesh (one draw call). ----
    const coverts: THREE.BufferGeometry[] = [];
    for (let row = 0; row < 5; row++) {
      const rt = row / 4; // 0 shoulders → 1 rump
      const z = 0.5 - rt * 1.1;
      const halfW = 0.2 * (1 - 0.45 * rt) + 0.04;
      const count = 5 - Math.floor(rt * 2);
      for (let i = 0; i < count; i++) {
        const u = count === 1 ? 0.5 : i / (count - 1);
        const lateral = (u - 0.5) * 2; // -1..1 across the back
        const cv = buildCovert(0.2 - 0.05 * rt, 0.12 - 0.03 * rt, 0.7 - 0.25 * rt);
        // seat each feather on the back surface, splayed down the flanks
        const px = lateral * halfW;
        const py = 0.12 - Math.abs(lateral) * 0.16 - rt * 0.04;
        cv.rotateZ(-lateral * 0.6); // tilt down the sides
        cv.rotateX(0.12); // lift the tips a touch
        cv.translate(px, py, z);
        coverts.push(cv);
      }
    }
    this.torso.add(new THREE.Mesh(toCreasedNormals(this.mergeIndexed(coverts), Math.PI * 0.5), featherMat));

    // ---- retracted S-neck → head ----
    // neckBase sits on the shoulders, kinked back; successive segments fold the
    // neck into the gentle resting S of a soaring pelican (head tucked low).
    // The neck base is sunk slightly into the shoulders so the join is seamless;
    // each segment overlaps the previous. Rest angles are stored so the animator
    // can play an organic travelling wave through the whole chain.
    this.neckBase = new THREE.Group();
    this.neckBase.position.set(0, 0.12, 0.7);
    this.neckBase.rotation.x = 0.85;
    this.bob.add(this.neckBase);
    this.neckBase.add(new THREE.Mesh(buildNeckSeg(0.11, 0.085, 0.22), plumeMat));

    this.neck1 = new THREE.Group();
    this.neck1.position.set(0, 0, 0.2);
    this.neck1.rotation.x = -1.05;
    this.neckBase.add(this.neck1);
    this.neck1.add(new THREE.Mesh(buildNeckSeg(0.087, 0.072, 0.2), plumeMat));

    this.neck2 = new THREE.Group();
    this.neck2.position.set(0, 0, 0.2);
    this.neck2.rotation.x = -0.55;
    this.neck1.add(this.neck2);
    this.neck2.add(new THREE.Mesh(buildNeckSeg(0.074, 0.062, 0.16), plumeMat));

    this.neck3 = new THREE.Group();
    this.neck3.position.set(0, 0, 0.16);
    this.neck3.rotation.x = 0.9; // the head levels out to look forward
    this.neck2.add(this.neck3);
    this.neck3.add(new THREE.Mesh(buildNeckSeg(0.064, 0.05, 0.11), plumeMat));
    this.neckRest = [0.85, -1.05, -0.55, 0.9]; // base, n1, n2, n3

    // head
    this.head = new THREE.Group();
    this.head.position.set(0, 0, 0.1);
    this.neck3.add(this.head);
    const headGeo = toCreasedNormals(buildHead(), Math.PI);
    this.head.add(new THREE.Mesh(headGeo, plumeMat));

    // eyes — small, glossy, slightly flattened beads set into a pale eye-ring so
    // they sit in the head rather than bulging off it; a tiny catch-light bead
    // gives the gaze life. The ring is a flat disc the bead nestles into.
    const eyeGeo = new THREE.SphereGeometry(0.018, 12, 10);
    eyeGeo.scale(1, 1, 0.72); // flatten against the skull
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
      ring.position.set(sx * 0.07, 0.032, 0.066);
      this.head.add(ring);
      const eye = new THREE.Mesh(eyeGeo, eyeMatGlossy);
      eye.position.set(sx * 0.072, 0.032, 0.072);
      this.head.add(eye);
      const glint = new THREE.Mesh(glintGeo, glintMat);
      glint.position.set(sx * 0.078, 0.04, 0.084);
      this.head.add(glint);
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
    // the signature pelican gular pouch, slung under the lower mandible
    const pouchMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 });
    const pouch = new THREE.Mesh(toCreasedNormals(buildGular(0.4, 0.075), Math.PI * 0.7), pouchMat);
    pouch.position.set(0, -0.006, 0.02);
    this.billLower.add(pouch);

    // ---- tail: a base wedge of coverts plus a fan of distinct solid rectrices
    // (tail feathers) layered over it, so the tail reads as real overlapping
    // feathers with depth rather than one flat paddle. All merged to one mesh. ----
    this.tail = new THREE.Group();
    this.tail.position.set(0, 0.02, -0.9);
    this.tail.rotation.x = -0.04;
    this.bob.add(this.tail);
    const tailParts: THREE.BufferGeometry[] = [buildTail(0.26, 0.1)]; // short underbase
    const NTAIL = 11;
    for (let i = 0; i < NTAIL; i++) {
      const u = (i - (NTAIL - 1) / 2) / ((NTAIL - 1) / 2); // -1..1 across the fan
      // central feathers longest, outer ones shorter & swept — a rounded fan
      const len = 0.36 * (1 - 0.22 * u * u);
      const blade = buildPrimary(1, len, 0.07, Math.abs(u) > 0.55);
      blade.rotateX(-Math.PI / 2); // lay flat, pointing −Z is handled by the spin
      blade.rotateY(Math.PI / 2 + u * 0.42); // splay across the fan
      blade.rotateX(0.06 + Math.abs(u) * 0.05); // outer feathers lift a touch
      blade.translate(u * 0.03, 0.004 - Math.abs(u) * 0.006, -0.02);
      tailParts.push(blade);
    }
    this.tail.add(new THREE.Mesh(toCreasedNormals(this.mergeIndexed(tailParts), Math.PI * 0.55), featherMat));

    // ---- legs: tucked & trailing back the way a soaring pelican streams them.
    // hip → tarsus, and a separate ankle group carrying the webbed foot so the
    // toes can curl and the foot can paddle/flex organically. Stored for the
    // animator. The tarsus tip is at −Z·TARSUS_LEN (with a slight drop). ----
    const legMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 });
    for (const sx of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(sx * 0.08, -0.16, -0.5); // rear belly, just ahead of the tail
      hip.rotation.x = -0.35; // streams up toward the tail line
      this.bob.add(hip);
      hip.add(new THREE.Mesh(toCreasedNormals(buildLeg(sx), Math.PI * 0.6), legMat));

      const ankle = new THREE.Group();
      ankle.position.set(0, -0.05, -TARSUS_LEN); // at the tarsus tip
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

  // A wing: shoulder (arm, broad) → elbow (forearm + suggested secondaries) →
  // wrist (hand) → fan of solid primary feathers. The arm/hand are solid lofted
  // airfoil blades; the secondaries are merged into the forearm so the trailing
  // edge reads as one continuous feathered plane (one draw call per group).
  private buildWing(side: number, featherMat: THREE.Material): Wing {
    // SHOULDER / arm — broad inner blade, dressed with overlapping rows of upper
    // coverts so the wing's top surface is feathered (layered self-shadow), then
    // all merged into a single mesh for the bone.
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.16, 0.07, 0.08);
    this.bob.add(shoulder);
    const armParts: THREE.BufferGeometry[] = [buildWingBone(side, 0.5, 0.56, 0.46, 0.05, 0.04, true)];
    for (let row = 0; row < 2; row++) {
      const rz = -0.02 - row * 0.1; // rows step toward the trailing edge
      for (let i = 0; i < 5; i++) {
        const u = i / 4;
        const cv = buildCovert(0.16 - row * 0.03, 0.1, 0.6 - row * 0.15);
        cv.rotateX(-0.12 - row * 0.05);
        cv.translate(side * (0.06 + u * 0.38), 0.03 - row * 0.012, rz);
        armParts.push(cv);
      }
    }
    const armGeo = toCreasedNormals(this.mergeIndexed(armParts), Math.PI * 0.5);
    shoulder.add(new THREE.Mesh(armGeo, featherMat));

    // ELBOW / forearm — narrower blade carrying the secondary feathers
    const elbow = new THREE.Group();
    elbow.position.set(side * 0.5, 0, 0);
    shoulder.add(elbow);
    const foreGeo = buildWingBone(side, 0.5, 0.46, 0.3, 0.04, 0.028, true);
    // secondaries: a dense, overlapping row of long flight feathers down the
    // trailing edge, plus a row of greater coverts over their bases — so the
    // forearm reads as layered feathers, not a smooth plate. Merged to one mesh.
    const secGeos: THREE.BufferGeometry[] = [foreGeo];
    for (let i = 0; i < 11; i++) {
      const t = i / 10;
      const fe = buildPrimary(side, 0.34 - 0.08 * t, 0.1, false);
      fe.rotateX(-0.2 - 0.04 * Math.sin(t * Math.PI)); // gentle scallop
      fe.translate(side * (0.04 + t * 0.42), -0.008, -0.15 - 0.025 * t);
      secGeos.push(fe);
    }
    for (let i = 0; i < 6; i++) { // greater coverts over the secondary bases
      const t = i / 5;
      const cv = buildCovert(0.13, 0.085, 0.45);
      cv.rotateX(-0.14);
      cv.translate(side * (0.06 + t * 0.36), 0.012, -0.06);
      secGeos.push(cv);
    }
    const elbowGeo = toCreasedNormals(this.mergeIndexed(secGeos), Math.PI * 0.5);
    elbow.add(new THREE.Mesh(elbowGeo, featherMat));

    // WRIST / hand — slim outer blade, with an ALULA (the little thumb-feather
    // tuft on the leading edge): a hallmark of a real wing, three short blades.
    const wrist = new THREE.Group();
    wrist.position.set(side * 0.5, 0, 0);
    elbow.add(wrist);
    const handParts: THREE.BufferGeometry[] = [buildWingBone(side, 0.34, 0.3, 0.16, 0.028, 0.016, false)];
    for (let i = 0; i < 3; i++) {
      const al = buildPrimary(side, 0.13 - 0.03 * i, 0.05, true);
      al.rotateZ(side * 0.14); // cocked up off the leading edge
      al.rotateY(side * (0.2 - i * 0.12));
      al.translate(side * (0.02 + i * 0.02), 0.018, 0.1); // leading edge, near wrist
      handParts.push(al);
    }
    const handGeo = toCreasedNormals(this.mergeIndexed(handParts), Math.PI * 0.55);
    wrist.add(new THREE.Mesh(handGeo, featherMat));

    // FAN — the long charcoal primaries splayed from the hand into the slotted,
    // finger-like wingtip of a soaring bird. The outer feathers are longest and
    // most separated (emarginated "fingers"), with primary coverts overlapping
    // their bases. These are the tips that trail and bend on the spring.
    const fan = new THREE.Group();
    fan.position.set(side * 0.32, 0, 0);
    wrist.add(fan);
    const fanGeos: THREE.BufferGeometry[] = [];
    const NPRI = 9;
    for (let i = 0; i < NPRI; i++) {
      const t = i / (NPRI - 1);
      // outermost (t→1) longest & narrowest → splayed fingers; inner ones shorter
      const len = 0.34 + 0.24 * t;
      const wid = 0.095 - 0.03 * t;
      const blade = buildPrimary(side, len, wid, true);
      // increasing rearward splay + slight individual separation = open slots
      blade.rotateZ(side * (-0.05 + t * 0.04));
      blade.rotateY(side * (-0.28 + t * 0.78 + 0.04 * Math.sin(t * 9))); // fan + jitter
      blade.rotateX(-0.04 - 0.05 * t); // outer fingers droop a touch more
      blade.translate(side * (0.005 + 0.02 * i), 0.002 * i, 0.04 - t * 0.2);
      fanGeos.push(blade);
    }
    for (let i = 0; i < 5; i++) { // primary coverts over the fan bases
      const t = i / 4;
      const cv = buildCovert(0.1, 0.07, 0.35);
      cv.rotateX(-0.1);
      cv.rotateY(side * (-0.1 + t * 0.3));
      cv.translate(side * (0.01 + t * 0.08), 0.014, 0.05);
      fanGeos.push(cv);
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
    // --- transform (the controller's contract) ---
    // The controller's `pitch` is +ve for a climb (forward.y = sin pitch). A
    // positive X-rotation, though, pitches the nose *down* (sends +Z → -Y), which
    // tilts the bird the wrong way: diving when climbing. We negate it on the X
    // axis so a climb tips the nose up and the camera (behind-and-above) sees more
    // of the bird's back; a dive tips the nose down and shows the belly. Yaw/roll
    // are unchanged, so the controller still owns heading and bank.
    this.root.position.copy(this.flight.position);
    this.root.rotation.set(-this.flight.pitch, this.flight.yaw, this.flight.roll, 'YXZ');

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

    // --- whole-body motion: the bird is never rigid. On top of the flap-coupled
    // heave we add a small fore/aft surge and a lateral sway, plus a slow idle
    // breathing drift that persists even on a dead glide so the mass always feels
    // alive and carried by the air. ---
    const idle = t * 0.9; // slow idle clock, independent of the flap energy
    // heave: rises as the wings drive down (lift), settles on recovery, lagged.
    this.bob.position.y = 0.075 * driveDown * amp - 0.028 * Math.cos(ph - BOB_LAG) * amp
      + 0.012 * Math.sin(idle * 0.8); // gentle ever-present float
    // surge: the body pulls forward slightly on the power stroke, eases back.
    this.bob.position.z = 0.035 * Math.sin(ph - 0.5) * amp;
    // sway: a soft side-to-side roll/translate, banking-coupled + idle.
    this.bob.position.x = 0.02 * Math.sin(idle * 0.6) - 0.03 * this.flight.roll;
    // pitch nod + a body roll that leans with the heave and the bank, and a
    // little yaw "fishtail" so the torso swims rather than holding stock-still.
    this.bob.rotation.x = 0.05 * Math.sin(ph - 0.35) * amp + 0.02 * Math.sin(idle * 0.7);
    this.bob.rotation.z = 0.06 * Math.sin(ph - 1.2) * amp - 0.08 * this.flight.roll;
    this.bob.rotation.y = 0.03 * Math.sin(idle * 0.5) + 0.04 * Math.sin(ph * 0.5 - 0.8) * amp;

    // --- torso flex: the body skin breathes against the wingbeat. On the loaded
    // downstroke the chest compresses and the breast lifts (the bird drawing power
    // through its core); on recovery it stretches long and slim. Implemented as a
    // gentle non-uniform scale + a tuck/extend pitch on the torso group, lagged a
    // hair behind the wings so the flesh follows the bones. ---
    const flex = Math.sin(ph - 0.3);
    const breath = 0.5 + 0.5 * Math.sin(idle * 1.1); // slow breathing even at rest
    this.torso.scale.set(
      1 + (0.05 * driveDown + 0.012 * breath) * amp + 0.006 * breath, // wider chest under load
      1 - 0.035 * driveDown * amp + 0.01 * breath, // squashes vertically on the down
      1 + 0.05 * Math.max(0, -flex) * amp, // elongates on the upstroke recovery
    );
    this.torso.rotation.x = 0.03 * flex * amp; // core tuck/extend

    // --- neck: an organic travelling wave runs down the S-curve (each joint lags
    // the one before it), so the neck undulates and breathes like a real supple
    // neck rather than a stiff bracket. The wave persists on a glide (idle) and
    // deepens with the flap; a slow lateral drift + bank-coupled yaw lets the head
    // glance into turns. The whole chain is keyed off its stored rest angles. ---
    const neckWave = (lag: number) =>
      0.05 * Math.sin(ph - lag) * amp + 0.03 * Math.sin(idle * 0.6 - lag * 0.5);
    const yawDrift = (lag: number) => 0.03 * Math.sin(idle * 0.45 - lag);
    this.neckBase.rotation.x = this.neckRest[0] + neckWave(0.0) * 0.7;
    this.neckBase.rotation.y = yawDrift(0.0) * 0.6;
    this.neck1.rotation.x = this.neckRest[1] + neckWave(0.5);
    this.neck1.rotation.y = yawDrift(0.5);
    this.neck2.rotation.x = this.neckRest[2] + neckWave(1.0);
    this.neck2.rotation.y = yawDrift(1.0) + 0.04 * this.flight.roll;
    this.neck3.rotation.x = this.neckRest[3] + neckWave(1.5) * 0.8;
    this.head.rotation.x = -0.04 * Math.sin(ph - 1.9) * amp + 0.02 * Math.sin(idle * 0.9);
    this.head.rotation.y = -0.06 * this.flight.roll + 0.025 * Math.sin(idle * 0.55); // glances into turns
    this.head.rotation.z = 0.04 * this.flight.roll; // slight head tilt into the bank
    this.billLower.rotation.x = 0.05 + 0.018 * driveDown; // bill cracks open under load

    // --- tail: biggest follow-through lag (steers + counter-balances) and acts
    // as a rudder, fanning into the bank. ---
    this.tail.rotation.x = -0.04 + 0.08 * Math.sin(ph - TAIL_LAG) * amp;
    this.tail.rotation.y = -0.22 * this.flight.roll;
    this.tail.rotation.z = 0.12 * this.flight.roll;

    // --- trailing legs & feet: the legs stream loosely behind, dangling lower on
    // the heave and swinging with the bank; the ankles add a second, lagged sway
    // and the webbed feet relax/paddle gently so the feet move organically rather
    // than being welded stiff. Each leg has its own slow phase so they're not in
    // lockstep. ---
    for (let i = 0; i < this.legs.length; i++) {
      const { hip, ankle, sgn } = this.legs[i];
      const lp = idle * 0.7 + i * 1.3; // per-leg slow clock
      hip.rotation.x = -0.35 + 0.05 * Math.cos(ph - BOB_LAG) * amp + 0.04 * driveDown * amp
        + 0.03 * Math.sin(lp);
      hip.rotation.z = 0.16 * this.flight.roll + sgn * (0.035 * Math.sin(lp * 0.8) + 0.02);
      // ankle lags the hip → the foot trails and paddles; toes relax open/closed
      ankle.rotation.x = 0.5 + 0.09 * Math.sin(lp - 0.7) + 0.05 * driveDown * amp;
      ankle.rotation.y = sgn * 0.05 * Math.sin(lp * 0.9 + 0.5);
      ankle.rotation.z = sgn * 0.04 * Math.sin(lp * 0.6);
    }
  }
}
