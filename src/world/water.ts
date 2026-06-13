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
// centre fades through a mid-band to a pale sky-skimmed shallow at the rim, with
// a baked sun-glitter sheen riding the surface toward the sun and a Fresnel-style
// rim that drinks the bright sky where the water thins out. The fan carries TWO
// rings (a mid ring + the shore ring) so the gradient is smooth and so the very
// gently displaced surface gives the lit material a quiet, varied highlight
// instead of one flat slab of specular. A ragged ring of wet, dark mud dabs is
// emitted into the SHARED splat layer so the shore reads wet and broken-up in the
// same painterly language as the turf.
//
// Cost: a pool is only built when a chunk genuinely contains a deep wet basin, so
// most chunks emit nothing. All placement noise is sampled, never per-frame, and
// the geometry is a few dozen verts. The shore march reuses its height samples and
// the dab arrays are sized once — no growth/`Float32Array.from` churn.

const _sun = new THREE.Vector3(...SUN_DIR).normalize();
const _col = new THREE.Color();
const _sky = new THREE.Color();

// Tiny, calm surface undulation baked into the lit fan: just enough that the
// low-roughness specular wanders softly across the pool instead of being one
// frozen flat highlight. Pure geometry — no per-frame work, the surface is still.
const RIPPLE = 0.05; // metres of vertical relief on the inner rings (very subtle)

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
  const sx = _sun.x, sz = _sun.z; // sun azimuth, for the baked glitter sheen

  // ---- radial shoreline: march each spoke out to where land meets the waterline ----
  // For every spoke we keep its unit direction, its found shore radius and the
  // shore world point — the surface fan, the rim shading and the dab ring all read
  // from these, so each spoke's geometry is computed exactly once.
  const SEG = 40;
  const dirX = new Float32Array(SEG);
  const dirZ = new Float32Array(SEG);
  const radS = new Float32Array(SEG); // shore radius per spoke
  const ringX = new Float32Array(SEG); // shore vertex x
  const ringZ = new Float32Array(SEG); // shore vertex z
  const step = maxR / 14;
  for (let s = 0; s < SEG; s++) {
    const a = (s / SEG) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    // March outward in small steps; stop where the bed rises to the waterline.
    let r = maxR;
    for (let t = step; t <= maxR; t += step) {
      if (field.height(bestX + ca * t, bestZ + sa * t) >= level) { r = t; break; }
    }
    // Organic wobble so the outline frays in/out — never a clean circle.
    const wob = 0.82 + 0.18 * Math.sin(a * 3 + phase) + 0.1 * Math.sin(a * 7 - phase * 1.7);
    r = Math.max(2.5, r * THREE.MathUtils.clamp(wob, 0.5, 1.15));
    dirX[s] = ca; dirZ[s] = sa; radS[s] = r;
    ringX[s] = bestX + ca * r; ringZ[s] = bestZ + sa * r;
  }

  // ---- surface fan: centre + a mid ring + the shore ring, vertex-coloured ----
  // Two rings give a smooth deep→shallow gradient AND let the lit material catch a
  // softly varied calm sheen (the inner verts sit a hair higher with a baked, still
  // ripple, so the specular wanders gently instead of being a single flat slab).
  // Layout: [0] centre, [1..SEG] mid ring, [SEG+1..2*SEG] shore ring.
  const vcount = 1 + SEG * 2;
  const pos = new Float32Array(vcount * 3);
  const col = new Float32Array(vcount * 3);

  // centre: deepest, coolest, with a faint warm sun-kiss so it doesn't read flat.
  _col.copy(palette.waterDeep).lerp(palette.waterShallow, 0.1).lerp(palette.sun, 0.04);
  pos[0] = bestX; pos[1] = level; pos[2] = bestZ;
  col[0] = _col.r; col[1] = _col.g; col[2] = _col.b;

  // Sky tone the thin rim "drinks" via a Fresnel-style brightening — a still tarn
  // at a grazing angle mirrors the luminous pale-blue horizon, lifting the edge.
  _sky.copy(palette.skyHorizon).lerp(palette.waterShallow, 0.35);

  for (let s = 0; s < SEG; s++) {
    const ca = dirX[s], sa = dirZ[s], r = radS[s];
    // baked glitter: brighter toward the sun azimuth (0 away → 1 toward the sun)
    const sheen = THREE.MathUtils.clamp((ca * sx + sa * sz) * 0.5 + 0.5, 0, 1);
    // a slow surface "breath" so the sheen breaks into a couple of soft glints
    // rather than a clean lobe — still, fixed in place, never animated.
    const glint = sheen * sheen * (0.55 + 0.45 * Math.sin(s * 0.9 + phase));

    // --- mid ring (≈55% out): the body deepening to the centre ---
    const mIdx = (s + 1) * 3;
    const mx = bestX + ca * r * 0.55, mz = bestZ + sa * r * 0.55;
    pos[mIdx] = mx;
    pos[mIdx + 1] = level + RIPPLE * Math.sin(s * 1.7 + phase) * 0.6;
    pos[mIdx + 2] = mz;
    _col.copy(palette.waterDeep).lerp(palette.waterShallow, 0.28 + sheen * 0.18);
    if (glint > 0.5) _col.lerp(palette.waterShallow, (glint - 0.5) * 0.5);
    col[mIdx] = _col.r; col[mIdx + 1] = _col.g; col[mIdx + 2] = _col.b;

    // --- shore ring (the marched waterline): pale sun-skimmed shallow + sky rim ---
    const sIdx = (SEG + 1 + s) * 3;
    pos[sIdx] = ringX[s];
    pos[sIdx + 1] = level + RIPPLE * Math.sin(s * 2.3 - phase) * 0.3;
    pos[sIdx + 2] = ringZ[s];
    _col.copy(palette.waterDeep).lerp(palette.waterShallow, 0.6 + sheen * 0.3);
    // Fresnel rim: the thinnest, widest-open shallows drink the bright sky.
    const fres = THREE.MathUtils.clamp(r / maxR, 0, 1);
    _col.lerp(_sky, fres * 0.4);
    if (glint > 0.45) _col.lerp(palette.waterShallow, (glint - 0.45) * 0.6);
    col[sIdx] = _col.r; col[sIdx + 1] = _col.g; col[sIdx + 2] = _col.b;
  }

  // Index: an inner fan (centre→mid ring) plus a ring band (mid→shore), so the
  // gradient and lighting interpolate across two bands instead of one long taper.
  const index = new Uint16Array(SEG * 3 + SEG * 6);
  let ii = 0;
  for (let s = 0; s < SEG; s++) {
    const sn = (s + 1) % SEG;
    const mA = s + 1, mB = sn + 1; // mid-ring verts
    const oA = SEG + 1 + s, oB = SEG + 1 + sn; // shore-ring verts
    // inner fan triangle
    index[ii++] = 0; index[ii++] = mA; index[ii++] = mB;
    // outer band quad (two triangles): mid → shore
    index[ii++] = mA; index[ii++] = oA; index[ii++] = oB;
    index[ii++] = mA; index[ii++] = oB; index[ii++] = mB;
  }

  const surfaceGeo = new THREE.BufferGeometry();
  surfaceGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  surfaceGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  surfaceGeo.setIndex(new THREE.BufferAttribute(index, 1));
  surfaceGeo.computeVertexNormals(); // mostly-up with a soft varied tilt → calm sheen
  surfaceGeo.computeBoundingSphere();

  // ---- wet-mud shoreline dabs (shared splat layer) ----
  // A ragged ring of dark, damp earth right at the waterline plus a few just
  // outside it — so the shore reads wet and broken, not a drawn outline. Sized to
  // SEG up front and filled with a running cursor (no array growth / `.from`).
  const cen = new Float32Array(SEG * 3);
  const cols = new Float32Array(SEG * 3);
  const scl = new Float32Array(SEG);
  const wnd = new Float32Array(SEG); // all 0: wet mud doesn't sway
  const ang = new Float32Array(SEG);
  const asp = new Float32Array(SEG);
  let n = 0;
  for (let s = 0; s < SEG; s++) {
    if (rnd() < 0.4) continue; // break the ring up so it isn't a solid band
    // nudge each dab a little in/out along its (already unit) spoke for a frayed rim
    const off = (rnd() - 0.35) * 2.4;
    const dr = radS[s] + off;
    const dx = bestX + dirX[s] * dr;
    const dz = bestZ + dirZ[s] * dr;
    const gy = field.height(dx, dz);
    _col.copy(palette.waterEdge).lerp(palette.pathEarth, rnd() * 0.4)
      .offsetHSL(0, (rnd() - 0.5) * 0.04, (rnd() - 0.5) * 0.12);
    const c3 = n * 3;
    cen[c3] = dx; cen[c3 + 1] = gy + 0.18; cen[c3 + 2] = dz;
    cols[c3] = _col.r; cols[c3 + 1] = _col.g; cols[c3 + 2] = _col.b;
    scl[n] = 1.0 + rnd() * 1.3;
    ang[n] = rnd() * Math.PI;
    asp[n] = 0.9 + rnd() * 0.3;
    n++;
  }

  // Trim to the dabs we actually placed (typed-array views — no copies of the data
  // beyond the final slice the consumer keeps).
  const shore = n === 0 ? null : {
    centers: cen.subarray(0, n * 3),
    scales: scl.subarray(0, n),
    colors: cols.subarray(0, n * 3),
    winds: wnd.subarray(0, n),
    angles: ang.subarray(0, n),
    aspects: asp.subarray(0, n),
  };

  return { surfaceGeo, shore, level, radius: maxR, cx: bestX, cz: bestZ };
}
