import * as THREE from 'three/webgpu';
import { Updatable } from '../core/Engine';
import { FlightController } from './FlightController';
import { palette } from '../render/palette';
import { SUN_DIR } from '../config';

// A procedural, pelican-derived hero bird — articulated Group hierarchy (no
// skinning) of plain MeshStandardMaterial parts with baked vertex-colour shading,
// driven by a slow, weighty, asymmetric flap with proximal→distal phase lag and
// underdamped springs on the primary feathers so the wingtips trail and settle.
// Great white pelican read: warm-white body, long warm bill + sagging gular
// pouch, retracted S-neck tucking the head over the shoulders, broad wings with
// black outer flight feathers. Built in local "real" metres, scaled up for the
// chase cam. Nose +Z, up +Y, wings along ±X.

const TAU = Math.PI * 2;
const FLAP_FREQ = 0.5; // Hz — slow & weighty
const STIFF_K = 55;
const DAMP_C = 12.6; // ~2·√K·0.85, slightly underdamped → tips overshoot & settle
const ELBOW_LAG = 0.9;
const WRIST_LAG = 1.6;
const BOB_LAG = 0.6;
const TAIL_LAG = 1.0;
const SCALE = 3.0;

const SUN = new THREE.Vector3(...SUN_DIR).normalize();

// palette
const C_BODY = new THREE.Color('#f4f7ee'); // warm white
const C_BODY_TOP = new THREE.Color('#fff6df'); // sun tint
const C_FEATHER = new THREE.Color('#1a1c22'); // black flight feathers
const C_SHEEN = new THREE.Color('#3a4150'); // cool blue-grey edge
const C_COVERT = new THREE.Color('#e8ebe0'); // pale grey-white inner wing
const C_BILL = new THREE.Color('#f2c14e');
const C_BILL_TIP = new THREE.Color('#e08a3c');
const C_NAIL = new THREE.Color('#c0392b');
const C_POUCH = new THREE.Color('#f6a96b');
const C_EYE = new THREE.Color('#15110d');

// ---- baking helpers ----
type PaintFn = (
  c: THREE.Color, x: number, y: number, z: number,
  nx: number, ny: number, nz: number, bb: THREE.Box3,
) => void;

function paint(geo: THREE.BufferGeometry, fn: PaintFn): THREE.BufferGeometry {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    fn(c, pos.getX(i), pos.getY(i), pos.getZ(i), nrm.getX(i), nrm.getY(i), nrm.getZ(i), bb);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

const sunlit = (nx: number, ny: number, nz: number, amt = 0.1) =>
  1 + amt * Math.max(0, nx * SUN.x + ny * SUN.y + nz * SUN.z);

/** A flat quad (two tris, non-indexed) from four corners; normals computed. */
function quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): THREE.BufferGeometry {
  const p = new Float32Array([
    a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z,
    a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z,
  ]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}

/** Wing membrane blade: root at x=0, tip at x=side·len; chord runs along ±Z. */
function membrane(len: number, rootC: number, tipC: number, side: number): THREE.BufferGeometry {
  const g = quad(
    new THREE.Vector3(0, 0, rootC * 0.5),
    new THREE.Vector3(0, 0, -rootC * 0.5),
    new THREE.Vector3(side * len, 0, -tipC * 0.5),
    new THREE.Vector3(side * len, 0, tipC * 0.5),
  );
  return paint(g, (c, x) => {
    const f = Math.min(1, Math.abs(x) / len); // 0 root → 1 tip
    c.copy(C_COVERT).lerp(C_FEATHER, Math.max(0, (f - 0.45) / 0.55) * 0.85).multiplyScalar(0.95);
  });
}

/** Feather card: length along side·X from the pivot, width along Z; flat (+Y). */
function featherCard(len: number, width: number, side: number, dark: boolean): THREE.BufferGeometry {
  const g = quad(
    new THREE.Vector3(0, 0, width * 0.5),
    new THREE.Vector3(0, 0, -width * 0.5),
    new THREE.Vector3(side * len, 0, -width * 0.35),
    new THREE.Vector3(side * len, 0, width * 0.35),
  );
  return paint(g, (c, x, _y, _z, nx, ny, nz) => {
    const f = Math.min(1, Math.abs(x) / len);
    if (dark) c.copy(C_FEATHER).lerp(C_SHEEN, f * 0.6);
    else c.copy(C_COVERT).lerp(C_FEATHER, Math.max(0, (f - 0.6) / 0.4) * 0.7);
    c.multiplyScalar(sunlit(nx, ny, nz, 0.12) * 0.95);
  });
}

/** Tapered wedge bill along +Z (base at z=0), with a tiny drooped nail at tip. */
function billWedge(len: number, bw: number, bh: number, tw: number, droop: number): THREE.BufferGeometry {
  const z1 = len;
  const ty = -droop; // tip droops down
  // 8 corners: base (z=0) ±bw,±bh ; tip (z=len) ±tw, ty±0.012
  const B = [
    new THREE.Vector3(-bw, bh, 0), new THREE.Vector3(bw, bh, 0),
    new THREE.Vector3(bw, -bh, 0), new THREE.Vector3(-bw, -bh, 0),
  ];
  const T = [
    new THREE.Vector3(-tw, ty + 0.012, z1), new THREE.Vector3(tw, ty + 0.012, z1),
    new THREE.Vector3(tw, ty - 0.012, z1), new THREE.Vector3(-tw, ty - 0.012, z1),
  ];
  const geos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    geos.push(quad(B[i], B[j], T[j], T[i]));
  }
  geos.push(quad(B[3], B[2], B[1], B[0])); // base cap
  geos.push(quad(T[0], T[1], T[2], T[3])); // tip cap
  const merged = mergeAll(geos);
  return paint(merged, (c, _x, _y, z) => {
    const f = z / len;
    if (f > 0.92) c.copy(C_NAIL);
    else c.copy(C_BILL).lerp(C_BILL_TIP, f);
    c.multiplyScalar(0.95);
  });
}

