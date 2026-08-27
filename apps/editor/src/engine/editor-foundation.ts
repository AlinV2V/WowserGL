import './engine-editor.css';
import type { EditorApp } from '../editor-app';
import { ComponentInspectorPanel } from './component-inspector';
import { SceneComponentModel } from './component-model';
import { DebugViewController } from './debug-views';
import { EngineHostRegistry } from './engine-host';
import { EngineToolsPanel } from './engine-tools-panel';
import { GlobalAssetBrowser } from './global-asset-browser';
import { StudioPluginHost } from './plugin-host';
import { PrefabBrowser } from './prefab-browser';
import { StudioProfiler } from './profiler';
import { ProjectWorkspace } from './project-workspace';
import { RuntimeGameView } from './runtime-game-view';
import { ServerAuthoringExporter } from './server-authoring';
import { StudioSimulationClock } from './simulation-clock';
import { StudioValidator } from './validation';
import { WowWorldTools } from './wow-tools';

export type EngineEditorFoundation = {
  components: SceneComponentModel;
  workspace: ProjectWorkspace;
  profiler: StudioProfiler;
  validator: StudioValidator;
  debug: DebugViewController;
  hosts: EngineHostRegistry;
  simulation: StudioSimulationClock;
  plugins: StudioPluginHost;
  componentInspector: ComponentInspectorPanel;
  gameView: RuntimeGameView;
  contentBrowser: GlobalAssetBrowser;
  prefabBrowser: PrefabBrowser;
  wowTools: WowWorldTools;
  serverAuthoring: ServerAuthoringExporter;
  toolsPanel: EngineToolsPanel;
};

const editingText = (target: EventTarget | null) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);

export function installEngineEditorFoundation(app: EditorApp, root: HTMLElement): EngineEditorFoundation {
  const components = new SceneComponentModel(app.store, app.history);
  const workspace = new ProjectWorkspace(app.store, components);
  const profiler = new StudioProfiler(app.renderer, app.scene);
  const validator = new StudioValidator(app.store, components);
  const debug = new DebugViewController(app.scene, app.store);
  const hosts = new EngineHostRegistry(app);
  const simulation = new StudioSimulationClock(app, root);
  const plugins = new StudioPluginHost({ app, components, workspace, profiler, validator, debug });
  const componentInspector = new ComponentInspectorPanel(root, app.store, components, workspace);
  const gameView = new RuntimeGameView(app, root);
  const contentBrowser = new GlobalAssetBrowser(app, root, components);
  const prefabBrowser = new PrefabBrowser(app, workspace, contentBrowser, root);
  const wowTools = new WowWorldTools(app, root, components);
  const serverAuthoring = new ServerAuthoringExporter(app, components, root);
  const toolsPanel = new EngineToolsPanel(app, root, components, workspace, profiler, validator, debug, plugins);
  app.hierarchy.setComponentModel(components, app.history);

  window.addEventListener('keydown', (event) => {
    if (editingText(event.target)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (event.shiftKey) workspace.exportFile();
      else {
        root.querySelector<HTMLButtonElement>('[data-save-project]')?.click();
        workspace.save();
        app.bottomPanel.log({ level: 'info', message: 'Saved scene patch and Studio workspace (Ctrl+S).', time: new Date() });
      }
      return;
    }
    if (event.key === 'Escape') {
      wowTools.togglePathMode(false);
      if (gameView.maximized) gameView.toggleMaximized(false);
    }
  });

  const foundation: EngineEditorFoundation = {
    components,
    workspace,
    profiler,
    validator,
    debug,
    hosts,
    simulation,
    plugins,
    componentInspector,
    gameView,
    contentBrowser,
    prefabBrowser,
    wowTools,
    serverAuthoring,
    toolsPanel,
  };

  const global = globalThis as unknown as { VanillaGLStudio?: Record<string, unknown> };
  Object.assign(global.VanillaGLStudio ??= {}, {
    foundation,
    scene: app.scene,
    renderer: app.renderer,
    bridge: app.bridge,
    store: app.store,
    history: app.history,
    engineHosts: hosts,
    simulation,
    saveWorkspace: () => workspace.save(),
    validate: () => validator.run(),
    captureProfile: () => ({ summary: profiler.summary(), drawables: profiler.captureFrame() }),
  });

  app.bottomPanel.log({
    level: 'info',
    message: 'Engine editor foundation ready: components, project workspace, nested hierarchy, validation, profiler, frame debugger, dependency graph, reusable prefabs, server authoring, WoW tools and authoritative CleanClient Game view.',
    time: new Date(),
  });

  return foundation;
}
