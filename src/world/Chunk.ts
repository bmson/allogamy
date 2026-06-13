import * as THREE from 'three/webgpu';
import { TerrainField } from './TerrainField';
import { mulberry32, hash2 } from '../core/rng';
import { palette } from '../render/palette';
import { buildSplatGeometryMerged, SplatLayer } from '../render/SplatMaterial';
import { buildBoulders } from './rock';
import { scatterTrees, TreeProto } from './tree';
// (TreeProto covers both trees and bushes)
import { scatterFlowers } from './flowers';
import { scatterWeeds } from './weeds';
import { scatterLeaves } from './leaves';
import { scatterFauna, ChunkFauna } from './fauna';
import { buildWater } from './water';
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
  // The whole painted field (terrain carpet + tree/bush foliage + flowers + weeds
  // + wet-mud shore) is merged into ONE instanced geometry → one draw call.
  private pointGeo: THREE.BufferGeometry;
  private rockGeo: THREE.BufferGeometry | null = null;
  private trunkGeo: THREE.BufferGeometry | null = null;
  private waterGeo: THREE.BufferGeometry | null = null;
  private fauna: ChunkFauna | null = null;

  constructor(
    cx: number,
    cz: number,
    field: TerrainField,
    meshMat: THREE.Material,
    pointMat: THREE.Material,
    rockMat: THREE.Material,
    trunkMat: THREE.Material,
    waterMat: THREE.Material,
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
      // The grass/water boundary is never a clean line. In the frayed margin band a
      // few turf dabs read instead as wet mud — the soggy, broken shoreline where
      // the brook laps the meadow — so the bank reads ragged, not a drawn outline.
      const margin = path > 0.08 && path < 0.34; // the frayed transition band
      const wetEdge = grassy && margin && rnd() < 0.35;
      // The channel itself (strong path, not rock) reads as calm water surface.
      const watery = !grassy && rock < 0.4;

      if (grassy && !wetEdge) {
        if (rnd() < 0.03) {
          // a pale weathered stone / pebble nestled in the turf — stone variety
          // scattered across the meadow (cf. the reference), not just on rock faces.
          cc.copy(palette.rock).lerp(palette.rockShadow, rnd() * 0.6);
          const stoneShade = THREE.MathUtils.clamp(0.7 + 0.4 * ndotl, 0.55, 1.1);
          cc.multiplyScalar(stoneShade);
          scale = 0.6 + rnd() * rnd() * 1.6; // mostly small grit, the rare bigger stone
          yoff = 0.2 + rnd() * 0.35; // sits low, on the ground
          wind = 0; angle = rnd() * Math.PI; aspect = 0.9 + rnd() * 0.3;
        } else if (rnd() < 0.022) {
          // wildflower fleck floating just above the grass — colour punctuation,
          // kept SPARSE and mostly white/violet so the meadow doesn't read acid-yellow.
          const f = rnd();
          if (f < 0.6) cc.copy(palette.flowerWhite);
          else if (f < 0.78) cc.copy(palette.flowerYellow);
          else cc.copy(palette.flowerViolet);
          scale = 0.5 + rnd() * 0.45; yoff = 0.7 + rnd() * 0.9; wind = 0.5;
        } else {
          // Light-coupled HSL turf: warm sunlit yellow-green → cool deep shade,
          // hot-lime dry patches, occasional deep-shadow pockets. Light is baked
          // into lightness here (do NOT also multiply by shade).
          const tint = field.tint(x, z) * 0.5 + 0.5;
          // Hue pulled a hair WARMER than the canopy (which is now cooler/deeper) so
          // the meadow and the tree masses separate cleanly in both hue and value.
          let h = 0.33 - lit * 0.04 + (tint - 0.5) * 0.04; // fresh true green
          // LUSH painted meadow (matched to the reference): a saturated verdant
          // carpet with a WIDE value range — bright sunlit lime crowns against deep
          // blue-green shadow pockets — which is what gives the turf its depth and
          // stops it reading as flat pale fuzz over bare ground.
          let s = 0.62 + (1 - lit) * 0.08 + tint * 0.04; // LUSH clean green — not muddy, not acid
          let l = 0.36 + lit * 0.26 + (rnd() - 0.5) * 0.07; // bright fresh meadow, floor well off black
          if (field.dry(x, z) > 0.62) { h = 0.28; s = 0.55; l = 0.54 + lit * 0.08; } // fresh dry green
          // A mild clump-to-clump dip for life — never the near-black it used to crush to.
          if (rnd() < 0.14) { l -= 0.07; }
          cc.setHSL(h, THREE.MathUtils.clamp(s, 0, 1), THREE.MathUtils.clamp(l, 0.30, 0.95)); // floor 0.30 → no dark grass
          // Bigger, blade-ish dabs so the carpet reads densely planted (less bare
          // ground showing through), a minority taller and upright.
          scale = 1.0 + rnd() * 1.1;
          aspect = rnd() < 0.4 ? 1.3 + rnd() * 0.9 : 0.9 + rnd() * 0.3;
          yoff = 0.5 + rnd() * 1.1;
          wind = 0.4 + rnd() * 0.15;
        }
      } else if (watery) {
        // Calm water surface of the stream channel. mixColor now paints the channel
        // in water tones (deep blue-green centre → pale shallows toward the banks);
        // we keep these dabs STILL (wind = 0 → no sway/wave), low and flat-hugging
        // the sunk bed, round and smooth — NO leafy blade treatment — so the brook
        // reads as a calm, glassy ribbon rather than swaying vegetation. A faint
        // sun-skimmed sheen lifts a few dabs so the surface isn't a flat slab.
        field.mixColor(x, z, y, slope, path, rock, cc);
        const sheen = THREE.MathUtils.clamp(0.86 + 0.22 * ndotl, 0.74, 1.12);
        cc.multiplyScalar(sheen);
        if (rnd() < 0.1) cc.lerp(palette.waterShallow, 0.3 + rnd() * 0.3); // glints
        scale = 1.0 + rnd() * 0.9; // broad, flat surface dabs
        yoff = 0.12 + rnd() * 0.28; // sits low on the water, in the sunk channel
        wind = 0; // calm/still — water must not wave
        angle = rnd() * Math.PI;
        aspect = 0.9 + rnd() * 0.3; // round, never blade-ish
      } else {
        // The wet shoreline (wetEdge): soggy dark mud where the brook meets the
        // turf — and, off the channel, the rare bare rock dab. Either way STILL.
        field.mixColor(x, z, y, slope, path, rock, cc);
        const shade = THREE.MathUtils.clamp(0.62 + 0.5 * ndotl, 0.5, 1.12);
        if (rnd() < 0.12) cc.copy(palette.rock).lerp(palette.rockShadow, rnd());
        else if (wetEdge) cc.copy(palette.waterEdge).lerp(palette.waterDeep, rnd() * 0.4); // wet-mud / damp shore fleck
        cc.multiplyScalar(shade);
        scale = wetEdge ? 0.6 + rnd() * 0.6 : 0.9 + rnd() * 0.8;
        yoff = wetEdge ? 0.18 + rnd() * 0.3 : yoff; // shore mud hugs the ground
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

    // Collect every layer that shares pointMat so they merge into ONE draw call.
    // The terrain carpet is the first (largest) layer; foliage / flowers / weeds /
    // shore append below. Each keeps its exact per-instance data — the merge only
    // collapses draw calls, the painted field is byte-for-byte the same.
    const splatLayers: SplatLayer[] = [{
      centers: centers.slice(0, w * 3),
      scales: scales.slice(0, w),
      colors: colors.slice(0, w * 3),
      winds: winds.slice(0, w),
      angles: angles.slice(0, w),
      aspects: aspects.slice(0, w),
    }];
    // Bound that actually covers the chunk (the quad template is tiny). Foliage is
    // taller than the heightfield, so the radius grows below to cover canopies.
    let splatMinY = minY;
    let splatMaxY = maxY;

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

      splatLayers.push({
        centers: trees.folCenter, scales: trees.folScale, colors: trees.folCol,
        winds: trees.folWind, angles: trees.folAngle, aspects: trees.folAspect,
      });
      // Trees rise above the heightfield — grow the splat bound to cover canopies.
      const tb = trees.bound;
      splatMinY = Math.min(splatMinY, tb.center.y - tb.radius);
      splatMaxY = Math.max(splatMaxY, tb.center.y + tb.radius);
    }

    // ---- wild flowers: clustered bright blooms on open grass ----
    const flowers = scatterFlowers(field, cx, cz);
    if (flowers) splatLayers.push(flowers);

    // ---- undergrowth: plush ground cover between turf and bushes ----
    const weeds = scatterWeeds(field, cx, cz);
    if (weeds) splatLayers.push(weeds);

    // ---- blowing leaves: wind-stirred leaf litter beneath the trees ----
    const leaves = scatterLeaves(field, cx, cz);
    if (leaves) splatLayers.push(leaves);

    // ---- water: a rare calm tarn in a low wet hollow (own rng stream) ----
    // Most chunks return null; only the few that hold a deep, wet basin get a pool.
    // The lit surface mesh drinks the sky; a ragged ring of wet-mud dabs joins the
    // shared splat layer so the shoreline reads wet and broken, not a drawn outline.
    const waterRnd = mulberry32(hash2(cx, cz, (WORLD_SEED ^ 0x7a7e12) >>> 0));
    const water = buildWater(field, cx, cz, waterRnd);
    if (water) {
      this.waterGeo = water.surfaceGeo;
      const pool = new THREE.Mesh(water.surfaceGeo, waterMat);
      pool.renderOrder = 1; // draw after the opaque bed so the slight transparency reads
      this.group.add(pool);

      if (water.shore) splatLayers.push(water.shore);
    }

    // ---- merge every pointMat layer into ONE instanced draw call ----
    // Terrain carpet + foliage + flowers + weeds + shore all share the splat
    // material, so we concatenate their per-instance arrays and draw the chunk's
    // entire painted field at once (was 4–5 draw calls per chunk). The instances
    // are unchanged, so the look is identical — this only cuts draw calls.
    const ig = buildSplatGeometryMerged(splatLayers);
    ig.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(ox + S / 2, (splatMinY + splatMaxY) / 2, oz + S / 2),
      Math.hypot(S * 0.72, (splatMaxY - splatMinY) / 2 + 4) + 6,
    );
    this.pointGeo = ig;
    const splats = new THREE.Mesh(ig, pointMat);
    splats.frustumCulled = true;
    this.group.add(splats);

    // ---- sparse distant life: grazing deer/sheep, the rare wheeling bird ----
    // (own rng stream inside fauna.ts; most chunks get nothing back)
    this.fauna = scatterFauna(field, cx, cz);
    if (this.fauna) this.group.add(this.fauna.object);
  }

  /** Tick the chunk's gentle fauna animation (no-op if the chunk has none). */
  update(time: number) {
    this.fauna?.update?.(time);
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.group);
    this.meshGeo.dispose();
    this.pointGeo.dispose(); // the merged terrain+foliage+flowers+weeds+shore field
    this.rockGeo?.dispose();
    this.trunkGeo?.dispose();
    this.waterGeo?.dispose();
    this.fauna?.dispose();
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
