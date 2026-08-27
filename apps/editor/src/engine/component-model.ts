import * as THREE from 'three';
import type { EditorHistory } from '../editor-history';
import type { EditorObjectStore } from '../editor-store';
import type { EditorRecord } from '../types';

export type StudioComponentType =
  | 'EditorMetadata'
  | 'Renderable'
  | 'M2Renderer'
  | 'WmoRenderer'
  | 'Collision'
  | 'CreatureSpawn'
  | 'GameObjectSpawn'
  | 'Light'
  | 'ParticleEmitter'
  | 'AudioSource'
  | 'AreaTrigger'
  | 'Path'
  | 'Portal'
  | 'Script'
  | 'PrefabInstance';

export type ComponentField = {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'color' | 'textarea';
  options?: Array<{ label: string; value: string }>;
  min?: number;
  max?: number;
  step?: number;
  readonly?: boolean;
};

export type ComponentSchema = {
  type: StudioComponentType;
  label: string;
  category: 'Core' | 'Rendering' | 'World' | 'Gameplay' | 'Effects' | 'Scripting';
  fields: ComponentField[];
  defaults: Record<string, unknown>;
  unique?: boolean;
};

export type StudioComponent = {
  type: StudioComponentType;
  enabled: boolean;
  data: Record<string, unknown>;
};

export type StudioEntity = {
  id: string;
  recordId: string;
  name: string;
  tileKey: string;
  kind: EditorRecord['kind'];
  layer: string;
  tags: string[];
  parentId?: string;
  components: StudioComponent[];
};

