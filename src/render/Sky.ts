import * as THREE from 'three/webgpu';
import { palette } from './palette';
import { makeGlowTexture, makeCloudTexture } from './textures';
import { SUN_DIR } from '../config';

// A gradient sky dome + sun glow + a drift of soft cumulus. The whole rig
// follows the camera so the horizon is effectively infinite.

const sunDir = new THREE.Vector3(...SUN_DIR).normalize();

// Per-cloud state. `home` is the rest position on the camera-centred dome; the
// live position is derived from `home` + drift + a slow bob/breath so the rig
// is allocation-free every frame. `warm` precomputes how near the sun each
// cloud sails (0 = far, 1 = right in front of the sun) for a happy golden kiss.
interface Cloud {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  speed: number; // horizontal drift (world units / s)
  home: THREE.Vector3; // rest position relative to the camera
  baseW: number; // sprite width at rest
  baseH: number; // sprite height at rest
  bobAmp: number; // vertical bob amplitude
  bobPhase: number; // bob/breath phase offset
  breath: number; // opacity+scale breathing depth
  baseOpacity: number; // opacity at rest
  warm: number; // 0..1 proximity to the sun azimuth (golden tint)
}

// Horizontal span the clouds recycle across. A cloud that drifts past +SPAN/2
// wraps seamlessly back to -SPAN/2, so the procession never visibly pops.
const CLOUD_SPAN = 4200;
const CLOUD_COUNT = 26;

export class Sky {
  private camera: THREE.Camera;
  private group = new THREE.Group();
  private clouds: Cloud[] = [];
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

    // --- Cumulus drift -------------------------------------------------------
    // A loose procession of soft cumulus on a camera-centred ring. Each cloud
    // carries its own drift speed, bob and breathing phase, and a precomputed
    // warmth from sailing near the sun azimuth (golden-rimmed clouds — the
    // happy-day cue). Per-cloud state is fixed here; update() is allocation-free.
    const cloudTexes = [makeCloudTexture(3), makeCloudTexture(11), makeCloudTexture(29)];
    // Sun azimuth (XZ heading toward the sun) — clouds crossing this glow warm.
    const sunAzX = sunDir.x;
    const sunAzZ = sunDir.z;
    const sunAzLen = Math.hypot(sunAzX, sunAzZ) || 1;
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const tex = cloudTexes[i % cloudTexes.length];
      const baseOpacity = 0.84 + (i % 5) * 0.03; // 0.84..0.96
      const mat = new THREE.SpriteMaterial({
        map: tex,
        color: palette.cloud.clone(), // cloned: warmed per-cloud below
        transparent: true,
        opacity: baseOpacity,
        depthWrite: false,
        fog: false,
      });

      const ang = (i / CLOUD_COUNT) * Math.PI * 2 + (i % 5) * 0.31;
      const rad = 900 + (i % 7) * 150;
      const hgt = 360 + (i % 4) * 120;
      const home = new THREE.Vector3(Math.cos(ang) * rad, hgt, Math.sin(ang) * rad);

      // Warmth: how aligned this cloud's bearing is with the sun azimuth (0..1).
      const bx = Math.cos(ang), bz = Math.sin(ang);
      const align = THREE.MathUtils.clamp((bx * sunAzX + bz * sunAzZ) / sunAzLen, 0, 1);
      const warm = align * align; // tighten so only near-sun clouds catch gold
      // Bake the steady golden rim straight into the sprite tint; the additive
      // sun glow behind also licks their edges, so this stays subtle.
      mat.color.copy(palette.cloud).lerp(palette.sun, warm * 0.35);

      const s = new THREE.Sprite(mat);
      const baseW = (380 + (i % 6) * 110) * 1.6;
      const baseH = 380 + (i % 6) * 110;
      s.scale.set(baseW, baseH, 1);

      this.clouds.push({
        sprite: s,
        mat,
        speed: 4 + (i % 5) * 1.5,
        home,
        baseW,
        baseH,
        bobAmp: 8 + (i % 4) * 6,
        bobPhase: i * 1.37,
        breath: 0.04 + (i % 3) * 0.015,
        baseOpacity,
        warm,
      });
      this.group.add(s);
    }

    scene.add(this.group);
  }

  update(_dt: number, t: number) {
    // Sky follows the camera; clouds drift slowly across it.
    this.group.position.copy(this.camera.position);

    // Sun glow breathes — a slow, shallow swell so the light feels alive, not a
    // flat decal. Cheap: one sin drives both scale and the additive opacity.
    const pulse = Math.sin(t * 0.35);
    this.glow.scale.setScalar(560 + pulse * 24);
    (this.glow.material as THREE.SpriteMaterial).opacity = 0.92 + pulse * 0.06;

    for (const c of this.clouds) {
      // Seamless recycle: drift along X and wrap within a band centred on the
      // home X, so a cloud leaving one side re-enters the other with no pop.
      const span = CLOUD_SPAN;
      const phase = (c.home.x + t * c.speed + span * 0.5) % span;
      const x = (phase < 0 ? phase + span : phase) - span * 0.5;

      // Slow vertical bob + a paired scale/opacity breath, each on its own phase
      // so the sky never pulses in unison — a living painting, not a metronome.
      const bob = Math.sin(t * 0.12 + c.bobPhase);
      const breathe = Math.sin(t * 0.09 + c.bobPhase * 0.7);
      c.sprite.position.set(x, c.home.y + bob * c.bobAmp, c.home.z);
      const k = 1 + breathe * c.breath;
      c.sprite.scale.set(c.baseW * k, c.baseH * k, 1);
      c.mat.opacity = c.baseOpacity + breathe * 0.05;
    }
  }
}