/** Sagging gular pouch: a V-trough hanging under the lower mandible along +Z. */
function gularPouch(len: number, sag: number): THREE.BufferGeometry {
  const N = 9;
  const rows: THREE.Vector3[][] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const z = t * len;
    const env = Math.sin(Math.PI * t); // 0 at ends, 1 mid
    const hw = 0.012 + 0.07 * env;
    const topY = -0.03;
    const botY = topY - sag * env;
    rows.push([
      new THREE.Vector3(-hw, topY, z),
      new THREE.Vector3(0, botY, z),
      new THREE.Vector3(hw, topY, z),
    ]);
  }
  const geos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < N - 1; i++) {
    const a = rows[i]; const b = rows[i + 1];
    geos.push(quad(a[0], a[1], b[1], b[0]));
    geos.push(quad(a[1], a[2], b[2], b[1]));
  }
  const merged = mergeAll(geos);
  return paint(merged, (c, _x, y) => {
    // underside brighter — reads as a glowing translucent sac
    c.copy(C_POUCH).multiplyScalar((y < -0.05 ? 1.06 : 0.92) * 0.95);
  });
}

/** Concatenate non-indexed position/normal geometries (colours baked later). */
function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const P = new Float32Array(total * 3);
  const Nn = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) {
    if (!g.attributes.normal) g.computeVertexNormals();
    P.set(g.attributes.position.array as Float32Array, o);
    Nn.set(g.attributes.normal.array as Float32Array, o);
    o += g.attributes.position.count * 3;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(Nn, 3));
  return out;
}

function smooth01(s: number): number {
  const x = s * 0.5 + 0.5;
  return x * x * (3 - 2 * x);
}

interface Wing {
  S: THREE.Group; E: THREE.Group; W: THREE.Group; fan: THREE.Group;
  sgn: number; springPos: number; springVel: number;
}

export class Bird implements Updatable {
  private flight: FlightController;
  private root = new THREE.Group();
  private bob = new THREE.Group();
  private neck1!: THREE.Group;
  private neck2!: THREE.Group;
  private head!: THREE.Group;
  private billLower!: THREE.Group;
  private tail!: THREE.Group;
  private wings: Wing[] = [];
  private phase = 0;

