import { Engine, Updatable } from './core/Engine';
import { Input } from './core/Input';
import { KeyboardControlSource, GyroControlSource } from './flight/PhoneControl';
import { TerrainField } from './world/TerrainField';
import { World } from './world/World';
import { FlightController } from './flight/FlightController';
import { Bird } from './flight/Bird';
import { Sky } from './render/Sky';
import { Controls } from './ui/Controls';
import { WORLD_SEED } from './config';

async function main() {
  const engine = new Engine();
  await engine.init();

  // Live-tuning dev panel (hidden behind the gear button / backtick key). Built
  // after init so it can reach engine.sun / engine.hemi / engine.scene.fog.
  new Controls(engine);

  const field = new TerrainField(WORLD_SEED);
  // Keyboard is the DEFAULT control source and always works (desktop). The phone
  // gyro is an opt-in source you swap to with the "fly with phone" button.
  const input = new Input();
  const keyboard = new KeyboardControlSource(input);
  const flight = new FlightController(engine.camera, keyboard, field);
  setupPhoneControl(flight, keyboard);
  const bird = new Bird(engine.scene, flight);
  const world = new World(engine.scene, field);
  const sky = new Sky(engine.scene, engine.camera);

  // Seed the camera near the start so the first frames look composed.
  engine.camera.position.set(0, 158, 12);

  const overlay = document.getElementById('overlay');
  const hud = document.getElementById('hud');
  let revealed = false;

  // Update order: fly → stream world → drift sky → reveal when ready.
  engine.add(flight);
  engine.add(bird); // ticks right after flight so it reads current position/angles
  engine.add(adapt((_dt, t) => {
    world.update(flight.position);
    world.tickGeneration(3);
    world.tickFauna(t);
  }));
  engine.add(sky);
  engine.add(adapt(() => {
    if (!revealed && world.ready()) {
      revealed = true;
      overlay?.classList.add('hidden');
      hud?.classList.add('show');
    }
  }));

  engine.start();
}

/** Wrap a thunk as an Updatable. */
function adapt(fn: (dt: number, t: number) => void): Updatable {
  return { update: fn };
}

/**
 * Wire the "fly with phone" button: tap to hand control to the phone's gyroscope
 * (requests sensor permission on a user gesture, then captures a neutral "level"
 * pose), tap again to return to the keyboard. The keyboard always stays available —
 * the phone is purely additive, so desktop flying is never affected.
 */
function setupPhoneControl(flight: FlightController, keyboard: KeyboardControlSource) {
  const btn = document.getElementById('phone-btn');
  if (!btn) return;
  let gyro: GyroControlSource | null = null;
  let onPhone = false;
  btn.addEventListener('click', async () => {
    if (!onPhone) {
      if (!gyro) gyro = new GyroControlSource();
      const ok = await gyro.requestPermission(); // iOS permission prompt (needs this gesture)
      if (!ok) {
        btn.textContent = 'no gyro here';
        setTimeout(() => { btn.textContent = 'fly with phone'; }, 1800);
        return;
      }
      gyro.calibrate(); // capture the current hold as "level"
      flight.setSource(gyro);
      onPhone = true;
      btn.textContent = 'use keyboard';
      btn.classList.add('on');
    } else {
      flight.setSource(keyboard);
      onPhone = false;
      btn.textContent = 'fly with phone';
      btn.classList.remove('on');
    }
  });
}

main().catch((e) => {
  console.error(e);
  const err = document.getElementById('err');
  const sub = document.querySelector('#overlay .sub') as HTMLElement | null;
  if (sub) sub.textContent = 'could not start';
  if (err) {
    err.style.display = 'block';
    err.textContent = String(e?.stack || e?.message || e);
  }
});
