import * as THREE from 'three';
import type { EditorRecord } from '../types';
import type { SceneComponentModel } from './component-model';

export type GraphNode = { id: string; label: string; kind: 'entity' | 'component' | 'material' | 'texture' | 'geometry' | 'tile' | 'server'; detail?: string };
export type GraphEdge = { from: string; to: string; label?: string };
export type DependencyGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

export function buildDependencyGraph(record: EditorRecord, components: SceneComponentModel): DependencyGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const addNode = (node: GraphNode) => { if (!seen.has(node.id)) { seen.add(node.id); nodes.push(node); } };
  const link = (from: string, to: string, label?: string) => edges.push({ from, to, label });
  const root = `entity:${record.id}`;
  addNode({ id: root, label: record.model.split(/[\\/]/).pop() || record.model, kind: 'entity', detail: record.kind.toUpperCase() });
  const tile = `tile:${record.tileKey}`;
  addNode({ id: tile, label: record.tileKey, kind: 'tile' });
  link(root, tile, 'placed in');

  const entity = components.entities.get(record.id);
  for (const entry of entity?.components ?? []) {
    const id = `component:${record.id}:${entry.type}`;
    addNode({ id, label: entry.type, kind: entry.type.endsWith('Spawn') ? 'server' : 'component', detail: entry.enabled ? 'enabled' : 'disabled' });
    link(root, id, 'component');
  }

  const textureNodes = new Map<string, string>();
  record.textures.forEach((texture, index) => {
    const id = `texture:${texture.toLowerCase()}`;
    textureNodes.set(texture, id);
    addNode({ id, label: texture.split(/[\\/]/).pop() || `Texture ${index}`, kind: 'texture', detail: texture });
  });

  let meshIndex = 0;
  record.object.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geoId = `geometry:${record.id}:${meshIndex}`;
    const triangles = Math.floor((mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position')?.count ?? 0) / 3);
    addNode({ id: geoId, label: mesh.name || `Geometry ${meshIndex}`, kind: 'geometry', detail: `${triangles.toLocaleString()} tris` });
    link(root, geoId, 'geometry');
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    materials.forEach((material, materialIndex) => {
      const matId = `material:${material.uuid}`;
      addNode({ id: matId, label: material.name || `${material.type} ${materialIndex}`, kind: 'material', detail: material.type });
      link(geoId, matId, 'material');
      for (const value of Object.values(material)) {
        if (!(value instanceof THREE.Texture)) continue;
        const source = String(value.userData?.sourceUrl ?? value.name ?? value.uuid);
        const texId = textureNodes.get(source) ?? `texture:${source.toLowerCase()}`;
        addNode({ id: texId, label: source.split(/[\\/]/).pop() || 'Texture', kind: 'texture', detail: source });
        link(matId, texId, 'samples');
      }
      if (material instanceof THREE.ShaderMaterial) {
        for (const [name, uniform] of Object.entries(material.uniforms)) {
          if (!(uniform?.value instanceof THREE.Texture)) continue;
          const source = String(uniform.value.userData?.sourceUrl ?? uniform.value.name ?? uniform.value.uuid);
          const texId = `texture:${source.toLowerCase()}`;
          addNode({ id: texId, label: source.split(/[\\/]/).pop() || name, kind: 'texture', detail: `${name} · ${source}` });
          link(matId, texId, name);
        }
      }
    });
    meshIndex++;
  });
  return { nodes, edges };
}
