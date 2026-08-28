import * as THREE from 'three';
import type { EditorObjectStore } from './editor-store';
import type { EditorRecord, MaterialLocator, MaterialOverride } from './types';

const colorHex = (material: THREE.Material) => {
  const color = (material as THREE.Material & { color?: THREE.Color }).color;
  return color ? `#${color.getHexString()}` : '#ffffff';
};
const emissiveHex = (material: THREE.Material) => {
  const color = (material as THREE.Material & { emissive?: THREE.Color }).emissive;
  return color ? `#${color.getHexString()}` : '#000000';
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
      rows.push({ mesh, material, slot, locator: {
        slot,
        materialIndex,
        groupIndex: Number.isFinite(meta.groupIndex) ? Number(meta.groupIndex) : undefined,
        batchIndex: Number.isFinite(meta.batchIndex) ? Number(meta.batchIndex) : undefined,
        meshIndex: Number.isFinite(meta.meshIndex) ? Number(meta.meshIndex) : undefined,
        partIndex: Number.isFinite(meta.partIndex ?? meta.part) ? Number(meta.partIndex ?? meta.part) : undefined,
        textureIndex: Number.isFinite(meta.textureIndex ?? meta.tex) ? Number(meta.textureIndex ?? meta.tex) : undefined,
      } });
      slot++;
    });
  });
  return rows;
};

const locatorMatches = (a: MaterialLocator, b: MaterialLocator) => {
  if (a.slot === b.slot) return true;
  if (a.groupIndex !== undefined && b.groupIndex !== undefined && a.groupIndex !== b.groupIndex) return false;
  if (a.batchIndex !== undefined && b.batchIndex !== undefined && a.batchIndex !== b.batchIndex) return false;
  if (a.meshIndex !== undefined && b.meshIndex !== undefined && a.meshIndex !== b.meshIndex) return false;
  if (a.partIndex !== undefined && b.partIndex !== undefined && a.partIndex !== b.partIndex) return false;
  if (a.textureIndex !== undefined && b.textureIndex !== undefined && a.textureIndex !== b.textureIndex) return false;
  return a.groupIndex !== undefined || a.batchIndex !== undefined || a.meshIndex !== undefined || a.partIndex !== undefined || a.textureIndex !== undefined;
};

export class EditorMaterialInspector extends EventTarget {
  private record: EditorRecord | null = null;
  private overrides = new Map<string, MaterialOverride>();

  constructor(private readonly container: HTMLElement, private readonly store: EditorObjectStore) {
    super();
    store.addEventListener('selection', (event) => { this.record = (event as CustomEvent<EditorRecord | null>).detail; this.render(); });
  }

  setOverrides(overrides: MaterialOverride[]) {
    this.overrides.clear();
    for (const override of overrides) this.overrides.set(override.id, override);
    this.render();
  }

  getOverrides() { return [...this.overrides.values()]; }

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
    this.container.innerHTML = `<div class="component-card material-component"><div class="component-head"><span class="component-toggle">▾</span><strong>Renderer / Materials</strong><span class="component-badge">${rows.length}</span></div><div class="component-body material-list" data-material-list></div></div>`;
    const list = this.container.querySelector<HTMLElement>('[data-material-list]')!;
    if (!rows.length) { list.innerHTML = '<div class="component-empty">No editable renderer material found.</div>'; return; }

