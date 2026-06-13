import * as THREE from 'three/webgpu';
import { Noise2D } from '../core/noise';
import { palette } from '../render/palette';

// The analytic description of the landscape: height, normal, and surface colour
// as pure functions of world (x, z). Chunks sample this; the flight controller
// samples height for ground clearance. Deterministic from the world seed.

const _n = new THREE.Vector3();

export interface SurfacePoint {
  slope: number; // 0 flat .. ~1 vertical
  path: number; // 0 grass .. 1 bare dirt path
  rock: number; // 0 none .. 1 rock face
  nx: number; // surface normal x (for sun shading)
  nz: number; // surface normal z
}

export class TerrainField {
  private hN: Noise2D; // height
  private tN: Noise2D; // colour tint
  private pN: Noise2D; // paths
  private rN: Noise2D; // rock patches
  private fN: Noise2D; // forest density
  private dN: Noise2D; // dry/lime patches

  constructor(seed: number) {
    this.hN = new Noise2D(seed);
    this.tN = new Noise2D((seed * 7 + 13) >>> 0);
    this.pN = new Noise2D((seed * 31 + 101) >>> 0);
    this.rN = new Noise2D((seed * 53 + 17) >>> 0);
    this.fN = new Noise2D((seed * 71 + 211) >>> 0);
    this.dN = new Noise2D((seed * 89 + 307) >>> 0);
  }

  /** Dry/lime patches in [0,1] — drives hot-lime grass overrides. */
  dry(x: number, z: number): number {
    return this.dN.fbm(x * 0.0055, z * 0.0055, 3) * 0.5 + 0.5;
  }

  /** Forest density in [0,1] — clumps of woodland with clearings between. */
  forest(x: number, z: number): number {
    return THREE.MathUtils.smoothstep(this.fN.fbm(x * 0.0026, z * 0.0026, 3), -0.15, 0.5);
  }

  /** Terrain height at world (x, z). */
  height(x: number, z: number): number {
    const continent = this.hN.fbm(x * 0.0009, z * 0.0009, 3); // broad rolling hills
    const hills = this.hN.fbm(x * 0.0042 + 100, z * 0.0042 - 50, 4);
    const ridges = this.hN.fbm(x * 0.0021 - 40, z * 0.0021 + 70, 3); // mid-scale relief
    const detail = this.hN.fbm(x * 0.02, z * 0.02, 2);
    // Taller, more pronounced hills for depth and overlapping ridgelines.
    let y = continent * 105 + ridges * 55 + hills * 26 + detail * 3.5;
    // Carve paths a touch lower so they read as worn tracks.
    y -= this.pathMask(x, z) * 1.4;
    return y;
  }

  /** Path strength in [0,1]: the zero-contours of a warped fBm form winding tracks. */
  pathMask(x: number, z: number): number {
    const v = this.pN.fbm(x * 0.0019, z * 0.0019, 3);
    return 1 - THREE.MathUtils.smoothstep(Math.abs(v), 0.018, 0.085);
  }

  /** Surface normal via central differences. */
  normal(x: number, z: number, eps = 1.6, out = _n): THREE.Vector3 {
    const hL = this.height(x - eps, z);
    const hR = this.height(x + eps, z);
    const hD = this.height(x, z - eps);
    const hU = this.height(x, z + eps);
    return out.set(hL - hR, 2 * eps, hD - hU).normalize();
  }

  surface(x: number, z: number): SurfacePoint {
    const n = this.normal(x, z);
    const slope = 1 - n.y;
    const nx = n.x, nz = n.z; // capture before _n is reused
    const path = this.pathMask(x, z);
    // Rock shows on steep ground and in sparse patches.
    const patch = THREE.MathUtils.smoothstep(this.rN.fbm(x * 0.011, z * 0.011, 3), 0.34, 0.6);
    const rock = THREE.MathUtils.clamp(Math.max(slope * 1.5 - 0.35, 0) + patch * 0.5, 0, 1);
    return { slope, path, rock, nx, nz };
  }

  /**
   * Surface colour from already-known surface values. Kept free of the heavy
   * height/normal evaluation so callers can precompute a grid once and sample it
   * cheaply per splat. `out` is reused to avoid allocations.
   */
  mixColor(
    x: number, z: number, y: number,
    slope: number, path: number, rock: number,
    out = new THREE.Color(),
  ): THREE.Color {
    const hn = THREE.MathUtils.clamp((y + 36) / 110, 0, 1);

    // Base green, sunlit toward the tops.
    out.copy(palette.grassLow).lerp(palette.grassHigh, THREE.MathUtils.smoothstep(hn, 0.32, 0.96));
    // Shade and deepen on slopes.
    out.lerp(palette.grassDark, THREE.MathUtils.clamp(slope * 1.5, 0, 0.7));
    out.lerp(palette.grassDeep, THREE.MathUtils.smoothstep(slope, 0.18, 0.5) * 0.3);

    // Dirt paths.
    if (path > 0.01) {
      const dry = this.tN.noise(x * 0.05, z * 0.05) * 0.5 + 0.5;
      _earth.copy(palette.pathEarth).lerp(palette.pathEarthDry, dry);
      out.lerp(_earth, THREE.MathUtils.smoothstep(path, 0.1, 0.7));
    }

    // Rock.
    if (rock > 0.01) {
      _rk.copy(palette.rockShadow).lerp(palette.rock, this.tN.noise(x * 0.08, z * 0.08) * 0.5 + 0.5);
      out.lerp(_rk, THREE.MathUtils.smoothstep(rock, 0.3, 0.8));
    }
    return out;
  }

  /** Smooth painterly tint, applied to the solid mesh for richness. */
  tint(x: number, z: number): number {
    return this.tN.fbm(x * 0.012, z * 0.012, 2);
  }
}

const _earth = new THREE.Color();
const _rk = new THREE.Color();
