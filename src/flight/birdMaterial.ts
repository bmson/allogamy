import * as THREE from 'three/webgpu';
import {
  Fn, vec3, float, mix, clamp, max, dot, smoothstep, fract, sin,
  oneMinus, pow, abs, uniform, vertexColor, normalWorld, positionWorld,
  positionViewDirection,
} from 'three/tsl';
import { SUN_DIR } from '../config';

// ===========================================================================
// THE PELICAN'S SKIN — a custom stylised TSL shader so the bird stops reading as
// a glossy PBR object and instead sits inside the soft, painterly meadow.
//
// The world is a wash of feathered brush-dabs run through a Kuwahara + glow +
// grade post pass. A realistic MeshStandardMaterial fights that: its specular
// highlights and physically-correct falloff make the bird look like injection-
// moulded plastic dropped into a watercolour. So we throw out PBR entirely and
// HAND-PAINT the lighting ourselves on a MeshBasicNodeMaterial (unlit base — we
// own every photon):
//
//   • SOFT ILLUSTRATED LIGHT — a wrapped/half-Lambert n·sun, eased into 2–3 gentle
//     value bands (illustrated, not a hard cel step, never a glossy spec).
//   • WARM KEY / COOL SHADE — the sunlit side warms toward the meadow's golden key;
//     the shadow side cools toward its luminous blue-violet shadow, so the bird
//     shares the scene's light temperature instead of being neutrally lit.
//   • PAINTERLY BREAK-UP — a faint broken-colour / value jitter keyed to world
//     position so the surface shimmers warm/cool like the world's dabs, reading
//     brushed rather than smooth plastic. Kept subtle so the bird stays clean.
//   • SKY-TINTED FRESNEL RIM — a soft pale-blue rim where the silhouette turns away,
//     nestling the bird into the airy sky behind it (like aerial light wrapping it).
//   • GENTLE INK CONTOUR — a quiet darkening at the deepest grazing angles, an
//     illustrated edge-line, never a hard cartoon outline.
//
// We don't re-apply Kuwahara/grade here — the full-frame post pass already grades
// everything. We only make the bird's SHADING soft + painterly so the post unifies
// it with the rest of the painting. Vertex colours (the heron-grey / charcoal /
// ochre wash baked in birdGeometry) stay the albedo; we only modulate them with
// this soft light, preserving the bird's palette identity.
//
// Lighting uses normalWorld + positionWorld so the bird lights CORRECTLY as it
// banks, flaps and wheels — the key stays pinned to the world sun, not the camera.
// ===========================================================================

// World sun direction (toward the sun), matching the scene + the geometry's baked
// `sunlit` term so the painted highlights and the live shading agree.
const SUN = new THREE.Vector3(...SUN_DIR).normalize();

// Scene-matched light colours (sRGB → linear via THREE colour management), read off
// palette.ts: warm golden key `sun`, luminous blue-violet `shadow`, pale sky `air`.
const KEY_WARM = new THREE.Color('#fff0cf'); // palette.sun  — warm golden key
const COOL_SHADE = new THREE.Color('#7e86b0'); // palette.shadow — blue-violet shade (never black)
const SKY_RIM = new THREE.Color('#cfe8f8'); // palette.air  — pale sky for the fresnel rim

/**
 * Live-tunable knobs for the stylised bird shading. All small, all safe to nudge
 * from a debug panel; defaults are tuned to nestle the bird into the bright meadow.
 */
export interface BirdShadeOpts {
  wrap?: number;       // half-Lambert wrap (0 = Lambert, 1 = fully wrapped/soft)
  ambient?: number;    // floor brightness in shade (shadows stay luminous, never black)
  warmth?: number;     // strength of warm-key / cool-shade temperature split
  bands?: number;      // 0 = smooth gradient, 1 = full 3-band illustrated toon read
  jitter?: number;     // painterly broken-colour amount (value/temperature flecks)
  rim?: number;        // sky-tinted fresnel rim strength
  contour?: number;    // gentle dark inked-edge strength
  emissiveTint?: THREE.Color; // optional extra (e.g. a touch of cool sheen on wings)
}

