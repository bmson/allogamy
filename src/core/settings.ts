// Centralized LIVE-TUNING state for the art knobs.
//
// Two flavours of state live here:
//   1. Shader params  → TSL `uniform(initialValue)` nodes. The shader graphs in
//      post.ts and SplatMaterial.ts reference these uniform nodes directly, so
//      setting `node.value` re-drives the running render with NO rebuild/reload.
//   2. JS-side params  → plain numbers in `jsSettings`. These can't live in the
//      shader graph (light intensity is a JS property; fog near/far must also be
//      written onto scene.fog). The control panel writes both the uniform AND the
//      JS target when a slider moves.
//
// EVERY default below is seeded from the CURRENT hard-coded value (post.ts consts
// and config.ts consts) so the look is byte-identical until a slider is moved.

import { uniform } from 'three/tsl';
import { FOG_NEAR, FOG_FAR, WIND_STRENGTH } from '../config';

// --- Shader uniforms (live, drive the TSL graph) ---------------------------
// Post-processing painterly grade (post.ts paint() node).
// Defaults below are the values dialed in live via the tuning panel and exported.
export const uGlow = uniform(0.61); // halation glow strength
export const uImpasto = uniform(1.5); // canvas relief / texture (impasto)
export const uChroma = uniform(0.97); // grade saturation
export const uVignette = uniform(0.84); // corner darkening amount
export const uBleed = uniform(0.7); // oil-paint smear strength

// Splat / stroke shaping (SplatMaterial.ts).
export const uStrokeBias = uniform(1.21); // length-axis elongation bias (aAspect.add)
export const uSizeFloor = uniform(0.013); // distance size-floor coefficient (depth.mul)
export const uWind = uniform(WIND_STRENGTH); // wind sway strength (config)
export const uSizeJitter = uniform(1.0); // per-stamp size irregularity (1 ± fraction)
export const uAngleJitter = uniform(1.4); // per-stamp direction irregularity (radians)

// Atmosphere — splat-side manual fog. scene.fog is updated separately in JS from
// the SAME values (see jsSettings.fogNear / fogFar + Controls.ts).
export const uFogNear = uniform(FOG_NEAR); // 200
export const uFogFar = uniform(FOG_FAR); // 560

// --- JS-side params (live, written to plain properties) --------------------
// Seeded from the current hard-coded values in Engine.ts. Engine.applySettings()
// reads these on init; the control panel writes them and pokes the live targets.
export const jsSettings = {
  sunIntensity: 2.6, // DirectionalLight intensity (Engine.ts) — panel default
  hemiIntensity: 0.62, // HemisphereLight intensity (Engine.ts) — panel default
  fogNear: FOG_NEAR, // mirror of uFogNear for scene.fog.near
  fogFar: FOG_FAR, // mirror of uFogFar for scene.fog.far
};

// The full default snapshot, used by the export button. Keys match the slider
// ids so the panel can read/write uniformly. Values equal the seeds above.
export interface SettingsSnapshot {
  glow: number;
  impasto: number;
  chroma: number;
  vignette: number;
  bleed: number;
  strokeBias: number;
  sizeFloor: number;
  wind: number;
  sizeJitter: number;
  angleJitter: number;
  fogNear: number;
  fogFar: number;
  sunIntensity: number;
  hemiIntensity: number;
}

/** Read the CURRENT live values back out as a flat snapshot (for export). */
export function snapshot(): SettingsSnapshot {
  return {
    glow: uGlow.value as number,
    impasto: uImpasto.value as number,
    chroma: uChroma.value as number,
    vignette: uVignette.value as number,
    bleed: uBleed.value as number,
    strokeBias: uStrokeBias.value as number,
    sizeFloor: uSizeFloor.value as number,
    wind: uWind.value as number,
    sizeJitter: uSizeJitter.value as number,
    angleJitter: uAngleJitter.value as number,
    fogNear: jsSettings.fogNear,
    fogFar: jsSettings.fogFar,
    sunIntensity: jsSettings.sunIntensity,
    hemiIntensity: jsSettings.hemiIntensity,
  };
}
