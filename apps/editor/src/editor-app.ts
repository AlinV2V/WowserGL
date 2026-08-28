import * as THREE from 'three';
import { EditorBottomPanel } from './editor-bottom-panel';
import { EditorCameraController } from './editor-camera';
import { EditorEnvironment } from './editor-environment';
import { EditorGizmoController } from './editor-gizmo';
import { EditorHierarchy } from './editor-hierarchy';
import { EditorHistory } from './editor-history';
import { EditorInspector } from './editor-inspector';
import { EditorLiveBridge, liveTargetFor } from './editor-live-bridge';
import { EditorMaterialInspector } from './editor-materials';
import { EditorPalette } from './editor-palette';
import { EditorSerializer, serializeEditorRecord } from './editor-serializer';
import { EditorObjectStore } from './editor-store';
import type { LiveProjectPayload } from './live-protocol';
import type { CustomMapPatch, EditorAsset, EditorRecord, LoadedEditorTile, MaterialOverride, SerializedObject } from './types';
import { VanillaGLAssetSource } from './vanillagl-source';

const normalizeModel = (value: string) => value.replaceAll('\\', '/').toLowerCase();

export class EditorApp {
  readonly scene = new THREE.Scene();
  readonly renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  readonly history = new EditorHistory();
  readonly store = new EditorObjectStore(this.scene);
  readonly serializer = new EditorSerializer();
  readonly source = new VanillaGLAssetSource(import.meta.env.VITE_VANILLAGL_ASSET_BASE ?? '');
  readonly bridge = new EditorLiveBridge();
  readonly camera: EditorCameraController;
  readonly gizmo: EditorGizmoController;
  readonly environment: EditorEnvironment;
  readonly palette: EditorPalette;
  readonly hierarchy: EditorHierarchy;
  readonly inspector: EditorInspector;
  readonly materialInspector: EditorMaterialInspector;
  readonly bottomPanel: EditorBottomPanel;

  private tile: LoadedEditorTile | null = null;
  private cursor = new THREE.Vector3();
  private hasCursor = false;
  private lastTime = performance.now();
  private viewport: HTMLElement;
  private status: HTMLElement;
  private tileInput: HTMLInputElement;
  private mapInput: HTMLInputElement;
  private bridgeBadge: HTMLElement;
  private liveSyncButton: HTMLButtonElement;
  private playButton: HTMLButtonElement;
  private materialOverrides: MaterialOverride[] = [];
  private liveSync = false;
  private playing = false;
  private dirty = false;
  private saveTimer = 0;
  private pushTimers = new Map<string, number>();
  private lastRuntimeCount = 0;

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = this.shell();
    this.viewport = root.querySelector<HTMLElement>('[data-viewport]')!;
    this.status = root.querySelector<HTMLElement>('[data-status]')!;
    this.tileInput = root.querySelector<HTMLInputElement>('[data-tile]')!;
    this.mapInput = root.querySelector<HTMLInputElement>('[data-map]')!;
    this.bridgeBadge = root.querySelector<HTMLElement>('[data-bridge-badge]')!;
    this.liveSyncButton = root.querySelector<HTMLButtonElement>('[data-live-sync]')!;
    this.playButton = root.querySelector<HTMLButtonElement>('[data-play]')!;

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.domElement.tabIndex = 0;
    this.viewport.append(this.renderer.domElement);

    this.camera = new EditorCameraController(this.renderer.domElement);
    this.environment = new EditorEnvironment(this.scene);
    this.gizmo = new EditorGizmoController(this.scene, this.renderer.domElement, this.camera, this.store, this.history);
    this.palette = new EditorPalette(root.querySelector<HTMLElement>('[data-project]')!);
    this.hierarchy = new EditorHierarchy(root.querySelector<HTMLElement>('[data-hierarchy]')!, this.store);
    this.inspector = new EditorInspector(
      root.querySelector<HTMLElement>('[data-inspector]')!,
      this.store,
      this.history,
      (x, y) => this.tile?.sampleHeightWorld(x, y) ?? 0,
    );
    this.materialInspector = new EditorMaterialInspector(this.inspector.materialHost(), this.store);
    this.environment.mountControls(root.querySelector<HTMLElement>('[data-environment]')!);
    this.bottomPanel = new EditorBottomPanel(root.querySelector<HTMLElement>('[data-bottom]')!, this.store);

