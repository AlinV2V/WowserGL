import type { EditorObjectStore } from './editor-store';
import type { MaterialOverride } from './types';

export type StudioLogEntry = { level: 'info' | 'warn' | 'error'; message: string; time: Date; runtime?: string };

export class EditorBottomPanel extends EventTarget {
  private tab: 'console' | 'changes' | 'game' = 'console';
  private logs: StudioLogEntry[] = [];
  private materials: MaterialOverride[] = [];
  private runtimes = 0;
  private bridgeStatus = 'offline';

  constructor(private readonly container: HTMLElement, private readonly store: EditorObjectStore) {
    super();
    this.mount();
    store.addEventListener('change', () => this.renderBody());
    store.addEventListener('selection', () => this.renderBody());
  }

  setMaterials(materials: MaterialOverride[]) {
    this.materials = materials;
    this.renderBody();
  }

  setBridge(status: string, runtimes: number) {
    this.bridgeStatus = status;
    this.runtimes = runtimes;
    this.renderBody();
  }

  log(entry: StudioLogEntry) {
    this.logs.push(entry);
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
    if (this.tab === 'console') this.renderBody();
  }

  private mount() {
    this.container.innerHTML = `
      <div class="bottom-tabs">
        <button data-tab="console" class="active">Console <span data-console-count>0</span></button>
        <button data-tab="changes">Changes <span data-change-count>0</span></button>
        <button data-tab="game">Live Game <span class="live-dot"></span></button>
        <div class="bottom-spacer"></div>
        <button data-clear title="Clear console">Clear</button>
        <button data-collapse title="Collapse panel">⌄</button>
      </div>
      <div class="bottom-body" data-bottom-body></div>`;
    for (const button of this.container.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      button.addEventListener('click', () => {
        this.tab = button.dataset.tab as typeof this.tab;
        for (const sibling of this.container.querySelectorAll<HTMLButtonElement>('[data-tab]')) sibling.classList.toggle('active', sibling === button);
        this.renderBody();
      });
    }
    this.container.querySelector('[data-clear]')!.addEventListener('click', () => { this.logs = []; this.renderBody(); });
    this.container.querySelector('[data-collapse]')!.addEventListener('click', () => this.container.classList.toggle('collapsed'));
    this.renderBody();
  }

  private renderBody() {
    const body = this.container.querySelector<HTMLElement>('[data-bottom-body]');
    if (!body) return;
    const changed = [...this.store.records.values()].filter((record) => record.state !== 'existing');
    this.container.querySelector<HTMLElement>('[data-console-count]')!.textContent = String(this.logs.length);
    this.container.querySelector<HTMLElement>('[data-change-count]')!.textContent = String(changed.length + this.materials.length);
    this.container.classList.toggle('runtime-ready', this.runtimes > 0);
    if (this.tab === 'console') {
      body.innerHTML = this.logs.length ? this.logs.map((entry) => `
        <div class="console-row ${entry.level}"><span class="console-time">${entry.time.toLocaleTimeString([], { hour12: false })}</span><span class="console-level">${entry.level}</span><span>${entry.runtime ? `[${entry.runtime}] ` : ''}${this.escape(entry.message)}</span></div>`).join('') : '<div class="bottom-empty">Bridge and editor messages appear here.</div>';
      body.scrollTop = body.scrollHeight;
      return;
    }
    if (this.tab === 'changes') {
      body.innerHTML = `
        <div class="changes-toolbar"><strong>${changed.length} scene changes · ${this.materials.length} material overrides</strong><span></span><button data-push-all class="accent">Push All</button><button data-save-all>Save Project</button></div>
        <div class="change-table">
          ${changed.map((record) => `<button data-record="${record.id}" class="change-row"><span class="change-state ${record.state}">${record.state}</span><span>${this.escape(record.model.split(/[\\/]/).pop() || record.model)}</span><span>${record.kind.toUpperCase()}</span><span>${this.escape(String(record.sourceId ?? record.id))}</span></button>`).join('')}
          ${this.materials.map((override) => `<div class="change-row material"><span class="change-state material">material</span><span>${this.escape(override.model.split(/[\\/]/).pop() || override.model)}</span><span>${override.scope}</span><span>${override.color ?? override.textureUrl ?? ''}</span></div>`).join('')}
        </div>`;
      body.querySelector('[data-push-all]')?.addEventListener('click', () => this.dispatchEvent(new Event('push-all')));
      body.querySelector('[data-save-all]')?.addEventListener('click', () => this.dispatchEvent(new Event('save-project')));
      for (const row of body.querySelectorAll<HTMLElement>('[data-record]')) {
        row.addEventListener('click', () => {
          const record = this.store.records.get(row.dataset.record!);
          if (record) this.store.select(record);
        });
      }
      return;
    }
    body.innerHTML = `
      <div class="live-game-card">
        <div class="live-game-status"><span class="runtime-orb ${this.runtimes ? 'online' : ''}"></span><div><strong>${this.runtimes ? `${this.runtimes} VanillaGL runtime${this.runtimes === 1 ? '' : 's'} connected` : 'No VanillaGL runtime connected'}</strong><small>Bridge status: ${this.bridgeStatus}</small></div></div>
        <div class="live-game-actions"><button data-open-game class="accent">Open Game with Live Link</button><button data-ping>Ping Runtime</button></div>
        <p>Launch VanillaGL through Studio to opt into live authoring. Normal game sessions do not load the Studio receiver.</p>
      </div>`;
    body.querySelector('[data-open-game]')?.addEventListener('click', () => this.dispatchEvent(new Event('open-game')));
    body.querySelector('[data-ping]')?.addEventListener('click', () => this.dispatchEvent(new Event('ping-runtime')));
  }

  private escape(value: string) {
    return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
  }
}
