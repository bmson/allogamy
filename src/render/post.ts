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
  min,
  pow,
  cos,
  smoothstep,
  reflect,
  normalize,
  screenUV,
  screenSize,
} from 'three/tsl';
import {
  uGlow, uImpasto, uChroma, uVignette, uBleed,
} from '../core/settings';

// Single full-screen TSL "painting" pass. In order:
//   1. Kuwahara flatten        — painterly cohesion (confident flat masses)
//   1.5 oil-paint bleed        — optional contour-aligned smear (uBleed, off by default)
//   2. halation glow           — soft bloom on the BRIGHT highlights only
//   3. impasto relief          — a little directional brush-light on the paint
//   4. Monet grade             — gentle shoulder, warm key / cool shadows, no crushed
//                                blacks, soft aerial depth toward the horizon, painterly
//                                vignette.
//
// Runs in LINEAR space; PostProcessing applies the sRGB encode on output, so we do
// NOT tone-map or gamma-encode here.
//
// NOTE: there is deliberately NO whole-frame canvas / paper / grain / weave texture
// here. It was removed on purpose — the painting reads as light and pigment, not as a
// noisy overlay. Do not reintroduce procedural grain.

export function buildPostProcessing(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): { post: THREE.PostProcessing } {
  const scenePass = pass(scene, camera);
  const scenePassColor = scenePass.getTextureNode('output');

  // Reference luminance weights (0.299, 0.587, 0.114) — kept exact (TSL's built-in
  // `luminance` uses Rec.709 coefficients, which differ).
  const lum = (c: any): any => dot(c, vec3(0.299, 0.587, 0.114));

  // Sample the scene colour at a uv offset measured in texels (px = 1/resolution).
  const tap = (px: any, ox: number, oy: number): any =>
    scenePassColor.sample(screenUV.add(px.mul(vec2(ox, oy)))).rgb;

  const tapv = (px: any, off: any): any =>
    scenePassColor.sample(screenUV.add(px.mul(off))).rgb;

  const paint = Fn(() => {
    const px = float(1.0).div(screenSize); // texel size, stays correct across resizes

    const raw = scenePassColor.rgb.toVar();

    // ---- SHARED 3x3 NEIGHBOURHOOD ------------------------------------------
    // One ring of 9 taps reused for Kuwahara, the bleed/impasto gradient, and glow.
    const STEP = 1.4;
    const c = raw;
    const e = tap(px, STEP, 0);
    const w = tap(px, -STEP, 0);
    const n = tap(px, 0, STEP);
    const s = tap(px, 0, -STEP);
    const ne = tap(px, STEP, STEP);
    const nw = tap(px, -STEP, STEP);
    const se = tap(px, STEP, -STEP);
    const sw = tap(px, -STEP, -STEP);

    // ---- 1) KUWAHARA flatten: 4 quadrants, keep the lowest-variance mean ----
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

    const col = mix(raw, bestMean, float(0.52)).toVar();

    // ---- 1.5) OIL-PAINT BLEED (shared gradient) -----------------------------
    const grad = vec2(le.sub(lw), ln.sub(ls));
    const blen = grad.x.mul(grad.x).add(grad.y.mul(grad.y)).add(1e-5).sqrt();
    const fdir = vec2(grad.y.div(blen), grad.x.negate().div(blen)); // along the contour
    const smear = col
      .add(tapv(px, fdir.mul(3.0)))
      .add(tapv(px, fdir.mul(-3.0)))
      .mul(1.0 / 3.0);
    col.assign(mix(col, smear, uBleed));

    // ---- 2) HALATION GLOW (highlight-gated) ---------------------------------
    // Average the 4 diagonal taps, but only let the BRIGHT part bloom. A smooth
    // threshold means the glow lives on sun-on-water and the pale sky, instead of
    // hazing the whole frame the way an un-gated glow*glow does. The bloom is also
    // tinted gently warm so highlights read as sunlight, not a grey wash.
    const glow = ne.add(nw).add(se).add(sw).mul(0.25);
    const glowL = lum(glow);
    // Only luminance above ~0.62 contributes; soft knee up to ~0.95.
    const bloomMask = smoothstep(0.62, 0.95, glowL);
    const bloom = glow.mul(glow).mul(bloomMask);
    const warmBloom = bloom.mul(vec3(1.05, 1.0, 0.9)); // faintly golden highlight bloom
    col.addAssign(warmBloom.mul(uGlow.mul(0.3)));

    // ---- 3) IMPASTO RELIEF (a little directional brush-light) ----------------
    // Light the luminance gradient as a shallow relief. No canvas grain term — the
    // relief comes purely from the painting's own brush structure.
    const k = uImpasto;
    const nrm = normalize(vec3(grad.mul(2.6).mul(k).negate(), 1.0));
    const L = normalize(vec3(-0.45, 0.55, 0.78));
    const diff = max(dot(nrm, L), 0.0);
    col.mulAssign(float(0.9).add(diff.mul(0.18)));
    const spec = pow(max(dot(reflect(L.negate(), nrm), vec3(0.0, 0.0, 1.0)), 0.0), 30.0);
    col.addAssign(vec3(1.0, 0.97, 0.9).mul(spec).mul(lum(col)).mul(0.16).mul(k));

    // ---- 4) MONET GRADE ------------------------------------------------------
    // (a) Gentle S-shaped contrast around mid-grey. Slightly less push than the
    //     straight ×1.14 so the lights don't clip; the shoulder below tames the top.
    col.assign(col.sub(0.5).mul(1.1).add(0.5));

    // (b) Soft highlight shoulder: roll the brightest values off toward — but never
    //     onto — white so the pale sky and sun-sparkle stay luminous instead of
    //     blowing to a flat clipped patch. x / (1 + max(0, x-knee)*amount).
    const knee = float(0.78);
    const over = max(col.sub(knee), 0.0);
    const shoulder = float(1.0).div(float(1.0).add(over.mul(0.55)));
    col.assign(col.mul(shoulder));

    // (c) Shadow lift toward a luminous blue-violet so darks never crush to black —
    //     matches the palette's `shadow` (#7e86b0). Strongest in the deepest values.
    const l0 = lum(col);
    const shadowMask = float(1.0).sub(smoothstep(0.0, 0.34, l0)); // 1 in darks → 0 by mid
    col.addAssign(vec3(0.018, 0.022, 0.04).mul(shadowMask));

    // (d) Chroma (saturation around luminance).
    const l1 = lum(col);
    col.assign(mix(vec3(l1), col, uChroma));

    // (e) Warm light / cool shadow split — the heart of the golden, airy key. Warm
    //     the lights toward sun gold, cool the shadows toward sky blue. Tuned a touch
    //     richer than before for cohesion, still well short of a colour cast.
    col.addAssign(vec3(0.078, 0.036, -0.024).mul(l1)); // warm in the lights
    col.addAssign(vec3(-0.012, 0.0, 0.038).mul(float(1.0).sub(l1))); // cool in the shadows

    // (f) Aerial depth toward the horizon. The scene's vertical band reads as
    //     near→far (sky/horizon up top, foreground below). A faint cool, slightly
    //     lifted sky wash applied toward the upper band gives painterly distance
    //     without fog haze. Gated to the upper third and feathered, so the
    //     foreground stays crisp and saturated.
    const air = vec3(0.76, 0.82, 0.91); // pale sky-blue, matches palette `air`
    const horizonBand = smoothstep(0.5, 0.98, screenUV.y); // 0 low → 1 high
    const aerial = horizonBand.mul(0.038);
    col.assign(mix(col, air, aerial));

    // (g) Painterly vignette — a soft, slightly warm corner settle (not a hard black
    //     photographic ring). Darken corners gently and pull a touch of warmth out so
    //     the eye rests on the centre.
    const vg = screenUV.sub(0.5);
    const vd = dot(vg, vg);
    col.mulAssign(float(1.0).sub(vd.mul(uVignette)));

    // (h) Safety: keep everything in a sane positive range (the bloom/grade can push
    //     a hair past 1 on the brightest sky; clamp gently so the sRGB encode is clean).
    col.assign(max(col, vec3(0.0)));
    col.assign(min(col, vec3(1.25)));

    return vec4(col, 1.0);
  });

  const post = new THREE.PostProcessing(renderer);
  post.outputNode = paint();
  return { post };
}