    this.addEditorHelpers();
    this.bindUi();
    this.bindLiveAuthoring();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(this.viewport);
    this.loop();
    this.bridge.connect();

    const params = new URLSearchParams(location.search);
    const initialTile = params.get('tile');
    const initialMap = Number(params.get('map') ?? 0);
    if (initialTile) {
      this.tileInput.value = initialTile;
      this.mapInput.value = String(initialMap);
      void this.loadTile(initialTile, initialMap);
    }
  }

  private shell() {
    return `
      <main class="studio-shell">
        <header class="menu-bar">
          <div class="unity-brand"><span class="brand-cube">V</span><strong>VanillaGL Studio</strong></div>
          <nav class="app-menu"><button data-menu="file">File</button><button data-menu="edit">Edit</button><button data-menu="assets">Assets</button><button data-menu="gameobject">GameObject</button><button data-menu="window">Window</button><button data-menu="help">Help</button></nav>
          <div class="scene-loader"><label>Map <input data-map type="number" value="0" min="0" /></label><label>Tile <input data-tile value="Azeroth_30_49" spellcheck="false" /></label><button data-load>Open</button></div>
          <button class="bridge-badge" data-bridge-badge title="Studio live bridge"><span></span><strong>Bridge Offline</strong></button>
        </header>

        <header class="tool-bar">
          <div class="tool-group transform-tools">
            <button class="tool-icon active" data-mode="translate" title="Move (W)">↔<kbd>W</kbd></button>
            <button class="tool-icon" data-mode="rotate" title="Rotate (E)">⟳<kbd>E</kbd></button>
            <button class="tool-icon" data-mode="scale" title="Scale (R)">⤢<kbd>R</kbd></button>
            <span class="tool-separator"></span>
            <button data-top title="Orthographic Top View">Top</button>
            <label class="toolbar-select">Grid<select data-grid-snap><option value="0">Off</option><option value="1">1 yd</option><option value="5">5 yd</option></select></label>
            <label class="toolbar-select">Angle<select data-angle-snap><option value="0">Off</option><option value="15">15°</option><option value="45">45°</option><option value="90">90°</option></select></label>
          </div>
          <div class="play-controls">
            <button class="play-button" data-play title="Play / attach runtime">▶</button>
            <button data-pause title="Pause Studio preview simulation">Ⅱ</button>
            <button data-step title="Step Studio preview simulation">▹|</button>
          </div>
          <div class="tool-group live-tools">
            <button data-live-sync class="live-sync"><span class="sync-dot"></span> Live Sync</button>
            <button data-push-all class="accent">Push All</button>
            <button data-save-project>Save Project</button>
            <button data-open-game>Open Game</button>
          </div>
        </header>

        <aside class="left-dock">
          <section class="dock-panel hierarchy-panel" data-hierarchy></section>
          <section class="dock-panel project-panel" data-project></section>
        </aside>

        <section class="scene-dock">
          <div class="dock-tabs scene-tabs"><button class="active">Scene</button><button data-game-tab>Game</button><span></span><button data-gizmos class="active">Gizmos</button></div>
          <section class="viewport" data-viewport>
            <div class="scene-overlay scene-overlay-left"><button>Shaded ▾</button><button>2D</button><button>Audio Assets</button></div>
            <div class="axis-widget"><span class="axis-z">Z</span><span class="axis-y">Y</span><span class="axis-x">X</span></div>
            <div class="viewport-help">RMB + WASD fly · Shift boost · Alt orbit · F frame selection · Ctrl+D duplicate · Del remove</div>
            <div class="viewport-badge">Scene · WebGL2 · Three.js r176</div>
          </section>
        </section>

        <aside class="right-dock">
          <section class="inspector-panel" data-inspector></section>
          <section class="environment-panel" data-environment></section>
        </aside>

        <section class="bottom-dock" data-bottom></section>
        <footer class="statusbar" data-status><span data-status-copy>Ready</span><span class="status-spacer"></span><span data-coords>0, 0, 0</span><span data-speed>35 yd/s</span></footer>

        <div class="context-menu" data-context-menu hidden>
          <button data-context-focus>Frame Selected <kbd>F</kbd></button>
          <button data-context-duplicate>Duplicate <kbd>Ctrl+D</kbd></button>
          <button data-context-push>Push to Game</button>
          <span></span>
          <button class="danger" data-context-delete>Delete <kbd>Del</kbd></button>
        </div>
        <input data-import-file type="file" accept="application/json,.json" hidden />
      </main>`;
  }

  private addEditorHelpers() {
    const grid = new THREE.GridHelper(2000, 200, 0x53606f, 0x2e343d);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = 0;
    grid.material.transparent = true;
    grid.material.opacity = 0.24;
    grid.userData.editorNonSelectable = true;
    this.scene.add(grid);
    const axes = new THREE.AxesHelper(8);
    axes.userData.editorNonSelectable = true;
    this.scene.add(axes);
  }

  private bindUi() {
    this.root.querySelector('[data-load]')!.addEventListener('click', () => void this.loadTile(this.tileInput.value.trim(), Number(this.mapInput.value || 0)));
    this.tileInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void this.loadTile(this.tileInput.value.trim(), Number(this.mapInput.value || 0));
    });
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
      button.addEventListener('click', () => {
        const mode = button.dataset.mode as 'translate' | 'rotate' | 'scale';
        this.gizmo.setMode(mode);
        for (const sibling of this.root.querySelectorAll('[data-mode]')) sibling.classList.toggle('active', sibling === button);
      });
    }
    this.gizmo.addEventListener('mode', (event) => {
      const mode = (event as CustomEvent<string>).detail;
      for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-mode]')) button.classList.toggle('active', button.dataset.mode === mode);
    });
    this.root.querySelector<HTMLSelectElement>('[data-grid-snap]')!.addEventListener('change', (event) => {
      const value = Number((event.target as HTMLSelectElement).value);
      this.gizmo.setTranslationSnap(value || null);
    });
    this.root.querySelector<HTMLSelectElement>('[data-angle-snap]')!.addEventListener('change', (event) => {
      const value = Number((event.target as HTMLSelectElement).value);
      this.gizmo.setRotationSnap(value || null);
    });
    this.root.querySelector('[data-top]')!.addEventListener('click', (event) => {
      const active = this.camera.toggleTopDown();
      (event.currentTarget as HTMLButtonElement).classList.toggle('active', active);
    });
    this.root.querySelector('[data-open-game]')!.addEventListener('click', () => this.bridge.openGame());
    this.root.querySelector('[data-push-all]')!.addEventListener('click', () => this.pushAll());
    this.root.querySelector('[data-save-project]')!.addEventListener('click', () => this.saveProject());
    this.liveSyncButton.addEventListener('click', () => {
      this.liveSync = !this.liveSync;
      this.liveSyncButton.classList.toggle('active', this.liveSync);
      this.setStatus(this.liveSync ? 'Live Sync enabled — scene edits push automatically.' : 'Live Sync disabled.');
      if (this.liveSync && this.bridge.runtimes) this.pushAll();
    });
    this.playButton.addEventListener('click', () => {
      this.playing = !this.playing;
      this.playButton.classList.toggle('active', this.playing);
      this.playButton.textContent = this.playing ? '■' : '▶';
      this.root.classList.toggle('play-mode', this.playing);
      this.bridge.setPlayMode(this.playing);
      if (this.playing && !this.bridge.runtimes) this.bridge.openGame();
    });

    this.palette.addEventListener('spawn', (event) => this.spawnAsset((event as CustomEvent<EditorAsset>).detail));
    this.gizmo.addEventListener('cursor', (event) => {
      this.cursor.copy((event as CustomEvent<THREE.Vector3>).detail);
      this.hasCursor = true;
      this.updateStatus();
    });
    this.store.addEventListener('selection', () => this.updateStatus());
    this.store.addEventListener('change', (event) => {
      this.markDirty();
      const record = (event as CustomEvent<EditorRecord | undefined>).detail;
      if (record && this.liveSync) this.queuePush(record);
      this.updateStatus();
    });
    this.environment.addEventListener('change', () => {
      this.markDirty();
      if (this.liveSync) this.queueEnvironmentPush();
    });
    this.camera.addEventListener('speed', () => this.updateStatus());

    this.renderer.domElement.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes('application/x-wowsergl-asset')) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    });
    this.renderer.domElement.addEventListener('drop', (event) => {
      event.preventDefault();
      const id = event.dataTransfer?.getData('application/x-wowsergl-asset');
      const asset = id ? this.palette.getAsset(id) : null;
      if (!asset) return;
      const point = this.raycastTerrain(event.clientX, event.clientY) ?? (this.hasCursor ? this.cursor.clone() : null);
      this.spawnAsset(asset, point ?? undefined);
    });

    this.hierarchy.addEventListener('focus', (event) => this.camera.focus((event as CustomEvent<EditorRecord>).detail.object));
    this.hierarchy.addEventListener('context', (event) => {
      const detail = (event as CustomEvent<{ record: EditorRecord; x: number; y: number }>).detail;
      this.showContextMenu(detail.record, detail.x, detail.y);
    });
    window.addEventListener('pointerdown', (event) => {
      const menu = this.root.querySelector<HTMLElement>('[data-context-menu]')!;
      if (!menu.hidden && !menu.contains(event.target as Node)) menu.hidden = true;
    });

    const fileInput = this.root.querySelector<HTMLInputElement>('[data-import-file]')!;
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const patch = await this.serializer.readFile(file);
        if (!this.tile || this.tile.key !== patch.tileKey || this.tile.mapId !== patch.mapId) await this.loadTile(patch.tileKey, patch.mapId, false);
        this.applyPatch(patch);
        this.setStatus(`Imported ${file.name}`);
      } catch (error) {
        this.setStatus(`Import failed: ${(error as Error).message}`);
      } finally {
        fileInput.value = '';
      }
    });
  }

  private bindLiveAuthoring() {
    this.bridge.addEventListener('status', () => this.updateBridgeUi());
    this.bridge.addEventListener('peers', () => {
      const previous = this.lastRuntimeCount;
      this.lastRuntimeCount = this.bridge.runtimes;
      this.updateBridgeUi();
      if (previous === 0 && this.bridge.runtimes > 0 && this.tile) {
        this.bottomPanel.log({ level: 'info', message: 'VanillaGL runtime connected. Applying current Studio project.', time: new Date() });
        this.pushAll();
      }
    });
    this.bridge.addEventListener('log', (event) => this.bottomPanel.log((event as CustomEvent).detail));
    this.inspector.addEventListener('push', (event) => this.pushRecord((event as CustomEvent<EditorRecord>).detail));
    this.inspector.addEventListener('save', () => this.saveProject());
    this.inspector.addEventListener('focus-game', (event) => this.bridge.focusRuntime((event as CustomEvent<EditorRecord>).detail));
    this.materialInspector.addEventListener('override', (event) => {
      const { record, override, push } = (event as CustomEvent<{ record: EditorRecord; override: MaterialOverride; push: boolean }>).detail;
      this.upsertMaterialOverride(override);
      if (push || this.liveSync) this.bridge.pushMaterial(record, override);
    });
    this.bottomPanel.addEventListener('push-all', () => this.pushAll());
    this.bottomPanel.addEventListener('save-project', () => this.saveProject());
    this.bottomPanel.addEventListener('open-game', () => this.bridge.openGame());
    this.bottomPanel.addEventListener('ping-runtime', () => {
      if (this.store.selected) this.bridge.focusRuntime(this.store.selected);
      else this.setStatus('Select an object to ping/focus it in the runtime.');
    });
    this.updateBridgeUi();
  }

  async loadTile(tileKey: string, mapId: number, restoreLocal = true) {
    if (!tileKey) return;
    this.setStatus(`Loading ${tileKey}…`);
    this.store.select(null);
    const previous = this.tile;
    try {
      const loaded = await this.source.loadTile(tileKey, mapId);
      if (previous) this.scene.remove(previous.group);
      this.store.clear();
      this.tile = loaded;
      this.store.tileKey = loaded.key;
      this.scene.add(loaded.group);
      loaded.group.updateMatrixWorld(true);
      loaded.group.traverse((object) => {
        const meta = object.userData.editorMeta;
        if (!meta) return;
        this.store.registerExisting(object, { kind: meta.kind, model: meta.model, tileKey: meta.tileKey, sourceId: meta.sourceId });
      });
      this.palette.setAssets(loaded.assets);
      this.materialOverrides = [];
      this.materialInspector.setOverrides([]);
      const center = loaded.group.position.clone();
      center.z = ((loaded.meta.minHeight ?? 0) + (loaded.meta.maxHeight ?? 20)) * 0.5;
      this.camera.orbit.target.copy(center);
      this.camera.perspective.position.copy(center).add(new THREE.Vector3(90, 90, 65));
      this.camera.perspective.lookAt(center);
      this.hasCursor = false;
      window.history.replaceState(null, '', `?tile=${encodeURIComponent(tileKey)}&map=${mapId}`);
      if (restoreLocal) this.restoreLocalProject();
      this.dirty = false;
      this.updateStatus();
      this.setStatus(`Loaded ${tileKey} · ${this.store.recordsForTile().length.toLocaleString()} scene objects · ${loaded.assets.length} reusable assets.`);
    } catch (error) {
      this.setStatus(`Load failed: ${(error as Error).message}`);
    }
  }

  private spawnAsset(asset: EditorAsset, position?: THREE.Vector3) {
    if (!this.tile) return this.setStatus('Load a tile before spawning assets.');
    const spawn = position?.clone() ?? (this.hasCursor ? this.cursor.clone() : this.tile.group.position.clone());
    if (!position && !this.hasCursor) spawn.z = this.tile.sampleHeightWorld(spawn.x, spawn.y);
    let record: EditorRecord | null = null;
    this.history.execute({
      label: `Spawn ${asset.label}`,
      redo: () => { record = this.store.addFromAsset(asset, spawn, this.tile!.key); },
      undo: () => { if (record) this.store.remove(record); },
    });
    if (record && this.liveSync) this.pushRecord(record);
  }

  private applyPatch(patch: CustomMapPatch) {
    if (!this.tile) return;
    const assets = new Map(this.tile.assets.map((asset) => [normalizeModel(asset.model), asset]));
    const spawnSerialized = (serialized: SerializedObject, kind: 'm2' | 'wmo') => {
      const asset = assets.get(normalizeModel(serialized.model));
      if (!asset || asset.kind !== kind) return;
      const record = this.store.addFromAsset(asset, new THREE.Vector3().fromArray(serialized.position), this.tile!.key);
      record.object.quaternion.fromArray(serialized.rotation);
      if (typeof serialized.scale === 'number') record.object.scale.setScalar(serialized.scale);
      else record.object.scale.fromArray(serialized.scale);
      record.object.updateMatrixWorld(true);
    };
    patch.customDoodads.forEach((object) => spawnSerialized(object, 'm2'));
    patch.customWmos.forEach((object) => spawnSerialized(object, 'wmo'));
    for (const deleted of patch.deletedObjects ?? []) {
      const record = this.store.recordsForTile().find((candidate) => String(candidate.sourceId ?? candidate.id) === deleted.id && normalizeModel(candidate.model) === normalizeModel(deleted.model));
      if (record) this.store.remove(record);
    }
    for (const modified of patch.modifiedObjects ?? []) {
      const record = this.store.recordsForTile().find((candidate) => String(candidate.sourceId ?? candidate.id) === String(modified.id) && normalizeModel(candidate.model) === normalizeModel(modified.model));
      if (!record) continue;
      this.applyWorldTransform(record.object, modified);
      this.store.markModified(record);
    }
    this.materialOverrides = [...(patch.materialOverrides ?? [])];
    this.materialInspector.setOverrides(this.materialOverrides);
    for (const override of this.materialOverrides) {
      const record = this.store.records.get(override.recordId) ?? this.store.recordsForTile().find((candidate) => String(candidate.sourceId ?? candidate.id) === String(override.sourceId ?? '') && normalizeModel(candidate.model) === normalizeModel(override.model));
      if (record) this.materialInspector.applyOverride(record, override);
    }
    if (patch.environment) {
      this.environment.setHour(patch.environment.hour);
      this.environment.setFog(patch.environment.fogNear, patch.environment.fogFar, patch.environment.fogColor);
      this.environment.setWeather(patch.environment.weather);
    }
    this.markDirty();
  }

  private createLiveProject(): LiveProjectPayload | null {
    if (!this.tile) return null;
    const records = this.store.recordsForTile().filter((record) => record.state !== 'existing');
    return {
      mapId: this.tile.mapId,
      tileKey: this.tile.key,
      objects: records.map((record) => ({
        target: liveTargetFor(record),
        state: record.state === 'deleted' ? 'deleted' : record.state === 'added' ? 'added' : 'modified',
        transform: record.state === 'deleted' ? undefined : serializeEditorRecord(record),
      })),
      materials: this.materialOverrides.filter((override) => override.tileKey === this.tile!.key),
      environment: { ...this.environment.state },
    };
  }

  private pushAll() {
    const project = this.createLiveProject();
    if (!project) return this.setStatus('Load a tile before pushing a project.');
    if (!this.bridge.runtimes) {
      this.setStatus('No VanillaGL runtime connected — use Open Game first.');
      this.bottomPanel.log({ level: 'warn', message: 'Push skipped: no VanillaGL runtime is connected.', time: new Date() });
      return;
    }
    this.bridge.pushProject(project);
    this.setStatus(`Pushed ${project.objects.length} object edits and ${project.materials.length} material overrides to VanillaGL.`);
  }

  private pushRecord(record: EditorRecord) {
    if (!this.bridge.runtimes) return this.setStatus('No VanillaGL runtime connected.');
    const serialized = serializeEditorRecord(record);
    this.bridge.pushRecord(record, serialized);
  }

  private queuePush(record: EditorRecord) {
    window.clearTimeout(this.pushTimers.get(record.id));
    this.pushTimers.set(record.id, window.setTimeout(() => {
      this.pushTimers.delete(record.id);
      if (this.liveSync && this.bridge.runtimes) this.pushRecord(record);
    }, 70));
  }

  private queueEnvironmentPush() {
    window.clearTimeout(this.pushTimers.get('__environment'));
    this.pushTimers.set('__environment', window.setTimeout(() => {
      this.pushTimers.delete('__environment');
      if (this.liveSync && this.bridge.runtimes) this.bridge.pushEnvironment(this.environment.state);
    }, 80));
  }

  private saveProject() {
    if (!this.tile) return this.setStatus('Load a tile before saving.');
    const patch = this.serializer.createPatch(this.store, this.tile.mapId, this.tile.key, this.environment.state, this.materialOverrides);
    localStorage.setItem(this.projectStorageKey(), JSON.stringify(patch));
    const project = this.createLiveProject();
    if (project) this.bridge.saveProject(project);
    this.dirty = false;
    this.updateStatus();
    this.setStatus('Studio project saved locally and sent to the bridge project store.');
  }

  private restoreLocalProject() {
    if (!this.tile) return;
    const raw = localStorage.getItem(this.projectStorageKey());
    if (!raw) return;
    try {
      const patch = JSON.parse(raw) as CustomMapPatch;
      if (patch.tileKey === this.tile.key && patch.mapId === this.tile.mapId) {
        this.applyPatch(patch);
        this.bottomPanel.log({ level: 'info', message: `Restored local Studio project for ${this.tile.key}.`, time: new Date() });
      }
    } catch {
      localStorage.removeItem(this.projectStorageKey());
    }
  }

  private projectStorageKey() {
    return this.tile ? `vanillagl-studio:${this.tile.mapId}:${this.tile.key}` : 'vanillagl-studio:empty';
  }

  private upsertMaterialOverride(override: MaterialOverride) {
    const index = this.materialOverrides.findIndex((candidate) => candidate.id === override.id);
    if (index >= 0) this.materialOverrides[index] = override;
    else this.materialOverrides.push(override);
    this.materialInspector.setOverrides(this.materialOverrides);
    this.bottomPanel.setMaterials(this.materialOverrides);
    this.markDirty();
  }

  private markDirty() {
    this.dirty = true;
    this.bottomPanel.setMaterials(this.materialOverrides);
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      if (!this.tile) return;
      const patch = this.serializer.createPatch(this.store, this.tile.mapId, this.tile.key, this.environment.state, this.materialOverrides);
      localStorage.setItem(this.projectStorageKey(), JSON.stringify(patch));
    }, 600);
    this.updateStatus();
  }

  private showContextMenu(record: EditorRecord, x: number, y: number) {
    const menu = this.root.querySelector<HTMLElement>('[data-context-menu]')!;
    menu.hidden = false;
    menu.style.left = `${Math.min(x, innerWidth - 210)}px`;
    menu.style.top = `${Math.min(y, innerHeight - 190)}px`;
    const close = () => { menu.hidden = true; };
    const once = (selector: string, fn: () => void) => {
      const button = menu.querySelector<HTMLButtonElement>(selector)!;
      const clone = button.cloneNode(true) as HTMLButtonElement;
      button.replaceWith(clone);
      clone.addEventListener('click', () => { fn(); close(); }, { once: true });
    };
    once('[data-context-focus]', () => this.camera.focus(record.object));
    once('[data-context-duplicate]', () => {
      let copy: EditorRecord | null = null;
      this.history.execute({
        label: `Duplicate ${record.model}`,
        redo: () => { copy = this.store.duplicate(record); },
        undo: () => { if (copy) this.store.remove(copy); },
      });
    });
    once('[data-context-push]', () => this.pushRecord(record));
    once('[data-context-delete]', () => {
      const previous = record.state;
      this.history.execute({
        label: `Delete ${record.model}`,
        redo: () => this.store.remove(record),
        undo: () => this.store.restore(record, previous),
      });
    });
  }

  private updateBridgeUi() {
    const ready = this.bridge.runtimes > 0;
    this.bridgeBadge.classList.toggle('online', ready);
    this.bridgeBadge.classList.toggle('connecting', this.bridge.status === 'connecting');
    this.bridgeBadge.querySelector('strong')!.textContent = ready ? `Live · ${this.bridge.runtimes} Game` : this.bridge.status === 'connecting' ? 'Connecting…' : this.bridge.status === 'connected' ? 'Bridge Ready' : 'Bridge Offline';
    this.bottomPanel.setBridge(this.bridge.status, this.bridge.runtimes);
  }

  private applyWorldTransform(object: THREE.Object3D, serialized: SerializedObject) {
    const worldPosition = new THREE.Vector3().fromArray(serialized.position);
    const worldQuaternion = new THREE.Quaternion().fromArray(serialized.rotation);
    const worldScale = typeof serialized.scale === 'number' ? new THREE.Vector3(serialized.scale, serialized.scale, serialized.scale) : new THREE.Vector3().fromArray(serialized.scale);
    if (object.parent) {
      object.parent.updateWorldMatrix(true, false);
      object.position.copy(object.parent.worldToLocal(worldPosition.clone()));
      const parentQuaternion = new THREE.Quaternion();
      object.parent.getWorldQuaternion(parentQuaternion);
      object.quaternion.copy(parentQuaternion.invert().multiply(worldQuaternion));
      const parentScale = new THREE.Vector3();
      object.parent.getWorldScale(parentScale);
      object.scale.set(worldScale.x / parentScale.x, worldScale.y / parentScale.y, worldScale.z / parentScale.z);
    } else {
      object.position.copy(worldPosition);
      object.quaternion.copy(worldQuaternion);
      object.scale.copy(worldScale);
    }
    object.updateMatrixWorld(true);
  }

  private raycastTerrain(clientX: number, clientY: number) {
    if (!this.tile) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera.active);
    return raycaster.intersectObject(this.tile.terrain, false)[0]?.point.clone() ?? null;
  }

  private resize() {
    const width = Math.max(1, this.viewport.clientWidth);
    const height = Math.max(1, this.viewport.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.resize(width, height);
  }

  private loop = () => {
    requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.camera.update(dt);
    this.renderer.render(this.scene, this.camera.active);
  };

  private setStatus(message: string) {
    this.status.querySelector<HTMLElement>('[data-status-copy]')!.textContent = message;
  }

  private updateStatus() {
    const selected = this.store.selected;
    const selectedText = selected ? `${selected.kind.toUpperCase()} · ${selected.model.split(/[\\/]/).pop()} · ${selected.state}` : 'No selection';
    const dirty = this.dirty ? ' • Unsaved' : '';
    this.status.querySelector<HTMLElement>('[data-status-copy]')!.textContent = `${selectedText}${dirty}`;
    this.status.querySelector<HTMLElement>('[data-coords]')!.textContent = this.hasCursor ? `${this.cursor.x.toFixed(1)}, ${this.cursor.y.toFixed(1)}, ${this.cursor.z.toFixed(1)}` : '—';
    this.status.querySelector<HTMLElement>('[data-speed]')!.textContent = `${this.camera.speed.toFixed(0)} yd/s`;
  }
}
