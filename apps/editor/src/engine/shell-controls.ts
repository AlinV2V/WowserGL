import type { EditorApp } from '../editor-app';
import type { DebugViewController, DebugViewMode } from './debug-views';

const SHADING: DebugViewMode[] = ['shaded', 'wireframe', 'unlit', 'overdraw'];

export class StudioShellControls {
  private gizmosVisible = true;
  private help: HTMLElement;

  constructor(private readonly app: EditorApp, private readonly root: HTMLElement, private readonly debug: DebugViewController) {
    this.help = this.createHelp();
    this.bindMenus();
    this.bindViewportControls();
    this.bindBridgeBadge();
    this.bindProjectHome();
    this.bindLegacyCardToggles();
    this.removeUnsupportedDecorativeButtons();
    this.correctTooltips();
  }

  private bindMenus() {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-menu]')) {
      button.title = this.menuTitle(button.dataset.menu ?? '');
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        switch (button.dataset.menu) {
          case 'file':
            this.root.querySelector<HTMLInputElement>('[data-import-file]')?.click();
            break;
          case 'edit':
            if (event.shiftKey) this.app.history.redo(); else this.app.history.undo();
            break;
          case 'assets':
            this.openGlobalAssets('all');
            break;
          case 'gameobject': {
            if (!this.app.store.selected) {
              this.app.bottomPanel.log({ level: 'warn', message: 'Select a scene object before adding a component.', time: new Date() });
              break;
            }
            const input = this.root.querySelector<HTMLInputElement>('.add-component-row.searchable input');
            input?.focus();
            input?.select();
            break;
          }
          case 'window':
            this.root.querySelector<HTMLButtonElement>('[data-engine-tab="profiler"]')?.click();
            break;
          case 'help':
            this.help.hidden = false;
            this.help.querySelector<HTMLButtonElement>('[data-studio-help-close]')?.focus();
            break;
        }
      }, { capture: true });
    }
  }

  private menuTitle(menu: string) {
    if (menu === 'file') return 'Import custom_map_patch.json';
    if (menu === 'edit') return 'Undo · Shift-click to redo';
    if (menu === 'assets') return 'Open the global CleanClientMMO Content Browser';
    if (menu === 'gameobject') return 'Focus Add Component for the current selection';
    if (menu === 'window') return 'Open the Profiler window';
    if (menu === 'help') return 'Studio controls and runtime workflow';
    return '';
  }

  private bindViewportControls() {
    const overlayButtons = [...this.root.querySelectorAll<HTMLButtonElement>('.scene-overlay-left button')];
    const shading = overlayButtons[0];
    const twoD = overlayButtons[1];
    const audio = overlayButtons[2];

    if (shading) {
      shading.dataset.shellControl = 'shading';
      shading.title = 'Cycle Scene debug shading: Shaded → Wireframe → Unlit → Overdraw';
      shading.addEventListener('click', () => {
        const index = SHADING.indexOf(this.debug.mode);
        const mode = SHADING[(index + 1) % SHADING.length];
        this.debug.setMode(mode);
        shading.textContent = `${mode[0].toUpperCase()}${mode.slice(1)} ▾`;
      });
      this.debug.addEventListener('change', () => {
        const mode = this.debug.mode;
        shading.textContent = `${mode[0].toUpperCase()}${mode.slice(1)} ▾`;
      });
    }

    if (twoD) {
      twoD.dataset.shellControl = '2d';
      twoD.title = 'Toggle orthographic top-down Scene view';
      twoD.addEventListener('click', () => {
        const active = this.app.camera.toggleTopDown();
        twoD.classList.toggle('active', active);
        this.root.querySelector<HTMLButtonElement>('[data-top]')?.classList.toggle('active', active);
      });
    }

    if (audio) {
      audio.dataset.shellControl = 'audio-assets';
      audio.textContent = 'Audio Assets';
      audio.title = 'Open indexed CleanClientMMO audio assets';
      audio.addEventListener('click', () => this.openGlobalAssets('audio'));
    }

    const gizmos = this.root.querySelector<HTMLButtonElement>('[data-gizmos]');
    gizmos?.addEventListener('click', () => {
      this.gizmosVisible = !this.gizmosVisible;
      this.app.gizmo.helper.visible = this.gizmosVisible;
      const worldTools = this.app.scene.getObjectByName('__studio_world_tools');
      if (worldTools) worldTools.visible = this.gizmosVisible;
      gizmos.classList.toggle('active', this.gizmosVisible);
      gizmos.setAttribute('aria-pressed', String(this.gizmosVisible));
      this.app.bottomPanel.log({ level: 'info', message: `Scene gizmos ${this.gizmosVisible ? 'shown' : 'hidden'}.`, time: new Date() });
    });
  }

  private bindBridgeBadge() {
    const badge = this.root.querySelector<HTMLButtonElement>('[data-bridge-badge]');
    if (!badge) return;
    badge.title = 'Open Live Game status · reconnect if the bridge is offline';
    badge.addEventListener('click', () => {
      if (this.app.bridge.status === 'offline') this.app.bridge.connect();
      this.root.querySelector<HTMLButtonElement>('[data-tab="game"]')?.click();
    });
  }

  private bindProjectHome() {
    const localAssets = [...this.root.querySelectorAll<HTMLButtonElement>('[data-project] .folder-button')]
      .find((button) => button.textContent?.trim() === 'Assets');
    if (!localAssets) return;
    localAssets.title = 'Reset the local tile asset browser';
    localAssets.addEventListener('click', () => {
      this.root.querySelector<HTMLButtonElement>('[data-project] [data-kind="all"]')?.click();
      this.root.querySelector<HTMLButtonElement>('[data-project] [data-category="all"]')?.click();
      const search = this.root.querySelector<HTMLInputElement>('[data-project] [data-search]');
      if (search) {
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        search.focus();
      }
    });
  }

  private bindLegacyCardToggles() {
    this.root.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLSpanElement) || !target.classList.contains('component-toggle')) return;
      const card = target.closest<HTMLElement>('.component-card');
      const body = card?.querySelector<HTMLElement>(':scope > .component-body');
      if (!body) return;
      body.hidden = !body.hidden;
      target.textContent = body.hidden ? '▸' : '▾';
    });
  }

  private removeUnsupportedDecorativeButtons() {
    // These were visual placeholders from the first Unity-style shell and had no command model.
    // Keep the UI truthful: no visible button exists unless it has an action path.
    this.root.querySelector('[data-lock]')?.remove();
    this.root.querySelectorAll('.inspector-panel .component-menu').forEach((button) => button.remove());
  }

  private correctTooltips() {
    const pause = this.root.querySelector<HTMLButtonElement>('[data-pause]');
    const step = this.root.querySelector<HTMLButtonElement>('[data-step]');
    if (pause) pause.title = 'Pause / resume Studio preview simulation (does not pause the VanillaGL server/runtime)';
    if (step) step.title = 'Advance Studio preview simulation by one 1/60 second step';
  }

  private openGlobalAssets(category: 'all' | 'audio') {
    const overlay = this.root.querySelector<HTMLElement>('.global-asset-browser');
    if (!overlay) {
      this.app.bottomPanel.log({ level: 'warn', message: 'Global Content Browser is not available.', time: new Date() });
      return;
    }
    overlay.hidden = false;
    const categorySelect = overlay.querySelector<HTMLSelectElement>('[data-global-category]');
    if (categorySelect) {
      categorySelect.value = category;
      categorySelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    overlay.querySelector<HTMLInputElement>('[data-global-search]')?.focus();
  }

  private createHelp() {
    const overlay = document.createElement('section');
    overlay.className = 'studio-help-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `<div class="studio-help-card" role="dialog" aria-modal="true" aria-label="VanillaGL Studio Help"><header><div><strong>VanillaGL Studio</strong><span>Author in Scene · verify in Game · persist as overrides</span></div><button data-studio-help-close aria-label="Close help">×</button></header><div class="studio-help-grid"><section><h3>Scene</h3><p><kbd>RMB</kbd> + WASD fly · <kbd>Shift</kbd> boost · <kbd>Alt</kbd> orbit · <kbd>F</kbd> focus.</p><p><kbd>W</kbd>/<kbd>E</kbd>/<kbd>R</kbd> move, rotate, scale. <kbd>Ctrl+D</kbd> duplicate. <kbd>Del</kbd> remove.</p></section><section><h3>Project</h3><p>Local Assets are from the loaded tile. Global opens the indexed CleanClientMMO catalog. Prefabs keep reusable component state.</p><p><kbd>Ctrl+S</kbd> saves scene overrides and workspace metadata. <kbd>Ctrl+Shift+S</kbd> exports the workspace file.</p></section><section><h3>Runtime</h3><p>Game embeds the authoritative CleanClientMMO renderer. Push/Live Sync uses the local bridge and requires a connected runtime.</p><p>Pause/Step affect Studio preview simulation only; gameplay remains server/runtime authoritative.</p></section><section><h3>Diagnostics</h3><p>Profiler, Frame Debugger, dependency Graph and Validation are available in the bottom dock. Validation should be clean before server export.</p></section></div></div>`;
    this.root.querySelector('.studio-shell')?.append(overlay);
    overlay.querySelector('[data-studio-help-close]')?.addEventListener('click', () => { overlay.hidden = true; });
    overlay.addEventListener('pointerdown', (event) => { if (event.target === overlay) overlay.hidden = true; });
    window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !overlay.hidden) overlay.hidden = true; });
    return overlay;
  }
}
