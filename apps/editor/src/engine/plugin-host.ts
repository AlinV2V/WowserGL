import type { EditorApp } from '../editor-app';
import type { SceneComponentModel } from './component-model';
import type { DebugViewController } from './debug-views';
import type { ProjectWorkspace } from './project-workspace';
import type { StudioProfiler } from './profiler';
import type { StudioValidator, StudioValidatorFn } from './validation';

export type StudioCommand = { id: string; label: string; description?: string; execute: () => void | Promise<void> };
export type StudioToolTab = { id: string; label: string; render: (host: HTMLElement) => void };
export type StudioPluginContext = {
  app: EditorApp;
  components: SceneComponentModel;
  workspace: ProjectWorkspace;
  profiler: StudioProfiler;
  validator: StudioValidator;
  debug: DebugViewController;
  registerCommand: (command: StudioCommand) => void;
  registerToolTab: (tab: StudioToolTab) => void;
  registerValidator: (validator: StudioValidatorFn) => void;
};
export type StudioPlugin = { id: string; name: string; version?: string; activate: (context: StudioPluginContext) => void | (() => void) };

export class StudioPluginHost extends EventTarget {
  readonly plugins = new Map<string, { plugin: StudioPlugin; dispose?: () => void }>();
  readonly commands = new Map<string, StudioCommand>();
  readonly tabs = new Map<string, StudioToolTab>();

  constructor(private readonly context: Omit<StudioPluginContext, 'registerCommand' | 'registerToolTab' | 'registerValidator'>) {
    super();
    this.installGlobalApi();
  }

  activate(plugin: StudioPlugin) {
    if (!plugin?.id || this.plugins.has(plugin.id)) return false;
    const api: StudioPluginContext = {
      ...this.context,
      registerCommand: (command) => this.registerCommand(plugin.id, command),
      registerToolTab: (tab) => this.registerToolTab(plugin.id, tab),
      registerValidator: (validator) => this.context.validator.register(validator),
    };
    const cleanup = plugin.activate(api);
    this.plugins.set(plugin.id, { plugin, dispose: typeof cleanup === 'function' ? cleanup : undefined });
    this.dispatchEvent(new CustomEvent('plugin', { detail: plugin }));
    return true;
  }

  deactivate(id: string) {
    const active = this.plugins.get(id);
    if (!active) return;
    active.dispose?.();
    this.plugins.delete(id);
    for (const [key] of this.commands) if (key.startsWith(`${id}:`)) this.commands.delete(key);
    for (const [key] of this.tabs) if (key.startsWith(`${id}:`)) this.tabs.delete(key);
    this.dispatchEvent(new Event('plugin'));
  }

  execute(id: string) {
    return this.commands.get(id)?.execute();
  }

  private registerCommand(pluginId: string, command: StudioCommand) {
    this.commands.set(`${pluginId}:${command.id}`, { ...command, id: `${pluginId}:${command.id}` });
    this.dispatchEvent(new Event('commands'));
  }

  private registerToolTab(pluginId: string, tab: StudioToolTab) {
    this.tabs.set(`${pluginId}:${tab.id}`, { ...tab, id: `${pluginId}:${tab.id}` });
    this.dispatchEvent(new Event('tabs'));
  }

  private installGlobalApi() {
    const global = globalThis as unknown as { VanillaGLStudio?: Record<string, unknown>; __wowserglPendingPlugins?: StudioPlugin[] };
    global.VanillaGLStudio = {
      version: '0.3-engine',
      registerPlugin: (plugin: StudioPlugin) => this.activate(plugin),
      deactivatePlugin: (id: string) => this.deactivate(id),
      executeCommand: (id: string) => this.execute(id),
      app: this.context.app,
      components: this.context.components,
      workspace: this.context.workspace,
      profiler: this.context.profiler,
      validator: this.context.validator,
      debug: this.context.debug,
    };
    for (const plugin of global.__wowserglPendingPlugins ?? []) this.activate(plugin);
    global.__wowserglPendingPlugins = [];
  }
}
