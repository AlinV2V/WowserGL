import * as THREE from 'three';
import type { EditorApp } from '../editor-app';
import type { EditorAsset, LoadedEditorTile } from '../types';
import type { SceneComponentModel } from './component-model';
import { CreatureAssetSource } from './creature-asset-source';

export type GlobalAssetEntry = {
  id: string;
  kind: 'm2' | 'wmo' | 'creature' | 'texture' | 'audio';
  model: string;
  label: string;
  category: 'nature' | 'structures' | 'props' | 'creatures' | 'textures' | 'audio' | 'other';
  representativeTile?: string;
  mapId?: number;
  displayId?: number;
  occurrences: number;
  textures?: string[];
  previewUrl?: string;
  metadata?: Record<string, unknown>;
};

type SpawnableAssetEntry = GlobalAssetEntry & { kind: 'm2' | 'wmo' | 'creature' };
type WorldAssetEntry = GlobalAssetEntry & { kind: 'm2' | 'wmo' };
type AssetIndex = { version: 1; generatedAt: string | null; source: string | null; assets: GlobalAssetEntry[] };
const normalize = (value: string) => value.replaceAll('\\', '/').toLowerCase();
const spawnable = (entry: GlobalAssetEntry): entry is SpawnableAssetEntry => entry.kind === 'm2' || entry.kind === 'wmo' || entry.kind === 'creature';
const FAVORITES_KEY = 'wowsergl:content-favorites:v1';
const RECENTS_KEY = 'wowsergl:content-recents:v1';

export class GlobalAssetBrowser extends EventTarget {
  private index: AssetIndex = { version: 1, generatedAt: null, source: null, assets: [] };
  private overlay: HTMLElement;
  private search: HTMLInputElement;
  private list: HTMLElement;
  private preview: HTMLElement;
  private category = 'all';
  private scope: 'all' | 'favorites' | 'recent' = 'all';
  private assetCache = new Map<string, Promise<EditorAsset>>();
  private tileCache = new Map<string, Promise<LoadedEditorTile>>();
  private creatures = new CreatureAssetSource();
  private audio: HTMLAudioElement | null = null;
  private favorites = new Set<string>();
  private recent: string[] = [];

  constructor(private readonly app: EditorApp, private readonly root: HTMLElement, private readonly components: SceneComponentModel) {
    super();
    this.loadLocalState();
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
    this.overlay.innerHTML = `<div class="global-assets-head"><strong>Content Browser</strong><span data-index-state>Index not loaded</span><button data-close>×</button></div><div class="global-assets-toolbar"><input data-global-search type="search" placeholder="Search models, creatures, textures and audio…"/><select data-global-scope><option value="all">All assets</option><option value="favorites">Favorites</option><option value="recent">Recent</option></select><select data-global-category><option value="all">All categories</option><option value="nature">Nature</option><option value="structures">Structures</option><option value="props">Props</option><option value="creatures">Creatures</option><option value="textures">Textures</option><option value="audio">Audio</option><option value="other">Other</option></select></div><div class="global-assets-body"><div class="global-assets-list" data-global-list></div><aside class="global-asset-preview" data-global-preview><div class="empty-state">Select an asset to inspect dependencies and preview it.</div></aside></div>`;
    project.append(this.overlay);
    this.search = this.overlay.querySelector<HTMLInputElement>('[data-global-search]')!;
    this.list = this.overlay.querySelector<HTMLElement>('[data-global-list]')!;
    this.preview = this.overlay.querySelector<HTMLElement>('[data-global-preview]')!;
    button.addEventListener('click', () => { this.overlay.hidden = !this.overlay.hidden; if (!this.overlay.hidden) this.search.focus(); });
    this.overlay.querySelector('[data-close]')!.addEventListener('click', () => { this.overlay.hidden = true; this.stopAudio(); });
    this.search.addEventListener('input', () => this.render());
    this.overlay.querySelector<HTMLSelectElement>('[data-global-category]')!.addEventListener('change', (event) => { this.category = (event.target as HTMLSelectElement).value; this.render(); });
    this.overlay.querySelector<HTMLSelectElement>('[data-global-scope]')!.addEventListener('change', (event) => { this.scope = (event.target as HTMLSelectElement).value as typeof this.scope; this.render(); });
    this.bindSceneDrop();
    void this.loadIndex();
  }

