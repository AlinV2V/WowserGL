import { MeshoptDecoder as ImportedMeshoptDecoder } from 'meshoptimizer';

export type MeshoptComponent = 'f32' | 'u32' | 'u16' | 'u8';
export type MeshoptMode = 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES';
export type MeshoptStreamRef = {
  $vgl: 'meshopt';
  offset: number;
  byteLength: number;
  count: number;
  stride: number;
  components: number;
  component: MeshoptComponent;
  mode: MeshoptMode;
  filter?: 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL' | 'COLOR';
  asArray?: boolean;
};
type MeshoptAssetEntry = { meta: string; binary: string };
type MeshoptManifest = { assets?: Record<string, MeshoptAssetEntry> };
type MeshoptDecoderApi = {
  ready: Promise<unknown>;
  useWorkers?: (count: number) => void;
  decodeGltfBufferAsync: (count: number, size: number, source: Uint8Array, mode: MeshoptMode, filter?: MeshoptStreamRef['filter']) => Promise<Uint8Array>;
};

type Sidecar = { meta: unknown; binary: Uint8Array };

const MANIFEST_URL = '/data/meshopt-assets.json';
const decoder = ImportedMeshoptDecoder as unknown as MeshoptDecoderApi;
let assets: Record<string, MeshoptAssetEntry> = {};
let initialized: Promise<void> | null = null;
let baseFetch: typeof fetch | null = null;
let installed = false;
const cache = new Map<string, Promise<Sidecar>>();

const sameOriginPath = (value: string) => {
  if (!value || /^(?:data|blob):/i.test(value)) return null;
  try {
    const url = new URL(value, location.href);
    return url.origin === location.origin ? url.pathname : null;
  } catch {
    return null;
  }
};

const componentWidth = (component: MeshoptComponent) => component === 'u8' ? 1 : component === 'u16' ? 2 : 4;

function unpack(ref: MeshoptStreamRef, decoded: Uint8Array) {
  const width = componentWidth(ref.component);
  const packedStride = ref.components * width;
  const count = ref.count * ref.components;
  let bytes = decoded;
  if (packedStride !== ref.stride) {
    bytes = new Uint8Array(ref.count * packedStride);
    for (let i = 0; i < ref.count; i++) {
      bytes.set(decoded.subarray(i * ref.stride, i * ref.stride + packedStride), i * packedStride);
    }
  } else {
    bytes = decoded.slice();
  }
  let result: Float32Array | Uint32Array | Uint16Array | Uint8Array;
  if (ref.component === 'f32') result = new Float32Array(bytes.buffer, bytes.byteOffset, count);
  else if (ref.component === 'u32') result = new Uint32Array(bytes.buffer, bytes.byteOffset, count);
  else if (ref.component === 'u16') result = new Uint16Array(bytes.buffer, bytes.byteOffset, count);
  else result = new Uint8Array(bytes.buffer, bytes.byteOffset, count);
  return ref.asArray ? Array.from(result) : result;
}

const isStream = (value: unknown): value is MeshoptStreamRef => !!value && typeof value === 'object' && (value as MeshoptStreamRef).$vgl === 'meshopt';

async function hydrate(value: unknown, binary: Uint8Array): Promise<unknown> {
  if (isStream(value)) {
    if (value.offset < 0 || value.byteLength < 0 || value.offset + value.byteLength > binary.byteLength) throw new Error('Meshopt stream outside sidecar');
    const source = binary.subarray(value.offset, value.offset + value.byteLength);
    const decoded = await decoder.decodeGltfBufferAsync(value.count, value.stride, source, value.mode, value.filter);
    return unpack(value, decoded);
  }
  if (Array.isArray(value)) {
    await Promise.all(value.map(async (item, index) => { value[index] = await hydrate(item, binary); }));
    return value;
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    await Promise.all(Object.keys(object).map(async (key) => { object[key] = await hydrate(object[key], binary); }));
  }
  return value;
}

function sidecar(path: string, entry: MeshoptAssetEntry) {
  let pending = cache.get(path);
  if (!pending) {
    const fetcher = baseFetch ?? fetch;
    pending = Promise.all([
      fetcher(entry.meta, { cache: 'force-cache' }),
      fetcher(entry.binary, { cache: 'force-cache' }),
    ]).then(async ([meta, binary]) => {
      if (!meta.ok || !binary.ok) throw new Error(`Meshopt sidecar unavailable for ${path}`);
      return { meta: await meta.json(), binary: new Uint8Array(await binary.arrayBuffer()) };
    });
    cache.set(path, pending);
    pending.catch(() => cache.delete(path));
  }
  return pending;
}

function routedResponse(path: string, entry: MeshoptAssetEntry, probe: Response, sourceRequest: () => Promise<Response>) {
  const decode = async () => {
    const payload = await sidecar(path, entry);
    const meta = typeof structuredClone === 'function' ? structuredClone(payload.meta) : JSON.parse(JSON.stringify(payload.meta));
    return hydrate(meta, payload.binary);
  };
  return new Proxy(probe, {
    get(target, property) {
      if (property === 'json') return async () => {
        try { return await decode(); } catch { return (await sourceRequest()).json(); }
      };
      if (property === 'text') return async () => {
        try { return JSON.stringify(await decode()); } catch { return (await sourceRequest()).text(); }
      };
      if (property === 'clone') return () => routedResponse(path, entry, target.clone(), sourceRequest);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function installRouting() {
  if (installed || !baseFetch) return;
  installed = true;
  const original = baseFetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') return original(input, init);
    const raw = request?.url ?? String(input);
    const path = sameOriginPath(raw);
    const entry = path ? assets[path] : undefined;
    if (!path || !entry) return original(input, init);
    try {
      const probe = await original(entry.meta, { cache: 'force-cache' });
      if (!probe.ok) return original(input, init);
      return routedResponse(path, entry, probe, () => original(input, init));
    } catch {
      return original(input, init);
    }
  }) as typeof fetch;
}

export function initializeMeshoptRuntime() {
  if (!initialized) {
    baseFetch = globalThis.fetch.bind(globalThis);
    initialized = Promise.all([
      decoder.ready,
      baseFetch(MANIFEST_URL, { cache: 'no-cache' })
        .then(async (response) => response.ok ? await response.json() as MeshoptManifest : { assets: {} })
        .catch(() => ({ assets: {} } as MeshoptManifest)),
    ]).then(([, manifest]) => {
      assets = manifest.assets ?? {};
      if (Object.keys(assets).length && decoder.useWorkers) {
        const cores = navigator.hardwareConcurrency || 4;
        decoder.useWorkers(Math.max(1, Math.min(4, Math.floor(cores / 2))));
      }
      installRouting();
    });
  }
  return initialized;
}

export const meshoptRuntimeDiagnostics = () => ({ mappedAssets: Object.keys(assets).length, cachedSidecars: cache.size });
