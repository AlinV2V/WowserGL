import './engine-editor.css';
import type { EditorApp } from '../editor-app';
import { ComponentInspectorPanel } from './component-inspector';
import { SceneComponentModel } from './component-model';
import { DebugViewController } from './debug-views';
import { EngineToolsPanel } from './engine-tools-panel';
import { GlobalAssetBrowser } from './global-asset-browser';
import { StudioPluginHost } from './plugin-host';
import { StudioProfiler } from './profiler';
import { ProjectWorkspace } from './project-workspace';
import { RuntimeGameView } from './runtime-game-view';
import { StudioValidator } from './validation';
import { WowWorldTools } from './wow-tools';

export type EngineEditorFoundation = {
  components: SceneComponentModel;
  workspace: ProjectWorkspace;
  profiler: StudioProfiler;
  validator: StudioValidator;
  debug: DebugViewController;
  plugins: StudioPluginHost;
  componentInspector: ComponentInspectorPanel;
  gameView: RuntimeGameView;
  contentBrowser: GlobalAssetBrowser;
  wowTools: WowWorldTools;
  toolsPanel: EngineToolsPanel;
};

export function installEngineEditorFoundation(app: EditorApp, root: HTMLElement): EngineEditorFoundation {
  const components = new SceneComponentModel(app.store, app.history);
  const workspace = new ProjectWorkspace(app.store, components);
  const profiler = new StudioProfiler(app.renderer, app.scene);
  const validator = new StudioValidator(app.store, components);
  const debug = new DebugViewController(app.scene, app.store);
  const plugins = new StudioPluginHost({ app, components, workspace, profiler, validator, debug });
  const componentInspector = new ComponentInspectorPanel(root, app.store, components);
  const gameView = new RuntimeGameView(app, root);
  const contentBrowser = new GlobalAssetBrowser(app, root, components);
  const wowTools = new WowWorldTools(app, root, components);
  const toolsPanel = new EngineToolsPanel(app, root, components, workspace, profiler, validator, debug, plugins);

  const foundation: EngineEditorFoundation = {
    components,
    workspace,
    profiler,
    validator,
    debug,
    plugins,
    componentInspector,
    gameView,
    contentBrowser,
    wowTools,
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
  });

  app.bottomPanel.log({
    level: 'info',
    message: 'Engine editor foundation ready: components, project workspace, validation, profiler, frame debugger, dependency graph, WoW tools and authoritative Game view.',
    time: new Date(),
  });

  return foundation;
}
