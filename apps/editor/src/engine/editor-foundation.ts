import './engine-editor.css';
import './engine-editor-polish.css';
import './shell-controls.css';
import type { EditorApp } from '../editor-app';
import type { EditorRecord } from '../types';
import { ComponentInspectorPanel } from './component-inspector';
import { SceneComponentModel } from './component-model';
import { CustomWorldAuthoring } from './custom-content-authoring';
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
import { StudioShellControls } from './shell-controls';
import { StudioSimulationClock } from './simulation-clock';
import { TerrainAuthoring } from './terrain-authoring';
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
  terrain: TerrainAuthoring;
  customWorld: CustomWorldAuthoring;
  componentInspector: ComponentInspectorPanel;
  gameView: RuntimeGameView;
  contentBrowser: GlobalAssetBrowser;
  prefabBrowser: PrefabBrowser;
  wowTools: WowWorldTools;
  serverAuthoring: ServerAuthoringExporter;
  toolsPanel: EngineToolsPanel;
  shellControls: StudioShellControls;
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
  simulation.addEventListener('tick', (event) => {
    const { dt, elapsed } = (event as CustomEvent<{ dt: number; elapsed: number }>).detail;
    app.environment.update(dt, app.camera.active.position);
    components.updateSimulation(dt, elapsed);
  });
  const plugins = new StudioPluginHost({ app, components, workspace, profiler, validator, debug });
  const terrain = new TerrainAuthoring(app, plugins);
  const customWorld = new CustomWorldAuthoring(app, components, workspace, simulation, terrain, plugins);
  const componentInspector = new ComponentInspectorPanel(root, app.store, components, workspace);
  const gameView = new RuntimeGameView(app, root);
  const contentBrowser = new GlobalAssetBrowser(app, root, components);
  const prefabBrowser = new PrefabBrowser(app, workspace, contentBrowser, root);
  const wowTools = new WowWorldTools(app, root, components);
  const serverAuthoring = new ServerAuthoringExporter(app, components, root);
  const toolsPanel = new EngineToolsPanel(app, root, components, workspace, profiler, validator, debug, plugins);
  const shellControls = new StudioShellControls(app, root, debug);
  app.hierarchy.setComponentModel(components, app.history);

  app.store.addEventListener('change', (event) => {
    const record = (event as CustomEvent<EditorRecord | undefined>).detail;
    const sourceId = String(record?.object.userData.editorDuplicatedFrom ?? '');
    if (!record || !sourceId) return;
    delete record.object.userData.editorDuplicatedFrom;
    const source = components.entities.get(sourceId);
    if (!source) return;
    const snapshot = components.serializeEntity(source);
    components.hydrateEntity(record, snapshot);
    if (snapshot.parentId) {
      const parent = app.store.records.get(snapshot.parentId);
      if (parent) parent.object.attach(record.object);
    }
    app.bottomPanel.log({ level: 'info', message: `Duplicated ${snapshot.name} with its components${workspace.prefabForRecord(record) ? ' and prefab link' : ''}.`, time: new Date() });
  });

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
      terrain.setMode('off');
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
    terrain,
    customWorld,
    componentInspector,
    gameView,
    contentBrowser,
    prefabBrowser,
    wowTools,
    serverAuthoring,
    toolsPanel,
    shellControls,
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
    terrain,
    customWorld,
    saveWorkspace: () => workspace.save(),
    exportCustomContent: () => customWorld.exportPackage(),
    validate: () => validator.run(),
    captureProfile: () => ({ summary: profiler.summary(), drawables: profiler.captureFrame() }),
  });

  app.bottomPanel.log({
    level: 'info',
    message: 'Engine editor foundation ready: components, project workspace, custom world authoring, terrain sculpting, nested hierarchy, audited shell controls, functional preview pause/step, validation, profiler, frame debugger, dependency graph, reusable prefabs, server authoring, WoW tools and authoritative CleanClient Game view.',
    time: new Date(),
  });

  return foundation;
}
