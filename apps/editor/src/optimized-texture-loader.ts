import * as THREE from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import {
  ensureTextureAssetScope,
  initializeAssetUrlResolver,
  resolveGpuAssetUrlSync,
  resolveTextureFallbackUrlSync,
} from './asset-url-resolver';

let ktx2: KTX2Loader | null = null;
let initialized: Promise<void> | null = null;
const fallback = new THREE.TextureLoader();

const loadTexture = (loader: THREE.TextureLoader, url: string) => loader.loadAsync(url);

/**
 * Studio uses the same logical texture catalog as CleanClientMMO. A tiny temporary renderer is
 * sufficient for KTX2 capability detection because Studio runs on the same browser/GPU as its
 * real viewport. The renderer is disposed immediately after feature probing.
 */
export function initializeOptimizedTextureLoader(): Promise<void> {
  if (!initialized) {
    initialized = initializeAssetUrlResolver().then(async () => {
      const loader = new KTX2Loader();
      loader.setTranscoderPath('/basis/');
      loader.setWorkerLimit(Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2))));
      try {
        const probe = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
        loader.detectSupport(probe);
        probe.dispose();
        ktx2 = loader;
      } catch (error) {
        console.warn('[Studio] KTX2 capability probe failed; using browser image fallbacks.', error);
        loader.dispose();
        ktx2 = null;
      }
    });
  }
  return initialized;
}

export async function loadOptimizedTexture(logicalUrl: string, options: { repeat?: boolean; flipY?: boolean } = {}) {
  await initializeOptimizedTextureLoader();
  await ensureTextureAssetScope(logicalUrl);

  let texture: THREE.Texture | null = null;
  const compressedUrl = ktx2 ? resolveGpuAssetUrlSync(logicalUrl) : null;
  if (ktx2 && compressedUrl) {
    try {
      texture = await ktx2.loadAsync(compressedUrl);
      texture.generateMipmaps = false;
      texture.userData.optimizedSource = compressedUrl;
    } catch (error) {
      console.warn(`[Studio] KTX2 failed for ${logicalUrl}; falling back to browser image.`, error);
    }
  }

  if (!texture) {
    const fallbackUrl = resolveTextureFallbackUrlSync(logicalUrl);
    if (!fallbackUrl) throw new Error(`No browser-decodable texture variant for ${logicalUrl}`);
    texture = await loadTexture(fallback, fallbackUrl);
    texture.userData.optimizedSource = fallbackUrl;
  }

  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = options.flipY ?? false;
  if (options.repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = Math.max(texture.anisotropy, 8);
  texture.userData.sourceUrl = logicalUrl;
  texture.needsUpdate = true;
  return texture;
}

export function disposeOptimizedTextureLoader() {
  ktx2?.dispose();
  ktx2 = null;
  initialized = null;
}
