import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, float, mix, clamp, max, min, dot, smoothstep, fract, sin, floor,
  oneMinus, pow, abs, uniform, vertexColor, normalWorld, positionWorld,
  positionViewDirection, screenCoordinate, length,
} from 'three/tsl';
import { SUN_DIR } from '../config';

// ===========================================================================
// THE PELICAN'S SKIN — a HAND-DRAWN, non-photorealistic "sketch" shader.
//
// The world is a soft painterly wash of dabs run through a Kuwahara + glow +
// impasto-on-paper post pass: it reads as something DRAWN. The bird used to be
// shaded as a soft toon figure — it sat in the painting, but it read as a
// *painted* solid, not a *drawn* one. The brief: make the pelican read as
// PENCIL-DRAWN / DOT-DRAWN — a cool NPR sketch that looks like a graphite (or
// stipple) drawing moving through the painting, so the eye reads it as "the
// drawn creature in the painted world."
//
// So we throw out the soft toon look and INK THE BIRD ON PAPER, in screen space:
//
//   • SHADED VALUE — a soft wrapped/half-Lambert n·sun gives a 0..1 lightness per
//     fragment (bright facing the sun, dark in shade). This VALUE drives how much
//     drawing (graphite/ink) we lay down: bright = bare paper, dark = dense marks.
//   • PENCIL CROSS-HATCHING — screen-space hatch lines at several orientations.
//     Bright areas are bare paper; as the value darkens we reveal one hatch layer,
//     then a second crossing layer, then a third/fourth — classic build-up of a
//     graphite drawing. The lines carry a little noise so edges read as soft
//     irregular graphite, never a clean printed grid.
//   • STIPPLE / HALFTONE DOTS — an alternative mark language: a screen-space dot
//     grid whose dot coverage GROWS as the value darkens (pointillist / dotted
//     shading), echoing the world's dab/splat language. A `hatchDot` knob blends
//     hatch (0) ↔ dots (1) so the user can pick "pencil" or "dotted."
//   • INK CONTOUR — a dark hand-inked edge-line from the grazing-angle fresnel
//     (and steep silhouette), drawn ON TOP so the form is bounded like a sketch.
//   • INK-ON-PAPER TINT — the marks are INK toned from the bird's identity (a warm
//     charcoal/heron tone derived from its own albedo) laid on a light PAPER tone
//     (also tinted by the albedo + scene light), so it still reads as the SAME
//     creature (heron-grey body, warm bill) — just drawn rather than rendered.
//
// We don't re-apply Kuwahara/grade here — the full-frame post pass already grades
// everything; it will sit the bird's marks on the same paper as the world. We use
// world-space normals so the shading (and thus the drawing density) tracks the sun
// as the bird banks, flaps and wheels. The screen-space marks are a CONSTANT
// on-screen size and shimmer slightly as the bird moves — that "redrawn each frame"
// flicker is exactly the hand-drawn feel we want.
// ===========================================================================

// World sun direction (toward the sun), matching the scene + the geometry's baked
// `sunlit` term so the shaded value agrees with the world's light.
const SUN = new THREE.Vector3(...SUN_DIR).normalize();

// Ink / paper identity tones. The bird is a pearl-grey pelican with a charcoal
// crown/primaries and a warm ochre bill (see birdGeometry palette). We draw it in
// graphite: a near-white warm PAPER and a cool charcoal INK. Both get nudged toward
// the bird's own albedo per-fragment so the drawing keeps the creature's identity
// (grey plumage stays grey-graphite; the warm bill inks in a warmer sepia).
const PAPER = new THREE.Color('#f4f2ec'); // warm off-white drawing paper
const INK = new THREE.Color('#2b2b33'); // cool graphite/charcoal ink
const KEY_WARM = new THREE.Color('#fff0cf'); // scene's warm golden key (warms lit paper)

/**
 * Live-tunable knobs for the hand-drawn bird shading. All safe to nudge from a
 * debug panel; defaults lean toward a clear PENCIL (cross-hatch) look.
 */
export interface BirdShadeOpts {
  wrap?: number;       // half-Lambert wrap (0 = Lambert, 1 = fully wrapped/soft)
  ambient?: number;    // value floor — how light the *darkest* shade stays (less ink)
  inkStrength?: number; // overall darkness of the drawn marks (0 = faint, 1 = bold)
  hatchScale?: number;  // hatch line spacing in screen pixels (smaller = finer pencil)
  hatchSoft?: number;   // line edge softness (0 = crisp, 1 = very soft graphite)
  hatchJitter?: number; // irregular wobble of the hatch lines (hand-drawn waver)
  hatchDot?: number;    // 0 = pure cross-hatch (pencil), 1 = pure stipple/halftone dots
  dotScale?: number;    // stipple/halftone cell size in screen pixels
  contour?: number;     // inked silhouette/interior contour strength
  paperWarmth?: number; // how much the lit paper warms toward the scene's golden key
  tintIdentity?: number; // how strongly ink+paper take on the bird's own albedo hue
  emissiveTint?: THREE.Color; // optional cool cast (wings keep their slate identity)
}

