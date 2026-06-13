import * as THREE from 'three/webgpu';
import { pass, Fn, vec3, vec4, float, mix, luminance, screenUV, dot } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

// The impressionist post stack: a soft global halation (bloom) so the whole
// high-key frame gently glows, then a "no-blacks Monet grade" that lifts the
// shadows (nothing is pure black), boosts chroma, warms the lights / cools the
// darks (split-tone), washes the brightest passages toward white, and vignettes.
// Runs in linear space; PostProcessing applies the sRGB encode on output, so we
// do NOT tone-map or gamma-encode here.

export function buildPostProcessing(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): { post: THREE.PostProcessing; bloomPass: ReturnType<typeof bloom> } {
  const scenePass = pass(scene, camera);
  const scenePassColor = scenePass.getTextureNode('output');

  // Highlight-only halation: a HIGH threshold so only the brightest passages (the
  // sun, white blooms) gain a faint glow — never the milky all-over wash that was
  // flattening and over-brightening the frame.
  const bloomPass = bloom(scenePassColor, 0.07, 0.6, 0.72);
  const composed = scenePassColor.add(bloomPass);

  // Painterly grade (after the reference, which used no bloom and a dark mossy
  // multiply-vignette): NO black-lift, NO chroma boost — the baked HSL value
  // contrast and the cool haze already carry the colour. Just a gentle midtone
  // contrast to restore depth, a whisper of warm-key/cool-shade, and a soft
  // vignette whose edges fall toward deep moss to frame the painting.
  const grade = Fn(([rgba]: [any]) => {
    let col: any = rgba.rgb;
    col = col.mul(col.mul(0.16).add(0.88)); // mild contrast — no crushed blacks, no blown highs
    const l1 = luminance(col);
    col = col.add(vec3(0.018, 0.006, -0.012).mul(l1)); // restrained warm light / cool shade
    const vg = screenUV.sub(0.5);
    const vig = float(1.0).sub(dot(vg, vg).mul(0.6)); // 1 at centre → darker at edges
    col = mix(col.mul(vec3(0.74, 0.86, 0.80)), col, vig); // edges deepen toward cool moss
    return vec4(col, 1.0);
  });

  const post = new THREE.PostProcessing(renderer);
  post.outputNode = grade(composed);
  return { post, bloomPass };
}
