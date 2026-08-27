import * as THREE from 'three';
import type { EditorHistory } from './editor-history';
import { applySnapshot, snapshotTransform, type EditorObjectStore } from './editor-store';
import type { EditorRecord } from './types';

export class EditorInspector {
  private record: EditorRecord | null = null;
  private fields = new Map<string, HTMLInputElement>();
  private metadata!: HTMLElement;

  constructor(
    private readonly container: HTMLElement,
    private readonly store: EditorObjectStore,
    private readonly history: EditorHistory,
    private readonly sampleHeight: (x: number, y: number) => number,
  ) {
    this.mount();
    store.addEventListener('selection', (event) => this.setRecord((event as CustomEvent<EditorRecord | null>).detail));
    store.addEventListener('change', () => this.refresh());
  }

  refresh() {
    if (!this.record) return;
    const o = this.record.object;
    const euler = new THREE.Euler().setFromQuaternion(o.quaternion, 'XYZ');
    const values: Record<string, number> = {
      px: o.position.x, py: o.position.y, pz: o.position.z,
      rx: THREE.MathUtils.radToDeg(euler.x), ry: THREE.MathUtils.radToDeg(euler.y), rz: THREE.MathUtils.radToDeg(euler.z),
      sx: o.scale.x, sy: o.scale.y, sz: o.scale.z,
    };
    for (const [key, value] of Object.entries(values)) this.fields.get(key)!.value = value.toFixed(key.startsWith('r') ? 2 : 4);
    this.metadata.innerHTML = `
      <div><span>Type</span><strong>${this.record.kind.toUpperCase()}</strong></div>
      <div><span>Model</span><strong title="${this.record.model}">${this.record.model}</strong></div>
      <div><span>Triangles</span><strong>${this.record.triangles.toLocaleString()}</strong></div>
      <div><span>Textures</span><strong>${this.record.textures.length}</strong></div>
      <div><span>State</span><strong>${this.record.state}</strong></div>`;
  }

  private mount() {
    const field = (key: string, label: string, step: string) => `<label class="axis-field"><span>${label}</span><input data-field="${key}" type="number" step="${step}" /></label>`;
    this.container.innerHTML = `
      <div class="panel-title">Inspector</div>
      <div class="inspector-empty" data-empty>Select an object in the viewport.</div>
      <div data-content hidden>
        <div class="section-label">Position</div><div class="field-grid three">${field('px','X','0.1')}${field('py','Y','0.1')}${field('pz','Z','0.1')}</div>
        <div class="section-label">Rotation</div><div class="field-grid three">${field('rx','X°','1')}${field('ry','Y°','1')}${field('rz','Z°','1')}</div>
        <div class="section-label">Scale</div><div class="field-grid three">${field('sx','X','0.01')}${field('sy','Y','0.01')}${field('sz','Z','0.01')}</div>
        <div class="quick-actions"><button data-ground>Align to Ground</button><button data-reset>Reset Rotation</button><button data-grid>Snap Grid</button></div>
        <div class="section-label">Asset Metadata</div><div class="metadata" data-metadata></div>
      </div>`;
    for (const input of this.container.querySelectorAll<HTMLInputElement>('[data-field]')) {
      this.fields.set(input.dataset.field!, input);
      input.addEventListener('change', () => this.commitFields());
    }
    this.metadata = this.container.querySelector<HTMLElement>('[data-metadata]')!;
    this.container.querySelector('[data-ground]')!.addEventListener('click', () => this.alignGround());
    this.container.querySelector('[data-reset]')!.addEventListener('click', () => this.mutate('Reset rotation', (o) => o.quaternion.identity()));
    this.container.querySelector('[data-grid]')!.addEventListener('click', () => this.mutate('Snap to grid', (o) => {
      o.position.x = Math.round(o.position.x);
      o.position.y = Math.round(o.position.y);
      o.position.z = Math.round(o.position.z);
    }));
  }

  private setRecord(record: EditorRecord | null) {
    this.record = record;
    this.container.querySelector<HTMLElement>('[data-empty]')!.hidden = !!record;
    this.container.querySelector<HTMLElement>('[data-content]')!.hidden = !record;
    this.refresh();
  }

  private commitFields() {
    if (!this.record) return;
    this.mutate('Inspector transform', (o) => {
      o.position.set(this.value('px'), this.value('py'), this.value('pz'));
      o.quaternion.setFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(this.value('rx')),
        THREE.MathUtils.degToRad(this.value('ry')),
        THREE.MathUtils.degToRad(this.value('rz')),
        'XYZ',
      ));
      o.scale.set(this.value('sx'), this.value('sy'), this.value('sz'));
    });
  }

  private alignGround() {
    if (!this.record) return;
    this.mutate('Align to ground', (object) => {
      object.updateWorldMatrix(true, false);
      const world = new THREE.Vector3();
      object.getWorldPosition(world);
      const h = this.sampleHeight(world.x, world.y);
      const hx = this.sampleHeight(world.x + 0.75, world.y) - h;
      const hy = this.sampleHeight(world.x, world.y + 0.75) - h;
      const normal = new THREE.Vector3(-hx, -hy, 0.75).normalize();
      const parent = object.parent;
      const worldPosition = new THREE.Vector3(world.x, world.y, h);
      if (parent) object.position.copy(parent.worldToLocal(worldPosition));
      else object.position.copy(worldPosition);
      const worldUpToNormal = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
      if (parent) {
        const parentQ = new THREE.Quaternion();
        parent.getWorldQuaternion(parentQ);
        object.quaternion.copy(parentQ.invert().multiply(worldUpToNormal));
      } else object.quaternion.copy(worldUpToNormal);
    });
  }

  private mutate(label: string, fn: (object: THREE.Object3D) => void) {
    if (!this.record) return;
    const record = this.record;
    const before = snapshotTransform(record.object);
    fn(record.object);
    record.object.updateMatrixWorld(true);
    const after = snapshotTransform(record.object);
    this.store.markModified(record);
    this.history.pushApplied({
      label,
      undo: () => { applySnapshot(record.object, before); this.store.markModified(record); this.refresh(); },
      redo: () => { applySnapshot(record.object, after); this.store.markModified(record); this.refresh(); },
    });
    this.refresh();
  }

  private value(key: string) {
    const value = Number(this.fields.get(key)!.value);
    return Number.isFinite(value) ? value : 0;
  }
}
