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
  abs,
  reflect,
  normalize,
  screenUV,
  screenSize,
  fract,
  sin,
  floor,
} from 'three/tsl';
import {
  uGlow, uImpasto, uChroma, uVignette, uBleed, uPaperTex, uGrainScale, uWeave,
} from '../core/settings';

// --- procedural value-noise → fbm, for the whole-frame canvas/paper grain ------
// A hashed value-noise on a pixel lattice, smoothstep-interpolated, summed over a
// couple of octaves. Sampled in FRAGMENT space so it reads as a fixed canvas
// texture the painting sits on (it doesn't swim with the camera).
const hash2 = /*#__PURE__*/ Fn(([p]: [any]) =>
  fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));

const vnoise = /*#__PURE__*/ Fn(([p]: [any]) => {
  const i = floor(p);
  const f = fract(p);
  const u: any = f.mul(f).mul(float(3.0).sub(f.mul(2.0))); // smoothstep weights
  const a = hash2(i);
  const b = hash2(i.add(vec2(1.0, 0.0)));
  const c = hash2(i.add(vec2(0.0, 1.0)));
  const d = hash2(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

// 3-octave fbm built on the value-noise above. The classic lacunarity≈2 /
// gain≈0.5 sum gives a "canvas tooth" that has structure at several scales at
// once (fine fibre, medium mottle, coarse blotch) instead of a single buzzy
// frequency — far closer to real primed-canvas grain. Returns ~[0,1].
const fbm = /*#__PURE__*/ Fn(([p]: [any]) => {
  const sum = float(0.0).toVar();
  const amp = float(0.5).toVar();
  const q = p.toVar();
  // Unrolled (TSL has no runtime loops in this idiom). Each octave doubles the
  // frequency and halves the amplitude; the small rotate-ish offset per octave
  // breaks axis-aligned tiling so the tooth never looks like a grid.
  sum.addAssign(vnoise(q).mul(amp));
  q.assign(q.mul(2.02).add(vec2(11.7, 4.3)));
  amp.assign(amp.mul(0.5));
  sum.addAssign(vnoise(q).mul(amp));
  q.assign(q.mul(2.03).add(vec2(3.1, 17.9)));
  amp.assign(amp.mul(0.5));
  sum.addAssign(vnoise(q).mul(amp));
  // Normalise by the amplitude sum (0.5+0.25+0.125 = 0.875) back to ~[0,1].
  return sum.mul(1.0 / 0.875);
});

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

    // Lean a touch harder on the Kuwahara mean (0.45 → 0.52): the reference painting
    // groups its greens into confident flat MASSES with soft interiors and crisp mass
    // boundaries — more flatten reads as deliberate brushwork, less as photographic
    // micro-detail. Held below ~0.6 so foliage/flower detail doesn't smear away.
    const col = mix(raw, bestMean, float(0.52)).toVar();

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
    col.assign(col.sub(0.5).mul(1.14).add(0.5)); // a touch more contrast for the reference's sunlit depth (still no crushed blacks)
    const l1 = lum(col);
    col.assign(mix(vec3(l1), col, uChroma)); // +chroma
    col.addAssign(vec3(0.065, 0.03, -0.02).mul(l1)); // warm sunlight in the lights (reference reads warm/golden)
    col.addAssign(vec3(-0.01, 0.0, 0.035).mul(float(1.0).sub(l1))); // cool shadows
    const vg = screenUV.sub(0.5);
    col.mulAssign(float(1.0).sub(dot(vg, vg).mul(uVignette))); // vignette

    // ---- 5) CANVAS / PAPER TEXTURE over the whole frame ----------------------
    // The painting should read as PIGMENT SITTING IN CANVAS WEAVE, not a flat
    // grain overlay. Three ingredients, all sampled in FRAGMENT space so the
    // texture is fixed to the "canvas" and doesn't swim with the camera:
    //
    //   (a) fbm tooth   — 3-octave value-noise: fine fibre + medium mottle +
    //                     coarse blotch in one term, the body of the canvas grain.
    //   (b) canvas weave — two crossed sinusoidal ridges (warp + weft) give the
    //                     regular directional tooth of woven canvas. Built from
    //                     |cos| ridges so the threads read as raised lines.
    //   (c) paper fibre  — a faint high-frequency mottle on top, the random fleck
    //                     of pressed paper fibre.
    //
    // `uGrainScale` rescales the whole frequency family; `uWeave` crossfades
    // between pure mottle (0) and pronounced woven tooth (1). All centred on 0 so
    // the texture both darkens and lightens (pigment pools in the valleys, thins
    // on the threads). Overall strength is the live `paperTex` knob; 0 = clean.
    const gs = uGrainScale;
    const tooth = fbm(fc.mul(float(0.045).mul(gs)).add(vec2(7.0))).sub(0.5); // ~[-0.5,0.5]
    // Woven warp/weft: |cos| ridges crossed at 90°, centred on 0. The two axes use
    // slightly different frequencies so the weave never beats into a perfect grid.
    const warp = abs(cos(fc.x.mul(float(0.85).mul(gs)))).sub(0.5);
    const weft = abs(cos(fc.y.mul(float(0.92).mul(gs)))).sub(0.5);
    const weave = warp.add(weft).mul(0.5).mul(uWeave);
    // High-freq paper fleck, kept low so it textures without buzzing.
    const fibre = vnoise(fc.mul(float(1.7).mul(gs)).add(vec2(31.0))).sub(0.5).mul(0.35);

    const canvas = tooth.mul(0.7).add(weave).add(fibre); // ~centred on 0

    // Luminance-aware: let the tooth bite in the MIDTONES (where wet pigment sits
    // deepest in the weave) and clean up toward the highlights (thin paint / lit
    // thread tops show the canvas least). A simple parabola peaking at mid-grey.
    const lT = lum(col);
    const toothMask = float(1.0).sub(abs(lT.sub(0.5)).mul(2.0)).max(0.0); // 1 at mid, 0 at extremes
    const bite = mix(float(0.55), float(1.0), toothMask); // never fully off in darks/lights

    col.mulAssign(float(1.0).add(canvas.mul(uPaperTex).mul(bite)));

    return vec4(col, 1.0);
  });

  const post = new THREE.PostProcessing(renderer);
  post.outputNode = paint();
  return { post };
}