  constructor(scene: THREE.Scene, flight: FlightController) {
    this.flight = flight;

    const plumeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0 });
    const featherMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.5, metalness: 0, flatShading: true, side: THREE.DoubleSide,
      emissive: new THREE.Color('#3a4150'), emissiveIntensity: 0.04,
    });
    const billMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0, flatShading: true });
    const pouchMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0, flatShading: true, side: THREE.DoubleSide });
    const eyeMat = new THREE.MeshStandardMaterial({ color: C_EYE, roughness: 0.3, metalness: 0 });

    this.root.add(this.bob);

    // ---- body (lathe teardrop, long axis +Z) ----
    const profile: THREE.Vector2[] = [];
    for (let k = 0; k < 24; k++) {
      const u = k / 23;
      const y = -0.85 + u * 1.7;
      const baseR = 0.02 * (1 - u) + 0.13 * u;
      const bulge = 0.26 * Math.exp(-((u - 0.6) ** 2) / (2 * 0.13 ** 2));
      profile.push(new THREE.Vector2(Math.max(0.015, baseR + bulge), y));
    }
    const bodyGeo = new THREE.LatheGeometry(profile, 22);
    bodyGeo.rotateX(Math.PI / 2); // +Y → +Z (neck toward +Z)
    bodyGeo.computeVertexNormals();
    paint(bodyGeo, (c, _x, y, _z, nx, ny, nz, bb) => {
      const top = (y - bb.min.y) / Math.max(1e-3, bb.max.y - bb.min.y);
      c.copy(C_BODY).lerp(C_BODY_TOP, top * 0.18);
      c.multiplyScalar((y < -0.02 ? 0.84 : 1.0) * sunlit(nx, ny, nz, 0.12) * 0.95);
    });
    this.bob.add(new THREE.Mesh(bodyGeo, plumeMat));

    // ---- neck (retracted S) + head ----
    const neckBase = new THREE.Group();
    neckBase.position.set(0, 0.1, 0.8);
    neckBase.rotation.x = 0.95;
    this.bob.add(neckBase);
    neckBase.add(new THREE.Mesh(this.neckSeg(0.15, 0.22, plumeMat), plumeMat));

    this.neck1 = new THREE.Group();
    this.neck1.position.set(0, 0, 0.22);
    this.neck1.rotation.x = -1.15;
    neckBase.add(this.neck1);
    this.neck1.add(new THREE.Mesh(this.neckSeg(0.12, 0.2, plumeMat), plumeMat));

    this.neck2 = new THREE.Group();
    this.neck2.position.set(0, 0, 0.2);
    this.neck2.rotation.x = 0.55;
    this.neck1.add(this.neck2);
    this.neck2.add(new THREE.Mesh(this.neckSeg(0.095, 0.13, plumeMat), plumeMat));

    this.head = new THREE.Group();
    this.head.position.set(0, 0, 0.13);
    this.neck2.add(this.head);
    const headGeo = new THREE.SphereGeometry(0.13, 16, 12);
    headGeo.scale(0.95, 1.0, 1.3);
    paint(headGeo, (c, _x, _y, _z, nx, ny, nz) => { c.copy(C_BODY).multiplyScalar(sunlit(nx, ny, nz, 0.12) * 0.95); });
    this.head.add(new THREE.Mesh(headGeo, plumeMat));

    const eyeGeo = new THREE.SphereGeometry(0.018, 8, 6);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(sx * 0.058, 0.03, 0.06);
      this.head.add(eye);
    }

    // bill: upper fixed, lower on a jaw pivot, pouch under lower
    const billUpper = new THREE.Mesh(billWedge(0.46, 0.085, 0.045, 0.014, 0.0), billMat);
    billUpper.position.set(0, 0.005, 0.15);
    billUpper.rotation.x = 0.05;
    this.head.add(billUpper);

    this.billLower = new THREE.Group();
    this.billLower.position.set(0, -0.02, 0.15);
    this.billLower.rotation.x = 0.05;
    this.head.add(this.billLower);
    this.billLower.add(new THREE.Mesh(billWedge(0.44, 0.078, 0.03, 0.012, 0.01), billMat));
    this.billLower.add(new THREE.Mesh(gularPouch(0.34, 0.085), pouchMat));

    // ---- tail (very short fan) ----
    this.tail = new THREE.Group();
    this.tail.position.set(0, 0.02, -0.84);
    this.tail.rotation.x = -0.05;
    this.bob.add(this.tail);
    for (let i = 0; i < 7; i++) {
      const card = new THREE.Mesh(featherCard(0.2, 0.06, -1, false), featherMat);
      card.rotation.y = (i - 3) * 0.12; // fan
      this.tail.add(card);
    }

    // ---- wings ----
    this.wings.push(this.buildWing(+1, featherMat));
    this.wings.push(this.buildWing(-1, featherMat));

    this.root.scale.setScalar(SCALE);
    this.root.traverse((o) => { o.frustumCulled = false; });
    scene.add(this.root);
  }

  private neckSeg(r: number, len: number, _mat: THREE.Material): THREE.BufferGeometry {
    const g = new THREE.CapsuleGeometry(r, len, 4, 8);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, len / 2);
    return paint(g, (c, _x, _y, _z, nx, ny, nz) => { c.copy(C_BODY).multiplyScalar(sunlit(nx, ny, nz, 0.12) * 0.95); });
  }

  private buildWing(side: number, featherMat: THREE.Material): Wing {
    const S = new THREE.Group();
    S.position.set(side * 0.155, 0.055, 0.1);
    this.bob.add(S);
    S.add(new THREE.Mesh(membrane(0.46, 0.52, 0.44, side), featherMat));

    const E = new THREE.Group();
    E.position.set(side * 0.46, 0, 0);
    S.add(E);
    E.add(new THREE.Mesh(membrane(0.52, 0.44, 0.32, side), featherMat));
    // secondaries along the forearm trailing edge (broad, overlapping)
    for (let i = 0; i < 8; i++) {
      const card = new THREE.Mesh(featherCard(0.3, 0.1, side, i > 5), featherMat);
      card.position.set(side * (0.05 + i * 0.06), 0, -0.13);
      card.rotation.x = -0.26;
      card.rotation.y = side * (i - 3.5) * 0.02;
      E.add(card);
    }

    const W = new THREE.Group();
    W.position.set(side * 0.52, 0, 0);
    E.add(W);
    W.add(new THREE.Mesh(membrane(0.42, 0.32, 0.2, side), featherMat));

    const fan = new THREE.Group();
    W.add(fan);
    for (let i = 0; i < 9; i++) {
      const dark = i >= 3; // outer flight feathers black
      const card = new THREE.Mesh(featherCard(0.42, 0.075, side, dark), featherMat);
      card.position.set(side * (0.03 + i * 0.035), 0, 0);
      card.rotation.y = side * (-0.18 + i * 0.07);
      card.rotation.x = -0.05;
      fan.add(card);
    }

    return { S, E, W, fan, sgn: side, springPos: 0, springVel: 0 };
  }

  update(dt: number, t: number) {
    this.root.position.copy(this.flight.position);
    this.root.rotation.set(this.flight.pitch, this.flight.yaw, this.flight.roll, 'YXZ');

    this.phase += TAU * FLAP_FREQ * dt;
    const ph = this.phase;

    // glide-hold: occasionally damp the flap toward a soaring hold (never metronomic)
    const glide = 0.55 + 0.45 * smooth01(Math.sin(TAU * 0.06 * t));
    const amp = 0.1 + 0.9 * glide;

    // asymmetric drive — sharp loaded downstroke, slower lifted recovery
    const drive = Math.sin(ph) - 0.35 * Math.sin(2 * ph);
    const shoulder = 0.18 + 0.52 * drive * amp; // rest dihedral so the V reads from behind
    const sweep = 0.1 * Math.sin(ph - 0.5) * amp;
    const dl = Math.sin(ph - ELBOW_LAG) - 0.35 * Math.sin(2 * (ph - ELBOW_LAG));
    const elbow = -0.18 + 0.45 * dl * amp + 0.3 * Math.max(0, -drive) * amp;
    const wrist = -0.22 + 0.4 * Math.sin(ph - WRIST_LAG) * amp;

    for (const w of this.wings) {
      const s = w.sgn;
      w.S.rotation.z = s * shoulder + 0.12 * this.flight.roll * s;
      w.S.rotation.y = s * sweep;
      w.E.rotation.z = s * elbow;
      w.W.rotation.z = s * wrist;
      // primary-tip lag: an underdamped spring chasing the wrist angle
      const a = STIFF_K * (wrist - w.springPos) - DAMP_C * w.springVel;
      w.springVel += a * dt;
      w.springPos += w.springVel * dt;
      if (!isFinite(w.springPos)) { w.springPos = 0; w.springVel = 0; }
      w.fan.rotation.z = s * (w.springPos * 0.6);
      w.fan.rotation.x = 0.4 * w.springVel; // feathering twist on reversal (symmetric)
    }

    // body lift bob (small, lagged) + tiny pitch nod
    this.bob.position.y = 0.055 * Math.cos(ph - BOB_LAG) * amp;
    this.bob.rotation.x = 0.035 * Math.sin(ph - 0.4) * amp;

    // neck breathe + head counter (heavy-bill inertia) + bill barely opens
    this.neck1.rotation.x = -1.15 + 0.05 * Math.sin(ph * 0.5) * amp;
    this.head.rotation.x = -0.04 * Math.sin(ph * 0.5 - 0.5) * amp;
    this.billLower.rotation.x = 0.05 + 0.02 * Math.max(0, Math.sin(ph));

    // tail follow-through (largest lag) + slight rudder with roll
    this.tail.rotation.x = -0.05 + 0.07 * Math.sin(ph - TAIL_LAG) * amp;
    this.tail.rotation.y = -0.2 * this.flight.roll;
  }
}
