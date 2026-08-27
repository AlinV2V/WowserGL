import type { EditorObjectKind, EnvironmentState, MaterialOverride, SerializedObject } from './types';

export type LiveTarget = {
  recordId: string;
  tileKey: string;
  kind: EditorObjectKind;
  model: string;
  sourceId?: string | number;
};

export type LiveCommand =
  | { type: 'transform.set'; target: LiveTarget; transform: SerializedObject }
  | { type: 'object.spawn'; target: LiveTarget; transform: SerializedObject }
  | { type: 'object.delete'; target: LiveTarget }
  | { type: 'object.restore'; target: LiveTarget }
  | { type: 'material.set'; target: LiveTarget; override: MaterialOverride }
  | { type: 'environment.set'; environment: EnvironmentState }
  | { type: 'project.apply'; project: LiveProjectPayload }
  | { type: 'playmode.set'; playing: boolean }
  | { type: 'selection.focus'; target: LiveTarget };

export type LiveProjectPayload = {
  mapId: number;
  tileKey: string;
  objects: Array<{ target: LiveTarget; state: 'added' | 'modified' | 'deleted'; transform?: SerializedObject }>;
  materials: MaterialOverride[];
  environment?: EnvironmentState;
};

export type BridgePacket =
  | { type: 'bridge.hello'; role: 'studio' | 'runtime'; id: string; runtimes: number; studios: number; cachedProject?: LiveProjectPayload }
  | { type: 'bridge.peers'; runtimes: number; studios: number }
  | { type: 'bridge.command'; id: string; command: LiveCommand; persist?: boolean }
  | { type: 'bridge.ack'; id: string; commandType: LiveCommand['type']; ok: boolean; message?: string; runtime?: string }
  | { type: 'bridge.log'; level: 'info' | 'warn' | 'error'; message: string; runtime?: string }
  | { type: 'project.save'; id: string; project: LiveProjectPayload }
  | { type: 'project.saved'; id: string; path: string; ok: boolean; message?: string }
  | { type: 'runtime.state'; runtime: string; sceneReady: boolean; mapId?: number; tileKey?: string };

export const makeCommandId = () => globalThis.crypto?.randomUUID?.() ?? `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
