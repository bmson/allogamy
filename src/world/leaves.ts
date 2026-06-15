import * as THREE from 'three/webgpu';
import { mulberry32, hash2 } from '../core/rng';
import { TerrainField } from './TerrainField';
import { SplatLayer } from '../render/SplatMaterial';
import { palette } from '../render/palette';
import { CHUNK_SIZE, WORLD_SEED, SUN_DIR } from '../config';

// Leaves blowing along the ground BENEATH the trees — the airborne "confetti"
// drift was lifted out of the sky and grounded here. These are ordinary splat
// strokes (so they merge into the chunk's single splat draw call and sway with
// the shared wind), but tuned to read as wind-stirred leaf litter rather than a
// uniform speckle:
//  - they GATHER into little wind-drifted clutches (a leaf pile, not lone flecks),
//    biased to settle where the canopy is densest — fallen from the wood above;
//  - their COLOUR echoes the foliage they dropped from: greener under light
//    woodland turning to amber/russet litter under the deep, old, shaded stands;
//  - they catch the same SUN the turf does (baked exposure), so they sit IN the
//    light instead of floating as flat decals;
//  - their stroke ANGLE streaks along the prevailing wind axis (with tumble
//    jitter) so the field reads as litter being CARRIED, not laid in a grid;
//  - most hug the ground in a thin carpet; only a stray few are lifted mid-gust.
// They keep a high sway weight (aWind>0) so the shared breeze tumbles them, and
// stay subtle & bounded — woodland litter, never a storm. Seeded from
// (cx, cz, WORLD_SEED) on a private salt so they're deterministic and seamless
// and can't perturb the terrain / tree / flower layouts.

const clamp = THREE.MathUtils.clamp;
const _col = new THREE.Color();

// Prevailing wind axis in the XZ plane, matched to the splat shader's gust (which
// pushes +X dominant, half on +Z). Leaf strokes streak along this so the litter
// reads as blowing in one coherent direction, not tumbling at random angles.
const WIND_ANGLE = Math.atan2(0.5, 1.0); // ≈ 0.46 rad, the gust's XZ heading
// Normalised sun azimuth (same convention as turf / flowers): leaves baked with
// this share the meadow's light. SUN_DIR is [x, y, z]; we use its horizontal cast.
const SUNX = SUN_DIR[0], SUNZ = SUN_DIR[2];

