import type { EditorCameraController } from '../editor-camera';
import type { EditorObjectStore } from '../editor-store';
import type { EditorRecord } from '../types';
import type { SceneComponentModel } from './component-model';

export type StudioLayer = { id: string; name: string; visible: boolean; locked: boolean };
export type StudioBookmark = { id: string; name: string; position: [number, number, number]; quaternion: [number, number, number, number]; target: [number, number, number] };
export type SerializedStudioEntity = ReturnType<SceneComponentModel['serializeEntity']>;
export type StudioPrefab = { id: string; name: string; model: string; kind: EditorRecord['kind']; entity: SerializedStudioEntity; createdAt: string };
export type StudioEntityBinding = { sourceKey: string; entity: SerializedStudioEntity };

export type StudioProjectDocument = {
  version: 2;
  format: 'wowsergl-studio-project';
  projectId: string;
  name: string;
  mapId: number;
  tileKey: string;
  savedAt: string;
  entities: SerializedStudioEntity[];
  bindings: StudioEntityBinding[];
  layers: StudioLayer[];
  bookmarks: StudioBookmark[];
  prefabs: StudioPrefab[];
  settings: { autosave: boolean; liveSyncPreferred: boolean; authoritativeGameView: boolean };
};

const STORAGE = 'wowsergl:project:v2';
const RECOVERY = 'wowsergl:recovery:v2';
const uuid = () => crypto.randomUUID?.() ?? `studio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const sourceKey = (record: EditorRecord) => `${record.tileKey}|${record.kind}|${record.model.replaceAll('\\', '/').toLowerCase()}|${record.sourceId ?? record.id}`;

const defaultLayers = (): StudioLayer[] => [
  { id: 'World', name: 'World', visible: true, locked: false },
  { id: 'Environment', name: 'Environment', visible: true, locked: false },
  { id: 'Gameplay', name: 'Gameplay', visible: true, locked: false },
  { id: 'Debug', name: 'Debug', visible: true, locked: false },
];

export class ProjectWorkspace extends EventTarget {
  projectId = uuid();
  name = 'VanillaGL World';
  layers = defaultLayers();
  bookmarks: StudioBookmark[] = [];
  prefabs: StudioPrefab[] = [];
  settings = { autosave: true, liveSyncPreferred: false, authoritativeGameView: true };
  private saveTimer = 0;
  private recoveryTimer = 0;
  private savedBindings = new Map<string, SerializedStudioEntity>();
  private restoredRecords = new Set<string>();
  recoveryAvailable = false;

  constructor(private readonly store: EditorObjectStore, private readonly components: SceneComponentModel) {
    super();
    this.loadMetadata();
    this.recoveryAvailable = this.hasNewerRecovery();
    const storeChanged = () => {
      this.restoreComponentState();
      this.scheduleSave();
    };
    store.addEventListener('change', storeChanged);
    components.addEventListener('change', () => this.scheduleSave());
    this.restoreComponentState();
    this.recoveryTimer = window.setInterval(() => this.writeRecovery(), 12000);
    window.addEventListener('beforeunload', () => { this.writeRecovery(); window.clearInterval(this.recoveryTimer); });
  }

  snapshot(): StudioProjectDocument {
    const params = new URLSearchParams(location.search);
    const entities = [...this.components.entities.values()].map((entity) => this.components.serializeEntity(entity));
    const bindings: StudioEntityBinding[] = [];
    for (const record of this.store.records.values()) {
      const entity = this.components.entities.get(record.id);
      if (entity) bindings.push({ sourceKey: sourceKey(record), entity: this.components.serializeEntity(entity) });
    }
    return {
      version: 2,
      format: 'wowsergl-studio-project',
      projectId: this.projectId,
      name: this.name,
      mapId: Number(params.get('map') ?? 0),
      tileKey: this.store.tileKey,
      savedAt: new Date().toISOString(),
      entities,
      bindings,
      layers: this.layers.map((layer) => ({ ...layer })),
      bookmarks: this.bookmarks.map((bookmark) => ({ ...bookmark, position: [...bookmark.position], quaternion: [...bookmark.quaternion], target: [...bookmark.target] })),
      prefabs: this.prefabs.map((prefab) => structuredClone(prefab)),
      settings: { ...this.settings },
    };
  }

  save() {
    const project = this.snapshot();
    localStorage.setItem(STORAGE, JSON.stringify(project));
    localStorage.removeItem(RECOVERY);
    this.savedBindings = new Map(project.bindings.map((binding) => [binding.sourceKey, structuredClone(binding.entity)]));
    this.recoveryAvailable = false;
    this.dispatchEvent(new CustomEvent('saved', { detail: project }));
    return project;
  }

  exportFile() {
    const project = this.save();
    const url = URL.createObjectURL(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }));
    const anchor = globalThis.document.createElement('a');
    anchor.href = url;
    anchor.download = `${this.name.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase() || 'wowsergl_project'}.wowsergl.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  createPrefab(record: EditorRecord) {
    const entity = this.components.entities.get(record.id);
    if (!entity) return null;
    const prefab: StudioPrefab = {
      id: uuid(),
      name: entity.name,
      model: record.model,
      kind: record.kind,
      entity: this.components.serializeEntity(entity),
      createdAt: new Date().toISOString(),
    };
    this.prefabs.push(prefab);
    this.scheduleSave();
    this.dispatchEvent(new CustomEvent('prefab', { detail: prefab }));
    return prefab;
  }

  removePrefab(id: string) {
    const index = this.prefabs.findIndex((prefab) => prefab.id === id);
    if (index < 0) return;
    this.prefabs.splice(index, 1);
    this.scheduleSave();
    this.dispatchEvent(new Event('change'));
  }

  addBookmark(camera: EditorCameraController, name = `Bookmark ${this.bookmarks.length + 1}`) {
    const active = camera.active;
    const bookmark: StudioBookmark = {
      id: uuid(),
      name,
      position: active.position.toArray() as [number, number, number],
      quaternion: active.quaternion.toArray() as [number, number, number, number],
      target: camera.orbit.target.toArray() as [number, number, number],
    };
    this.bookmarks.push(bookmark);
    this.scheduleSave();
    this.dispatchEvent(new Event('change'));
    return bookmark;
  }

  applyBookmark(camera: EditorCameraController, bookmark: StudioBookmark) {
    camera.perspective.position.fromArray(bookmark.position);
    camera.perspective.quaternion.fromArray(bookmark.quaternion);
    camera.orbit.target.fromArray(bookmark.target);
    camera.orbit.update();
  }

  setLayer(id: string, patch: Partial<StudioLayer>) {
    const layer = this.layers.find((item) => item.id === id);
    if (!layer) return;
    Object.assign(layer, patch);
    for (const entity of this.components.entities.values()) {
      if (entity.layer !== id) continue;
      const record = this.store.records.get(entity.recordId);
      if (!record) continue;
      record.object.visible = layer.visible;
      record.object.userData.studioLayerLocked = layer.locked;
    }
    this.scheduleSave();
    this.dispatchEvent(new Event('change'));
  }

  restoreRecoveryMetadata() {
    const raw = localStorage.getItem(RECOVERY);
    if (!raw) return false;
    try {
      const project = JSON.parse(raw) as StudioProjectDocument;
      if (project.version !== 2) return false;
      this.applyMetadata(project);
      this.restoredRecords.clear();
      this.restoreComponentState();
      this.recoveryAvailable = false;
      localStorage.setItem(STORAGE, raw);
      localStorage.removeItem(RECOVERY);
      this.dispatchEvent(new Event('change'));
      return true;
    } catch { return false; }
  }

  private restoreComponentState() {
    if (!this.savedBindings.size) return;
    for (const record of this.store.records.values()) {
      if (this.restoredRecords.has(record.id)) continue;
      const snapshot = this.savedBindings.get(sourceKey(record));
      if (!snapshot) continue;
      this.restoredRecords.add(record.id);
      this.components.hydrateEntity(record, snapshot);
    }
  }

  private loadMetadata() {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return;
    try {
      const project = JSON.parse(raw) as StudioProjectDocument;
      if (project.version === 2 && project.format === 'wowsergl-studio-project') this.applyMetadata(project);
    } catch { /* malformed local workspace is ignored */ }
  }

  private applyMetadata(project: StudioProjectDocument) {
    this.projectId = project.projectId || this.projectId;
    this.name = project.name || this.name;
    this.layers = project.layers?.length ? project.layers.map((layer) => ({ ...layer })) : defaultLayers();
    this.bookmarks = (project.bookmarks ?? []).map((bookmark) => structuredClone(bookmark));
    this.prefabs = (project.prefabs ?? []).map((prefab) => structuredClone(prefab));
    this.settings = { ...this.settings, ...(project.settings ?? {}) };
    const bindings = project.bindings?.length
      ? project.bindings
      : (project.entities ?? []).map((entity) => ({ sourceKey: `${entity.tileKey}|${entity.kind}|legacy|${entity.recordId}`, entity }));
    this.savedBindings = new Map(bindings.map((binding) => [binding.sourceKey, structuredClone(binding.entity)]));
  }

  private scheduleSave() {
    this.dispatchEvent(new Event('change'));
    if (!this.settings.autosave) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      localStorage.setItem(STORAGE, JSON.stringify(this.snapshot()));
    }, 900);
  }

  private writeRecovery() {
    try { localStorage.setItem(RECOVERY, JSON.stringify(this.snapshot())); } catch { /* quota/full storage */ }
  }

  private hasNewerRecovery() {
    try {
      const recovery = JSON.parse(localStorage.getItem(RECOVERY) ?? 'null') as StudioProjectDocument | null;
      const saved = JSON.parse(localStorage.getItem(STORAGE) ?? 'null') as StudioProjectDocument | null;
      return !!recovery && (!saved || new Date(recovery.savedAt).getTime() > new Date(saved.savedAt).getTime());
    } catch { return false; }
  }
}
