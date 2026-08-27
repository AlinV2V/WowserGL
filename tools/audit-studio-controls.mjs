import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'));
const read = (path) => readFileSync(join(root, path), 'utf8');
const has = (source, fragment, label = fragment) => assert.ok(source.includes(fragment), `Missing control/backend path: ${label}`);
const lacks = (source, fragment, label = fragment) => assert.ok(!source.includes(fragment), `Stale control/pipeline remains: ${label}`);

const editor = read('apps/editor/src/editor-app.ts');
const shell = read('apps/editor/src/engine/shell-controls.ts');
const foundation = read('apps/editor/src/engine/editor-foundation.ts');
const simulation = read('apps/editor/src/engine/simulation-clock.ts');
const game = read('apps/editor/src/engine/runtime-game-view.ts');
const bridgeClient = read('apps/editor/src/editor-live-bridge.ts');
const bridgeServer = read('apps/bridge/server.mjs');
const protocol = read('apps/editor/src/live-protocol.ts');
const bottom = read('apps/editor/src/editor-bottom-panel.ts');
const inspector = read('apps/editor/src/editor-inspector.ts');
const materials = read('apps/editor/src/editor-materials.ts');
const environment = read('apps/editor/src/editor-environment.ts');
const palette = read('apps/editor/src/editor-palette.ts');
const componentInspector = read('apps/editor/src/engine/component-inspector.ts');
const tools = read('apps/editor/src/engine/engine-tools-panel.ts');
const globalAssets = read('apps/editor/src/engine/global-asset-browser.ts');

// Every menu rendered by EditorApp is owned by the audited shell controller.
const menus = [...editor.matchAll(/data-menu="([^"]+)"/g)].map((match) => match[1]);
assert.deepEqual(menus, ['file', 'edit', 'assets', 'gameobject', 'window', 'help']);
for (const menu of menus) has(shell, `case '${menu}':`, `menu ${menu}`);

// Primary static toolbar / Scene controls.
for (const [label, fragment, source] of [
  ['Open tile', "[data-load]')!.addEventListener('click'", editor],
  ['Move/Rotate/Scale', "querySelectorAll<HTMLButtonElement>('[data-mode]')", editor],
  ['Grid snap', "[data-grid-snap]')!.addEventListener('change'", editor],
  ['Angle snap', "[data-angle-snap]')!.addEventListener('change'", editor],
  ['Top view', "[data-top]')!.addEventListener('click'", editor],
  ['Play runtime mode', "this.bridge.setPlayMode(this.playing)", editor],
  ['Live Sync', "this.liveSyncButton.addEventListener('click'", editor],
  ['Push All', "[data-push-all]')!.addEventListener('click'", editor],
  ['Save Project', "[data-save-project]')!.addEventListener('click'", editor],
  ['Open Game window', "[data-open-game]')!.addEventListener('click'", editor],
  ['Embedded Game tab', "this.gameTab.addEventListener('click'", game],
  ['Scene tab', "this.sceneTab.addEventListener('click'", game],
  ['Gizmos', "[data-gizmos]", shell],
  ['Bridge status button', "[data-bridge-badge]", shell],
  ['Shading mode', "shading.dataset.shellControl = 'shading'", shell],
  ['2D view', "twoD.dataset.shellControl = '2d'", shell],
  ['Audio assets', "audio.dataset.shellControl = 'audio-assets'", shell],
]) has(source, fragment, label);

// Pause and Step must affect actual preview state, not only a dead clock.
has(simulation, "[data-pause]", 'Pause control');
has(simulation, "[data-step]", 'Step control');
has(simulation, 'this.advance(1 / 60, true)', 'single-frame step');
has(foundation, "simulation.addEventListener('tick'", 'simulation consumer');
has(foundation, 'app.environment.update(dt, app.camera.active.position)', 'preview simulation backend');
lacks(editor, 'this.environment.update(dt, this.camera.active.position)', 'duplicate environment update bypassing Pause/Step');
lacks(editor, "[data-game-tab]')!.addEventListener('click', () => this.bridge.openGame())", 'legacy Game-tab popup handler');
lacks(editor, "querySelectorAll<HTMLButtonElement>('[data-menu]')", 'legacy partial menu dispatcher');
lacks(editor, 'Pause live runtime', 'misleading runtime pause label');

