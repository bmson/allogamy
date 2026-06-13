import * as THREE from 'three/webgpu';
import { mulberry32, hash2 } from '../core/rng';
import { TerrainField } from './TerrainField';
import { SplatLayer } from '../render/SplatMaterial';
import { CHUNK_SIZE, WORLD_SEED } from '../config';

// Leaves blowing along the ground BENEATH the trees — the airborne "confetti"
// drift was lifted out of the sky and grounded here. These are ordinary splat
// strokes (so they merge into the chunk's single splat draw call and sway with
// the shared wind), but tuned to read as wind-stirred leaf litter: low to the
// ground, leaf-coloured (green turning to amber/russet), elongated, with a high
// sway weight so the breeze carries them. They gather where woodland is dense
// (under canopies) and only a few stray into the open — kept subtle, not a storm.

const clamp = THREE.MathUtils.clamp;

export function scatterLeaves(field: TerrainField, cx: number, cz: number): SplatLayer | null {
  const S = CHUNK_SIZE;
  const ox = cx * S;
  const oz = cz * S;
  // Own rng salt so leaf placement can't shift the terrain / tree / flower layouts,
  // and stays seamless across chunk borders.
  const rnd = mulberry32(hash2(cx, cz, (WORLD_SEED ^ 0x1eaf) >>> 0));

  const cen: number[] = [], scl: number[] = [], col: number[] = [];
  const wnd: number[] = [], ang: number[] = [], asp: number[] = [];
  const c = new THREE.Color();

  const cells = 16;
  const cs = S / cells;
  for (let gz = 0; gz < cells; gz++) {
    for (let gx = 0; gx < cells; gx++) {
      const x = ox + (gx + rnd()) * cs;
      const z = oz + (gz + rnd()) * cs;
      const surf = field.surface(x, z);
      if (surf.path > 0.3 || surf.rock > 0.5 || surf.slope > 0.6) continue;
      const dens = field.forest(x, z); // 0 open .. 1 deep woodland
      // gather under/near trees; only a few drift into the open. Subtle.
      if (rnd() > 0.05 + dens * 0.55) continue;

      const y = field.height(x, z);
      const n = 1 + ((rnd() * 2) | 0); // 1-2 leaves per accepted cell
      for (let i = 0; i < n; i++) {
        const px = x + (rnd() - 0.5) * cs * 0.8;
        const pz = z + (rnd() - 0.5) * cs * 0.8;

        // Leaf colour: mostly green-turning, some warm amber, a few russet/brown.
        const t = rnd();
        let h: number, s: number, l: number;
        if (t < 0.5) { h = 0.27 - rnd() * 0.06; s = 0.46 + rnd() * 0.1; l = 0.38 + rnd() * 0.12; }
        else if (t < 0.8) { h = 0.11 + rnd() * 0.03; s = 0.6 + rnd() * 0.1; l = 0.44 + rnd() * 0.1; }
        else { h = 0.05 + rnd() * 0.03; s = 0.55 + rnd() * 0.1; l = 0.34 + rnd() * 0.08; }
        c.setHSL(h, clamp(s, 0, 1), clamp(l, 0.1, 0.9));

        cen.push(px, y + 0.25 + rnd() * 1.3, pz); // low to the ground, a few lifted by wind
        scl.push(0.5 + rnd() * 0.7);
        col.push(c.r, c.g, c.b);
        wnd.push(1.0 + rnd() * 0.7); // blow strongly — the breeze carries leaves most
        ang.push(rnd() * Math.PI); // random orientation → tumbling strokes
        asp.push(0.75 + rnd() * 0.5); // elongated leaf-stroke
      }
    }
  }

  if (scl.length === 0) return null;
  return {
    centers: Float32Array.from(cen),
    scales: Float32Array.from(scl),
    colors: Float32Array.from(col),
    winds: Float32Array.from(wnd),
    angles: Float32Array.from(ang),
    aspects: Float32Array.from(asp),
  };
}
