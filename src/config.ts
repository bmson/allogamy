// Global tunables for the world. Kept in one place so milestones can rebalance
// streaming, density, and view distance without hunting through modules.

export const WORLD_SEED = 1337;

// Terrain chunk grid (world units).
export const CHUNK_SIZE = 160; // metres per chunk edge
export const CHUNK_RES = 36; // heightfield quads per chunk edge (~4.4 m cells)

// Streaming radii, measured in chunks from the bird. The dense haze (below) fully
// hides everything past ~480 m, so we needn't generate as far — fewer live chunks,
// better perf, and the streaming frontier is born inside the fog and never pops.
export const LOAD_RADIUS = 4; // generate out to this ring (4 * 160 = 640 m)
export const UNLOAD_RADIUS = 5; // keep until this ring, then free

// Splat density per chunk — high, for the wall-to-wall painted carpet. Tune live
// via SPLAT_DENSITY without touching code if perf needs it.
export const SPLATS_PER_CHUNK = 40000;
export const SPLAT_DENSITY = 1.0;

// Wind sway strength (world units), scaled per-instance by aWind.
export const WIND_STRENGTH = 1.1;

// Fog hides the streaming frontier: new chunks are born beyond FOG_FAR (inside
// the haze) and never visibly pop in. LOAD_RADIUS*CHUNK_SIZE must exceed FOG_FAR.
// Dense and CLOSE, like the reference (it fogged a 130 m world by 165 m): the cool
// grey-blue haze sets in early, muting and unifying the whole field into one
// luminous painting and giving the receding hills real atmospheric depth.
export const FOG_NEAR = 110;
export const FOG_FAR = 480;

// Camera. Narrower fov → compressed, painting-like framing (cf. reference).
export const CAM_FOV = 54;
export const CAM_FAR = 5000;

// Direction the sun comes from (also used to place the sky glow).
export const SUN_DIR: [number, number, number] = [-0.5, 0.55, -0.62];
