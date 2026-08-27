import * as THREE from 'three';
import type { EditorAsset, EditorAssetCategory } from './types';

type CategoryFilter = 'all' | EditorAssetCategory;

const categoryLabels: Record<CategoryFilter, string> = {
  all: 'All',
  nature: '🌲 Nature',
  structures: '🏰 Structures',
  props: '🪑 Props',
  creatures: '🐉 Creatures',
  other: 'Other',
};

class AssetThumbnailer {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(36, 4 / 3, 0.01, 10000);
  private readonly cache = new Map<string, string>();
  private chain = Promise.resolve();

  constructor() {
    this.renderer.setSize(128, 96, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x30343b, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(3, -4, 6);
    this.scene.add(key);
  }

  request(asset: EditorAsset, image: HTMLImageElement) {
    const cached = this.cache.get(asset.id);
    if (cached) { image.src = cached; return; }
    this.chain = this.chain.then(async () => {
      if (!image.isConnected) return;
      const root = asset.template.clone(true);
      root.traverse((object) => { object.userData.editorNonSelectable = false; });
      this.scene.add(root);
      const box = new THREE.Box3().setFromObject(root);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      if (!sphere.isEmpty()) {
        root.position.sub(sphere.center);
        const radius = Math.max(0.3, sphere.radius);
        this.camera.position.set(radius * 1.8, -radius * 2.2, radius * 1.5);
        this.camera.near = Math.max(0.01, radius / 100);
        this.camera.far = radius * 20;
        this.camera.updateProjectionMatrix();
        this.camera.lookAt(0, 0, 0);
      }
      this.renderer.render(this.scene, this.camera);
      const url = this.renderer.domElement.toDataURL('image/webp', 0.78);
      this.cache.set(asset.id, url);
      image.src = url;
      this.scene.remove(root);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }).catch(() => {});
  }
}

export class EditorPalette extends EventTarget {
  private assets: EditorAsset[] = [];
  private filtered: EditorAsset[] = [];
  private list!: HTMLElement;
  private search!: HTMLInputElement;
  private category: CategoryFilter = 'all';
  private kind: 'all' | 'm2' | 'wmo' = 'all';
  private thumbnailer: AssetThumbnailer | null = null;

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

  getAsset(id: string) { return this.assets.find((asset) => asset.id === id) ?? null; }

  private mount() {
    this.container.innerHTML = `
      <div class="panel-head"><span>Project</span><div class="panel-head-actions"><button data-kind="all" class="active">All</button><button data-kind="m2">M2</button><button data-kind="wmo">WMO</button></div></div>
      <div class="project-toolbar"><button class="folder-button">Assets</button><div class="hierarchy-search project-search"><span>⌕</span><input data-search type="search" placeholder="Search models, props, creatures…" /></div></div>
      <div class="asset-categories">${(Object.keys(categoryLabels) as CategoryFilter[]).map((category) => `<button data-category="${category}" class="${category === 'all' ? 'active' : ''}">${categoryLabels[category]}</button>`).join('')}</div>
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
    for (const button of this.container.querySelectorAll<HTMLButtonElement>('[data-category]')) {
      button.addEventListener('click', () => {
        this.category = button.dataset.category as CategoryFilter;
        for (const sibling of this.container.querySelectorAll<HTMLButtonElement>('[data-category]')) sibling.classList.toggle('active', sibling === button);
        this.applyFilter();
      });
    }
  }

  private applyFilter() {
    const q = this.search.value.trim().toLowerCase();
    this.filtered = this.assets.filter((asset) =>
      (this.kind === 'all' || asset.kind === this.kind) &&
      (this.category === 'all' || (asset.category ?? 'other') === this.category) &&
      (!q || `${asset.label} ${asset.model} ${asset.category ?? ''}`.toLowerCase().includes(q))
    );
    this.render();
  }

  private render() {
    this.list.replaceChildren();
    if (!this.filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = this.assets.length ? 'No matching assets.' : 'Load a CleanClientMMO tile to populate the Project browser.';
      this.list.append(empty);
      return;
    }
    this.thumbnailer ??= new AssetThumbnailer();
    for (const asset of this.filtered.slice(0, 800)) {
      const item = document.createElement('button');
      item.className = 'asset-item asset-item-preview';
      item.draggable = true;
      item.title = `${asset.model}\nClick to spawn · drag into Scene`;
      const thumb = document.createElement('span');
      thumb.className = 'asset-thumbnail asset-thumbnail-3d';
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      const badge = document.createElement('small');
      badge.textContent = asset.kind.toUpperCase();
      thumb.append(image, badge);
      const copy = document.createElement('span');
      copy.className = 'asset-copy';
      const strong = document.createElement('strong');
      strong.textContent = asset.label;
      const path = document.createElement('small');
      path.textContent = asset.model;
      copy.append(strong, path);
      const tris = document.createElement('span');
      tris.className = 'asset-tris';
      tris.textContent = `${asset.triangles.toLocaleString()} tris`;
      item.append(thumb, copy, tris);
      item.addEventListener('click', () => this.dispatchEvent(new CustomEvent('spawn', { detail: asset })));
      item.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData('application/x-wowsergl-asset', asset.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
      });
      this.list.append(item);
      if (this.list.children.length <= 160) this.thumbnailer.request(asset, image);
    }
  }
}
