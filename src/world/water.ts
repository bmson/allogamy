import * as THREE from 'three/webgpu';
import { palette } from '../render/palette';
import { CHUNK_SIZE, SUN_DIR } from '../config';
import { TerrainField } from './TerrainField';

// Water — used SPARINGLY. A handful of small, calm tarns nestled in the rare low
// basins the terrain scoops out (TerrainField.wetness + the height dip that goes
// with it). A pool is a flat disc at a water level a touch above the basin floor;
// its shoreline is found by marching each radial spoke OUTWARD until the terrain
// climbs back up to the waterline — so the pool hugs the actual hollow and its
// outline is organically irregular, never a clean circle.
//
// The surface is a vertex-coloured fan drawn with a dedicated low-roughness lit
// material (so the directional sun + hemisphere sky give it a calm sheen by
// construction — no env map, no per-frame work). Deep cool blue-green at the
// centre fades to a pale sky-skimmed shallow at the rim. A ragged ring of wet,
// dark mud dabs is emitted into the SHARED splat layer so the shore reads wet and
// broken-up in the same painterly language as the turf.
//
// Cost: a pool is only built when a chunk genuinely contains a deep wet basin, so
// most chunks emit nothing. All placement noise is sampled, never per-frame.

const _sun = new THREE.Vector3(...SUN_DIR).normalize();
const _col = new THREE.Color();

export interface WaterResult {
  /** Vertex-coloured fan for the still water surface (lit, low-roughness). */
  surfaceGeo: THREE.BufferGeometry;
  /** Wet-mud shoreline dabs, in the shared splat attribute layout. */
  shore: {
    centers: Float32Array;
    scales: Float32Array;
    colors: Float32Array;
    winds: Float32Array;
    angles: Float32Array;
    aspects: Float32Array;
  } | null;
  /** Water-surface height, for bounding-sphere placement by the caller. */
  level: number;
  /** Approximate radius, for the bounding sphere. */
  radius: number;
  /** Pool centre (world), for the bounding sphere. */
  cx: number;
  cz: number;
}

/**
 * Build the single calm pool for one chunk, or null if the chunk holds no
 * sufficiently deep wet basin. `rnd` is the chunk's own (salted) stream so pool
 * placement can never shift the splat / tree / rock layouts.
 */
