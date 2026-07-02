import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { F_STRIDE, U_STRIDE, T_GROUND } from './config.js';

// The player bird, redrawn as a red-crowned crane (grus japonensis) — the
// bird of Japanese screens and Monet's beloved japonisme: white body, black
// neck and trailing secondaries, a drop of crimson on the crown, long legs
// trailing behind. Painted with the same watercolor dabs as the landscape.
//
// Flight anatomy matters here: cranes fly with the neck fully EXTENDED
// (herons fold theirs), legs stretched straight back past the tail, and
// broad wings with slotted finger-tips. The animation gives the flap a
// span-wise travelling wave, an asymmetric (faster) downstroke, a raised
// dihedral glide, and a stabilised head that stays calm while the body works.

export const CRANE_SCALE = 1.24;

export const PART_BODY = 0;
export const PART_NECK = 1;
export const PART_HEAD = 2;
export const PART_LEG = 3;
export const PART_TAIL = 4;
export const PART_WING = 5;

const rnd = mulberry32(0xc0a11e5);
const col = new THREE.Color();
const _hsl = { h: 0, s: 0, l: 0 };

const WHITE = new THREE.Color(0.97, 0.96, 0.92);
const CREAM = new THREE.Color(0.94, 0.89, 0.79);
const VIOLET_SHADE = new THREE.Color(0.7, 0.7, 0.85);
const GREY_SHADE = new THREE.Color(0.8, 0.81, 0.86);
const INK = new THREE.Color(0.09, 0.1, 0.14);
const INK_SOFT = new THREE.Color(0.21, 0.23, 0.31);
const CROWN_RED = new THREE.Color(0.84, 0.16, 0.15);
const BILL_OLIVE = new THREE.Color(0.52, 0.5, 0.36);
const BILL_DARK = new THREE.Color(0.25, 0.24, 0.19);
const LEG_INK = new THREE.Color(0.15, 0.16, 0.2);

function jit(c, h = 0.012, s = 0.04, l = 0.045) {
  c.getHSL(_hsl);
  c.setHSL(
    (_hsl.h + (rnd() - 0.5) * 2 * h + 1) % 1,
    THREE.MathUtils.clamp(_hsl.s + (rnd() - 0.5) * 2 * s, 0, 1),
    THREE.MathUtils.clamp(_hsl.l + (rnd() - 0.5) * 2 * l, 0.04, 0.98)
  );
  return c;
}

