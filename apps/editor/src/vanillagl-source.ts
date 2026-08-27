import * as THREE from 'three';
import { createTerrainMaterial } from './terrain-shader';
import { loadOptimizedTexture } from './optimized-texture-loader';
import { TILE_HALF, TILE_SIZE, type EditorAsset, type LoadedEditorTile, type TileMeta } from './types';
import { loadWmoBinary } from './wmo-binary';

type DoodadManifest = { textures?: string[]; meshes?: Array<any>; instances?: Array<any> };
type WmoManifest = { textures?: string[]; models?: Array<any>; instances?: Array<any> };

const optionalJson = async <T>(url: string): Promise<T | null> => {
  try {
    const response = await fetch(url);
    if (!response.ok || response.headers.get('content-type')?.includes('text/html')) return null;
    return await response.json() as T;
  } catch { return null; }
};

const optionalBuffer = async (url: string): Promise<ArrayBuffer | null> => {
  try {
    const response = await fetch(url);
    if (!response.ok || response.headers.get('content-type')?.includes('text/html')) return null;
    return await response.arrayBuffer();
  } catch { return null; }
};

const indexAttribute = (indices: ArrayLike<number>) => {
  let max = 0;
  for (let i = 0; i < indices.length; i++) max = Math.max(max, Number(indices[i]));
  return new THREE.BufferAttribute(max <= 65535 ? Uint16Array.from(indices) : Uint32Array.from(indices), 1);
};

const countTriangles = (root: THREE.Object3D) => {
  let triangles = 0;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.geometry) return;
    triangles += Math.floor((mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position')?.count ?? 0) / 3);
  });
  return triangles;
};

const logicalTextureUrl = (base: string, name: string) => {
  const clean = String(name ?? '').replaceAll('\\', '/');
  if (!clean) return '';
  if (/^(?:https?:|data:|blob:)/i.test(clean) || clean.startsWith('/')) return clean;
  return `${base}/${clean}`;
};

const sampleTerrainHeightGrid = (heights: ArrayLike<number>, inner: ArrayLike<number> | null, n: number, row: number, col: number) => {
  const rowF = THREE.MathUtils.clamp(row, 0, n - 1);
  const colF = THREE.MathUtils.clamp(col, 0, n - 1);
  const r0 = Math.min(n - 2, Math.floor(rowF));
  const c0 = Math.min(n - 2, Math.floor(colF));
  const fr = rowF - r0, fc = colF - c0;
  if (!inner) {
    const h0 = THREE.MathUtils.lerp(heights[r0 * n + c0], heights[(r0 + 1) * n + c0], fr);
    const h1 = THREE.MathUtils.lerp(heights[r0 * n + c0 + 1], heights[(r0 + 1) * n + c0 + 1], fr);
    return THREE.MathUtils.lerp(h0, h1, fc);
  }
  const a = heights[r0 * n + c0], b = heights[(r0 + 1) * n + c0];
  const c = heights[(r0 + 1) * n + c0 + 1], d = heights[r0 * n + c0 + 1];
  const m = inner[r0 * (n - 1) + c0];
  if (fr + fc <= 1 && fr <= 0.5 && fc <= 0.5) return a + (b - a) * fr * 2 + (m - a - (b - a) * 0.5) * fc * 2;
  if (fr >= fc && fr >= 0.5) return b + (c - b) * fc * 2 + (m - b - (c - b) * 0.5) * (1 - fr) * 2;
  if (fc >= fr && fc >= 0.5) return d + (c - d) * fr * 2 + (m - d - (c - d) * 0.5) * (1 - fc) * 2;
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, fr), THREE.MathUtils.lerp(d, c, fr), fc) * 0.25 + m * 0.75;
};

const categoryFor = (model: string): EditorAsset['category'] => {
  const value = model.toLowerCase();
  if (/creature|human|orc|dragon|guard|npc|character/.test(value)) return 'creatures';
  if (/tree|bush|rock|plant|stump|flower|grass|shrub|mushroom/.test(value)) return 'nature';
  if (/house|castle|bridge|tower|building|wall|gate|tent|inn|abbey|church|farm/.test(value)) return 'structures';
  if (/bench|chair|crate|barrel|campfire|lamp|table|bed|banner|flag|sign|cart|fence/.test(value)) return 'props';
  return 'other';
};

export class VanillaGLAssetSource {
  constructor(private readonly assetBase = '') {}

