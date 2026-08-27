import type { EditorApp } from '../editor-app';
import { buildDependencyGraph, type GraphNode } from './dependency-graph';
import type { DebugViewController, DebugViewMode } from './debug-views';
import type { SceneComponentModel } from './component-model';
import type { StudioPluginHost } from './plugin-host';
import type { ProjectWorkspace } from './project-workspace';
import type { StudioProfiler } from './profiler';
import type { StudioValidator, ValidationSeverity } from './validation';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
type BuiltinTab = 'profiler' | 'frame' | 'graph' | 'validation' | 'project';

export class EngineToolsPanel {
  private overlay: HTMLElement;
  private body: HTMLElement;
  private tabs: HTMLElement;
  private tab: string = 'profiler';
  private visible = false;
  private validationFilter: ValidationSeverity | 'all' = 'all';

  constructor(
    private readonly app: EditorApp,
    private readonly root: HTMLElement,
    private readonly components: SceneComponentModel,
    private readonly workspace: ProjectWorkspace,
    private readonly profiler: StudioProfiler,
    private readonly validator: StudioValidator,
    private readonly debug: DebugViewController,
    private readonly plugins: StudioPluginHost,
  ) {
    const bottom = root.querySelector<HTMLElement>('[data-bottom]')!;
    this.tabs = bottom.querySelector<HTMLElement>('.bottom-tabs')!;
    this.body = bottom.querySelector<HTMLElement>('[data-bottom-body]')!;
    this.overlay = document.createElement('div');
    this.overlay.className = 'engine-tools-overlay';
    this.overlay.hidden = true;
    bottom.append(this.overlay);
    this.installTabs();
    bottom.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => button.addEventListener('click', () => this.hideCustom()));
    profiler.addEventListener('sample', () => { if (this.visible && this.tab === 'profiler') this.render(); });
    validator.addEventListener('change', () => { this.updateValidationBadge(); if (this.visible && this.tab === 'validation') this.render(); });
    app.store.addEventListener('selection', () => { if (this.visible && (this.tab === 'graph' || this.tab === 'frame' || this.tab === 'project')) this.render(); });
    workspace.addEventListener('change', () => { if (this.visible && this.tab === 'project') this.render(); });
    plugins.addEventListener('tabs', () => this.installPluginTabs());
    plugins.addEventListener('plugin', () => { if (this.visible && this.tab === 'project') this.render(); });
    this.updateValidationBadge();
  }

  private installTabs() {
    const spacer = this.tabs.querySelector('.bottom-spacer')!;
    const definitions: Array<[BuiltinTab, string]> = [['profiler','Profiler'],['frame','Frame Debugger'],['graph','Graph'],['validation','Validation'],['project','Project']];
    for (const [id, label] of definitions) {
      const button = document.createElement('button');
      button.dataset.engineTab = id;
      button.textContent = label;
      if (id === 'validation') button.innerHTML = `Validation <span data-validation-count>0</span>`;
      button.addEventListener('click', () => this.show(id));
      this.tabs.insertBefore(button, spacer);
    }
    this.installPluginTabs();
  }

  private installPluginTabs() {
    this.tabs.querySelectorAll('[data-plugin-tab]').forEach((node) => node.remove());
    const spacer = this.tabs.querySelector('.bottom-spacer')!;
    for (const tab of this.plugins.tabs.values()) {
      const button = document.createElement('button');
      button.dataset.engineTab = tab.id;
      button.dataset.pluginTab = '1';
      button.textContent = tab.label;
      button.addEventListener('click', () => this.show(tab.id));
      this.tabs.insertBefore(button, spacer);
    }
  }

  private show(tab: string) {
    this.tab = tab;
    this.visible = true;
    this.body.hidden = true;
    this.overlay.hidden = false;
    this.tabs.querySelectorAll('button').forEach((button) => button.classList.toggle('active', button.dataset.engineTab === tab));
    this.render();
  }

  private hideCustom() {
    this.visible = false;
    this.overlay.hidden = true;
    this.body.hidden = false;
    this.tabs.querySelectorAll('[data-engine-tab]').forEach((button) => button.classList.remove('active'));
  }

  private render() {
    const plugin = this.plugins.tabs.get(this.tab);
    if (plugin) { this.overlay.replaceChildren(); plugin.render(this.overlay); return; }
    if (this.tab === 'profiler') return this.renderProfiler();
    if (this.tab === 'frame') return this.renderFrame();
    if (this.tab === 'graph') return this.renderGraph();
    if (this.tab === 'validation') return this.renderValidation();
    this.renderProject();
  }

  private renderProfiler() {
    const s = this.profiler.sample;
    const summary = this.profiler.summary();
    const history = this.profiler.history.slice(-120);
    const maxMs = Math.max(16.67, ...history.map((sample) => sample.frameMs));
    const points = history.map((sample, index) => `${(index / Math.max(1, history.length - 1)) * 100},${100 - sample.frameMs / maxMs * 100}`).join(' ');
    const offenders = this.profiler.captureFrame().slice(0, 10);
    this.overlay.innerHTML = `<div class="engine-tool-header"><strong>Renderer Profiler</strong><span>Studio Scene host · ${summary.samples} samples</span><div><button data-profiler-reset>Reset</button><button data-profiler-export>Export Capture</button></div></div><div class="profiler-grid">
      ${this.metric('FPS', s.fps.toFixed(1), s.fps >= 55 ? 'good' : s.fps >= 30 ? 'warn' : 'bad')}
      ${this.metric('Frame', `${s.frameMs.toFixed(2)} ms`, s.frameMs <= 18 ? 'good' : 'warn')}
      ${this.metric('Average', `${summary.averageFrameMs.toFixed(2)} ms`)}
      ${this.metric('P95', `${summary.p95FrameMs.toFixed(2)} ms`, summary.p95FrameMs <= 18 ? 'good' : summary.p95FrameMs <= 33 ? 'warn' : 'bad')}
      ${this.metric('Draw Calls', s.calls.toLocaleString())}
      ${this.metric('Triangles', s.triangles.toLocaleString())}
      ${this.metric('Meshes', `${s.meshes.toLocaleString()} / ${s.instancedMeshes} instanced`)}
      ${this.metric('GPU Objects', `${s.geometries} geo · ${s.textures} tex · ${s.programs} shaders`)}
    </div><div class="profiler-chart"><div class="chart-label">Frame time · last ${history.length} samples · max ${maxMs.toFixed(1)} ms</div><svg viewBox="0 0 100 100" preserveAspectRatio="none"><line x1="0" y1="${100 - 16.67 / maxMs * 100}" x2="100" y2="${100 - 16.67 / maxMs * 100}" class="chart-budget"/><polyline points="${points}"/></svg></div><div class="profiler-offenders"><strong>Heaviest renderables</strong>${offenders.map((row, index) => `<div><span>${index + 1}</span><b title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</b><span>${row.triangles.toLocaleString()} tris</span><span>${row.instances}×</span><span>${row.textures} tex</span></div>`).join('') || '<div class="project-empty">No renderables captured.</div>'}</div><div class="engine-note">The profiler above measures the Studio Scene host. Use the <strong>Game</strong> tab for the authoritative CleanClientMMO renderer/runtime.</div>`;
    this.overlay.querySelector('[data-profiler-reset]')!.addEventListener('click', () => { this.profiler.reset(); this.renderProfiler(); });
    this.overlay.querySelector('[data-profiler-export]')!.addEventListener('click', () => this.profiler.exportCapture());
  }

  private metric(label: string, value: string, tone = '') { return `<div class="profiler-metric ${tone}"><span>${label}</span><strong>${value}</strong></div>`; }

  private renderFrame() {
    const rows = this.profiler.captureFrame().slice(0, 240);
    const materials = this.debug.selectedMaterialSummary();
    this.overlay.innerHTML = `<div class="engine-tool-header"><strong>Frame Debugger</strong><span>${rows.length} captured renderables</span><div class="debug-view-actions">${(['shaded','wireframe','unlit','overdraw'] as DebugViewMode[]).map((mode) => `<button data-debug-mode="${mode}" class="${this.debug.mode === mode ? 'active' : ''}">${mode}</button>`).join('')}<label><input data-debug-bounds type="checkbox" ${this.debug.bounds ? 'checked' : ''}/> Bounds</label><label><input data-terrain-wire type="checkbox" ${this.debug.terrainWire ? 'checked' : ''}/> Terrain Wire</label><button data-frame-export>Export</button></div></div><div class="frame-debug-layout"><div class="frame-table"><div class="frame-row header"><span>Renderable</span><span>Type</span><span>Tris</span><span>Instances</span><span>Material</span><span>Textures</span></div>${rows.map((row) => `<div class="frame-row${row.visible ? '' : ' muted'}"><span title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span><span>${row.type}</span><span>${row.triangles.toLocaleString()}</span><span>${row.instances}</span><span>${escapeHtml(row.material)}</span><span>${row.textures}</span></div>`).join('')}</div><aside class="shader-inspector"><strong>Selected Materials / Shader Inputs</strong>${materials.length ? materials.map((material) => `<div class="shader-card"><b>${escapeHtml(material.name)}</b><small>${material.type}</small><span>${material.uniforms.length ? `Uniforms: ${material.uniforms.map(escapeHtml).join(', ')}` : 'No custom uniforms'}</span><span>${material.textures.length ? `Textures: ${material.textures.map((value) => escapeHtml(value.split(/[\\/]/).pop() || value)).join(', ')}` : 'No textures'}</span></div>`).join('') : '<div class="bottom-empty">Select an M2/WMO to inspect its material graph inputs.</div>'}</aside></div>`;
    this.overlay.querySelectorAll<HTMLButtonElement>('[data-debug-mode]').forEach((button) => button.addEventListener('click', () => { this.debug.setMode(button.dataset.debugMode as DebugViewMode); this.renderFrame(); }));
    this.overlay.querySelector<HTMLInputElement>('[data-debug-bounds]')!.addEventListener('change', (event) => this.debug.setBounds((event.target as HTMLInputElement).checked));
    this.overlay.querySelector<HTMLInputElement>('[data-terrain-wire]')!.addEventListener('change', (event) => this.debug.setTerrainWire((event.target as HTMLInputElement).checked));
    this.overlay.querySelector('[data-frame-export]')!.addEventListener('click', () => this.profiler.exportCapture());
  }

  private renderGraph() {
    const record = this.app.store.selected;
    if (!record) { this.overlay.innerHTML = '<div class="bottom-empty">Select an object to build its dependency/component graph.</div>'; return; }
    const graph = buildDependencyGraph(record, this.components);
    const kinds: GraphNode['kind'][] = ['entity','component','server','geometry','material','texture','tile'];
    const positions = new Map<string, { x: number; y: number }>();
    const columns = kinds.map((kind) => graph.nodes.filter((node) => node.kind === kind)).filter((nodes) => nodes.length);
    columns.forEach((nodes, column) => nodes.forEach((node, row) => positions.set(node.id, { x: 80 + column * 180, y: 45 + row * 72 })));
    const width = Math.max(900, columns.length * 180 + 120);
    const height = Math.max(300, ...[...positions.values()].map((value) => value.y + 60));
    const edges = graph.edges.map((edge) => { const a = positions.get(edge.from), b = positions.get(edge.to); return a && b ? `<line x1="${a.x + 120}" y1="${a.y + 22}" x2="${b.x}" y2="${b.y + 22}"/><text x="${(a.x + b.x + 120) / 2}" y="${(a.y + b.y) / 2 + 14}">${escapeHtml(edge.label ?? '')}</text>` : ''; }).join('');
    const nodes = graph.nodes.map((node) => { const p = positions.get(node.id)!; return `<g class="graph-node ${node.kind}" transform="translate(${p.x} ${p.y})"><rect width="120" height="44" rx="4"/><text x="8" y="17">${escapeHtml(node.label.slice(0, 22))}</text><text class="detail" x="8" y="33">${escapeHtml((node.detail ?? node.kind).slice(0, 26))}</text></g>`; }).join('');
    this.overlay.innerHTML = `<div class="engine-tool-header"><strong>Entity / Asset Dependency Graph</strong><span>${graph.nodes.length} nodes · ${graph.edges.length} links · ${escapeHtml(record.model)}</span></div><div class="dependency-graph"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><g class="graph-edges">${edges}</g>${nodes}</svg></div>`;
  }

  private renderValidation() {
    const counts = this.validator.counts();
    const issues = this.validationFilter === 'all' ? this.validator.issues : this.validator.issues.filter((issue) => issue.severity === this.validationFilter);
    this.overlay.innerHTML = `<div class="engine-tool-header"><strong>Scene Validation</strong><span>${counts.errors} errors · ${counts.warnings} warnings · ${counts.info} info</span><div><select data-validation-filter><option value="all">All</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Info</option></select><button data-run-validation>Run Now</button></div></div><div class="validation-list">${issues.length ? issues.map((issue) => `<button class="validation-row ${issue.severity}" data-validation-record="${issue.recordId ?? ''}"><span>${issue.severity}</span><b>${issue.code}</b><span>${escapeHtml(issue.message)}</span></button>`).join('') : '<div class="validation-clean">✓ No validation issues for this filter.</div>'}</div>`;
    const filter = this.overlay.querySelector<HTMLSelectElement>('[data-validation-filter]')!;
    filter.value = this.validationFilter;
    filter.addEventListener('change', () => { this.validationFilter = filter.value as typeof this.validationFilter; this.renderValidation(); });
    this.overlay.querySelector('[data-run-validation]')!.addEventListener('click', () => { this.validator.run(); this.renderValidation(); });
    this.overlay.querySelectorAll<HTMLElement>('[data-validation-record]').forEach((row) => row.addEventListener('click', () => { const record = this.app.store.records.get(row.dataset.validationRecord ?? ''); if (record) { this.app.store.select(record); this.app.camera.focus(record.object); } }));
  }

  private renderProject() {
    const selected = this.app.store.selected;
    const currentPrefab = selected ? this.workspace.prefabForRecord(selected) : null;
    const overridden = selected ? this.workspace.isPrefabOverridden(selected) : false;
    this.overlay.innerHTML = `<div class="engine-tool-header"><strong>Project Workspace</strong><span>${escapeHtml(this.workspace.name)} · v2 · Ctrl+S</span><div><button data-project-save class="accent">Save</button><button data-project-save-as>Save As</button><button data-project-open>Open Workspace</button><button data-project-export>Export Workspace</button>${this.workspace.recoveryAvailable ? '<button data-project-recover>Recover Autosave</button>' : ''}</div></div><input data-project-file type="file" accept=".json,.wowsergl.json,application/json" hidden/><div class="project-engine-grid"><section><h3>Layers</h3>${this.workspace.layers.map((layer) => `<div class="project-layer"><span>${escapeHtml(layer.name)}</span><label><input type="checkbox" data-layer-visible="${escapeHtml(layer.id)}" ${layer.visible ? 'checked' : ''}/> visible</label><label><input type="checkbox" data-layer-lock="${escapeHtml(layer.id)}" ${layer.locked ? 'checked' : ''}/> locked</label></div>`).join('')}</section><section><h3>Scene Bookmarks</h3><div class="project-actions"><button data-add-bookmark>Add Camera Bookmark</button></div>${this.workspace.bookmarks.map((bookmark) => `<div class="project-list-row static"><button class="project-row-main" data-bookmark="${bookmark.id}">${escapeHtml(bookmark.name)}</button><button data-remove-bookmark="${bookmark.id}">×</button></div>`).join('') || '<div class="project-empty">No bookmarks yet.</div>'}</section><section><h3>Prefabs</h3><div class="project-actions"><button data-create-prefab ${selected ? '' : 'disabled'}>Create Prefab From Selection</button>${currentPrefab ? `<span class="prefab-inline-state ${overridden ? 'overridden' : ''}">${escapeHtml(currentPrefab.name)} · ${overridden ? 'overridden' : 'synced'}</span>` : ''}</div>${this.workspace.prefabs.map((prefab) => `<div class="project-list-row static"><span>${escapeHtml(prefab.name)}</span><small>${escapeHtml(prefab.model)}</small><button data-remove-prefab="${prefab.id}">×</button></div>`).join('') || '<div class="project-empty">No prefabs yet.</div>'}</section><section><h3>Recent Locations</h3>${this.workspace.recentProjects.map((recent) => `<button class="project-list-row" data-recent-tile="${escapeHtml(recent.tileKey)}" data-recent-map="${recent.mapId}"><span>${escapeHtml(recent.name)}</span><small>${escapeHtml(recent.tileKey)} · map ${recent.mapId}</small></button>`).join('') || '<div class="project-empty">No saved workspaces yet.</div>'}</section><section><h3>Plugins & Extension API</h3><div class="engine-note">Browser plugins can call <code>VanillaGLStudio.registerPlugin(...)</code> to register commands, validators and tool tabs without modifying the editor core.</div>${[...this.plugins.plugins.values()].map(({ plugin }) => `<div class="project-list-row static"><span>${escapeHtml(plugin.name)}</span><small>${escapeHtml(plugin.version ?? plugin.id)}</small></div>`).join('') || '<div class="project-empty">No external plugins loaded.</div>'}</section></div>`;
    this.overlay.querySelector('[data-project-save]')!.addEventListener('click', () => { this.root.querySelector<HTMLButtonElement>('[data-save-project]')?.click(); this.workspace.save(); });
    this.overlay.querySelector('[data-project-save-as]')!.addEventListener('click', () => {
      const next = window.prompt('Workspace name', this.workspace.name);
      if (next === null) return;
      this.workspace.saveAs(next);
      this.workspace.exportFile();
      this.renderProject();
    });
    const file = this.overlay.querySelector<HTMLInputElement>('[data-project-file]')!;
    this.overlay.querySelector('[data-project-open]')!.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const selectedFile = file.files?.[0];
      if (!selectedFile) return;
      try {
        const project = await this.workspace.importFile(selectedFile);
        if (project.tileKey && project.tileKey !== this.app.store.tileKey) await this.app.loadTile(project.tileKey, project.mapId);
        this.app.bottomPanel.log({ level: 'info', message: `Opened workspace ${project.name}.`, time: new Date() });
      } catch (error) {
        this.app.bottomPanel.log({ level: 'error', message: `Workspace import failed: ${error instanceof Error ? error.message : String(error)}`, time: new Date() });
      } finally { file.value = ''; this.renderProject(); }
    });
    this.overlay.querySelector('[data-project-export]')!.addEventListener('click', () => this.workspace.exportFile());
    this.overlay.querySelector('[data-project-recover]')?.addEventListener('click', () => { this.workspace.restoreRecoveryMetadata(); this.renderProject(); });
    this.overlay.querySelector('[data-add-bookmark]')!.addEventListener('click', () => { this.workspace.addBookmark(this.app.camera); this.renderProject(); });
    this.overlay.querySelector('[data-create-prefab]')!.addEventListener('click', () => { if (this.app.store.selected) this.workspace.createPrefab(this.app.store.selected); this.renderProject(); });
    this.overlay.querySelectorAll<HTMLInputElement>('[data-layer-visible]').forEach((input) => input.addEventListener('change', () => this.workspace.setLayer(input.dataset.layerVisible!, { visible: input.checked })));
    this.overlay.querySelectorAll<HTMLInputElement>('[data-layer-lock]').forEach((input) => input.addEventListener('change', () => this.workspace.setLayer(input.dataset.layerLock!, { locked: input.checked })));
    this.overlay.querySelectorAll<HTMLElement>('[data-bookmark]').forEach((button) => button.addEventListener('click', () => { const bookmark = this.workspace.bookmarks.find((item) => item.id === button.dataset.bookmark); if (bookmark) this.workspace.applyBookmark(this.app.camera, bookmark); }));
    this.overlay.querySelectorAll<HTMLElement>('[data-remove-bookmark]').forEach((button) => button.addEventListener('click', () => { this.workspace.removeBookmark(button.dataset.removeBookmark!); this.renderProject(); }));
    this.overlay.querySelectorAll<HTMLElement>('[data-remove-prefab]').forEach((button) => button.addEventListener('click', () => { this.workspace.removePrefab(button.dataset.removePrefab!); this.renderProject(); }));
    this.overlay.querySelectorAll<HTMLElement>('[data-recent-tile]').forEach((button) => button.addEventListener('click', () => void this.app.loadTile(button.dataset.recentTile!, Number(button.dataset.recentMap ?? 0))));
  }

  private updateValidationBadge() {
    const counts = this.validator.counts();
    const badge = this.tabs.querySelector<HTMLElement>('[data-validation-count]');
    if (badge) badge.textContent = String(counts.errors + counts.warnings);
  }
}
