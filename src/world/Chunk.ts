import * as THREE from 'three/webgpu';
import { TerrainField } from './TerrainField';
import { mulberry32, hash2 } from '../core/rng';
import { palette } from '../render/palette';
import { buildSplatGeometry } from '../render/SplatMaterial';
import { buildBoulders } from './rock';
import { scatterTrees, TreeProto } from './tree';
// (TreeProto covers both trees and bushes)
import { scatterFlowers } from './flowers';
import { scatterWeeds } from './weeds';
import { CHUNK_SIZE, CHUNK_RES, SPLATS_PER_CHUNK, SPLAT_DENSITY, WORLD_SEED, SUN_DIR } from '../config';

// Normalised sun direction, for baking slope shading into the splats.
const _sun = new THREE.Vector3(...SUN_DIR).normalize();
const SUNX = _sun.x, SUNY = _sun.y, SUNZ = _sun.z;

// One terrain tile = a solid coloured mesh (guarantees you can never see through
// the ground) + a dense layer of painterly point "splats" sitting on it, plus a
// wildflower speckle. Materials are shared and passed in; a chunk owns only its
// geometries and frees them on dispose.
//
// Cost control: the noise-heavy surface (height/slope/path/rock) is evaluated
// ONCE per grid vertex, then bilinearly sampled per splat — so splat density is
// essentially free and streaming stays smooth.

export class Chunk {
  readonly group = new THREE.Group();
  private meshGeo: THREE.BufferGeometry;
  private pointGeo: THREE.BufferGeometry;
  private rockGeo: THREE.BufferGeometry | null = null;
  private trunkGeo: THREE.BufferGeometry | null = null;
  private folGeo: THREE.BufferGeometry | null = null;
  private flowerGeo: THREE.BufferGeometry | null = null;
  private weedGeo: THREE.BufferGeometry | null = null;

  constructor(
    cx: number,
    cz: number,
    field: TerrainField,
    meshMat: THREE.Material,
    pointMat: THREE.Material,
    rockMat: THREE.Material,
    trunkMat: THREE.Material,
    protos: TreeProto[],
    bushProtos: TreeProto[],
  ) {
    const S = CHUNK_SIZE;
    const RES = CHUNK_RES;
    const ox = cx * S;
    const oz = cz * S;
    const dim = RES + 1;
    const vcount = dim * dim;

    // ---- precompute the surface grid ----
    const H = new Float32Array(vcount);
    const SL = new Float32Array(vcount);
    const PA = new Float32Array(vcount);
    const RO = new Float32Array(vcount);
    const NX = new Float32Array(vcount); // surface normal, for sun shading
    const NZ = new Float32Array(vcount);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let j = 0; j < dim; j++) {
      for (let i = 0; i < dim; i++) {
        const idx = j * dim + i;
        const x = ox + (i / RES) * S;
        const z = oz + (j / RES) * S;
        const h = field.height(x, z);
        H[idx] = h;
        if (h < minY) minY = h;
        if (h > maxY) maxY = h;
        const s = field.surface(x, z);
        SL[idx] = s.slope; PA[idx] = s.path; RO[idx] = s.rock;
        NX[idx] = s.nx; NZ[idx] = s.nz;
      }
    }

