import * as THREE from 'three';
import { TILE_HALF, TILE_SIZE, type EditorAsset, type LoadedEditorTile, type TileMeta } from './types';
import { loadWmoBinary } from './wmo-binary';

type DoodadManifest = {
  textures?: string[];
  meshes?: Array<any>;
  instances?: Array<any>;
};

type WmoManifest = {
  textures?: string[];
  models?: Array<any>;
  instances?: Array<any>;
};

const optionalJson = async <T>(url: string): Promise<T | null> => {
  try {
    const response = await fetch(url);
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
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

export class VanillaGLAssetSource {
  constructor(private readonly assetBase = '') {}

  async loadTile(tileKey: string, mapId = 0): Promise<LoadedEditorTile> {
    const base = `${this.assetBase}/terrain/tiles/${tileKey}`;
    const wmoPromise = (async () => (await loadWmoBinary(base)) ?? await optionalJson<WmoManifest>(`${base}/wmos.json`))();
    const [metaResponse, heightResponse, doodads, wmoDoodads, wmos] = await Promise.all([
      fetch(`${base}/meta.json`),
      fetch(`${base}/heights.f32`),
      optionalJson<DoodadManifest>(`${base}/doodads.json`),
      optionalJson<DoodadManifest>(`${base}/wmo_doodads.json`),
      wmoPromise,
    ]);
    if (!metaResponse.ok) throw new Error(`meta.json HTTP ${metaResponse.status}`);
    if (!heightResponse.ok) throw new Error(`heights.f32 HTTP ${heightResponse.status}`);
    const meta = await metaResponse.json() as TileMeta;
    const heights = new Float32Array(await heightResponse.arrayBuffer());
    if (!Number.isFinite(meta.n) || meta.n < 2 || heights.length < meta.n * meta.n) {
      throw new Error(`Invalid VanillaGL terrain bake for ${tileKey}`);
    }

    const group = new THREE.Group();
    group.name = `tile:${tileKey}`;
    group.position.set((meta.originX ?? TILE_HALF) - TILE_HALF, (meta.originY ?? TILE_HALF) - TILE_HALF, 0);
    const terrain = await this.buildTerrain(base, meta, heights);
    terrain.userData.editorTerrain = true;
    terrain.userData.editorNonSelectable = true;
    group.add(terrain);

    const assets: EditorAsset[] = [];
    if (doodads) await this.addDoodads(base, tileKey, doodads, group, assets, 'terrain');
    if (wmoDoodads) await this.addDoodads(base, tileKey, wmoDoodads, group, assets, 'wmo');
    if (wmos) await this.addWmos(base, tileKey, wmos, group, assets);

    const step = TILE_SIZE / (meta.n - 1);
    const sampleHeightWorld = (worldX: number, worldY: number) => {
      const localX = worldX - group.position.x;
      const localY = worldY - group.position.y;
      const rowF = THREE.MathUtils.clamp((TILE_HALF - localX) / step, 0, meta.n - 1);
      const colF = THREE.MathUtils.clamp((TILE_HALF - localY) / step, 0, meta.n - 1);
      const r0 = Math.min(meta.n - 2, Math.floor(rowF));
      const c0 = Math.min(meta.n - 2, Math.floor(colF));
      const tx = rowF - r0;
      const ty = colF - c0;
      const a = heights[r0 * meta.n + c0];
      const b = heights[(r0 + 1) * meta.n + c0];
      const c = heights[r0 * meta.n + c0 + 1];
      const d = heights[(r0 + 1) * meta.n + c0 + 1];
      return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
    };

    return { key: tileKey, mapId, meta, group, terrain, heightGrid: heights, assets, sampleHeightWorld };
  }

  private async buildTerrain(base: string, meta: TileMeta, heights: Float32Array) {
    const n = meta.n;
    const step = TILE_SIZE / (n - 1);
    const positions = new Float32Array(n * n * 3);
    const uvs = new Float32Array(n * n * 2);
    let p = 0, u = 0;
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        positions[p++] = TILE_HALF - row * step;
        positions[p++] = TILE_HALF - col * step;
        positions[p++] = heights[row * n + col];
        uvs[u++] = row / (n - 1);
        uvs[u++] = col / (n - 1);
      }
    }
    const indices: number[] = [];
    for (let row = 0; row < n - 1; row++) {
      for (let col = 0; col < n - 1; col++) {
        const a = row * n + col;
        const b = (row + 1) * n + col;
        const c = row * n + col + 1;
        const d = (row + 1) * n + col + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indexAttribute(indices));
    geometry.computeVertexNormals();
    let material: THREE.Material = new THREE.MeshLambertMaterial({ color: 0x6a7554 });
    try {
      const texture = await new THREE.TextureLoader().loadAsync(`${base}/ground.png`);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.userData.sourceUrl = `${base}/ground.png`;
      material = new THREE.MeshLambertMaterial({ map: texture, color: 0xffffff });
    } catch {
      // Shader-only bakes remain editable with the neutral terrain fallback.
    }
    const terrain = new THREE.Mesh(geometry, material);
    terrain.receiveShadow = false;
    return terrain;
  }

  private async addDoodads(base: string, tileKey: string, manifest: DoodadManifest, root: THREE.Group, assets: EditorAsset[], source: string) {
    const meshes = manifest.meshes ?? [];
    const instances = manifest.instances ?? [];
    const textures = await this.loadTextures(base, manifest.textures ?? []);
    const templates = meshes.map((mesh, meshIndex) => {
      const template = new THREE.Group();
      template.name = String(mesh.source ?? `m2-${meshIndex}`);
      const positions = new THREE.Float32BufferAttribute(mesh.positions ?? [], 3);
      const uvs = mesh.uvs?.length ? new THREE.Float32BufferAttribute(mesh.uvs, 2) : null;
      for (const part of mesh.parts ?? []) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', positions);
        if (uvs) geometry.setAttribute('uv', uvs);
        geometry.setIndex(indexAttribute(part.indices ?? []));
        geometry.computeVertexNormals();
        const map = Number.isInteger(part.tex) ? textures[part.tex] ?? null : null;
        const blendMode = Number(part.blendMode ?? 1);
        const material = new THREE.MeshLambertMaterial({
          map,
          color: 0xffffff,
          side: (Number(part.renderFlags ?? 0) & 0x04) ? THREE.DoubleSide : THREE.FrontSide,
          transparent: blendMode >= 2,
          depthWrite: blendMode < 2,
          alphaTest: blendMode === 1 ? 25 / 255 : 0,
        });
        template.add(new THREE.Mesh(geometry, material));
      }
      const model = String(mesh.source ?? `m2-${meshIndex}`);
      assets.push({
        id: `m2:${model}`,
        kind: 'm2',
        model,
        label: model.split(/[\\/]/).pop() ?? model,
        template,
        triangles: countTriangles(template),
        textures: (manifest.textures ?? []).filter(Boolean),
      });
      return template;
    });
    for (let i = 0; i < instances.length; i++) {
      const instance = instances[i];
      const template = templates[instance.m];
      if (!template) continue;
      const object = template.clone(true);
      object.position.set(Number(instance.x ?? 0), Number(instance.y ?? 0), Number(instance.z ?? 0));
      object.quaternion.set(Number(instance.qx ?? 0), Number(instance.qy ?? 0), Number(instance.qz ?? 0), Number(instance.qw ?? 1));
      object.scale.setScalar(Number(instance.s ?? 1));
      object.userData.editorMeta = {
        kind: 'm2', model: String(meshes[instance.m]?.source ?? template.name), tileKey, sourceId: instance.id ?? i, source,
      };
      object.userData.editorSelectable = true;
      root.add(object);
    }
  }

  private async addWmos(base: string, tileKey: string, manifest: WmoManifest, root: THREE.Group, assets: EditorAsset[]) {
    const textures = await this.loadTextures(base, manifest.textures ?? []);
    const models = manifest.models ?? [];
    const templates = models.map((model, modelIndex) => {
      const template = new THREE.Group();
      template.name = String(model.name ?? `wmo-${modelIndex}`);
      for (const group of model.groups ?? []) {
        const positions = new THREE.Float32BufferAttribute(group.positions ?? [], 3);
        const normals = group.normals?.length ? new THREE.Float32BufferAttribute(group.normals, 3) : null;
        const uvs = group.uvs?.length ? new THREE.Float32BufferAttribute(group.uvs, 2) : null;
        const indices = indexAttribute(group.indices ?? []);
        const batches = group.batches?.length ? group.batches : [{ tex: -1, indexStart: 0, indexCount: indices.count, flags: 0, blendMode: 0 }];
        for (const batch of batches) {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', positions);
          if (normals) geometry.setAttribute('normal', normals);
          if (uvs) geometry.setAttribute('uv', uvs);
          geometry.setIndex(indices);
          if (!normals) geometry.computeVertexNormals();
          const start = Number(batch.indexStart ?? batch.start ?? 0);
          const count = Number(batch.indexCount ?? batch.count ?? indices.count);
          geometry.setDrawRange(start, count);
          const map = Number.isInteger(batch.tex) ? textures[batch.tex] ?? null : null;
          const blendMode = Number(batch.blendMode ?? 0);
          const material = new THREE.MeshLambertMaterial({
            map,
            color: map ? 0xffffff : 0x9a8e7f,
            side: (Number(batch.flags ?? 0) & 0x04) ? THREE.DoubleSide : THREE.FrontSide,
            transparent: blendMode >= 2,
            depthWrite: blendMode < 2,
          });
          template.add(new THREE.Mesh(geometry, material));
        }
      }
      const modelPath = String(model.name ?? `wmo-${modelIndex}`);
      assets.push({
        id: `wmo:${modelPath}`,
        kind: 'wmo',
        model: modelPath,
        label: modelPath.split(/[\\/]/).pop() ?? modelPath,
        template,
        triangles: countTriangles(template),
        textures: (manifest.textures ?? []).filter(Boolean),
      });
      return template;
    });
    for (let i = 0; i < (manifest.instances ?? []).length; i++) {
      const instance = manifest.instances![i];
      const template = templates[instance.m];
      if (!template) continue;
      const object = template.clone(true);
      object.position.set(Number(instance.x ?? 0), Number(instance.y ?? 0), Number(instance.z ?? 0));
      object.quaternion.set(Number(instance.qx ?? 0), Number(instance.qy ?? 0), Number(instance.qz ?? 0), Number(instance.qw ?? 1));
      object.userData.editorMeta = {
        kind: 'wmo', model: String(models[instance.m]?.name ?? template.name), tileKey, sourceId: instance.id ?? i,
      };
      object.userData.editorSelectable = true;
      root.add(object);
    }
  }

  private async loadTextures(base: string, names: string[]) {
    const loader = new THREE.TextureLoader();
    return Promise.all(names.map(async (name) => {
      try {
        const texture = await loader.loadAsync(`${base}/${name}`);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.userData.sourceUrl = `${base}/${name}`;
        return texture;
      } catch {
        return null;
      }
    }));
  }
}
