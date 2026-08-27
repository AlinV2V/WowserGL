import type { EditorAsset } from './types';

export class EditorPalette extends EventTarget {
  private assets: EditorAsset[] = [];
  private filtered: EditorAsset[] = [];
  private list!: HTMLElement;
  private search!: HTMLInputElement;
  private kind: 'all' | 'm2' | 'wmo' = 'all';

  constructor(private readonly container: HTMLElement) {
    super();
    this.mount();
  }

  setAssets(assets: EditorAsset[]) {
    const unique = new Map<string, EditorAsset>();
    for (const asset of assets) unique.set(asset.id, asset);
    this.assets = [...unique.values()].sort((a, b) => a.label.localeCompare(b.label));
    this.applyFilter();
  }

  getAsset(id: string) {
    return this.assets.find((asset) => asset.id === id) ?? null;
  }

  private mount() {
    this.container.innerHTML = `
      <div class="panel-head"><span>Project</span><div class="panel-head-actions"><button data-kind="all" class="active">All</button><button data-kind="m2">M2</button><button data-kind="wmo">WMO</button></div></div>
      <div class="project-toolbar"><button class="folder-button">Assets</button><div class="hierarchy-search project-search"><span>⌕</span><input data-search type="search" placeholder="Search assets" /></div></div>
      <div class="asset-list unity-assets" data-list></div>`;
    this.search = this.container.querySelector<HTMLInputElement>('[data-search]')!;
    this.list = this.container.querySelector<HTMLElement>('[data-list]')!;
    this.search.addEventListener('input', () => this.applyFilter());
    for (const button of this.container.querySelectorAll<HTMLButtonElement>('[data-kind]')) {
      button.addEventListener('click', () => {
        this.kind = button.dataset.kind as typeof this.kind;
        for (const sibling of this.container.querySelectorAll<HTMLButtonElement>('[data-kind]')) sibling.classList.toggle('active', sibling === button);
        this.applyFilter();
      });
    }
  }

  private applyFilter() {
    const q = this.search.value.trim().toLowerCase();
    this.filtered = this.assets.filter((asset) => (this.kind === 'all' || asset.kind === this.kind) && (!q || `${asset.label} ${asset.model}`.toLowerCase().includes(q)));
    this.render();
  }

  private render() {
    this.list.replaceChildren();
    if (!this.filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = this.assets.length ? 'No matching assets.' : 'Load a VanillaGL tile to populate the Project browser.';
      this.list.append(empty);
      return;
    }
    for (const asset of this.filtered.slice(0, 800)) {
      const item = document.createElement('button');
      item.className = 'asset-item';
      item.draggable = true;
      item.title = `${asset.model}\nClick to spawn · drag into Scene`;
      item.innerHTML = `<span class="asset-thumbnail"><span>${asset.kind === 'wmo' ? '▣' : '◆'}</span><small>${asset.kind.toUpperCase()}</small></span><span class="asset-copy"><strong>${asset.label}</strong><small>${asset.model}</small></span><span class="asset-tris">${asset.triangles.toLocaleString()} tris</span>`;
      item.addEventListener('click', () => this.dispatchEvent(new CustomEvent('spawn', { detail: asset })));
      item.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData('application/x-wowsergl-asset', asset.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
      });
      this.list.append(item);
    }
  }
}
