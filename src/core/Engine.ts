import * as THREE from 'three/webgpu';
import { palette } from '../render/palette';
import { buildPostProcessing } from '../render/post';
import { CAM_FOV, CAM_FAR, SUN_DIR } from '../config';
import { jsSettings } from './settings';

export interface Updatable {
  update(dt: number, t: number): void;
}

// Cap the device pixel ratio. The painterly post pass is heavily fill-rate bound
// (a multi-tap Kuwahara + flow bleed + glow over the WHOLE frame), so rendering
// at the native ratio of a 3x phone or Retina display would triple that cost for
// detail the soft, blended look throws away anyway. 2 keeps edges crisp on HiDPI
// while holding the post budget sane.
const MAX_PIXEL_RATIO = 2;

/**
 * Prefer WebGPU; fall back to a WebGL2 backend if WebGPU is unavailable or its
 * init fails (e.g. headless Chrome). `?webgl` forces the fallback for testing.
 *
 * `getFallback` lets the renderer downgrade to WebGL2 on its OWN if the WebGPU
 * backend faults mid-init, before our explicit catch even runs — so the first
 * `init()` already self-heals in most cases; the catch is the last-ditch retry.
 */
async function createRenderer(): Promise<THREE.WebGPURenderer> {
  const forceWebGL = new URLSearchParams(location.search).has('webgl');
  try {
    const r = new THREE.WebGPURenderer({
      antialias: true,
      forceWebGL,
      // Ask the OS for the discrete GPU on dual-GPU laptops — this is an
      // always-on flight piece, not a battery-sipper; the meadow wants the muscle.
      powerPreference: 'high-performance',
    });
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
  // Public so the live-tuning panel (src/ui/Controls.ts) can drive these JS-side
  // art params directly: light.intensity and scene.fog.near/far.
  sun!: THREE.DirectionalLight;
  hemi!: THREE.HemisphereLight;
  private clock = new THREE.Clock();
  private updaters: Updatable[] = [];
  private postFX!: THREE.PostProcessing;
  // Resize is coalesced to one apply per frame: a burst of `resize` events (a
  // window drag, a mobile rotate) only triggers a single, deferred re-layout.
  private pendingResize = false;
  // Last applied backbuffer dimensions — used to skip no-op resizes that would
  // otherwise free & reallocate the post render targets for no reason.
  private appliedW = 0;
  private appliedH = 0;
  private appliedDpr = 0;

  async init() {
    THREE.ColorManagement.enabled = true;
    const renderer = await createRenderer();
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    // Stylized flat-colour art: no tone mapping, so the authored bold, saturated
    // palette reaches the screen as-is (just sRGB-encoded on output).
    renderer.toneMapping = THREE.NoToneMapping;
    // The Sky dome fully wraps the view, so the canvas is never actually cleared
    // to this — but a sky-horizon clear means any single uncovered seam (or the
    // frame before the dome streams in) flashes blue, never black. Cheaper and
    // calmer than a transparent canvas compositing against the page.
    renderer.setClearColor(palette.skyHorizon, 1);
    document.body.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.appliedW = window.innerWidth;
    this.appliedH = window.innerHeight;
    this.appliedDpr = renderer.getPixelRatio();

    // Surface a lost GPU device instead of failing silently to a frozen frame —
    // WebGPU can drop the device on driver hiccups / GPU resets. We log loudly so
    // the symptom is diagnosable; THREE attempts its own internal restore.
    renderer.onDeviceLost = (info) => {
      console.error(`[allogamy] GPU device lost (${info.api}): ${info.reason ?? 'unknown'} — ${info.message}`);
    };

    const scene = new THREE.Scene();
    scene.background = palette.fog.clone();
    // Fog near/far seed from the live settings (which themselves seed from the
    // config consts), so the panel can update scene.fog.near/far in lockstep
    // with the splat-side fog uniforms (uFogNear/uFogFar). Defaults sit far past
    // the loaded world (bright, clear day): fog is effectively off until tuned in.
    scene.fog = new THREE.Fog(palette.fog.clone(), jsSettings.fogNear, jsSettings.fogFar);
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(
      CAM_FOV,
      window.innerWidth / window.innerHeight,
      0.5,
      CAM_FAR,
    );

    // Warm, low-afternoon light: a softer hemisphere fill (less flat) lets the
    // strong, warm directional key carve form into the lit meshes — golden, not cold.
    const hemi = new THREE.HemisphereLight(
      palette.skyZenith.clone(),
      palette.groundBounce.clone(),
      jsSettings.hemiIntensity,
    );
    scene.add(hemi);
    this.hemi = hemi;
    const sun = new THREE.DirectionalLight(palette.sun.clone(), jsSettings.sunIntensity);
    sun.position.set(...SUN_DIR).multiplyScalar(120);
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;

    // Painterly post: Kuwahara cohesion + halation glow + canvas relief + grade.
    this.postFX = buildPostProcessing(renderer, scene, this.camera).post;

    // `passive` resize listener: the handler never calls preventDefault, so the
    // browser can dispatch it without blocking scroll/paint. We only flag a
    // pending resize here; the real (allocating) work happens once, in the tick.
    window.addEventListener('resize', this.onResize, { passive: true });
  }

  // Arrow property → stable reference, so the listener could be removed cleanly
  // and `this` is bound without a per-call closure.
  private onResize = () => {
    this.pendingResize = true;
  };

  // Apply a coalesced resize. Skips entirely when nothing actually changed (the
  // common case for spurious resize events), so the post render targets are only
  // reallocated when the drawable size or DPI genuinely moved.
  private applyResize() {
    this.pendingResize = false;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === 0 || h === 0) return; // minimized / detached: don't divide by zero
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    if (w === this.appliedW && h === this.appliedH && dpr === this.appliedDpr) return;

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Re-clamp the pixel ratio every resize so dragging the window between a
    // Retina and a standard monitor updates the backbuffer density correctly.
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h);
    this.appliedW = w;
    this.appliedH = h;
    this.appliedDpr = dpr;
  }

  add(u: Updatable) {
    this.updaters.push(u);
  }

  start() {
    this.renderer.setAnimationLoop(() => this.tick());
  }

  private tick() {
    // Apply any pending resize BEFORE updaters run, so flight/camera math and the
    // draw all see one consistent aspect ratio this frame.
    if (this.pendingResize) this.applyResize();

    // Clamp dt so a stall (tab in background, GC pause) can't teleport the bird or
    // blow up an eased value — capped at 50 ms (~3 frames at 60 fps) of catch-up.
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    for (const u of this.updaters) u.update(dt, t);
    this.postFX.render(); // painterly post (replaces renderer.render)
  }
}
