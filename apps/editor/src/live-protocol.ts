import type { EditorObjectKind, EnvironmentState, MaterialLocator, MaterialOverride, SerializedObject } from './types';

export type LiveTarget = { recordId: string; tileKey: string; kind: EditorObjectKind; model: string; sourceId?: string | number };
export type StudioLightPreview = { enabled: boolean; color: string; intensity: number; radius: number };
export type StudioBehaviorWaypoint = { x: number; y: number; z: number; waitMs?: number; speed?: number; orientation?: number; emoteId?: number };
export type StudioBehaviorPreview = { mode: 'idle' | 'wander' | 'waypoints' | 'guard'; speed: number; wanderDistance: number; aggroRadius: number; leashRadius: number; loop: boolean; waypoints: StudioBehaviorWaypoint[] };
export type StudioCharacterEquipment = { displayInfoId: number; inventoryType: number; sheath?: number; slot?: number; classId?: number; subclass?: number; material?: number };
export type StudioCharacterPreview = { race: number; classId: number; gender: number; skin: number; face: number; hairStyle: number; hairColor: number; facialHair: number; level: number; animationId?: number; scale?: number; equipment: StudioCharacterEquipment[] };
export type StudioAdvancedMaterialPreview = { locator: MaterialLocator; scope: 'instance' | 'asset'; shaderMode?: 'vanilla' | 'unlit' | 'emissive'; opacity?: number; emissive?: string; doubleSided?: boolean; depthWrite?: boolean; uvScale?: [number, number]; uvOffset?: [number, number] };

export type LiveCommand =
  | { type: 'transform.set'; target: LiveTarget; transform: SerializedObject }
  | { type: 'object.spawn'; target: LiveTarget; transform: SerializedObject }
  | { type: 'object.delete'; target: LiveTarget }
  | { type: 'object.restore'; target: LiveTarget }
  | { type: 'material.set'; target: LiveTarget; override: MaterialOverride }
  | { type: 'material.advanced'; target: LiveTarget; material: StudioAdvancedMaterialPreview }
  | { type: 'environment.set'; environment: EnvironmentState }
  | { type: 'project.apply'; project: LiveProjectPayload }
  | { type: 'playmode.set'; playing: boolean }
  | { type: 'selection.focus'; target: LiveTarget }
  | { type: 'light.preview'; target: LiveTarget; light: StudioLightPreview }
  | { type: 'behavior.preview'; target: LiveTarget; behavior: StudioBehaviorPreview }
  | { type: 'behavior.stop'; target: LiveTarget }
  | { type: 'character.preview'; target: LiveTarget; character: StudioCharacterPreview }
  | { type: 'character.clear'; target: LiveTarget };

export type LiveProjectPayload = { mapId: number; tileKey: string; objects: Array<{ target: LiveTarget; state: 'added' | 'modified' | 'deleted'; transform?: SerializedObject }>; materials: MaterialOverride[]; environment?: EnvironmentState };
export type BridgePacket =
  | { type: 'bridge.hello'; role: 'studio' | 'runtime' | 'runtime-extension'; id: string; runtimes: number; extensions?: number; studios: number; cachedProject?: LiveProjectPayload }
  | { type: 'bridge.peers'; runtimes: number; extensions?: number; studios: number }
  | { type: 'bridge.command'; id: string; command: LiveCommand; persist?: boolean }
  | { type: 'bridge.ack'; id: string; commandType: LiveCommand['type']; ok: boolean; message?: string; runtime?: string }
  | { type: 'bridge.log'; level: 'info' | 'warn' | 'error'; message: string; runtime?: string }
  | { type: 'project.save'; id: string; project: LiveProjectPayload }
  | { type: 'project.saved'; id: string; path: string; ok: boolean; message?: string }
  | { type: 'runtime.state'; runtime: string; sceneReady: boolean; mapId?: number; tileKey?: string };

export const makeCommandId = () => globalThis.crypto?.randomUUID?.() ?? `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