    // ---- solid surface mesh ----
    const pos = new Float32Array(vcount * 3);
    const col = new Float32Array(vcount * 3);
    const c = new THREE.Color();
    for (let j = 0; j < dim; j++) {
      for (let i = 0; i < dim; i++) {
        const idx = j * dim + i;
        const x = ox + (i / RES) * S;
        const z = oz + (j / RES) * S;
        const y = H[idx];
        pos[idx * 3] = x; pos[idx * 3 + 1] = y; pos[idx * 3 + 2] = z;
        field.mixColor(x, z, y, SL[idx], PA[idx], RO[idx], c);
        const t = field.tint(x, z);
        c.offsetHSL(t * 0.022, t * 0.045, t * 0.035);
        col[idx * 3] = c.r; col[idx * 3 + 1] = c.g; col[idx * 3 + 2] = c.b;
      }
    }
    const indexArr = vcount > 65535 ? new Uint32Array(RES * RES * 6) : new Uint16Array(RES * RES * 6);
    let ii = 0;
    for (let j = 0; j < RES; j++) {
      for (let i = 0; i < RES; i++) {
        const a = j * dim + i;
        const b = a + 1;
        const d = a + dim;
        const e = d + 1;
        indexArr[ii++] = a; indexArr[ii++] = d; indexArr[ii++] = b;
        indexArr[ii++] = b; indexArr[ii++] = d; indexArr[ii++] = e;
      }
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    mg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    mg.setIndex(new THREE.BufferAttribute(indexArr, 1));
    mg.computeVertexNormals();
    mg.computeBoundingSphere();
    this.meshGeo = mg;
    this.group.add(new THREE.Mesh(mg, meshMat));

    // ---- painterly splats + wildflowers (instanced billboards) ----
    const N = Math.round(SPLATS_PER_CHUNK * SPLAT_DENSITY);
    const centers = new Float32Array(N * 3);
    const scales = new Float32Array(N);
    const colors = new Float32Array(N * 3);
    const winds = new Float32Array(N);
    const angles = new Float32Array(N); // stroke orientation (screen-space)
    const aspects = new Float32Array(N); // stroke width / length
    const rnd = mulberry32(hash2(cx, cz, WORLD_SEED));
    const cc = new THREE.Color();
    let w = 0;
    for (let k = 0; k < N; k++) {
      const u = rnd();
      const v = rnd();
      const gx = u * RES;
      const gz = v * RES;
      const slope = bilin(SL, dim, gx, gz);
      const path = bilin(PA, dim, gx, gz);
      const rock = bilin(RO, dim, gx, gz);

      const x = ox + u * S;
      const z = oz + v * S;
      const y = bilin(H, dim, gx, gz);

      // Sun term, so colour is coupled to the light (warm lit / cool shade).
      const nx = bilin(NX, dim, gx, gz);
      const nz = bilin(NZ, dim, gx, gz);
      const ny = Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz));
      const ndotl = nx * SUNX + ny * SUNY + nz * SUNZ;
      const lit = THREE.MathUtils.clamp(0.5 + 0.5 * ndotl, 0, 1);

      let scale = 0.85 + rnd() * 0.95;
      let wind = 0.45;
      let angle = 0;
      let aspect = 0.92 + rnd() * 0.26; // round-ish dabs (1 ≈ round)
      let yoff = 0.4 + rnd() * 1.0;

      const grassy = path < 0.3 && rock < 0.4;
      if (grassy) {
        if (rnd() < 0.04) {
          // wildflower fleck floating just above the grass — colour punctuation
          const f = rnd();
          if (f < 0.55) cc.copy(palette.flowerWhite);
          else if (f < 0.85) cc.copy(palette.flowerYellow);
          else cc.copy(palette.flowerViolet);
          scale = 0.5 + rnd() * 0.45; yoff = 0.7 + rnd() * 0.9; wind = 0.5;
        } else {
          // Light-coupled HSL turf: warm sunlit yellow-green → cool deep shade,
          // hot-lime dry patches, occasional deep-shadow pockets. Light is baked
          // into lightness here (do NOT also multiply by shade).
          const tint = field.tint(x, z) * 0.5 + 0.5;
          let h = 0.32 - lit * 0.11 + (tint - 0.5) * 0.05;
          let s = 0.58 + (1 - lit) * 0.12 + tint * 0.05;
          let l = 0.16 + lit * 0.42 + (rnd() - 0.5) * 0.08;
          if (field.dry(x, z) > 0.62) { h = 0.19; s = 0.74; l = 0.5 + lit * 0.12; }
          if (rnd() < 0.1) l *= 0.6; // deep-shadow pockets
          cc.setHSL(h, s, THREE.MathUtils.clamp(l, 0.05, 0.95));
          wind = 0.4 + rnd() * 0.15;
        }
      } else {
        // bare ground: dirt/pebble dabs (mixColor tints them), shaded by sun
        field.mixColor(x, z, y, slope, path, rock, cc);
        const shade = THREE.MathUtils.clamp(0.62 + 0.5 * ndotl, 0.5, 1.12);
        if (rnd() < 0.12) cc.copy(palette.rock).lerp(palette.rockShadow, rnd());
        cc.multiplyScalar(shade);
        scale = 0.9 + rnd() * 0.8;
        wind = 0;
        aspect = 0.95 + rnd() * 0.2;
      }

