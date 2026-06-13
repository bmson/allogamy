import * as THREE from 'three/webgpu';

// Ghibli Verdant, read straight off the reference painting: many saturated green
// tones, warm dirt paths, pale rock, a bright cyan sky, and the white + yellow
// wildflower speckle that ties into the pollen theme.
//
// Colours are authored in sRGB hex; with ColorManagement on, THREE stores them
// linear, which is what the vertex-colour buffers and lights want.

export const palette = {
  // sky / atmosphere — ported from 6.html's airy paper world. The hex below is
  // sRGB; THREE converts to linear, and these were chosen so the LINEAR values
  // land on the reference's shader colours: zenith vec3(0.55,0.67,0.86), horizon
  // vec3(0.93,0.87,0.8), aerial/fog vec3(0.72,0.75,0.89).
  skyZenith: new THREE.Color('#c4d6ef'), // soft blue overhead → linear ≈ (0.55,0.67,0.86)
  skyHorizon: new THREE.Color('#f7f0e7'), // warm pale paper horizon → linear ≈ (0.93,0.87,0.80)
  fog: new THREE.Color('#dde1f2'), // pale blue-violet aerial haze → linear ≈ (0.72,0.75,0.89)
  sun: new THREE.Color('#ffeec2'), // warm golden key
  air: new THREE.Color('#dde1f2'), // distance wash for the splats — matches the airy fog
  shadow: new THREE.Color('#7e86b0'), // luminous blue-violet — shadows never black
  cloud: new THREE.Color('#ffffff'),
  groundBounce: new THREE.Color('#8fc25c'), // hemisphere light, lower hemisphere

  // ground greens — temperature split: warm sunlit yellow-green → cool deep
  // blue-green shade, with a wide value range so the meadow isn't monochrome.
  grassLow: new THREE.Color('#2f8a44'), // lively meadow green — vibrant again, but shy
  grassHigh: new THREE.Color('#6cc456'), // of the original electric/acid extreme
  grassDark: new THREE.Color('#102815'),
  grassDeep: new THREE.Color('#0d2b1a'),
  grassLime: new THREE.Color('#cfdd35'), // bright lime patches (just off acid-yellow)

  // earth & rock — dirt warmed toward terracotta
  pathEarth: new THREE.Color('#a85e26'),
  pathEarthDry: new THREE.Color('#c47b3a'),
  pathPebble: new THREE.Color('#bcae93'), // pale worn grit scattered along worn margins
  rock: new THREE.Color('#b6b3a6'),
  rockShadow: new THREE.Color('#7f8378'),

  // water — rare calm tarns nestled in hollows. Cool and luminous, drinking the
  // sky: a deep blue-green body, a paler sun-skimmed shallow, and a wet dark mud
  // rim where the pool meets the turf.
  waterDeep: new THREE.Color('#2f6f86'), // cool blue-green body, reflecting zenith
  waterShallow: new THREE.Color('#7fb6bc'), // pale sun-skimmed shallows / sky sheen
  waterEdge: new THREE.Color('#4a3a28'), // wet dark mud at the shoreline

  // wildflowers — the colour punctuation we were missing (esp. violet)
  flowerWhite: new THREE.Color('#fefef7'),
  flowerYellow: new THREE.Color('#f9da12'),
  flowerViolet: new THREE.Color('#b89fdf'),
  flowerLavender: new THREE.Color('#c9b3e8'),
  goldenEye: new THREE.Color('#f2c80f'),
  orangeEye: new THREE.Color('#da5a0b'),

  // trees — deliberately deeper & richer than the grass so canopies read as
  // distinct masses against the bright chartreuse turf.
  bark: new THREE.Color('#6b4a2f'),
  barkDark: new THREE.Color('#3c2a19'),
  foliageLight: new THREE.Color('#6fb53c'),
  foliage: new THREE.Color('#357827'),
  foliageDark: new THREE.Color('#1c4d1f'),
  conifer: new THREE.Color('#235a38'),
  coniferDark: new THREE.Color('#123a26'),

  // bushes, berries & blossoms
  bush: new THREE.Color('#54a234'),
  bushDark: new THREE.Color('#357c27'),
  berryRed: new THREE.Color('#cb3a2c'),
  berryDeep: new THREE.Color('#7c2348'),
  blossom: new THREE.Color('#f1dbe9'),
} as const;
