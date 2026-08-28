import * as THREE from 'three';
import type { EditorApp } from '../editor-app';
import type { StudioPluginHost } from './plugin-host';

export type TerrainBrushMode = 'off' | 'raise' | 'lower' | 'smooth' | 'flatten';
export type TerrainTilePatch = {
  tileKey: string;
  vertices: Record<string, number>;
};

const STORAGE = 'wowsergl:terrain-patches:v1';

export class TerrainAuthoring extends EventTarget {
  mode: TerrainBrushMode = 'off';
  radius = 12;
  strength = 1.5;
  flattenHeight = 0;
  private patches = new Map<string, TerrainTilePatch>();
  private original = new WeakMap<THREE.BufferGeometry, Float32Array>();
  private strokeBefore = new Map<number, number>();
  private strokeAfter = new Map<number, number>();
  private painting = false;
  private panel: HTMLElement | null = null;

  constructor(private readonly app: EditorApp, plugins: StudioPluginHost) {
    super();
    this.load();
    plugins.activate({
      id: 'builtin-terrain-authoring',
      name: 'Terrain Authoring',
      version: '1.0.0',
      activate: ({ registerToolTab, registerValidator }) => {
        registerToolTab({ id: 'terrain', label: 'Terrain', render: (host) => this.render(host) });
        registerValidator(() => this.validate());
      },
    });
    this.bindPointer();
    app.store.addEventListener('change', () => window.setTimeout(() => this.restoreCurrentTile(), 0));
  }

  snapshot(): TerrainTilePatch[] {
    return [...this.patches.values()].map((patch) => ({ tileKey: patch.tileKey, vertices: { ...patch.vertices } }));
  }

  applySnapshot(patches: TerrainTilePatch[]) {
    this.patches = new Map(patches.map((patch) => [patch.tileKey, { tileKey: patch.tileKey, vertices: { ...patch.vertices } }]));
    this.persist();
    this.restoreCurrentTile();
  }

  setMode(mode: TerrainBrushMode) {
    this.mode = mode;
    this.app.renderer.domElement.style.cursor = mode === 'off' ? '' : 'crosshair';
    this.renderCurrent();
  }

  private bindPointer() {
    const canvas = this.app.renderer.domElement;
    canvas.addEventListener('pointerdown', (event) => {
      if (this.mode === 'off' || event.button !== 0 || event.altKey) return;
      const hit = this.hit(event);
      if (!hit) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.painting = true;
      this.strokeBefore.clear();
      this.strokeAfter.clear();
      canvas.setPointerCapture?.(event.pointerId);
      this.applyBrush(hit);
    }, true);
    canvas.addEventListener('pointermove', (event) => {
      if (!this.painting || this.mode === 'off') return;
      const hit = this.hit(event);
      if (!hit) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.applyBrush(hit);
    }, true);
    const finish = () => {
      if (!this.painting) return;
      this.painting = false;
      if (!this.strokeAfter.size) return;
      const terrain = this.terrain();
      if (!terrain) return;
      const before = new Map(this.strokeBefore);
      const after = new Map(this.strokeAfter);
      const apply = (values: Map<number, number>) => {
        const attr = terrain.geometry.getAttribute('position') as THREE.BufferAttribute;
        for (const [index, z] of values) attr.setZ(index, z);
        this.finishGeometry(terrain);
        this.capturePatch(terrain, values.keys());
      };
      this.app.history.pushApplied({ label: `Terrain ${this.mode}`, undo: () => apply(before), redo: () => apply(after) });
      this.persist();
    };
    canvas.addEventListener('pointerup', finish, true);
    canvas.addEventListener('pointercancel', finish, true);
  }

