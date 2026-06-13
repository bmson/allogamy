// Keyboard flight input. Later milestones add an iPhone-gyro source that writes
// the same fields, so the flight controller stays input-agnostic.

export class Input {
  left = false;
  right = false;
  up = false; // nose up / climb
  down = false; // nose down / dive

  constructor() {
    window.addEventListener('keydown', (e) => this.set(e.code, true));
    window.addEventListener('keyup', (e) => this.set(e.code, false));
    // Stop arrow keys scrolling the page.
    window.addEventListener('keydown', (e) => {
      if (e.code.startsWith('Arrow')) e.preventDefault();
    });
  }

  private set(code: string, v: boolean) {
    switch (code) {
      case 'ArrowLeft': case 'KeyA': this.left = v; break;
      case 'ArrowRight': case 'KeyD': this.right = v; break;
      case 'ArrowUp': case 'KeyW': this.up = v; break;
      case 'ArrowDown': case 'KeyS': this.down = v; break;
    }
  }
}
