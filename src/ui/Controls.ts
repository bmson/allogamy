// Live-tuning dev panel — a collapsible HTML overlay of labelled sliders for the
// high-impact ART knobs. Each slider drives a TSL uniform (shader params) or a
// plain JS property (light intensity / scene.fog) so the running render changes
// IMMEDIATELY with no reload. An "Export defaults" button serializes the current
// values to the clipboard as JSON + a paste-ready code block.
//
// It's an art piece, so the tech stays out of the way: the panel is hidden by
// default behind a small gear button and toggles with the backtick (`) key.
//
// Defaults on load equal the current hard-coded values (seeded in settings.ts),
// so nothing changes visually until a slider is moved.

import type { Engine } from '../core/Engine';
import {
  uGlow, uImpasto, uChroma, uVignette, uBleed, uPaperTex,
  uStrokeBias, uSizeFloor, uWind, uSizeJitter, uAngleJitter,
  uFogNear, uFogFar,
  jsSettings, snapshot,
} from '../core/settings';

// One slider spec. `get` reads the current value (for seeding the slider +
// readout); `set` applies a new value LIVE to its target(s).
interface Knob {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (v: number) => void;
  // Decimals for the on-screen readout (defaults to a sensible guess).
  decimals?: number;
}

interface Group {
  name: string;
  knobs: Knob[];
}

export class Controls {
  private root!: HTMLDivElement;
  private panel!: HTMLDivElement;
  private open = false;

