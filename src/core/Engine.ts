import * as THREE from 'three/webgpu';
import { palette } from '../render/palette';
import { buildPostProcessing } from '../render/post';
import { FOG_NEAR, FOG_FAR, CAM_FOV, CAM_FAR, SUN_DIR } from '../config';

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

    // Warm, low-afternoon light: a softer hemisphere fill (less flat) lets the
    // strong, warm directional key carve form into the lit meshes — golden, not cold.
    const hemi = new THREE.HemisphereLight(palette.skyZenith.clone(), palette.groundBounce.clone(), 0.62);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(palette.sun.clone(), 2.6);
    sun.position.set(...SUN_DIR).multiplyScalar(120);
    scene.add(sun);
    scene.add(sun.target);

    // Painterly post: Kuwahara cohesion + halation glow + canvas relief + grade.
    this.postFX = buildPostProcessing(renderer, scene, this.camera).post;

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
    this.postFX.render(); // painterly post (replaces renderer.render)
  }
}
