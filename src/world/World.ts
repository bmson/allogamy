import * as THREE from 'three/webgpu';
import { TerrainField } from './TerrainField';
import { Chunk } from './Chunk';
import { makeSplatMaterial } from '../render/SplatMaterial';
import { createTreePrototypes, createBushPrototypes, TreeProto } from './tree';
import { CHUNK_SIZE, LOAD_RADIUS, UNLOAD_RADIUS, WORLD_SEED } from '../config';

// Streams chunks around the bird. Generation is time-sliced (a few chunks per
// frame, nearest first) and reaches well beyond the fog, so terrain is always
// finished and faded-in before it could enter view — nothing changes on screen.
//
// Perf shape: the heavy bookkeeping (ring scan, unload sweep, queue prune) only
// runs when the bird crosses a chunk boundary — on every other frame update() is
// an O(1) no-op. Live chunks are keyed by a packed integer (no per-frame string
// allocation / parsing), and the build queue is kept nearest-first only when it
// has actually changed, so the hot path stays allocation-free and hitch-free.

// Chunk coords are packed into one integer key so the live set is a plain numeric
// Map (no string concat per cell per frame, no indexOf/slice to decode). Coords
// are biased into a non-negative range and packed at 16 bits each — the streamed
// world never strays anywhere near ±32k chunks (that is ±5.2 million metres).
const KEY_BIAS = 0x8000; // 32768 — centres the signed range in [0, 65535]
function packKey(cx: number, cz: number): number {
  return ((cx + KEY_BIAS) << 16) | (cz + KEY_BIAS);
}
// Recover the signed chunk coords from a packed key (unsigned shift to dodge the
// sign bit, since the high half can set bit 31). Lets the unload sweep range-test
// live chunks without storing cx/cz separately or reaching into Chunk's internals.
function keyCx(key: number): number {
  return (key >>> 16) - KEY_BIAS;
}
function keyCz(key: number): number {
  return (key & 0xffff) - KEY_BIAS;
}

interface QueueItem {
  cx: number;
  cz: number;
  key: number;
}

export class World {
  private scene: THREE.Scene;
  private field: TerrainField;
  private meshMat: THREE.Material;
  private pointMat: THREE.Material;
  private rockMat: THREE.Material;
  private trunkMat: THREE.Material;
  private waterMat: THREE.Material;
  private protos: TreeProto[];
  private bushProtos: TreeProto[];

  private chunks = new Map<number, Chunk>();
  private queued = new Set<number>();
  private queue: QueueItem[] = [];
  private focus = new THREE.Vector3();

  // The chunk cell the bird currently sits in. Bookkeeping only re-runs when this
  // changes; -0x7fffffff is an impossible cell so the very first update() fires.
  private lastCcx = -0x7fffffff;
  private lastCcz = -0x7fffffff;
  // Set when the queue's membership changes, so tickGeneration only re-sorts the
  // nearest-first order when it can have actually shifted (not every frame).
  private queueDirty = false;

