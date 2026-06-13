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
  private wN: Noise2D; // domain-warp + frayed path edges (also drives wetness)

  constructor(seed: number) {
    this.hN = new Noise2D(seed);
    this.tN = new Noise2D((seed * 7 + 13) >>> 0);
    this.pN = new Noise2D((seed * 31 + 101) >>> 0);
    this.rN = new Noise2D((seed * 53 + 17) >>> 0);
    this.fN = new Noise2D((seed * 71 + 211) >>> 0);
    this.dN = new Noise2D((seed * 89 + 307) >>> 0);
    this.wN = new Noise2D((seed * 113 + 401) >>> 0);
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
    // Scoop the wet basins lower so pools nestle in genuine hollows (and the land
    // reads with more relief). The dip is squared so it only bites where wetness is
    // strong — a few cupped low places, not a general lowering.
    const wet = this.wetness(x, z);
    y -= wet * wet * 16;
    // Carve paths a touch lower so they read as worn tracks.
    y -= this.pathMask(x, z) * 1.4;
    return y;
  }

  /**
   * Path strength in [0,1]: the zero-contours of a warped fBm form winding tracks.
   * WILD by construction — the tracks are not clean ribbons:
   *  - the sample coords are DOMAIN-WARPED, so tracks meander, braid and fork;
   *  - the half-width breathes spatially, so a path swells, narrows and FADES out
   *    entirely in stretches (a track that peters into the grass and resumes);
   *  - the |contour| distance is perturbed by a high-frequency EDGE noise, so the
   *    grass/path boundary is frayed and ragged — grass pushes onto the track in
   *    tongues and the worn earth bleeds out in fingers, never a smooth band.
   */
  pathMask(x: number, z: number): number {
    // Domain warp: shove the lookup around by a lower-frequency flow field so the
    // track wanders organically instead of tracing a tidy noise contour.
    const wx = this.wN.fbm(x * 0.0011 + 19, z * 0.0011 - 7, 2) * 230;
    const wz = this.wN.fbm(x * 0.0011 - 31, z * 0.0011 + 23, 2) * 230;
    const px = x + wx, pz = z + wz;

    const v = this.pN.fbm(px * 0.0019, pz * 0.0019, 4);

    // Half-width breathes between ~0 (track fades to nothing) and full worn track.
    const widthN = this.wN.fbm(x * 0.0016 + 5, z * 0.0016 + 5, 2); // ~[-1,1]
    const half = THREE.MathUtils.clamp(0.062 + widthN * 0.05, 0.0, 0.11);
    if (half <= 0.001) return 0; // a stretch where the path has worn away entirely

    // Frayed edge: nibble the contour distance with fine noise so the rim breaks up
    // into ragged tongues/fingers rather than a clean feathered band.
    const fray = this.wN.fbm(x * 0.05, z * 0.05, 3) * 0.026;
    const d = Math.abs(v) + fray;
    return 1 - THREE.MathUtils.smoothstep(d, half * 0.22, half);
  }

  /**
   * Wetness in [0,1] — a broad, slow field marking the rare low basins where a
   * calm pool could gather. High only in a few places; water also requires the
   * terrain to actually dip into a hollow (see Chunk water placement), so pools
   * stay sparse. Kept analytic & cheap (sampled, never per-frame).
   */
  wetness(x: number, z: number): number {
    return THREE.MathUtils.smoothstep(this.wN.fbm(x * 0.0013 - 61, z * 0.0013 + 47, 3), 0.28, 0.62);
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
    // Rock shows on steep ground AND in more frequent, varied patches now: broad
    // weathered scree fields at a coarse scale, plus finer scattered outcrops, so
    // the meadow is studded with far more stone variety. Two octave-scales keep it
    // from reading as one uniform speckle.
    const scree = THREE.MathUtils.smoothstep(this.rN.fbm(x * 0.0055, z * 0.0055, 3), 0.22, 0.55);
    const outcrop = THREE.MathUtils.smoothstep(this.rN.fbm(x * 0.018 + 40, z * 0.018 - 23, 3), 0.3, 0.58);
    const patch = Math.max(scree * 0.7, outcrop * 0.6);
    const rock = THREE.MathUtils.clamp(Math.max(slope * 1.7 - 0.25, 0) + patch, 0, 1);
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
    // Damp, deep-green margins around the wet basins for richer value depth.
    out.lerp(palette.grassDeep, THREE.MathUtils.smoothstep(this.wetness(x, z), 0.45, 0.85) * 0.4);

    // Dirt paths — with WORN, BROKEN-UP margins rather than a clean fill. A medium
    // mottle scatters bare patches & damp dark pockets across the track, and a pale
    // grit/pebble fleck rides the frayed outer rim so the edge reads as scuffed and
    // ragged, never a painted ribbon.
    if (path > 0.01) {
      const dry = this.tN.noise(x * 0.05, z * 0.05) * 0.5 + 0.5;
      _earth.copy(palette.pathEarth).lerp(palette.pathEarthDry, dry);
      // mottle the bare earth so it isn't a flat slab (scuffed light/dark patches)
      const mottle = (this.dN.noise(x * 0.09, z * 0.09) * 0.5 + 0.5 - 0.5) * 0.22;
      _earth.offsetHSL(0, 0, mottle);
      // Only the STRONG path core paints as bare earth — faint/worn stretches keep
      // their green so the meadow dominates and the track reads as a thin accent
      // ribbon (cf. the reference), not a broad beige band bleeding through the turf.
      out.lerp(_earth, THREE.MathUtils.smoothstep(path, 0.38, 0.85));
      // pale grit along the worn outer band (path is mid, not full), broken by noise
      const rim = (1 - Math.abs(path - 0.55) * 3.0);
      const grit = this.rN.noise(x * 0.12, z * 0.12) * 0.5 + 0.5;
      if (rim > 0 && grit > 0.55) out.lerp(palette.pathPebble, rim * (grit - 0.55) * 0.8);
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
