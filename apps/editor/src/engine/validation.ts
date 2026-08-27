import * as THREE from 'three';
import type { EditorObjectStore } from '../editor-store';
import type { SceneComponentModel } from './component-model';

export type ValidationSeverity = 'error' | 'warning' | 'info';
export type ValidationIssue = { id: string; severity: ValidationSeverity; code: string; message: string; recordId?: string };
export type StudioValidatorFn = (store: EditorObjectStore, components: SceneComponentModel) => ValidationIssue[];

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
        if (creature && Number(creature.data.templateEntry ?? 0) <= 0) issues.push(this.issue('warning', 'CREATURE_ENTRY_REQUIRED', 'Creature spawn has no server template entry.', record.id));
        const gameobject = this.components.getComponent(entity, 'GameObjectSpawn');
        if (gameobject && Number(gameobject.data.templateEntry ?? 0) <= 0) issues.push(this.issue('warning', 'GAMEOBJECT_ENTRY_REQUIRED', 'GameObject spawn has no server template entry.', record.id));
        const script = this.components.getComponent(entity, 'Script');
        if (script && script.data.enabled !== false && !String(script.data.module ?? '').trim()) issues.push(this.issue('warning', 'EMPTY_SCRIPT', 'Script component is enabled but has no module.', record.id));
      }
      const box = new THREE.Box3().setFromObject(record.object);
      if (!box.isEmpty() && !finite([...box.min.toArray(), ...box.max.toArray()])) issues.push(this.issue('error', 'INVALID_BOUNDS', 'Renderable generated invalid world bounds.', record.id));
    }
    for (const validator of this.extra) {
      try { issues.push(...validator(this.store, this.components)); }
      catch (error) { issues.push(this.issue('error', 'PLUGIN_VALIDATOR_FAILED', error instanceof Error ? error.message : String(error))); }
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

  private schedule() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.run(), 120);
  }

  private issue(severity: ValidationSeverity, code: string, message: string, recordId?: string): ValidationIssue {
    return { id: `${code}:${recordId ?? 'project'}:${Math.random().toString(36).slice(2, 7)}`, severity, code, message, recordId };
  }
}
