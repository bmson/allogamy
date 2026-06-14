import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, float, mix, clamp, max, min, dot, smoothstep, fract, sin, floor,
  oneMinus, abs, uniform, vertexColor, normalWorld, positionLocal,
  positionViewDirection, screenCoordinate, length, step, attribute,
} from 'three/tsl';
import { SUN_DIR } from '../config';

// ===========================================================================
// THE PELICAN'S SKIN — a FLAT, HAND-DRAWN 2D ILLUSTRATION shader.
//
// The previous skin inked a screen-space pencil hatch over a flattened albedo —
// but it still drove the marks from a SMOOTH wrapped n·sun ramp, so the body kept
// reading as a 3D model: a continuous light→dark gradient sculpts form like a lit
// solid, and the eye can't help but see volume. The brief: make the bird read as a
// FLAT, hand-DRAWN 2D illustration moving through the painted world — NOT a lit 3D
// model. The single biggest "less-3D" lever is killing that smooth gradient.
//
// HOW THIS KILLS THE 3D READ — three cooperating moves:
//
//   1. FLATTEN / QUANTIZE THE LIGHT. The smooth n·sun is SNAPPED to two (→three)
//      hard FLAT regions — a light fill and a shadow fill (with an optional mid) —
//      via a `flatten` knob (0 = the old smooth ramp, 1 = fully posterised flat
//      fills). A continuous gradient is what makes a surface read as a curved 3D
//      solid; replacing it with a couple of flat ink-wash fills makes the body read
//      as filled SHAPES on paper. This is the heart of the effect.
//
//   2. NOISE-WARP THE TERMINATOR + MOTTLE THE FILLS. The boundary between the light
//      and shadow fills is displaced by procedural fbm noise, so the shadow edge is
//      a WAVERING hand-painted line rather than a clean 3D terminator that traces
//      the geometry. The flat fills are then mottled by a second, finer fbm wash so
//      each fill reads as a dry-ink / watercolour wash with grain — never a smooth
//      shaded plastic. The noise is sampled in OBJECT space so the wash STICKS to
//      the surface (it doesn't swim as the bird banks), reading as paint laid on the
//      bird, with a faint screen-space paper grain layered on for a drawn-on feel.
//
//   3. STRONG WOBBLY INKED OUTLINE. A hand-inked contour from the grazing-angle
//      fresnel bounds the silhouette + interior folds, its threshold wobbled by
//      noise so the line breathes like a pen line, not a vector-clean rim. A flat
//      fill only reads as an intentional DRAWING once it's bounded by an inked edge;
//      without it the flat shape looks like an untextured blob.
//
// The existing screen-space pencil HATCH is folded back in as ONE restrained layer,
// gated to the shadow fill only, to give the dark side a little drawn tooth — but it
// is no longer the primary look and is dialled low by default.
//
// We keep the bird's palette IDENTITY (pearl-grey body, charcoal primaries, warm
// ochre bill) as FLAT ink/wash tones: the baked per-vertex wash is read for HUE only
// (its value is normalised away) so the fills carry the creature's colour without
// re-introducing the bake's own 3D shading. World-space normals drive the (now
// quantized) light so the flat fills still flip light↔shadow as the bird banks and
// the sun tracks across it — it reads as a drawing that's AWARE of the light, not a
// frozen sticker. The full-frame post pass grades the scene; we don't re-grade here.
// ===========================================================================

// World sun direction (toward the sun), matching the scene + the geometry's baked
// `sunlit` term so the flat fills agree with the world's light.
const SUN = new THREE.Vector3(...SUN_DIR).normalize();

