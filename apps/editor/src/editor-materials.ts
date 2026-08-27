import * as THREE from 'three';
import type { EditorObjectStore } from './editor-store';
import type { EditorRecord, MaterialLocator, MaterialOverride } from './types';

const colorHex = (material: THREE.Material) => {
  const color = (material as THREE.Material & { color?: THREE.Color }).color;
  return color ? `#${color.getHexString()}` : '#ffffff';
};

const materialName = (material: THREE.Material, index: number) => material.name || `${material.type} ${index + 1}`;

const collectMaterials = (record: EditorRecord) => {
  const rows: Array<{ mesh: THREE.Mesh; material: THREE.Material; locator: MaterialLocator; slot: number }> = [];
  let slot = 0;
  record.object.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material, materialIndex) => {
      const meta = mesh.userData.editorMaterial ?? mesh.userData.wmoPick ?? mesh.userData.wowDoodad ?? {};
      rows.push({
        mesh,
        material,
        slot,
        locator: {
          slot,
          materialIndex,
          groupIndex: Number.isFinite(meta.groupIndex) ? Number(meta.groupIndex) : undefined,
          batchIndex: Number.isFinite(meta.batchIndex) ? Number(meta.batchIndex) : undefined,
          meshIndex: Number.isFinite(meta.meshIndex) ? Number(meta.meshIndex) : undefined,
          partIndex: Number.isFinite(meta.partIndex ?? meta.part) ? Number(meta.partIndex ?? meta.part) : undefined,
          textureIndex: Number.isFinite(meta.textureIndex ?? meta.tex) ? Number(meta.textureIndex ?? meta.tex) : undefined,
        },
      });
      slot++;
    });
  });
  return rows;
};

const locatorMatches = (a: MaterialLocator, b: MaterialLocator) => {
  if (a.slot === b.slot) return true;
  if (a.groupIndex !== undefined && b.groupIndex !== undefined && a.groupIndex !== b.groupIndex) return false;
  if (a.meshIndex !== undefined && b.meshIndex !== undefined && a.meshIndex !== b.meshIndex) return false;
  if (a.partIndex !== undefined && b.partIndex !== undefined && a.partIndex !== b.partIndex) return false;
  if (a.textureIndex !== undefined && b.textureIndex !== undefined && a.textureIndex !== b.textureIndex) return false;
  return a.groupIndex !== undefined || a.meshIndex !== undefined || a.partIndex !== undefined || a.textureIndex !== undefined;
};

export class EditorMaterialInspector extends EventTarget {
  private record: EditorRecord | null = null;
  private overrides = new Map<string, MaterialOverride>();

  constructor(private readonly container: HTMLElement, private readonly store: EditorObjectStore) {
    super();
    store.addEventListener('selection', (event) => {
      this.record = (event as CustomEvent<EditorRecord | null>).detail;
      this.render();
    });
  }

  setOverrides(overrides: MaterialOverride[]) {
    this.overrides.clear();
    for (const override of overrides) this.overrides.set(override.id, override);
    this.render();
  }

  getOverrides() {
    return [...this.overrides.values()];
  }

  applyOverride(record: EditorRecord, override: MaterialOverride) {
    for (const row of collectMaterials(record)) {
      if (!locatorMatches(row.locator, override.locator)) continue;
      this.applyPreview(row.mesh, row.locator.materialIndex ?? 0, override);
    }
    this.overrides.set(override.id, override);
    if (this.record === record) this.render();
  }

