import type { EditorHistory } from './editor-history';
import type { EditorObjectStore } from './editor-store';
import type { EditorRecord } from './types';
import type { SceneComponentModel } from './engine/component-model';

const iconFor = (record: EditorRecord) => record.kind === 'wmo' ? '▣' : record.kind === 'm2' ? '◆' : record.kind === 'npc' ? '●' : '◇';
const stateClass = (record: EditorRecord) => record.state === 'existing' ? '' : ` state-${record.state}`;

export class EditorHierarchy extends EventTarget {
  private query = '';
  private showChangedOnly = false;
  private sceneCollapsed = false;
  private collapsed = new Set<string>();
  private components: SceneComponentModel | null = null;
  private history: EditorHistory | null = null;

  constructor(private readonly container: HTMLElement, private readonly store: EditorObjectStore) {
    super();
    this.mount();
    store.addEventListener('change', () => this.render());
    store.addEventListener('selection', () => this.render());
  }

  setComponentModel(components: SceneComponentModel, history: EditorHistory) {
    this.components = components;
    this.history = history;
    components.addEventListener('change', () => this.render());
    this.render();
  }

  render() {
    const list = this.container.querySelector<HTMLElement>('[data-hierarchy-list]');
    if (!list) return;
    const q = this.query.toLowerCase();
    const all = [...this.store.records.values()]
      .filter((record) => record.object.visible || record.state === 'deleted')
      .filter((record) => !this.showChangedOnly || record.state !== 'existing');
    const byId = new Map(all.map((record) => [record.id, record]));
    const directMatches = all.filter((record) => !q || record.model.toLowerCase().includes(q) || record.kind.includes(q) || String(record.sourceId ?? '').includes(q));
    const visibleIds = new Set(directMatches.map((record) => record.id));
    if (q && this.components) {
      for (const record of directMatches) {
        let parentId = this.components.entities.get(record.id)?.parentId;
        const guard = new Set<string>();
        while (parentId && !guard.has(parentId)) {
          guard.add(parentId);
          visibleIds.add(parentId);
          parentId = this.components.entities.get(parentId)?.parentId;
        }
      }
    }
    const records = all.filter((record) => !q || visibleIds.has(record.id));
    const children = new Map<string, EditorRecord[]>();
    const roots: EditorRecord[] = [];
    for (const record of records) {
      const parentId = this.components?.entities.get(record.id)?.parentId;
      if (parentId && byId.has(parentId) && visibleIds.has(parentId)) {
        const bucket = children.get(parentId) ?? [];
        bucket.push(record);
        children.set(parentId, bucket);
      } else roots.push(record);
    }
    const sort = (items: EditorRecord[]) => items.sort((a, b) => a.kind.localeCompare(b.kind) || a.model.localeCompare(b.model));
    sort(roots);
    children.forEach(sort);
    list.replaceChildren();

    const sceneRow = document.createElement('button');
    sceneRow.className = 'hierarchy-scene-row';
    sceneRow.innerHTML = `<span class="tree-arrow">${this.sceneCollapsed ? '▸' : '▾'}</span><span class="hierarchy-icon scene-icon">◈</span><strong>${this.store.tileKey || 'Scene'}</strong><span class="hierarchy-count">${records.length}</span>`;
    sceneRow.addEventListener('click', () => { this.sceneCollapsed = !this.sceneCollapsed; this.render(); });
    sceneRow.addEventListener('dragover', (event) => { if (this.components) { event.preventDefault(); sceneRow.classList.add('drop-target'); } });
    sceneRow.addEventListener('dragleave', () => sceneRow.classList.remove('drop-target'));
    sceneRow.addEventListener('drop', (event) => {
      event.preventDefault();
      sceneRow.classList.remove('drop-target');
      const id = event.dataTransfer?.getData('application/x-wowsergl-hierarchy');
      const record = id ? this.store.records.get(id) : null;
      if (record) this.reparent(record, null);
    });
    list.append(sceneRow);
    if (this.sceneCollapsed) return;

    let rendered = 0;
    const renderBranch = (record: EditorRecord, depth: number) => {
      if (rendered >= 1500) return;
      rendered++;
      const childRows = children.get(record.id) ?? [];
      const row = document.createElement('button');
      row.className = `hierarchy-row${stateClass(record)}${this.store.selected === record ? ' selected' : ''}`;
      row.dataset.record = record.id;
      row.draggable = !!this.components;
      const label = record.model.split(/[\\/]/).pop() || record.model;
      const hasChildren = childRows.length > 0;
      const isCollapsed = this.collapsed.has(record.id);
      row.innerHTML = `<span class="tree-indent" style="width:${8 + depth * 13}px"></span><span class="tree-arrow child-arrow ${hasChildren ? '' : 'empty'}">${hasChildren ? (isCollapsed ? '▸' : '▾') : ''}</span><span class="hierarchy-icon">${iconFor(record)}</span><span class="hierarchy-name" title="${record.model.replaceAll('"', '&quot;')}">${label}</span><span class="hierarchy-kind">${record.kind.toUpperCase()}</span><span class="state-dot" title="${record.state}"></span>`;
      row.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        if (target.classList.contains('child-arrow') && hasChildren) {
          if (isCollapsed) this.collapsed.delete(record.id); else this.collapsed.add(record.id);
          this.render();
          return;
        }
        this.store.select(record);
      });
      row.addEventListener('dblclick', () => this.dispatchEvent(new CustomEvent('focus', { detail: record })));
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.store.select(record);
        this.dispatchEvent(new CustomEvent('context', { detail: { record, x: event.clientX, y: event.clientY } }));
      });
      row.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData('application/x-wowsergl-hierarchy', record.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragover', (event) => {
        const id = event.dataTransfer?.getData('application/x-wowsergl-hierarchy');
        if (id && id !== record.id && !this.wouldCycle(id, record.id)) {
          event.preventDefault();
          row.classList.add('drop-target');
        }
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', (event) => {
        event.preventDefault();
        row.classList.remove('drop-target');
        const id = event.dataTransfer?.getData('application/x-wowsergl-hierarchy');
        const child = id ? this.store.records.get(id) : null;
        if (child && child !== record) this.reparent(child, record);
      });
      list.append(row);
      if (!isCollapsed) for (const child of childRows) renderBranch(child, depth + 1);
    };
    for (const root of roots) renderBranch(root, 0);
    if (rendered < records.length) {
      const more = document.createElement('div');
      more.className = 'hierarchy-more';
      more.textContent = `${records.length - rendered} more objects — use search to narrow the hierarchy.`;
      list.append(more);
    }
  }

  private reparent(record: EditorRecord, parent: EditorRecord | null) {
    if (!this.components || !this.history) return;
    if (parent && this.wouldCycle(record.id, parent.id)) return;
    const entity = this.components.entities.get(record.id);
    if (!entity) return;
    const beforeParentId = entity.parentId;
    const apply = (parentId?: string) => {
      const nextParent = parentId ? this.store.records.get(parentId) ?? null : null;
      entity.parentId = nextParent?.id;
      const destination = nextParent?.object ?? this.sceneRoot(record.object);
      if (destination && record.object.parent !== destination) destination.attach(record.object);
      this.store.markModified(record);
      this.components!.dispatchEvent(new Event('change'));
      this.render();
    };
    this.history.execute({ label: parent ? `Parent ${record.model} → ${parent.model}` : `Unparent ${record.model}`, redo: () => apply(parent?.id), undo: () => apply(beforeParentId) });
  }

  private sceneRoot(object: THREE.Object3D | any) {
    let root = object as { parent: any; attach?: (child: any) => void };
    while (root.parent) root = root.parent;
    return typeof root.attach === 'function' ? root : null;
  }

  private wouldCycle(childId: string, parentId: string) {
    if (childId === parentId || !this.components) return true;
    let cursor: string | undefined = parentId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      if (cursor === childId) return true;
      seen.add(cursor);
      cursor = this.components.entities.get(cursor)?.parentId;
    }
    return false;
  }

  private mount() {
    this.container.innerHTML = `
      <div class="panel-head"><span>Hierarchy</span><div class="panel-head-actions"><button data-changed title="Show modified objects">Δ</button><button data-collapse title="Collapse all">−</button></div></div>
      <div class="hierarchy-search"><span>⌕</span><input data-hierarchy-search placeholder="Search scene" spellcheck="false" /></div>
      <div class="hierarchy-list" data-hierarchy-list></div>`;
    const search = this.container.querySelector<HTMLInputElement>('[data-hierarchy-search]')!;
    search.addEventListener('input', () => { this.query = search.value.trim(); this.render(); });
    this.container.querySelector('[data-changed]')!.addEventListener('click', (event) => {
      this.showChangedOnly = !this.showChangedOnly;
      (event.currentTarget as HTMLButtonElement).classList.toggle('active', this.showChangedOnly);
      this.render();
    });
    this.container.querySelector('[data-collapse]')!.addEventListener('click', () => {
      if (this.collapsed.size) this.collapsed.clear();
      else for (const record of this.store.records.values()) this.collapsed.add(record.id);
      this.render();
    });
    this.render();
  }
}
