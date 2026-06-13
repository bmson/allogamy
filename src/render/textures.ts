import * as THREE from 'three/webgpu';

// Small procedurally drawn textures. Generated once and shared.

/**
 * Soft round splat mask. Used as a Points alphaMap (sampled with the per-point
 * coord). White centre → black rim; with alphaTest this yields crisp, slightly
 * soft circular dabs that write depth — so no transparency sorting and no
 * see-through gaps. The faint edge ramp keeps them painterly rather than hard.
 */
export function makeSplatTexture(): THREE.CanvasTexture {
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, 'rgb(255,255,255)');
  g.addColorStop(0.55, 'rgb(255,255,255)');
  g.addColorStop(0.82, 'rgb(150,150,150)');
  g.addColorStop(1.0, 'rgb(0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
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
  const lobes: [number, number, number][] = [
    [0.50, 0.50, 0.30], [0.40, 0.45, 0.21], [0.61, 0.54, 0.20],
    [0.50, 0.37, 0.17], [0.44, 0.63, 0.16], [0.63, 0.41, 0.15],
  ];
  for (const [lx, ly, lr] of lobes) {
    const g = ctx.createRadialGradient(lx * s, ly * s, 0, lx * s, ly * s, lr * s);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.38)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** Radial white→transparent glow, for the sun sprite (additive). */
export function makeGlowTexture(): THREE.CanvasTexture {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.7)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** Puffy cumulus blob built from overlapping soft circles. RGBA with alpha. */
export function makeCloudTexture(seed = 1): THREE.CanvasTexture {
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d')!;
  // deterministic-ish puff layout from the seed
  let a = seed * 2654435761;
  const rnd = () => {
    a = (a * 1103515245 + 12345) & 0x7fffffff;
    return a / 0x7fffffff;
  };
  const puffs = 11;
  for (let i = 0; i < puffs; i++) {
    const px = s * (0.28 + rnd() * 0.44);
    const py = s * (0.42 + rnd() * 0.3);
    const pr = s * (0.1 + rnd() * 0.16);
    const g = ctx.createRadialGradient(px, py, 0, px, py, pr);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