const SCHEMAS: ComponentSchema[] = [
  { type: 'EditorMetadata', label: 'Editor Metadata', category: 'Core', unique: true, defaults: { layer: 'World', tags: '', locked: false }, fields: [
    { key: 'layer', label: 'Layer', type: 'select', options: ['World','Environment','Gameplay','Debug'].map((value) => ({ label: value, value })) },
    { key: 'tags', label: 'Tags', type: 'string' },
    { key: 'locked', label: 'Locked', type: 'boolean' },
  ] },
  { type: 'Renderable', label: 'Renderer', category: 'Rendering', unique: true, defaults: { visible: true, castShadow: false, receiveShadow: false }, fields: [
    { key: 'visible', label: 'Visible', type: 'boolean' },
    { key: 'castShadow', label: 'Cast Shadow', type: 'boolean' },
    { key: 'receiveShadow', label: 'Receive Shadow', type: 'boolean' },
  ] },
  { type: 'M2Renderer', label: 'M2 Renderer', category: 'Rendering', unique: true, defaults: { model: '', triangles: 0, textures: 0 }, fields: [
    { key: 'model', label: 'Model', type: 'string', readonly: true },
    { key: 'triangles', label: 'Triangles', type: 'number', readonly: true },
    { key: 'textures', label: 'Textures', type: 'number', readonly: true },
  ] },
  { type: 'WmoRenderer', label: 'WMO Renderer', category: 'Rendering', unique: true, defaults: { model: '', groups: 0, triangles: 0, textures: 0 }, fields: [
    { key: 'model', label: 'Model', type: 'string', readonly: true },
    { key: 'groups', label: 'Groups', type: 'number', readonly: true },
    { key: 'triangles', label: 'Triangles', type: 'number', readonly: true },
    { key: 'textures', label: 'Textures', type: 'number', readonly: true },
  ] },
  { type: 'Collision', label: 'Collision', category: 'World', defaults: { enabled: true, mode: 'mesh', debug: false }, fields: [
    { key: 'enabled', label: 'Enabled', type: 'boolean' },
    { key: 'mode', label: 'Mode', type: 'select', options: [{label:'Mesh / BVH',value:'mesh'},{label:'Trigger',value:'trigger'},{label:'None',value:'none'}] },
    { key: 'debug', label: 'Debug Draw', type: 'boolean' },
  ] },
  { type: 'CreatureSpawn', label: 'Creature Spawn', category: 'Gameplay', defaults: { templateEntry: 0, displayId: 0, faction: 0, respawnSeconds: 300 }, fields: [
    { key: 'templateEntry', label: 'Creature Entry', type: 'number', min: 0, step: 1 },
    { key: 'displayId', label: 'Display ID', type: 'number', min: 0, step: 1 },
    { key: 'faction', label: 'Faction', type: 'number', min: 0, step: 1 },
    { key: 'respawnSeconds', label: 'Respawn', type: 'number', min: 0, step: 1 },
  ] },
  { type: 'GameObjectSpawn', label: 'GameObject Spawn', category: 'Gameplay', defaults: { templateEntry: 0, respawnSeconds: 300, state: 1 }, fields: [
    { key: 'templateEntry', label: 'GO Template Entry', type: 'number', min: 0, step: 1 },
    { key: 'respawnSeconds', label: 'Respawn', type: 'number', min: 0, step: 1 },
    { key: 'state', label: 'State', type: 'number', min: 0, max: 2, step: 1 },
  ] },
  { type: 'Light', label: 'Light', category: 'Effects', defaults: { color: '#fff2d2', intensity: 2, radius: 18 }, fields: [
    { key: 'color', label: 'Color', type: 'color' },
    { key: 'intensity', label: 'Intensity', type: 'number', min: 0, step: 0.1 },
    { key: 'radius', label: 'Radius', type: 'number', min: 0, step: 0.5 },
  ] },
  { type: 'ParticleEmitter', label: 'Particle Emitter', category: 'Effects', defaults: { color: '#ffcf75', size: 0.25, rate: 30, lifetime: 1.5 }, fields: [
    { key: 'color', label: 'Color', type: 'color' },
    { key: 'size', label: 'Size', type: 'number', min: 0.01, step: 0.05 },
    { key: 'rate', label: 'Rate', type: 'number', min: 1, step: 1 },
    { key: 'lifetime', label: 'Lifetime', type: 'number', min: 0.05, step: 0.05 },
  ] },
  { type: 'AudioSource', label: 'Audio Source', category: 'Effects', defaults: { url: '', volume: 1, loop: true }, fields: [
    { key: 'url', label: 'Sound URL', type: 'string' },
    { key: 'volume', label: 'Volume', type: 'number', min: 0, max: 1, step: 0.05 },
    { key: 'loop', label: 'Loop', type: 'boolean' },
  ] },
  { type: 'AreaTrigger', label: 'Area Trigger', category: 'Gameplay', defaults: { shape: 'cylinder', radius: 5, height: 3, script: '' }, fields: [
    { key: 'shape', label: 'Shape', type: 'select', options: [{label:'Cylinder',value:'cylinder'},{label:'Box',value:'box'},{label:'Sphere',value:'sphere'}] },
    { key: 'radius', label: 'Radius', type: 'number', min: 0.1, step: 0.25 },
    { key: 'height', label: 'Height', type: 'number', min: 0.1, step: 0.25 },
    { key: 'script', label: 'Script Hook', type: 'string' },
  ] },
  { type: 'Path', label: 'Waypoint Path', category: 'Gameplay', defaults: { name: 'Path', loop: true, speed: 2.5, waypoints: [] }, fields: [
    { key: 'name', label: 'Name', type: 'string' },
    { key: 'loop', label: 'Loop', type: 'boolean' },
    { key: 'speed', label: 'Speed', type: 'number', min: 0.1, step: 0.1 },
  ] },
  { type: 'Portal', label: 'WMO Portal', category: 'World', defaults: { groupA: 0, groupB: 0, enabled: true }, fields: [
    { key: 'groupA', label: 'Group A', type: 'number', step: 1 },
    { key: 'groupB', label: 'Group B', type: 'number', step: 1 },
    { key: 'enabled', label: 'Enabled', type: 'boolean' },
  ] },
  { type: 'Script', label: 'Script', category: 'Scripting', defaults: { module: '', enabled: true, parameters: '{}' }, fields: [
    { key: 'module', label: 'Module', type: 'string' },
    { key: 'enabled', label: 'Enabled', type: 'boolean' },
    { key: 'parameters', label: 'Parameters', type: 'textarea' },
  ] },
  { type: 'PrefabInstance', label: 'Prefab Instance', category: 'Core', defaults: { prefabId: '', unpacked: false }, fields: [
    { key: 'prefabId', label: 'Prefab', type: 'string', readonly: true },
    { key: 'unpacked', label: 'Unpacked', type: 'boolean' },
  ] },
];

const schemaByType = new Map(SCHEMAS.map((schema) => [schema.type, schema]));
const component = (entity: StudioEntity, type: StudioComponentType) => entity.components.find((entry) => entry.type === type) ?? null;

function groupCount(object: THREE.Object3D) {
  const groups = new Set<number>();
  object.traverse((child) => {
    const value = child.userData.editorMaterial?.groupIndex;
    if (Number.isInteger(value)) groups.add(Number(value));
  });
  return groups.size;
}

export class SceneComponentModel extends EventTarget {
  readonly entities = new Map<string, StudioEntity>();

  constructor(readonly store: EditorObjectStore, private readonly history: EditorHistory) {
    super();
    this.syncAll();
    store.addEventListener('change', () => this.syncAll());
    store.addEventListener('selection', () => this.dispatchEvent(new Event('selection')));
  }

