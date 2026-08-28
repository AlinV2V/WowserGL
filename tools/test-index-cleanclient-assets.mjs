import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'));
const fixture = mkdtempSync(join(tmpdir(), 'wowsergl-index-'));
const publicDir = join(fixture, 'public');
const output = join(fixture, 'studio-asset-index.json');
const writeJson = (relative, value) => {
  const target = join(publicDir, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(value));
};

try {
  writeJson('terrain/index.json', [{ key: 'Azeroth_30_49', map: 0, originX: -8900, originY: 600 }]);
  writeJson('terrain/tiles/Azeroth_30_49/doodads.json', {
    textures: ['doodad_tex/tree.webp'],
    meshes: [{ source: 'World/Generic/PassiveDoodads/Trees/TestTree.m2' }],
    instances: [{ m: 0 }, { m: 0 }],
  });
  writeJson('terrain/tiles/Azeroth_30_49/wmos.meta.json', {
    textures: ['wmo_tex/house.webp'],
    models: [{ name: 'World/WMO/TestHouse.wmo', groups: [] }],
    instances: [{ m: 0 }],
  });
  writeJson('creatures/manifest.json', {
    123: { path: '/creatures/123/model.json', textures: ['/creatures/123/body.webp'], modelId: 44, scale: 1.25 },
  });
  writeJson('data/texture-assets.json', {
    assets: {
      '/terrain/tiles/Azeroth_30_49/doodad_tex/tree.webp': { variants: { ktx2: '/textures/tree.ktx2', webp: '/textures/tree.webp', source: '/textures/tree.png' } },
    },
  });
  writeJson('sounds/sound-manifest.json', {
    entries: {
      55: { id: 55, name: 'TestBell', files: ['bells/test-bell.ogg'], volume: 0.75, loop: false },
    },
  });

  const result = spawnSync(process.execPath, [join(root, 'tools', 'index-cleanclient-assets.mjs'), '--force'], {
    cwd: root,
    env: { ...process.env, CLEANCLIENT_PUBLIC_DIR: publicDir, STUDIO_ASSET_INDEX_OUTPUT: output },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `indexer failed:\n${result.stdout}\n${result.stderr}`);
  const index = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(index.version, 1);
  assert.equal(index.source, publicDir);
  assert.ok(index.generatedAt);
  assert.ok(Array.isArray(index.assets));

  const byKind = (kind) => index.assets.filter((asset) => asset.kind === kind);
  assert.equal(byKind('m2').length, 1);
  assert.equal(byKind('wmo').length, 1);
  assert.equal(byKind('creature').length, 1);
  assert.equal(byKind('texture').length, 1);
  assert.equal(byKind('audio').length, 1);

  const tree = byKind('m2')[0];
  assert.equal(tree.occurrences, 2);
  assert.equal(tree.category, 'nature');
  assert.equal(tree.representativeTile, 'Azeroth_30_49');
  assert.equal(tree.mapId, 0);

  const creature = byKind('creature')[0];
  assert.equal(creature.displayId, 123);
  assert.equal(creature.metadata.modelId, 44);
  assert.equal(creature.metadata.scale, 1.25);

  const texture = byKind('texture')[0];
  assert.equal(texture.previewUrl, '/textures/tree.webp');
  assert.equal(texture.metadata.ktx2, '/textures/tree.ktx2');

  const audio = byKind('audio')[0];
  assert.equal(audio.previewUrl, '/sounds/bells/test-bell.ogg');
  assert.equal(audio.metadata.soundId, 55);
  assert.equal(audio.metadata.volume, 0.75);

  console.log(`[engine-test] asset index fixture passed with ${index.assets.length} entries`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
