import * as THREE from 'three';

export type StudioTerrainLight = {
  fogColor: [number, number, number];
  fogNear: number;
  fogFar: number;
  sunDir: THREE.Vector3;
  sunColor: [number, number, number];
  ambient: [number, number, number];
  groundAmbient: [number, number, number];
};

export type StudioTerrainAssets = {
  texArrayUrl: string;
  chunkMapUrl: string;
  splatUrl: string;
  shadowUrl: string;
  texCount: number;
  texSize: number;
  layerScale: number;
};

const VERT = /* glsl */ `
out vec2 vUv;
out vec3 vAmbient;
out vec3 vSun;
out float vFog;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uGroundAmbient;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 worldNormal = normalize(mat3(modelMatrix) * normal);
  float ndl = clamp(dot(worldNormal, normalize(-uSunDir)), 0.0, 1.0);
  float up = worldNormal.z * 0.5 + 0.5;
  vAmbient = mix(uGroundAmbient, uAmbient, up);
  vSun = uSunColor * ndl;
  vec4 viewPos = viewMatrix * wp;
  float fogDepth = max(0.0, -viewPos.z);
  vFog = clamp((fogDepth - uFogNear) / max(1.0, uFogFar - uFogNear), 0.0, 1.0);
  gl_Position = projectionMatrix * viewPos;
}`;

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
in vec3 vAmbient;
in vec3 vSun;
in float vFog;
out vec4 outColor;
uniform sampler2DArray uTexArray;
uniform sampler2D uChunkMap;
uniform sampler2D uSplat;
uniform sampler2D uShadow;
uniform float uLayerScale;
uniform float uMipBias;
uniform float uDetail;
uniform float uShadowStrength;
uniform vec3 uFogColor;

bool sampleLayer(float idx, vec2 uv, out vec3 rgb) {
  if (idx > 250.0) { rgb = vec3(0.0); return false; }
  rgb = texture(uTexArray, vec3(uv, idx), uMipBias).rgb;
  return true;
}

void main() {
  vec2 mapUv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 tileUv = clamp(mapUv, vec2(0.0), vec2(1.0 - 1.0 / 65536.0));
  vec2 chunk = floor(tileUv * 16.0);
  vec2 chunkUv = (chunk + 0.5) / 16.0;
  vec4 cm = floor(texture(uChunkMap, chunkUv) * 255.0 + 0.5);
  vec3 a = texture(uSplat, tileUv).rgb * uDetail;
  vec2 tuv = vUv * uLayerScale;
  vec3 col, layer;
  if (!sampleLayer(cm.r, tuv, col)) col = vec3(0.42, 0.45, 0.30);
  if (sampleLayer(cm.g, tuv, layer)) col = mix(col, layer, a.r);
  if (sampleLayer(cm.b, tuv, layer)) col = mix(col, layer, a.g);
  if (sampleLayer(cm.a, tuv, layer)) col = mix(col, layer, a.b);
  float shadowFactor = 1.0 - uShadowStrength * (1.0 - texture(uShadow, tileUv).r);
  vec3 lit = col * shadowFactor * clamp(vAmbient + vSun, 0.0, 1.0);
  lit = mix(lit, uFogColor, vFog);
  outColor = vec4(lit, 1.0);
}`;

async function loadPixels(url: string) {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image load failed: ${url}`));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable for terrain texture hydration');
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, image.width, image.height);
  return { data: new Uint8Array(pixels.data.buffer.slice(0)), width: image.width, height: image.height };
}

export async function createTerrainMaterial(assets: StudioTerrainAssets, light: StudioTerrainLight) {
  const [arrayPixels, chunkResponse, splatPixels, shadowPixels] = await Promise.all([
    loadPixels(assets.texArrayUrl),
    fetch(assets.chunkMapUrl),
    loadPixels(assets.splatUrl),
    loadPixels(assets.shadowUrl),
  ]);
  if (!chunkResponse.ok) throw new Error(`chunk map HTTP ${chunkResponse.status}`);
  const expectedHeight = assets.texSize * assets.texCount;
  if (arrayPixels.width !== assets.texSize || arrayPixels.height !== expectedHeight) {
    throw new Error(`terrain texture array dimensions ${arrayPixels.width}x${arrayPixels.height} do not match ${assets.texSize}x${expectedHeight}`);
  }

  const texArray = new THREE.DataArrayTexture(arrayPixels.data, assets.texSize, assets.texSize, assets.texCount);
  texArray.format = THREE.RGBAFormat;
  texArray.type = THREE.UnsignedByteType;
  texArray.wrapS = texArray.wrapT = THREE.RepeatWrapping;
  texArray.magFilter = THREE.LinearFilter;
  texArray.minFilter = THREE.LinearMipmapLinearFilter;
  texArray.generateMipmaps = true;
  texArray.anisotropy = 16;
  texArray.needsUpdate = true;

  const chunkBytes = new Uint8Array(await chunkResponse.arrayBuffer());
  const chunkSide = Math.round(Math.sqrt(chunkBytes.length / 4));
  const chunkMap = new THREE.DataTexture(chunkBytes, chunkSide, chunkSide, THREE.RGBAFormat);
  chunkMap.magFilter = chunkMap.minFilter = THREE.NearestFilter;
  chunkMap.generateMipmaps = false;
  chunkMap.needsUpdate = true;

  const splat = new THREE.DataTexture(splatPixels.data, splatPixels.width, splatPixels.height, THREE.RGBAFormat);
  splat.magFilter = splat.minFilter = THREE.LinearFilter;
  splat.generateMipmaps = false;
  splat.needsUpdate = true;

  const shadow = new THREE.DataTexture(shadowPixels.data, shadowPixels.width, shadowPixels.height, THREE.RGBAFormat);
  shadow.magFilter = shadow.minFilter = THREE.LinearFilter;
  shadow.generateMipmaps = false;
  shadow.needsUpdate = true;

  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTexArray: { value: texArray },
      uChunkMap: { value: chunkMap },
      uSplat: { value: splat },
      uShadow: { value: shadow },
      uLayerScale: { value: assets.layerScale },
      uMipBias: { value: 0 },
      uDetail: { value: 1 },
      uShadowStrength: { value: 0.3 },
      uFogColor: { value: new THREE.Color(...light.fogColor) },
      uFogNear: { value: light.fogNear },
      uFogFar: { value: light.fogFar },
      uSunDir: { value: light.sunDir.clone().normalize() },
      uSunColor: { value: new THREE.Color(...light.sunColor) },
      uAmbient: { value: new THREE.Color(...light.ambient) },
      uGroundAmbient: { value: new THREE.Color(...light.groundAmbient) },
    },
  });
}

export function updateTerrainMaterialLight(material: THREE.ShaderMaterial, light: StudioTerrainLight) {
  material.uniforms.uFogColor.value.setRGB(...light.fogColor);
  material.uniforms.uFogNear.value = light.fogNear;
  material.uniforms.uFogFar.value = light.fogFar;
  material.uniforms.uSunDir.value.copy(light.sunDir).normalize();
  material.uniforms.uSunColor.value.setRGB(...light.sunColor);
  material.uniforms.uAmbient.value.setRGB(...light.ambient);
  material.uniforms.uGroundAmbient.value.setRGB(...light.groundAmbient);
}
