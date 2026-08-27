import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'));
const OUTPUT = process.env.STUDIO_ASSET_INDEX_OUTPUT ? resolve(process.env.STUDIO_ASSET_INDEX_OUTPUT) : join(ROOT, 'apps', 'editor', 'public', 'studio-asset-index.json');
const force = process.argv.includes('--force');
const optional = process.argv.includes('--if-available');
const candidates = [
  process.env.CLEANCLIENT_PUBLIC_DIR,
  process.env.VANILLAGL_PUBLIC_DIR,
  join(ROOT, '..', 'VanillaGL', 'apps', 'client', 'public'),
  join(ROOT, '..', 'CleanClientMMO', 'apps', 'client', 'public'),
].filter(Boolean).map((value) => resolve(value));
const PUBLIC = candidates.find((value) => existsSync(value));

const categoryFor = (model) => {
  const value = String(model).toLowerCase();
  if (/creature|human|orc|dragon|guard|npc|character/.test(value)) return 'creatures';
  if (/tree|bush|rock|plant|stump|flower|grass|shrub|mushroom|vine|cactus/.test(value)) return 'nature';
  if (/house|castle|bridge|tower|building|wall|gate|tent|inn|abbey|church|farm|keep|hut|stable/.test(value)) return 'structures';
  if (/bench|chair|crate|barrel|campfire|lamp|table|bed|banner|flag|sign|cart|fence|weapon|book|bottle/.test(value)) return 'props';
  return 'other';
};
const normalized = (value) => String(value ?? '').replaceAll('\\', '/');
const safeJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};
const labelFor = (model) => normalized(model).split('/').pop() || String(model);
const publicPath = (url) => join(PUBLIC, String(url ?? '').replace(/^\/+/, '').split(/[?#]/, 1)[0]);

if (!PUBLIC) {
  const message = '[studio-index] CleanClientMMO public directory not found. Set CLEANCLIENT_PUBLIC_DIR or place VanillaGL beside WowserGL.';
  if (optional) { console.log(message); process.exit(0); }
  console.error(message); process.exit(1);
}
if (!force && existsSync(OUTPUT)) {
  const existing = safeJson(OUTPUT);
  if (existing?.version === 1 && existing.generatedAt && Array.isArray(existing.assets) && existing.assets.length) {
    console.log(`[studio-index] using existing ${existing.assets.length} asset entries`);
    process.exit(0);
  }
}

const tileIndexRaw = safeJson(join(PUBLIC, 'terrain', 'index.json'));
const tileEntries = Array.isArray(tileIndexRaw) ? tileIndexRaw : tileIndexRaw?.tiles ?? tileIndexRaw?.entries ?? tileIndexRaw?.index ?? [];
const mapByTile = new Map(tileEntries.map((entry) => [String(entry.key), Number(entry.map ?? 0)]));
const assets = new Map();

const upsert = ({ kind, model, tileKey, mapId, count = 1, textures = [], displayId, category, previewUrl, metadata }) => {
  const clean = normalized(model);
  if (!clean) return;
  const id = kind === 'creature' ? `creature:${displayId}` : `${kind}:${clean.toLowerCase()}`;
  const existing = assets.get(id);
  if (existing) {
    existing.occurrences += count;
    if (!existing.representativeTile && tileKey) existing.representativeTile = tileKey;
    if (existing.mapId === undefined && mapId !== undefined) existing.mapId = mapId;
    if (!existing.previewUrl && previewUrl) existing.previewUrl = normalized(previewUrl);
    if (textures.length) existing.textures = [...new Set([...(existing.textures ?? []), ...textures.map(normalized).filter(Boolean)])].slice(0, 24);
    return;
  }
  assets.set(id, {
    id,
    kind,
    model: clean,
    label: kind === 'creature' ? `${labelFor(clean)} · #${displayId}` : labelFor(clean),
    category: category ?? (kind === 'creature' ? 'creatures' : categoryFor(clean)),
    ...(tileKey ? { representativeTile: tileKey } : {}),
    ...(mapId !== undefined ? { mapId } : {}),
    ...(displayId !== undefined ? { displayId } : {}),
    ...(previewUrl ? { previewUrl: normalized(previewUrl) } : {}),
    ...(metadata ? { metadata } : {}),
    occurrences: count,
    ...(textures.length ? { textures: [...new Set(textures.map(normalized).filter(Boolean))].slice(0, 24) } : {}),
  });
};

const terrainRoot = join(PUBLIC, 'terrain', 'tiles');
let tiles = 0;
if (existsSync(terrainRoot)) {
  for (const entry of readdirSync(terrainRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const tileKey = entry.name;
    const tileDir = join(terrainRoot, tileKey);
    const mapId = mapByTile.get(tileKey) ?? 0;
    const scanDoodads = (file) => {
      const manifest = safeJson(join(tileDir, file));
      if (!manifest?.meshes || !Array.isArray(manifest.meshes)) return;
      const counts = new Map();
      for (const instance of manifest.instances ?? []) counts.set(Number(instance.m), (counts.get(Number(instance.m)) ?? 0) + 1);
      manifest.meshes.forEach((mesh, index) => upsert({ kind: 'm2', model: mesh.source, tileKey, mapId, count: counts.get(index) ?? 1, textures: manifest.textures ?? [] }));
    };
    scanDoodads('doodads.json');
    scanDoodads('wmo_doodads.json');
    const wmos = safeJson(join(tileDir, 'wmos.meta.json')) ?? safeJson(join(tileDir, 'wmos.json'));
    if (wmos?.models && Array.isArray(wmos.models)) {
      const counts = new Map();
      for (const instance of wmos.instances ?? []) counts.set(Number(instance.m), (counts.get(Number(instance.m)) ?? 0) + 1);
      wmos.models.forEach((model, index) => upsert({ kind: 'wmo', model: model.name ?? model.source, tileKey, mapId, count: counts.get(index) ?? 1, textures: wmos.textures ?? model.textures ?? [] }));
    }
    tiles++;
    if (tiles % 100 === 0) console.log(`[studio-index] scanned ${tiles} tiles · ${assets.size} unique assets`);
  }
}

const creatureManifest = safeJson(join(PUBLIC, 'creatures', 'manifest.json'));
if (creatureManifest && typeof creatureManifest === 'object') {
  for (const [id, entry] of Object.entries(creatureManifest)) {
    const displayId = Number(id);
    if (!Number.isFinite(displayId) || !entry?.path) continue;
    upsert({ kind: 'creature', model: entry.path, count: 1, textures: entry.textures ?? [], displayId, metadata: { modelId: entry.modelId ?? null, scale: entry.scale ?? 1 } });
  }
}

const addTextureRegistry = (registry) => {
  for (const [logical, descriptor] of Object.entries(registry?.assets ?? {})) {
    const variants = descriptor?.variants ?? {};
    upsert({
      kind: 'texture',
      model: logical,
      category: 'textures',
      count: 1,
      previewUrl: variants.webp ?? variants.source ?? logical,
      metadata: { ktx2: variants.ktx2 ?? null, webp: variants.webp ?? null, source: variants.source ?? null },
    });
  }
};
const legacyTextures = safeJson(join(PUBLIC, 'data', 'texture-assets.json'));
if (legacyTextures?.assets) addTextureRegistry(legacyTextures);
else {
  const catalog = safeJson(join(PUBLIC, 'data', 'catalogs', 'texture-assets', 'index.json'));
  for (const shard of Object.values(catalog?.shards ?? {})) {
    if (!shard?.url) continue;
    const registry = safeJson(publicPath(shard.url));
    if (registry) addTextureRegistry(registry);
  }
}

const soundManifest = safeJson(join(PUBLIC, 'sounds', 'sound-manifest.json'));
if (soundManifest?.entries && typeof soundManifest.entries === 'object') {
  for (const [id, entry] of Object.entries(soundManifest.entries)) {
    const files = Array.isArray(entry?.files) ? entry.files.map(normalized).filter(Boolean) : [];
    const first = files[0];
    const previewUrl = first ? (/^\//.test(first) ? first : `/sounds/${first.replace(/^sounds\//, '')}`) : undefined;
    const numericId = Number(id);
    upsert({
      kind: 'audio',
      model: String(entry?.name || id),
      category: 'audio',
      count: Math.max(1, files.length),
      previewUrl,
      metadata: { soundId: entry?.id ?? (Number.isFinite(numericId) && numericId !== 0 ? numericId : id), files, loop: entry?.loop === true, volume: entry?.volume ?? 1 },
    });
  }
}

const result = {
  version: 1,
  generatedAt: new Date().toISOString(),
  source: PUBLIC,
  assets: [...assets.values()].sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id)),
};
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(result));
console.log(`[studio-index] wrote ${result.assets.length} assets from ${tiles} tiles to ${OUTPUT}`);
