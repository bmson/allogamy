import * as THREE from 'three/webgpu';

// Ghibli Verdant, read straight off the reference painting: many saturated green
// tones, warm dirt paths, pale rock, a bright cyan sky, and the white + yellow
// wildflower speckle that ties into the pollen theme.
//
// Colours are authored in sRGB hex; with ColorManagement on, THREE stores them
// linear, which is what the vertex-colour buffers and lights want.

export const palette = {
  // sky / atmosphere
  skyZenith: new THREE.Color('#2f93e6'),
  skyHorizon: new THREE.Color('#cdeef7'),
  fog: new THREE.Color('#c6d6da'), // pale blue-green air — strokes & mesh dissolve into it
  sun: new THREE.Color('#fff6df'),
  air: new THREE.Color('#bcd2d6'), // distance wash for the splats (reference paper tone)
  shadow: new THREE.Color('#7e86b0'), // luminous blue-violet — shadows never black
  cloud: new THREE.Color('#ffffff'),
  groundBounce: new THREE.Color('#8fc25c'), // hemisphere light, lower hemisphere

  // ground greens (low → sunlit high → shaded slope → deep blue-green accent)
  grassLow: new THREE.Color('#5aa830'),
  grassHigh: new THREE.Color('#aadc4e'),
  grassDark: new THREE.Color('#33701f'),
  grassDeep: new THREE.Color('#246b3a'),

  // earth & rock
  pathEarth: new THREE.Color('#b9803f'),
  pathEarthDry: new THREE.Color('#cf9a55'),
  rock: new THREE.Color('#b6b3a6'),
  rockShadow: new THREE.Color('#7f8378'),

  // wildflowers
  flowerWhite: new THREE.Color('#f4f7ee'),
  flowerYellow: new THREE.Color('#f4d23a'),

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
