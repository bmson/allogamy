import * as THREE from 'three/webgpu';
import {
  pass,
  Fn,
  vec2,
  vec3,
  vec4,
  float,
  mix,
  dot,
  max,
  pow,
  cos,
  reflect,
  normalize,
  screenUV,
  screenSize,
} from 'three/tsl';

// Faithful TSL port of 6.html's single post pass `paintFrag` (lines ~805-872).
// One full-screen pass that turns the rendered frame into a "painting": a
// Kuwahara flatten for painterly cohesion, a halation glow, an impasto relief
// lit against a canvas grain (the paper feel), and finally a no-blacks Monet
// grade. Runs in linear space; PostProcessing applies the sRGB encode on
// output, so we do NOT tone-map or gamma-encode here.
//
// The reference's GLSL math is ported node-for-node. The dynamic Kuwahara
// neighbourhood (4 quadrants x a 2x2 tap) is unrolled in JS so each texture
// fetch has a constant offset, which is the natural shape for TSL.

const GLOW = 0.7; // uGlow in 6.html
const IMPASTO = 0.5; // uImpasto in 6.html

export function buildPostProcessing(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): { post: THREE.PostProcessing } {
  const scenePass = pass(scene, camera);
  const scenePassColor = scenePass.getTextureNode('output');

  // Reference luminance weights (0.299, 0.587, 0.114). TSL's built-in
  // `luminance` uses the working-colour-space coefficients (Rec.709), which
  // differ — so we replicate the reference exactly.
  const lum = (c: any): any => dot(c, vec3(0.299, 0.587, 0.114));

  // Sample the scene colour at a uv offset measured in texels.
  // `px` is 1/resolution (texel size); offset is in texel units.
  const tap = (px: any, ox: number, oy: number): any =>
    scenePassColor.sample(screenUV.add(px.mul(vec2(ox, oy)))).rgb;

  const paint = Fn(() => {
    // Texel size = 1 / resolution. `screenSize` is a RENDER-updated uniform, so
    // this stays correct across resizes with no Engine.ts change.
    const px = float(1.0).div(screenSize); // vec2

    const raw = scenePassColor.rgb.toVar();

    // ---- 1) KUWAHARA flatten: 4 quadrants, keep the lowest-variance mean ----
    // Quadrant sign vectors s, matching 6.html:
    //   q0: (+1,+1)  q1: (-1,+1)  q2: (-1,-1)  q3: (+1,-1)
    const quadrants: Array<[number, number]> = [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ];

    const bestMean = raw.toVar();
    const bestVar = float(1e9).toVar();

    // Offset step = texel * 1.4 (uPx * 1.4 in the reference).
    const STEP = 1.4;
    for (const [sx, sy] of quadrants) {
      let meanAcc: any = vec3(0.0);
      let m2Acc: any = float(0.0);
      for (let i = 0; i <= 1; i++) {
        for (let j = 0; j <= 1; j++) {
          const cc = tap(px, i * sx * STEP, j * sy * STEP);
          meanAcc = meanAcc.add(cc);
          const l = lum(cc);
          m2Acc = m2Acc.add(l.mul(l));
        }
      }
      const mean = meanAcc.mul(0.25);
      const ml = lum(mean);
      const v = m2Acc.mul(0.25).sub(ml.mul(ml));
      // if (v < bestVar) { bestVar = v; bestMean = mean; }
      const take = v.lessThan(bestVar);
      bestMean.assign(mix(bestMean, mean, take));
      bestVar.assign(mix(bestVar, v, take));
    }

    const col = mix(raw, bestMean, float(0.45)).toVar();

    // ---- 2) HALATION GLOW: 4 diagonal taps, add glow*glow ----
    const g1 = tap(px, 5, 3);
    const g2 = tap(px, -5, 3);
    const g3 = tap(px, 3, -5);
    const g4 = tap(px, -3, -5);
    const glow = g1.add(g2).add(g3).add(g4).mul(0.25);
    col.addAssign(glow.mul(glow).mul(0.22 * GLOW));

    // ---- 3) IMPASTO RELIEF on a canvas grain ----
    // Luminance central differences at 1.5 texels.
    const lx1 = lum(tap(px, 1.5, 0));
    const lx0 = lum(tap(px, -1.5, 0));
    const ly1 = lum(tap(px, 0, 1.5));
    const ly0 = lum(tap(px, 0, -1.5));
    const grad = vec2(lx1.sub(lx0), ly1.sub(ly0));

    // fc = uv / texel  (== uv * resolution == fragment coords)
    const fc = screenUV.div(px);
    const canvasGrad = vec2(cos(fc.x.mul(1.55)), cos(fc.y.mul(1.55))).mul(0.01);

    const k = float(IMPASTO);
    const nrm = normalize(
      vec3(grad.mul(2.6).mul(k).add(canvasGrad.mul(k)).negate(), 1.0),
    );
    const L = normalize(vec3(-0.45, 0.55, 0.78));
    const diff = max(dot(nrm, L), 0.0);
    col.mulAssign(float(0.86).add(diff.mul(0.24)));
    const spec = pow(max(dot(reflect(L.negate(), nrm), vec3(0.0, 0.0, 1.0)), 0.0), 30.0);
    col.addAssign(vec3(1.0, 0.97, 0.9).mul(spec).mul(lum(col)).mul(0.2).mul(k));

    // ---- 4) MONET GRADE ----
    col.assign(col.mul(0.93).add(0.055)); // black-lift, no pure blacks
    const l1 = lum(col);
    col.assign(mix(vec3(l1), col, float(1.14))); // +chroma
    col.addAssign(vec3(0.05, 0.025, -0.015).mul(l1)); // warm lights
    col.addAssign(vec3(-0.01, 0.0, 0.035).mul(float(1.0).sub(l1))); // cool shadows
    const vg = screenUV.sub(0.5);
    col.mulAssign(float(1.0).sub(dot(vg, vg).mul(0.28))); // vignette

    return vec4(col, 1.0);
  });

  const post = new THREE.PostProcessing(renderer);
  post.outputNode = paint();
  return { post };
}
