import * as THREE from 'three/webgpu';

// Ghibli Verdant, read straight off the reference painting: many saturated green
// tones, warm dirt paths, pale rock, a bright cyan sky, and the white + yellow
// wildflower speckle that ties into the pollen theme.
//
// Colours are authored in sRGB hex; with ColorManagement on, THREE stores them
// linear, which is what the vertex-colour buffers and lights want.

export const palette = {
  // sky / atmosphere
  skyZenith: new THREE.Color('#3875c2'),
  skyHorizon: new THREE.Color('#ccdee6'), // = fog, so hazed hills dissolve seamlessly into the sky
  fog: new THREE.Color('#ccdee6'), // cool pale grey-blue haze — strokes & mesh dissolve into it
  sun: new THREE.Color('#fff6df'),
  air: new THREE.Color('#ccdee6'), // distance wash for the splats (reference paper tone)
  shadow: new THREE.Color('#7e86b0'), // luminous blue-violet — shadows never black
  cloud: new THREE.Color('#ffffff'),
  groundBounce: new THREE.Color('#8fc25c'), // hemisphere light, lower hemisphere

  // ground greens — temperature split: warm sunlit yellow-green → cool deep
  // blue-green shade, with a wide value range so the meadow isn't monochrome.
  grassLow: new THREE.Color('#2a8a40'),
  grassHigh: new THREE.Color('#5fc94f'),
  grassDark: new THREE.Color('#102815'),
  grassDeep: new THREE.Color('#0d2b1a'),
  grassLime: new THREE.Color('#d8e21f'), // hot lime patches

  // earth & rock — dirt warmed toward terracotta
  pathEarth: new THREE.Color('#a85e26'),
  pathEarthDry: new THREE.Color('#c47b3a'),
  rock: new THREE.Color('#b6b3a6'),
  rockShadow: new THREE.Color('#7f8378'),

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
