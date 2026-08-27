import * as THREE from 'three';
import type { EditorAsset, EditorObjectKind, EditorRecord, TransformSnapshot } from './types';

const newId = () => globalThis.crypto?.randomUUID?.() ?? `editor-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const snapshotTransform = (object: THREE.Object3D): TransformSnapshot => ({
  position: object.position.toArray() as [number, number, number],
  quaternion: object.quaternion.toArray() as [number, number, number, number],
  scale: object.scale.toArray() as [number, number, number],
});

export const applySnapshot = (object: THREE.Object3D, snapshot: TransformSnapshot) => {
  object.position.fromArray(snapshot.position);
  object.quaternion.fromArray(snapshot.quaternion);
  object.scale.fromArray(snapshot.scale);
  object.updateMatrixWorld(true);
};

const objectStats = (root: THREE.Object3D) => {
  let triangles = 0;
  const textures = new Set<string>();
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) {
      const indexCount = mesh.geometry.index?.count ?? 0;
      const positionCount = mesh.geometry.getAttribute('position')?.count ?? 0;
      triangles += Math.floor((indexCount || positionCount) / 3);
    }
    const materials = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    for (const material of materials) {
      const map = (material as THREE.MeshStandardMaterial).map;
      const source = map?.userData?.sourceUrl ?? map?.name;
      if (source) textures.add(String(source));
    }
  });
  return { triangles, textures: [...textures] };
};

export class EditorObjectStore extends EventTarget {
  readonly records = new Map<string, EditorRecord>();
  selected: EditorRecord | null = null;
  tileKey = '';

  constructor(private readonly scene: THREE.Scene) {
    super();
  }

  clear() {
    this.select(null);
    for (const record of this.records.values()) {
      if (record.object.userData.editorProxy || record.state === 'added') this.scene.remove(record.object);
    }
    this.records.clear();
    this.changed();
  }

  recordsForTile(tileKey = this.tileKey) {
    return [...this.records.values()].filter((record) => record.tileKey === tileKey);
  }

  registerExisting(object: THREE.Object3D, data: Partial<EditorRecord> & { kind: EditorObjectKind; model: string; tileKey: string }) {
    const existingId = String(object.userData.editorRecordId ?? '');
    if (existingId && this.records.has(existingId)) return this.records.get(existingId)!;
    const stats = objectStats(object);
    const record: EditorRecord = {
      id: existingId || newId(),
      object,
      kind: data.kind,
      model: data.model,
      tileKey: data.tileKey,
      sourceId: data.sourceId,
      state: 'existing',
      original: snapshotTransform(object),
      triangles: data.triangles ?? stats.triangles,
      textures: data.textures ?? stats.textures,
    };
    object.userData.editorRecordId = record.id;
    object.userData.editorSelectable = true;
    this.records.set(record.id, record);
    return record;
  }

  addFromAsset(asset: EditorAsset, position: THREE.Vector3, tileKey = this.tileKey) {
    const object = asset.template.clone(true);
    object.position.copy(position);
    object.userData.editorAsset = true;
    object.visible = true;
    this.scene.add(object);
    const record: EditorRecord = {
      id: newId(),
      object,
      kind: asset.kind,
      model: asset.model,
      tileKey,
      state: 'added',
      triangles: asset.triangles,
      textures: [...asset.textures],
    };
    object.userData.editorRecordId = record.id;
    object.userData.editorSelectable = true;
    this.records.set(record.id, record);
    this.select(record);
    this.changed(record);
    return record;
  }

  duplicate(record: EditorRecord, position?: THREE.Vector3) {
    const object = record.object.clone(true);
    object.position.copy(position ?? record.object.position.clone().add(new THREE.Vector3(1, 1, 0)));
    object.visible = true;
    this.scene.add(object);
    const copy: EditorRecord = {
      ...record,
      id: newId(),
      object,
      state: 'added',
      original: undefined,
      instanced: undefined,
      sourceId: undefined,
    };
    object.userData.editorRecordId = copy.id;
    object.userData.editorSelectable = true;
    this.records.set(copy.id, copy);
    this.select(copy);
    this.changed(copy);
    return copy;
  }

  remove(record: EditorRecord) {
    if (record.state === 'added') {
      record.object.visible = false;
    } else {
      record.state = 'deleted';
      record.object.visible = false;
    }
    if (record.instanced) this.writeInstancedMatrix(record, true);
    if (this.selected === record) this.select(null);
    this.changed(record);
  }

  restore(record: EditorRecord, previousState: EditorRecord['state'] = 'existing') {
    record.object.visible = true;
    record.state = previousState;
    if (record.instanced) this.writeInstancedMatrix(record, false);
    this.changed(record);
  }

  markModified(record: EditorRecord) {
    if (record.state === 'existing') record.state = 'modified';
    this.syncInstanced(record);
    this.changed(record);
  }

  select(record: EditorRecord | null) {
    this.selected = record;
    this.dispatchEvent(new CustomEvent('selection', { detail: record }));
  }

  resolveHit(hit: THREE.Intersection): EditorRecord | null {
    if (hit.object instanceof THREE.InstancedMesh && hit.instanceId !== undefined && hit.object.userData.wowDoodad) {
      return this.getOrCreateInstanceProxy(hit.object, hit.instanceId);
    }
    let node: THREE.Object3D | null = hit.object;
    while (node) {
      const id = String(node.userData.editorRecordId ?? '');
      if (id && this.records.has(id)) return this.records.get(id)!;
      if (node.userData.wmoPick?.kind === 'wmo') {
        const pick = node.userData.wmoPick;
        return this.registerExisting(node, {
          kind: 'wmo', model: String(pick.model ?? node.name ?? 'WMO'), tileKey: String(pick.tile ?? this.tileKey), sourceId: pick.uniqueId,
        });
      }
      if (node.userData.editorEntity) {
        const meta = node.userData.editorEntity;
        return this.registerExisting(node, {
          kind: meta.kind ?? 'npc', model: meta.model ?? meta.name ?? node.name ?? 'entity', tileKey: meta.tileKey ?? this.tileKey, sourceId: meta.id,
        });
      }
      node = node.parent;
    }
    return null;
  }

  private getOrCreateInstanceProxy(mesh: THREE.InstancedMesh, instanceId: number) {
    const id = `instance:${mesh.uuid}:${instanceId}`;
    const existing = this.records.get(id);
    if (existing) return existing;
    mesh.updateWorldMatrix(true, false);
    const local = new THREE.Matrix4();
    mesh.getMatrixAt(instanceId, local);
    const world = mesh.matrixWorld.clone().multiply(local);
    const proxy = new THREE.Group();
    world.decompose(proxy.position, proxy.quaternion, proxy.scale);
    proxy.userData.editorRecordId = id;
    proxy.userData.editorSelectable = true;
    proxy.userData.editorProxy = true;
    this.scene.add(proxy);
    const doodad = mesh.userData.wowDoodad ?? {};
    const sourceIndices = Array.isArray(doodad.sourceIndices) ? doodad.sourceIndices : [];
    const record: EditorRecord = {
      id,
      object: proxy,
      kind: 'm2',
      model: String(doodad.source ?? mesh.name ?? 'M2'),
      tileKey: String(doodad.tileKey ?? this.tileKey),
      sourceId: sourceIndices[instanceId] ?? instanceId,
      state: 'existing',
      original: snapshotTransform(proxy),
      triangles: objectStats(mesh).triangles,
      textures: objectStats(mesh).textures,
      instanced: { mesh, instanceId, originalMatrix: local.clone() },
    };
    this.records.set(id, record);
    return record;
  }

  private syncInstanced(record: EditorRecord) {
    if (!record.instanced) return;
    const { mesh, instanceId } = record.instanced;
    mesh.updateWorldMatrix(true, false);
    record.object.updateWorldMatrix(true, false);
    const local = mesh.matrixWorld.clone().invert().multiply(record.object.matrixWorld);
    mesh.setMatrixAt(instanceId, local);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }

  private writeInstancedMatrix(record: EditorRecord, hidden: boolean) {
    if (!record.instanced) return;
    const { mesh, instanceId, originalMatrix } = record.instanced;
    if (hidden) {
      const m = originalMatrix.clone();
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      m.decompose(p, q, s);
      s.setScalar(0);
      m.compose(p, q, s);
      mesh.setMatrixAt(instanceId, m);
    } else if (record.state === 'existing' && record.original) {
      mesh.setMatrixAt(instanceId, originalMatrix);
    } else {
      this.syncInstanced(record);
      return;
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  private changed(record?: EditorRecord) {
    this.dispatchEvent(new CustomEvent<EditorRecord | undefined>('change', { detail: record }));
  }
}