  async instantiatePrefab(prefab: { id: string; model: string; kind: string; entity: Parameters<SceneComponentModel['hydrateEntity']>[1] }) {
    const component = prefab.entity.components.find((entry) => entry.type === 'CreatureSpawn');
    const displayId = Number(component?.data.displayId ?? 0);
    const entry = this.index.assets.find((candidate) => candidate.kind === 'creature' && displayId > 0 && candidate.displayId === displayId)
      ?? this.index.assets.find((candidate) => candidate.kind === prefab.kind && normalize(candidate.model) === normalize(prefab.model));
    if (!entry || !spawnable(entry)) throw new Error(`Prefab asset is not present in the spawnable global index: ${prefab.model}`);
    const record = await this.spawn(entry);
    this.components.hydrateEntity(record, prefab.entity);
    this.components.addComponent(record, 'PrefabInstance', { prefabId: prefab.id, unpacked: false });
    this.dispatchEvent(new CustomEvent('spawn', { detail: { entry, record, prefab } }));
    return record;
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
    const recentRank = new Map(this.recent.map((id, index) => [id, index]));
    let rows = this.index.assets.filter((entry) => (this.category === 'all' || entry.category === this.category) && (!q || `${entry.label} ${entry.model} ${entry.kind}`.toLowerCase().includes(q)));
    if (this.scope === 'favorites') rows = rows.filter((entry) => this.favorites.has(entry.id));
    if (this.scope === 'recent') rows = rows.filter((entry) => recentRank.has(entry.id)).sort((a, b) => (recentRank.get(a.id) ?? 999) - (recentRank.get(b.id) ?? 999));
    rows = rows.slice(0, 1800);
    this.list.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = this.index.assets.length ? 'No matching indexed assets.' : 'Build the CleanClientMMO asset index with `npm run index:assets`.';
      this.list.append(empty);
      return;
    }
    for (const entry of rows) {
      const row = document.createElement('div');
      row.className = 'global-asset-row';
      row.draggable = spawnable(entry);
      const icon = entry.kind === 'wmo' ? '▣' : entry.kind === 'creature' ? '●' : entry.kind === 'texture' ? '▧' : entry.kind === 'audio' ? '♪' : '◆';
      row.innerHTML = `<span class="global-kind ${entry.kind}">${icon}</span><button class="global-asset-main"><strong></strong><small></small></button><span class="global-occurs">${entry.occurrences.toLocaleString()}×</span><button class="global-favorite ${this.favorites.has(entry.id) ? 'active' : ''}" title="Favorite">★</button>`;
      row.querySelector('strong')!.textContent = entry.label;
      row.querySelector('small')!.textContent = entry.kind === 'creature' ? `${entry.model} · display ${entry.displayId ?? '?'}` : `${entry.model}${entry.representativeTile ? ` · ${entry.representativeTile}` : ''}`;
      row.title = spawnable(entry) ? 'Double-click or drag into Scene to place' : 'Click to preview';
      row.querySelector('.global-asset-main')!.addEventListener('click', () => { this.touchRecent(entry.id); this.showPreview(entry); });
      if (spawnable(entry)) row.querySelector('.global-asset-main')!.addEventListener('dblclick', () => void this.spawnSafely(entry));
      row.querySelector('.global-favorite')!.addEventListener('click', (event) => { event.stopPropagation(); this.toggleFavorite(entry.id); this.render(); });
      row.addEventListener('dragstart', (event) => {
        if (!spawnable(entry)) { event.preventDefault(); return; }
        event.dataTransfer?.setData('application/x-wowsergl-global-asset', entry.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
      });
      this.list.append(row);
    }
  }

  private showPreview(entry: GlobalAssetEntry) {
    this.stopAudio();
    this.preview.replaceChildren();
    const head = document.createElement('div');
    head.className = 'content-preview-head';
    const title = document.createElement('strong');
    title.textContent = entry.label;
    const kind = document.createElement('span');
    kind.textContent = entry.kind.toUpperCase();
    head.append(title, kind);
    this.preview.append(head);

    if (entry.kind === 'texture' && entry.previewUrl) {
      const frame = document.createElement('div');
      frame.className = 'texture-preview-frame';
      const image = document.createElement('img');
      image.src = entry.previewUrl;
      image.alt = entry.label;
      image.addEventListener('error', () => frame.classList.add('preview-error'));
      frame.append(image);
      this.preview.append(frame);
    }
    if (entry.kind === 'audio' && entry.previewUrl) {
      const controls = document.createElement('div');
      controls.className = 'audio-preview';
      const play = document.createElement('button');
      play.className = 'accent';
      play.textContent = '▶ Play';
      const stop = document.createElement('button');
      stop.textContent = '■ Stop';
      play.addEventListener('click', () => {
        this.stopAudio();
        this.audio = new Audio(entry.previewUrl);
        void this.audio.play().catch((error) => this.app.bottomPanel.log({ level: 'warn', message: `Audio preview failed: ${error instanceof Error ? error.message : String(error)}`, time: new Date() }));
      });
      stop.addEventListener('click', () => this.stopAudio());
      controls.append(play, stop);
      this.preview.append(controls);
    }
    if (spawnable(entry)) {
      const place = document.createElement('button');
      place.className = 'accent content-place-button';
      place.textContent = 'Place at Scene Focus';
      place.addEventListener('click', () => void this.spawnSafely(entry));
      this.preview.append(place);
    }

    const details = document.createElement('dl');
    details.className = 'content-preview-details';
    const add = (label: string, value: string) => {
      const dt = document.createElement('dt'); dt.textContent = label;
      const dd = document.createElement('dd'); dd.textContent = value;
      details.append(dt, dd);
    };
    add('Path / name', entry.model);
    add('Occurrences', entry.occurrences.toLocaleString());
    if (entry.representativeTile) add('Representative tile', entry.representativeTile);
    if (entry.displayId !== undefined) add('Display ID', String(entry.displayId));
    if (entry.previewUrl) add('Preview source', entry.previewUrl);
    if (entry.textures?.length) add('Dependencies', entry.textures.join('\n'));
    if (entry.metadata && Object.keys(entry.metadata).length) add('Metadata', JSON.stringify(entry.metadata, null, 2));
    this.preview.append(details);
  }

