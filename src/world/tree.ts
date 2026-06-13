import * as THREE from 'three/webgpu';
import { mulberry32, hash2 } from '../core/rng';
import { palette } from '../render/palette';
import { TerrainField } from './TerrainField';
import { CHUNK_SIZE, WORLD_SEED } from '../config';

// Procedural tree generator. Each tree is a recursive branching skeleton built
// from tapered cylinders (a real trunk + boughs) topped with a canopy of splat
// dabs — keeping foliage in the same painterly point-cloud language as the
// terrain while the trunk stays solid geometry.
//
// To stay cheap we generate a handful of seeded PROTOTYPES once (stored in
// local space, base at the origin). Chunks then scatter instances by rotating /
// scaling / tinting the prototype arrays directly — no per-tree geometry
// allocation, no repetition (variation comes from instance transform + which of
// many prototypes is picked).

export type TreeType = 'deciduous' | 'conifer' | 'bush';

export interface TreeProto {
  type: TreeType;
  trunkPos: Float32Array;
  trunkNor: Float32Array;
  trunkCol: Float32Array;
  folPos: Float32Array; // xyz per canopy dab (local)
  folScale: Float32Array;
  folCol: Float32Array;
  folWind: Float32Array; // per-dab sway strength
  folAngle: Float32Array; // per-dab stroke orientation
  folAspect: Float32Array; // per-dab stroke width/length
  height: number;
  canopyR: number; // for spacing
}

// ---- scratch ----
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _up = new THREE.Vector3();
const _col = new THREE.Color();
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);