  constructor(private engine: Engine) {
    this.buildStyles();
    this.buildDom();
    window.addEventListener('keydown', (e) => {
      // Backtick toggles the panel. Ignore when typing in an input.
      if (e.key === '`' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  private groups(): Group[] {
    const { engine } = this;
    return [
      {
        name: 'Atmosphere',
        knobs: [
          {
            id: 'fogNear', label: 'fog near', min: 0, max: 3000, step: 10, decimals: 0,
            get: () => uFogNear.value as number,
            set: (v) => {
              uFogNear.value = v;
              jsSettings.fogNear = v;
              if (engine.scene.fog) (engine.scene.fog as any).near = v;
            },
          },
          {
            id: 'fogFar', label: 'fog far', min: 100, max: 4000, step: 10, decimals: 0,
            get: () => uFogFar.value as number,
            set: (v) => {
              uFogFar.value = v;
              jsSettings.fogFar = v;
              if (engine.scene.fog) (engine.scene.fog as any).far = v;
            },
          },
        ],
      },
      {
        name: 'Strokes',
        knobs: [
          {
            id: 'strokeBias', label: 'elongation', min: 0, max: 2, step: 0.01, decimals: 2,
            get: () => uStrokeBias.value as number,
            set: (v) => { uStrokeBias.value = v; },
          },
          {
            id: 'sizeFloor', label: 'size floor', min: 0, max: 0.02, step: 0.0005, decimals: 4,
            get: () => uSizeFloor.value as number,
            set: (v) => { uSizeFloor.value = v; },
          },
          {
            id: 'wind', label: 'wind', min: 0, max: 3, step: 0.05, decimals: 2,
            get: () => uWind.value as number,
            set: (v) => { uWind.value = v; },
          },
          {
            id: 'sizeJitter', label: 'size jitter', min: 0, max: 1, step: 0.01, decimals: 2,
            get: () => uSizeJitter.value as number,
            set: (v) => { uSizeJitter.value = v; },
          },
          {
            id: 'angleJitter', label: 'angle jitter', min: 0, max: 3.14, step: 0.01, decimals: 2,
            get: () => uAngleJitter.value as number,
            set: (v) => { uAngleJitter.value = v; },
          },
        ],
      },
      {
        name: 'Post',
        knobs: [
          {
            id: 'glow', label: 'glow', min: 0, max: 1.5, step: 0.01, decimals: 2,
            get: () => uGlow.value as number,
            set: (v) => { uGlow.value = v; },
          },
          {
            id: 'impasto', label: 'texture', min: 0, max: 1.5, step: 0.01, decimals: 2,
            get: () => uImpasto.value as number,
            set: (v) => { uImpasto.value = v; },
          },
          {
            id: 'chroma', label: 'chroma', min: 0.5, max: 2, step: 0.01, decimals: 2,
            get: () => uChroma.value as number,
            set: (v) => { uChroma.value = v; },
          },
          {
            id: 'vignette', label: 'vignette', min: 0, max: 1, step: 0.01, decimals: 2,
            get: () => uVignette.value as number,
            set: (v) => { uVignette.value = v; },
          },
          {
            id: 'bleed', label: 'bleed', min: 0, max: 1, step: 0.01, decimals: 2,
            get: () => uBleed.value as number,
            set: (v) => { uBleed.value = v; },
          },
          {
            id: 'paperTex', label: 'noise', min: 0, max: 0.8, step: 0.01, decimals: 2,
            get: () => uPaperTex.value as number,
            set: (v) => { uPaperTex.value = v; },
          },
        ],
      },
      {
        name: 'Light',
        knobs: [
          {
            id: 'sunIntensity', label: 'sun', min: 0, max: 6, step: 0.05, decimals: 2,
            get: () => jsSettings.sunIntensity,
            set: (v) => { jsSettings.sunIntensity = v; engine.sun.intensity = v; },
          },
          {
            id: 'hemiIntensity', label: 'sky fill', min: 0, max: 3, step: 0.01, decimals: 2,
            get: () => jsSettings.hemiIntensity,
            set: (v) => { jsSettings.hemiIntensity = v; engine.hemi.intensity = v; },
          },
        ],
      },
    ];
  }

  private buildStyles() {
    if (document.getElementById('tune-style')) return;
    const css = `
      #tune-gear {
        position: fixed; top: 14px; right: 14px; z-index: 20;
        width: 34px; height: 34px; border-radius: 9px; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        font-size: 17px; line-height: 1; color: #3a3046;
        background: rgba(250,246,240,0.78); backdrop-filter: blur(6px);
        border: 1px solid rgba(58,48,70,0.28);
        box-shadow: 0 4px 18px rgba(58,48,70,0.22);
        font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        transition: background 0.15s ease;
      }
      #tune-gear:hover { background: rgba(250,246,240,0.95); }
      #tune-panel {
        position: fixed; top: 56px; right: 14px; z-index: 20;
        width: 232px; max-height: calc(100vh - 80px); overflow-y: auto;
        background: rgba(250,246,240,0.9); backdrop-filter: blur(8px);
        border: 1px solid rgba(58,48,70,0.22); border-radius: 12px;
        padding: 12px 14px; color: #3a3046;
        box-shadow: 0 8px 30px rgba(58,48,70,0.28);
        font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        display: none;
      }
      #tune-panel.open { display: block; }
      #tune-panel h2 {
        margin: 10px 0 6px; font-size: 10px; font-weight: 700;
        letter-spacing: 0.18em; text-transform: uppercase; opacity: 0.55;
      }
      #tune-panel h2:first-child { margin-top: 0; }
      #tune-panel .row {
        display: grid; grid-template-columns: 64px 1fr 38px; align-items: center;
        gap: 7px; margin: 5px 0; font-size: 11px;
      }
      #tune-panel .row label { opacity: 0.85; }
      #tune-panel input[type="range"] { width: 100%; accent-color: #3a3046; }
      #tune-panel .val { text-align: right; opacity: 0.7; font-variant-numeric: tabular-nums; }
      #tune-panel .actions { display: flex; gap: 8px; margin-top: 12px; }
      #tune-panel button {
        flex: 1; font: inherit; font-size: 11px; color: #3a3046; cursor: pointer;
        background: transparent; border: 1px solid rgba(58,48,70,0.32);
        border-radius: 8px; padding: 7px 8px; transition: background 0.15s ease;
      }
      #tune-panel button:hover { background: rgba(58,48,70,0.09); }
      #tune-panel .hint { margin-top: 8px; font-size: 9.5px; opacity: 0.5; line-height: 1.4; }
      #tune-toast {
        position: fixed; top: 56px; right: 256px; z-index: 21;
        background: rgba(58,48,70,0.92); color: #faf6f0;
        font-family: ui-monospace, monospace; font-size: 11px;
        padding: 7px 11px; border-radius: 8px; opacity: 0;
        transition: opacity 0.25s ease; pointer-events: none;
      }
      #tune-toast.show { opacity: 1; }
    `;
    const style = document.createElement('style');
    style.id = 'tune-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  private buildDom() {
    const gear = document.createElement('div');
    gear.id = 'tune-gear';
    gear.title = 'Tuning panel (backtick `)';
    gear.textContent = '⚙'; // gear glyph
    gear.addEventListener('click', () => this.toggle());

    const panel = document.createElement('div');
    panel.id = 'tune-panel';

    for (const group of this.groups()) {
      const h = document.createElement('h2');
      h.textContent = group.name;
      panel.appendChild(h);
      for (const k of group.knobs) {
        panel.appendChild(this.buildRow(k));
      }
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Copy settings';
    exportBtn.addEventListener('click', () => this.exportSettings());
    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', () => this.reset());
    actions.append(exportBtn, resetBtn);
    panel.appendChild(actions);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Stroke density (SPLATS_PER_CHUNK) is baked per chunk and is NOT live — it only applies to newly generated chunks.';
    panel.appendChild(hint);

    document.body.append(gear, panel);
    this.panel = panel;
    this.root = panel;
  }

  // Builds one slider row and wires oninput → live set + readout refresh.
  private buildRow(k: Knob): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'row';

    const label = document.createElement('label');
    label.textContent = k.label;
    label.htmlFor = `tune-${k.id}`;

    const input = document.createElement('input');
    input.type = 'range';
    input.id = `tune-${k.id}`;
    input.min = String(k.min);
    input.max = String(k.max);
    input.step = String(k.step);
    input.value = String(k.get());

    const val = document.createElement('span');
    val.className = 'val';
    const dec = k.decimals ?? 2;
    const fmt = (v: number) => v.toFixed(dec);
    val.textContent = fmt(k.get());

    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      k.set(v);
      val.textContent = fmt(v);
    });

    row.append(label, input, val);
    return row;
  }

  private toggle() {
    this.open = !this.open;
    this.panel.classList.toggle('open', this.open);
  }

  // Re-seed every slider + readout from the current live values (used after
  // Reset, which writes the defaults back through each knob's setter).
  private reset() {
    for (const group of this.groups()) {
      for (const k of group.knobs) {
        // Restore the seeded default by reading the snapshot key.
        const def = (DEFAULTS as unknown as Record<string, number>)[k.id];
        if (def !== undefined) k.set(def);
        const input = document.getElementById(`tune-${k.id}`) as HTMLInputElement | null;
        if (input) {
          input.value = String(k.get());
          const valEl = input.parentElement?.querySelector('.val');
          if (valEl) valEl.textContent = (k.get()).toFixed(k.decimals ?? 2);
        }
      }
    }
    this.toast('Reset to defaults');
  }

  // Serialize the CURRENT values and copy to the clipboard as a JSON object PLUS
  // a paste-ready JS block the user can drop into settings.ts / config.ts.
  private async exportSettings() {
    const s = snapshot();
    const json = JSON.stringify(s, null, 2);

    const block = [
      '// === Allogamy tuned defaults — paste into the source listed per line ===',
      '// src/core/settings.ts uniforms:',
      `export const uGlow = uniform(${s.glow});        // post.ts glow`,
      `export const uImpasto = uniform(${s.impasto});     // post.ts texture/relief`,
      `export const uChroma = uniform(${s.chroma});      // post.ts grade chroma`,
      `export const uVignette = uniform(${s.vignette});    // post.ts vignette`,
      `export const uStrokeBias = uniform(${s.strokeBias});  // SplatMaterial elongation bias`,
      `export const uSizeFloor = uniform(${s.sizeFloor});  // SplatMaterial distance size-floor`,
      `export const uWind = uniform(${s.wind});        // wind strength (or set config.WIND_STRENGTH)`,
      `export const uFogNear = uniform(${s.fogNear});      // fog near (or set config.FOG_NEAR)`,
      `export const uFogFar = uniform(${s.fogFar});       // fog far  (or set config.FOG_FAR)`,
      `export const uBleed = uniform(${s.bleed});       // post.ts oil-paint bleed`,
      `export const uPaperTex = uniform(${s.paperTex});    // post.ts canvas/paper noise grain`,
      `export const uSizeJitter = uniform(${s.sizeJitter});   // SplatMaterial per-stamp size jitter`,
      `export const uAngleJitter = uniform(${s.angleJitter});  // SplatMaterial per-stamp angle jitter`,
      '// src/core/settings.ts jsSettings (+ mirror in config.ts / Engine.ts):',
      `//   sunIntensity:  ${s.sunIntensity}   // Engine.ts DirectionalLight intensity`,
      `//   hemiIntensity: ${s.hemiIntensity}  // Engine.ts HemisphereLight intensity`,
      `//   FOG_NEAR = ${s.fogNear}; FOG_FAR = ${s.fogFar};  // config.ts`,
      `//   WIND_STRENGTH = ${s.wind};  // config.ts`,
      '',
      '/* JSON */',
      json,
    ].join('\n');

    try {
      await navigator.clipboard.writeText(block);
      this.toast('Settings copied to clipboard');
    } catch {
      // Clipboard API can fail without a user gesture / on insecure origins.
      console.log('[allogamy] tuned settings:\n' + block);
      this.toast('Clipboard blocked — logged to console');
    }
  }

  private toastEl: HTMLDivElement | null = null;
  private toastTimer = 0;
  private toast(msg: string) {
    if (!this.toastEl) {
      this.toastEl = document.createElement('div');
      this.toastEl.id = 'tune-toast';
      document.body.appendChild(this.toastEl);
    }
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl?.classList.remove('show');
    }, 1600);
  }
}

// Default values captured at module-load = the current hard-coded look. Used by
// the Reset button so it restores the original art without a reload.
const DEFAULTS = snapshot();
