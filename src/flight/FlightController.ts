import * as THREE from 'three/webgpu';
import { ControlSource } from './PhoneControl';
import { TerrainField } from '../world/TerrainField';

// Weighty banking flight. Tilt (roll) banks the bird into a turn; pitch climbs
// or dives and trades for speed. Everything eases toward its target so the
// motion has inertia and never snaps — the bird should feel heavy and gliding.
//
// The controller owns the flight state and drives a chase camera. Later the bird
// mesh is parented to `position`/`orientation` and the camera trails it.

const UP = new THREE.Vector3(0, 1, 0);
const MAX_ROLL = 0.62;
const MAX_PITCH = 0.42;
const MIN_CLEARANCE = 42;
const SOFT_FLOOR_CLEARANCE = 74;
const SOFT_CEILING_CLEARANCE = 220;
const MAX_CLEARANCE = 285;

export class FlightController {
  readonly position = new THREE.Vector3(0, 150, 30);
  readonly forward = new THREE.Vector3(0, 0, 1);
  /** Smoothed flight angles, exposed so the bird mesh can match the bank/pitch. */
  yaw = 0;
  pitch = 0;
  roll = 0;

  private camera: THREE.PerspectiveCamera;
  private source: ControlSource;
  private field: TerrainField;
  private baseSpeed = 48;
  private camPos = new THREE.Vector3(0, 156, 14);
  private lookTarget = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  /** Eased lateral camera swing — slides out to a profile view through turns. */
  private swing = 0;
  /** Smoothed turn rate (yaw velocity), used to lead the framing into a turn. */
  private turnLead = 0;
  /** Smoothed pitch, drives a subtle dolly/FOV speed cue on dives & climbs. */
  private speedCue = 0;
  /** Eased FOV so the dive widening / climb easing never snaps. */
  private fov = 0;
  /** Free-running clock for the gentle idle breathing. */
  private clock = 0;

  constructor(camera: THREE.PerspectiveCamera, source: ControlSource, field: TerrainField) {
    this.camera = camera;
    this.source = source;
    this.field = field;
  }

  /** Hot-swap the active input source (keyboard ↔ phone gyro) without rebuilding. */
  setSource(source: ControlSource) {
    this.source = source;
  }