export function buildCrane() {
  const dabs = [];
  const add = (x, y, z, size, angle, aspect, part, side = 0, sp = 0, tt = 0) => {
    dabs.push({
      x, y, z, r: col.r, g: col.g, b: col.b,
      size, angle, aspect, phase: rnd(), part, side, sp, tt,
    });
  };

  // ---- body: a white tapered hull, sunlit cream above, violet wash below ----
  for (let i = 0; i < 240; i++) {
    const z = -0.78 + rnd() * 1.34;
    const prof = Math.sqrt(Math.max(0.05, 1 - Math.pow((z + 0.12) / 0.72, 2)));
    const a = rnd() * Math.PI * 2;
    const rr = Math.sqrt(rnd());
    const x = Math.cos(a) * rr * 0.33 * prof;
    const y = Math.sin(a) * rr * 0.24 * prof + Math.sin((z + 0.6) * 1.8) * 0.03;
    const up = Math.max(0, Math.sin(a));
    const down = Math.max(0, -Math.sin(a));
    col.copy(WHITE)
      .lerp(CREAM, up * (0.24 + rnd() * 0.14))
      .lerp(VIOLET_SHADE, down * (0.34 + rnd() * 0.1) + Math.max(0, -z - 0.4) * 0.08);
    jit(col);
    add(x, y, z, 0.17 + rnd() * 0.14, rnd() * Math.PI, 0.4 + rnd() * 0.24, PART_BODY);
  }
  // sunlit breast wash
  for (let i = 0; i < 40; i++) {
    const z = 0.12 + rnd() * 0.44;
    const a = (rnd() - 0.5) * 2.4;
    col.copy(WHITE).lerp(CREAM, 0.3 + rnd() * 0.2);
    jit(col);
    add(Math.sin(a) * 0.2, -0.08 - Math.cos(a) * 0.1 + rnd() * 0.06, z,
      0.16 + rnd() * 0.1, rnd() * Math.PI, 0.5 + rnd() * 0.2, PART_BODY);
  }

  // ---- tail: short and white, with the black tertial "bustle" above it ----
  for (let i = 0; i < 46; i++) {
    const t = rnd();
    const x = (rnd() - 0.5) * (0.3 - t * 0.12);
    const y = -0.02 - t * 0.06 + (rnd() - 0.5) * 0.07;
    const z = -0.66 - t * 0.4;
    col.copy(WHITE).lerp(GREY_SHADE, 0.15 + t * 0.3).lerp(VIOLET_SHADE, t * 0.2);
    jit(col);
    add(x, y, z, 0.12 + (1 - t) * 0.1 + rnd() * 0.06,
      Math.PI / 2 + (rnd() - 0.5) * 0.4, 0.24 + rnd() * 0.14, PART_TAIL, 0, 0, t);
  }
  for (let i = 0; i < 18; i++) {
    const t = rnd();
    col.copy(INK).lerp(INK_SOFT, rnd() * 0.5);
    jit(col, 0.01, 0.03, 0.03);
    add((rnd() - 0.5) * 0.24, 0.08 + rnd() * 0.1 - t * 0.06, -0.5 - t * 0.42,
      0.13 + rnd() * 0.1, Math.PI / 2 + (rnd() - 0.5) * 0.5, 0.3 + rnd() * 0.2, PART_TAIL, 0, 0, t);
  }

  // ---- neck: fully extended, white at the base, black throat, white nape ----
  for (let i = 0; i < 130; i++) {
    const t = rnd();
    const rad = 0.085 * (1 - t * 0.38);
    const a = rnd() * Math.PI * 2;
    const rr = Math.sqrt(rnd());
    const ny = Math.sin(a) * rr * rad;
    const z = 0.5 + t * 1.16;
    const y = 0.06 + t * 0.1 - Math.sin(t * Math.PI) * 0.045 + ny;
    const x = Math.cos(a) * rr * rad;
    const nape = ny > rad * 0.3; // top ridge of the neck stays pale
    if (t < 0.3) {
      col.copy(WHITE).lerp(GREY_SHADE, t * 0.5);
    } else if (nape && t < 0.9) {
      col.copy(WHITE).lerp(CREAM, 0.2);
    } else {
      col.copy(INK).lerp(INK_SOFT, rnd() * 0.45);
    }
    jit(col, 0.008, 0.03, 0.035);
    add(x, y, z, (0.09 + rnd() * 0.06) * (1 - t * 0.3),
      Math.PI / 2 + (rnd() - 0.5) * 0.3, 0.2 + rnd() * 0.15, PART_NECK, 0, 0, t);
  }

  // ---- head: black cheeks, white nape, crimson crown, olive bill ----
  for (let i = 0; i < 54; i++) {
    const a = rnd() * Math.PI * 2;
    const u = rnd() * 2 - 1;
    const sq = Math.sqrt(1 - u * u);
    const hx = sq * Math.cos(a) * 0.095;
    const hy = u * 0.08;
    const hz = sq * Math.sin(a) * 0.115;
    if (hy > 0.035 && hz > -0.05 && hz < 0.07) col.copy(CROWN_RED).lerp(new THREE.Color(1, 0.4, 0.3), rnd() * 0.2);
    else if (hz < -0.02 && hy > -0.02) col.copy(WHITE).lerp(CREAM, rnd() * 0.25);
    else col.copy(INK).lerp(INK_SOFT, rnd() * 0.4);
    jit(col, 0.008, 0.03, 0.03);
    add(hx, 0.2 + hy, 1.74 + hz, 0.055 + rnd() * 0.045, rnd() * Math.PI, 0.34 + rnd() * 0.2, PART_HEAD);
  }
  // crown accent — a soft red drop that reads from far away
  col.copy(CROWN_RED);
  add(0, 0.27, 1.74, 0.1, 0, 0.6, PART_HEAD);
  // eyes
  for (const s of [-1, 1]) {
    col.copy(INK);
    add(s * 0.075, 0.22, 1.81, 0.04, 0, 0.7, PART_HEAD);
  }
  // bill
  for (let i = 0; i < 26; i++) {
    const t = rnd();
    col.copy(BILL_OLIVE).lerp(BILL_DARK, t * 0.55 + rnd() * 0.15);
    jit(col, 0.008, 0.03, 0.03);
    add((rnd() - 0.5) * 0.035 * (1 - t * 0.6), 0.17 - t * 0.055 + (rnd() - 0.5) * 0.02, 1.87 + t * 0.48,
      0.05 + (1 - t) * 0.025 + rnd() * 0.02, Math.PI / 2 + (rnd() - 0.5) * 0.16, 0.13 + rnd() * 0.06, PART_HEAD);
  }

  // ---- wings ----
  const halfspanX = (sp) => 0.16 + sp * 2.46;
  const chordW = (sp) => sp < 0.72 ? 0.9 - 0.35 * sp : 0.648 - (sp - 0.72) * 1.6;
  const chordC = (sp) => 0.22 - sp * sp * 0.5;
  const camber = (sp) => Math.sin(Math.min(sp * 1.1, 1) * Math.PI) * 0.09;

  for (const side of [-1, 1]) {
    // upper coverts: broad white washes with cream light and violet shade
    for (let i = 0; i < 140; i++) {
      const sp = Math.pow(rnd(), 0.72) * 0.97;
      const w = chordW(sp);
      const chn = (rnd() * 2 - 1) * 0.82;
      const z = chordC(sp) + chn * w * 0.5;
      const y = camber(sp) + (1 - Math.abs(chn)) * 0.02 + (rnd() - 0.5) * 0.05;
      const mood = rnd();
      col.copy(WHITE);
      if (mood < 0.22) col.lerp(CREAM, 0.3 + rnd() * 0.2);
      else if (mood < 0.42) col.lerp(VIOLET_SHADE, 0.22 + rnd() * 0.16);
      else if (mood < 0.52) col.lerp(GREY_SHADE, 0.3);
      jit(col);
      add(side * halfspanX(sp), y, z, (0.22 + rnd() * 0.14) * (1 - sp * 0.3),
        side * 0.15 + (rnd() - 0.5) * 0.34, 0.36 + rnd() * 0.24, PART_WING, side, sp);
    }
    // black secondaries: the crane's signature dark trailing edge, inner wing
    for (let i = 0; i < 62; i++) {
      const sp = 0.05 + rnd() * 0.5;
      const w = chordW(sp);
      const chn = -0.45 - rnd() * 0.55;
      const z = chordC(sp) + chn * w * 0.5;
      const y = camber(sp) * 0.9 + (rnd() - 0.5) * 0.04;
      col.copy(INK).lerp(INK_SOFT, rnd() * 0.55).lerp(VIOLET_SHADE, rnd() * 0.12);
      jit(col, 0.01, 0.03, 0.035);
      add(side * halfspanX(sp), y, z, 0.24 + rnd() * 0.16,
        Math.PI / 2 + (rnd() - 0.5) * 0.3 - side * 0.12, 0.16 + rnd() * 0.1, PART_WING, side, sp);
    }
    // white primaries sweeping toward the tip
    for (let i = 0; i < 64; i++) {
      const sp = 0.55 + rnd() * 0.45;
      const w = chordW(sp);
      const chn = -0.2 - rnd() * 0.75;
      const z = chordC(sp) + chn * w * 0.5;
      const y = camber(sp) + (rnd() - 0.5) * 0.04;
      col.copy(WHITE).lerp(GREY_SHADE, Math.max(0, sp - 0.75) * 1.4 * rnd());
      jit(col);
      add(side * halfspanX(sp), y, z, 0.2 + rnd() * 0.14,
        Math.PI / 2 - side * (0.18 + sp * 0.4) + (rnd() - 0.5) * 0.26, 0.14 + rnd() * 0.1, PART_WING, side, sp);
    }
    // slotted finger tips: seven long separated feathers
    for (let f = 0; f < 7; f++) {
      const spf = 0.8 + f * 0.032;
      const baseX = halfspanX(spf);
      const baseZ = chordC(spf) - chordW(spf) * 0.2;
      const splay = (f - 3) * 0.12;
      const len = 0.56 - Math.abs(f - 3) * 0.05;
      for (let k = 0; k < 3; k++) {
        const t = (k + 0.5) / 3;
        col.copy(WHITE).lerp(GREY_SHADE, t * 0.35 + (f > 4 ? 0.15 : 0));
        if (k === 2) col.lerp(INK_SOFT, 0.22); // a whisper of ink at the very tip
        jit(col, 0.006, 0.02, 0.03);
        add(side * (baseX + t * len * 0.55), camber(spf) + t * 0.05 + f * 0.008,
          baseZ - t * len * (0.55 + Math.abs(splay)),
          0.3 - t * 0.06, Math.PI / 2 - side * (0.3 + splay), 0.09 + rnd() * 0.03,
          PART_WING, side, Math.min(1, spf + t * 0.15));
      }
    }
    // leading-edge contour: a drawn line of pale grey along the wing front
    for (let i = 0; i < 24; i++) {
      const sp = rnd() * 0.9;
      const z = chordC(sp) + chordW(sp) * 0.46;
      col.copy(GREY_SHADE).lerp(WHITE, rnd() * 0.4);
      jit(col, 0.006, 0.02, 0.03);
      add(side * halfspanX(sp), camber(sp) + 0.025, z, 0.16 + rnd() * 0.08,
        side * 0.14 + (rnd() - 0.5) * 0.14, 0.13 + rnd() * 0.05, PART_WING, side, sp);
    }
    // shoulder blend into the torso
    for (let i = 0; i < 26; i++) {
      const t = rnd();
      col.copy(WHITE).lerp(CREAM, rnd() * 0.2).lerp(VIOLET_SHADE, rnd() * 0.14);
      jit(col);
      add(side * (0.1 + t * 0.3), 0.04 + Math.sin(t * Math.PI) * 0.05 + (rnd() - 0.5) * 0.05,
        -0.15 + rnd() * 0.5, 0.18 + rnd() * 0.1, side * 0.2 + (rnd() - 0.5) * 0.3,
        0.4 + rnd() * 0.2, PART_WING, side, t * 0.12);
    }
  }

  // ---- legs: long, ink-dark, trailing straight behind past the tail ----
  for (const side of [-1, 1]) {
    for (let i = 0; i < 34; i++) {
      const t = rnd();
      col.copy(LEG_INK).lerp(INK_SOFT, rnd() * 0.3);
      jit(col, 0.006, 0.02, 0.025);
      add(side * (0.12 - t * 0.02) + (rnd() - 0.5) * 0.02,
        -0.15 - t * 0.15 + (rnd() - 0.5) * 0.02,
        -0.42 - t * 1.18,
        0.05 + rnd() * 0.03 + (t < 0.25 ? 0.03 : 0), // feathered thigh slightly thicker
        Math.PI / 2 + (rnd() - 0.5) * 0.12, 0.13 + rnd() * 0.05, PART_LEG, side, 0, t);
    }
    for (let toe = -1; toe <= 1; toe++) {
      for (let k = 0; k < 3; k++) {
        const t = (k + 1) / 3;
        col.copy(LEG_INK);
        add(side * 0.1 + toe * t * 0.045, -0.3 - t * 0.02, -1.6 - t * 0.12,
          0.035, Math.PI / 2 + toe * 0.3, 0.12, PART_LEG, side, 0, 1);
      }
    }
  }

  return dabs;
}

