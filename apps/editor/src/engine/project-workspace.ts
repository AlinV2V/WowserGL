import * as THREE from 'three';
import type { EditorCameraController } from '../editor-camera';
import type { EditorObjectStore } from '../editor-store';
import type { EditorRecord } from '../types';
import type { SceneComponentModel, StudioEntity } from './component-model';

export type StudioLayer = { id: string; name: string; visible: boolean; locked: boolean };
export type StudioBookmark = { id: string; name: string; position: [number, number, number]; quaternion: [number, number, number, number]; target: [number, number, number] };
export type StudioPrefab = { id: string; name: string; model: string; kind: EditorRecord['kind']; entity: ReturnType<SceneComponentModel['serializeEntity']>; createdAt: string };

export type StudioProjectDocument = {
  version: 2;
  format: 'wowsergl-studio-project';
  projectId: string;
  name: string;
  mapId: number;
  tileKey: string;
  savedAt: string;
  entities: Array<ReturnType<SceneComponentModel['serializeEntity']>>;
  layers: StudioLayer[];
  bookmarks: StudioBookmark[];
  prefabs: StudioPrefab[];
  settings: { autosave: boolean; liveSyncPreferred: boolean; authoritativeGameView: boolean };
};

const STORAGE = 'wowsergl:project:v2';
const RECOVERY = 'wowsergl:recovery:v2';
const uuid = () => crypto.randomUUID?.() ?? `studio-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
  recoveryAvailable = false;

  constructor(private readonly store: EditorObjectStore, private readonly components: SceneComponentModel) {
    super();
    this.loadMetadata();
    this.recoveryAvailable = this.hasNewerRecovery();
    const dirty = () => this.scheduleSave();
    store.addEventListener('change', dirty);
    components.addEventListener('change', dirty);
    this.recoveryTimer = window.setInterval(() => this.writeRecovery(), 12000);
    window.addEventListener('beforeunload', () => { this.writeRecovery(); window.clearInterval(this.recoveryTimer); });
  }

  snapshot(): StudioProjectDocument {
    const params = new URLSearchParams(location.search);
    return {
      version: 2,
      format: 'wowsergl-studio-project',
      projectId: this.projectId,
      name: this.name,
      mapId: Number(params.get('map') ?? 0),
      tileKey: this.store.tileKey,
      savedAt: new Date().toISOString(),
      entities: [...this.components.entities.values()].map((entity) => this.components.serializeEntity(entity)),
      layers: this.layers.map((layer) => ({ ...layer })),
      bookmarks: this.bookmarks.map((bookmark) => ({ ...bookmark, position: [...bookmark.position], quaternion: [...bookmark.quaternion], target: [...bookmark.target] })),
      prefabs: this.prefabs.map((prefab) => structuredClone(prefab)),
      settings: { ...this.settings },
    };
  }

  save() {
    const document = this.snapshot();
    localStorage.setItem(STORAGE, JSON.stringify(document));
    localStorage.removeItem(RECOVERY);
    this.recoveryAvailable = false;
    this.dispatchEvent(new CustomEvent('saved', { detail: document }));
    return document;
  }

  exportFile() {
    const document = this.save();
    const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
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
      const document = JSON.parse(raw) as StudioProjectDocument;
      if (document.version !== 2) return false;
      this.applyMetadata(document);
      this.recoveryAvailable = false;
      localStorage.setItem(STORAGE, raw);
      localStorage.removeItem(RECOVERY);
      this.dispatchEvent(new Event('change'));
      return true;
    } catch { return false; }
  }

  private loadMetadata() {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return;
    try {
      const document = JSON.parse(raw) as StudioProjectDocument;
      if (document.version === 2 && document.format === 'wowsergl-studio-project') this.applyMetadata(document);
    } catch { /* malformed local workspace is ignored */ }
  }

  private applyMetadata(document: StudioProjectDocument) {
    this.projectId = document.projectId || this.projectId;
    this.name = document.name || this.name;
    this.layers = document.layers?.length ? document.layers.map((layer) => ({ ...layer })) : defaultLayers();
    this.bookmarks = (document.bookmarks ?? []).map((bookmark) => structuredClone(bookmark));
    this.prefabs = (document.prefabs ?? []).map((prefab) => structuredClone(prefab));
    this.settings = { ...this.settings, ...(document.settings ?? {}) };
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
