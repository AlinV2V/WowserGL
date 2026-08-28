import * as THREE from 'three';
import type { EditorObjectStore } from '../editor-store';
import type { SceneComponentModel } from './component-model';

export type ValidationSeverity = 'error' | 'warning' | 'info';
export type ValidationIssue = { id: string; severity: ValidationSeverity; code: string; message: string; recordId?: string };
export type ValidationInput = Omit<ValidationIssue, 'id'> & { id?: string };
export type StudioValidatorFn = (store: EditorObjectStore, components: SceneComponentModel) => ValidationInput[];

const finite = (values: number[]) => values.every(Number.isFinite);

export class StudioValidator extends EventTarget {
  issues: ValidationIssue[] = [];
  private extra: StudioValidatorFn[] = [];
  private timer = 0;

  constructor(private readonly store: EditorObjectStore, private readonly components: SceneComponentModel) {
    super();
    const schedule = () => this.schedule();
    store.addEventListener('change', schedule);
    components.addEventListener('change', schedule);
    this.run();
  }

  register(validator: StudioValidatorFn) { this.extra.push(validator); this.run(); }

  run() {
    const issues: ValidationIssue[] = [];
    const sourceIds = new Map<string, string>();
    for (const record of this.store.records.values()) {
      const p = record.object.position, q = record.object.quaternion, s = record.object.scale;
      if (!finite([...p.toArray(), ...q.toArray(), ...s.toArray()])) issues.push(this.issue('error', 'INVALID_TRANSFORM', 'Transform contains NaN/Infinity.', record.id));
      if (Math.min(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)) < 0.0001) issues.push(this.issue('warning', 'ZERO_SCALE', 'Object has effectively zero scale.', record.id));
      if (Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)) > 100) issues.push(this.issue('warning', 'EXTREME_SCALE', 'Object scale is larger than 100×.', record.id));
      if (!record.model.trim()) issues.push(this.issue('error', 'MISSING_MODEL', 'Object has no model path.', record.id));
      if (!record.textures.length && (record.kind === 'm2' || record.kind === 'wmo')) issues.push(this.issue('info', 'NO_TEXTURE_REFERENCES', 'No texture dependencies were recorded for this renderer.', record.id));
      if (record.state === 'deleted' && record.object.visible) issues.push(this.issue('error', 'DELETE_VISIBILITY_MISMATCH', 'Deleted object is still visible.', record.id));
      if (record.sourceId !== undefined) {
        const key = `${record.tileKey}|${record.kind}|${record.model.toLowerCase()}|${record.sourceId}`;
        const prior = sourceIds.get(key);
        if (prior && prior !== record.id) issues.push(this.issue('error', 'DUPLICATE_SOURCE_ID', `Duplicate source identity with ${prior}.`, record.id));
        else sourceIds.set(key, record.id);
      }
      const entity = this.components.entities.get(record.id);
      if (entity) {
        const creature = this.components.getComponent(entity, 'CreatureSpawn');
        const gameobject = this.components.getComponent(entity, 'GameObjectSpawn');
        const path = this.components.getComponent(entity, 'Path');
        const trigger = this.components.getComponent(entity, 'AreaTrigger');
        const script = this.components.getComponent(entity, 'Script');
        const prefab = this.components.getComponent(entity, 'PrefabInstance');
        if (creature && Number(creature.data.templateEntry ?? 0) <= 0) issues.push(this.issue('warning', 'CREATURE_ENTRY_REQUIRED', 'Creature spawn has no server template entry.', record.id));
        if (gameobject && Number(gameobject.data.templateEntry ?? 0) <= 0) issues.push(this.issue('warning', 'GAMEOBJECT_ENTRY_REQUIRED', 'GameObject spawn has no server template entry.', record.id));
        if (creature && gameobject) issues.push(this.issue('error', 'SERVER_SPAWN_CONFLICT', 'An entity cannot export as both a Creature and a GameObject spawn.', record.id));
        if (creature) {
          const movement = String(creature.data.movementMode ?? 'idle');
          if (!['idle', 'random', 'waypoints'].includes(movement)) issues.push(this.issue('error', 'CREATURE_MOVEMENT_MODE', `Unknown creature movement mode: ${movement}.`, record.id));
          if (movement === 'random' && Number(creature.data.wanderDistance ?? 5) <= 0) issues.push(this.issue('warning', 'CREATURE_WANDER_RADIUS', 'Random movement should have a wander radius greater than zero.', record.id));
        }
        if (path) {
          const waypoints = Array.isArray(path.data.waypoints) ? path.data.waypoints : [];
          if (!creature) issues.push(this.issue('warning', 'PATH_WITHOUT_CREATURE', 'Waypoint path is authored on an entity without CreatureSpawn.', record.id));
          if (!waypoints.length) issues.push(this.issue('info', 'PATH_EMPTY', 'Waypoint Path has no authored points.', record.id));
          if (creature && String(creature.data.movementMode ?? 'idle') === 'waypoints' && !waypoints.length) issues.push(this.issue('warning', 'CREATURE_WAYPOINTS_EMPTY', 'Creature movement is set to waypoints but no path points are authored.', record.id));
          if (waypoints.some((point) => !Array.isArray(point) || point.length < 3 || !finite(point.slice(0, 3).map(Number)))) issues.push(this.issue('error', 'PATH_INVALID_POINT', 'Waypoint path contains an invalid coordinate.', record.id));
        } else if (creature && String(creature.data.movementMode ?? 'idle') === 'waypoints') issues.push(this.issue('warning', 'CREATURE_PATH_REQUIRED', 'Creature movement is set to waypoints but the entity has no Path component.', record.id));
        if (trigger && (Number(trigger.data.radius ?? 0) <= 0 || Number(trigger.data.height ?? 0) <= 0)) issues.push(this.issue('error', 'TRIGGER_DIMENSION', 'Area trigger radius/height must be greater than zero.', record.id));
        if (script && script.data.enabled !== false && !String(script.data.module ?? '').trim()) issues.push(this.issue('warning', 'EMPTY_SCRIPT', 'Script component is enabled but has no module.', record.id));
        if (script && String(script.data.parameters ?? '').trim()) {
          try { JSON.parse(String(script.data.parameters)); }
          catch { issues.push(this.issue('error', 'SCRIPT_PARAMETERS_JSON', 'Script parameters must be valid JSON.', record.id)); }
        }
        if (prefab && !String(prefab.data.prefabId ?? '').trim()) issues.push(this.issue('error', 'PREFAB_ID_REQUIRED', 'PrefabInstance has no prefab definition ID.', record.id));
        if (entity.parentId && !this.store.records.has(entity.parentId)) issues.push(this.issue('warning', 'PARENT_MISSING', `Parent entity ${entity.parentId} is not present in this scene.`, record.id));
        if (entity.parentId && this.hasParentCycle(entity.id)) issues.push(this.issue('error', 'PARENT_CYCLE', 'Hierarchy parenting contains a cycle.', record.id));
      }
      const box = new THREE.Box3().setFromObject(record.object);
      if (!box.isEmpty() && !finite([...box.min.toArray(), ...box.max.toArray()])) issues.push(this.issue('error', 'INVALID_BOUNDS', 'Renderable generated invalid world bounds.', record.id));
    }
    for (const validator of this.extra) {
      try {
        for (const input of validator(this.store, this.components)) {
          issues.push(input.id ? input as ValidationIssue : this.issue(input.severity, input.code, input.message, input.recordId));
        }
      } catch (error) { issues.push(this.issue('error', 'PLUGIN_VALIDATOR_FAILED', error instanceof Error ? error.message : String(error))); }
    }
    this.issues = issues;
    this.dispatchEvent(new CustomEvent('change', { detail: issues }));
    return issues;
  }

  counts() {
    return {
      errors: this.issues.filter((issue) => issue.severity === 'error').length,
      warnings: this.issues.filter((issue) => issue.severity === 'warning').length,
      info: this.issues.filter((issue) => issue.severity === 'info').length,
    };
  }

  issuesFor(recordId: string) { return this.issues.filter((issue) => issue.recordId === recordId); }

  private hasParentCycle(startId: string) {
    let cursor = this.components.entities.get(startId)?.parentId;
    const seen = new Set([startId]);
    while (cursor) {
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      cursor = this.components.entities.get(cursor)?.parentId;
    }
    return false;
  }

  private schedule() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.run(), 120);
  }

  private issue(severity: ValidationSeverity, code: string, message: string, recordId?: string): ValidationIssue {
    return { id: `${code}:${recordId ?? 'project'}:${Math.random().toString(36).slice(2, 7)}`, severity, code, message, recordId };
  }
}