  private hit(event: PointerEvent) {
    const terrain = this.terrain();
    if (!terrain) return null;
    const rect = this.app.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.app.camera.active);
    return raycaster.intersectObject(terrain, false)[0] ?? null;
  }

  private terrain(): THREE.Mesh | null {
    const matches: THREE.Mesh[] = [];
    this.app.scene.traverse((object) => {
      if (matches.length || !object.userData.editorTerrain) return;
      if (object.userData.editorTileKey && object.userData.editorTileKey !== this.app.store.tileKey) return;
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) matches.push(mesh);
    });
    return matches[0] ?? null;
  }

  private ensureOriginal(terrain: THREE.Mesh) {
    let baseline = this.original.get(terrain.geometry);
    if (!baseline) {
      const attr = terrain.geometry.getAttribute('position') as THREE.BufferAttribute;
      baseline = new Float32Array(attr.count);
      for (let i = 0; i < attr.count; i++) baseline[i] = attr.getZ(i);
      this.original.set(terrain.geometry, baseline);
    }
    return baseline;
  }

  private applyBrush(hit: THREE.Intersection) {
    const terrain = this.terrain();
    if (!terrain) return;
    this.ensureOriginal(terrain);
    const attr = terrain.geometry.getAttribute('position') as THREE.BufferAttribute;
    const local = terrain.worldToLocal(hit.point.clone());
    const radiusSq = this.radius * this.radius;
    let average = 0, count = 0;
    if (this.mode === 'smooth') {
      for (let i = 0; i < attr.count; i++) {
        const dx = attr.getX(i) - local.x, dy = attr.getY(i) - local.y;
        if (dx * dx + dy * dy <= radiusSq) { average += attr.getZ(i); count++; }
      }
      average = count ? average / count : local.z;
    }
    for (let i = 0; i < attr.count; i++) {
      const dx = attr.getX(i) - local.x, dy = attr.getY(i) - local.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > radiusSq) continue;
      if (!this.strokeBefore.has(i)) this.strokeBefore.set(i, attr.getZ(i));
      const falloff = 1 - Math.sqrt(distanceSq) / Math.max(0.001, this.radius);
      const current = attr.getZ(i);
      let next = current;
      if (this.mode === 'raise') next = current + this.strength * falloff * 0.12;
      else if (this.mode === 'lower') next = current - this.strength * falloff * 0.12;
      else if (this.mode === 'smooth') next = THREE.MathUtils.lerp(current, average, Math.min(1, this.strength * 0.04 * falloff));
      else if (this.mode === 'flatten') next = THREE.MathUtils.lerp(current, this.flattenHeight, Math.min(1, this.strength * 0.05 * falloff));
      attr.setZ(i, next);
      this.strokeAfter.set(i, next);
    }
    this.finishGeometry(terrain);
    this.capturePatch(terrain, this.strokeAfter.keys());
  }

  private finishGeometry(terrain: THREE.Mesh) {
    const attr = terrain.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    terrain.geometry.computeVertexNormals();
    terrain.geometry.computeBoundingBox();
    terrain.geometry.computeBoundingSphere();
  }

  private capturePatch(terrain: THREE.Mesh, indices: Iterable<number>) {
    const tileKey = this.app.store.tileKey;
    if (!tileKey) return;
    const patch = this.patches.get(tileKey) ?? { tileKey, vertices: {} };
    const attr = terrain.geometry.getAttribute('position') as THREE.BufferAttribute;
    const baseline = this.ensureOriginal(terrain);
    for (const index of indices) {
      const z = attr.getZ(index);
      if (Math.abs(z - baseline[index]) < 0.0001) delete patch.vertices[String(index)];
      else patch.vertices[String(index)] = Number(z.toFixed(5));
    }
    if (Object.keys(patch.vertices).length) this.patches.set(tileKey, patch); else this.patches.delete(tileKey);
    this.persist();
  }

  private restoreCurrentTile() {
    const terrain = this.terrain();
    const patch = this.patches.get(this.app.store.tileKey);
    if (!terrain || !patch) return;
    this.ensureOriginal(terrain);
    const attr = terrain.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (const [key, value] of Object.entries(patch.vertices)) {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0 && index < attr.count) attr.setZ(index, value);
    }
    this.finishGeometry(terrain);
  }

  private revertTile() {
    const terrain = this.terrain();
    if (!terrain) return;
    const baseline = this.ensureOriginal(terrain);
    const attr = terrain.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < attr.count; i++) attr.setZ(i, baseline[i]);
    this.finishGeometry(terrain);
    this.patches.delete(this.app.store.tileKey);
    this.persist();
    this.renderCurrent();
  }

  private render(host: HTMLElement) {
    this.panel = host;
    host.innerHTML = `<div class="engine-tool-header"><strong>Terrain Authoring</strong><span>${this.app.store.tileKey || 'No tile'} · package-backed sculpting</span><div><button data-terrain-revert>Revert Tile</button></div></div>
      <div class="custom-author-grid"><section><h3>Sculpt Brush</h3><div class="terrain-mode-row">${(['off','raise','lower','smooth','flatten'] as TerrainBrushMode[]).map((mode) => `<button data-terrain-mode="${mode}" class="${this.mode === mode ? 'active' : ''}">${mode}</button>`).join('')}</div>
      <label>Radius <input data-terrain-radius type="number" min="1" max="120" step="1" value="${this.radius}"/></label>
      <label>Strength <input data-terrain-strength type="number" min="0.1" max="20" step="0.1" value="${this.strength}"/></label>
      <label>Flatten height <input data-terrain-height type="number" step="0.25" value="${this.flattenHeight}"/></label>
      <p>Drag LMB over the active tile. Every stroke is undoable and persists as per-vertex terrain overrides.</p></section>
      <section><h3>Pipeline</h3><p><strong>Studio Scene:</strong> live preview now.</p><p><strong>Project package:</strong> terrain deltas are exported with Custom World Authoring.</p><p><strong>CleanClient Game:</strong> not hot-applied yet; there is intentionally no fake Push button until the game runtime consumes terrain deltas.</p><p>${Object.keys(this.patches.get(this.app.store.tileKey)?.vertices ?? {}).length.toLocaleString()} modified vertices on this tile.</p></section></div>`;
    host.querySelectorAll<HTMLButtonElement>('[data-terrain-mode]').forEach((button) => button.addEventListener('click', () => this.setMode(button.dataset.terrainMode as TerrainBrushMode)));
    host.querySelector<HTMLInputElement>('[data-terrain-radius]')!.addEventListener('change', (event) => { this.radius = Math.max(1, Number((event.target as HTMLInputElement).value)); });
    host.querySelector<HTMLInputElement>('[data-terrain-strength]')!.addEventListener('change', (event) => { this.strength = Math.max(0.1, Number((event.target as HTMLInputElement).value)); });
    host.querySelector<HTMLInputElement>('[data-terrain-height]')!.addEventListener('change', (event) => { this.flattenHeight = Number((event.target as HTMLInputElement).value) || 0; });
    host.querySelector('[data-terrain-revert]')!.addEventListener('click', () => this.revertTile());
  }

  private renderCurrent() { if (this.panel?.isConnected) this.render(this.panel); }

  private validate() {
    return this.snapshot().flatMap((patch) => Object.entries(patch.vertices).filter(([, value]) => !Number.isFinite(value)).map(([index]) => ({ severity: 'error' as const, code: 'terrain.invalid-height', message: `${patch.tileKey} vertex ${index} has an invalid height.` })));
  }

  private persist() {
    try { localStorage.setItem(STORAGE, JSON.stringify(this.snapshot())); } catch { /* quota */ }
    this.dispatchEvent(new Event('change'));
    this.renderCurrent();
  }

  private load() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE) ?? '[]') as TerrainTilePatch[];
      if (Array.isArray(parsed)) this.patches = new Map(parsed.filter((patch) => patch?.tileKey).map((patch) => [patch.tileKey, { tileKey: patch.tileKey, vertices: { ...(patch.vertices ?? {}) } }]));
    } catch { /* ignore malformed local cache */ }
  }
}
