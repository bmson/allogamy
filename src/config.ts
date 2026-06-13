// Global tunables for the world. Kept in one place so milestones can rebalance
// streaming, density, and view distance without hunting through modules.

export const WORLD_SEED = 1337;

// Terrain chunk grid (world units).
export const CHUNK_SIZE = 160; // metres per chunk edge
export const CHUNK_RES = 36; // heightfield quads per chunk edge (~4.4 m cells)

// Streaming radii, measured in chunks from the bird.
export const LOAD_RADIUS = 5; // generate out to this ring (5 * 160 = 800 m)
export const UNLOAD_RADIUS = 6; // keep until this ring, then free

// Splat density per chunk — high, for the wall-to-wall painted carpet. Tune live
// via SPLAT_DENSITY without touching code if perf needs it.
export const SPLATS_PER_CHUNK = 40000;
export const SPLAT_DENSITY = 1.0;

// Wind sway strength (world units), scaled per-instance by aWind.
export const WIND_STRENGTH = 1.1;

// Fog hides the streaming frontier: new chunks are born beyond FOG_FAR (inside
// the haze) and never visibly pop in. LOAD_RADIUS*CHUNK_SIZE must exceed FOG_FAR.
// Tighter now to bound the dense visible set and deepen the painterly haze.
export const FOG_NEAR = 420;
export const FOG_FAR = 720;

// Camera. Narrower fov → compressed, painting-like framing (cf. reference).
export const CAM_FOV = 54;
export const CAM_FAR = 5000;

// Direction the sun comes from (also used to place the sky glow).
export const SUN_DIR: [number, number, number] = [-0.5, 0.55, -0.62];
