import type { EditorRecord, EnvironmentState, MaterialOverride, SerializedObject } from './types';
import type { BridgePacket, LiveCommand, LiveProjectPayload, LiveTarget, StudioBehaviorPreview, StudioCharacterPreview, StudioLightPreview } from './live-protocol';
import { makeCommandId } from './live-protocol';

export type BridgeStatus = 'offline' | 'connecting' | 'connected' | 'runtime-ready';
export const liveTargetFor = (record: EditorRecord): LiveTarget => ({ recordId: record.id, tileKey: record.tileKey, kind: record.kind, model: record.model, sourceId: record.sourceId });

export class EditorLiveBridge extends EventTarget {
  status: BridgeStatus = 'offline';
  runtimes = 0;
  extensions = 0;
  studios = 0;
  url: string;
  private socket: WebSocket | null = null;
  private reconnectTimer = 0;
  private manuallyClosed = false;
  private pending = new Map<string, { type: LiveCommand['type'] | 'project.save'; sentAt: number }>();

  constructor(url = import.meta.env.VITE_STUDIO_BRIDGE_URL ?? 'ws://127.0.0.1:5191') { super(); this.url = url; }

  connect() {
    this.manuallyClosed = false;
    window.clearTimeout(this.reconnectTimer);
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    this.setStatus('connecting');
    const url = new URL(this.url);
    url.searchParams.set('role', 'studio');
    url.searchParams.set('client', 'WowserGL Studio');
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener('open', () => { this.setStatus('connected'); this.log('info', `Connected to WowserGL live bridge at ${this.url}`); });
    socket.addEventListener('message', (event) => this.onMessage(event.data));
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null;
      this.runtimes = 0;
      this.extensions = 0;
      this.setStatus('offline');
      this.dispatchEvent(new Event('peers'));
      if (!this.manuallyClosed) this.reconnectTimer = window.setTimeout(() => this.connect(), 1600);
    });
    socket.addEventListener('error', () => this.log('warn', 'Live bridge connection failed; retrying.'));
  }

  disconnect() {
    this.manuallyClosed = true;
    window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
    this.setStatus('offline');
  }

  setUrl(url: string) {
    this.url = url.trim() || 'ws://127.0.0.1:5191';
    this.disconnect();
    this.manuallyClosed = false;
    this.connect();
  }

  command(command: LiveCommand, persist = false) {
    const id = makeCommandId();
    const packet: BridgePacket = { type: 'bridge.command', id, command, persist };
    if (!this.send(packet)) return false;
    this.pending.set(id, { type: command.type, sentAt: performance.now() });
    this.dispatchEvent(new CustomEvent('command', { detail: { id, command, persist } }));
    return true;
  }

  pushRecord(record: EditorRecord, serialized: SerializedObject) {
    const target = liveTargetFor(record);
    if (record.state === 'added') return this.command({ type: 'object.spawn', target, transform: serialized });
    if (record.state === 'deleted') return this.command({ type: 'object.delete', target });
    return this.command({ type: 'transform.set', target, transform: serialized });
  }

  restoreRecord(record: EditorRecord) {
    return this.command({ type: 'object.restore', target: liveTargetFor(record) });
  }

  pushMaterial(record: EditorRecord, override: MaterialOverride) {
    const target = liveTargetFor(record);
    const sent = this.command({ type: 'material.set', target, override });
    if (
      override.shaderMode
      || override.doubleSided !== undefined
      || override.depthWrite !== undefined
      || override.uvScale
      || override.uvOffset
      || override.opacity !== undefined
      || override.emissive
    ) {
      this.command({
        type: 'material.advanced',
        target,
        material: {
          locator: override.locator,
          scope: override.scope,
          shaderMode: override.shaderMode,
          opacity: override.opacity,
          emissive: override.emissive,
          doubleSided: override.doubleSided,
          depthWrite: override.depthWrite,
          uvScale: override.uvScale,
          uvOffset: override.uvOffset,
        },
      });
    }
    return sent;
  }

  pushEnvironment(environment: EnvironmentState) {
    return this.command({ type: 'environment.set', environment: { ...environment } });
  }

  pushProject(project: LiveProjectPayload) {
    return this.command({ type: 'project.apply', project }, true);
  }

  saveProject(project: LiveProjectPayload) {
    const id = makeCommandId();
    if (!this.send({ type: 'project.save', id, project })) return false;
    this.pending.set(id, { type: 'project.save', sentAt: performance.now() });
    return true;
  }

  setPlayMode(playing: boolean) {
    return this.command({ type: 'playmode.set', playing });
  }

  focusRuntime(record: EditorRecord) {
    return this.command({ type: 'selection.focus', target: liveTargetFor(record) });
  }

  previewLight(record: EditorRecord, light: StudioLightPreview) {
    return this.command({ type: 'light.preview', target: liveTargetFor(record), light });
  }

  previewBehavior(record: EditorRecord, behavior: StudioBehaviorPreview) {
    return this.command({ type: 'behavior.preview', target: liveTargetFor(record), behavior });
  }

  stopBehavior(record: EditorRecord) {
    return this.command({ type: 'behavior.stop', target: liveTargetFor(record) });
  }

  previewCharacter(record: EditorRecord, character: StudioCharacterPreview) {
    return this.command({ type: 'character.preview', target: liveTargetFor(record), character });
  }

  clearCharacter(record: EditorRecord) {
    return this.command({ type: 'character.clear', target: liveTargetFor(record) });
  }

  openGame(gameUrl = import.meta.env.VITE_VANILLAGL_GAME_URL ?? 'http://localhost:5173/') {
    const url = new URL(gameUrl, location.href);
    // VanillaGL remains separate and unmodified. The external CDP adapter attaches out-of-process.
    url.searchParams.set('debugtools', '');
    window.open(url.toString(), 'vanillagl-game');
  }

  private onMessage(raw: unknown) {
    let packet: BridgePacket;
    try {
      packet = JSON.parse(String(raw)) as BridgePacket;
    } catch {
      return;
    }

    if (packet.type === 'bridge.hello' || packet.type === 'bridge.peers') {
      this.runtimes = packet.runtimes;
      this.extensions = packet.extensions ?? 0;
      this.studios = packet.studios;
      this.setStatus(this.runtimes > 0 ? 'runtime-ready' : 'connected');
      this.dispatchEvent(new CustomEvent('peers', { detail: { runtimes: this.runtimes, extensions: this.extensions, studios: this.studios } }));
      if (packet.type === 'bridge.hello' && packet.cachedProject) {
        this.dispatchEvent(new CustomEvent('cached-project', { detail: packet.cachedProject }));
      }
      return;
    }

    if (packet.type === 'bridge.ack') {
      const pending = this.pending.get(packet.id);
      this.pending.delete(packet.id);
      const elapsed = pending ? Math.round(performance.now() - pending.sentAt) : 0;
      this.log(
        packet.ok ? 'info' : 'error',
        `${packet.commandType} ${packet.ok ? 'applied' : 'failed'}${elapsed ? ` in ${elapsed}ms` : ''}${packet.message ? ` — ${packet.message}` : ''}`,
        packet.runtime,
      );
      this.dispatchEvent(new CustomEvent('ack', { detail: packet }));
      return;
    }

    if (packet.type === 'project.saved') {
      this.pending.delete(packet.id);
      this.log(packet.ok ? 'info' : 'error', packet.ok ? `Project saved to ${packet.path}` : `Project save failed: ${packet.message ?? 'unknown error'}`);
      this.dispatchEvent(new CustomEvent('project-saved', { detail: packet }));
      return;
    }

    if (packet.type === 'bridge.log') {
      this.log(packet.level, packet.message, packet.runtime);
      return;
    }

    if (packet.type === 'runtime.state') {
      this.dispatchEvent(new CustomEvent('runtime-state', { detail: packet }));
    }
  }

  private send(packet: BridgePacket) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.log('warn', 'No WowserGL live bridge connection. Start `npm run bridge` or `npm run dev`.');
      return false;
    }
    this.socket.send(JSON.stringify(packet));
    return true;
  }

  private setStatus(status: BridgeStatus) {
    if (this.status === status) return;
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: status }));
  }

  private log(level: 'info' | 'warn' | 'error', message: string, runtime?: string) {
    this.dispatchEvent(new CustomEvent('log', { detail: { level, message, runtime, time: new Date() } }));
  }
}