const DEFAULTS: Required<Omit<BirdShadeOpts, 'emissiveTint'>> = {
  wrap: 0.55,
  ambient: 0.46,
  warmth: 0.30,
  bands: 0.5,
  jitter: 0.05,
  rim: 0.30,
  contour: 0.22,
};

// Cheap 3-D value-ish hash → a soft broken-colour fleck, the painterly grain. We
// quantise world position into coarse cells (≈ brush-dab scale) and hash them so the
// surface breaks into warm/cool patches like the world's dabs, not a smooth gradient.
const brokenColour = /*#__PURE__*/ Fn(([p]: [any]) => {
  // two offset hashes → a signed, roughly band-limited fleck in [-1, 1]
  const cell = p.mul(5.5);
  const h1 = fract(sin(dot(cell.floor(), vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
  const h2 = fract(sin(dot(cell.mul(1.7).floor(), vec3(39.346, 11.135, 83.155))).mul(24634.633));
  return h1.add(h2).sub(1.0); // ≈ [-1, 1]
});

/**
 * Build the custom stylised bird material. `vertexColors` is on so the baked
 * per-vertex wash is the albedo; we replace lighting entirely via colorNode.
 *
 * @param opts  optional per-part overrides (wings can carry a faint cool sheen).
 */
export function makeBirdMaterial(opts: BirdShadeOpts = {}): THREE.MeshBasicNodeMaterial {
  const o = { ...DEFAULTS, ...opts };
  const mat = new THREE.MeshBasicNodeMaterial();
  // NOTE: vertexColors stays OFF. NodeMaterial auto-multiplies colorNode by
  // vertexColor() when the flag is true — but WE read the baked wash explicitly as
  // our albedo (below), so enabling it would double-apply the vertex colours. We
  // own the whole shading chain via colorNode instead.
  mat.vertexColors = false;
  mat.fog = false; // the painterly world has fog off; the post pass owns atmosphere

  // --- uniforms (exposed for live tuning without a rebuild) ---
  const uWrap = uniform(o.wrap);
  const uAmbient = uniform(o.ambient);
  const uWarmth = uniform(o.warmth);
  const uBands = uniform(o.bands);
  const uJitter = uniform(o.jitter);
  const uRim = uniform(o.rim);
  const uContour = uniform(o.contour);

  const sun = vec3(SUN.x, SUN.y, SUN.z);
  const keyWarm = vec3(KEY_WARM.r, KEY_WARM.g, KEY_WARM.b);
  const coolShade = vec3(COOL_SHADE.r, COOL_SHADE.g, COOL_SHADE.b);
  const skyRim = vec3(SKY_RIM.r, SKY_RIM.g, SKY_RIM.b);

  // Base albedo = the baked painterly vertex wash (heron-grey / charcoal / ochre).
  // vertexColor() is a vec4; take .rgb so the whole shading chain stays vec3.
  const albedo = vertexColor().rgb;

  // World-space normal so the bird lights correctly as it banks / flaps / wheels.
  const N = normalWorld.normalize();

  // --- SOFT ILLUSTRATED DIFFUSE -------------------------------------------------
  // Half-Lambert WRAP: remap n·sun from [-1,1] into a soft [0,1] that never fully
  // reaches black on the shaded side — the gentle, illustrated falloff of a painted
  // figure rather than the hard terminator of PBR.
  const ndl = dot(N, sun);
  const wrapped = mix(
    max(ndl, float(0.0)),                 // wrap = 0 → plain Lambert
    ndl.mul(0.5).add(0.5),                // wrap = 1 → fully wrapped half-Lambert
    uWrap,
  );

  // 2–3 soft TOON BANDS: ease the wrapped value through a couple of gentle plateaus
  // so it reads as illustrated value steps (shadow / mid / light) — but blended with
  // smoothstep so the steps are soft brush transitions, never a hard cel edge. We
  // mix between the raw smooth gradient and the banded read by `uBands`.
  const band = smoothstep(float(0.12), float(0.34), wrapped)        // shadow → mid
    .mul(0.5)
    .add(smoothstep(float(0.5), float(0.72), wrapped).mul(0.5));    // mid → light
  const shade = mix(wrapped, band, uBands);

  // Lift out of black by the ambient floor (the meadow's shadows stay luminous), so
  // the darkest side of the bird still glows faintly rather than crushing to plastic.
  const lightAmt = uAmbient.add(shade.mul(oneMinus(uAmbient)));

  // --- WARM KEY / COOL SHADE ----------------------------------------------------
  // Tint the LIT side toward the warm golden key and the SHADE side toward the cool
  // blue-violet shadow, so the bird shares the scene's light temperature. Built as a
  // light-colour that multiplies the albedo: warm where lit, cool where shaded.
  const lightCol = mix(coolShade, keyWarm, smoothstep(float(0.15), float(0.85), shade));
  // blend that tint in by `uWarmth` (rest is neutral white) so we keep the bird's
  // own palette identity and only push it gently into the scene's temperature.
  const tint = mix(vec3(1.0, 1.0, 1.0), lightCol, uWarmth);

  // shaded albedo: the baked wash, lit by our soft band, warmed/cooled by the scene.
  let lit = albedo.mul(lightAmt).mul(tint);

  // --- PAINTERLY BROKEN-COLOUR BREAK-UP ----------------------------------------
  // A faint warm/cool fleck keyed to WORLD position so the surface shimmers like the
  // world's broken-colour dabs — pushing toward the warm key on positive flecks and
  // the cool shade on negative ones. Tiny amplitude: the bird stays clean + readable.
  const fleck = brokenColour(positionWorld);
  const warmFleck = mix(lit, lit.mul(keyWarm.mul(1.18)), max(fleck, float(0.0)).mul(uJitter));
  lit = mix(warmFleck, warmFleck.mul(coolShade.mul(1.35)), max(fleck.negate(), float(0.0)).mul(uJitter));

  // --- SKY-TINTED FRESNEL RIM + GENTLE INK CONTOUR ------------------------------
  // Fresnel from the view direction: 1 at grazing silhouette edges, 0 facing us.
  const fres = oneMinus(clamp(abs(dot(N, positionViewDirection.normalize())), float(0.0), float(1.0)));
  // RIM: a soft pale-sky glow added only on the LIT-facing rim, so the bird's edge
  // melts into the airy sky behind it (aerial light wrapping the silhouette). Gated
  // by how lit that edge is, so it reads as light catching the rim, not a flat halo.
  const rimMask = pow(fres, float(3.0)).mul(smoothstep(float(-0.2), float(0.6), ndl));
  lit = mix(lit, skyRim, rimMask.mul(uRim));
  // CONTOUR: a quiet darkening at the very deepest grazing angle on the SHADED side —
  // an illustrated edge-line that grounds the form. Subtle, never a hard cartoon ink.
  const contourMask = pow(fres, float(5.0)).mul(smoothstep(float(0.55), float(-0.1), ndl));
  lit = lit.mul(oneMinus(contourMask.mul(uContour)));

  // Optional cool sheen tint (used by the wing membranes to keep their slate cast).
  if (opts.emissiveTint) {
    const t = opts.emissiveTint;
    lit = mix(lit, lit.mul(vec3(t.r, t.g, t.b).mul(2.0)), float(0.06));
  }

  mat.colorNode = lit;

  // expose knobs for live tuning (read/written as uniform .value)
  (mat as BirdMaterial).knobs = {
    wrap: uWrap, ambient: uAmbient, warmth: uWarmth, bands: uBands,
    jitter: uJitter, rim: uRim, contour: uContour,
  };
  return mat as BirdMaterial;
}

export interface BirdMaterialKnobs {
  wrap: ReturnType<typeof uniform>;
  ambient: ReturnType<typeof uniform>;
  warmth: ReturnType<typeof uniform>;
  bands: ReturnType<typeof uniform>;
  jitter: ReturnType<typeof uniform>;
  rim: ReturnType<typeof uniform>;
  contour: ReturnType<typeof uniform>;
}
export type BirdMaterial = THREE.MeshBasicNodeMaterial & { knobs: BirdMaterialKnobs };
