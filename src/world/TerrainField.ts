import * as THREE from 'three/webgpu';
import { Noise2D } from '../core/noise';
import { palette } from '../render/palette';

// The analytic description of the landscape: height, normal, and surface colour
// as pure functions of world (x, z). Chunks sample this; the flight controller
// samples height for ground clearance. Deterministic from the world seed.

const _n = new THREE.Vector3();

const clamp = THREE.MathUtils.clamp;
const smoothstep = THREE.MathUtils.smoothstep;

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
    return smoothstep(this.fN.fbm(x * 0.0026, z * 0.0026, 3), -0.15, 0.5);
  }

  /**
   * The broad terrain RELIEF (rolling continent, overlapping ridgelines, hills and
   * fine detail) — everything that shapes the land BEFORE the local water/path
   * carving. Factored out from `height()` so the central-difference `normal()` can
   * sample it directly: it dominates the surface gradient, while the path notch and
   * the very-low-frequency wet dip change the normal only negligibly at a ~1.6 m eps
   * (and the paths read as flat water anyway). This roughly halves the cost of
   * `surface()`, which is the field's single hottest call (per grid vertex, plus a
   * 4-tap normal). Deterministic and allocation-free.
   */
  private relief(x: number, z: number): number {
    // Broad rolling continent: the slow swell that the eye reads as the land's
    // body, before any sharper relief is layered on.
    const continent = this.hN.fbm(x * 0.0009, z * 0.0009, 3);

    // Mid-scale RIDGES, domain-warped so ranges overlap and interleave instead of
    // tracing tidy parallel waves. The ridge transform (1 - |fbm|, then squared)
    // turns rounded noise into crisp ridgelines separated by broad cupped valleys —
    // which is what makes the hills read as carved land rather than dunes.
    const wx = this.hN.noise(x * 0.0016 + 11, z * 0.0016 - 4) * 60;
    const wz = this.hN.noise(x * 0.0016 - 7, z * 0.0016 + 19) * 60;
    let ridge = 1 - Math.abs(this.hN.fbm((x + wx) * 0.0021 - 40, (z + wz) * 0.0021 + 70, 3));
    ridge = ridge * ridge; // sharpen the crests, open out the valley floors

    // Secondary hills and the fine breakup that keeps slopes from going glassy.
    const hills = this.hN.fbm(x * 0.0042 + 100, z * 0.0042 - 50, 4);
    const detail = this.hN.fbm(x * 0.02, z * 0.02, 2);

    // Taller, more pronounced relief for depth and overlapping ridgelines. The
    // ridge term is biased to -0.5 so valleys sit BELOW the continent baseline,
    // giving genuine hollows for water and shade to gather in.
    return continent * 105 + (ridge - 0.5) * 64 + hills * 24 + detail * 3.5;
  }

  /** Terrain height at world (x, z) — relief, then the local water/path carving. */
  height(x: number, z: number): number {
    let y = this.relief(x, z);
    // Scoop the wet basins lower so pools nestle in genuine hollows (and the land
    // reads with more relief). The dip is squared so it only bites where wetness is
    // strong — a few cupped low places, not a general lowering.
    const wet = this.wetness(x, z);
    y -= wet * wet * 16;
    // Carve paths a touch lower so they read as worn tracks (now a sunk water bed):
    // a soft V — deepest down the centreline, easing back up toward the banks.
    const p = this.pathMask(x, z);
    y -= p * p * 2.0;
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
    // track wanders organically instead of tracing a tidy noise contour. Two octaves
    // is plenty for the warp (it only needs to be smooth), keeping this cheap.
    const wx = this.wN.fbm(x * 0.0011 + 19, z * 0.0011 - 7, 2) * 230;
    const wz = this.wN.fbm(x * 0.0011 - 31, z * 0.0011 + 23, 2) * 230;
    const px = x + wx, pz = z + wz;

    const v = this.pN.fbm(px * 0.0019, pz * 0.0019, 4);

    // Half-width breathes between ~0 (track fades to nothing) and full worn track.
    const widthN = this.wN.fbm(x * 0.0016 + 5, z * 0.0016 + 5, 2); // ~[-1,1]
    const half = clamp(0.062 + widthN * 0.05, 0.0, 0.11);
    if (half <= 0.001) return 0; // a stretch where the path has worn away entirely

    // Frayed edge: nibble the contour distance with fine noise so the rim breaks up
    // into ragged tongues/fingers rather than a clean feathered band.
    const fray = this.wN.fbm(x * 0.05, z * 0.05, 3) * 0.026;
    const d = Math.abs(v) + fray;
    return 1 - smoothstep(d, half * 0.22, half);
  }

  /**
   * Wetness in [0,1] — a broad, slow field marking the rare low basins where a
   * calm pool could gather. High only in a few places; water also requires the
   * terrain to actually dip into a hollow (see Chunk water placement), so pools
   * stay sparse. Kept analytic & cheap (sampled, never per-frame).
   */
  wetness(x: number, z: number): number {
    return smoothstep(this.wN.fbm(x * 0.0013 - 61, z * 0.0013 + 47, 3), 0.28, 0.62);
  }

  /**
   * Surface normal via central differences. Samples the broad RELIEF (not the full
   * carved height): the path notch and the slow wet dip perturb a 1.6 m-eps gradient
   * negligibly, and paths shade as flat water regardless — so this halves the normal
   * cost without a visible change to the lit turf.
   */
  normal(x: number, z: number, eps = 1.6, out = _n): THREE.Vector3 {
    const hL = this.relief(x - eps, z);
    const hR = this.relief(x + eps, z);
    const hD = this.relief(x, z - eps);
    const hU = this.relief(x, z + eps);
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
    const scree = smoothstep(this.rN.fbm(x * 0.0055, z * 0.0055, 3), 0.22, 0.55);
    const outcrop = smoothstep(this.rN.fbm(x * 0.018 + 40, z * 0.018 - 23, 3), 0.3, 0.58);
    const patch = Math.max(scree * 0.7, outcrop * 0.6);
    let rock = clamp(Math.max(slope * 1.7 - 0.25, 0) + patch, 0, 1);
    // The water channel washes its bed clean — suppress stone inside the brook so a
    // scree patch never floats over the calm surface as a rocky speckle.
    if (path > 0.3) rock *= 1 - smoothstep(path, 0.3, 0.6);
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
    const hn = clamp((y + 36) / 110, 0, 1);

    // Base green, sunlit toward the tops.
    out.copy(palette.grassLow).lerp(palette.grassHigh, smoothstep(hn, 0.32, 0.96));
    // Shade and deepen on slopes.
    out.lerp(palette.grassDark, clamp(slope * 1.5, 0, 0.7));
    out.lerp(palette.grassDeep, smoothstep(slope, 0.18, 0.5) * 0.3);
    // Damp, deep-green margins around the wet basins for richer value depth.
    out.lerp(palette.grassDeep, smoothstep(this.wetness(x, z), 0.45, 0.85) * 0.4);

    // Water stream — the winding channel (was a dirt track) now reads as a calm
    // blue brook nestled in its sunk bed. The colour bands run from a deep blue-
    // green body in the centre of the channel out to paler sun-skimmed shallows
    // toward the banks, finished with a wet dark-mud rim where it meets the turf.
    // Gentle noise mottles the surface so it isn't a flat slab — but it's a slow,
    // smooth ripple (low frequency), never the scuffed/gritty break-up of earth.
    if (path > 0.01) {
      // Wet-mud rim first: a thin dark band rides the frayed outer edge of the
      // channel (path mid, not full) where wet earth meets grass.
      const rim = (1 - Math.abs(path - 0.42) * 3.4);
      if (rim > 0) out.lerp(palette.waterEdge, clamp(rim, 0, 1) * 0.75);
      // The channel body: shallows toward the banks deepening to the centre. A slow
      // ripple shifts the deep/shallow mix so the surface has gentle movement of
      // tone without reading as broken ground. A second, slower swell crossing the
      // first keeps the ripple from tiling into a regular wash.
      const ripple = (this.tN.fbm(x * 0.02, z * 0.02, 2)
        + this.tN.noise(z * 0.009 - 13, x * 0.009 + 7) * 0.5) * 0.4 + 0.5;
      // a richer, deeper blue-green body (a touch more contrast bank→centre).
      _water.copy(palette.waterShallow).lerp(palette.waterDeep, smoothstep(path, 0.26, 0.95));
      // SKY REFLECTION: the calm surface mirrors the pale horizon in broad patches
      // where the slow ripple crests — soft luminous blue lifts that read as a still
      // brook catching the sky, not a flat painted band.
      _water.lerp(palette.skyHorizon, clamp((ripple - 0.56) * 1.4, 0, 1) * 0.42);
      // FINE SPARKLE: a tight high-frequency glint field lays scattered near-white
      // sun-points on the crests — the sun glittering off moving water.
      const spark = this.tN.noise(x * 0.14 + 4.2, z * 0.14 - 9.1);
      if (spark > 0.72) _water.lerp(palette.sun, (spark - 0.72) * 1.6 * 0.5);
      // Only the channel proper paints as water — faint/worn stretches keep their
      // green so the brook reads as a thin winding ribbon the meadow presses up to.
      out.lerp(_water, smoothstep(path, 0.3, 0.9));
    }

    // Rock.
    if (rock > 0.01) {
      _rk.copy(palette.rockShadow).lerp(palette.rock, this.tN.noise(x * 0.08, z * 0.08) * 0.5 + 0.5);
      out.lerp(_rk, smoothstep(rock, 0.3, 0.8));
    }
    return out;
  }

  /** Smooth painterly tint, applied to the solid mesh for richness. */
  tint(x: number, z: number): number {
    return this.tN.fbm(x * 0.012, z * 0.012, 2);
  }
}

const _water = new THREE.Color();
const _rk = new THREE.Color();