// Context menu actions must all have a path; mutation actions are undoable.
for (const control of ['focus', 'duplicate', 'push', 'delete']) has(editor, `once('[data-context-${control}]'`, `context ${control}`);
has(editor, 'this.history.execute({\n        label: `Duplicate', 'undoable context duplicate');
has(editor, 'this.history.execute({\n        label: `Delete', 'undoable context delete');

// Bottom dock.
for (const control of ['data-clear', 'data-collapse', "data-tab=\"console\"", "data-tab=\"changes\"", "data-tab=\"game\""]) has(bottom, control, `bottom ${control}`);
has(bottom, "dispatchEvent(new Event('push-all'))", 'Changes Push All dispatch');
has(bottom, "dispatchEvent(new Event('save-project'))", 'Changes Save dispatch');
has(bottom, "dispatchEvent(new Event('open-game'))", 'Live Game launch dispatch');
has(bottom, "dispatchEvent(new Event('ping-runtime'))", 'Live Game ping dispatch');

// Inspector / materials / environment.
for (const marker of ['data-ground', 'data-reset', 'data-grid', 'data-push-selection', 'data-save-selection', 'data-focus-game']) has(inspector, marker, `Inspector ${marker}`);
for (const marker of ['data-preview', 'data-push']) has(materials, marker, `Material ${marker}`);
for (const marker of ['data-time', 'data-fog-near', 'data-fog-far', 'data-fog-color', 'data-weather']) has(environment, marker, `Environment ${marker}`);
for (const marker of ['data-kind', 'data-category', 'data-search']) has(palette, marker, `Local Assets ${marker}`);
for (const fragment of ["copy.addEventListener('click'", "paste.addEventListener('click'", "reset.addEventListener('click'", "remove.addEventListener('click'", "button.addEventListener('click'"]) has(componentInspector, fragment, `Component Inspector ${fragment}`);

// Engine windows and project workspace controls.
for (const marker of [
  'data-profiler-reset', 'data-profiler-export', 'data-debug-mode', 'data-debug-bounds', 'data-terrain-wire', 'data-frame-export',
  'data-validation-filter', 'data-run-validation', 'data-project-save', 'data-project-save-as', 'data-project-open', 'data-project-export',
  'data-add-bookmark', 'data-create-prefab', 'data-layer-visible', 'data-layer-lock', 'data-remove-bookmark', 'data-remove-prefab', 'data-recent-tile',
]) has(tools, marker, `Engine tools ${marker}`);

// Global Content Browser actions must fail visibly rather than reject silently.
has(globalAssets, 'spawnSafely(', 'safe global asset placement');
has(globalAssets, 'Asset placement failed:', 'global asset placement error reporting');
for (const marker of ['data-global-search', 'data-global-scope', 'data-global-category', 'global-favorite', '▶ Play', '■ Stop', 'Place at Scene Focus']) has(globalAssets, marker, `Content Browser ${marker}`);

// Live buttons must map through protocol -> bridge -> runtime relay/ack path.
const commandTypes = ['transform.set', 'object.spawn', 'object.delete', 'object.restore', 'material.set', 'environment.set', 'project.apply', 'playmode.set', 'selection.focus'];
for (const type of commandTypes) has(protocol, `'${type}'`, `protocol ${type}`);
for (const clientMethod of ['pushRecord(', 'restoreRecord(', 'pushMaterial(', 'pushEnvironment(', 'pushProject(', 'saveProject(', 'setPlayMode(', 'focusRuntime(']) has(bridgeClient, clientMethod, `bridge client ${clientMethod}`);
has(bridgeServer, "client.role === 'studio' && packet.type === 'bridge.command'", 'Studio command relay');
has(bridgeServer, "broadcast('runtime', packet)", 'runtime relay');
has(bridgeServer, "client.role === 'runtime' && (packet.type === 'bridge.ack'", 'runtime ACK return path');
has(bridgeServer, "packet.type === 'project.save'", 'project persistence backend');
has(bridgeServer, "writeFile(projectPath", 'project file write');

// UI placeholders that are intentionally unsupported must not remain visible.
has(shell, "querySelector('[data-lock]')?.remove()", 'Inspector lock placeholder removal');
has(shell, "querySelectorAll('.inspector-panel .component-menu')", 'component menu placeholder removal');
has(foundation, 'new StudioShellControls', 'audited shell controller installation');

console.log(`[engine-test] audited ${menus.length} menus, primary shell controls, editor windows and ${commandTypes.length} live command families`);
