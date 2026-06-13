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
    const MAX_ROLL = 0.62;
    const MAX_PITCH = 0.42;
    const targetRoll = c.roll * MAX_ROLL;
    const targetPitch = c.pitch * MAX_PITCH;

    // Ease toward targets — this is where the "weight" lives.
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 2.1);
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 1.7);

    // Banking turn: the more the bird is rolled, the faster it yaws.
    this.yaw += this.roll * 0.95 * dt;

    // Heading from yaw + pitch.
    const cp = Math.cos(this.pitch);
    this.forward.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp).normalize();

    // Dive accelerates, climb bleeds speed.
    const speed = this.baseSpeed * (1 - this.pitch * 0.85);
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
    // Trail behind and above, smoothed for a floating feel. Raised and aimed
    // closer so the bird is framed from behind-and-above (wingspan reads).
    const back = this.tmp.set(-this.forward.x, 0, -this.forward.z).normalize();
    this.camPos.copy(this.position).addScaledVector(back, 16).addScaledVector(UP, 9);
    const k = 1 - Math.exp(-dt * 3.6);
    this.camera.position.lerp(this.camPos, k);

    this.lookTarget.copy(this.position).addScaledVector(this.forward, 18);
    this.camera.up.copy(UP);
    this.camera.lookAt(this.lookTarget);
    // Lean the camera into the bank for that swooping feel.
    this.camera.rotateZ(this.roll * 0.5);
  }
}
