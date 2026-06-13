import * as THREE from 'three/webgpu';
import { TerrainField } from './TerrainField';
import { mulberry32, hash2 } from '../core/rng';
import { palette } from '../render/palette';
import { buildSplatGeometry } from '../render/SplatMaterial';
import { buildBoulders } from './rock';
import { scatterTrees, TreeProto } from './tree';
// (TreeProto covers both trees and bushes)
import { CHUNK_SIZE, CHUNK_RES, SPLATS_PER_CHUNK, WORLD_SEED, SUN_DIR } from '../config';

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
    const N = SPLATS_PER_CHUNK;
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
      field.mixColor(x, z, y, slope, path, rock, cc);

      // Fine grass dabs — small for higher fidelity; canopies read as much
      // larger masses, and the matching mesh below covers the gaps.
      let scale = 0.8 + rnd() * 0.95;
      let wind = 0.2;
      // brushstroke orientation: grass blades near-vertical & thin
      let angle = (rnd() - 0.5) * 0.7;
      let aspect = 0.18 + rnd() * 0.1;

      // Grass: lush fine dabs with a wildflower speckle and darker undertones for
      // depth. Bare ground (paths/rock): dense small gravelly dabs (mixColor has
      // already tinted them dirt/stone) with the odd pale pebble.
      const grassy = path < 0.3 && rock < 0.4;
      if (grassy) {
        const r = rnd();
        if (r < 0.05) { cc.copy(palette.flowerWhite); scale = 0.55 + rnd() * 0.45; wind = 0.12; angle = rnd() * Math.PI; aspect = 0.8 + rnd() * 0.12; }
        else if (r < 0.085) { cc.copy(palette.flowerYellow); scale = 0.55 + rnd() * 0.45; wind = 0.12; angle = rnd() * Math.PI; aspect = 0.8 + rnd() * 0.12; }
        else {
          // Vibrant turf: lots of bright sunlit tips, a little shade for depth,
          // and a saturation bump so the green really sings.
          const v = rnd();
          const light = v < 0.32 ? 0.05 + rnd() * 0.1 // sunlit tips
            : v < 0.46 ? -0.04 - rnd() * 0.05 // a touch of shade
              : (rnd() - 0.5) * 0.06;
          cc.offsetHSL((rnd() - 0.5) * 0.04, 0.05 + rnd() * 0.09, light);
          wind = 0.16 + (scale - 1.2) * 0.12; // taller blades sway a touch more
        }
      } else {
        scale = 0.9 + rnd() * 0.8; // pebbly, fills the track without grass tufts
        wind = 0; // dirt & stone don't move
        angle = Math.PI / 2 + (rnd() - 0.5) * 0.9; // dragged across the track
        aspect = 0.3 + rnd() * 0.18;
        if (rnd() < 0.12) cc.copy(palette.rock).lerp(palette.rockShadow, rnd());
        else cc.offsetHSL((rnd() - 0.5) * 0.02, (rnd() - 0.5) * 0.06, (rnd() - 0.4) * 0.1);
      }

      // Sun shading by terrain slope so hillsides have light & shade — the main
      // cure for flatness. ny from nx,nz; brighten sun-facing, darken away.
      const nx = bilin(NX, dim, gx, gz);
      const nz = bilin(NZ, dim, gx, gz);
      const ny = Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz));
      const ndotl = nx * SUNX + ny * SUNY + nz * SUNZ;
      const shade = THREE.MathUtils.clamp(0.6 + 0.55 * ndotl, 0.5, 1.12);
      cc.multiplyScalar(shade);

      centers[w * 3] = x;
      centers[w * 3 + 1] = y + 0.4 + rnd() * 1.0;
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
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.group);
    this.meshGeo.dispose();
    this.pointGeo.dispose();
    this.rockGeo?.dispose();
    this.trunkGeo?.dispose();
    this.folGeo?.dispose();
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
