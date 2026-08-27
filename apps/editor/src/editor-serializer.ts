import * as THREE from 'three';
import type { EditorObjectStore } from './editor-store';
import type { CustomMapPatch, EditorRecord, EnvironmentState, SerializedObject } from './types';

const serializeScale = (scale: THREE.Vector3): number | [number, number, number] => {
  if (Math.abs(scale.x - scale.y) < 1e-5 && Math.abs(scale.x - scale.z) < 1e-5) return Number(scale.x.toFixed(6));
  return scale.toArray().map((v) => Number(v.toFixed(6))) as [number, number, number];
};

const serializeObject = (record: EditorRecord): SerializedObject => {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  record.object.updateWorldMatrix(true, false);
  record.object.matrixWorld.decompose(position, quaternion, scale);
  return {
    id: record.sourceId !== undefined ? String(record.sourceId) : record.id,
    model: record.model.replaceAll('\\', '/'),
    position: position.toArray().map((v) => Number(v.toFixed(4))) as [number, number, number],
    rotation: quaternion.toArray().map((v) => Number(v.toFixed(7))) as [number, number, number, number],
    scale: serializeScale(scale),
  };
};

export class EditorSerializer {
  createPatch(store: EditorObjectStore, mapId: number, tileKey: string, environment?: EnvironmentState): CustomMapPatch {
    const records = [...store.records.values()].filter((record) => record.tileKey === tileKey);
    return {
      version: 1,
      mapId,
      tileKey,
      customDoodads: records.filter((r) => r.state === 'added' && r.object.visible && r.kind === 'm2').map(serializeObject),
      customWmos: records.filter((r) => r.state === 'added' && r.object.visible && r.kind === 'wmo').map(serializeObject),
      deletedObjects: records.filter((r) => r.state === 'deleted').map((r) => ({ id: String(r.sourceId ?? r.id), kind: r.kind, model: r.model.replaceAll('\\', '/') })),
      modifiedObjects: records.filter((r) => r.state === 'modified' && r.object.visible).map(serializeObject),
      environment: environment ? { ...environment } : undefined,
    };
  }

  download(store: EditorObjectStore, mapId: number, tileKey: string, environment?: EnvironmentState) {
    const patch = this.createPatch(store, mapId, tileKey, environment);
    const blob = new Blob([JSON.stringify(patch, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'custom_map_patch.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async readFile(file: File): Promise<CustomMapPatch> {
    const parsed = JSON.parse(await file.text()) as CustomMapPatch;
    if (parsed.version !== 1 || !Number.isFinite(parsed.mapId) || typeof parsed.tileKey !== 'string') {
      throw new Error('Unsupported or malformed WowserGL map patch');
    }
    return parsed;
  }
}