function barkColor(rnd: () => number): THREE.Color {
  return _col.copy(palette.bark).lerp(palette.barkDark, rnd() * 0.6)
    .offsetHSL((rnd() - 0.5) * 0.02, (rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.08).clone();
}

function foliageColor(rnd: () => number, type: TreeType): THREE.Color {
  // Lower-contrast palette: brights are common, darks are softened (lerped only
  // partway toward the dark tone) so no near-black dabs stick out of the canopy.
  if (type === 'conifer') {
    _col.copy(palette.conifer).lerp(palette.coniferDark, rnd() * 0.45);
  } else {
    const r = rnd();
    if (r < 0.24) _col.copy(palette.foliage).lerp(palette.foliageLight, 0.5 + rnd() * 0.5);
    else if (r < 0.36) _col.copy(palette.foliage).lerp(palette.foliageDark, rnd() * 0.5);
    else _col.copy(palette.foliage).lerp(palette.foliageLight, rnd() * 0.45);
  }
  return _col.offsetHSL((rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.07).clone();
}

/** Append a tapered cylinder (flat-shaded) between a→b into the trunk arrays. */
function emitCylinder(
  tp: number[], tn: number[], tc: number[],
  a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number,
  color: THREE.Color, segs = 6,
) {
  _dir.subVectors(b, a);
  const len = _dir.length();
  if (len < 1e-4) return;
  _dir.divideScalar(len);
  _up.copy(Math.abs(_dir.y) > 0.99 ? X : Y);
  _t1.crossVectors(_dir, _up).normalize();
  _t2.crossVectors(_dir, _t1).normalize();

  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const d0x = Math.cos(a0), d0y = Math.sin(a0);
    const d1x = Math.cos(a1), d1y = Math.sin(a1);
    // ring directions
    const n0 = new THREE.Vector3().addScaledVector(_t1, d0x).addScaledVector(_t2, d0y);
    const n1 = new THREE.Vector3().addScaledVector(_t1, d1x).addScaledVector(_t2, d1y);
    const A0 = new THREE.Vector3().copy(a).addScaledVector(n0, ra);
    const A1 = new THREE.Vector3().copy(a).addScaledVector(n1, ra);
    const B0 = new THREE.Vector3().copy(b).addScaledVector(n0, rb);
    const B1 = new THREE.Vector3().copy(b).addScaledVector(n1, rb);
    pushTri(tp, tn, tc, A0, B0, B1, n0, n0, n1, color);
    pushTri(tp, tn, tc, A0, B1, A1, n0, n1, n1, color);
  }
}

function pushTri(
  tp: number[], tn: number[], tc: number[],
  p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3,
  n0: THREE.Vector3, n1: THREE.Vector3, n2: THREE.Vector3,
  c: THREE.Color,
) {
  tp.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
  tn.push(n0.x, n0.y, n0.z, n1.x, n1.y, n1.z, n2.x, n2.y, n2.z);
  for (let k = 0; k < 3; k++) tc.push(c.r, c.g, c.b);
}

/** Tilt a direction by `angle` around a random azimuth, with an upward bias. */
function perturb(out: THREE.Vector3, dir: THREE.Vector3, angle: number, upBias: number, rnd: () => number) {
  _up.copy(Math.abs(dir.y) > 0.99 ? X : Y);
  _t1.crossVectors(dir, _up).normalize();
  _t2.crossVectors(dir, _t1).normalize();
  const az = rnd() * Math.PI * 2;
  const tiltx = Math.cos(az), tilty = Math.sin(az);
  out.copy(dir).multiplyScalar(Math.cos(angle));
  out.addScaledVector(_t1, Math.sin(angle) * tiltx);
  out.addScaledVector(_t2, Math.sin(angle) * tilty);
  out.y += upBias;
  return out.normalize();
}

function emitBlob(
  fp: number[], fs: number[], fc: number[], fw: number[], fa: number[], fasp: number[],
  cx: number, cy: number, cz: number, radius: number, count: number,
  baseScale: number, windBase: number, type: TreeType, rnd: () => number,
) {
  const inv = 1 / (radius + 1e-3);
  for (let i = 0; i < count; i++) {
    // random point in a slightly squashed sphere, clustered toward centre
    const u = rnd() * 2 - 1;
    const phi = rnd() * Math.PI * 2;
    const r = radius * Math.cbrt(rnd());
    const s = Math.sqrt(1 - u * u);
    const ox = Math.cos(phi) * s * r;
    const oy = u * r * 0.85;
    const oz = Math.sin(phi) * s * r;
    fp.push(cx + ox, cy + oy, cz + oz);
    fs.push(baseScale * (0.75 + rnd() * 0.7));
    // leafy strokes wrap tangentially around the clump
    fa.push(Math.atan2(oz, ox) + Math.PI / 2 + (rnd() - 0.5) * 0.8);
    fasp.push(0.45 + rnd() * 0.28);
    const c = foliageColor(rnd, type);
    // Baked shading so the canopy reads as a lit volume, not a flat blob:
    // top-lit, interior ambient-occluded, sun-facing side brightened.
    const topness = oy * inv * 0.5 + 0.5;
    const aoR = Math.sqrt(ox * ox + oy * oy + oz * oz) * inv;
    const sun = (ox * -0.5 + oz * -0.62) * inv;
    // Gentle shading — narrow range so the canopy has form without harsh spots.
    const shade = Math.min(1.1, Math.max(0.74, (0.82 + 0.18 * topness) * (0.88 + 0.12 * aoR) * (1 + 0.07 * sun)));
    c.multiplyScalar(shade);
    fc.push(c.r, c.g, c.b);
    // outer/upper leaves sway most
    fw.push(windBase * (0.5 + 0.5 * topness) * (0.7 + 0.5 * aoR));
  }
}

function growBranch(
  tp: number[], tn: number[], tc: number[],
  fp: number[], fs: number[], fc: number[], fw: number[], fa: number[], fasp: number[],
  a: THREE.Vector3, dir: THREE.Vector3, len: number, rad: number, depth: number,
  rnd: () => number,
) {
  const b = new THREE.Vector3().copy(a).addScaledVector(dir, len);
  emitCylinder(tp, tn, tc, a, b, rad, rad * 0.72, barkColor(rnd), 6);

  if (depth >= 3 || rad < 0.1) {
    emitBlob(fp, fs, fc, fw, fa, fasp, b.x, b.y, b.z, 1.9 + rad * 3, 18 + Math.floor(rnd() * 14), 2.1, 0.8, 'deciduous', rnd);
    return;
  }
  const n = 2 + (rnd() < 0.55 ? 1 : 0);
  const nd = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    perturb(nd, dir, 0.5 + rnd() * 0.5, 0.18, rnd);
    growBranch(tp, tn, tc, fp, fs, fc, fw, fa, fasp, b, nd.clone(), len * (0.72 + rnd() * 0.12), rad * 0.68, depth + 1, rnd);
  }
}

