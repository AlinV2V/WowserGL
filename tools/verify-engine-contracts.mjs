import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'));
const read = (path) => readFileSync(join(root, path), 'utf8');
const requireText = (file, fragments) => {
  const source = read(file);
  for (const fragment of fragments) assert.ok(source.includes(fragment), `${file} is missing required engine contract: ${fragment}`);
};

requireText('apps/editor/src/engine/component-model.ts', [
  "'CreatureSpawn'", "'GameObjectSpawn'", "'AreaTrigger'", "'Path'", "'Portal'", "'PrefabInstance'",
  'serializeEntity(', 'hydrateEntity(', 'setComponentValue(',
]);
requireText('apps/editor/src/engine/project-workspace.ts', [
  "version: 2", "format: 'wowsergl-studio-project'", 'bindings:', 'prefabs:', 'recoveryAvailable',
  'applyInstanceToPrefab(', 'revertPrefabInstance(', 'unpackPrefab(', 'importFile(',
]);
requireText('apps/editor/src/engine/runtime-game-view.ts', [
  'studioBridge', 'studioEmbedded', 'RuntimeGameView', 'toggleMaximized(', 'reload()',
]);
requireText('apps/editor/src/engine/plugin-host.ts', [
  'registerPlugin', 'commands', 'registerValidator', 'registerToolTab',
]);
requireText('apps/editor/src/engine/profiler.ts', [
  'captureFrame()', 'renderer.info', 'history', 'summary()', 'exportCapture()',
]);
requireText('apps/editor/src/engine/validation.ts', [
  'CREATURE_ENTRY_REQUIRED', 'GAMEOBJECT_ENTRY_REQUIRED', 'DUPLICATE_SOURCE_ID', 'PARENT_CYCLE', 'PATH_INVALID_POINT',
]);
requireText('apps/editor/src/engine/wow-tools.ts', [
  'Waypoint Path Tool', 'AreaTrigger', 'CreatureSpawn', 'studioWaypointIndex',
]);
requireText('apps/editor/src/engine/global-asset-browser.ts', [
  'application/x-wowsergl-global-asset', 'FAVORITES_KEY', 'RECENTS_KEY', "entry.kind === 'texture'", "entry.kind === 'audio'",
]);
requireText('apps/editor/src/editor-hierarchy.ts', [
  'setComponentModel(', 'application/x-wowsergl-hierarchy', 'wouldCycle(', 'parentId',
]);
requireText('apps/editor/src/engine/editor-foundation.ts', [
  'SceneComponentModel', 'ProjectWorkspace', 'StudioProfiler', 'RuntimeGameView', 'GlobalAssetBrowser', 'WowWorldTools',
  'setComponentModel(', 'editorDuplicatedFrom', 'captureProfile',
]);
requireText('apps/editor/src/editor-live-bridge.ts', [
  "type: 'object.spawn'", "type: 'object.delete'", "type: 'material.set'", "type: 'project.apply'",
]);
requireText('apps/editor/src/engine/server-authoring.ts', [
  'creature_movement', 'CreatureSpawn', 'GameObjectSpawn',
]);

const project = JSON.parse(read('package.json'));
assert.ok(project.scripts?.['index:assets'], 'package.json must expose index:assets');
assert.ok(project.scripts?.['verify:engine'], 'package.json must expose verify:engine');
assert.ok(project.scripts?.['test:asset-index'], 'package.json must expose deterministic asset-index testing');

console.log('[engine-test] Studio architecture contracts verified');
