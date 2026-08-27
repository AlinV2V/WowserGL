import type { EditorAsset } from './types';

export class EditorPalette extends EventTarget {
  private assets: EditorAsset[] = [];
  private filtered: EditorAsset[] = [];
  private list!: HTMLElement;
  private search!: HTMLInputElement;

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
      <div class="panel-title">Asset Browser</div>
      <input class="search" data-search type="search" placeholder="Search M2 / WMO models..." />
      <div class="asset-list" data-list></div>`;
    this.search = this.container.querySelector('[data-search]')!;
    this.list = this.container.querySelector('[data-list]')!;
    this.search.addEventListener('input', () => this.applyFilter());
  }

  private applyFilter() {
    const q = this.search.value.trim().toLowerCase();
    this.filtered = this.assets.filter((asset) => !q || `${asset.label} ${asset.model}`.toLowerCase().includes(q));
    this.render();
  }

  private render() {
    this.list.replaceChildren();
    if (!this.filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = this.assets.length ? 'No matching assets.' : 'Load a VanillaGL tile to populate models.';
      this.list.append(empty);
      return;
    }
    for (const asset of this.filtered.slice(0, 600)) {
      const item = document.createElement('button');
      item.className = 'asset-item';
      item.draggable = true;
      item.innerHTML = `<span class="asset-kind">${asset.kind.toUpperCase()}</span><span class="asset-copy"><strong>${asset.label}</strong><small>${asset.model}</small></span><span class="asset-tris">${asset.triangles.toLocaleString()} tris</span>`;
      item.addEventListener('click', () => this.dispatchEvent(new CustomEvent('spawn', { detail: asset })));
      item.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData('application/x-wowsergl-asset', asset.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
      });
      this.list.append(item);
    }
  }
}
