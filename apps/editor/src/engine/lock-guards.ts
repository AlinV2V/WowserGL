import type { EditorApp } from '../editor-app';
import { applySnapshot, isRecordLocked, snapshotTransform } from '../editor-store';
import type { EditorRecord, TransformSnapshot } from '../types';

export class EditorLockGuards {
  private protectedTransforms = new Map<string, { record: EditorRecord; transform: TransformSnapshot; state: EditorRecord['state'] }>();

  constructor(private readonly app: EditorApp, private readonly root: HTMLElement) {
    this.bindContextMenu();
    this.bindHierarchyDragDrop();
    this.bindGroupedTransforms();
  }

  private bindContextMenu() {
    const menu = this.root.querySelector<HTMLElement>('[data-context-menu]');
    menu?.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!button || (!button.matches('[data-context-delete]') && !button.matches('[data-context-duplicate]'))) return;
      if (!isRecordLocked(this.app.store.selected)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.app.bottomPanel.log({ level: 'warn', message: 'Unlock the selected object/layer before duplicating or deleting it.', time: new Date() });
    }, true);
  }

  private bindHierarchyDragDrop() {
    const hierarchy = this.root.querySelector<HTMLElement>('[data-hierarchy]');
    hierarchy?.addEventListener('dragstart', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-record]');
      const record = row ? this.app.store.records.get(row.dataset.record ?? '') : null;
      if (!isRecordLocked(record)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.app.bottomPanel.log({ level: 'warn', message: 'Locked objects cannot be reparented.', time: new Date() });
    }, true);
    hierarchy?.addEventListener('drop', (event) => {
      const sourceId = event.dataTransfer?.getData('application/x-wowsergl-hierarchy') ?? '';
      const source = sourceId ? this.app.store.records.get(sourceId) : null;
      const targetRow = (event.target as HTMLElement).closest<HTMLElement>('[data-record]');
      const target = targetRow ? this.app.store.records.get(targetRow.dataset.record ?? '') : null;
      if (!isRecordLocked(source) && !isRecordLocked(target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.app.bottomPanel.log({ level: 'warn', message: 'Unlock both hierarchy objects/layers before changing parenting.', time: new Date() });
    }, true);
  }

  private bindGroupedTransforms() {
    this.app.gizmo.controls.addEventListener('mouseDown', () => {
      this.protectedTransforms.clear();
      for (const record of this.app.store.records.values()) {
        if (!isRecordLocked(record)) continue;
        this.protectedTransforms.set(record.id, { record, transform: snapshotTransform(record.object), state: record.state });
      }
    });
    this.app.gizmo.controls.addEventListener('objectChange', () => this.restoreProtected());
    this.app.gizmo.controls.addEventListener('mouseUp', () => {
      this.restoreProtected();
      this.protectedTransforms.clear();
    });
  }

  private restoreProtected() {
    for (const { record, transform, state } of this.protectedTransforms.values()) {
      const now = snapshotTransform(record.object);
      if (JSON.stringify(now) === JSON.stringify(transform)) continue;
      applySnapshot(record.object, transform);
      record.state = state;
    }
  }
}
