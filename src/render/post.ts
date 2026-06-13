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
import { uGlow, uImpasto, uChroma, uVignette, uBleed } from '../core/settings';

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

// GLOW (0.7) and IMPASTO (0.5) are now LIVE uniforms in src/core/settings.ts
// (uGlow / uImpasto), so the control panel can drive them at runtime. The
// grade's chroma (1.14) and vignette (0.28) are likewise uChroma / uVignette.

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

  // Sample at an arbitrary texel-offset VECTOR (a node) — for the flow-aligned smear.
  const tapv = (px: any, off: any): any =>
    scenePassColor.sample(screenUV.add(px.mul(off))).rgb;

  const paint = Fn(() => {
    // Texel size = 1 / resolution. `screenSize` is a RENDER-updated uniform, so
    // this stays correct across resizes with no Engine.ts change.
    const px = float(1.0).div(screenSize); // vec2

    const raw = scenePassColor.rgb.toVar();

    // ---- SHARED 3x3 NEIGHBOURHOOD ------------------------------------------
    // The Kuwahara flatten, the bleed/impasto gradient, and the glow all want
    // the colour at a small ring of offsets. The original code re-sampled those
    // points independently (16 Kuwahara + 4 bleed-grad + 4 glow + 4 impasto-grad
    // ≈ 28-32 taps/pixel). We sample ONE 3x3 grid (centre + 4 axis + 4 diagonal
    // = 9 taps), reuse it for everything, and add 2 short smear taps — ~11 taps,
    // roughly a 60% cut, while keeping the same painterly result family.
    const STEP = 1.4; // matches the reference's uPx*1.4 Kuwahara step
    const c = raw; // centre (already have it)
    const e = tap(px, STEP, 0); // east
    const w = tap(px, -STEP, 0); // west
    const n = tap(px, 0, STEP); // north
    const s = tap(px, 0, -STEP); // south
    const ne = tap(px, STEP, STEP);
    const nw = tap(px, -STEP, STEP);
    const se = tap(px, STEP, -STEP);
    const sw = tap(px, -STEP, -STEP);

    // ---- 1) KUWAHARA flatten: 4 quadrants, keep the lowest-variance mean ----
    // Same 4 overlapping 2x2 quadrants as the reference, but each quadrant is now
    // assembled from the SHARED grid samples instead of fresh fetches:
    //   q0 (+,+): c, e, n, ne   q1 (-,+): c, w, n, nw
    //   q2 (-,-): c, w, s, sw   q3 (+,-): c, e, s, se
    const lc = lum(c);
    const le = lum(e);
    const lw = lum(w);
    const ln = lum(n);
    const ls = lum(s);
    const lne = lum(ne);
    const lnw = lum(nw);
    const lse = lum(se);
    const lsw = lum(sw);

    const bestMean = raw.toVar();
    const bestVar = float(1e9).toVar();
    const considerQuad = (
      a: any, b: any, d: any, f: any, la: any, lb: any, ld: any, lf: any,
    ): void => {
      const mean = a.add(b).add(d).add(f).mul(0.25);
      const ml = lum(mean);
      // variance = E[l²] - E[l]²  (luminance, like the reference)
      const m2 = la.mul(la).add(lb.mul(lb)).add(ld.mul(ld)).add(lf.mul(lf)).mul(0.25);
      const v = m2.sub(ml.mul(ml));
      const take = v.lessThan(bestVar);
      bestMean.assign(mix(bestMean, mean, take));
      bestVar.assign(mix(bestVar, v, take));
    };
    considerQuad(c, e, n, ne, lc, le, ln, lne);
    considerQuad(c, w, n, nw, lc, lw, ln, lnw);
    considerQuad(c, w, s, sw, lc, lw, ls, lsw);
    considerQuad(c, e, s, se, lc, le, ls, lse);

    const col = mix(raw, bestMean, float(0.45)).toVar();

    // ---- 1.5) OIL-PAINT BLEED + IMPASTO GRADIENT (shared) -------------------
    // Luminance central differences from the SHARED grid (no extra taps) drive
    // BOTH the contour-aligned bleed AND the impasto relief below.
    const grad = vec2(le.sub(lw), ln.sub(ls));
    const blen = grad.x.mul(grad.x).add(grad.y.mul(grad.y)).add(1e-5).sqrt();
    const fdir = vec2(grad.y.div(blen), grad.x.negate().div(blen)); // isophote ⟂ gradient
    // Smear ALONG the contour so neighbouring strokes melt like wet oil paint.
    // Trimmed from a 4-tap symmetric blur to a 2-tap one (the wider ±6 taps added
    // little over the ±3 pair); strength = uBleed.
    const smear = col
      .add(tapv(px, fdir.mul(3.0)))
      .add(tapv(px, fdir.mul(-3.0)))
      .mul(1.0 / 3.0);
    col.assign(mix(col, smear, uBleed));

    // ---- 2) HALATION GLOW: reuse the 4 diagonal grid taps, add glow*glow ----
    const glow = ne.add(nw).add(se).add(sw).mul(0.25);
    col.addAssign(glow.mul(glow).mul(uGlow.mul(0.22)));

    // ---- 3) IMPASTO RELIEF on a canvas grain (reuses `grad`) ----------------
    // fc = uv / texel  (== uv * resolution == fragment coords)
    const fc = screenUV.div(px);
    const canvasGrad = vec2(cos(fc.x.mul(1.55)), cos(fc.y.mul(1.55))).mul(0.01);

    const k = uImpasto;
    const nrm = normalize(
      vec3(grad.mul(2.6).mul(k).add(canvasGrad.mul(k)).negate(), 1.0),
    );
    const L = normalize(vec3(-0.45, 0.55, 0.78));
    const diff = max(dot(nrm, L), 0.0);
    col.mulAssign(float(0.86).add(diff.mul(0.24)));
    const spec = pow(max(dot(reflect(L.negate(), nrm), vec3(0.0, 0.0, 1.0)), 0.0), 30.0);
    col.addAssign(vec3(1.0, 0.97, 0.9).mul(spec).mul(lum(col)).mul(0.2).mul(k));

    // ---- 4) MONET GRADE ----
    col.assign(col.sub(0.5).mul(1.18).add(0.5)); // higher contrast — deeper darks, brighter lights
    const l1 = lum(col);
    col.assign(mix(vec3(l1), col, uChroma)); // +chroma
    col.addAssign(vec3(0.05, 0.025, -0.015).mul(l1)); // warm lights
    col.addAssign(vec3(-0.01, 0.0, 0.035).mul(float(1.0).sub(l1))); // cool shadows
    const vg = screenUV.sub(0.5);
    col.mulAssign(float(1.0).sub(dot(vg, vg).mul(uVignette))); // vignette

    return vec4(col, 1.0);
  });

  const post = new THREE.PostProcessing(renderer);
  post.outputNode = paint();
  return { post };
}
