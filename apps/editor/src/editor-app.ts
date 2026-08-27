import * as THREE from 'three';
import { EditorCameraController } from './editor-camera';
import { EditorEnvironment } from './editor-environment';
import { EditorGizmoController } from './editor-gizmo';
import { EditorHistory } from './editor-history';
import { EditorInspector } from './editor-inspector';
import { EditorPalette } from './editor-palette';
import { EditorSerializer } from './editor-serializer';
import { EditorObjectStore } from './editor-store';
import type { CustomMapPatch, EditorAsset, EditorRecord, LoadedEditorTile, SerializedObject } from './types';
import { VanillaGLAssetSource } from './vanillagl-source';

const normalizeModel = (value: string) => value.replaceAll('\\', '/').toLowerCase();

export class EditorApp {
  readonly scene = new THREE.Scene();
  readonly renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  readonly history = new EditorHistory();
  readonly store = new EditorObjectStore(this.scene);
  readonly serializer = new EditorSerializer();
  readonly source = new VanillaGLAssetSource(import.meta.env.VITE_VANILLAGL_ASSET_BASE ?? '');
  readonly camera: EditorCameraController;
  readonly gizmo: EditorGizmoController;
  readonly environment: EditorEnvironment;
  readonly palette: EditorPalette;
  readonly inspector: EditorInspector;
  private tile: LoadedEditorTile | null = null;
  private cursor = new THREE.Vector3();
  private hasCursor = false;
  private lastTime = performance.now();
  private viewport: HTMLElement;
  private status: HTMLElement;
  private tileInput: HTMLInputElement;
  private mapInput: HTMLInputElement;

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = this.shell();
    this.viewport = root.querySelector<HTMLElement>('[data-viewport]')!;
    this.status = root.querySelector<HTMLElement>('[data-status]')!;
    this.tileInput = root.querySelector<HTMLInputElement>('[data-tile]')!;
    this.mapInput = root.querySelector<HTMLInputElement>('[data-map]')!;

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.domElement.tabIndex = 0;
    this.viewport.append(this.renderer.domElement);

    this.camera = new EditorCameraController(this.renderer.domElement);
    this.environment = new EditorEnvironment(this.scene);
    this.gizmo = new EditorGizmoController(this.scene, this.renderer.domElement, this.camera, this.store, this.history);
    this.palette = new EditorPalette(root.querySelector<HTMLElement>('[data-palette]')!);
    this.inspector = new EditorInspector(
      root.querySelector<HTMLElement>('[data-inspector]')!,
      this.store,
      this.history,
      (x, y) => this.tile?.sampleHeightWorld(x, y) ?? 0,
    );
    this.environment.mountControls(root.querySelector<HTMLElement>('[data-environment]')!);

