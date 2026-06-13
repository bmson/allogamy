import * as THREE from 'three/webgpu';
import { pass, Fn, vec3, vec4, float, mix, luminance, screenUV, dot, smoothstep } from 'three/tsl';
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

  // soft halation glow — kept restrained so it lifts highlights without washing
  // the whole frame to milk (the "grading not there / too flat" fix).
  const bloomPass = bloom(scenePassColor, 0.28, 0.8, 0.12);
  const composed = scenePassColor.add(bloomPass);

  // Impressionist-realism grade: keep rich saturated colour (paintings aren't
  // grey), only a gentle black-lift so nothing is dead, a warm/cool split, and a
  // vignette. We SATURATE rather than desaturate-to-white.
  const monetGrade = Fn(([rgba]: [any]) => {
    const lifted = rgba.rgb.mul(0.965).add(0.022); // small black-lift only
    const l1 = luminance(lifted);
    let col: any = mix(vec3(l1, l1, l1), lifted, float(1.22)); // +22% chroma → richer
    col = col.add(vec3(0.045, 0.02, -0.02).mul(l1)); // warm the lights
    col = col.add(vec3(-0.012, 0.0, 0.04).mul(l1.oneMinus())); // cool the shadows
    const vg = screenUV.sub(0.5);
    col = col.mul(float(1.0).sub(dot(vg, vg).mul(0.26))); // gentle vignette
    return vec4(col, 1.0);
  });

  const post = new THREE.PostProcessing(renderer);
  post.outputNode = monetGrade(composed);
  return { post, bloomPass };
}