// Ink / paper / wash identity tones. The bird is a pearl-grey pelican with a
// charcoal crown/primaries and a warm ochre bill (see birdGeometry palette). We
// render it as flat ink-WASH fills on warm paper: a LIGHT fill (near-white warm
// paper holding the lit shapes), a SHADOW fill (a cool grey-blue wash), and a dark
// INK for the wavering contour + the sparse hatch. Each is nudged toward the bird's
// own albedo per-fragment so the fills keep the creature's identity (grey plumage
// washes grey, the warm bill washes a warmer sepia).
const PAPER = new THREE.Color('#f4f2ec');     // warm off-white drawing paper (light fill)
const SHADOW = new THREE.Color('#9fa9b8');    // cool grey-blue ink-wash (shadow fill)
const MIDWASH = new THREE.Color('#c9cdd2');   // optional mid fill between light & shadow
const INK = new THREE.Color('#23232b');       // near-black contour / hatch ink
const KEY_WARM = new THREE.Color('#fff0cf');  // scene's warm golden key (warms the lit fill)

/**
 * Live-tunable knobs for the flat hand-drawn bird. All safe to nudge from a debug
 * panel; defaults lean STRONGLY toward the flat 2D-illustration look.
 */
export interface BirdShadeOpts {
  flatten?: number;     // 0 = smooth ramp (old 3D look) → 1 = fully posterised flat fills
  bands?: number;       // # of flat regions when flat: 2 = light/shadow, 3 = + a mid wash
  wrap?: number;        // half-Lambert wrap of the underlying n·sun (soft falloff)
  shadeLift?: number;   // value floor — how light the shadow fill stays (less ink)
  noiseScale?: number;  // object-space wash/mottle frequency (bigger = finer grain)
  noiseStrength?: number; // how strongly the fbm wash mottles the flat fills
  edgeWobble?: number;  // how far noise warps the light↔shadow terminator (wavering edge)
  outline?: number;     // inked silhouette/interior contour strength
  outlineWobble?: number; // noise wobble of the inked edge (hand-drawn, not vector-clean)
  hatch?: number;       // sparse pencil hatch in the shadow fill (0 = none, 1 = strong)
  hatchScale?: number;  // hatch line spacing in screen pixels
  paperWarmth?: number; // how much the lit fill warms toward the scene's golden key
  tintIdentity?: number; // how strongly the fills take on the bird's own albedo hue
  emissiveTint?: THREE.Color; // optional cool cast (wings keep their slate identity)
  mergeMask?: boolean;  // read the per-vertex `aMerge` attribute (body + wings) and, at
                        // the wing↔body junction, suppress the inked contour AND relax
                        // the toon quantization to a smooth ramp — so the wing root flows
                        // into the body with no inked "cut" line and no hard band-step.
}

const DEFAULTS: Required<Omit<BirdShadeOpts, 'emissiveTint'>> = {
  flatten: 0.92,        // STRONGLY flat: the shading snaps to hard fills, not a ramp
  bands: 3,             // light / mid / shadow — three flat ink-wash regions
  wrap: 0.55,           // soft underlying half-Lambert before it's posterised
  shadeLift: 0.34,      // keep the shadow fill an open grey wash, never a black hole
  noiseScale: 5.5,      // object-space wash frequency (a few mottled patches per body)
  noiseStrength: 0.5,   // a confident watercolour/dry-ink mottle on every fill
  edgeWobble: 0.32,     // the terminator wavers like a hand-painted shadow edge
  outline: 1.05,        // a bold hand-inked contour — the form's 2D boundary
  outlineWobble: 0.4,   // the edge breathes; never a clean vector rim
  hatch: 0.3,           // a light pencil tooth in the shadow only (secondary, not primary)
  hatchScale: 7.5,
  paperWarmth: 0.4,     // lit fill warms toward the golden key — the only "light" tint
  tintIdentity: 0.62,   // identity HUE only — applied to a value-flattened albedo
  mergeMask: false,     // off for parts without the aMerge attribute (e.g. legs)
};