  async loadTile(tileKey: string, mapId = 0): Promise<LoadedEditorTile> {
    const base = `${this.assetBase}/terrain/tiles/${tileKey}`;
    const wmoPromise = (async () => (await loadWmoBinary(base)) ?? await optionalJson<WmoManifest>(`${base}/wmos.json`))();
    const [metaResponse, heightResponse, holesBuffer, innerBuffer, normalsBuffer, doodads, wmoDoodads, wmos] = await Promise.all([
      fetch(`${base}/meta.json`),
      fetch(`${base}/heights.f32`),
      optionalBuffer(`${base}/holes.bin`),
      optionalBuffer(`${base}/heights_inner.f32`),
      optionalBuffer(`${base}/normals.f32`),
      optionalJson<DoodadManifest>(`${base}/doodads.json`),
      optionalJson<DoodadManifest>(`${base}/wmo_doodads.json`),
      wmoPromise,
    ]);
    if (!metaResponse.ok) throw new Error(`meta.json HTTP ${metaResponse.status}`);
    if (!heightResponse.ok) throw new Error(`heights.f32 HTTP ${heightResponse.status}`);
    const meta = await metaResponse.json() as TileMeta;
    const heights = new Float32Array(await heightResponse.arrayBuffer());
    const innerHeights = innerBuffer ? new Float32Array(innerBuffer) : null;
    const holes = holesBuffer ? new Uint16Array(holesBuffer) : null;
    const normals = normalsBuffer ? new Float32Array(normalsBuffer) : null;
    if (!Number.isFinite(meta.n) || meta.n < 2 || heights.length < meta.n * meta.n) throw new Error(`Invalid CleanClient terrain bake for ${tileKey}`);

    const group = new THREE.Group();
    group.name = `tile:${tileKey}`;
    group.userData.editorTileKey = tileKey;
    group.position.set((meta.originX ?? TILE_HALF) - TILE_HALF, (meta.originY ?? TILE_HALF) - TILE_HALF, 0);
    const terrain = await this.buildTerrain(base, meta, heights, innerHeights, holes, normals);
    terrain.userData.editorTerrain = true;
    terrain.userData.editorNonSelectable = true;
    terrain.userData.editorTileKey = tileKey;
    group.add(terrain);

    const assets: EditorAsset[] = [];
    if (doodads) await this.addDoodads(base, tileKey, doodads, group, assets, 'terrain');
    if (wmoDoodads) await this.addDoodads(base, tileKey, wmoDoodads, group, assets, 'wmo');
    if (wmos) await this.addWmos(base, tileKey, wmos, group, assets);

    const step = TILE_SIZE / (meta.n - 1);
    const sampleHeightWorld = (worldX: number, worldY: number) => {
      const localX = worldX - group.position.x;
      const localY = worldY - group.position.y;
      const row = (TILE_HALF - localX) / step;
      const col = (TILE_HALF - localY) / step;
      return sampleTerrainHeightGrid(heights, innerHeights, meta.n, row, col);
    };
    return { key: tileKey, mapId, meta, group, terrain, heightGrid: heights, innerHeightGrid: innerHeights, assets, sampleHeightWorld };
  }

  private async buildTerrain(base: string, meta: TileMeta, heights: Float32Array, inner: Float32Array | null, holes: Uint16Array | null, normals: Float32Array | null) {
    const n = meta.n, innerN = n - 1, step = TILE_SIZE / innerN;
    const outerCount = n * n, innerCount = inner?.length === innerN * innerN ? inner.length : 0;
    const positions = new Float32Array((outerCount + innerCount) * 3);
    const uvs = new Float32Array((outerCount + innerCount) * 2);
    for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
      const i = row * n + col;
      positions[i * 3] = TILE_HALF - row * step;
      positions[i * 3 + 1] = TILE_HALF - col * step;
      positions[i * 3 + 2] = heights[i];
      uvs[i * 2] = col / innerN;
      uvs[i * 2 + 1] = 1 - row / innerN;
    }
    if (innerCount) for (let row = 0; row < innerN; row++) for (let col = 0; col < innerN; col++) {
      const i = outerCount + row * innerN + col;
      positions[i * 3] = TILE_HALF - (row + 0.5) * step;
      positions[i * 3 + 1] = TILE_HALF - (col + 0.5) * step;
      positions[i * 3 + 2] = inner![row * innerN + col];
      uvs[i * 2] = (col + 0.5) / innerN;
      uvs[i * 2 + 1] = 1 - (row + 0.5) / innerN;
    }
    const indices: number[] = [];
    const holed = (row: number, col: number) => {
      if (!holes) return false;
      const rr = Math.max(0, Math.min(127, row)), cc = Math.max(0, Math.min(127, col));
      const mask = holes[(rr >> 3) * 16 + (cc >> 3)] ?? 0;
      return !!mask && (mask & (1 << ((((rr & 7) / 2) | 0) * 4 + (((cc & 7) / 2) | 0)))) !== 0;
    };
    for (let row = 0; row < innerN; row++) for (let col = 0; col < innerN; col++) {
      if (holed(row, col)) continue;
      const a = row * n + col, b = (row + 1) * n + col, c = b + 1, d = a + 1;
      if (innerCount) {
        const m = outerCount + row * innerN + col;
        indices.push(a, b, m, b, c, m, c, d, m, d, a, m);
      } else indices.push(a, b, d, b, c, d);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indexAttribute(indices));
    if (normals && normals.length === positions.length) geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    else geometry.computeVertexNormals();

