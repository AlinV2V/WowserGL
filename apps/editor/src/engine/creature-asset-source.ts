import * as THREE from 'three';
import { loadOptimizedTexture } from '../optimized-texture-loader';
import type { EditorAsset } from '../types';

type CreatureDisplay = { displayId: number; model: string; scale: number; alpha: number; skins?: Array<string | null>; bakeSkin?: string | null; visible?: number[] };
type CreatureSubmesh = { partId: number; textureType: number; type0Tex: string | null; blendMode: number; renderFlags: number; indexStart: number; indexCount: number };
type CreatureModel = { source: string; vertexCount: number; indexCount: number; indexType: 'u16' | 'u32'; submeshes: CreatureSubmesh[]; sequences?: unknown[]; globalSequences?: unknown[]; bones?: unknown[]; attachments?: unknown[]; cameras?: unknown[] };

async function gzipJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Creature model HTTP ${response.status}: ${url}`);
  if (!response.body) return await response.json() as T;
  const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text()) as T;
}

const textureFor = (submesh: CreatureSubmesh, display: CreatureDisplay) => {
  if (submesh.type0Tex) return submesh.type0Tex;
  if (submesh.textureType === 1) return display.bakeSkin ?? null;
  if (submesh.textureType === 11) return display.skins?.[0] ?? null;
  if (submesh.textureType === 12) return display.skins?.[1] ?? null;
  if (submesh.textureType === 13) return display.skins?.[2] ?? null;
  return null;
};

export class CreatureAssetSource {
  private cache = new Map<number, Promise<EditorAsset>>();

  load(displayId: number, fallbackPath = `Creature Display ${displayId}`) {
    let pending = this.cache.get(displayId);
    if (!pending) {
      pending = this.loadInternal(displayId, fallbackPath);
      this.cache.set(displayId, pending);
      pending.catch(() => this.cache.delete(displayId));
    }
    return pending;
  }

  private async loadInternal(displayId: number, fallbackPath: string): Promise<EditorAsset> {
    const displayResponse = await fetch(`/creatures/display/${displayId}.json`);
    if (!displayResponse.ok) throw new Error(`Creature display ${displayId} is not baked in CleanClientMMO.`);
    const display = await displayResponse.json() as CreatureDisplay;
    const [meta, geoResponse] = await Promise.all([
      gzipJson<CreatureModel>(`/creatures/models/${display.model}/model.json.gz`),
      fetch(`/creatures/models/${display.model}/geo.bin`),
    ]);
    if (!geoResponse.ok) throw new Error(`Creature geometry HTTP ${geoResponse.status}`);
    const buffer = await geoResponse.arrayBuffer();
    const v = meta.vertexCount;
    let offset = 0;
    const positions = new Float32Array(buffer, offset, v * 3); offset += v * 3 * 4;
    const normals = new Float32Array(buffer, offset, v * 3); offset += v * 3 * 4;
    const uvs = new Float32Array(buffer, offset, v * 2); offset += v * 2 * 4;
    offset += v * 4; // bone weights
    offset += v * 4; // bone indices
    const indices = meta.indexType === 'u32'
      ? new Uint32Array(buffer, offset, meta.indexCount)
      : new Uint16Array(buffer, offset, meta.indexCount);

    const textureUrls = new Set<string>();
    for (const submesh of meta.submeshes) {
      const url = textureFor(submesh, display);
      if (url) textureUrls.add(url);
    }
    const textureMap = new Map<string, THREE.Texture>();
    await Promise.all([...textureUrls].map(async (url) => {
      try { textureMap.set(url, await loadOptimizedTexture(url)); } catch (error) { console.warn(`[Studio] creature texture unavailable ${url}`, error); }
    }));

    const template = new THREE.Group();
    template.name = meta.source || fallbackPath;
    const visible = new Set(display.visible?.length ? display.visible : meta.submeshes.map((_, index) => index));
    let triangles = 0;
    meta.submeshes.forEach((submesh, index) => {
      if (!visible.has(index) || submesh.indexCount <= 0) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      geometry.setDrawRange(submesh.indexStart, submesh.indexCount);
      const url = textureFor(submesh, display);
      const material = new THREE.MeshLambertMaterial({
        map: url ? textureMap.get(url) ?? null : null,
        color: 0xffffff,
        transparent: submesh.blendMode >= 2 || display.alpha < 255,
        opacity: display.alpha > 0 ? Math.min(1, display.alpha / 255) : 1,
        depthWrite: submesh.blendMode < 2,
        alphaTest: submesh.blendMode === 1 ? 25 / 255 : 0,
        side: (submesh.renderFlags & 0x04) ? THREE.DoubleSide : THREE.FrontSide,
      });
      material.name = `Creature part ${submesh.partId}`;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.editorMaterial = { meshIndex: 0, partIndex: index, textureIndex: index };
      template.add(mesh);
      triangles += Math.floor(submesh.indexCount / 3);
    });
    template.scale.setScalar(display.scale || 1);
    template.userData.creatureDisplayId = displayId;
    template.userData.creatureAnimation = { sequences: meta.sequences ?? [], globalSequences: meta.globalSequences ?? [], bones: meta.bones ?? [], attachments: meta.attachments ?? [], cameras: meta.cameras ?? [] };
    const model = meta.source || fallbackPath;
    return { id: `creature:${displayId}`, kind: 'm2', model, label: `${model.split(/[\\/]/).pop() || model} · #${displayId}`, template, triangles, textures: [...textureUrls], category: 'creatures' };
  }
}