// ---------------------------------------------------------------------------
// TSL VALUE NOISE — implemented here (no engine helper). A hashed value-noise on a
// lattice, smoothstep-interpolated, summed over a few octaves into fbm. Two flavours:
//   • hash21 / vnoise2 : 2D, used for the screen-space hatch waver + paper grain.
//   • hash31 / vnoise3 / fbm3 : 3D, sampled in OBJECT space so the watercolour wash
//     and the terminator warp STICK to the surface as the bird flies.
// ---------------------------------------------------------------------------

// 2D hash → [0,1)
const hash21 = /*#__PURE__*/ Fn(([p]: [any]) => {
  return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
});

// 2D smooth value noise (bilinear of the hash on a coarse grid).
const vnoise2 = /*#__PURE__*/ Fn(([p]: [any]) => {
  const i = floor(p);
  const f = fract(p);
  const u: any = f.mul(f).mul(float(3.0).sub(f.mul(2.0))); // smoothstep weights (vec2)
  const a = hash21(i);
  const b = hash21(i.add(vec2(1.0, 0.0)));
  const c = hash21(i.add(vec2(0.0, 1.0)));
  const d = hash21(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

// 3D hash → [0,1). Dotted against an irrational vector then sined/fracted — cheap,
// no texture, stable per object-space lattice cell.
const hash31 = /*#__PURE__*/ Fn(([p]: [any]) => {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))).mul(43758.5453));
});

// 3D smooth value noise: trilinear interpolation of the 8 corner hashes of the cell,
// with smoothstep weights → a soft continuous field with no grid creases.
const vnoise3 = /*#__PURE__*/ Fn(([p]: [any]) => {
  const i = floor(p);
  const f = fract(p);
  const u: any = f.mul(f).mul(float(3.0).sub(f.mul(2.0))); // smoothstep weights (vec3)
  const c000 = hash31(i.add(vec3(0.0, 0.0, 0.0)));
  const c100 = hash31(i.add(vec3(1.0, 0.0, 0.0)));
  const c010 = hash31(i.add(vec3(0.0, 1.0, 0.0)));
  const c110 = hash31(i.add(vec3(1.0, 1.0, 0.0)));
  const c001 = hash31(i.add(vec3(0.0, 0.0, 1.0)));
  const c101 = hash31(i.add(vec3(1.0, 0.0, 1.0)));
  const c011 = hash31(i.add(vec3(0.0, 1.0, 1.0)));
  const c111 = hash31(i.add(vec3(1.0, 1.0, 1.0)));
  const x00 = mix(c000, c100, u.x);
  const x10 = mix(c010, c110, u.x);
  const x01 = mix(c001, c101, u.x);
  const x11 = mix(c011, c111, u.x);
  const y0 = mix(x00, x10, u.y);
  const y1 = mix(x01, x11, u.y);
  return mix(y0, y1, u.z);
});

// 3D fBm — three octaves of vnoise3, halving amplitude / ~doubling frequency, with
// an offset per octave so they don't align. Returns ~[0,1]. This is the
// watercolour/dry-ink wash that mottles the flat fills and warps the terminator.
const fbm3 = /*#__PURE__*/ Fn(([p]: [any]) => {
  const o1 = vnoise3(p);
  const o2 = vnoise3(p.mul(2.03).add(vec3(11.5, 3.2, 7.8)));
  const o3 = vnoise3(p.mul(4.07).add(vec3(5.1, 19.3, 2.4)));
  // weights sum to 1 so the result stays in ~[0,1]
  return o1.mul(0.57).add(o2.mul(0.29)).add(o3.mul(0.14));
});

