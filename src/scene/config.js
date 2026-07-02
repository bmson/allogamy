import * as THREE from 'three';

// ---------------- world layout ----------------
export const TILE = 58;                 // world units per tile
export const GRID_R = 2;                // tiles kept each side of camera
export const ACTIVE = 2 * GRID_R + 1;   // 5x5 = 25 live tiles
export const FADE_OUT = GRID_R * TILE - 14;   // strokes fully dissolved by here
export const FADE_IN = FADE_OUT - 44;         // start dissolving here
export const SORT_CULL_RADIUS = FADE_OUT + 2;
export const PER_TILE_CAP = 20000;      // hard ceiling on splats per tile
export const NSLOTS = ACTIVE * ACTIVE + 1; // +1 spare so a transition frame never starves
export const CAP = NSLOTS * PER_TILE_CAP;

// Calm tarns appear wherever the height field dips below this (~1.5% of the
// land, so ponds are an occasional gift, not a sea). Everything that reads
// ground level for FLYING or SETTLING should use surfaceAt (terrain.js),
// which clamps to the water surface.
export const WATER_LEVEL = 4.0;

// ---------------- stroke types (splatType attribute) ----------------
export const T_GROUND = 0;   // static dab
export const T_FOLIAGE = 1;  // canopy — sways + reacts to the crane's wake
export const T_GRASS = 3;    // grass/flowers — bends in wind + wake
export const T_LEAF = 4;     // loose drifting leaf
export const T_FLY = 5;      // butterfly / pollen mote flutter
export const T_BIRD = 6;     // distant circling swallows
export const T_SMOKE = 7;    // cottage chimney puffs
export const T_WATER = 8;    // pond strokes — slow horizontal shimmer

// ---------------- interleaved GPU layout ----------------
// Every splat buffer in the scene shares one layout so a single ShaderMaterial
// draws terrain, crane, pollen and blooms alike:
//   float buffer, stride 5: x, y, z, size, angle
//   uint8 buffer, stride 8: r, g, b, aspect, type, phase, flex, (pad)
export const F_STRIDE = 5;
export const U_STRIDE = 8;

// ---------------- Monet light ----------------
// Watercolor sun: warm but pale; shadows are luminous violet washes, never grey.
export const SUN = new THREE.Color(1.0, 0.95, 0.84);
export const SHADOW = new THREE.Color(0.6, 0.58, 0.82);
export const LIGHT = new THREE.Vector3(0.62, 0.72, 0.32).normalize();