  get schemas() { return SCHEMAS; }
  schema(type: StudioComponentType) { return schemaByType.get(type) ?? null; }
  selectedEntity() { return this.store.selected ? this.entities.get(this.store.selected.id) ?? null : null; }
  getComponent(entity: StudioEntity, type: StudioComponentType) { return component(entity, type); }

  syncAll() {
    const live = new Set(this.store.records.keys());
    for (const id of this.entities.keys()) if (!live.has(id)) this.entities.delete(id);
    for (const record of this.store.records.values()) this.syncRecord(record);
    this.dispatchEvent(new Event('change'));
  }

  syncRecord(record: EditorRecord) {
    let entity = this.entities.get(record.id);
    if (!entity) {
      entity = {
        id: record.id,
        recordId: record.id,
        name: record.model.split(/[\\/]/).pop() || record.model,
        tileKey: record.tileKey,
        kind: record.kind,
        layer: 'World',
        tags: [],
        components: [],
      };
      entity.components.push({ type: 'EditorMetadata', enabled: true, data: { ...this.schema('EditorMetadata')!.defaults } });
      entity.components.push({ type: 'Renderable', enabled: true, data: { ...this.schema('Renderable')!.defaults } });
      const rendererType: StudioComponentType | null = record.kind === 'wmo' ? 'WmoRenderer' : record.kind === 'm2' ? 'M2Renderer' : null;
      if (rendererType) entity.components.push({ type: rendererType, enabled: true, data: { ...this.schema(rendererType)!.defaults } });
      this.entities.set(record.id, entity);
    }
    entity.name = record.model.split(/[\\/]/).pop() || record.model;
    entity.tileKey = record.tileKey;
    entity.kind = record.kind;
    const metadata = component(entity, 'EditorMetadata');
    if (metadata) {
      entity.layer = String(metadata.data.layer ?? 'World');
      entity.tags = String(metadata.data.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
    }
    const renderable = component(entity, 'Renderable');
    if (renderable) renderable.data.visible = record.object.visible;
    const renderer = component(entity, record.kind === 'wmo' ? 'WmoRenderer' : 'M2Renderer');
    if (renderer) {
      renderer.data.model = record.model;
      renderer.data.triangles = record.triangles;
      renderer.data.textures = record.textures.length;
      if (renderer.type === 'WmoRenderer') renderer.data.groups = groupCount(record.object);
    }
  }

  addComponent(record: EditorRecord, type: StudioComponentType, seed: Record<string, unknown> = {}) {
    const entity = this.entities.get(record.id) ?? (this.syncRecord(record), this.entities.get(record.id)!);
    const schema = this.schema(type);
    if (!schema) return null;
    if (schema.unique && component(entity, type)) return component(entity, type);
    const next: StudioComponent = { type, enabled: true, data: { ...schema.defaults, ...seed } };
    const redo = () => { if (!entity.components.includes(next)) entity.components.push(next); this.applyRuntime(record, next); this.changed(); };
    const undo = () => { const index = entity.components.indexOf(next); if (index >= 0) entity.components.splice(index, 1); this.removeRuntime(record, type); this.changed(); };
    this.history.execute({ label: `Add ${schema.label}`, redo, undo });
    return next;
  }

  removeComponent(record: EditorRecord, type: StudioComponentType) {
    const entity = this.entities.get(record.id);
    if (!entity || type === 'EditorMetadata' || type === 'Renderable' || type === 'M2Renderer' || type === 'WmoRenderer') return;
    const existing = component(entity, type);
    if (!existing) return;
    const index = entity.components.indexOf(existing);
    this.history.execute({
      label: `Remove ${this.schema(type)?.label ?? type}`,
      redo: () => { const at = entity.components.indexOf(existing); if (at >= 0) entity.components.splice(at, 1); this.removeRuntime(record, type); this.changed(); },
      undo: () => { entity.components.splice(Math.min(index, entity.components.length), 0, existing); this.applyRuntime(record, existing); this.changed(); },
    });
  }

  setComponentValue(record: EditorRecord, type: StudioComponentType, key: string, value: unknown) {
    const entity = this.entities.get(record.id);
    const target = entity ? component(entity, type) : null;
    if (!entity || !target) return;
    const before = target.data[key];
    if (Object.is(before, value)) return;
    const apply = (next: unknown) => {
      target.data[key] = next;
      if (type === 'EditorMetadata') {
        entity.layer = String(target.data.layer ?? 'World');
        entity.tags = String(target.data.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
      }
      this.applyRuntime(record, target);
      this.store.markModified(record);
      this.changed();
    };
    this.history.execute({ label: `${this.schema(type)?.label ?? type}: ${key}`, redo: () => apply(value), undo: () => apply(before) });
  }

  serializeEntity(entity: StudioEntity) {
    return {
      id: entity.id,
      recordId: entity.recordId,
      name: entity.name,
      tileKey: entity.tileKey,
      kind: entity.kind,
      layer: entity.layer,
      tags: [...entity.tags],
      parentId: entity.parentId,
      components: entity.components.map((entry) => ({ type: entry.type, enabled: entry.enabled, data: structuredClone(entry.data) })),
    };
  }

  hydrateEntity(record: EditorRecord, snapshot: ReturnType<SceneComponentModel['serializeEntity']>) {
    const entity: StudioEntity = {
      id: record.id,
      recordId: record.id,
      name: snapshot.name,
      tileKey: record.tileKey,
      kind: record.kind,
      layer: snapshot.layer,
      tags: [...snapshot.tags],
      parentId: snapshot.parentId,
      components: snapshot.components.map((entry) => ({ type: entry.type, enabled: entry.enabled, data: structuredClone(entry.data) })),
    };
    this.entities.set(record.id, entity);
    for (const entry of entity.components) this.applyRuntime(record, entry);
    this.changed();
    return entity;
  }

  private applyRuntime(record: EditorRecord, target: StudioComponent) {
    if (target.type === 'Renderable') {
      record.object.visible = target.data.visible !== false;
      record.object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = target.data.castShadow === true;
        mesh.receiveShadow = target.data.receiveShadow === true;
      });
    }
    if (target.type === 'EditorMetadata') {
      record.object.userData.studioLayer = String(target.data.layer ?? 'World');
      record.object.userData.studioLocked = target.data.locked === true;
    }
    if (target.type === 'Collision') record.object.userData.studioCollision = { ...target.data };
    if (target.type === 'Light') this.updateLight(record, target);
    if (target.type === 'ParticleEmitter') this.updateParticlePreview(record, target);
    if (target.type === 'AreaTrigger') record.object.userData.studioAreaTrigger = { ...target.data };
    if (target.type === 'Path') record.object.userData.studioPath = structuredClone(target.data);
    if (target.type === 'CreatureSpawn' || target.type === 'GameObjectSpawn') record.object.userData.studioServerSpawn = { type: target.type, ...target.data };
  }

