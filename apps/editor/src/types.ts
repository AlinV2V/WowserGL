import type * as THREE from 'three';

export const TILE_SIZE = 533.33333;
export const TILE_HALF = TILE_SIZE / 2;

export type EditorObjectKind = 'm2' | 'wmo' | 'npc' | 'gameobject' | 'unknown';
export type EditorRecordState = 'existing' | 'added' | 'modified' | 'deleted';

export type TransformSnapshot = {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
};

export type EditorAssetCategory = 'nature' | 'structures' | 'props' | 'creatures' | 'other';

export type EditorAsset = {
  id: string;
  kind: 'm2' | 'wmo';
  model: string;
  label: string;
  template: THREE.Object3D;
  triangles: number;
  textures: string[];
  category?: EditorAssetCategory;
};

export type InstancedBinding = {
  mesh: THREE.InstancedMesh;
  instanceId: number;
  originalMatrix: THREE.Matrix4;
};

export type EditorRecord = {
  id: string;
  kind: EditorObjectKind;
  model: string;
  object: THREE.Object3D;
  tileKey: string;
  sourceId?: string | number;
  state: EditorRecordState;
  original?: TransformSnapshot;
  triangles: number;
  textures: string[];
  instanced?: InstancedBinding;
};

export type TileMeta = {
  n: number;
  dir?: string;
  originX?: number;
  originY?: number;
  minHeight?: number;
  maxHeight?: number;
  shader?: {
    texCount?: number;
    texSize?: number;
    layerScale?: number;
    compressedMipFormat?: 'dxt1' | 'dxt3' | null;
    mipLevels?: number;
    surfaceResolution?: number;
  };
};

export type TileIndexEntry = {
  key: string;
  map: number;
  dir: string;
  originX: number;
  originY: number;
  minHeight?: number;
  maxHeight?: number;
  source?: string;
  streamRadius?: number;
};

export type LoadedEditorTile = {
  key: string;
  mapId: number;
  meta: TileMeta;
  group: THREE.Group;
  terrain: THREE.Mesh;
  heightGrid: Float32Array;
  innerHeightGrid?: Float32Array | null;
  assets: EditorAsset[];
  sampleHeightWorld: (x: number, y: number) => number;
};

export type EnvironmentState = {
  hour: number;
  fogNear: number;
  fogFar: number;
  fogColor: string;
  weather: 'clear' | 'rain' | 'snow';
};

export type SerializedObject = {
  id?: string;
  model: string;
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: number | [number, number, number];
};

export type MaterialLocator = {
  slot: number;
  materialIndex?: number;
  groupIndex?: number;
  batchIndex?: number;
  meshIndex?: number;
  partIndex?: number;
  textureIndex?: number;
};

export type MaterialOverride = {
  id: string;
  recordId: string;
  tileKey: string;
  kind: EditorObjectKind;
  model: string;
  sourceId?: string | number;
  locator: MaterialLocator;
  scope: 'instance' | 'asset';
  color?: string;
  textureUrl?: string;
  opacity?: number;
  emissive?: string;
};

export type CustomMapPatch = {
  version: 1;
  mapId: number;
  tileKey: string;
  customDoodads: SerializedObject[];
  customWmos: SerializedObject[];
  deletedObjects: Array<{ id: string; kind: EditorObjectKind; model: string }>;
  modifiedObjects: SerializedObject[];
  materialOverrides?: MaterialOverride[];
  environment?: EnvironmentState;
  studio?: {
    savedAt: string;
    format: 'vanillagl-studio-live-v1';
  };
};
