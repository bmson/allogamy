import { Engine, Updatable } from './core/Engine';
import { Input } from './core/Input';
import { TerrainField } from './world/TerrainField';
import { World } from './world/World';
import { FlightController } from './flight/FlightController';
import { Bird } from './flight/Bird';
import { Sky } from './render/Sky';
import { WORLD_SEED } from './config';

async function main() {
  const engine = new Engine();
  await engine.init();

  const field = new TerrainField(WORLD_SEED);
  const input = new Input();
  const flight = new FlightController(engine.camera, input, field);
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
  engine.add(adapt(() => {
    world.update(flight.position);
    world.tickGeneration(3);
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
function adapt(fn: () => void): Updatable {
  return { update: fn };
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