export function buildWater(
  field: TerrainField,
  cxChunk: number,
  czChunk: number,
  rnd: () => number,
): WaterResult | null {
  const S = CHUNK_SIZE;
  const ox = cxChunk * S;
  const oz = czChunk * S;

  // ---- find the wettest, deepest basin candidate in this chunk ----
  // Coarse scan; a candidate must be both WET (broad wetness field high) and a true
  // local dip (lower than the surrounding land). Both bars are high so pools are rare.
  let bestX = 0, bestZ = 0, bestScore = -Infinity, bestH = 0;
  const scan = 5;
  for (let j = 0; j < scan; j++) {
    for (let i = 0; i < scan; i++) {
      const x = ox + ((i + 0.5) / scan) * S;
      const z = oz + ((j + 0.5) / scan) * S;
      const wet = field.wetness(x, z);
      if (wet < 0.72) continue; // SPARSE: only the wettest pockets qualify
      // Is it a hollow? Compare the local height to its ring of neighbours.
      const h = field.height(x, z);
      const r = 26;
      const around =
        (field.height(x + r, z) + field.height(x - r, z) +
          field.height(x, z + r) + field.height(x, z - r)) * 0.25;
      const dip = around - h; // >0 means we sit below the surroundings
      if (dip < 1.2) continue; // must be a genuine cup, not a flat wet field
      const score = wet * 2 + dip * 0.15;
      if (score > bestScore) { bestScore = score; bestX = x; bestZ = z; bestH = h; }
    }
  }
  if (bestScore < 0) return null;

  // ---- water level: just above the basin floor; small calm tarns ----
  const level = bestH + 0.5;
  const maxR = 9 + rnd() * 16; // small pools (≈9..25 m)
  const phase = rnd() * Math.PI * 2;

  // ---- radial shoreline: march each spoke out to where land meets the waterline ----
  const SEG = 40;
  const ring = new Float32Array(SEG * 2); // x,z of each shore vertex
  const rim = new Float32Array(SEG); // shallowness 0 (deep) .. 1 (lip) per spoke
  for (let s = 0; s < SEG; s++) {
    const a = (s / SEG) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    // March outward in small steps; stop where the bed rises to the waterline.
    let r = maxR;
    const step = maxR / 14;
    for (let t = step; t <= maxR; t += step) {
      if (field.height(bestX + ca * t, bestZ + sa * t) >= level) { r = t; break; }
    }
    // Organic wobble so the outline frays in/out — never a clean circle.
    const wob = 0.82 + 0.18 * Math.sin(a * 3 + phase) + 0.1 * Math.sin(a * 7 - phase * 1.7);
    r = Math.max(2.5, r * THREE.MathUtils.clamp(wob, 0.5, 1.15));
    ring[s * 2] = bestX + ca * r;
    ring[s * 2 + 1] = bestZ + sa * r;
    rim[s] = THREE.MathUtils.clamp(r / maxR, 0, 1); // wider spoke ≈ more open shallow
  }

  // ---- surface fan: centre vertex + ring, vertex-coloured ----
  const vcount = SEG + 1;
  const pos = new Float32Array(vcount * 3);
  const col = new Float32Array(vcount * 3);
  // sun azimuth term → a faint asymmetric sky-sheen across the still surface
  const sx = _sun.x, sz = _sun.z;

  // centre: deepest, coolest, with a soft sky highlight baked in
  _col.copy(palette.waterDeep).lerp(palette.waterShallow, 0.12);
  pos[0] = bestX; pos[1] = level; pos[2] = bestZ;
  col[0] = _col.r; col[1] = _col.g; col[2] = _col.b;

  for (let s = 0; s < SEG; s++) {
    const vx = ring[s * 2], vz = ring[s * 2 + 1];
    const idx = s + 1;
    pos[idx * 3] = vx; pos[idx * 3 + 1] = level; pos[idx * 3 + 2] = vz;
    // shallow toward the rim; a gentle sky sheen toward the sun azimuth
    const ax = vx - bestX, az = vz - bestZ;
    const inv = 1 / Math.max(1e-3, Math.hypot(ax, az));
    const sheen = THREE.MathUtils.clamp((ax * sx + az * sz) * inv * 0.5 + 0.5, 0, 1);
    _col.copy(palette.waterDeep).lerp(palette.waterShallow, 0.45 + sheen * 0.35);
    col[idx * 3] = _col.r; col[idx * 3 + 1] = _col.g; col[idx * 3 + 2] = _col.b;
  }

  const index = new Uint16Array(SEG * 3);
  let ii = 0;
  for (let s = 0; s < SEG; s++) {
    const a = s + 1;
    const b = ((s + 1) % SEG) + 1;
    index[ii++] = 0; index[ii++] = a; index[ii++] = b;
  }
  const surfaceGeo = new THREE.BufferGeometry();
  surfaceGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  surfaceGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  surfaceGeo.setIndex(new THREE.BufferAttribute(index, 1));
  surfaceGeo.computeVertexNormals(); // ≈ flat-up, gives the lit material its sheen
  surfaceGeo.computeBoundingSphere();

  // ---- wet-mud shoreline dabs (shared splat layer) ----
  // A ragged ring of dark, damp earth right at the waterline plus a few just
  // outside it — so the shore reads wet and broken, not a drawn outline.
  const cen: number[] = [], scl: number[] = [], wnd: number[] = [], ang: number[] = [], asp: number[] = [];
  const cols: number[] = [];
  for (let s = 0; s < SEG; s++) {
    if (rnd() < 0.4) continue; // break the ring up so it isn't a solid band
    const vx = ring[s * 2], vz = ring[s * 2 + 1];
    const ax = vx - bestX, az = vz - bestZ;
    const inv = 1 / Math.max(1e-3, Math.hypot(ax, az));
    // nudge each dab a little in/out along its spoke for a frayed, mottled rim
    const off = (rnd() - 0.35) * 2.4;
    const dx = vx + ax * inv * off;
    const dz = vz + az * inv * off;
    const gy = field.height(dx, dz);
    _col.copy(palette.waterEdge).lerp(palette.pathEarth, rnd() * 0.4)
      .offsetHSL(0, (rnd() - 0.5) * 0.04, (rnd() - 0.5) * 0.12);
    cen.push(dx, gy + 0.18, dz);
    scl.push(1.0 + rnd() * 1.3);
    cols.push(_col.r, _col.g, _col.b);
    wnd.push(0); // wet mud doesn't sway
    ang.push(rnd() * Math.PI);
    asp.push(0.9 + rnd() * 0.3);
  }

  const shore = scl.length === 0 ? null : {
    centers: Float32Array.from(cen),
    scales: Float32Array.from(scl),
    colors: Float32Array.from(cols),
    winds: Float32Array.from(wnd),
    angles: Float32Array.from(ang),
    aspects: Float32Array.from(asp),
  };

  return { surfaceGeo, shore, level, radius: maxR, cx: bestX, cz: bestZ };
}
