import * as THREE from 'three/webgpu';
import { palette } from '../render/palette';
import { buildPostProcessing } from '../render/post';
import { FOG_NEAR, FOG_FAR, CAM_FOV, CAM_FAR, SUN_DIR, WORLD_SEED } from '../config';
import { createDrift, Drift } from '../render/petals';

export interface Updatable {
  update(dt: number, t: number): void;
}

/**
 * Prefer WebGPU; fall back to a WebGL2 backend if WebGPU is unavailable or its
 * init fails (e.g. headless Chrome). `?webgl` forces the fallback for testing.
 */
async function createRenderer(): Promise<THREE.WebGPURenderer> {
  const forceWebGL = new URLSearchParams(location.search).has('webgl');
  try {
    const r = new THREE.WebGPURenderer({ antialias: true, forceWebGL });
    await r.init();
    return r;
  } catch (e) {
    console.warn('[allogamy] WebGPU init failed — falling back to WebGL2.', e);
    const r = new THREE.WebGPURenderer({ antialias: true, forceWebGL: true });
    await r.init();
    return r;
  }
}

// Owns the WebGPU renderer, scene, camera, lights, and the frame loop. Modules
// register as updatables and are ticked in registration order before each draw.

export class Engine {
  renderer!: THREE.WebGPURenderer;
  scene!: THREE.Scene;
  camera!: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private updaters: Updatable[] = [];
  private postFX!: THREE.PostProcessing;
  private drift!: Drift;

  async init() {
    THREE.ColorManagement.enabled = true;
    const renderer = await createRenderer();
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    // Stylized flat-colour art: no tone mapping, so the authored bold, saturated
    // palette reaches the screen as-is (just sRGB-encoded on output).
    renderer.toneMapping = THREE.NoToneMapping;
    document.body.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = palette.fog.clone();
    scene.fog = new THREE.Fog(palette.fog.clone(), FOG_NEAR, FOG_FAR);
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(
      CAM_FOV,
      window.innerWidth / window.innerHeight,
      0.5,
      CAM_FAR,
    );

    // Bright, clean midday light: strong hemisphere fill keeps the greens
    // saturated, a warm key sun adds soft form.
    const hemi = new THREE.HemisphereLight(palette.skyZenith.clone(), palette.groundBounce.clone(), 1.05);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(palette.sun.clone(), 2.0);
    sun.position.set(...SUN_DIR).multiplyScalar(120);
    scene.add(sun);
    scene.add(sun.target);

    // Impressionist post: bloom halation + no-blacks Monet grade.
    this.postFX = buildPostProcessing(renderer, scene, this.camera).post;

    // Camera-anchored drift of petals/leaves/pollen/butterflies — the ever-present
    // airborne life that surrounds the bird (the literal allogamy). Its per-frame
    // cost is one uniform write; all motion is GPU vertex work.
    this.drift = createDrift({ seed: WORLD_SEED });
    scene.add(this.drift.object);

    window.addEventListener('resize', () => this.onResize());
  }

  private onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  add(u: Updatable) {
    this.updaters.push(u);
  }

  start() {
    this.renderer.setAnimationLoop(() => this.tick());
  }

  private tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    for (const u of this.updaters) u.update(dt, t);
    this.drift.update(this.camera.position, t);
    this.postFX.render(); // bloom + grade (replaces renderer.render)
  }
}
