// Global tunables for the world. Kept in one place so milestones can rebalance
// streaming, density, and view distance without hunting through modules.

export const WORLD_SEED = 1337;

// Terrain chunk grid (world units).
export const CHUNK_SIZE = 160; // metres per chunk edge
export const CHUNK_RES = 36; // heightfield quads per chunk edge (~4.4 m cells)

// Streaming radii, measured in chunks from the bird. LOAD edge (5 * 160 = 800 m)
// sits comfortably beyond FOG_FAR (560 m), so new chunks are born ~240 m deep in
// the haze — invisible — and have ~5 s of flight to generate before they emerge.
export const LOAD_RADIUS = 4; // generate out to this ring (4 * 160 = 640 m)
export const UNLOAD_RADIUS = 4; // free as soon as out of load range. Fog is OFF, so
// far chunks aren't hidden — but 4 rings (~49-disc of live chunks vs ~89 at radius 5)
// is plenty of view at this FOV and roughly halves the live chunk/instance/draw-call
// count. The biggest single perf lever after the depth-write fix.

// Splat density per chunk — high, for the wall-to-wall painted carpet, but trimmed
// from 40000 to 22000: with the size-floor keeping distant dabs plush and the
// depth-write fix collapsing overdraw, the carpet still reads wall-to-wall while
// each chunk carries ~45% fewer instances (a direct cut to vertex + fill work).
// Tune live via SPLAT_DENSITY without touching code if perf needs it.
export const SPLATS_PER_CHUNK = 22000;
export const SPLAT_DENSITY = 1.0;

// Wind sway strength (world units), scaled per-instance by aWind.
export const WIND_STRENGTH = 1.1;

// Fog hides the streaming frontier: new chunks are born beyond FOG_FAR (inside
// the haze) and never visibly pop in. LOAD_RADIUS*CHUNK_SIZE must exceed FOG_FAR.
// Haze onset pushed OUT so a clear, saturated foreground band reads first and then
// recedes into mist — that dark→light, sharp→soft gradient is what gives the
// landscape depth. Too close (110) washed the mid-field flat. The far plane still
// dissolves the hills and the streaming frontier into the cool grey-blue haze.
// Fog effectively REMOVED — pushed far beyond the ~800 m loaded world so nothing
// in view is hazed (bright, clear, happy day). Re-add via the panel's fog sliders
// or by lowering these. (The splat aerial wash + scene.fog both read these.)
export const FOG_NEAR = 1500;
export const FOG_FAR = 3000;

// Camera. Narrower fov → compressed, painting-like framing. Matches 6.html's 52°.
export const CAM_FOV = 52;
export const CAM_FAR = 5000;

// Direction the sun comes from (also used to place the sky glow).
export const SUN_DIR: [number, number, number] = [-0.5, 0.55, -0.62];
