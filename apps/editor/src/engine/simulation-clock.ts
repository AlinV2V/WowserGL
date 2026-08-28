import type { EditorApp } from '../editor-app';

export class StudioSimulationClock extends EventTarget {
  paused = false;
  frame = 0;
  elapsed = 0;
  private last = performance.now();
  private raf = 0;

  constructor(private readonly app: EditorApp, root: HTMLElement) {
    super();
    const pause = root.querySelector<HTMLButtonElement>('[data-pause]')!;
    const step = root.querySelector<HTMLButtonElement>('[data-step]')!;
    pause.title = 'Pause / resume Studio simulation previews';
    step.title = 'Advance Studio simulation previews by one 1/60s step';
    pause.addEventListener('click', () => {
      this.paused = !this.paused;
      pause.classList.toggle('active', this.paused);
      this.app.bottomPanel.log({ level: 'info', message: this.paused ? 'Studio simulation preview paused.' : 'Studio simulation preview resumed.', time: new Date() });
      this.dispatchEvent(new CustomEvent('pause', { detail: this.paused }));
    });
    step.addEventListener('click', () => {
      this.paused = true;
      pause.classList.add('active');
      this.advance(1 / 60, true);
    });
    this.loop();
  }

  dispose() { cancelAnimationFrame(this.raf); }

  private loop = () => {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (!this.paused) this.advance(dt, false);
    this.raf = requestAnimationFrame(this.loop);
  };

  private advance(dt: number, stepped: boolean) {
    this.frame++;
    this.elapsed += dt;
    this.dispatchEvent(new CustomEvent('tick', { detail: { dt, elapsed: this.elapsed, frame: this.frame, stepped } }));
  }
}
