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

    // Dome: vertical sRGB gradient horizon → zenith.
    const geo = new THREE.SphereGeometry(2400, 32, 20);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const y = geo.attributes.position.getY(i) / 2400;
      // Bring the blue DOWN into the visible band: a thin warm horizon (for the
      // hazed hills to dissolve into) climbs quickly to a luminous sky, so a
      // low-angle flying view shows real gradient instead of a flat beige wall.
      const t = THREE.MathUtils.smoothstep(y, 0.0, 0.34);
      c.copy(palette.skyHorizon).lerp(palette.skyZenith, t);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
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