    this.addEditorHelpers();
    this.bindUi();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(this.viewport);
    this.loop();

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
        <header class="topbar">
          <div class="brand"><span class="brand-mark">V</span><div><strong>VanillaGL Studio</strong><small>World Editor & Engine Sandbox</small></div></div>
          <div class="tile-loader">
            <label>Map <input data-map type="number" value="0" min="0" /></label>
            <label>Tile <input data-tile value="Azeroth_30_49" spellcheck="false" /></label>
            <button class="primary" data-load>Load Tile</button>
          </div>
          <div class="toolbar" role="toolbar">
            <button data-mode="translate" class="active" title="Translate (W)">Move <kbd>W</kbd></button>
            <button data-mode="rotate" title="Rotate (E)">Rotate <kbd>E</kbd></button>
            <button data-mode="scale" title="Scale (R)">Scale <kbd>R</kbd></button>
            <span class="divider"></span>
            <label class="compact">Grid <select data-grid-snap><option value="0">Off</option><option value="1">1 yd</option><option value="5">5 yd</option></select></label>
            <label class="compact">Angle <select data-angle-snap><option value="0">Off</option><option value="15">15°</option><option value="45">45°</option><option value="90">90°</option></select></label>
            <button data-top>Top View</button>
            <span class="divider"></span>
            <button data-import>Import</button>
            <button class="primary" data-export>Export JSON</button>
            <input data-import-file type="file" accept="application/json,.json" hidden />
          </div>
        </header>
        <aside class="left-panel panel" data-palette></aside>
        <section class="viewport" data-viewport>
          <div class="viewport-help">RMB look · WASD fly · Shift boost · Space/C vertical · wheel speed · Alt orbit · F focus</div>
          <div class="viewport-badge">WebGL2 / Three.js r176</div>
        </section>
        <aside class="right-panel">
          <section class="panel inspector" data-inspector></section>
          <section class="panel environment" data-environment></section>
        </aside>
        <footer class="statusbar" data-status>Ready — load a VanillaGL terrain tile.</footer>
      </main>`;
  }

  private addEditorHelpers() {
    const grid = new THREE.GridHelper(2000, 200, 0x40454f, 0x252a31);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = 0;
    grid.material.transparent = true;
    grid.material.opacity = 0.22;
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
    this.root.querySelector('[data-export]')!.addEventListener('click', () => {
      if (!this.tile) return this.setStatus('Load a tile before exporting.');
      this.serializer.download(this.store, this.tile.mapId, this.tile.key, this.environment.state);
      this.setStatus('Exported custom_map_patch.json');
    });
    const fileInput = this.root.querySelector<HTMLInputElement>('[data-import-file]')!;
    this.root.querySelector('[data-import]')!.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const patch = await this.serializer.readFile(file);
        if (!this.tile || this.tile.key !== patch.tileKey || this.tile.mapId !== patch.mapId) await this.loadTile(patch.tileKey, patch.mapId);
        this.applyPatch(patch);
        this.setStatus(`Imported ${file.name}`);
      } catch (error) {
        this.setStatus(`Import failed: ${(error as Error).message}`);
      } finally {
        fileInput.value = '';
      }
    });

    this.palette.addEventListener('spawn', (event) => this.spawnAsset((event as CustomEvent<EditorAsset>).detail));
    this.gizmo.addEventListener('cursor', (event) => {
      this.cursor.copy((event as CustomEvent<THREE.Vector3>).detail);
      this.hasCursor = true;
      this.updateStatus();
    });
    this.store.addEventListener('selection', () => this.updateStatus());
    this.store.addEventListener('change', () => this.updateStatus());
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
  }

  async loadTile(tileKey: string, mapId: number) {
    if (!tileKey) return;
    this.setStatus(`Loading ${tileKey}…`);
    this.store.select(null);
    const previous = this.tile;
    try {
      const loaded = await this.source.loadTile(tileKey, mapId);
      if (previous) this.scene.remove(previous.group);
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
      const center = loaded.group.position.clone();
      center.z = ((loaded.meta.minHeight ?? 0) + (loaded.meta.maxHeight ?? 20)) * 0.5;
      this.camera.orbit.target.copy(center);
      this.camera.perspective.position.copy(center).add(new THREE.Vector3(90, 90, 65));
      this.camera.perspective.lookAt(center);
      this.hasCursor = false;
      window.history.replaceState(null, '', `?tile=${encodeURIComponent(tileKey)}&map=${mapId}`);
      this.setStatus(`Loaded ${tileKey}: ${loaded.assets.length} reusable M2/WMO assets.`);
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
      const record = [...this.store.records.values()].find((candidate) => candidate.tileKey === patch.tileKey && String(candidate.sourceId ?? candidate.id) === deleted.id);
      if (record) this.store.remove(record);
    }
    for (const modified of patch.modifiedObjects ?? []) {
      const record = [...this.store.records.values()].find((candidate) => candidate.tileKey === patch.tileKey && String(candidate.sourceId ?? candidate.id) === String(modified.id));
      if (!record) continue;
      this.applyWorldTransform(record.object, modified);
      this.store.markModified(record);
    }
    if (patch.environment) {
      this.environment.setHour(patch.environment.hour);
      this.environment.setFog(patch.environment.fogNear, patch.environment.fogFar, patch.environment.fogColor);
      this.environment.setWeather(patch.environment.weather);
    }
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
    this.environment.update(dt, this.camera.active.position);
    this.renderer.render(this.scene, this.camera.active);
  };

  private updateStatus() {
    if (!this.tile) return;
    const selected = this.store.selected;
    const changed = [...this.store.records.values()].filter((record) => record.tileKey === this.tile!.key && record.state !== 'existing' && record.object.visible).length;
    const cursor = this.hasCursor ? ` · Cursor ${this.cursor.x.toFixed(1)}, ${this.cursor.y.toFixed(1)}, ${this.cursor.z.toFixed(1)}` : '';
    this.setStatus(`${this.tile.key} · ${selected ? selected.model.split(/[\\/]/).pop() : 'No selection'} · ${changed} patch change${changed === 1 ? '' : 's'} · Fly ${this.camera.speed.toFixed(0)} yd/s${cursor}`);
  }

  private setStatus(message: string) {
    this.status.textContent = message;
  }
}
