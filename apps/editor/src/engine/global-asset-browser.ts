import * as THREE from 'three';
import type { EditorApp } from '../editor-app';
import type { EditorAsset, LoadedEditorTile } from '../types';
import type { SceneComponentModel } from './component-model';
import { CreatureAssetSource } from './creature-asset-source';

export type GlobalAssetEntry = {
  id: string;
  kind: 'm2' | 'wmo' | 'creature';
  model: string;
  label: string;
  category: 'nature' | 'structures' | 'props' | 'creatures' | 'other';
  representativeTile?: string;
  mapId?: number;
  displayId?: number;
  occurrences: number;
  textures?: string[];
};

type AssetIndex = { version: 1; generatedAt: string | null; source: string | null; assets: GlobalAssetEntry[] };
const normalize = (value: string) => value.replaceAll('\\', '/').toLowerCase();

export class GlobalAssetBrowser extends EventTarget {
  private index: AssetIndex = { version: 1, generatedAt: null, source: null, assets: [] };
  private overlay: HTMLElement;
  private search: HTMLInputElement;
  private list: HTMLElement;
  private category = 'all';
  private assetCache = new Map<string, Promise<EditorAsset>>();
  private tileCache = new Map<string, Promise<LoadedEditorTile>>();
  private creatures = new CreatureAssetSource();

  constructor(private readonly app: EditorApp, private readonly root: HTMLElement, private readonly components: SceneComponentModel) {
    const project = root.querySelector<HTMLElement>('[data-project]')!;
    const toolbar = project.querySelector('.project-toolbar');
    const button = document.createElement('button');
    button.className = 'folder-button global-assets-button';
    button.textContent = 'Global';
    button.title = 'Open the indexed CleanClientMMO content catalog';
    toolbar?.prepend(button);
    this.overlay = document.createElement('div');
    this.overlay.className = 'global-asset-browser';
    this.overlay.hidden = true;
    this.overlay.innerHTML = `<div class="global-assets-head"><strong>Content Browser</strong><span data-index-state>Index not loaded</span><button data-close>×</button></div><div class="global-assets-toolbar"><input data-global-search type="search" placeholder="Search every indexed M2, WMO and creature…"/><select data-global-category><option value="all">All categories</option><option value="nature">Nature</option><option value="structures">Structures</option><option value="props">Props</option><option value="creatures">Creatures</option><option value="other">Other</option></select></div><div class="global-assets-list" data-global-list></div>`;
    project.append(this.overlay);
    this.search = this.overlay.querySelector<HTMLInputElement>('[data-global-search]')!;
    this.list = this.overlay.querySelector<HTMLElement>('[data-global-list]')!;
    button.addEventListener('click', () => { this.overlay.hidden = !this.overlay.hidden; if (!this.overlay.hidden) this.search.focus(); });
    this.overlay.querySelector('[data-close]')!.addEventListener('click', () => { this.overlay.hidden = true; });
    this.search.addEventListener('input', () => this.render());
    this.overlay.querySelector<HTMLSelectElement>('[data-global-category]')!.addEventListener('change', (event) => { this.category = (event.target as HTMLSelectElement).value; this.render(); });
    void this.loadIndex();
  }

