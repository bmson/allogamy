// Seeded RNG + gradient noise shared by terrain, tile building and particles.

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeNoise(seed) {
  const rand = mulberry32(seed);
  const perm = new Uint8Array(512);
  const gxA = new Float32Array(512), gyA = new Float32Array(512);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  for (let i = 0; i < 512; i++) {
    perm[i] = perm[i & 255];
    const a = rand() * Math.PI * 2;
    gxA[i] = Math.cos(a); gyA[i] = Math.sin(a);
  }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  function noise2(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);
    const h = (X, Y) => perm[(X & 255) + perm[Y & 255]];
    const d = (i, dx, dy) => gxA[i] * dx + gyA[i] * dy;
    const n00 = d(h(xi, yi), xf, yf);
    const n10 = d(h(xi + 1, yi), xf - 1, yf);
    const n01 = d(h(xi, yi + 1), xf, yf - 1);
    const n11 = d(h(xi + 1, yi + 1), xf - 1, yf - 1);
    const x1 = n00 + u * (n10 - n00);
    const x2 = n01 + u * (n11 - n01);
    return x1 + v * (x2 - x1);
  }
  function fbm(x, y, oct = 5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      sum += amp * noise2(x * freq, y * freq);
      norm += amp; amp *= 0.52; freq *= 2.07;
    }
    return sum / norm;
  }
  function ridge(x, y, oct = 4) {
    let amp = 0.6, freq = 1, sum = 0;
    for (let o = 0; o < oct; o++) {
      sum += amp * (0.7 - Math.abs(noise2(x * freq, y * freq)));
      amp *= 0.5; freq *= 2.1;
    }
    return sum;
  }
  return { noise2, fbm, ridge, rand };
}
