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
export const WIND_STRENGTH = 1.7;

// Fog hides the streaming frontier: new chunks are born beyond FOG_FAR (inside
// the haze) and never visibly pop in — the landscape is always FULLY built before
// it emerges from the haze into view. So FOG_FAR MUST sit inside the guaranteed-
// built radius. With LOAD_RADIUS=4 the load disc (slightly rounded in World.ts)
// guarantees ~500 m of contiguous terrain even in its worst diagonal notch and at
// the worst bird-in-cell offset, so FOG_FAR=480 keeps the frontier safely buried.
// The haze colour is the bright pale blue-violet palette.fog, so the distance
// reads as a luminous summer haze (Ghibli aerial perspective), NOT grey gloom: a
// crisp, saturated ~300 m foreground that recedes into bright sky. Open the view
// out by raising LOAD_RADIUS (+ the disc round-out) AND these together, or pull
// them via the panel's fog sliders. (The splat aerial wash + scene.fog read these.)
export const FOG_NEAR = 460;
export const FOG_FAR = 720;

// Camera. Narrower fov → compressed, painting-like framing.
export const CAM_FOV = 52;
export const CAM_FAR = 5000;

// Direction the sun comes from (also used to place the sky glow).
export const SUN_DIR: [number, number, number] = [-0.5, 0.55, -0.62];