export function scatterLeaves(field: TerrainField, cx: number, cz: number): SplatLayer | null {
  const S = CHUNK_SIZE;
  const ox = cx * S;
  const oz = cz * S;
  // Own rng salt so leaf placement can't shift the terrain / tree / flower layouts,
  // and stays seamless across chunk borders.
  const rnd = mulberry32(hash2(cx, cz, (WORLD_SEED ^ 0x1eaf) >>> 0));

  const cen: number[] = [], scl: number[] = [], col: number[] = [];
  const wnd: number[] = [], ang: number[] = [], asp: number[] = [];

  // DENSITY: a little richer again so the woodland floor has more small "found"
  // detail, while still gathering under trees instead of carpeting the meadow.
  const cells = 12;
  const cs = S / cells;
  for (let gz = 0; gz < cells; gz++) {
    for (let gx = 0; gx < cells; gx++) {
      const x = ox + (gx + rnd()) * cs;
      const z = oz + (gz + rnd()) * cs;

      // Density gate FIRST: forest() is a single fbm, whereas surface() does a
      // central-difference normal + warped path + two rock octaves (~20× the work).
      // Most open-ground cells reject here, so we skip the expensive surface eval on
      // the overwhelming majority. Leaves gather under/near trees; only a stray few
      // drift into the open. Subtle. (dens: 0 open .. 1 deep woodland.)
      const dens = field.forest(x, z);
      // DENSITY: still strongly gated to woodland, with a few more stray drifts in
      // the open so the ground reads less empty from flight height.
      if (rnd() > 0.04 + dens * 0.52) continue;

      // Now the costly surface eval, only for cells that already passed the gate.
      const surf = field.surface(x, z);
      if (surf.path > 0.3 || surf.rock > 0.5 || surf.slope > 0.6) continue;

      const y = field.height(x, z);
      // Baked exposure from the surface normal (same meadow-sun term as the turf and
      // the flowers), so litter sits in the landscape's light. nx²+nz² gives ny back
      // without a second normal eval.
      const ny = Math.sqrt(Math.max(0, 1 - surf.nx * surf.nx - surf.nz * surf.nz));
      const lit = clamp(0.5 + 0.5 * (surf.nx * SUNX + ny * 0.55 + surf.nz * SUNZ), 0, 1);

      // A small wind-drifted clutch rather than a uniform fleck per cell: leaves pile
      // up where they settle. Denser woodland drops a slightly fuller pile. The
      // clutch is ELONGATED along the wind axis so it reads as a streaked drift, not
      // a round dot — leaves raked into a comet-tail by the breeze.
      const clutch = 1 + ((rnd() * (2 + dens * 4)) | 0); // 1..6, fuller in deep wood
      const cwx = Math.cos(WIND_ANGLE), cwz = Math.sin(WIND_ANGLE); // along-wind unit
      const drift = cs * 0.55; // clutch length scale
      for (let i = 0; i < clutch; i++) {
        // Offset along the wind (long) and across it (short) → a feathered streak.
        const along = (rnd() - 0.5) * 2 * drift;
        const across = (rnd() - 0.5) * drift * 0.45;
        const px = x + cwx * along - cwz * across;
        const pz = z + cwz * along + cwx * across;

        // Leaf colour echoes the canopy it fell from: light woodland stays greenish;
        // deep, old, shaded stands have turned to amber/russet litter. `turn` rises
        // with density (more turned the deeper the wood) and a touch with shade.
        const turn = clamp(dens * 0.55 + (1 - lit) * 0.25 + rnd() * 0.35, 0, 1);
        let h: number, s: number, l: number;
        if (turn < 0.45) {
          // green-turning: a yellow-green leaf just past its prime, echoing foliage.
          // A few are still fresh bright green (just-fallen), widening the spread.
          const freshLeaf = rnd() < 0.25;
          h = (freshLeaf ? 0.31 : 0.26) - rnd() * 0.05 - turn * 0.04;
          s = 0.5 + rnd() * 0.14;
          l = (freshLeaf ? 0.38 : 0.34) + rnd() * 0.12;
        } else if (turn < 0.78) {
          // warm amber / ochre — the bulk of the autumn litter.
          h = 0.11 + rnd() * 0.035;
          s = 0.62 + rnd() * 0.12;
          l = 0.4 + rnd() * 0.1;
        } else {
          // deep russet / rust-brown — the oldest fallen leaves (kept off black).
          h = 0.045 + rnd() * 0.03;
          s = 0.55 + rnd() * 0.12;
          l = 0.36 + rnd() * 0.08;
        }
        // Bake the meadow light: warm & lift in sun, cool & deepen in shade — the
        // same coupling the turf and flowers use, so litter shares the scene's light.
        l = clamp(l + (lit - 0.5) * 0.18, 0.12, 0.82);
        s = clamp(s * (0.92 + (1 - lit) * 0.14), 0, 1);
        _col.setHSL(clamp(h, 0, 1), s, l);
        // a faint cool shadow wash on the most shaded litter, never to black.
        if (lit < 0.4) _col.lerp(palette.shadow, (0.4 - lit) * 0.18);

        // Height: most leaves hug the ground in a thin carpet; a stray few catch the
        // gust and lift. Square the roll so the lifted ones are RARE (carpet-biased),
        // and let denser piles sit a hair lower (settled, packed litter).
        const lift = rnd() * rnd(); // 0..1, biased low
        const yy = y + 0.12 + lift * 1.35 - dens * 0.06;

        cen.push(px, yy, pz);
        scl.push(0.42 + rnd() * 0.6);
        col.push(_col.r, _col.g, _col.b);
        // Lifted leaves are mid-gust and sway hardest; settled litter sways less so it
        // reads as resting on the turf rather than levitating. Always >0 (vegetation).
        wnd.push(0.55 + lift * 0.95 + rnd() * 0.35);
        // Streak the stroke along the wind axis with a tumble jitter — litter being
        // CARRIED in one direction, lifted leaves tumbling more freely than settled.
        ang.push(WIND_ANGLE + (rnd() - 0.5) * (0.7 + lift * 1.6));
        // Elongated leaf-stroke; lifted/tumbling ones stretch a touch more.
        asp.push(0.85 + rnd() * 0.45 + lift * 0.35);
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