const DEFAULTS: Required<Omit<BirdShadeOpts, 'emissiveTint'>> = {
  wrap: 0.55,
  ambient: 0.16,        // shade still leaves a little paper — never a solid black blob
  inkStrength: 0.92,    // bold, confident graphite
  hatchScale: 7.0,      // ~7 px between strokes — a clear, legible pencil hatch
  hatchSoft: 0.5,
  hatchJitter: 0.35,
  hatchDot: 0.0,        // DEFAULT = pencil cross-hatch (set →1 for the dotted look)
  dotScale: 6.0,
  contour: 0.85,
  paperWarmth: 0.35,
  tintIdentity: 0.55,
};

// Cheap screen-space value hash → soft per-region noise so the marks waver like a
// human hand (lines aren't perfectly straight, dots aren't a perfect grid).
const hash21 = /*#__PURE__*/ Fn(([p]: [any]) => {
  const h = fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
  return h;
});

// Smooth-ish value noise in screen space (bilinear of the hash on a coarse grid),
// used to wobble line phase and break up the marks so they read as graphite, not print.
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

// ONE hatch layer: parallel screen-space lines at angle (ca, sa), spaced `scale`
// pixels, with a soft edge and a little noisy waver. Returns INK COVERAGE in [0,1]
// (1 = on a line / full graphite, 0 = bare paper between lines). `reveal` gates the
// layer in as the shaded value crosses `thresh` (so darker areas grow more layers).
const hatchLayer = /*#__PURE__*/ Fn((
  [frag, ca, sa, scale, soft, jitter, phase]:
  [any, any, any, any, any, any, any],
) => {
  // rotate the fragment coords into the line's frame; the line runs along one axis
  // and repeats along the other.
  const u = frag.x.mul(ca).add(frag.y.mul(sa));
  // a slow noise waver perpendicular to the lines → the strokes aren't dead straight
  const wob = vnoise2(frag.mul(0.06).add(phase)).sub(0.5).mul(jitter).mul(scale);
  const coord = u.add(wob).div(scale).add(phase);
  // triangle wave 0..1 across one line period; the stroke sits near the centre.
  const tri = abs(fract(coord).sub(0.5)).mul(2.0); // 0 at line centre → 1 between
  // a soft line: full ink at the centre, fading out by `lineHalf`. `soft` widens the
  // falloff so the graphite edge is fuzzy rather than a crisp printed rule.
  const lineHalf = mix(float(0.34), float(0.6), soft);
  const cov = oneMinus(smoothstep(float(0.06), lineHalf, tri));
  // graphite grain along the stroke: nibble the coverage with fine noise so the line
  // is dry/broken (bristly), not a solid wire.
  const grain = vnoise2(vec2(u.mul(0.5), frag.y.mul(ca).sub(frag.x.mul(sa)).mul(0.5)));
  return clamp(cov.mul(float(0.75).add(grain.mul(0.5))), float(0.0), float(1.0));
});

