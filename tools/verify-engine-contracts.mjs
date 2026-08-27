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
]);
requireText('apps/editor/src/engine/runtime-game-view.ts', [
  "studioBridge", "studioEmbedded", 'RuntimeGameView',
]);
requireText('apps/editor/src/engine/plugin-host.ts', [
  'registerPlugin', 'commands', 'validators', 'tabs',
]);
requireText('apps/editor/src/engine/profiler.ts', [
  'captureFrame()', 'renderer.info', 'history',
]);
requireText('apps/editor/src/engine/validation.ts', [
  'CREATURE_ENTRY_REQUIRED', 'GAMEOBJECT_ENTRY_REQUIRED', 'DUPLICATE_SOURCE_ID',
]);
requireText('apps/editor/src/engine/wow-tools.ts', [
  'Waypoint Path Tool', 'AreaTrigger', 'CreatureSpawn',
]);
requireText('apps/editor/src/engine/editor-foundation.ts', [
  'SceneComponentModel', 'ProjectWorkspace', 'StudioProfiler', 'RuntimeGameView', 'GlobalAssetBrowser', 'WowWorldTools',
]);
requireText('apps/editor/src/editor-live-bridge.ts', [
  "type: 'object.spawn'", "type: 'object.delete'", "type: 'material.set'", "type: 'project.apply'",
]);

const project = JSON.parse(read('package.json'));
assert.ok(project.scripts?.['index:assets'], 'package.json must expose index:assets');
assert.ok(project.scripts?.['verify:engine'], 'package.json must expose verify:engine');

console.log('[engine-test] Studio architecture contracts verified');