// ONE hatch layer: parallel screen-space lines at angle (ca, sa), spaced `scale`
// pixels, soft-edged with a little noisy waver. Returns INK COVERAGE in [0,1].
const hatchLayer = /*#__PURE__*/ Fn((
  [frag, ca, sa, scale, jitter, phase]:
  [any, any, any, any, any, any],
) => {
  const u = frag.x.mul(ca).add(frag.y.mul(sa));
  const wob = vnoise2(frag.mul(0.06).add(phase)).sub(0.5).mul(jitter).mul(scale);
  const coord = u.add(wob).div(scale).add(phase);
  const tri = abs(fract(coord).sub(0.5)).mul(2.0); // 0 at line centre → 1 between
  const cov = oneMinus(smoothstep(float(0.08), float(0.5), tri));
  const grain = vnoise2(vec2(u.mul(0.5), frag.y.mul(ca).sub(frag.x.mul(sa)).mul(0.5)));
  return clamp(cov.mul(float(0.75).add(grain.mul(0.5))), float(0.0), float(1.0));
});

/**
 * Build the flat hand-drawn bird material. Same signature/return type as before, so
 * Bird.ts's call sites (`makeBirdMaterial()` / `makeBirdMaterial({...})`) are
 * unchanged. The baked per-vertex wash is read as the albedo and used only to TINT
 * the flat fills to the creature's identity; light → flat-fill choice is owned by
 * colorNode below.
 *
 * @param opts  optional per-part overrides (legs use a finer hatch; wings can carry
 *              a cooler slate cast via emissiveTint).
 */