function buildDeciduous(rnd: () => number): TreeProto {
  const tp: number[] = [], tn: number[] = [], tc: number[] = [];
  const fp: number[] = [], fs: number[] = [], fc: number[] = [], fw: number[] = [], fa: number[] = [], fasp: number[] = [];

  const trunkH = 8 + rnd() * 6;
  const trunkR = 0.4 + rnd() * 0.32;
  // slightly leaning trunk in two segments
  const lean = perturb(new THREE.Vector3(), Y, rnd() * 0.16, 0, rnd);
  const mid = new THREE.Vector3().copy(lean).multiplyScalar(trunkH * 0.55);
  emitCylinder(tp, tn, tc, new THREE.Vector3(0, 0, 0), mid, trunkR, trunkR * 0.82, barkColor(rnd), 7);
  const top = new THREE.Vector3().copy(lean).multiplyScalar(trunkH);
  emitCylinder(tp, tn, tc, mid, top, trunkR * 0.82, trunkR * 0.62, barkColor(rnd), 7);

  // boughs spreading from the top
  const boughs = 3 + Math.floor(rnd() * 3);
  const nd = new THREE.Vector3();
  for (let i = 0; i < boughs; i++) {
    perturb(nd, lean, 0.5 + rnd() * 0.55, 0.12, rnd);
    growBranch(tp, tn, tc, fp, fs, fc, fw, fa, fasp, top, nd.clone(), trunkH * (0.4 + rnd() * 0.2), trunkR * 0.6, 1, rnd);
  }

  // a full rounded canopy mass centred above the crown
  const canopyR = trunkH * (0.52 + rnd() * 0.2);
  emitBlob(fp, fs, fc, fw, fa, fasp, top.x, top.y + canopyR * 0.45, top.z, canopyR, 300 + Math.floor(rnd() * 180), 2.8, 0.9, 'deciduous', rnd);

  return finalize('deciduous', tp, tn, tc, fp, fs, fc, fw, fa, fasp, trunkH + canopyR, canopyR);
}

function buildConifer(rnd: () => number): TreeProto {
  const tp: number[] = [], tn: number[] = [], tc: number[] = [];
  const fp: number[] = [], fs: number[] = [], fc: number[] = [], fw: number[] = [], fa: number[] = [], fasp: number[] = [];

  const H = 12 + rnd() * 9;
  const R = 0.34 + rnd() * 0.26;
  const lean = perturb(new THREE.Vector3(), Y, rnd() * 0.08, 0, rnd);
  // trunk in three segments tapering to a point
  let prev = new THREE.Vector3(0, 0, 0);
  for (let s = 1; s <= 3; s++) {
    const p = new THREE.Vector3().copy(lean).multiplyScalar((s / 3) * H);
    emitCylinder(tp, tn, tc, prev, p, R * (1 - (s - 1) / 3) + 0.04, R * (1 - s / 3) + 0.03, barkColor(rnd), 6);
    prev = p;
  }

  // conical tiered foliage: rings shrinking toward a pointed top
  const baseR = H * (0.26 + rnd() * 0.1);
  const tiers = 5 + Math.floor(rnd() * 3);
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1); // 0 base .. 1 top
    const cy = H * (0.22 + f * 0.74);
    const ringR = baseR * (1 - f) + 0.4;
    const dabs = Math.round(12 + (1 - f) * 34);
    for (let i = 0; i < dabs; i++) {
      const ang = rnd() * Math.PI * 2;
      const rr = ringR * (0.4 + rnd() * 0.6);
      fp.push(Math.cos(ang) * rr + lean.x * cy, cy + (rnd() - 0.5) * ringR * 0.3, Math.sin(ang) * rr + lean.z * cy);
      fs.push((1.25 + rnd() * 0.9) * (0.7 + (1 - f) * 0.6));
      const c = foliageColor(rnd, 'conifer');
      // shading: lower skirts in shadow, top tiers lit, interior occluded
      const aoR = rr / (ringR + 1e-3);
      const sun = Math.cos(ang) * -0.5 + Math.sin(ang) * -0.62;
      const shade = Math.min(1.18, Math.max(0.42, (0.5 + 0.5 * f) * (0.72 + 0.28 * aoR) * (1 + 0.13 * sun)));
      c.multiplyScalar(shade);
      fc.push(c.r, c.g, c.b);
      fw.push(0.55 * (0.3 + 0.7 * f)); // conifers are stiffer; tips sway a little
      fa.push(ang + Math.PI / 2 + (rnd() - 0.5) * 0.5); // sprays radiate from the spire
      fasp.push(0.22 + rnd() * 0.12);
    }
  }
  return finalize('conifer', tp, tn, tc, fp, fs, fc, fw, fa, fasp, H, baseR);
}