  private async spawn(entry: SpawnableAssetEntry, position?: THREE.Vector3) {
    const asset = await this.resolve(entry);
    const target = position ?? this.ground(this.app.camera.orbit.target.x, this.app.camera.orbit.target.y) ?? this.app.camera.orbit.target.clone();
    const record = this.app.store.addFromAsset(asset, target, this.app.store.tileKey);
    if (entry.kind === 'creature') this.components.addComponent(record, 'CreatureSpawn', { displayId: entry.displayId ?? 0 });
    this.touchRecent(entry.id);
    this.app.store.select(record);
    this.app.bottomPanel.log({ level: 'info', message: `Placed ${entry.label} from the global Content Browser.`, time: new Date() });
    this.dispatchEvent(new CustomEvent('spawn', { detail: { entry, record } }));
    return record;
  }

  private async spawnSafely(entry: SpawnableAssetEntry, position?: THREE.Vector3) {
    try {
      return await this.spawn(entry, position);
    } catch (error) {
      this.app.bottomPanel.log({ level: 'error', message: `Asset placement failed: ${error instanceof Error ? error.message : String(error)}`, time: new Date() });
      return null;
    }
  }

  private resolve(entry: SpawnableAssetEntry) {
    let pending = this.assetCache.get(entry.id);
    if (!pending) {
      if (entry.kind === 'creature') pending = this.creatures.load(Number(entry.displayId), entry.model);
      else pending = this.resolveWorldAsset(entry as WorldAssetEntry);
      this.assetCache.set(entry.id, pending);
      pending.catch(() => this.assetCache.delete(entry.id));
    }
    return pending;
  }

  private async resolveWorldAsset(entry: WorldAssetEntry) {
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

  private bindSceneDrop() {
    const canvas = this.app.renderer.domElement;
    canvas.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types.includes('application/x-wowsergl-global-asset')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    canvas.addEventListener('drop', (event) => {
      const id = event.dataTransfer?.getData('application/x-wowsergl-global-asset');
      if (!id) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const entry = this.index.assets.find((candidate) => candidate.id === id);
      if (!entry || !spawnable(entry)) return;
      const point = this.groundFromScreen(event.clientX, event.clientY);
      void this.spawnSafely(entry, point ?? undefined);
    }, true);
  }

  private groundFromScreen(clientX: number, clientY: number) {
    const rect = this.app.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.app.camera.active);
    return raycaster.intersectObjects(this.app.scene.children, true).find((candidate) => candidate.object.userData.editorTerrain)?.point.clone() ?? null;
  }

  private ground(x: number, y: number) {
    const raycaster = new THREE.Raycaster(new THREE.Vector3(x, y, 10000), new THREE.Vector3(0, 0, -1), 0, 20000);
    const hit = raycaster.intersectObjects(this.app.scene.children, true).find((candidate) => candidate.object.userData.editorTerrain);
    return hit?.point.clone() ?? null;
  }

  private toggleFavorite(id: string) {
    if (this.favorites.has(id)) this.favorites.delete(id); else this.favorites.add(id);
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...this.favorites]));
  }

  private touchRecent(id: string) {
    this.recent = [id, ...this.recent.filter((value) => value !== id)].slice(0, 40);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(this.recent));
  }

  private loadLocalState() {
    try { this.favorites = new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]') as string[]); } catch { this.favorites = new Set(); }
    try { this.recent = (JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]') as string[]).slice(0, 40); } catch { this.recent = []; }
  }

  private stopAudio() {
    if (!this.audio) return;
    this.audio.pause();
    this.audio.currentTime = 0;
    this.audio = null;
  }
}
