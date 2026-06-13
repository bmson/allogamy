import { mulberry32 } from './rng';

// Classic 2D gradient (Perlin) noise with seeded permutation, plus fBm.
// Used for terrain height, colour tinting, paths, and the wind field.
//
// This is one of the hottest functions in the project — `noise()` is hit per
// terrain vertex (and four more times for each central-difference normal), across
// seven Noise2D instances in TerrainField alone, while chunks stream. So the inner
// loop is written to stay allocation-free and JIT-friendly: no per-call closures,
// every Math.floor computed once, gradient dot products fully inlined, and the
// gradient table split into two Float32Arrays so the dot product is a pair of
// direct typed-array loads instead of tuple indexing. The numeric output is
// BIT-IDENTICAL to the previous straightforward implementation, which is required:
// streamed-out chunks must regenerate pixel-for-pixel or the world flickers.

// The 8 unit-ish gradient directions, split component-wise so a dot product is two
// flat loads + two multiplies (faster than indexing an array-of-tuples, and the
// values stay exact). Index order matches the original GRAD2 table:
//   0:( 1, 1) 1:(-1, 1) 2:( 1,-1) 3:(-1,-1) 4:( 1, 0) 5:(-1, 0) 6:( 0, 1) 7:( 0,-1)
const GRAD_X = new Float32Array([1, -1, 1, -1, 1, -1, 0, 0]);
const GRAD_Y = new Float32Array([1, 1, -1, -1, 0, 0, 1, -1]);

// Quintic interpolant (Perlin's improved fade): zero 1st and 2nd derivatives at the
// cell edges, so adjacent cells join without the visible creasing the cubic gives.
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export class Noise2D {
  // 0..255 lattice hashes, doubled to 512 so `perm[a + b]` never overflows without a
  // wrap. Uint8 is both correct (values are 0..255) and the fastest width measured —
  // narrower loads, 4x less memory across the many instances the world allocates.
  private readonly perm = new Uint8Array(512);

  constructor(seed = 1) {
    const rnd = mulberry32(seed);
    const p = this.perm;
    for (let i = 0; i < 256; i++) p[i] = i;
    // Fisher–Yates shuffle for a seed-stable permutation. (Done in-place on the first
    // half of `perm` to avoid a scratch array — identical sequence to before.)
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    // Mirror the shuffled table into the upper half.
    for (let i = 0; i < 256; i++) p[i + 256] = p[i];
  }

  /** Single octave, output roughly in [-1, 1]. */
  noise(x: number, y: number): number {
    // Floor each axis ONCE (cell origin), then derive both the wrapped lattice index
    // and the fractional cell position from it — the original called Math.floor twice
    // per axis.
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const xi = fx & 255;
    const yi = fy & 255;
    const xf = x - fx;
    const yf = y - fy;

    const u = fade(xf);
    const v = fade(yf);

    // Hash the four cell corners. Hoist the two row hashes (p[xi], p[xi+1]) so each is
    // fetched once rather than twice.
    const p = this.perm;
    const a = p[xi] + yi;
    const b = p[xi + 1] + yi;
    const h00 = p[a] & 7;       // (0,0)
    const h01 = p[a + 1] & 7;   // (0,1)
    const h10 = p[b] & 7;       // (1,0)
    const h11 = p[b + 1] & 7;   // (1,1)

    // Gradient dot products to each corner, inlined (no closure allocation per call).
    const xf1 = xf - 1;
    const yf1 = yf - 1;
    const n00 = GRAD_X[h00] * xf + GRAD_Y[h00] * yf;
    const n10 = GRAD_X[h10] * xf1 + GRAD_Y[h10] * yf;
    const n01 = GRAD_X[h01] * xf + GRAD_Y[h01] * yf1;
    const n11 = GRAD_X[h11] * xf1 + GRAD_Y[h11] * yf1;

    // Bilinear blend with the faded weights (lerp inlined). ~[-1, 1].
    const x1 = n00 + (n10 - n00) * u;
    const x2 = n01 + (n11 - n01) * u;
    return x1 + (x2 - x1) * v;
  }

  /** Fractal Brownian motion, normalised to ~[-1, 1]. */
  fbm(x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}