  constructor(scene: THREE.Scene, field: TerrainField) {
    this.scene = scene;
    this.field = field;

    this.meshMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0,
    });
    this.pointMat = makeSplatMaterial();
    this.rockMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0,
      flatShading: true, // crisp faceted stone
    });
    this.trunkMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      flatShading: true,
    });
    // Calm water: vertex-coloured (cool sky tones baked in) but LIT and smooth, so
    // the sun + sky hemisphere skim a quiet sheen off it. Low roughness reads as a
    // still, reflective surface without an env map; slightly transparent so the
    // muddy shore beneath feathers through at the rim.
    this.waterMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.12,
      metalness: 0.0,
      transparent: true,
      opacity: 0.9,
    });
    this.protos = createTreePrototypes(WORLD_SEED);
    this.bushProtos = createBushPrototypes(WORLD_SEED);
  }

  /** Queue any missing chunks in range; free chunks that fell out of range. */
  update(pos: THREE.Vector3) {
    this.focus.copy(pos);
    const ccx = Math.floor(pos.x / CHUNK_SIZE);
    const ccz = Math.floor(pos.z / CHUNK_SIZE);
    // Within a single chunk cell the needed disc, the unload set, and the queue's
    // membership are all identical frame to frame — so the whole sweep is skipped
    // until the bird actually crosses into a new cell. tickGeneration still drains
    // the queue every frame; this only gates the (allocation-heavy) re-planning.
    if (ccx === this.lastCcx && ccz === this.lastCcz) return;
    this.lastCcx = ccx;
    this.lastCcz = ccz;
    // The bird crossed into a new cell, so any pending work should be re-ordered
    // nearest-first toward the new position before the next build slice.
    if (this.queue.length) this.queueDirty = true;

    // ---- queue any missing chunk inside the load disc, nearest cells first ----
    const r2 = LOAD_RADIUS * LOAD_RADIUS + 1;
    for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
      for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
        if (dx * dx + dz * dz > r2) continue;
        const cx = ccx + dx;
        const cz = ccz + dz;
        const key = packKey(cx, cz);
        if (this.chunks.has(key) || this.queued.has(key)) continue;
        this.queued.add(key);
        this.queue.push({ cx, cz, key });
        this.queueDirty = true;
      }
    }

    // ---- free live chunks that fell out of the (Chebyshev) unload box ----
    for (const [key, ch] of this.chunks) {
      if (Math.abs(keyCx(key) - ccx) > UNLOAD_RADIUS || Math.abs(keyCz(key) - ccz) > UNLOAD_RADIUS) {
        ch.dispose(this.scene);
        this.chunks.delete(key);
      }
    }

    // ---- drop queued-but-unbuilt chunks that drifted out of range ----
    // On a fast bird, cells queued a few crossings ago can leave the load disc
    // before we ever reach them. Building those would burn a whole frame slice on
    // a chunk we'd unload immediately — and an un-pruned queue/queued set leaks.
    // Compact in place (single pass, no allocation) so the survivors stay queued.
    let kept = 0;
    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];
      if (Math.abs(item.cx - ccx) > LOAD_RADIUS || Math.abs(item.cz - ccz) > LOAD_RADIUS) {
        this.queued.delete(item.key);
        this.queueDirty = true;
        continue;
      }
      this.queue[kept++] = item;
    }
    this.queue.length = kept;
  }

  /** Build up to `max` queued chunks this frame, nearest to the bird first. */
  tickGeneration(max = 3) {
    if (this.queue.length === 0) return;
    // Re-order nearest-first only when the queue's membership has changed since the
    // last build. The bird moves smoothly, so re-planning that happens at most once
    // per chunk-crossing is enough to keep "nearest first" honest, and we skip the
    // O(n log n) sort on the frames in between.
    if (this.queueDirty) {
      const fx = this.focus.x;
      const fz = this.focus.z;
      this.queue.sort((a, b) => dist2(b, fx, fz) - dist2(a, fx, fz));
      this.queueDirty = false;
    }
    let n = 0;
    // The queue is sorted farthest-first, so the nearest chunks sit at the tail and
    // pop() drains them in O(1) without the O(n) shift() did on every build.
    while (n < max && this.queue.length) {
      const { cx, cz, key } = this.queue.pop()!;
      this.queued.delete(key);
      if (this.chunks.has(key)) continue;
      const ch = new Chunk(
        cx, cz, this.field,
        this.meshMat, this.pointMat, this.rockMat, this.trunkMat, this.waterMat, this.protos, this.bushProtos,
      );
      this.scene.add(ch.group);
      this.chunks.set(key, ch);
      n++;
    }
  }

  /** Tick gentle per-chunk fauna animation (head-bob, tail flick, soaring bird). */
  tickFauna(time: number) {
    for (const ch of this.chunks.values()) ch.update(time);
  }

  /** True once the 3×3 block under the bird exists — used to reveal the scene. */
  ready(): boolean {
    const ccx = Math.floor(this.focus.x / CHUNK_SIZE);
    const ccz = Math.floor(this.focus.z / CHUNK_SIZE);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!this.chunks.has(packKey(ccx + dx, ccz + dz))) return false;
      }
    }
    return true;
  }
}

function dist2(c: { cx: number; cz: number }, fx: number, fz: number): number {
  const x = (c.cx + 0.5) * CHUNK_SIZE - fx;
  const z = (c.cz + 0.5) * CHUNK_SIZE - fz;
  return x * x + z * z;
}
