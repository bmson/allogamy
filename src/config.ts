// Global tunables for the world. Kept in one place so milestones can rebalance
// streaming, density, and view distance without hunting through modules.

export const WORLD_SEED = 1337;

// Terrain chunk grid (world units).
export const CHUNK_SIZE = 160; // metres per chunk edge
export const CHUNK_RES = 36; // heightfield quads per chunk edge (~4.4 m cells)

// Streaming radii, measured in chunks from the bird. LOAD edge (5 * 160 = 800 m)
// sits comfortably beyond FOG_FAR (560 m), so new chunks are born ~240 m deep in
// the haze — invisible — and have ~5 s of flight to generate before they emerge.
export const LOAD_RADIUS = 5; // generate out to this ring (5 * 160 = 800 m)
export const UNLOAD_RADIUS = 5; // free as soon as out of load range — the Chebyshev
// box at 6 retained far more chunks than the disc ever fills; they sit past FOG_FAR
// so dropping to 5 shrinks the live set toward the ~89 disc with no visible pop.

// Splat density per chunk — high, for the wall-to-wall painted carpet. Tune live
// via SPLAT_DENSITY without touching code if perf needs it.
export const SPLATS_PER_CHUNK = 40000;
export const SPLAT_DENSITY = 1.0;

// Wind sway strength (world units), scaled per-instance by aWind.
export const WIND_STRENGTH = 1.1;

// Fog hides the streaming frontier: new chunks are born beyond FOG_FAR (inside
// the haze) and never visibly pop in. LOAD_RADIUS*CHUNK_SIZE must exceed FOG_FAR.
// Haze onset pushed OUT so a clear, saturated foreground band reads first and then
// recedes into mist — that dark→light, sharp→soft gradient is what gives the
// landscape depth. Too close (110) washed the mid-field flat. The far plane still
// dissolves the hills and the streaming frontier into the cool grey-blue haze.
export const FOG_NEAR = 200;
export const FOG_FAR = 560;

// Camera. Narrower fov → compressed, painting-like framing. Matches 6.html's 52°.
export const CAM_FOV = 52;
export const CAM_FAR = 5000;

// Direction the sun comes from (also used to place the sky glow).
export const SUN_DIR: [number, number, number] = [-0.5, 0.55, -0.62];