export function makeBirdMaterial(opts: BirdShadeOpts = {}): BirdMaterial {
  const o = { ...DEFAULTS, ...opts };
  const mat = new THREE.MeshBasicNodeMaterial();
  // vertexColors OFF: NodeMaterial would auto-multiply colorNode by vertexColor()
  // when true, but WE read the baked wash explicitly (as the identity tint) so the
  // whole shading chain is owned by colorNode.
  mat.vertexColors = false;
  mat.fog = false; // the painterly world has fog off; the post pass owns atmosphere

  // --- uniforms (exposed for live tuning without a rebuild) ---
  const uFlatten = uniform(o.flatten);
  const uBands = uniform(o.bands);
  const uWrap = uniform(o.wrap);
  const uShadeLift = uniform(o.shadeLift);
  const uNoiseScale = uniform(o.noiseScale);
  const uNoiseStrength = uniform(o.noiseStrength);
  const uEdgeWobble = uniform(o.edgeWobble);
  const uOutline = uniform(o.outline);
  const uOutlineWobble = uniform(o.outlineWobble);
  const uHatch = uniform(o.hatch);
  const uHatchScale = uniform(o.hatchScale);
  const uPaperWarmth = uniform(o.paperWarmth);
  const uTintIdentity = uniform(o.tintIdentity);

  const sun = vec3(SUN.x, SUN.y, SUN.z);
  const paper = vec3(PAPER.r, PAPER.g, PAPER.b);
  const shadowCol = vec3(SHADOW.r, SHADOW.g, SHADOW.b);
  const midCol = vec3(MIDWASH.r, MIDWASH.g, MIDWASH.b);
  const ink = vec3(INK.r, INK.g, INK.b);
  const keyWarm = vec3(KEY_WARM.r, KEY_WARM.g, KEY_WARM.b);

  // --- IDENTITY ALBEDO (HUE ONLY) --------------------------------------------
  // Base albedo = the baked painterly vertex wash (heron-grey / charcoal / ochre),
  // but the bake carries its OWN 3D shading (top/under gradients, baked AO, a sunlit
  // term). Tinting with it raw would re-introduce that 3D gradient and fight the flat
  // fills. So FLATTEN its value: keep the hue/chroma (the colour identity — grey
  // plumage vs warm bill vs charcoal primaries) but re-seat lightness to a constant
  // mid. The only value variation on the bird then comes from the quantized live
  // light below, never from the bake.
  const rawAlbedo = vertexColor().rgb;
  const albLuma = dot(rawAlbedo, vec3(0.299, 0.587, 0.114));
  const FLAT_VALUE = float(0.62);
  const albedo = rawAlbedo.div(max(albLuma, float(0.04))).mul(FLAT_VALUE);

  // --- OBJECT-SPACE WASH COORD ------------------------------------------------
  // Sample the fbm wash in OBJECT space so the watercolour grain and the terminator
  // warp are PAINTED ON the bird — they stick to the surface and don't swim as it
  // banks. (positionLocal is pre-skinning; for an NPR wash that's perfect — the marks
  // sit on the body like ink, undisturbed by the flap.)
  const objP = positionLocal.xyz.mul(uNoiseScale);
  const wash = fbm3(objP);                         // ~[0,1] coarse-ish mottle
  const washFine = fbm3(objP.mul(2.7).add(vec3(8.0))); // finer second wash for grain

  // World-space normal so the (quantized) light tracks the sun as the bird banks.
  const N = normalWorld.normalize();

  // --- UNDERLYING LIGHT (before quantizing) ----------------------------------
  // Half-Lambert WRAP: remap n·sun from [-1,1] into a soft [0,1]; never crushes the
  // shaded side to black. Lift out of the floor by `shadeLift` so the shadow fill is
  // an open grey, not a black hole.
  const ndl = dot(N, sun);
  const wrapped = mix(
    max(ndl, float(0.0)),       // wrap = 0 → plain Lambert
    ndl.mul(0.5).add(0.5),      // wrap = 1 → fully wrapped half-Lambert
    uWrap,
  );
  // WARP the light value by the object-space wash BEFORE quantizing → the boundary
  // between fills (the terminator) bends and wavers along the noise instead of tracing
  // the clean geometric terminator. This is what turns the shadow edge into a
  // hand-painted line rather than a 3D light/dark seam.
  const warpedLight = clamp(
    wrapped.add(wash.sub(0.5).mul(uEdgeWobble)),
    float(0.0), float(1.0),
  );

  // --- QUANTIZE: smooth ramp → FLAT FILLS (the core "less 3D" move) -----------
  // Posterise the warped light into `bands` flat steps (2 = light/shadow, 3 = + mid).
  // step() positions, smoothstep() softens the knife-edge between fills just enough
  // that it reads as a brushed wash boundary, not aliased banding — but it is NOT a
  // smooth gradient: between the (noise-wobbled) thresholds the value is FLAT. We then
  // mix between the flat result and the original smooth `wrapped` by (1-flatten), so
  // flatten = 1 is fully posterised and flatten = 0 falls back to the old smooth ramp.
  //
  // Two thresholds carve up to three fills; the second is gated off when bands < 3 so
  // the body collapses to a clean light/shadow two-tone.
  const useMid = step(float(2.5), uBands); // 1 when bands >= 3
  const t0 = float(0.5);   // light  ↔ (mid|shadow) boundary
  const t1 = float(0.78);  // mid    ↔ light boundary (only when useMid)
  const soft = float(0.06); // a hair of softness so the wash edge isn't a hard alias
  // build a 0/0.5/1 quantized value:
  //   below t0           → shadow fill (0)
  //   t0..t1 (if mid)    → mid fill   (0.5)
  //   above t1 (or t0)   → light fill (1)
  const upper = smoothstep(t1.sub(soft), t1.add(soft), warpedLight);
  const lowerStep = smoothstep(t0.sub(soft), t0.add(soft), warpedLight);
  // with a mid band: shadow→mid at t0, mid→light at t1.
  const qMid = lowerStep.mul(0.5).add(upper.mul(0.5));
  // without a mid band: a single light/shadow split at t0.
  const qTwo = lowerStep;
  const quant = mix(qTwo, qMid, useMid);
  // WING↔BODY MERGE MASK: 1 exactly where the wing root buries into the body (and on
  // the body's matching shoulder shelf), 0 everywhere else. At the junction we relax
  // the flatten toward a SMOOTH ramp so the wing root's near-flat plane doesn't fall
  // into a different posterised light band than the curved body beside it — that band
  // mismatch is what reads as a hard pale→dark "cut" where the wing meets the flank.
  // Everywhere else the full flat 2D look is preserved.
  const merge = o.mergeMask
    ? clamp(attribute('aMerge', 'float'), float(0.0), float(1.0))
    : float(0.0);
  const localFlatten = uFlatten.mul(oneMinus(merge.mul(0.8)));
  // blend smooth↔flat by the (locally relaxed) flatten knob.
  const litFrac = mix(wrapped, quant, localFlatten); // 0 = shadow fill … 1 = light fill

  // --- BUILD THE FLAT IDENTITY FILLS -----------------------------------------
  // Each fill is a flat ink-wash tone tinted toward the bird's (value-flattened)
  // albedo hue so the creature's identity survives (grey body / warm bill). The lit
  // fill warms toward the golden key; the shadow fill stays a cool open grey.
  const tintLight = mix(paper, paper.mul(keyWarm), uPaperWarmth);
  const litFill = mix(tintLight, albedo, uTintIdentity.mul(0.5));
  // shadow fill: cool wash, tinted toward a slightly darker version of the identity.
  const shFill = mix(shadowCol, albedo.mul(0.72), uTintIdentity.mul(0.6));
  // mid fill: between the two, tinted toward identity too.
  const mdFill = mix(midCol, albedo.mul(0.86), uTintIdentity.mul(0.55));
  // lift the shadow fill toward the mid by `shadeLift` so the dark side stays an OPEN
  // wash (a drawing's shadows aren't black).
  const shFillLifted = mix(shFill, mdFill, uShadeLift);

  // compose the three flat fills by the quantized litFrac. With a mid band the value
  // lands on 0 / 0.5 / 1; map those to shadow / mid / light. Without it, litFrac is
  // 0 or 1 and the mid step is never reached.
  const lowHalf = mix(shFillLifted, mdFill, clamp(litFrac.mul(2.0), float(0.0), float(1.0)));
  const highHalf = mix(mdFill, litFill, clamp(litFrac.sub(0.5).mul(2.0), float(0.0), float(1.0)));
  let fill = mix(lowHalf, highHalf, step(float(0.5), litFrac));

  // --- WATERCOLOUR / DRY-INK MOTTLE on the flat fills ------------------------
  // Multiply each flat fill by an object-space fbm wash so it reads as pigment that
  // pooled and dried unevenly — the single strongest cue that this is PAINT, not a
  // shaded plastic surface. Centred on 1 so it darkens AND lightens patches; a finer
  // octave adds tooth. A faint screen-space paper grain layered on top sells the
  // "drawn on a sheet" feel. Kept multiplicative + clamped so it can't blow out.
  const frag = screenCoordinate.xy;
  const paperGrain = vnoise2(frag.mul(0.5)).sub(0.5).mul(0.06); // subtle on-paper tooth
  const mottle = oneMinus(uNoiseStrength).add(
    wash.mul(0.6).add(washFine.mul(0.4)).mul(uNoiseStrength).mul(2.0).mul(0.5),
  ).add(paperGrain);
  fill = clamp(fill.mul(mottle), vec3(0.0), vec3(1.4));

  // --- SPARSE PENCIL HATCH (secondary tooth, shadow only) --------------------
  // Two crossing screen-space hatch layers, revealed ONLY in the shadow fill, give
  // the dark side a little hand-drawn graphite tooth without re-introducing a
  // gradient. Dialled low by default — the flat fills are the primary look.
  const A1 = vec2(0.927, 0.375);  // ~22°
  const A2 = vec2(-0.375, 0.927); // ~112° (crosses A1)
  const h1 = hatchLayer(frag, A1.x, A1.y, uHatchScale, float(0.35), float(0.0));
  const h2 = hatchLayer(frag, A2.x, A2.y, uHatchScale.mul(0.92), float(0.35), float(13.3));
  // shadow mask: 1 deep in the shadow fill, 0 in the light fill (so light stays clean
  // paper). Uses the quantized litFrac so the hatch lives exactly inside the dark fill.
  const shadowMask = oneMinus(smoothstep(float(0.1), float(0.55), litFrac));
  const hatchCov = max(h1, h2).mul(shadowMask).mul(uHatch);

  // --- WOBBLY INKED CONTOUR ---------------------------------------------------
  // Fresnel from the view direction: 1 at grazing silhouette / interior edges, 0
  // facing us — a hand-inked contour bounding the form. The threshold is WOBBLED by
  // the object-space wash so the line thickens/thins and breathes like a pen line; a
  // touch of screen-space noise adds dry breaks. THIS is what makes the flat fills
  // read as an intentional drawing rather than an untextured blob.
  const fres = oneMinus(clamp(abs(dot(N, positionViewDirection.normalize())), float(0.0), float(1.0)));
  const wob = wash.sub(0.5).mul(uOutlineWobble); // ±wobble on the edge threshold
  const edgeNoise = vnoise2(frag.mul(0.09)).mul(0.3).add(0.8); // dry breaks along the line
  const lo = float(0.55).add(wob);
  const hi = float(0.86).add(wob);
  const contourCov = smoothstep(lo, hi, fres).mul(edgeNoise).mul(uOutline)
    .mul(oneMinus(merge.mul(0.92))); // no inked seam where the wing buries into the body

  // total ink coverage (hatch tooth + the bounding contour), clamped to full ink.
  const inkCov = clamp(max(hatchCov, contourCov), float(0.0), float(1.0));

  // --- INK-ON-FILL OUTPUT -----------------------------------------------------
  // ink tone tinted toward a deep version of the local identity so the warm bill inks
  // a touch warmer and the grey body inks cool charcoal — but kept dark.
  const albInk = min(albedo.mul(0.32), vec3(0.5));
  const idInk = mix(ink, albInk, uTintIdentity.mul(0.6));
  let outc = mix(fill, idInk, inkCov);

  // Optional cool sheen tint (used by the wing membranes to keep their slate cast):
  // a touch of the tint pushed into the result so the wing reads a hair cooler.
  if (opts.emissiveTint) {
    const t = opts.emissiveTint;
    outc = mix(outc, outc.mul(vec3(t.r, t.g, t.b).mul(2.2)), float(0.10));
  }

  mat.colorNode = outc;

  // expose knobs for live tuning (read/written as uniform .value)
  (mat as BirdMaterial).knobs = {
    flatten: uFlatten, bands: uBands, wrap: uWrap, shadeLift: uShadeLift,
    noiseScale: uNoiseScale, noiseStrength: uNoiseStrength, edgeWobble: uEdgeWobble,
    outline: uOutline, outlineWobble: uOutlineWobble, hatch: uHatch,
    hatchScale: uHatchScale, paperWarmth: uPaperWarmth, tintIdentity: uTintIdentity,
  };
  return mat as BirdMaterial;
}

export interface BirdMaterialKnobs {
  flatten: ReturnType<typeof uniform>;
  bands: ReturnType<typeof uniform>;
  wrap: ReturnType<typeof uniform>;
  shadeLift: ReturnType<typeof uniform>;
  noiseScale: ReturnType<typeof uniform>;
  noiseStrength: ReturnType<typeof uniform>;
  edgeWobble: ReturnType<typeof uniform>;
  outline: ReturnType<typeof uniform>;
  outlineWobble: ReturnType<typeof uniform>;
  hatch: ReturnType<typeof uniform>;
  hatchScale: ReturnType<typeof uniform>;
  paperWarmth: ReturnType<typeof uniform>;
  tintIdentity: ReturnType<typeof uniform>;
}
export type BirdMaterial = THREE.MeshBasicNodeMaterial & { knobs: BirdMaterialKnobs };