  render() {
    if (!this.record) {
      this.container.innerHTML = '<div class="component-card"><div class="component-head"><strong>Renderer</strong></div><div class="component-empty">Select an object to inspect its materials.</div></div>';
      return;
    }
    const rows = collectMaterials(this.record);
    this.container.innerHTML = `
      <div class="component-card material-component">
        <div class="component-head"><span class="component-toggle">▾</span><strong>Renderer / Materials</strong><span class="component-badge">${rows.length}</span></div>
        <div class="component-body material-list" data-material-list></div>
      </div>`;
    const list = this.container.querySelector<HTMLElement>('[data-material-list]')!;
    if (!rows.length) {
      list.innerHTML = '<div class="component-empty">No editable renderer material found.</div>';
      return;
    }
    rows.slice(0, 64).forEach((row, index) => {
      const key = this.overrideKey(this.record!, row.locator);
      const existing = this.overrides.get(key);
      const item = document.createElement('div');
      item.className = 'material-row';
      item.innerHTML = `
        <div class="material-title"><span class="material-swatch" style="background:${existing?.color ?? colorHex(row.material)}"></span><strong>${materialName(row.material, index)}</strong><span>#${row.locator.slot}</span></div>
        <div class="material-controls">
          <label><span>Tint</span><input data-color type="color" value="${existing?.color ?? colorHex(row.material)}" /></label>
          <label class="material-texture"><span>Texture override</span><input data-texture value="${existing?.textureUrl ?? ''}" placeholder="/textures/custom/red_flag.ktx2" spellcheck="false" /></label>
          <label><span>Scope</span><select data-scope><option value="instance"${existing?.scope !== 'asset' ? ' selected' : ''}>This object</option><option value="asset"${existing?.scope === 'asset' ? ' selected' : ''}>All same asset</option></select></label>
          <div class="material-actions"><button data-preview>Apply Preview</button><button class="accent" data-push>Push to Game</button></div>
        </div>`;
      const color = item.querySelector<HTMLInputElement>('[data-color]')!;
      const texture = item.querySelector<HTMLInputElement>('[data-texture]')!;
      const scope = item.querySelector<HTMLSelectElement>('[data-scope]')!;
      const buildOverride = (): MaterialOverride => ({
        id: key,
        recordId: this.record!.id,
        tileKey: this.record!.tileKey,
        kind: this.record!.kind,
        model: this.record!.model,
        sourceId: this.record!.sourceId,
        locator: row.locator,
        scope: scope.value as 'instance' | 'asset',
        color: color.value,
        textureUrl: texture.value.trim() || undefined,
      });
      item.querySelector('[data-preview]')!.addEventListener('click', () => {
        const override = buildOverride();
        this.applyPreview(row.mesh, row.locator.materialIndex ?? 0, override);
        this.overrides.set(key, override);
        this.dispatchEvent(new CustomEvent('override', { detail: { record: this.record, override, push: false } }));
        this.render();
      });
      item.querySelector('[data-push]')!.addEventListener('click', () => {
        const override = buildOverride();
        this.applyPreview(row.mesh, row.locator.materialIndex ?? 0, override);
        this.overrides.set(key, override);
        this.dispatchEvent(new CustomEvent('override', { detail: { record: this.record, override, push: true } }));
        this.render();
      });
      list.append(item);
    });
  }

  private applyPreview(mesh: THREE.Mesh, materialIndex: number, override: MaterialOverride) {
    const materials = Array.isArray(mesh.material) ? [...mesh.material] : [mesh.material];
    const current = materials[materialIndex];
    if (!current) return;
    let material = current;
    if (!material.userData.editorMaterialClone) {
      material = material.clone();
      material.userData.editorMaterialClone = true;
      materials[materialIndex] = material;
      mesh.material = Array.isArray(mesh.material) ? materials : material;
    }
    const color = (material as THREE.Material & { color?: THREE.Color }).color;
    if (color && override.color) color.set(override.color);
    if (override.textureUrl && 'map' in material) {
      const texture = new THREE.TextureLoader().load(override.textureUrl);
      texture.colorSpace = THREE.SRGBColorSpace;
      (material as THREE.MeshBasicMaterial).map = texture;
    }
    material.needsUpdate = true;
  }

  private overrideKey(record: EditorRecord, locator: MaterialLocator) {
    const source = String(record.sourceId ?? record.id);
    return `${record.tileKey}:${record.kind}:${source}:${locator.groupIndex ?? 'g'}:${locator.meshIndex ?? 'm'}:${locator.partIndex ?? 'p'}:${locator.textureIndex ?? 't'}:${locator.slot}`;
  }
}
