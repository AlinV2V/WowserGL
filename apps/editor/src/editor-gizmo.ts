import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { EditorCameraController } from './editor-camera';
import { EditorHistory } from './editor-history';
import { applySnapshot, EditorObjectStore, snapshotTransform } from './editor-store';
import type { EditorRecord, TransformSnapshot } from './types';

export class EditorGizmoController extends EventTarget {
  readonly controls: TransformControls;
  readonly helper: THREE.Object3D;
  private highlight: THREE.BoxHelper | null = null;
  private dragStart: TransformSnapshot | null = null;
  private cursorWorld: THREE.Vector3 | null = null;
  private selected: EditorRecord | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly dom: HTMLCanvasElement,
    private readonly cameraController: EditorCameraController,
    private readonly store: EditorObjectStore,
    private readonly history: EditorHistory,
  ) {
    super();
    this.controls = new TransformControls(cameraController.active, dom);
    this.helper = this.controls.getHelper();
    this.helper.userData.editorNonSelectable = true;
    scene.add(this.helper);
    this.controls.addEventListener('mouseDown', () => {
      if (this.selected) this.dragStart = snapshotTransform(this.selected.object);
    });
    this.controls.addEventListener('objectChange', () => {
      if (!this.selected) return;
      this.selected.object.updateMatrixWorld(true);
      this.store.markModified(this.selected);
      this.updateHighlight();
      this.dispatchEvent(new Event('transform'));
    });
    this.controls.addEventListener('mouseUp', () => this.commitTransform());
    cameraController.addEventListener('camera', (event) => {
      (this.controls as unknown as { camera: THREE.Camera }).camera = (event as CustomEvent<THREE.Camera>).detail;
    });
    store.addEventListener('selection', (event) => this.setSelection((event as CustomEvent<EditorRecord | null>).detail));
    this.bindPointer();
    this.bindKeys();
  }

  setMode(mode: 'translate' | 'rotate' | 'scale') {
    this.controls.setMode(mode);
    this.dispatchEvent(new CustomEvent('mode', { detail: mode }));
  }

  setTranslationSnap(value: number | null) {
    this.controls.setTranslationSnap(value);
  }

  setRotationSnap(degrees: number | null) {
    this.controls.setRotationSnap(degrees === null ? null : THREE.MathUtils.degToRad(degrees));
  }

  private bindPointer() {
    this.dom.addEventListener('pointermove', (event) => this.updateCursor(event));
    this.dom.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.altKey) return;
      if ((this.controls as unknown as { dragging: boolean }).dragging) return;
      const hit = this.pick(event);
      if (hit?.object.userData.editorTerrain) return;
      this.store.select(hit ? this.store.resolveHit(hit) : null);
    });
  }

  private bindKeys() {
    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement;
      if (target?.matches?.('input,textarea,select')) return;
      if (event.ctrlKey || event.metaKey) {
        if (event.code === 'KeyZ') {
          event.preventDefault();
          event.shiftKey ? this.history.redo() : this.history.undo();
          return;
        }
        if (event.code === 'KeyY') {
          event.preventDefault();
          this.history.redo();
          return;
        }
        if (event.code === 'KeyD' && this.selected) {
          event.preventDefault();
          const source = this.selected;
          let copy: EditorRecord | null = null;
          this.history.execute({
            label: `Duplicate ${source.model}`,
            redo: () => { copy = this.store.duplicate(source, this.cursorWorld?.clone()); },
            undo: () => { if (copy) this.store.remove(copy); },
          });
          return;
        }
      }
      if (event.code === 'KeyW') this.setMode('translate');
      if (event.code === 'KeyE') this.setMode('rotate');
      if (event.code === 'KeyR') this.setMode('scale');
      if ((event.code === 'Delete' || event.code === 'Backspace') && this.selected) {
        event.preventDefault();
        const record = this.selected;
        const oldState = record.state;
        this.history.execute({
          label: `Delete ${record.model}`,
          redo: () => this.store.remove(record),
          undo: () => this.store.restore(record, oldState),
        });
      }
      if (event.code === 'KeyF' && this.selected) this.cameraController.focus(this.selected.object);
    });
  }

  private pick(event: PointerEvent) {
    this.pointerFromEvent(event);
    this.raycaster.setFromCamera(this.pointer, this.cameraController.active);
    return this.raycaster.intersectObjects(this.scene.children, true)
      .find((hit) => !this.isEditorHelper(hit.object));
  }

  private updateCursor(event: PointerEvent) {
    this.pointerFromEvent(event);
    this.raycaster.setFromCamera(this.pointer, this.cameraController.active);
    const hit = this.raycaster.intersectObjects(this.scene.children, true)
      .find((candidate) => candidate.object.userData.editorTerrain);
    this.cursorWorld = hit?.point.clone() ?? this.cursorWorld;
    if (this.cursorWorld) this.dispatchEvent(new CustomEvent('cursor', { detail: this.cursorWorld.clone() }));
  }

  private pointerFromEvent(event: PointerEvent) {
    const rect = this.dom.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private isEditorHelper(object: THREE.Object3D) {
    for (let node: THREE.Object3D | null = object; node; node = node.parent) {
      if (node.userData.editorNonSelectable) return true;
    }
    return false;
  }

  private setSelection(record: EditorRecord | null) {
    this.selected = record;
    this.controls.detach();
    if (this.highlight) {
      this.scene.remove(this.highlight);
      this.highlight.dispose();
      this.highlight = null;
    }
    if (!record || record.state === 'deleted') return;
    this.controls.attach(record.object);
    this.highlight = new THREE.BoxHelper(record.object, 0xffd36a);
    this.highlight.userData.editorNonSelectable = true;
    this.scene.add(this.highlight);
  }

  private updateHighlight() {
    this.highlight?.update();
  }

  private commitTransform() {
    if (!this.selected || !this.dragStart) return;
    const record = this.selected;
    const before = this.dragStart;
    const after = snapshotTransform(record.object);
    this.dragStart = null;
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.history.pushApplied({
      label: `Transform ${record.model}`,
      undo: () => { applySnapshot(record.object, before); this.store.markModified(record); this.updateHighlight(); },
      redo: () => { applySnapshot(record.object, after); this.store.markModified(record); this.updateHighlight(); },
    });
  }
}
