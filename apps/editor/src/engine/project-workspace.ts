import type { EditorCameraController } from '../editor-camera';
import type { EditorObjectStore } from '../editor-store';
import type { EditorRecord } from '../types';
import type { SceneComponentModel } from './component-model';

export type StudioLayer = { id: string; name: string; visible: boolean; locked: boolean };
export type StudioBookmark = { id: string; name: string; position: [number, number, number]; quaternion: [number, number, number, number]; target: [number, number, number] };
export type SerializedStudioEntity = ReturnType<SceneComponentModel['serializeEntity']>;
export type StudioPrefab = { id: string; name: string; model: string; kind: EditorRecord['kind']; entity: SerializedStudioEntity; createdAt: string; updatedAt?: string };
export type StudioEntityBinding = { sourceKey: string; entity: SerializedStudioEntity };
export type RecentStudioProject = { projectId: string; name: string; mapId: number; tileKey: string; savedAt: string };

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
const RECENTS = 'wowsergl:recent-projects:v2';
const uuid = (): string => crypto.randomUUID?.() ?? `studio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const sourceKey = (record: EditorRecord) => `${record.tileKey}|${record.kind}|${record.model.replaceAll('\\', '/').toLowerCase()}|${record.sourceId ?? record.id}`;

const defaultLayers = (): StudioLayer[] => [
  { id: 'World', name: 'World', visible: true, locked: false },
  { id: 'Environment', name: 'Environment', visible: true, locked: false },
  { id: 'Gameplay', name: 'Gameplay', visible: true, locked: false },
  { id: 'Debug', name: 'Debug', visible: true, locked: false },
];

const prefabPayload = (entity: SerializedStudioEntity): SerializedStudioEntity => ({
  ...structuredClone(entity),
  parentId: undefined,
  components: entity.components.filter((entry) => entry.type !== 'PrefabInstance').map((entry) => structuredClone(entry)),
});

const comparablePrefab = (entity: SerializedStudioEntity) => JSON.stringify({
  name: entity.name,
  layer: entity.layer,
  tags: [...entity.tags].sort(),
  components: entity.components
    .filter((entry) => entry.type !== 'PrefabInstance')
    .map((entry) => ({ type: entry.type, enabled: entry.enabled, data: entry.data }))
    .sort((a, b) => a.type.localeCompare(b.type)),
});

export class ProjectWorkspace extends EventTarget {
  projectId: string = uuid();
  name = 'VanillaGL World';
  layers = defaultLayers();
  bookmarks: StudioBookmark[] = [];
  prefabs: StudioPrefab[] = [];
  recentProjects: RecentStudioProject[] = [];
  settings = { autosave: true, liveSyncPreferred: false, authoritativeGameView: true };
  private saveTimer = 0;
  private recoveryTimer = 0;
  private savedBindings = new Map<string, SerializedStudioEntity>();
  private restoredRecords = new Set<string>();
  recoveryAvailable = false;

  constructor(private readonly store: EditorObjectStore, private readonly components: SceneComponentModel) {
    super();
    this.recentProjects = this.loadRecents();
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
    this.rememberRecent(project);
    this.dispatchEvent(new CustomEvent('saved', { detail: project }));
    return project;
  }

  saveAs(name: string) {
    const clean = name.trim();
    if (clean) this.name = clean;
    return this.save();
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

  async importFile(file: File) {
    const project = JSON.parse(await file.text()) as StudioProjectDocument;
    if (project.version !== 2 || project.format !== 'wowsergl-studio-project') throw new Error('Unsupported WowserGL Studio workspace format.');
    this.applyMetadata(project);
    this.restoredRecords.clear();
    this.restoreComponentState();
    localStorage.setItem(STORAGE, JSON.stringify(project));
    localStorage.removeItem(RECOVERY);
    this.recoveryAvailable = false;
    this.rememberRecent(project);
    this.dispatchEvent(new CustomEvent('imported', { detail: project }));
    this.dispatchEvent(new Event('change'));
    return project;
  }

  createPrefab(record: EditorRecord) {
    const entity = this.components.entities.get(record.id);
    if (!entity) return null;
    const now = new Date().toISOString();
    const prefab: StudioPrefab = {
      id: uuid(),
      name: entity.name,
      model: record.model,
      kind: record.kind,
      entity: prefabPayload(this.components.serializeEntity(entity)),
      createdAt: now,
      updatedAt: now,
    };
    this.prefabs.push(prefab);
    this.components.addComponent(record, 'PrefabInstance', { prefabId: prefab.id, unpacked: false });
    this.scheduleSave();
    this.dispatchEvent(new CustomEvent('prefab', { detail: prefab }));
    return prefab;
  }

  prefabForRecord(record: EditorRecord) {
    const entity = this.components.entities.get(record.id);
    const instance = entity ? this.components.getComponent(entity, 'PrefabInstance') : null;
    const id = String(instance?.data.prefabId ?? '');
    return id ? this.prefabs.find((prefab) => prefab.id === id) ?? null : null;
  }

  isPrefabOverridden(record: EditorRecord) {
    const prefab = this.prefabForRecord(record);
    const entity = this.components.entities.get(record.id);
    return !!prefab && !!entity && comparablePrefab(this.components.serializeEntity(entity)) !== comparablePrefab(prefab.entity);
  }

  applyInstanceToPrefab(record: EditorRecord) {
    const prefab = this.prefabForRecord(record);
    const entity = this.components.entities.get(record.id);
    if (!prefab || !entity) return false;
    prefab.entity = prefabPayload(this.components.serializeEntity(entity));
    prefab.name = entity.name;
    prefab.updatedAt = new Date().toISOString();
    this.scheduleSave();
    this.dispatchEvent(new CustomEvent('prefab-updated', { detail: prefab }));
    return true;
  }

  revertPrefabInstance(record: EditorRecord) {
    const prefab = this.prefabForRecord(record);
    if (!prefab) return false;
    const snapshot = prefabPayload(prefab.entity);
    snapshot.components.push({ type: 'PrefabInstance', enabled: true, data: { prefabId: prefab.id, unpacked: false } });
    this.components.hydrateEntity(record, snapshot);
    this.scheduleSave();
    return true;
  }

  unpackPrefab(record: EditorRecord) {
    const prefab = this.prefabForRecord(record);
    if (!prefab) return false;
    this.components.removeComponent(record, 'PrefabInstance');
    this.scheduleSave();
    return true;
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

  removeBookmark(id: string) {
    const index = this.bookmarks.findIndex((bookmark) => bookmark.id === id);
    if (index < 0) return;
    this.bookmarks.splice(index, 1);
    this.scheduleSave();
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
      const project = this.snapshot();
      localStorage.setItem(STORAGE, JSON.stringify(project));
      this.rememberRecent(project);
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

  private loadRecents(): RecentStudioProject[] {
    try {
      const value = JSON.parse(localStorage.getItem(RECENTS) ?? '[]') as RecentStudioProject[];
      return Array.isArray(value) ? value.slice(0, 8) : [];
    } catch { return []; }
  }

  private rememberRecent(project: StudioProjectDocument) {
    const entry: RecentStudioProject = { projectId: project.projectId, name: project.name, mapId: project.mapId, tileKey: project.tileKey, savedAt: project.savedAt };
    this.recentProjects = [entry, ...this.recentProjects.filter((item) => item.projectId !== entry.projectId)].slice(0, 8);
    localStorage.setItem(RECENTS, JSON.stringify(this.recentProjects));
  }
}