    rows.slice(0, 64).forEach((row, index) => {
      const key = this.overrideKey(this.record!, row.locator);
      const existing = this.overrides.get(key);
      const map = (row.material as THREE.Material & { map?: THREE.Texture | null }).map ?? null;
      const opacity = existing?.opacity ?? row.material.opacity ?? 1;
      const uvScale = existing?.uvScale ?? (map ? [map.repeat.x, map.repeat.y] as [number, number] : [1, 1]);
      const uvOffset = existing?.uvOffset ?? (map ? [map.offset.x, map.offset.y] as [number, number] : [0, 0]);
      const item = document.createElement('div');
      item.className = 'material-row material-row-advanced';
      item.innerHTML = `<div class="material-title"><span class="material-swatch" style="background:${existing?.color ?? colorHex(row.material)}"></span><strong>${materialName(row.material, index)}</strong><span>#${row.locator.slot}</span></div>
        <div class="material-controls">
          <label><span>Tint</span><input data-color type="color" value="${existing?.color ?? colorHex(row.material)}" /></label>
          <label class="material-texture"><span>Texture override</span><input data-texture value="${existing?.textureUrl ?? ''}" placeholder="/textures/custom/red_flag.png" spellcheck="false" /></label>
          <label><span>Shader</span><select data-shader><option value="vanilla">Vanilla Lit</option><option value="unlit">Unlit</option><option value="emissive">Emissive</option></select></label>
          <label><span>Emissive</span><input data-emissive type="color" value="${existing?.emissive ?? emissiveHex(row.material)}" /></label>
          <label><span>Opacity</span><input data-opacity type="number" min="0" max="1" step="0.05" value="${opacity}" /></label>
          <label><span>UV Scale</span><span class="material-vector"><input data-uv-scale-x type="number" step="0.05" value="${uvScale[0]}"/><input data-uv-scale-y type="number" step="0.05" value="${uvScale[1]}"/></span></label>
          <label><span>UV Offset</span><span class="material-vector"><input data-uv-offset-x type="number" step="0.05" value="${uvOffset[0]}"/><input data-uv-offset-y type="number" step="0.05" value="${uvOffset[1]}"/></span></label>
          <label><span>Scope</span><select data-scope><option value="instance"${existing?.scope !== 'asset' ? ' selected' : ''}>This object</option><option value="asset"${existing?.scope === 'asset' ? ' selected' : ''}>All same asset</option></select></label>
          <label class="material-check"><input data-double-sided type="checkbox" ${existing?.doubleSided ?? row.material.side === THREE.DoubleSide ? 'checked' : ''}/><span>Double-sided</span></label>
          <label class="material-check"><input data-depth-write type="checkbox" ${existing?.depthWrite ?? row.material.depthWrite ? 'checked' : ''}/><span>Depth write</span></label>
          <div class="material-actions"><button data-preview>Apply Preview</button><button class="accent" data-push>Push to Game</button></div>
        </div>`;
      const shader = item.querySelector<HTMLSelectElement>('[data-shader]')!;
      shader.value = existing?.shaderMode ?? 'vanilla';
      const buildOverride = (): MaterialOverride => ({
        id: key,
        recordId: this.record!.id,
        tileKey: this.record!.tileKey,
        kind: this.record!.kind,
        model: this.record!.model,
        sourceId: this.record!.sourceId,
        locator: row.locator,
        scope: item.querySelector<HTMLSelectElement>('[data-scope]')!.value as 'instance' | 'asset',
        color: item.querySelector<HTMLInputElement>('[data-color]')!.value,
        textureUrl: item.querySelector<HTMLInputElement>('[data-texture]')!.value.trim() || undefined,
        shaderMode: shader.value as 'vanilla' | 'unlit' | 'emissive',
        emissive: item.querySelector<HTMLInputElement>('[data-emissive]')!.value,
        opacity: THREE.MathUtils.clamp(Number(item.querySelector<HTMLInputElement>('[data-opacity]')!.value), 0, 1),
        doubleSided: item.querySelector<HTMLInputElement>('[data-double-sided]')!.checked,
        depthWrite: item.querySelector<HTMLInputElement>('[data-depth-write]')!.checked,
        uvScale: [Number(item.querySelector<HTMLInputElement>('[data-uv-scale-x]')!.value) || 1, Number(item.querySelector<HTMLInputElement>('[data-uv-scale-y]')!.value) || 1],
        uvOffset: [Number(item.querySelector<HTMLInputElement>('[data-uv-offset-x]')!.value) || 0, Number(item.querySelector<HTMLInputElement>('[data-uv-offset-y]')!.value) || 0],
      });
      item.querySelector('[data-preview]')!.addEventListener('click', () => this.commit(row, key, buildOverride(), false));
      item.querySelector('[data-push]')!.addEventListener('click', () => this.commit(row, key, buildOverride(), true));
      list.append(item);
    });
  }

  private commit(row: ReturnType<typeof collectMaterials>[number], key: string, override: MaterialOverride, push: boolean) {
    this.applyPreview(row.mesh, row.locator.materialIndex ?? 0, override);
    this.overrides.set(key, override);
    this.dispatchEvent(new CustomEvent('override', { detail: { record: this.record, override, push } }));
    this.render();
  }

  private applyPreview(mesh: THREE.Mesh, materialIndex: number, override: MaterialOverride) {
    const materials = Array.isArray(mesh.material) ? [...mesh.material] : [mesh.material];
    const current = materials[materialIndex];
    if (!current) return;
    let material = current;
    if (!material.userData.editorMaterialClone) {
      material = material.clone();
      material.userData = { ...material.userData, editorMaterialClone: true, editorOriginalMaterial: current };
      if (material instanceof THREE.ShaderMaterial) material.uniforms = THREE.UniformsUtils.clone(material.uniforms);
      materials[materialIndex] = material;
      mesh.material = Array.isArray(mesh.material) ? materials : material;
    }
    const color = (material as THREE.Material & { color?: THREE.Color }).color;
    if (color && override.color) color.set(override.color);
    const emissive = (material as THREE.Material & { emissive?: THREE.Color; emissiveIntensity?: number }).emissive;
    if (emissive && override.emissive) {
      emissive.set(override.shaderMode === 'emissive' ? override.emissive : '#000000');
      if ('emissiveIntensity' in material) (material as THREE.MeshStandardMaterial).emissiveIntensity = override.shaderMode === 'emissive' ? 1 : 0;
    }
    if (override.opacity !== undefined) {
      material.opacity = THREE.MathUtils.clamp(override.opacity, 0, 1);
      material.transparent = material.opacity < 0.999;
    }
    if (override.doubleSided !== undefined) material.side = override.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
    if (override.depthWrite !== undefined) material.depthWrite = override.depthWrite;
    const mapped = material as THREE.Material & { map?: THREE.Texture | null };
    if (override.textureUrl && 'map' in material) {
      const texture = new THREE.TextureLoader().load(override.textureUrl);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      mapped.map = texture;
    }
    if (mapped.map) {
      mapped.map.wrapS = mapped.map.wrapT = THREE.RepeatWrapping;
      if (override.uvScale) mapped.map.repeat.set(override.uvScale[0], override.uvScale[1]);
      if (override.uvOffset) mapped.map.offset.set(override.uvOffset[0], override.uvOffset[1]);
      mapped.map.needsUpdate = true;
    }
    material.userData.editorShaderMode = override.shaderMode ?? 'vanilla';
    if (material instanceof THREE.ShaderMaterial) {
      const uniforms = material.uniforms;
      if (override.shaderMode === 'unlit') {
        if (uniforms.uSunColor?.value?.setRGB) uniforms.uSunColor.value.setRGB(0, 0, 0);
        if (uniforms.uSkyAmbient?.value?.setRGB) uniforms.uSkyAmbient.value.setRGB(1, 1, 1);
        if (uniforms.uGroundAmbient?.value?.setRGB) uniforms.uGroundAmbient.value.setRGB(1, 1, 1);
      }
      if (override.shaderMode === 'emissive') {
        if (uniforms.uSunColor?.value?.setRGB) uniforms.uSunColor.value.setRGB(0, 0, 0);
        if (uniforms.uSkyAmbient?.value?.setRGB) uniforms.uSkyAmbient.value.setRGB(1, 1, 1);
        if (uniforms.uGroundAmbient?.value?.setRGB) uniforms.uGroundAmbient.value.setRGB(1, 1, 1);
      }
    }
    material.needsUpdate = true;
  }

  private overrideKey(record: EditorRecord, locator: MaterialLocator) {
    const source = String(record.sourceId ?? record.id);
    return `${record.tileKey}:${record.kind}:${source}:${locator.groupIndex ?? 'g'}:${locator.meshIndex ?? 'm'}:${locator.partIndex ?? 'p'}:${locator.textureIndex ?? 't'}:${locator.slot}`;
  }
}