  private async loadIndex() {
    try {
      const response = await fetch('/studio-asset-index.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = await response.json() as AssetIndex;
      this.index = parsed.version === 1 && Array.isArray(parsed.assets) ? parsed : this.index;
      const state = this.overlay.querySelector<HTMLElement>('[data-index-state]')!;
      state.textContent = this.index.assets.length ? `${this.index.assets.length.toLocaleString()} assets · ${this.index.generatedAt ? new Date(this.index.generatedAt).toLocaleString() : 'bundled index'}` : 'Index is empty — run npm run index:assets';
      this.render();
    } catch (error) {
      this.overlay.querySelector<HTMLElement>('[data-index-state]')!.textContent = `Index unavailable: ${(error as Error).message}`;
      this.render();
    }
  }

  private render() {
    const q = this.search.value.trim().toLowerCase();
    const rows = this.index.assets.filter((entry) => (this.category === 'all' || entry.category === this.category) && (!q || `${entry.label} ${entry.model} ${entry.kind}`.toLowerCase().includes(q))).slice(0, 1200);
    this.list.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = this.index.assets.length ? 'No matching indexed assets.' : 'Build the CleanClientMMO asset index with `npm run index:assets`.';
      this.list.append(empty);
      return;
    }
    for (const entry of rows) {
      const row = document.createElement('button');
      row.className = 'global-asset-row';
      row.innerHTML = `<span class="global-kind ${entry.kind}">${entry.kind === 'wmo' ? '▣' : entry.kind === 'creature' ? '●' : '◆'}</span><span><strong></strong><small></small></span><span class="global-occurs">${entry.occurrences.toLocaleString()}×</span>`;
      row.querySelector('strong')!.textContent = entry.label;
      row.querySelector('small')!.textContent = entry.kind === 'creature' ? `${entry.model} · display ${entry.displayId ?? '?'}` : `${entry.model}${entry.representativeTile ? ` · ${entry.representativeTile}` : ''}`;
      row.title = 'Double-click to place at the Scene camera focus';
      row.addEventListener('dblclick', () => void this.spawn(entry));
      this.list.append(row);
    }
  }

  private async spawn(entry: GlobalAssetEntry) {
    try {
      const asset = await this.resolve(entry);
      const target = this.app.camera.orbit.target.clone();
      const point = this.ground(target.x, target.y) ?? target;
      const record = this.app.store.addFromAsset(asset, point, this.app.store.tileKey);
      if (entry.kind === 'creature') this.components.addComponent(record, 'CreatureSpawn', { displayId: entry.displayId ?? 0 });
      this.app.bottomPanel.log({ level: 'info', message: `Placed ${entry.label} from the global Content Browser.`, time: new Date() });
      this.dispatchEvent(new CustomEvent('spawn', { detail: { entry, record } }));
    } catch (error) {
      this.app.bottomPanel.log({ level: 'error', message: `Asset placement failed: ${error instanceof Error ? error.message : String(error)}`, time: new Date() });
    }
  }

  private resolve(entry: GlobalAssetEntry) {
    let pending = this.assetCache.get(entry.id);
    if (!pending) {
      pending = entry.kind === 'creature'
        ? this.creatures.load(Number(entry.displayId), entry.model)
        : this.resolveWorldAsset(entry);
      this.assetCache.set(entry.id, pending);
      pending.catch(() => this.assetCache.delete(entry.id));
    }
    return pending;
  }

  private async resolveWorldAsset(entry: GlobalAssetEntry) {
    if (!entry.representativeTile) throw new Error(`No representative tile is indexed for ${entry.model}`);
    let tile = this.tileCache.get(entry.representativeTile);
    if (!tile) {
      tile = this.app.source.loadTile(entry.representativeTile, entry.mapId ?? Number(new URLSearchParams(location.search).get('map') ?? 0));
      this.tileCache.set(entry.representativeTile, tile);
      tile.catch(() => this.tileCache.delete(entry.representativeTile!));
    }
    const loaded = await tile;
    const asset = loaded.assets.find((candidate) => candidate.kind === entry.kind && normalize(candidate.model) === normalize(entry.model));
    if (!asset) throw new Error(`${entry.model} was not found in ${entry.representativeTile}`);
    return asset;
  }

  private ground(x: number, y: number) {
    const raycaster = new THREE.Raycaster(new THREE.Vector3(x, y, 10000), new THREE.Vector3(0, 0, -1), 0, 20000);
    const hit = raycaster.intersectObjects(this.app.scene.children, true).find((candidate) => candidate.object.userData.editorTerrain);
    return hit?.point.clone() ?? null;
  }
}
