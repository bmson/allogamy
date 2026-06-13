import * as THREE from 'three/webgpu';

// Small procedurally drawn textures. Generated once and shared.

// Tiny deterministic LCG so seeded textures (clouds) stay reproducible across
// runs and machines. Returns a closure over its own 31-bit state.
function makeRng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a * 1103515245 + 12345) & 0x7fffffff;
    return a / 0x7fffffff;
  };
}

// Paint a radial gradient but only fill its bounding box rather than the whole
// canvas — overlapping soft circles are the workhorse here, and clipping each to
// its own footprint turns a full-canvas fill into a small one. The +1 padding
// keeps the alpha=0 rim from clipping into a visible hard edge.
function paintRadial(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  stops: [number, string][],
): void {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  for (const [o, col] of stops) g.addColorStop(o, col);
  ctx.fillStyle = g;
  const x = Math.floor(cx - r) - 1;
  const y = Math.floor(cy - r) - 1;
  const d = Math.ceil(r * 2) + 2;
  ctx.fillRect(x, y, d, d);
}

/**
 * Soft round splat mask. Used as a Points alphaMap (sampled with the per-point
 * coord). White centre → black rim; with alphaTest this yields crisp, slightly
 * soft circular dabs that write depth — so no transparency sorting and no
 * see-through gaps. The falloff is a smooth gaussian-ish ramp so the rim stays
 * painterly rather than hard.
 */
export function makeSplatTexture(): THREE.CanvasTexture {
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d')!;
  // A multi-stop ramp approximating a gaussian shoulder: a generous bright core
  // that rolls off gently through grey into black, so alphaTest can bite anywhere
  // along the soft shoulder and still read as a feathered dab.
  paintRadial(ctx, s / 2, s / 2, s / 2, [
    [0.0, 'rgb(255,255,255)'],
    [0.5, 'rgb(255,255,255)'],
    [0.7, 'rgb(214,214,214)'],
    [0.84, 'rgb(140,140,140)'],
    [0.94, 'rgb(54,54,54)'],
    [1.0, 'rgb(0,0,0)'],
  ]);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace; // data, not colour
  return tex;
}

/**
 * An organic, slightly irregular soft blob (grayscale) used as the splat shape
 * mask instead of a perfect circle. Built from several overlapping offset soft
 * lobes so its 0.5 contour is lumpy; combined with per-instance rotation in the
 * material, every dab reads a little differently — more painterly, less dotty.
 */
export function makeSplatShapeTexture(): THREE.CanvasTexture {
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, s, s);
  ctx.globalCompositeOperation = 'lighter';
  // Lobes: [x, y, radius]. A dominant body plus smaller satellites pushes the
  // 0.5 contour into an irregular, brush-loaded silhouette rather than a disc.
  const lobes: [number, number, number][] = [
    [0.50, 0.50, 0.30], [0.40, 0.45, 0.21], [0.61, 0.54, 0.20],
    [0.50, 0.37, 0.17], [0.44, 0.63, 0.16], [0.63, 0.41, 0.15],
  ];
  for (const [lx, ly, lr] of lobes) {
    paintRadial(ctx, lx * s, ly * s, lr * s, [
      [0, 'rgba(255,255,255,0.85)'],
      [0.6, 'rgba(255,255,255,0.38)'],
      [1, 'rgba(255,255,255,0)'],
    ]);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/**
 * Radial white→transparent glow, for the sun sprite (additive). A bright,
 * concentrated core fades through a long luminous skirt; the gentle exponential
 * tail gives the sun a soft halation bloom instead of a hard-edged disc when it
 * stacks with the post halation pass.
 */
export function makeGlowTexture(): THREE.CanvasTexture {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d')!;
  paintRadial(ctx, s / 2, s / 2, s / 2, [
    [0.0, 'rgba(255,255,255,1)'],
    [0.12, 'rgba(255,255,255,0.92)'],
    [0.3, 'rgba(255,255,255,0.55)'],
    [0.55, 'rgba(255,255,255,0.2)'],
    [0.78, 'rgba(255,255,255,0.06)'],
    [1.0, 'rgba(255,255,255,0)'],
  ]);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/**
 * Puffy cumulus blob built from overlapping soft circles. RGBA with alpha.
 * Tinted white by the cloud sprite, so the value variation here is what gives
 * each cloud a hand-painted, top-lit body with a softer, slightly shaded
 * underside rather than a flat puff. Each gradient is clipped to its own
 * footprint, so the whole texture is built from small fills.
 */
export function makeCloudTexture(seed = 1): THREE.CanvasTexture {
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d')!;
  const rnd = makeRng(seed);

  // First lay a broad, soft base so the cloud reads as one connected mass with a
  // flattish bottom, instead of a ring of separate bubbles. Slightly grey so the
  // crown puffs (pure white below) pop as top-lit highlights.
  paintRadial(ctx, s * 0.5, s * 0.52, s * 0.4, [
    [0, 'rgba(244,246,250,0.7)'],
    [0.55, 'rgba(238,241,247,0.45)'],
    [1, 'rgba(238,241,247,0)'],
  ]);

  // Crown puffs — clustered toward the upper body and biased upward in size so
  // the silhouette billows on top and settles flat underneath, like real cumulus.
  const puffs = 11;
  for (let i = 0; i < puffs; i++) {
    const px = s * (0.26 + rnd() * 0.48);
    // bias y toward the upper half; squash the spread so bottoms stay level
    const py = s * (0.38 + rnd() * 0.26);
    const pr = s * (0.1 + rnd() * 0.15);
    // top-lit shading: puffs sitting higher are brighter at their crowns
    const lit = 1 - (py / s - 0.38) / 0.5; // ~1 at top, ~0 lower down
    const core = 0.86 + 0.12 * lit;
    paintRadial(ctx, px, py, pr, [
      [0, `rgba(255,255,255,${core.toFixed(3)})`],
      [0.55, 'rgba(252,253,255,0.42)'],
      [1, 'rgba(252,253,255,0)'],
    ]);
  }

  // A faint cool wash along the underside grounds the cloud with a hint of
  // self-shadow without muddying it — kept subtle so the day stays bright.
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  paintRadial(ctx, s * 0.5, s * 0.7, s * 0.34, [
    [0, 'rgba(206,214,232,0.16)'],
    [0.7, 'rgba(206,214,232,0.05)'],
    [1, 'rgba(206,214,232,0)'],
  ]);
  ctx.restore();

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
