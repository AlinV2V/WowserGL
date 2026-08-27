import * as THREE from 'three';
import type { EditorHistory } from './editor-history';
import { applySnapshot, snapshotTransform, type EditorObjectStore } from './editor-store';
import type { EditorRecord } from './types';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

export class EditorInspector extends EventTarget {
  private record: EditorRecord | null = null;
  private fields = new Map<string, HTMLInputElement>();
  private metadata!: HTMLElement;

  constructor(
    private readonly container: HTMLElement,
    private readonly store: EditorObjectStore,
    private readonly history: EditorHistory,
    private readonly sampleHeight: (x: number, y: number) => number,
  ) {
    super();
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
    for (const [key, value] of Object.entries(values)) {
      const field = this.fields.get(key);
      if (field && document.activeElement !== field) field.value = value.toFixed(key.startsWith('r') ? 2 : 4);
    }
    const source = String(this.record.sourceId ?? 'local');
    this.metadata.innerHTML = `
      <div><span>Type</span><strong>${this.record.kind.toUpperCase()}</strong></div>
      <div><span>Model</span><strong title="${escapeHtml(this.record.model)}">${escapeHtml(this.record.model)}</strong></div>
      <div><span>Source ID</span><strong>${escapeHtml(source)}</strong></div>
      <div><span>Triangles</span><strong>${this.record.triangles.toLocaleString()}</strong></div>
      <div><span>Textures</span><strong>${this.record.textures.length}</strong></div>
      <div><span>Override State</span><strong class="inspector-state ${this.record.state}">${this.record.state}</strong></div>`;
  }

  private mount() {
    const field = (key: string, label: string, axis: string, step: string) => `<label class="unity-axis ${axis}"><span>${label}</span><input data-field="${key}" type="number" step="${step}" /></label>`;
    this.container.innerHTML = `
      <div class="inspector-header"><div><strong>Inspector</strong><small data-object-name>No Selection</small></div></div>
      <div class="inspector-empty" data-empty>Select an object in Scene or Hierarchy.</div>
      <div class="inspector-content" data-content hidden>
        <section class="component-card transform-component">
          <div class="component-head"><span class="component-toggle">▾</span><strong>Transform</strong></div>
          <div class="component-body">
            <div class="transform-row"><span>Position</span><div class="axis-row">${field('px','X','x','0.1')}${field('py','Y','y','0.1')}${field('pz','Z','z','0.1')}</div></div>
            <div class="transform-row"><span>Rotation</span><div class="axis-row">${field('rx','X','x','1')}${field('ry','Y','y','1')}${field('rz','Z','z','1')}</div></div>
            <div class="transform-row"><span>Scale</span><div class="axis-row">${field('sx','X','x','0.01')}${field('sy','Y','y','0.01')}${field('sz','Z','z','0.01')}</div></div>
            <div class="quick-actions unity-actions"><button data-ground>Align Ground</button><button data-reset>Reset Rotation</button><button data-grid>Snap Grid</button></div>
          </div>
        </section>
        <section class="component-card">
          <div class="component-head"><span class="component-toggle">▾</span><strong>VanillaGL Object</strong></div>
          <div class="component-body metadata" data-metadata></div>
        </section>
        <section class="component-card live-component">
          <div class="component-head"><span class="component-toggle">▾</span><strong>Live Authoring</strong><span class="component-badge">Runtime</span></div>
          <div class="component-body">
            <p class="component-help">Preview remains local. Push updates the running VanillaGL scene. Save persists the override project.</p>
            <div class="live-author-actions"><button class="accent" data-push-selection>Push Selection</button><button data-save-selection>Save Override</button><button data-focus-game>Focus In Game</button></div>
          </div>
        </section>
        <div data-material-host></div>
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
    this.container.querySelector('[data-push-selection]')!.addEventListener('click', () => {
      if (this.record) this.dispatchEvent(new CustomEvent('push', { detail: this.record }));
    });
    this.container.querySelector('[data-save-selection]')!.addEventListener('click', () => {
      if (this.record) this.dispatchEvent(new CustomEvent('save', { detail: this.record }));
    });
    this.container.querySelector('[data-focus-game]')!.addEventListener('click', () => {
      if (this.record) this.dispatchEvent(new CustomEvent('focus-game', { detail: this.record }));
    });
  }

  materialHost() {
    return this.container.querySelector<HTMLElement>('[data-material-host]')!;
  }

  private setRecord(record: EditorRecord | null) {
    this.record = record;
    this.container.querySelector<HTMLElement>('[data-empty]')!.hidden = !!record;
    this.container.querySelector<HTMLElement>('[data-content]')!.hidden = !record;
    const label = this.container.querySelector<HTMLElement>('[data-object-name]')!;
    label.textContent = record ? (record.model.split(/[\\/]/).pop() || record.model) : 'No Selection';
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