/**
 * Build the hand-drawn bird material. Same signature/return type as before, so
 * Bird.ts's call sites (`makeBirdMaterial()` / `makeBirdMaterial({...})`) are
 * unchanged. The baked per-vertex wash is read as the albedo and used only to TINT
 * the ink/paper so the drawing keeps the creature's identity; lighting → drawing
 * density is owned entirely by colorNode below.
 *
 * @param opts  optional per-part overrides (wings carry a cooler slate ink cast).
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
  const uWrap = uniform(o.wrap);
  const uAmbient = uniform(o.ambient);
  const uInk = uniform(o.inkStrength);
  const uHatchScale = uniform(o.hatchScale);
  const uHatchSoft = uniform(o.hatchSoft);
  const uHatchJitter = uniform(o.hatchJitter);
  const uHatchDot = uniform(o.hatchDot);
  const uDotScale = uniform(o.dotScale);
  const uContour = uniform(o.contour);
  const uPaperWarmth = uniform(o.paperWarmth);
  const uTintIdentity = uniform(o.tintIdentity);

  const sun = vec3(SUN.x, SUN.y, SUN.z);
  const paper = vec3(PAPER.r, PAPER.g, PAPER.b);
  const ink = vec3(INK.r, INK.g, INK.b);
  const keyWarm = vec3(KEY_WARM.r, KEY_WARM.g, KEY_WARM.b);

  // Base albedo = the baked painterly vertex wash (heron-grey / charcoal / ochre).
  // Used ONLY to give the ink + paper the bird's own identity (grey plumage →
  // graphite, warm bill → sepia), so the drawing reads as THIS creature.
  const albedo = vertexColor().rgb;

  // World-space normal so shading (and thus drawing density) tracks the sun as the
  // bird banks / flaps / wheels.
  const N = normalWorld.normalize();

  // --- SHADED VALUE (drives the drawing density) -------------------------------
  // Half-Lambert WRAP: remap n·sun from [-1,1] into a soft [0,1]; never crushes the
  // shaded side to black, the gentle illustrated falloff a hand would actually draw.
  const ndl = dot(N, sun);
  const wrapped = mix(
    max(ndl, float(0.0)),                 // wrap = 0 → plain Lambert
    ndl.mul(0.5).add(0.5),                // wrap = 1 → fully wrapped half-Lambert
    uWrap,
  );
  // value: 1 = lit (bare paper), 0 = deep shade (dense marks). Lift out of the
  // floor by `ambient` so the darkest shade still leaves some paper showing.
  const value = clamp(uAmbient.add(wrapped.mul(oneMinus(uAmbient))), float(0.0), float(1.0));
  // INK AMOUNT — how much drawing we lay down; inverse of value. The darker the
  // surface, the more graphite. Eased a touch so the build-up reads like tone.
  const tone = oneMinus(value); // 0 (lit) → 1 (deep shade)

  // --- screen-space fragment coordinates (constant on-screen mark size) ---------
  // screenCoordinate is in physical pixels; that's the "paper" the marks live on.
  const frag = screenCoordinate.xy;

  // ============================ PENCIL CROSS-HATCHING ==========================
  // Build up to FOUR hatch layers at staggered orientations. Each layer is gated in
  // as `tone` rises past a threshold, so:
  //   bright (tone≈0)  → bare paper
  //   light-mid        → 1 direction (single hatch)
  //   mid              → + crossing direction (cross-hatch)
  //   dark             → + a third/fourth steeper layer (dense cross-hatch)
  // The four directions (≈ 22°, 112°, 67°, 157°) give a believable hand build-up.
  const s1 = uHatchScale;
  const s2 = uHatchScale.mul(0.92); // slightly different spacing per layer (organic)
  const s3 = uHatchScale.mul(1.12);
  const s4 = uHatchScale.mul(0.8);

  // angle (cos, sin) pairs — precomputed constants
  const A1 = vec2(0.927, 0.375);   // ~22°
  const A2 = vec2(-0.375, 0.927);  // ~112° (crosses A1)
  const A3 = vec2(0.391, 0.921);   // ~67°
  const A4 = vec2(-0.921, 0.391);  // ~157°

  const jit = uHatchJitter;
  const soft = uHatchSoft;
  const h1 = hatchLayer(frag, A1.x, A1.y, s1, soft, jit, float(0.0));
  const h2 = hatchLayer(frag, A2.x, A2.y, s2, soft, jit, float(13.3));
  const h3 = hatchLayer(frag, A3.x, A3.y, s3, soft, jit, float(27.1));
  const h4 = hatchLayer(frag, A4.x, A4.y, s4, soft, jit, float(41.7));

  // reveal masks: each layer eases in over a tone window (soft so the build-up of
  // value reads as continuous tone, not hard bands).
  const r1 = smoothstep(float(0.12), float(0.34), tone);
  const r2 = smoothstep(float(0.34), float(0.55), tone);
  const r3 = smoothstep(float(0.55), float(0.74), tone);
  const r4 = smoothstep(float(0.74), float(0.92), tone);

  // accumulate hatch coverage; max() so overlapping layers stay graphite-dark (ink
  // doesn't get "darker than black"), each gated by its reveal.
  let hatchCov = h1.mul(r1);
  hatchCov = max(hatchCov, h2.mul(r2));
  hatchCov = max(hatchCov, h3.mul(r3));
  hatchCov = max(hatchCov, h4.mul(r4));
  // and a touch of additive density in the very darkest tone so deep shade truly
  // fills in (where all four cross) without flattening to a solid block.
  hatchCov = clamp(hatchCov.add(h1.add(h2).mul(r4).mul(0.25)), float(0.0), float(1.0));

  // ============================ STIPPLE / HALFTONE DOTS ========================
  // A screen-space dot grid whose dot RADIUS grows with `tone` → pointillist /
  // dotted shading that echoes the world's dab language. Jittered cell centres so
  // it reads hand-stippled, not a printer's screen.
  const cell = frag.div(uDotScale);
  const cellId = floor(cell);
  const cellUv = fract(cell).sub(0.5); // -0.5..0.5 within the cell
  // jitter each dot's centre a little by a per-cell hash
  const jx = hash21(cellId).sub(0.5).mul(0.5);
  const jy = hash21(cellId.add(vec2(5.2, 1.3))).sub(0.5).mul(0.5);
  const dotR = length(cellUv.sub(vec2(jx, jy)));
  // dot radius grows with tone (0 → no dot, ~0.6 → dots kiss). A faint per-cell size
  // variation keeps it organic.
  const sizeVar = hash21(cellId.add(vec2(2.7, 9.1))).mul(0.18).add(0.91);
  const targetR = tone.mul(0.62).mul(sizeVar);
  // soft-edged dot: inside radius → full ink, feather the rim by ~1 px-worth.
  const dotCov = oneMinus(smoothstep(targetR.sub(float(0.06)), targetR.add(float(0.06)), dotR))
    .mul(smoothstep(float(0.0), float(0.05), tone)); // no dots on bare-lit paper

  // ============================ HATCH ↔ DOT BLEND ==============================
  // uHatchDot: 0 = pure pencil cross-hatch, 1 = pure stipple/halftone dots.
  const markCov = mix(hatchCov, dotCov, uHatchDot);

  // ============================ INK CONTOUR ===================================
  // Fresnel from the view direction: 1 at grazing silhouette/interior edges, 0
  // facing us — a hand-inked contour line bounding the form. Tasteful, not a thick
  // cartoon outline: a tight grazing band plus a touch of noise so the inked edge
  // wavers like a pen line.
  const fres = oneMinus(clamp(abs(dot(N, positionViewDirection.normalize())), float(0.0), float(1.0)));
  const edgeNoise = vnoise2(frag.mul(0.08)).mul(0.25).add(0.85);
  const contourCov = smoothstep(float(0.62), float(0.9), fres).mul(edgeNoise).mul(uContour);

  // total ink coverage: the drawn marks PLUS the inked contour, scaled by overall
  // ink strength. Clamped so it can't exceed full ink.
  const inkCov = clamp(max(markCov, contourCov).mul(uInk), float(0.0), float(1.0));

  // ============================ INK-ON-PAPER OUTPUT ===========================
  // Give the paper + ink the bird's own identity so the drawing reads as THIS
  // creature: lerp the neutral paper/ink toward the albedo by `tintIdentity`. The
  // paper additionally warms toward the scene's golden key on the LIT side so the
  // drawing shares the world's light temperature; the ink picks up a darkened,
  // slightly desaturated version of the albedo (graphite of that hue).
  // identity hue for the paper (light, washed toward the bird's local colour)
  const litPaper = mix(paper, paper.mul(keyWarm), value.mul(uPaperWarmth));
  const idPaper = mix(litPaper, max(albedo, vec3(0.0)), uTintIdentity.mul(0.6));
  // ink tone: charcoal nudged toward a deep version of the local albedo (so the warm
  // bill inks warmer/sepia, the grey plumage inks cool graphite) — kept dark.
  const albInk = min(albedo.mul(0.45), vec3(0.6, 0.6, 0.6));
  const idInk = mix(ink, albInk, uTintIdentity.mul(0.7));

  // lay ink onto paper by coverage.
  let outc = mix(idPaper, idInk, inkCov);

  // Optional cool sheen tint (used by the wing membranes to keep their slate cast):
  // a touch of the tint pushed into both ink and paper so the wing drawing reads a
  // hair cooler/darker than the body — the slate primaries as graphite.
  if (opts.emissiveTint) {
    const t = opts.emissiveTint;
    outc = mix(outc, outc.mul(vec3(t.r, t.g, t.b).mul(2.2)), float(0.10));
  }

  mat.colorNode = outc;

  // expose knobs for live tuning (read/written as uniform .value)
  (mat as BirdMaterial).knobs = {
    wrap: uWrap, ambient: uAmbient, inkStrength: uInk,
    hatchScale: uHatchScale, hatchSoft: uHatchSoft, hatchJitter: uHatchJitter,
    hatchDot: uHatchDot, dotScale: uDotScale, contour: uContour,
    paperWarmth: uPaperWarmth, tintIdentity: uTintIdentity,
  };
  return mat as BirdMaterial;
}

export interface BirdMaterialKnobs {
  wrap: ReturnType<typeof uniform>;
  ambient: ReturnType<typeof uniform>;
  inkStrength: ReturnType<typeof uniform>;
  hatchScale: ReturnType<typeof uniform>;
  hatchSoft: ReturnType<typeof uniform>;
  hatchJitter: ReturnType<typeof uniform>;
  hatchDot: ReturnType<typeof uniform>;
  dotScale: ReturnType<typeof uniform>;
  contour: ReturnType<typeof uniform>;
  paperWarmth: ReturnType<typeof uniform>;
  tintIdentity: ReturnType<typeof uniform>;
}
export type BirdMaterial = THREE.MeshBasicNodeMaterial & { knobs: BirdMaterialKnobs };
