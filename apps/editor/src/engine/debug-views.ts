import * as THREE from 'three';
import type { EditorObjectStore } from '../editor-store';

export type DebugViewMode = 'shaded' | 'wireframe' | 'unlit' | 'overdraw';

type WireMaterial = THREE.Material & { wireframe?: boolean };

export class DebugViewController extends EventTarget {
  mode: DebugViewMode = 'shaded';
  bounds = false;
  terrainWire = false;
  private originalOverride: THREE.Material | null = null;
  private overdraw = new THREE.MeshBasicMaterial({ color: 0x203080, transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending });
  private unlit = new THREE.MeshBasicMaterial({ color: 0xdddddd });
  private wireStates = new Map<string, boolean>();
  private boundsHelpers: THREE.BoxHelper[] = [];

  constructor(private readonly scene: THREE.Scene, private readonly store: EditorObjectStore) {
    super();
    store.addEventListener('change', () => { if (this.bounds) this.rebuildBounds(); });
  }

  setMode(mode: DebugViewMode) {
    if (this.mode === 'wireframe') this.restoreWireframe();
    this.scene.overrideMaterial = this.originalOverride;
    this.mode = mode;
    if (mode === 'wireframe') this.applyWireframe();
    if (mode === 'unlit') this.scene.overrideMaterial = this.unlit;
    if (mode === 'overdraw') this.scene.overrideMaterial = this.overdraw;
    this.dispatchEvent(new CustomEvent('change', { detail: mode }));
  }

  setBounds(enabled: boolean) {
    this.bounds = enabled;
    this.rebuildBounds();
    this.dispatchEvent(new Event('change'));
  }

  setTerrainWire(enabled: boolean) {
    this.terrainWire = enabled;
    this.scene.traverse((object) => {
      if (!object.userData.editorTerrain) return;
      const mesh = object as THREE.Mesh;
      const list = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of list) if ('wireframe' in material) (material as WireMaterial).wireframe = enabled;
    });
    this.dispatchEvent(new Event('change'));
  }

  selectedMaterialSummary() {
    const record = this.store.selected;
    if (!record) return [] as Array<{ name: string; type: string; uniforms: string[]; textures: string[] }>;
    const result: Array<{ name: string; type: string; uniforms: string[]; textures: string[] }> = [];
    record.object.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const list = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of list) {
        const textures: string[] = [];
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.push(String(value.userData?.sourceUrl ?? value.name ?? value.uuid));
        result.push({ name: material.name || material.uuid.slice(0, 8), type: material.type, uniforms: material instanceof THREE.ShaderMaterial ? Object.keys(material.uniforms) : [], textures });
      }
    });
    return result;
  }

  private applyWireframe() {
    this.wireStates.clear();
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const list = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of list) {
        if (!('wireframe' in material)) continue;
        const target = material as WireMaterial;
        this.wireStates.set(material.uuid, target.wireframe === true);
        target.wireframe = true;
      }
    });
  }

  private restoreWireframe() {
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const list = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of list) {
        if (!('wireframe' in material)) continue;
        (material as WireMaterial).wireframe = this.wireStates.get(material.uuid) ?? false;
      }
    });
    this.wireStates.clear();
  }

  private rebuildBounds() {
    for (const helper of this.boundsHelpers) { helper.removeFromParent(); helper.dispose(); }
    this.boundsHelpers = [];
    if (!this.bounds) return;
    for (const record of this.store.records.values()) {
      if (!record.object.visible || record.state === 'deleted') continue;
      const helper = new THREE.BoxHelper(record.object, 0x66aaff);
      helper.userData.editorNonSelectable = true;
      this.scene.add(helper);
      this.boundsHelpers.push(helper);
    }
  }
}
