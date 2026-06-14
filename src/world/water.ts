import * as THREE from 'three/webgpu';
import {
  positionLocal, time, sin, vec3, float, mix, attribute, vertexColor, smoothstep, clamp,
} from 'three/tsl';
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
// frozen flat highlight. This baked relief is now ALSO animated at runtime by the
// node material below (the travelling ripple rides on top of it).
const RIPPLE = 0.05; // metres of vertical relief on the inner rings (very subtle)

// ---- live-water animation knobs (speed / amplitude) ----
// Tuned for a CALM stream/tarn: travelling waves of a few cm, drifting slowly in
// one direction like a gentle current, plus a slow sky-sheen scroll. Bump these to
// make the water busier; drop them toward 0 to freeze it.
const WAVE_AMP = 0.06; // metres of vertical ripple (world scale) — very subtle
const WAVE_FREQ = 0.08; // spatial frequency (1/m) — long, lazy swells, not chop
const WAVE_SPEED = 0.55; // how fast the ripple front drifts (the "current")

// ---- COLOUR-DRIVEN motion (the geometric ripple above is too small to read from a
// fast, high glide, so the *visible* "it's alive" cue is animated COLOUR instead) ----
// Drifting caustic bands: two crossing travelling sine fields interfere into moving
// light/dark patches that slide across the surface — the eye reads flow even on a
// near-flat low-poly disc.
const CAUSTIC_FREQ_A = 0.17; // 1/m — primary caustic band frequency
const CAUSTIC_FREQ_B = 0.1; // 1/m — secondary, crosses the first
const CAUSTIC_SPEED = 0.85; // how fast the bright bands drift downstream
const CAUSTIC_STRENGTH = 0.34; // how strongly the bands lighten the surface toward sky-blue
// Shore foam: a pale lip that LAPS in and out at the waterline (a travelling pulse,
// gated to the rim by the baked aShore factor) — reads as water breaking on the shore.
const FOAM_SPEED = 1.7; // how fast the foam laps along the shore
const FOAM_FREQ = 0.55; // 1/m — wavelength of the lapping band (short, frothy)
const FOAM_STRENGTH = 0.9; // peak whiteness of the foam at the rim
const FOAM = new THREE.Color('#eef6f7'); // near-white shore foam / splash

/**
 * Calm, MOVING water surface material (TSL node material). Shared by every water
 * mesh, so the animation is driven entirely on the GPU from the `time` node — no
 * per-frame CPU work, no per-chunk uniforms. Two cues sell the motion:
 *
 *  1) A low-amplitude travelling RIPPLE in `positionNode`: two summed sines of the
 *     surface's WORLD x/z (the chunk group sits at the origin, so the mesh's local
 *     position equals its world position) advanced by `time`. The waves drift in
 *     one direction like a current and stay phase-coherent across chunk seams.
 *
 *  2) A scrolling sky SHEEN folded into `emissiveNode`: a slow sine band sweeping
 *     across the surface in world space lifts the existing sky-blue emissive where
 *     it passes, so highlights travel along the stream. This is the strongest "it's
 *     moving" cue and reads even where the mesh is nearly flat / low-poly.
 *
 * Everything else is preserved: vertex colours (the baked waterDeep→shallow→edge
 * tones), the gentle sky-blue emissive lift, transparency, and the diffuse (non-
 * mirror) lit look — so it still matches the soft world, just alive.
 */