  private removeRuntime(record: EditorRecord, type: StudioComponentType) {
    if (type === 'Light') record.object.getObjectByName('__studio_light')?.removeFromParent();
    if (type === 'ParticleEmitter') record.object.getObjectByName('__studio_particles')?.removeFromParent();
    if (type === 'Collision') delete record.object.userData.studioCollision;
    if (type === 'AreaTrigger') delete record.object.userData.studioAreaTrigger;
    if (type === 'Path') delete record.object.userData.studioPath;
    if (type === 'CreatureSpawn' || type === 'GameObjectSpawn') delete record.object.userData.studioServerSpawn;
  }

  private updateLight(record: EditorRecord, target: StudioComponent) {
    let light = record.object.getObjectByName('__studio_light') as THREE.PointLight | undefined;
    if (!light) {
      light = new THREE.PointLight();
      light.name = '__studio_light';
      light.userData.editorNonSelectable = true;
      record.object.add(light);
    }
    light.color.set(String(target.data.color ?? '#ffffff'));
    light.intensity = Number(target.data.intensity ?? 1);
    light.distance = Number(target.data.radius ?? 20);
  }

  private updateParticlePreview(record: EditorRecord, target: StudioComponent) {
    let points = record.object.getObjectByName('__studio_particles') as THREE.Points | undefined;
    if (!points) {
      const positions = new Float32Array(96 * 3);
      for (let i = 0; i < 96; i++) {
        const angle = i * 2.399963;
        const radius = 0.15 + (i % 17) / 17;
        positions[i * 3] = Math.cos(angle) * radius;
        positions[i * 3 + 1] = Math.sin(angle) * radius;
        positions[i * 3 + 2] = (i % 23) / 11;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      points = new THREE.Points(geometry, new THREE.PointsMaterial());
      points.name = '__studio_particles';
      points.userData.editorNonSelectable = true;
      record.object.add(points);
    }
    const material = points.material as THREE.PointsMaterial;
    material.color.set(String(target.data.color ?? '#ffffff'));
    material.size = Number(target.data.size ?? 0.25);
    material.transparent = true;
    material.opacity = 0.8;
  }

  private changed() { this.dispatchEvent(new Event('change')); }
}
