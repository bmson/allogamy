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
    const targetPitch = c.pitch * MAX_PITCH;

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

    // Never sink into the ground; ease the nose back up if we bottom out.
    const floor = this.field.height(this.position.x, this.position.z) + 24;
    if (this.position.y < floor) {
      this.position.y = floor;
      this.pitch += (0.12 - this.pitch) * Math.min(1, dt * 3);
    }
    if (this.position.y > 920) this.position.y = 920;

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

    const lateral = s * 18; // how far around to the side
    const backDist = 16 - a * 7; // pull in as we come around so the bird stays framed
    const rise = 9 - a * 2.5; // drop a touch for a flatter, more dramatic angle

    this.camPos.copy(this.position)
      .addScaledVector(back, backDist)
      .addScaledVector(side, lateral)
      .addScaledVector(UP, rise);
    const k = 1 - Math.exp(-dt * 3.6);
    this.camera.position.lerp(this.camPos, k);

    // Aim closer to the bird as we swing aside so it stays centred in frame.
    const ahead = 18 - a * 11;
    this.lookTarget.copy(this.position).addScaledVector(this.forward, ahead);
    this.camera.up.copy(UP);
    this.camera.lookAt(this.lookTarget);
    // Lean the camera into the bank for that swooping feel.
    this.camera.rotateZ(this.roll * 0.5);
  }
}
