import * as THREE from 'three/webgpu';
import { TerrainField } from './TerrainField';
import { Chunk } from './Chunk';
import { makeSplatMaterial } from '../render/SplatMaterial';
import { createTreePrototypes, createBushPrototypes, TreeProto } from './tree';
import { CHUNK_SIZE, LOAD_RADIUS, UNLOAD_RADIUS, WORLD_SEED } from '../config';

// Streams chunks around the bird. Generation is time-sliced (a few chunks per
// frame, nearest first) and reaches well beyond the fog, so terrain is always
// finished and faded-in before it could enter view — nothing changes on screen.

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

  private chunks = new Map<string, Chunk>();
  private queued = new Set<string>();
  private queue: { cx: number; cz: number; key: string }[] = [];
  private focus = new THREE.Vector3();

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
    const r2 = LOAD_RADIUS * LOAD_RADIUS + 1;

    for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
      for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
        if (dx * dx + dz * dz > r2) continue;
        const cx = ccx + dx;
        const cz = ccz + dz;
        const key = cx + ',' + cz;
        if (this.chunks.has(key) || this.queued.has(key)) continue;
        this.queued.add(key);
        this.queue.push({ cx, cz, key });
      }
    }

    for (const [key, ch] of this.chunks) {
      const ci = key.indexOf(',');
      const cx = +key.slice(0, ci);
      const cz = +key.slice(ci + 1);
      if (Math.abs(cx - ccx) > UNLOAD_RADIUS || Math.abs(cz - ccz) > UNLOAD_RADIUS) {
        ch.dispose(this.scene);
        this.chunks.delete(key);
      }
    }
  }

  /** Build up to `max` queued chunks this frame, nearest to the bird first. */
  tickGeneration(max = 3) {
    if (this.queue.length === 0) return;
    const fx = this.focus.x;
    const fz = this.focus.z;
    this.queue.sort((a, b) => dist2(a, fx, fz) - dist2(b, fx, fz));
    let n = 0;
    while (n < max && this.queue.length) {
      const { cx, cz, key } = this.queue.shift()!;
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
        if (!this.chunks.has(ccx + dx + ',' + (ccz + dz))) return false;
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
