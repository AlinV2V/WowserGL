import type { EditorApp } from '../editor-app';

export type EngineCapability = 'authoring' | 'rendering' | 'collision' | 'animation' | 'materials' | 'streaming' | 'gameplay' | 'server-link';
export type EngineHostState = {
  id: 'studio-scene' | 'cleanclient-runtime';
  label: string;
  authoritative: boolean;
  connected: boolean;
  sceneReady: boolean;
  capabilities: EngineCapability[];
  note: string;
};

export class EngineHostRegistry extends EventTarget {
  readonly hosts = new Map<EngineHostState['id'], EngineHostState>();

  constructor(private readonly app: EditorApp) {
    super();
    this.hosts.set('studio-scene', {
      id: 'studio-scene',
      label: 'Studio Scene Host',
      authoritative: false,
      connected: true,
      sceneReady: true,
      capabilities: ['authoring','rendering','materials','streaming','collision'],
      note: 'Editor-oriented host. Uses CleanClient bake contracts while remaining optimized for authoring and selection.',
    });
    this.hosts.set('cleanclient-runtime', {
      id: 'cleanclient-runtime',
      label: 'CleanClientMMO Runtime',
      authoritative: true,
      connected: app.bridge.runtimes > 0,
      sceneReady: false,
      capabilities: ['rendering','collision','animation','materials','streaming','gameplay','server-link'],
      note: 'Authoritative game rendering/runtime. Embedded in the Game tab and controlled through the Studio bridge.',
    });
    app.bridge.addEventListener('peers', () => {
      const runtime = this.hosts.get('cleanclient-runtime')!;
      runtime.connected = app.bridge.runtimes > 0;
      if (!runtime.connected) runtime.sceneReady = false;
      this.changed();
    });
    app.bridge.addEventListener('runtime-state', (event) => {
      const runtime = this.hosts.get('cleanclient-runtime')!;
      runtime.connected = true;
      runtime.sceneReady = Boolean((event as CustomEvent<{ sceneReady?: boolean }>).detail.sceneReady);
      this.changed();
    });
  }

  get authoritative() { return this.hosts.get('cleanclient-runtime')!; }
  get scene() { return this.hosts.get('studio-scene')!; }
  private changed() { this.dispatchEvent(new CustomEvent('change', { detail: [...this.hosts.values()].map((host) => ({ ...host, capabilities: [...host.capabilities] })) })); }
}
