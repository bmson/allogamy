import * as THREE from 'three/webgpu';
import { palette } from './palette';
import { makeGlowTexture, makeCloudTexture } from './textures';
import { SUN_DIR } from '../config';

// A gradient sky dome + sun glow + a drift of soft cumulus. The whole rig
// follows the camera so the horizon is effectively infinite.

const sunDir = new THREE.Vector3(...SUN_DIR).normalize();

export class Sky {
  private camera: THREE.Camera;
  private group = new THREE.Group();
  private clouds: { sprite: THREE.Sprite; speed: number; offset: THREE.Vector3 }[] = [];

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.camera = camera;

    // Dome gradient ported from 6.html's skyFrag: mix(horizon, zenith) over a
    // smoothstep(-0.12, 0.55) band of dir.y, plus a warm sun glow that pools where
    // the view looks toward the sun. Baked per-vertex (sRGB-linear colours) so the
    // dome is a single cheap MeshBasic draw with no custom shader. dir is the
    // normalized vertex position (= view direction on a camera-centred sphere).
    const geo = new THREE.SphereGeometry(2400, 48, 32);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    const dir = new THREE.Vector3();
    // Warm sun glow tint, in the same linear space as palette colours: 6.html used
    // vec3(1.0, 0.8, 0.5) * 0.4 directly in the (linear) shader.
    const sunGlowTint = new THREE.Color(1.0, 0.8, 0.5).multiplyScalar(0.4);
    for (let i = 0; i < n; i++) {
      dir.set(
        geo.attributes.position.getX(i),
        geo.attributes.position.getY(i),
        geo.attributes.position.getZ(i),
      ).normalize();
      const t = THREE.MathUtils.smoothstep(dir.y, -0.12, 0.55);
      c.copy(palette.skyHorizon).lerp(palette.skyZenith, t);
      const sun = Math.pow(Math.max(dir.dot(sunDir), 0), 5);
      col[i * 3] = c.r + sunGlowTint.r * sun;
      col[i * 3 + 1] = c.g + sunGlowTint.g * sun;
      col[i * 3 + 2] = c.b + sunGlowTint.b * sun;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const dome = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }),
    );
    dome.renderOrder = -2;
    this.group.add(dome);

    // Sun glow.
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeGlowTexture(),
        color: palette.sun,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );
    glow.scale.setScalar(620);
    glow.position.copy(sunDir).multiplyScalar(2000);
    glow.renderOrder = -1;
    this.group.add(glow);

    // Cumulus drift.
    const cloudTexes = [makeCloudTexture(3), makeCloudTexture(11), makeCloudTexture(29)];
    for (let i = 0; i < 26; i++) {
      const tex = cloudTexes[i % cloudTexes.length];
      const mat = new THREE.SpriteMaterial({
        map: tex,
        color: palette.cloud,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        fog: false,
      });
      const s = new THREE.Sprite(mat);
      const ang = (i / 26) * Math.PI * 2 + (i % 5) * 0.31;
      const rad = 900 + (i % 7) * 150;
      const hgt = 360 + (i % 4) * 120;
      const offset = new THREE.Vector3(Math.cos(ang) * rad, hgt, Math.sin(ang) * rad);
      const scale = 380 + (i % 6) * 110;
      s.scale.set(scale * 1.6, scale, 1);
      this.clouds.push({ sprite: s, speed: 4 + (i % 5) * 1.5, offset });
      this.group.add(s);
    }

    scene.add(this.group);
  }

  update(_dt: number, t: number) {
    // Sky follows the camera; clouds drift slowly across it.
    this.group.position.copy(this.camera.position);
    for (const c of this.clouds) {
      // offset is fixed; drift X to read as a slow wind across the sky
      const drift = (t * c.speed) % 3000;
      c.sprite.position.set(c.offset.x + drift - 1500, c.offset.y, c.offset.z);
    }
  }
}