function finalize(
  type: TreeType,
  tp: number[], tn: number[], tc: number[],
  fp: number[], fs: number[], fc: number[], fw: number[], fa: number[], fasp: number[],
  height: number, canopyR: number,
): TreeProto {
  return {
    type,
    trunkPos: Float32Array.from(tp),
    trunkNor: Float32Array.from(tn),
    trunkCol: Float32Array.from(tc),
    folPos: Float32Array.from(fp),
    folScale: Float32Array.from(fs),
    folCol: Float32Array.from(fc),
    folWind: Float32Array.from(fw),
    folAngle: Float32Array.from(fa),
    folAspect: Float32Array.from(fasp),
    height,
    canopyR,
  };
}

/**
 * A bush. Two kinds: flowering shrubs (rounded, carry blossoms + berries) and
 * low wide scrub (flatter, leafier, sparse flowers) — together they fill the
 * landscape with varied ground cover.
 */
function buildBush(rnd: () => number, scrub: boolean): TreeProto {
  const fp: number[] = [], fs: number[] = [], fc: number[] = [], fw: number[] = [], fa: number[] = [], fasp: number[] = [];
  const R = scrub ? 1.9 + rnd() * 2.6 : 1.2 + rnd() * 1.6;
  const cy = R * (scrub ? 0.42 : 0.7); // scrub sits lower & wider
  // overlapping leafy mounds — scrub spreads into 2-4 clumps
  const mounds = scrub ? 2 + Math.floor(rnd() * 3) : 1 + (rnd() < 0.5 ? 1 : 0);
  for (let m = 0; m < mounds; m++) {
    const spread = scrub ? 1.1 : 0.7;
    const mx = (rnd() - 0.5) * R * spread;
    const mz = (rnd() - 0.5) * R * spread;
    const mr = scrub ? R * (0.55 + rnd() * 0.35) : R;
    emitBlob(fp, fs, fc, fw, fa, fasp, mx, cy + (rnd() - 0.5) * R * 0.25, mz, mr, 45 + Math.floor(rnd() * 45), 1.4, 0.42, 'bush', rnd);
  }
  // blossoms + berries scattered over the crown (scrub gets far fewer)
  const decor = scrub ? 3 + Math.floor(rnd() * 6) : 14 + Math.floor(rnd() * 18);
  for (let i = 0; i < decor; i++) {
    const u = rnd() * 2 - 1;
    const phi = rnd() * Math.PI * 2;
    const rr = R * (0.6 + rnd() * 0.45);
    const s = Math.sqrt(1 - u * u);
    const px = Math.cos(phi) * s * rr;
    const py = cy + Math.abs(u) * rr * 0.7; // bias to the upper surface
    const pz = Math.sin(phi) * s * rr;
    const r = rnd();
    if (r < 0.45) _col.copy(palette.blossom);
    else if (r < 0.6) _col.copy(palette.flowerYellow);
    else if (r < 0.82) _col.copy(palette.berryRed);
    else _col.copy(palette.berryDeep);
    _col.offsetHSL((rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.06);
    fp.push(px, py, pz);
    fs.push(0.7 + rnd() * 0.7); // small bright accents
    fc.push(_col.r, _col.g, _col.b);
    fw.push(0.3 + rnd() * 0.2);
    fa.push(rnd() * Math.PI); // blossoms/berries are roundish dabs
    fasp.push(0.82 + rnd() * 0.12);
  }
  return finalize('bush', [], [], [], fp, fs, fc, fw, fa, fasp, R * 1.6, R);
}

/** Build the tree prototype library once. */
export function createTreePrototypes(seed: number): TreeProto[] {
  const protos: TreeProto[] = [];
  for (let i = 0; i < 7; i++) protos.push(buildDeciduous(mulberry32((seed * 131 + i * 17 + 1) >>> 0)));
  for (let i = 0; i < 5; i++) protos.push(buildConifer(mulberry32((seed * 197 + i * 23 + 7) >>> 0)));
  return protos;
}

/** Build the bush prototype library once — a mix of flowering shrubs and scrub. */
export function createBushPrototypes(seed: number): TreeProto[] {
  const protos: TreeProto[] = [];
  for (let i = 0; i < 7; i++) protos.push(buildBush(mulberry32((seed * 251 + i * 29 + 3) >>> 0), false));
  for (let i = 0; i < 7; i++) protos.push(buildBush(mulberry32((seed * 311 + i * 37 + 9) >>> 0), true));
  return protos;
}

export interface ChunkTrees {
  trunkPos: Float32Array;
  trunkNor: Float32Array;
  trunkCol: Float32Array;
  folCenter: Float32Array;
  folScale: Float32Array;
  folCol: Float32Array;
  folWind: Float32Array;
  folAngle: Float32Array;
  folAspect: Float32Array;
  bound: THREE.Sphere;
}

/**
 * Scatter trees and bushes across a chunk and bake them into merged arrays by
 * transforming the chosen prototypes (yaw + uniform scale + translate, plus a
 * colour tint). Trees contribute trunk geometry + foliage; bushes only foliage.
 */
export function scatterTrees(
  field: TerrainField, cx: number, cz: number,
  treeProtos: TreeProto[], bushProtos: TreeProto[],
): ChunkTrees | null {
  const S = CHUNK_SIZE;
  const ox = cx * S;
  const oz = cz * S;
  const rnd = mulberry32(hash2(cx, cz, (WORLD_SEED ^ 0x77ee) >>> 0));

  const tp: number[] = [], tn: number[] = [], tc: number[] = [];
  const fcen: number[] = [], fsc: number[] = [], fcol: number[] = [], fwd: number[] = [], fang: number[] = [], fasp: number[] = [];
  let minY = Infinity, maxY = -Infinity;
  let placed = 0;
  // Ground shadows fall away from the sun (sun ≈ [-0.5,0.55,-0.62]).
  const sdx = 0.627, sdz = 0.778;
  const shadowAngle = Math.atan2(sdz, sdx); // strokes dragged along the shadow

  // Stamp a prototype's foliage into the chunk arrays at a transform.
  const stampFoliage = (
    proto: TreeProto, x: number, y: number, z: number,
    scale: number, cyaw: number, syaw: number, tint: number,
  ) => {
    const fpos = proto.folPos, fscl = proto.folScale, fc = proto.folCol, fwi = proto.folWind;
    const fan = proto.folAngle, fas = proto.folAspect;
    for (let k = 0; k < fpos.length; k += 3) {
      const kk = k / 3;
      const lx = fpos[k] * scale, ly = fpos[k + 1] * scale, lz = fpos[k + 2] * scale;
      const wx = lx * cyaw + lz * syaw + x;
      const wz = -lx * syaw + lz * cyaw + z;
      const wy = ly + y;
      fcen.push(wx, wy, wz);
      fsc.push(fscl[kk] * scale);
      fcol.push(fc[k] * tint, fc[k + 1] * tint, fc[k + 2] * tint);
      fwd.push(fwi[kk]);
      fang.push(fan[kk]); // screen-space stroke angle — independent of world yaw
      fasp.push(fas[kk]);
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
    }
  };

  // ---- trees: trunk geometry + foliage + contact shadow ----
  const cells = 8;
  const cellSize = S / cells;
  for (let gz = 0; gz < cells; gz++) {
    for (let gx = 0; gx < cells; gx++) {
      const x = ox + (gx + rnd()) * cellSize;
      const z = oz + (gz + rnd()) * cellSize;
      const surf = field.surface(x, z);
      if (surf.path > 0.2 || surf.rock > 0.4 || surf.slope > 0.46) continue;
      const dens = field.forest(x, z);
      if (rnd() > 0.22 + dens * 1.0) continue;

      const proto = treeProtos[Math.floor(rnd() * treeProtos.length)];
      const scale = 0.95 + rnd() * 0.8;
      const yaw = rnd() * Math.PI * 2;
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const y = field.height(x, z) - 0.3;
      const tint = 0.92 + rnd() * 0.16;

      const tpos = proto.trunkPos, tnor = proto.trunkNor, tcol = proto.trunkCol;
      for (let k = 0; k < tpos.length; k += 3) {
        const lx = tpos[k] * scale, ly = tpos[k + 1] * scale, lz = tpos[k + 2] * scale;
        const wx = lx * cy + lz * sy + x;
        const wz = -lx * sy + lz * cy + z;
        const wy = ly + y;
        tp.push(wx, wy, wz);
        const nx = tnor[k], nz = tnor[k + 2];
        tn.push(nx * cy + nz * sy, tnor[k + 1], -nx * sy + nz * cy);
        tc.push(tcol[k] * tint, tcol[k + 1] * tint, tcol[k + 2] * tint);
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
      }
      stampFoliage(proto, x, y, z, scale, cy, sy, tint);

      // soft cast-shadow pool, offset & elongated away from the sun
      const shN = 18 + Math.floor(rnd() * 14);
      const shR = proto.canopyR * scale * 0.85;
      const scx = x + sdx * shR * 0.7;
      const scz = z + sdz * shR * 0.7;
      for (let i = 0; i < shN; i++) {
        const ang = rnd() * Math.PI * 2;
        const rr = shR * Math.sqrt(rnd());
        fcen.push(scx + Math.cos(ang) * rr + sdx * rr * 0.5, y + 0.35, scz + Math.sin(ang) * rr + sdz * rr * 0.5);
        fsc.push((2.6 + rnd() * 2.6) * scale);
        fcol.push(palette.foliageDark.r * 0.3, palette.foliageDark.g * 0.3, palette.foliageDark.b * 0.3);
        fwd.push(0);
        fang.push(shadowAngle + (rnd() - 0.5) * 0.5);
        fasp.push(0.3 + rnd() * 0.15);
      }
      placed++;
    }
  }

  // ---- bushes + scrub: foliage-only ground cover, dense everywhere ----
  const bcells = 11;
  const bcs = S / bcells;
  for (let gz = 0; gz < bcells; gz++) {
    for (let gx = 0; gx < bcells; gx++) {
      const x = ox + (gx + rnd()) * bcs;
      const z = oz + (gz + rnd()) * bcs;
      const surf = field.surface(x, z);
      if (surf.path > 0.24 || surf.rock > 0.5 || surf.slope > 0.55) continue;
      const dens = field.forest(x, z);
      // scrub scatters broadly even in the open; thicker toward woodland
      if (rnd() > 0.36 + dens * 0.5) continue;

      const proto = bushProtos[Math.floor(rnd() * bushProtos.length)];
      const scale = 0.75 + rnd() * 0.75;
      const yaw = rnd() * Math.PI * 2;
      const y = field.height(x, z) - 0.2;
      const tint = 0.92 + rnd() * 0.16;
      stampFoliage(proto, x, y, z, scale, Math.cos(yaw), Math.sin(yaw), tint);

      // small ground shadow under the bush, offset from the sun
      const bShR = proto.canopyR * scale * 0.8;
      const bN = 5 + Math.floor(rnd() * 5);
      for (let i = 0; i < bN; i++) {
        const ang = rnd() * Math.PI * 2;
        const rr = bShR * Math.sqrt(rnd());
        fcen.push(x + sdx * bShR * 0.5 + Math.cos(ang) * rr, y + 0.25, z + sdz * bShR * 0.5 + Math.sin(ang) * rr);
        fsc.push((1.5 + rnd() * 1.5) * scale);
        fcol.push(palette.bushDark.r * 0.34, palette.bushDark.g * 0.34, palette.bushDark.b * 0.34);
        fwd.push(0);
        fang.push(shadowAngle + (rnd() - 0.5) * 0.5);
        fasp.push(0.3 + rnd() * 0.15);
      }
      placed++;
    }
  }

  if (placed === 0) return null;
  return {
    trunkPos: Float32Array.from(tp),
    trunkNor: Float32Array.from(tn),
    trunkCol: Float32Array.from(tc),
    folCenter: Float32Array.from(fcen),
    folScale: Float32Array.from(fsc),
    folCol: Float32Array.from(fcol),
    folWind: Float32Array.from(fwd),
    folAngle: Float32Array.from(fang),
    folAspect: Float32Array.from(fasp),
    bound: new THREE.Sphere(
      new THREE.Vector3(ox + S / 2, (minY + maxY) / 2, oz + S / 2),
      Math.hypot(S * 0.75, (maxY - minY) / 2) + 6,
    ),
  };
}