/** Write the static half of every dab (color, size, aspect, type, phase). */
export function initCraneStatic(dabs, F, U) {
  for (let i = 0; i < dabs.length; i++) {
    const d = dabs[i];
    const fo = i * F_STRIDE;
    F[fo + 3] = d.size * 1.32; // painterly size boost, matches old bird presence
    const uo = i * U_STRIDE;
    U[uo] = Math.min(255, Math.max(0, d.r * 255) | 0);
    U[uo + 1] = Math.min(255, Math.max(0, d.g * 255) | 0);
    U[uo + 2] = Math.min(255, Math.max(0, d.b * 255) | 0);
    U[uo + 3] = Math.min(255, d.aspect * 255) | 0;
    U[uo + 4] = T_GROUND; // no wind/wake response — the crane is the wind
    U[uo + 5] = (d.phase * 255) | 0;
    U[uo + 6] = 0;
  }
}

// Scratch for the head rotation
const clamp = THREE.MathUtils.clamp;

/**
 * Animate the crane into its interleaved float buffer (pos + angle).
 * Reads flight.{x,y,z,forward,right,up,roll,pitch,swing,speedCue,motion,
 * wingPhase,wingPower,wingFlex} — wing state itself is advanced here.
 */
export function updateCrane(F, dabs, flight, t, dt) {
  const motion = flight.motion;
  const pitchCue = clamp(flight.speedCue, -1, 1);
  const climbCue = THREE.MathUtils.smoothstep(pitchCue, 0.06, 0.82);
  const glideCue = THREE.MathUtils.smoothstep(-pitchCue, 0.04, 0.78);
  const bankCue = clamp(flight.swing, -1, 1);

  // stately crane cadence: quicker when climbing, near-still on a glide
  const cadenceTarget = clamp(0.34 + motion * 0.1 + climbCue * 0.22 - glideCue * 0.26, 0.1, 0.66);
  const powerTarget = clamp(0.3 + motion * 0.22 + climbCue * 0.34 - glideCue * 0.4, 0.05, 0.85);
  const flexTarget = clamp(0.45 + motion * 0.18 + climbCue * 0.2 - glideCue * 0.14, 0.24, 0.8);
  flight.wingCadence += (cadenceTarget - flight.wingCadence) * (1 - Math.exp(-dt * 2.2));
  flight.wingPower += (powerTarget - flight.wingPower) * (1 - Math.exp(-dt * 2.8));
  flight.wingFlex += (flexTarget - flight.wingFlex) * (1 - Math.exp(-dt * 2.6));
  flight.wingPhase = (flight.wingPhase + dt * flight.wingCadence * Math.PI * 2) % (Math.PI * 2);

  const P = flight.wingPhase;
  // asymmetric stroke: the downbeat is faster than the recovery
  const wave = (ph) => Math.sin(ph + 0.45 * Math.sin(ph));
  const power = flight.wingPower;
  const dihedral = glideCue * 0.3;
  const heave = -wave(P) * 0.055 * power; // body answers the wingbeat…
  const settle = Math.sin(t * 0.8 + 0.6) * 0.05 * (0.3 + motion * 0.7) * (1 - glideCue * 0.6);

  const fwd = flight.forward, right = flight.right, up = flight.up;
  const cx = flight.x;
  const cy = flight.y + Math.sin(t * 1.05) * 0.14;
  const cz = flight.z;

  // head aims gently into the turn and against the dive, and stays level
  const headYaw = clamp(-flight.roll * 0.5 + Math.sin(t * 1.2) * 0.04, -0.42, 0.42);
  const headPitch = clamp(-flight.pitch * 0.4 + Math.sin(t * 1.5 + 0.7) * 0.03, -0.24, 0.24);
  const cyaw = Math.cos(headYaw), syaw = Math.sin(headYaw);
  const cpit = Math.cos(headPitch), spit = Math.sin(headPitch);
  const pivX = 0, pivY = 0.16, pivZ = 1.62;

  const legDroop = (1 - motion) * 0.3 + climbCue * 0.12;

  for (let i = 0; i < dabs.length; i++) {
    const d = dabs[i];
    let x = d.x, y = d.y, z = d.z;
    let ang = d.angle;

    if (d.part === PART_WING) {
      const sp = d.sp;
      const phL = P - sp * 0.95;             // travelling wave root -> tip
      const w = wave(phL);
      const amp = power * (0.1 + Math.pow(sp, 1.22) * 1.0);
      const tipFlex = Math.pow(sp, 2.0) * flight.wingFlex;
      y += w * amp + settle * (0.3 + sp)
         + dihedral * sp                      // raised V on the glide
         + bankCue * d.side * (0.06 + sp * 0.24) * (0.4 + motion * 0.6)
         + wave(phL - 0.55) * tipFlex * 0.18; // trailing flex follows through
      z += -Math.cos(phL) * 0.1 * sp * power  // forward sweep on the downbeat
         - sp * sp * 0.24 * glideCue;         // tips swept back when gliding
      x += -d.side * sp * 0.12 * glideCue
         + d.side * Math.sin(P + d.phase * 0.7) * sp * 0.04 * power;
      ang += d.side * (w * 0.15 + bankCue * (0.05 + sp * 0.08) + glideCue * 0.04)
           + wave(phL - 0.4) * tipFlex * 0.3;
      y += heave * 0.4;
    } else if (d.part === PART_HEAD) {
      let hx = x - pivX, hy = y - pivY, hz = z - pivZ;
      let tx = hx * cyaw + hz * syaw;
      let tz = -hx * syaw + hz * cyaw;
      hx = tx; hz = tz;
      let ty = hy * cpit - hz * spit;
      tz = hy * spit + hz * cpit;
      hy = ty; hz = tz;
      x = pivX + hx + Math.sin(t * 2.0 + d.phase * 6.28) * 0.012;
      y = pivY + hy + heave * 0.1; // stabilised: the head rides level
      z = pivZ + hz + Math.cos(t * 1.1 + d.phase * 4.0) * 0.015;
    } else if (d.part === PART_NECK) {
      const nt = d.tt;
      const follow = Math.pow(nt, 1.5);
      x += headYaw * 0.22 * follow + Math.sin(t * 1.8 + d.phase * 6.28) * 0.012 * nt;
      y += headPitch * 0.1 * follow + heave * (1 - nt * 0.88);
      z += Math.cos(t * 1.35 + d.phase * 5.1) * 0.012 * nt;
    } else if (d.part === PART_LEG) {
      const lt = d.tt;
      y += heave - legDroop * lt * 0.34 + Math.sin(t * 2.6 + lt * 3.0 + d.side) * 0.012 * lt;
      z += glideCue * lt * 0.05;
      ang += -legDroop * 0.3 * lt;
    } else if (d.part === PART_TAIL) {
      const tt = d.tt;
      x += -flight.roll * 0.12 * tt;
      y += heave + (-flight.pitch * 0.12 + Math.abs(wave(P)) * 0.03) * tt
         + Math.sin(t * 1.45 + d.phase * 6.28) * 0.012 * tt;
    } else {
      y += heave + Math.sin(t * 1.7 + d.phase * 6.28) * 0.02;
    }

    x *= CRANE_SCALE; y *= CRANE_SCALE; z *= CRANE_SCALE;
    const fo = i * F_STRIDE;
    F[fo] = cx + right.x * x + up.x * y + fwd.x * z;
    F[fo + 1] = cy + right.y * x + up.y * y + fwd.y * z;
    F[fo + 2] = cz + right.z * x + up.z * y + fwd.z * z;
    F[fo + 4] = ang;
  }
}
