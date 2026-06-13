// Global tunables for the world. Kept in one place so milestones can rebalance
// streaming, density, and view distance without hunting through modules.

export const WORLD_SEED = 1337;

// Terrain chunk grid (world units).
export const CHUNK_SIZE = 160; // metres per chunk edge
export const CHUNK_RES = 36; // heightfield quads per chunk edge (~4.4 m cells)

// Streaming radii, measured in chunks from the bird.
export const LOAD_RADIUS = 6; // generate out to this ring (6 * 160 = 960 m)
export const UNLOAD_RADIUS = 7; // keep until this ring, then free

// Splat density per chunk (the painterly billboard layer over the solid mesh).
// Finer, denser dabs for higher fidelity; the colour-matched mesh underneath
// fills micro-gaps so we don't have to brute-force density (keeps perf sane).
export const SPLATS_PER_CHUNK = 22000;

// Fog hides the streaming frontier: new chunks are born beyond FOG_FAR (inside
// the haze) and never visibly pop in. LOAD_RADIUS*CHUNK_SIZE must exceed FOG_FAR.
// Pushed out so nearby terrain stays crisp and saturated; haze only far off.
export const FOG_NEAR = 520;
export const FOG_FAR = 900;

// Camera. Narrower fov → compressed, painting-like framing (cf. reference).
export const CAM_FOV = 54;
export const CAM_FAR = 5000;

// Direction the sun comes from (also used to place the sky glow).
export const SUN_DIR: [number, number, number] = [-0.5, 0.55, -0.62];
