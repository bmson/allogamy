import * as THREE from 'three/webgpu';
import { palette } from './palette';
import { makeGlowTexture } from './textures';
import { SUN_DIR } from '../config';
import { makeVolumetricClouds, VolumetricClouds } from '../world/volumetricClouds';

// A gradient sky dome + sun glow + a raymarched VOLUMETRIC cloud layer. The whole
// rig follows the camera so the horizon is effectively infinite. The clouds are a
// fbm density field raymarched on a camera-centred dome (see volumetricClouds.ts),
// sitting between the gradient dome and the sun glow so the horizon/fog reads
// beneath them and the sun still pools its light in front.

const sunDir = new THREE.Vector3(...SUN_DIR).normalize();

export class Sky {
  private camera: THREE.Camera;
  private group = new THREE.Group();
  private clouds: VolumetricClouds;
  private glow: THREE.Sprite;

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.camera = camera;

    // --- Dome gradient -------------------------------------------------------
    // Ported from 6.html's skyFrag but enriched into a clear, happy-day curve and
    // baked per-vertex (linear colours) so the dome stays one cheap MeshBasic draw
    // with no custom shader. dir is the normalized vertex position (= view
    // direction on a camera-centred sphere). Three things layer in here:
    //   1. a horizon→zenith blend whose curve is eased so the overhead blue reads
    //      deep and saturated while the band near the horizon stays wide and pale;
    //   2. a soft clear-sky "lift" just above the horizon (the luminous glow real
    //      skies get from forward scatter) so the seam between sky and land sings;
    //   3. a two-lobe sun aureole — a tight warm core plus a broad warm wash — so
    //      the sky genuinely pools light toward the sun instead of a hard hotspot.
    // 40x24 segments: the gradient is smooth enough that the coarser tessellation
    // is indistinguishable from 48x32 while shaving ~40% of the dome's vertices.
    const geo = new THREE.SphereGeometry(2400, 40, 24);
    const posAttr = geo.attributes.position;
    const n = posAttr.count;
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    const dir = new THREE.Vector3();
    // Warm sun tints, authored in the same linear space as the palette. The core
    // is the hot golden pool right at the sun; the wash is a fainter, far broader
    // warm bloom that carries across much of the sky on a clear day.
    const sunCore = new THREE.Color(1.0, 0.82, 0.52).multiplyScalar(0.42);
    const sunWash = new THREE.Color(1.0, 0.93, 0.78).multiplyScalar(0.12);
    // Horizon lift: nudge the band just above the horizon toward the pale horizon
    // tone so the sky brightens into the land rather than meeting it on a line.
    const horizonLift = palette.skyHorizon;
    for (let i = 0; i < n; i++) {
      dir.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).normalize();

      // Eased vertical blend. The raw smoothstep band is biased with a gentle
      // gamma (>1) so most of the dome carries the deep zenith blue and the pale
      // horizon is held to a tighter ring — a crisper, more saturated clear day.
      const band = THREE.MathUtils.smoothstep(dir.y, -0.18, 0.62);
      const t = band * band * (3 - 2 * band); // extra smootherstep ease
      c.copy(palette.skyHorizon).lerp(palette.skyZenith, t);

      // Soft glow just above the horizon (peaks ~6° up, fades by ~25°). Additive
      // toward the pale horizon tone — the airy forward-scatter brightening.
      const lift = Math.max(0, 1 - Math.abs(dir.y - 0.1) / 0.32);
      const liftAmt = lift * lift * 0.16;

      // Two-lobe sun aureole. Both lobes key off the view-to-sun alignment; the
      // core is tight (high power), the wash is broad (low power) and clamped to
      // the sky hemisphere so it never bleeds warmth into the ground-facing dome.
      const align = Math.max(dir.dot(sunDir), 0);
      const core = align * align * align * align * align; // ~pow 5, tight
      const wash = align * align * Math.max(dir.y + 0.1, 0); // broad, sky-only

      col[i * 3] = c.r + (horizonLift.r - c.r) * liftAmt + sunCore.r * core + sunWash.r * wash;
      col[i * 3 + 1] = c.g + (horizonLift.g - c.g) * liftAmt + sunCore.g * core + sunWash.g * wash;
      col[i * 3 + 2] = c.b + (horizonLift.b - c.b) * liftAmt + sunCore.b * core + sunWash.b * wash;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // The dome only needs position + colour; drop the normals/uv the sphere ships
    // with so the GPU uploads a leaner buffer.
    geo.deleteAttribute('normal');
    geo.deleteAttribute('uv');
    const dome = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }),
    );
    dome.renderOrder = -2;
    this.group.add(dome);

    // --- Sun glow ------------------------------------------------------------
    // A bright additive aureole at the sun. The shared glow texture is layered
    // twice — a smaller hot core sprite over a larger soft halo — for a luminous
    // sun that reads as light rather than a flat disc. Both pulse together with a
    // very slow, very shallow breath (animated in update()).
    const glowTex = makeGlowTexture();
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        color: palette.sun,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );
    halo.scale.setScalar(1020);
    halo.position.copy(sunDir).multiplyScalar(2000);
    halo.renderOrder = -1;
    this.group.add(halo);

    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        color: palette.sun,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );
    glow.scale.setScalar(560);
    glow.position.copy(sunDir).multiplyScalar(2000);
    glow.renderOrder = -1;
    this.group.add(glow);
    this.glow = glow;

    // --- Live clouds ---------------------------------------------------------
    // A field of soft-cumulus BILLBOARDS the bird flies through — a faithful port
    // of the reference CodePen's layered cloud-sprite technique (see
    // volumetricClouds.ts). Unlike the gradient dome and sun glow, this layer lives
    // in WORLD space (added to the scene, NOT the camera-following group): the puffs
    // sit at real world positions and recycle around the bird, so flying through
    // them gives true parallax. Rendered at order -1 (over the gradient dome at -2,
    // under the solid world at 0) so terrain and the bird occlude the clouds.
    this.clouds = makeVolumetricClouds();
    scene.add(this.clouds.mesh);

    scene.add(this.group);
  }

  update(dt: number, t: number) {
    // Sky follows the camera; the cloud dome rides with it so the layer is
    // effectively infinite (the drift happens inside the noise field, not by
    // moving the dome — see volumetricClouds.ts).
    this.group.position.copy(this.camera.position);

    // Sun glow breathes — a slow, shallow swell so the light feels alive, not a
    // flat decal. Cheap: one sin drives both scale and the additive opacity.
    const pulse = Math.sin(t * 0.35);
    this.glow.scale.setScalar(560 + pulse * 24);
    (this.glow.material as THREE.SpriteMaterial).opacity = 0.92 + pulse * 0.06;

    // Advance the cloud field: drift on the wind + recycle puffs around the bird.
    this.clouds.update(dt, t, this.camera.position);
  }
}