  update(dt: number) {
    // Continuous flight intent from whatever source is active (keyboard or phone gyro).
    const c = this.source.read();
    const targetRoll = -c.roll * MAX_ROLL; // bank INTO the turn (the tilt was inverted)
    let targetPitch = c.pitch * MAX_PITCH;

    // Keep the bird in a comfortable flight band before it reaches a hard bound.
    // The old ground check let it dive down to terrain+24 and then snapped upward,
    // which read as a bounce. These guards bend the input away from the floor/sky
    // early, while the hard clamp below is only a last-resort safety rail.
    const currentGround = this.field.height(this.position.x, this.position.z);
    const clearance = this.position.y - currentGround;
    if (clearance < SOFT_FLOOR_CLEARANCE) {
      const lift = 1 - THREE.MathUtils.clamp(
        (clearance - MIN_CLEARANCE) / (SOFT_FLOOR_CLEARANCE - MIN_CLEARANCE),
        0, 1,
      );
      targetPitch = Math.max(targetPitch, THREE.MathUtils.lerp(0.04, 0.18, lift));
    } else if (clearance > SOFT_CEILING_CLEARANCE) {
      const descend = THREE.MathUtils.clamp(
        (clearance - SOFT_CEILING_CLEARANCE) / (MAX_CLEARANCE - SOFT_CEILING_CLEARANCE),
        0, 1,
      );
      targetPitch = Math.min(targetPitch, THREE.MathUtils.lerp(-0.04, -0.18, descend));
    }

    // Ease toward targets — this is where the "weight" lives.
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 2.1);
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 1.7);

    // Banking turn: the more the bird is rolled, the faster it yaws. Sign flipped in
    // lockstep with the bank above so the TURN DIRECTION is unchanged — only the tilt
    // now leans correctly into the turn.
    this.yaw -= this.roll * 0.95 * dt;

    // Heading from yaw + pitch.
    const cp = Math.cos(this.pitch);
    this.forward.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp).normalize();

    // Energy trade, ASYMMETRIC: a dive trades altitude for real speed (strong
    // accel), but a climb only bleeds gently — a powerful soaring bird carries its
    // momentum UP the slope rather than mushing into a stall. Diving (pitch < 0)
    // keeps the old steep -0.85 gain; climbing (pitch > 0) uses a much milder 0.22
    // bleed, and the whole thing is held above a healthy floor so a sustained climb
    // never feels like it's slowing to a crawl.
    const trade = this.pitch < 0 ? 0.85 : 0.22; // steep on the dive, gentle on the climb
    const speed = Math.max(this.baseSpeed * 0.72, this.baseSpeed * (1 - this.pitch * trade));
    this.position.addScaledVector(this.forward, speed * dt);

    // Hard rails: by the time these trigger, the soft guards above are already
    // steering away. Keep them decisive so the bird can never visibly hit terrain
    // or disappear into the high sky.
    const ground = this.field.height(this.position.x, this.position.z);
    const floor = ground + MIN_CLEARANCE;
    if (this.position.y < floor) {
      this.position.y = floor;
      this.pitch = Math.max(this.pitch, 0.05);
    }
    const ceiling = ground + MAX_CLEARANCE;
    if (this.position.y > ceiling) {
      this.position.y = ceiling;
      this.pitch = Math.min(this.pitch, -0.06);
    }

    this.clock += dt;
    this.updateCamera(dt);
  }

  private updateCamera(dt: number) {
    // Horizontal basis relative to the bird's heading: straight behind, and the
    // side (perpendicular) it can swing out along.
    const back = this.tmp.set(-this.forward.x, 0, -this.forward.z).normalize();
    const side = this.tmp2.set(-this.forward.z, 0, this.forward.x).normalize();

    // Through a banked turn the camera swings OUT to one side so we catch the
    // bird's profile and the full wingspread; level out and it falls back to the
    // behind-and-above chase. `swing` eases on its own (slower than the bank)
    // so the camera has real weight — it settles into the side view and drifts
    // back rather than snapping with the controls. Normalised to ~[-1, 1].
    const swingTarget = this.roll / MAX_ROLL;
    this.swing += (swingTarget - this.swing) * (1 - Math.exp(-dt * 2.0));
    const s = this.swing;
    const a = Math.min(1, Math.abs(s));

    // ANTICIPATION: the bank itself (which leads the actual yaw) feeds a slowly
    // eased "turn lead". It rises a touch faster than it settles so the framing
    // commits into a turn just before the heading swings, then unwinds gently.
    const leadTarget = this.roll / MAX_ROLL;
    const leadEase = leadTarget * leadTarget > this.turnLead * this.turnLead ? 2.4 : 1.5;
    this.turnLead += (leadTarget - this.turnLead) * (1 - Math.exp(-dt * leadEase));

    // SPEED CUE: smoothed pitch. A dive (pitch < 0) eases the camera back and
    // widens the lens a hair for a sense of rushing speed; a climb pulls in and
    // narrows slightly. Heavily smoothed so it breathes rather than pumps.
    this.speedCue += (this.pitch / MAX_PITCH - this.speedCue) * (1 - Math.exp(-dt * 1.4));
    const dive = Math.max(0, -this.speedCue); // 0..1 on dives only
    const climb = Math.max(0, this.speedCue); // 0..1 on climbs only

    // IDLE BREATH: a near-imperceptible bob/drift so the rig feels alive even in
    // dead-level straight flight. Faded out as the bird manoeuvres so it never
    // fights the deliberate swing/lean. Two slightly detuned sines avoid an
    // obvious loop.
    const calm = 1 - Math.max(a, Math.abs(this.speedCue));
    const breath = calm * 0.65;
    const bob = Math.sin(this.clock * 0.62) * 0.9 * breath;
    const sway = Math.sin(this.clock * 0.41 + 1.3) * 0.7 * breath;

    const lateral = s * 18 + sway; // how far around to the side
    const backDist = 16 - a * 7 + dive * 5 - climb * 2.5; // dolly back on dives, in on climbs
    const rise = 9 - a * 2.5 + bob; // drop a touch for a flatter, more dramatic angle

    this.camPos.copy(this.position)
      .addScaledVector(back, backDist)
      .addScaledVector(side, lateral)
      .addScaledVector(UP, rise);
    const k = 1 - Math.exp(-dt * 3.6);
    this.camera.position.lerp(this.camPos, k);

    // Aim closer to the bird as we swing aside so it stays centred in frame, and
    // LEAD the look target sideways toward where the bird is turning so the frame
    // anticipates the new heading rather than chasing it.
    const ahead = 18 - a * 11;
    this.lookTarget.copy(this.position)
      .addScaledVector(this.forward, ahead)
      .addScaledVector(side, this.turnLead * 7);
    this.camera.up.copy(UP);
    this.camera.lookAt(this.lookTarget);

    // SPEED FOV: widen on a dive, ease slightly tighter on a climb — eased on its
    // own line so it can never snap. Base FOV is whatever the camera was built with.
    const fovTarget = dive * 6 - climb * 2;
    this.fov += (fovTarget - this.fov) * (1 - Math.exp(-dt * 2.0));
    const baseFov = (this.camera as THREE.PerspectiveCamera & { baseFov?: number }).baseFov
      ?? ((this.camera as THREE.PerspectiveCamera & { baseFov?: number }).baseFov = this.camera.fov);
    this.camera.fov = baseFov + this.fov;
    this.camera.updateProjectionMatrix();

    // Lean the camera into the bank for that swooping feel.
    this.camera.rotateZ(this.roll * 0.5);
  }
}