      centers[w * 3] = x;
      centers[w * 3 + 1] = y + yoff;
      centers[w * 3 + 2] = z;
      scales[w] = scale;
      colors[w * 3] = cc.r; colors[w * 3 + 1] = cc.g; colors[w * 3 + 2] = cc.b;
      winds[w] = wind;
      angles[w] = angle;
      aspects[w] = aspect;
      w++;
    }

    const ig = buildSplatGeometry(
      centers.slice(0, w * 3), scales.slice(0, w), colors.slice(0, w * 3),
      winds.slice(0, w), angles.slice(0, w), aspects.slice(0, w),
    );
    // The quad template is tiny, so set a bound that actually covers the chunk
    // (otherwise frustum culling would drop the whole chunk early).
    ig.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(ox + S / 2, (minY + maxY) / 2, oz + S / 2),
      Math.hypot(S * 0.72, (maxY - minY) / 2 + 4) + 4,
    );
    this.pointGeo = ig;
    const splats = new THREE.Mesh(ig, pointMat);
    splats.frustumCulled = true;
    this.group.add(splats);

    // ---- boulders (independent rng stream so it can't shift splat layout) ----
    const rockRnd = mulberry32(hash2(cx, cz, (WORLD_SEED ^ 0xb07de7) >>> 0));
    const rockGeo = buildBoulders(field, cx, cz, rockRnd);
    if (rockGeo) {
      this.rockGeo = rockGeo;
      this.group.add(new THREE.Mesh(rockGeo, rockMat));
    }

    // ---- trees + bushes: solid trunks + splat foliage ----
    const trees = scatterTrees(field, cx, cz, protos, bushProtos);
    if (trees) {
      if (trees.trunkPos.length > 0) {
        const tg = new THREE.BufferGeometry();
        tg.setAttribute('position', new THREE.BufferAttribute(trees.trunkPos, 3));
        tg.setAttribute('normal', new THREE.BufferAttribute(trees.trunkNor, 3));
        tg.setAttribute('color', new THREE.BufferAttribute(trees.trunkCol, 3));
        tg.boundingSphere = trees.bound.clone();
        this.trunkGeo = tg;
        this.group.add(new THREE.Mesh(tg, trunkMat));
      }

      const fg = buildSplatGeometry(trees.folCenter, trees.folScale, trees.folCol, trees.folWind, trees.folAngle, trees.folAspect);
      fg.boundingSphere = trees.bound.clone();
      this.folGeo = fg;
      const fol = new THREE.Mesh(fg, pointMat);
      fol.frustumCulled = true;
      this.group.add(fol);
    }

    // ---- wild flowers: clustered bright blooms on open grass ----
    const flowers = scatterFlowers(field, cx, cz);
    if (flowers) {
      const flg = buildSplatGeometry(
        flowers.centers, flowers.scales, flowers.colors,
        flowers.winds, flowers.angles, flowers.aspects,
      );
      flg.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(ox + S / 2, (minY + maxY) / 2, oz + S / 2),
        Math.hypot(S * 0.72, (maxY - minY) / 2 + 4) + 4,
      );
      this.flowerGeo = flg;
      const blooms = new THREE.Mesh(flg, pointMat);
      blooms.frustumCulled = true;
      this.group.add(blooms);
    }

    // ---- undergrowth: plush ground cover between turf and bushes ----
    const weeds = scatterWeeds(field, cx, cz);
    if (weeds) {
      const wg = buildSplatGeometry(
        weeds.centers, weeds.scales, weeds.colors,
        weeds.winds, weeds.angles, weeds.aspects,
      );
      wg.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(ox + S / 2, (minY + maxY) / 2, oz + S / 2),
        Math.hypot(S * 0.72, (maxY - minY) / 2 + 4) + 6,
      );
      this.weedGeo = wg;
      const wm = new THREE.Mesh(wg, pointMat);
      wm.frustumCulled = true;
      this.group.add(wm);
    }
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.group);
    this.meshGeo.dispose();
    this.pointGeo.dispose();
    this.rockGeo?.dispose();
    this.trunkGeo?.dispose();
    this.folGeo?.dispose();
    this.flowerGeo?.dispose();
    this.weedGeo?.dispose();
  }
}

/** Bilinear sample of a dim×dim grid at fractional grid coords. */
function bilin(arr: Float32Array, dim: number, gx: number, gz: number): number {
  const x0 = Math.min(dim - 1, gx | 0);
  const z0 = Math.min(dim - 1, gz | 0);
  const x1 = Math.min(dim - 1, x0 + 1);
  const z1 = Math.min(dim - 1, z0 + 1);
  const fx = gx - x0;
  const fz = gz - z0;
  const a = arr[z0 * dim + x0];
  const b = arr[z0 * dim + x1];
  const cc = arr[z1 * dim + x0];
  const d = arr[z1 * dim + x1];
  return (a * (1 - fx) + b * fx) * (1 - fz) + (cc * (1 - fx) + d * fx) * fz;
}