export function makeWaterMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  // vertexColors OFF: we read the baked wash explicitly via vertexColor() and own the
  // whole colour chain in colorNode (so the flag can't double-multiply our result).
  mat.vertexColors = false;
  mat.roughness = 0.5;
  mat.metalness = 0.0;
  mat.transparent = true;
  mat.opacity = 0.92;

  // World position of this surface vertex (group is at origin → local == world, so the
  // animation stays phase-coherent across chunk seams).
  const p = positionLocal;
  const wx = p.x;
  const wz = p.z;
  const t = time;
  // Baked radial factor: 0 at the pool centre → 1 at the marched waterline (see
  // buildWater). Lets the shared shader know where the shore is, for the foam.
  const shore = attribute('aShore', 'float');

  // --- (1) keep a tiny travelling vertical ripple so the lit specular still wanders
  // (subtle; the *visible* motion is the colour animation below). ---
  const w1 = sin(wx.mul(WAVE_FREQ).add(wz.mul(WAVE_FREQ * 0.6)).add(t.mul(WAVE_SPEED)));
  const w2 = sin(wx.mul(WAVE_FREQ * 1.7).sub(wz.mul(WAVE_FREQ * 0.9)).add(t.mul(WAVE_SPEED * 0.7)));
  mat.positionNode = vec3(p.x, p.y.add(w1.add(w2.mul(0.5)).mul(WAVE_AMP)), p.z);

  // --- (2) DRIFTING CAUSTIC BANDS (the main "it's moving" cue) -----------------
  // Two crossing travelling sine fields interfere into bright/dark patches that slide
  // across the surface. Squared so the bright crests read as discrete moving glints on
  // a darker body rather than a uniform pulse. This is pure colour — visible even when
  // the disc is geometrically flat and far away.
  const cA = sin(wx.mul(CAUSTIC_FREQ_A).add(wz.mul(CAUSTIC_FREQ_A * 0.7)).add(t.mul(CAUSTIC_SPEED)));
  const cB = sin(wx.mul(CAUSTIC_FREQ_B).sub(wz.mul(CAUSTIC_FREQ_B * 1.3)).add(t.mul(CAUSTIC_SPEED * 0.6)));
  const causticRaw = cA.add(cB).mul(0.25).add(0.5); // 0..1 moving field
  const caustic = causticRaw.mul(causticRaw); // sharpen the crests

  // --- (3) SHORE FOAM — a pale lip that LAPS in and out at the waterline ---------
  // A short-wavelength band travelling along the surface, gated hard to the rim by the
  // baked shore factor, squared for a frothy crest. Reads as water breaking on shore.
  const lap = sin(wx.mul(FOAM_FREQ).add(wz.mul(FOAM_FREQ * 1.1)).sub(t.mul(FOAM_SPEED)))
    .mul(0.5).add(0.5);
  const lap2 = sin(wx.mul(FOAM_FREQ * 0.6).sub(wz.mul(FOAM_FREQ * 0.8)).sub(t.mul(FOAM_SPEED * 0.7)))
    .mul(0.5).add(0.5);
  const rim = smoothstep(float(0.55), float(1.0), shore); // only near the waterline
  const foam = clamp(lap.mul(lap2).mul(rim).mul(FOAM_STRENGTH), float(0.0), float(1.0));

  // --- compose the surface colour ---------------------------------------------
  const base = vertexColor().rgb; // baked deep→shallow gradient
  const skyBright = vec3(palette.waterShallow.r, palette.waterShallow.g, palette.waterShallow.b);
  const foamCol = vec3(FOAM.r, FOAM.g, FOAM.b);
  // lighten toward sky-blue where the caustics crest, then lay the white foam on top
  let color = mix(base, skyBright, caustic.mul(CAUSTIC_STRENGTH));
  color = mix(color, foamCol, foam);
  mat.colorNode = color;

  // emissive: a gentle constant sky lift + a touch riding the caustic crests and the
  // foam, so both the drifting glints and the breaking foam stay bright through the
  // lighting/grade (added after lighting → guaranteed to read as motion).
  const sky = vec3(palette.skyHorizon.r, palette.skyHorizon.g, palette.skyHorizon.b);
  mat.emissiveNode = sky.mul(float(0.26).add(caustic.mul(0.16))).add(foamCol.mul(foam.mul(0.45)));

  return mat;
}

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

  // ---- surface fan: centre + an inner ring + a mid ring + the shore ring ----
  // THREE rings (was two) give a smooth deep→shallow gradient AND enough radial
  // samples that the animated travelling ripple (driven in the node material from
  // world position) reads as a smooth heave across the pool rather than faceting
  // over a couple of huge triangles. The extra ring is a handful of verts — water
  // is rare and small, so it stays cheap. Each ring still carries the baked still
  // relief; the runtime ripple rides on top of it.
  // Layout: [0] centre, [1..SEG] inner ring, [SEG+1..2*SEG] mid ring,
  //         [2*SEG+1..3*SEG] shore ring.
  const RING_F = [0.32, 0.64]; // inner / mid ring radii as a fraction of the spoke
  const vcount = 1 + SEG * 3;
  const pos = new Float32Array(vcount * 3);
  const col = new Float32Array(vcount * 3);
  // Per-vertex shore factor (0 at the centre → 1 at the marched waterline). Read by
  // makeWaterMaterial to lap animated foam onto exactly the rim, in the shared shader.
  const shoreF = new Float32Array(vcount);

  // centre: deepest, coolest, with a faint warm sun-kiss so it doesn't read flat.
  _col.copy(palette.waterDeep).lerp(palette.waterShallow, 0.1).lerp(palette.sun, 0.04);
  pos[0] = bestX; pos[1] = level; pos[2] = bestZ;
  col[0] = _col.r; col[1] = _col.g; col[2] = _col.b;
  shoreF[0] = 0; // centre

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

    // --- inner & mid rings: the body deepening to the centre ---
    for (let k = 0; k < 2; k++) {
      const f = RING_F[k];
      const idx = (1 + k * SEG + s) * 3;
      pos[idx] = bestX + ca * r * f;
      pos[idx + 1] = level + RIPPLE * Math.sin(s * (1.7 + k * 0.6) + phase) * (0.6 - k * 0.18);
      pos[idx + 2] = bestZ + sa * r * f;
      // deepen→shallow with radius; the mid ring is a touch paler than the inner.
      _col.copy(palette.waterDeep).lerp(palette.waterShallow, 0.2 + f * 0.22 + sheen * 0.18);
      if (glint > 0.5) _col.lerp(palette.waterShallow, (glint - 0.5) * 0.5);
      col[idx] = _col.r; col[idx + 1] = _col.g; col[idx + 2] = _col.b;
      shoreF[1 + k * SEG + s] = f; // radial fraction → shore factor for this ring
    }

    // --- shore ring (the marched waterline): pale sun-skimmed shallow + sky rim ---
    const sIdx = (1 + 2 * SEG + s) * 3;
    pos[sIdx] = ringX[s];
    pos[sIdx + 1] = level + RIPPLE * Math.sin(s * 2.3 - phase) * 0.3;
    pos[sIdx + 2] = ringZ[s];
    _col.copy(palette.waterDeep).lerp(palette.waterShallow, 0.6 + sheen * 0.3);
    // Fresnel rim: the thinnest, widest-open shallows drink the bright sky.
    const fres = THREE.MathUtils.clamp(r / maxR, 0, 1);
    _col.lerp(_sky, fres * 0.4);
    if (glint > 0.45) _col.lerp(palette.waterShallow, (glint - 0.45) * 0.6);
    col[sIdx] = _col.r; col[sIdx + 1] = _col.g; col[sIdx + 2] = _col.b;
    shoreF[1 + 2 * SEG + s] = 1.0; // the marched waterline → full shore factor (foam laps here)
  }

  // Index: an inner fan (centre→inner ring) plus two ring bands (inner→mid→shore),
  // so the gradient and the animated ripple interpolate across three bands.
  const index = new Uint16Array(SEG * 3 + SEG * 6 * 2);
  let ii = 0;
  const ringStart = (k: number) => 1 + k * SEG; // first vert index of ring k (0=inner)
  for (let s = 0; s < SEG; s++) {
    const sn = (s + 1) % SEG;
    const iA = ringStart(0) + s, iB = ringStart(0) + sn; // inner-ring verts
    // inner fan triangle (centre → inner ring)
    index[ii++] = 0; index[ii++] = iA; index[ii++] = iB;
    // two ring bands: inner→mid, then mid→shore
    for (let k = 0; k < 2; k++) {
      const aA = ringStart(k) + s, aB = ringStart(k) + sn; // band's inner edge
      const bA = ringStart(k + 1) + s, bB = ringStart(k + 1) + sn; // band's outer edge
      index[ii++] = aA; index[ii++] = bA; index[ii++] = bB;
      index[ii++] = aA; index[ii++] = bB; index[ii++] = aB;
    }
  }

  const surfaceGeo = new THREE.BufferGeometry();
  surfaceGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  surfaceGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  surfaceGeo.setAttribute('aShore', new THREE.BufferAttribute(shoreF, 1));
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
