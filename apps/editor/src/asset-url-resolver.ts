export type TextureAsset = {
  variants?: { ktx2?: string; webp?: string; source?: string };
};

type TextureRegistry = { assets?: Record<string, TextureAsset> };
type CatalogShard = { url: string };
type CatalogIndex = { shards?: Record<string, CatalogShard> };

const CATALOG_INDEX_URL = '/data/catalogs/texture-assets/index.json';
const LEGACY_REGISTRY_URL = '/data/texture-assets.json';
let assets: Record<string, TextureAsset> = {};
let shards: Record<string, CatalogShard> = {};
let initPromise: Promise<void> | null = null;
let catalogMode: 'sharded' | 'legacy' | 'unavailable' = 'unavailable';
const loadedScopes = new Set<string>();
const scopePromises = new Map<string, Promise<void>>();

const parseLogicalUrl = (value: string) => {
  if (!value || /^(?:data|blob):/i.test(value)) return null;
  try {
    const parsed = new URL(value, location.href);
    return {
      logicalPath: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
      sameOrigin: parsed.origin === location.origin,
    };
  } catch {
    return null;
  }
};

const scopeForPath = (path: string) => {
  const relative = path.replace(/^\/+/, '');
  return relative.includes('/') ? relative.split('/', 1)[0]!.toLowerCase() : 'root';
};

const loadScope = async (scope: string) => {
  if (catalogMode !== 'sharded' || loadedScopes.has(scope)) return;
  const descriptor = shards[scope];
  if (!descriptor) {
    loadedScopes.add(scope);
    return;
  }
  let pending = scopePromises.get(scope);
  if (!pending) {
    pending = fetch(descriptor.url, { cache: 'force-cache' })
      .then(async (response) => response.ok ? await response.json() as TextureRegistry : { assets: {} })
      .then((registry) => Object.assign(assets, registry.assets ?? {}))
      .finally(() => {
        loadedScopes.add(scope);
        scopePromises.delete(scope);
      });
    scopePromises.set(scope, pending);
  }
  await pending;
};

export const initializeAssetUrlResolver = () => {
  if (!initPromise) {
    initPromise = fetch(CATALOG_INDEX_URL, { cache: 'no-cache' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`texture catalog HTTP ${response.status}`);
        const index = await response.json() as CatalogIndex;
        shards = index.shards ?? {};
        catalogMode = 'sharded';
      })
      .catch(async () => {
        try {
          const response = await fetch(LEGACY_REGISTRY_URL, { cache: 'force-cache' });
          if (!response.ok) throw new Error(`legacy texture registry HTTP ${response.status}`);
          const registry = await response.json() as TextureRegistry;
          assets = registry.assets ?? {};
          catalogMode = 'legacy';
        } catch {
          assets = {};
          catalogMode = 'unavailable';
        }
      });
  }
  return initPromise;
};

export async function ensureTextureAssetScope(value: string) {
  await initializeAssetUrlResolver();
  const parsed = parseLogicalUrl(value);
  if (!parsed?.sameOrigin) return;
  await loadScope(scopeForPath(parsed.logicalPath));
}

const variant = (value: string, type: 'ktx2' | 'webp' | 'source') => {
  const parsed = parseLogicalUrl(value);
  if (!parsed?.sameOrigin) return type === 'source' ? value : null;
  const mapped = assets[parsed.logicalPath]?.variants?.[type];
  return mapped ? `${mapped}${parsed.search}${parsed.hash}` : null;
};

export const resolveGpuAssetUrlSync = (value: string) => variant(value, 'ktx2');

export const resolveTextureFallbackUrlSync = (value: string) => {
  const parsed = parseLogicalUrl(value);
  if (!parsed) return value;
  if (!parsed.sameOrigin) return value;
  const asset = assets[parsed.logicalPath];
  if (!asset) return value;
  return variant(value, 'webp') ?? variant(value, 'source');
};

export const assetUrlResolverDiagnostics = () => ({
  catalogMode,
  registeredAssets: Object.keys(assets).length,
  loadedScopes: [...loadedScopes],
});
