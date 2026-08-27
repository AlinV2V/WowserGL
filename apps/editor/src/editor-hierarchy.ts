import type { EditorObjectStore } from './editor-store';
import type { EditorRecord } from './types';

const iconFor = (record: EditorRecord) => record.kind === 'wmo' ? '▣' : record.kind === 'm2' ? '◆' : record.kind === 'npc' ? '●' : '◇';
const stateClass = (record: EditorRecord) => record.state === 'existing' ? '' : ` state-${record.state}`;

export class EditorHierarchy extends EventTarget {
  private query = '';
  private showChangedOnly = false;

  constructor(private readonly container: HTMLElement, private readonly store: EditorObjectStore) {
    super();
    this.mount();
    store.addEventListener('change', () => this.render());
    store.addEventListener('selection', () => this.render());
  }

  render() {
    const list = this.container.querySelector<HTMLElement>('[data-hierarchy-list]');
    if (!list) return;
    const q = this.query.toLowerCase();
    const records = [...this.store.records.values()]
      .filter((record) => record.object.visible || record.state === 'deleted')
      .filter((record) => !this.showChangedOnly || record.state !== 'existing')
      .filter((record) => !q || record.model.toLowerCase().includes(q) || record.kind.includes(q) || String(record.sourceId ?? '').includes(q))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.model.localeCompare(b.model));
    const visible = records.slice(0, 1500);
    list.innerHTML = '';

    const sceneRow = document.createElement('button');
    sceneRow.className = 'hierarchy-scene-row';
    sceneRow.innerHTML = `<span class="tree-arrow">▾</span><span class="hierarchy-icon scene-icon">◈</span><strong>${this.store.tileKey || 'Scene'}</strong><span class="hierarchy-count">${records.length}</span>`;
    list.append(sceneRow);

    for (const record of visible) {
      const row = document.createElement('button');
      row.className = `hierarchy-row${stateClass(record)}${this.store.selected === record ? ' selected' : ''}`;
      row.dataset.record = record.id;
      const label = record.model.split(/[\\/]/).pop() || record.model;
      row.innerHTML = `<span class="tree-indent"></span><span class="hierarchy-icon">${iconFor(record)}</span><span class="hierarchy-name" title="${record.model.replaceAll('"', '&quot;')}">${label}</span><span class="hierarchy-kind">${record.kind.toUpperCase()}</span><span class="state-dot" title="${record.state}"></span>`;
      row.addEventListener('click', () => this.store.select(record));
      row.addEventListener('dblclick', () => this.dispatchEvent(new CustomEvent('focus', { detail: record })));
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.store.select(record);
        this.dispatchEvent(new CustomEvent('context', { detail: { record, x: event.clientX, y: event.clientY } }));
      });
      list.append(row);
    }
    if (visible.length < records.length) {
      const more = document.createElement('div');
      more.className = 'hierarchy-more';
      more.textContent = `${records.length - visible.length} more objects — use search to narrow the hierarchy.`;
      list.append(more);
    }
  }

  private mount() {
    this.container.innerHTML = `
      <div class="panel-head"><span>Hierarchy</span><div class="panel-head-actions"><button data-changed title="Show modified objects">Δ</button><button data-collapse title="Collapse">−</button></div></div>
      <div class="hierarchy-search"><span>⌕</span><input data-hierarchy-search placeholder="Search scene" spellcheck="false" /></div>
      <div class="hierarchy-list" data-hierarchy-list></div>`;
    const search = this.container.querySelector<HTMLInputElement>('[data-hierarchy-search]')!;
    search.addEventListener('input', () => { this.query = search.value.trim(); this.render(); });
    this.container.querySelector('[data-changed]')!.addEventListener('click', (event) => {
      this.showChangedOnly = !this.showChangedOnly;
      (event.currentTarget as HTMLButtonElement).classList.toggle('active', this.showChangedOnly);
      this.render();
    });
    this.render();
  }
}