    let material: THREE.Material;
    if (meta.shader?.texCount && meta.shader?.texSize && meta.shader?.layerScale) {
      try {
        material = await createTerrainMaterial({
          texArrayUrl: `${base}/tex_array.png`,
          chunkMapUrl: `${base}/chunk_map.bin`,
          splatUrl: `${base}/splat_atlas.png`,
          shadowUrl: `${base}/shadow_atlas.png`,
          texCount: meta.shader.texCount,
          texSize: meta.shader.texSize,
          layerScale: meta.shader.layerScale,
        }, {
          fogColor: [0.44, 0.52, 0.60], fogNear: 220, fogFar: 1100,
          sunDir: new THREE.Vector3(-0.5, -0.35, -0.8).normalize(),
          sunColor: [0.72, 0.70, 0.62], ambient: [0.46, 0.50, 0.53], groundAmbient: [0.24, 0.22, 0.18],
        });
      } catch (error) {
        console.warn(`[Studio] authentic terrain shader failed for ${base}`, error);
        material = await this.fallbackTerrain(base);
      }
    } else material = await this.fallbackTerrain(base);
    return new THREE.Mesh(geometry, material);
  }

  private async fallbackTerrain(base: string): Promise<THREE.Material> {
    try {
      const texture = await loadOptimizedTexture(`${base}/ground.png`, { flipY: true });
      return new THREE.MeshLambertMaterial({ map: texture, color: 0xffffff });
    } catch {
      return new THREE.MeshLambertMaterial({ color: 0x6a7554 });
    }
  }

  private async addDoodads(base: string, tileKey: string, manifest: DoodadManifest, root: THREE.Group, assets: EditorAsset[], source: string) {
    const meshes = manifest.meshes ?? [], instances = manifest.instances ?? [], textureNames = manifest.textures ?? [];
    const textures = await this.loadTextures(base, textureNames);
    const templates = meshes.map((mesh, meshIndex) => {
      const template = new THREE.Group();
      template.name = String(mesh.source ?? `m2-${meshIndex}`);
      const positions = new THREE.Float32BufferAttribute(mesh.positions ?? [], 3);
      const uvs = mesh.uvs?.length ? new THREE.Float32BufferAttribute(mesh.uvs, 2) : null;
      for (let partIndex = 0; partIndex < (mesh.parts ?? []).length; partIndex++) {
        const part = mesh.parts[partIndex];
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', positions);
        if (uvs) geometry.setAttribute('uv', uvs);
        geometry.setIndex(indexAttribute(part.indices ?? []));
        geometry.computeVertexNormals();
        const textureIndex = Number.isInteger(part.tex) ? Number(part.tex) : -1;
        const map = textureIndex >= 0 ? textures[textureIndex] ?? null : null;
        const blendMode = Number(part.blendMode ?? 0), renderFlags = Number(part.renderFlags ?? 0);
        const material = new THREE.MeshLambertMaterial({
          map, color: 0xffffff,
          side: (renderFlags & 0x04) ? THREE.DoubleSide : THREE.FrontSide,
          transparent: blendMode >= 2,
          depthWrite: blendMode < 2,
          alphaTest: blendMode === 1 ? 25 / 255 : 0,
        });
        material.name = textureNames[textureIndex]?.split(/[\\/]/).pop() ?? `M2 Material ${partIndex}`;
        const partMesh = new THREE.Mesh(geometry, material);
        partMesh.userData.editorMaterial = { meshIndex, partIndex, textureIndex };
        template.add(partMesh);
      }
      const model = String(mesh.source ?? `m2-${meshIndex}`);
      assets.push({ id: `m2:${model}`, kind: 'm2', model, label: model.split(/[\\/]/).pop() ?? model, template, triangles: countTriangles(template), textures: textureNames.filter(Boolean), category: categoryFor(model) });
      return template;
    });
    for (let i = 0; i < instances.length; i++) {
      const instance = instances[i], template = templates[instance.m];
      if (!template) continue;
      const object = template.clone(true);
      object.position.set(Number(instance.x ?? 0), Number(instance.y ?? 0), Number(instance.z ?? 0));
      object.quaternion.set(Number(instance.qx ?? 0), Number(instance.qy ?? 0), Number(instance.qz ?? 0), Number(instance.qw ?? 1));
      object.scale.setScalar(Number(instance.s ?? 1));
      object.userData.editorMeta = { kind: 'm2', model: String(meshes[instance.m]?.source ?? template.name), tileKey, sourceId: instance.id ?? instance.r ?? i, source };
      object.userData.editorSelectable = true;
      root.add(object);
    }
  }

  private async addWmos(base: string, tileKey: string, manifest: WmoManifest, root: THREE.Group, assets: EditorAsset[]) {
    const textureNames = manifest.textures ?? [], textures = await this.loadTextures(base, textureNames), models = manifest.models ?? [];
    const templates = models.map((model, modelIndex) => {
      const template = new THREE.Group();
      template.name = String(model.name ?? `wmo-${modelIndex}`);
      for (let groupIndex = 0; groupIndex < (model.groups ?? []).length; groupIndex++) {
        const sourceGroup = model.groups[groupIndex];
        const positions = new THREE.Float32BufferAttribute(sourceGroup.positions ?? [], 3);
        const normals = sourceGroup.normals?.length ? new THREE.Float32BufferAttribute(sourceGroup.normals, 3) : null;
        const uvs = sourceGroup.uvs?.length ? new THREE.Float32BufferAttribute(sourceGroup.uvs, 2) : null;
        const fullIndex = indexAttribute(sourceGroup.indices ?? []);
        const batches = sourceGroup.batches?.length ? sourceGroup.batches : [{ tex: -1, indexStart: 0, indexCount: fullIndex.count, flags: 0, blendMode: 0 }];
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
          const batch = batches[batchIndex], geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', positions);
          if (normals) geometry.setAttribute('normal', normals); else geometry.computeVertexNormals();
          if (uvs) geometry.setAttribute('uv', uvs);
          geometry.setIndex(fullIndex);
          geometry.setDrawRange(Number(batch.indexStart ?? batch.start ?? 0), Number(batch.indexCount ?? batch.count ?? fullIndex.count));
          const textureIndex = Number.isInteger(batch.tex) ? Number(batch.tex) : -1;
          const map = textureIndex >= 0 ? textures[textureIndex] ?? null : null;
          const blendMode = Number(batch.blendMode ?? 0), flags = Number(batch.flags ?? 0);
          const material = new THREE.MeshLambertMaterial({
            map, color: map ? 0xffffff : 0x9a8e7f,
            side: (flags & 0x04) ? THREE.DoubleSide : THREE.FrontSide,
            transparent: blendMode >= 2,
            depthWrite: blendMode < 2,
            alphaTest: blendMode === 1 ? 25 / 255 : 0,
          });
          material.name = textureNames[textureIndex]?.split(/[\\/]/).pop() ?? `WMO ${groupIndex}:${batchIndex}`;
          const batchMesh = new THREE.Mesh(geometry, material);
          batchMesh.userData.editorMaterial = { groupIndex, batchIndex, textureIndex };
          template.add(batchMesh);
        }
      }
      const modelPath = String(model.name ?? `wmo-${modelIndex}`);
      assets.push({ id: `wmo:${modelPath}`, kind: 'wmo', model: modelPath, label: modelPath.split(/[\\/]/).pop() ?? modelPath, template, triangles: countTriangles(template), textures: textureNames.filter(Boolean), category: categoryFor(modelPath) });
      return template;
    });
    for (let i = 0; i < (manifest.instances ?? []).length; i++) {
      const instance = manifest.instances![i], template = templates[instance.m];
      if (!template) continue;
      const object = template.clone(true);
      object.position.set(Number(instance.x ?? 0), Number(instance.y ?? 0), Number(instance.z ?? 0));
      object.quaternion.set(Number(instance.qx ?? 0), Number(instance.qy ?? 0), Number(instance.qz ?? 0), Number(instance.qw ?? 1));
      object.userData.editorMeta = { kind: 'wmo', model: String(models[instance.m]?.name ?? template.name), tileKey, sourceId: instance.id ?? i };
      object.userData.editorSelectable = true;
      root.add(object);
    }
  }

  private async loadTextures(base: string, names: string[]) {
    return Promise.all(names.map(async (name) => {
      const url = logicalTextureUrl(base, name);
      if (!url) return null;
      try { return await loadOptimizedTexture(url); }
      catch (error) { console.warn(`[Studio] texture unavailable: ${url}`, error); return null; }
    }));
  }
}
