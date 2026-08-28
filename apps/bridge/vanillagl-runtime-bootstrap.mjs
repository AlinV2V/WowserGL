/**
 * Runtime compatibility layer injected into a running VanillaGL development page through CDP.
 * This file lives in WowserGL. VanillaGL remains unmodified/read-only.
 *
 * The function must stay closure-free because the external adapter serializes it with toString()
 * and evaluates it inside the VanillaGL execution context.
 */
export function installVanillaGLCompatibilityRuntime() {
  const VERSION = 1;
  const g = globalThis;
  if (g.__wowserglExternalRuntime?.version === VERSION) return g.__wowserglExternalRuntime.state();

  const standalone = new Map();
  const hiddenMatrices = new Map();
  const hiddenVisibility = new Map();
  const lights = new Map();
  const behaviors = new Map();
  const characters = new Map();
  const tileMetaCache = new Map();
  let threePromise = null;
  let environmentOverride = null;
  let pendingProject = null;
  let projectRetryTimer = 0;
  let environmentTimer = 0;
  let frame = 0;
  let lastTime = performance.now();

  const normalize = (value) => String(value ?? '').replaceAll('\\', '/').toLowerCase();
  const sameId = (left, right) => left !== undefined && right !== undefined && String(left) === String(right);
  const keyFor = (target) => `${target.tileKey}|${target.kind}|${normalize(target.model)}|${target.sourceId ?? target.recordId}`;
  const scene = () => g.__wowScene ?? null;
  const camera = () => g.__wowCamera ?? null;
  const controls = () => g.__wowControls ?? null;
  const notHydrated = (message) => Object.assign(new Error(message), { name: 'NotHydratedError', notHydrated: true });
  const isNotHydrated = (error) => !!error?.notHydrated || error?.name === 'NotHydratedError';

  async function THREE() {
    if (!threePromise) {
      threePromise = import('/@id/three').catch(() => import('/node_modules/.vite/deps/three.js'));
    }
    return await threePromise;
  }

  function requireScene() {
    const value = scene();
    if (!value) throw notHydrated('VanillaGL QA scene is not ready. Use the Vite development server so existing QA globals are available.');
    return value;
  }

  function isStudioObject(object) {
    for (let node = object; node; node = node.parent) if (node.userData?.wowserglExternalTarget) return true;
    return false;
  }

  function topSceneChild(object) {
    const rootScene = scene();
    if (!rootScene) return null;
    let node = object;
    while (node.parent && node.parent !== rootScene) node = node.parent;
    return node.parent === rootScene ? node : null;
  }

  function wmoRoots(target, assetScope = false) {
    const rootScene = scene();
    const matches = [];
    if (!rootScene) return matches;
    rootScene.traverse((object) => {
      if (isStudioObject(object)) return;
      const meta = object.userData?.wmoPick;
      if (meta?.kind !== 'wmo') return;
      if (String(meta.tile ?? '') !== target.tileKey || normalize(meta.model) !== normalize(target.model)) return;
      if (!assetScope && target.sourceId !== undefined && !sameId(meta.uniqueId, target.sourceId)) return;
      matches.push(object);
    });
    return matches;
  }

  function sourceIndex(value) {
    if (!value || typeof value !== 'object') return value;
    return value.sourceIndex ?? value.index ?? value.id ?? value;
  }

  function doodadBindings(target, assetScope = false) {
    const rootScene = scene();
    const matches = [];
    if (!rootScene) return matches;
    rootScene.traverse((object) => {
      if (isStudioObject(object)) return;
      const meta = object.userData?.wowDoodad;
      if (!object.isInstancedMesh || !meta) return;
      if (String(meta.tileKey ?? '') !== target.tileKey || normalize(meta.source) !== normalize(target.model)) return;
      if (assetScope) {
        for (let instanceId = 0; instanceId < object.count; instanceId++) matches.push({ mesh: object, instanceId });
        return;
      }
      if (target.sourceId === undefined) return;
      const indices = Array.isArray(meta.sourceIndices) ? meta.sourceIndices : [];
      for (let instanceId = 0; instanceId < Math.min(indices.length, object.count); instanceId++) {
        if (sameId(sourceIndex(indices[instanceId]), target.sourceId)) matches.push({ mesh: object, instanceId });
      }
    });
    return matches;
  }

  function tileRoot(tileKey) {
    const rootScene = scene();
    if (!rootScene) return null;
    let found = null;
    rootScene.traverse((object) => {
      if (found || isStudioObject(object)) return;
      const wmo = object.userData?.wmoPick;
      const doodad = object.userData?.wowDoodad;
      if (String(wmo?.tile ?? doodad?.tileKey ?? '') === tileKey) found = topSceneChild(object);
    });
    return found;
  }

  async function tileMeta(tileKey) {
    let request = tileMetaCache.get(tileKey);
    if (!request) {
      request = fetch(`/terrain/tiles/${encodeURIComponent(tileKey)}/meta.json`)
        .then(async (response) => {
          if (!response.ok) throw new Error(`tile meta HTTP ${response.status}`);
          return await response.json();
        });
      tileMetaCache.set(tileKey, request);
    }
    return await request;
  }

  async function renderOrigin(tileKey) {
    const T = await THREE();
    const root = tileRoot(tileKey);
    if (!root) throw notHydrated(`tile ${tileKey} is not hydrated`);
    const meta = await tileMeta(tileKey);
    const half = 533.33333 / 2;
    return new T.Vector2(Number(meta.originX ?? half) - half - root.position.x, Number(meta.originY ?? half) - half - root.position.y);
  }

  async function renderMatrix(tileKey, transform) {
    const T = await THREE();
    const origin = await renderOrigin(tileKey);
    const scale = typeof transform.scale === 'number'
      ? new T.Vector3(transform.scale, transform.scale, transform.scale)
      : new T.Vector3().fromArray(transform.scale);
    return new T.Matrix4().compose(
      new T.Vector3(transform.position[0] - origin.x, transform.position[1] - origin.y, transform.position[2]),
      new T.Quaternion().fromArray(transform.rotation),
      scale,
    );
  }

  async function applyObjectTransform(object, tileKey, transform) {
    const desired = await renderMatrix(tileKey, transform);
    if (object.parent) {
      object.parent.updateWorldMatrix(true, false);
      desired.premultiply(object.parent.matrixWorld.clone().invert());
    }
    desired.decompose(object.position, object.quaternion, object.scale);
    object.visible = true;
    object.updateMatrixWorld(true);
  }

  async function applyBindingTransform(binding, tileKey, transform) {
    const desired = await renderMatrix(tileKey, transform);
    binding.mesh.updateWorldMatrix(true, false);
    desired.premultiply(binding.mesh.matrixWorld.clone().invert());
    binding.mesh.setMatrixAt(binding.instanceId, desired);
    binding.mesh.instanceMatrix.needsUpdate = true;
    binding.mesh.computeBoundingSphere?.();
    hiddenMatrices.delete(`${binding.mesh.uuid}:${binding.instanceId}`);
  }

  function cloneMaterial(material) {
    const clone = material.clone();
    clone.userData = { ...material.userData, wowserglExternalClone: true };
    if (clone.isShaderMaterial) {
      const uniforms = {};
      for (const [name, entry] of Object.entries(clone.uniforms ?? {})) {
        const value = entry?.value;
        uniforms[name] = { ...entry, value: value?.clone ? value.clone() : value };
      }
      clone.uniforms = uniforms;
      clone.defines = { ...(clone.defines ?? {}) };
      delete clone.defines.WOW_INSTANCED;
      delete clone.defines.WOW_INSTANCE_TINT;
      if (clone.uniforms.uHasInstanceTint) clone.uniforms.uHasInstanceTint.value = 0;
    }
    return clone;
  }

  function cloneObjectMaterials(root) {
    root.traverse((object) => {
      if (!object.isMesh || !object.material) return;
      object.material = Array.isArray(object.material) ? object.material.map(cloneMaterial) : cloneMaterial(object.material);
    });
  }

  async function standaloneWmo(target) {
    const key = keyFor(target);
    if (standalone.has(key)) return standalone.get(key);
    const template = wmoRoots(target, true)[0];
    if (!template) throw notHydrated(`WMO ${target.model} is not hydrated`);
    const clone = template.clone(true);
    cloneObjectMaterials(clone);
    clone.userData.wmoPick = { ...(template.userData.wmoPick ?? {}), kind: 'wmo', tile: target.tileKey, model: target.model, uniqueId: target.sourceId ?? target.recordId };
    clone.userData.wowserglExternalTarget = { ...target };
    clone.name = `wowsergl-external:${target.model}`;
    requireScene().add(clone);
    standalone.set(key, clone);
    return clone;
  }

  async function standaloneDoodad(target) {
    const T = await THREE();
    const key = keyFor(target);
    const cached = standalone.get(key);
    if (cached) return cached;
    const exact = target.sourceId !== undefined ? doodadBindings(target) : [];
    let sources = exact;
    if (!sources.length) {
      const rootScene = requireScene();
      let cell = null;
      const candidates = [];
      rootScene.traverse((object) => {
        if (isStudioObject(object)) return;
        const meta = object.userData?.wowDoodad;
        if (!object.isInstancedMesh || object.count < 1 || !meta) return;
        if (String(meta.tileKey ?? '') !== target.tileKey || normalize(meta.source) !== normalize(target.model)) return;
        const candidateCell = String(meta.spatialCell ?? 'default');
        cell ??= candidateCell;
        if (candidateCell === cell) candidates.push({ mesh: object, instanceId: 0 });
      });
      sources = candidates;
    }
    if (!sources.length) throw notHydrated(`M2 ${target.model} is not hydrated`);
    const first = sources[0];
    const instanceMatrix = new T.Matrix4();
    first.mesh.getMatrixAt(first.instanceId, instanceMatrix);
    first.mesh.updateWorldMatrix(true, false);
    const group = new T.Group();
    first.mesh.matrixWorld.clone().multiply(instanceMatrix).decompose(group.position, group.quaternion, group.scale);
    group.name = `wowsergl-external:${target.model}`;
    group.userData.wowserglExternalTarget = { ...target };
    const parts = new Set();
    for (const binding of sources) {
      const meta = binding.mesh.userData?.wowDoodad ?? {};
      const partKey = `${meta.meshIndex ?? 'm'}:${meta.part ?? 'p'}`;
      if (parts.has(partKey)) continue;
      parts.add(partKey);
      const mesh = new T.Mesh(
        binding.mesh.geometry,
        Array.isArray(binding.mesh.material) ? binding.mesh.material.map(cloneMaterial) : cloneMaterial(binding.mesh.material),
      );
      mesh.userData.wowDoodad = { ...meta };
      group.add(mesh);
    }
    requireScene().add(group);
    standalone.set(key, group);
    for (const binding of exact) {
      const matrix = new T.Matrix4();
      binding.mesh.getMatrixAt(binding.instanceId, matrix);
      const bindingKey = `${binding.mesh.uuid}:${binding.instanceId}`;
      if (!hiddenMatrices.has(bindingKey)) hiddenMatrices.set(bindingKey, matrix.clone());
      const p = new T.Vector3(), q = new T.Quaternion(), s = new T.Vector3();
      matrix.decompose(p, q, s);
      binding.mesh.setMatrixAt(binding.instanceId, new T.Matrix4().compose(p, q, s.setScalar(0)));
      binding.mesh.instanceMatrix.needsUpdate = true;
    }
    return group;
  }

  async function applyTransform(target, transform) {
    const live = standalone.get(keyFor(target));
    if (live) return await applyObjectTransform(live, target.tileKey, transform);
    if (target.kind === 'wmo') {
      const root = wmoRoots(target)[0];
      if (!root) throw notHydrated(`WMO ${target.model} is not loaded`);
      return await applyObjectTransform(root, target.tileKey, transform);
    }
    if (target.kind === 'm2') {
      const bindings = doodadBindings(target);
      if (!bindings.length) throw notHydrated(`M2 ${target.model} is not loaded`);
      await Promise.all(bindings.map((binding) => applyBindingTransform(binding, target.tileKey, transform)));
      return;
    }
    throw new Error(`live transform is not supported for ${target.kind}`);
  }

  async function spawn(target, transform) {
    const object = target.kind === 'wmo' ? await standaloneWmo(target) : target.kind === 'm2' ? await standaloneDoodad(target) : null;
    if (!object) throw new Error(`live spawn is not supported for ${target.kind}`);
    await applyObjectTransform(object, target.tileKey, transform);
  }

  async function remove(target) {
    const T = await THREE();
    const key = keyFor(target);
    const live = standalone.get(key);
    if (live) {
      hiddenVisibility.set(key, live.visible);
      live.visible = false;
      return;
    }
    if (target.kind === 'wmo') {
      const root = wmoRoots(target)[0];
      if (!root) throw notHydrated(`WMO ${target.model} is not loaded`);
      hiddenVisibility.set(key, root.visible);
      root.visible = false;
      return;
    }
    if (target.kind === 'm2') {
      const bindings = doodadBindings(target);
      if (!bindings.length) throw notHydrated(`M2 ${target.model} is not loaded`);
      for (const binding of bindings) {
        const matrix = new T.Matrix4();
        binding.mesh.getMatrixAt(binding.instanceId, matrix);
        const bindingKey = `${binding.mesh.uuid}:${binding.instanceId}`;
        if (!hiddenMatrices.has(bindingKey)) hiddenMatrices.set(bindingKey, matrix.clone());
        const p = new T.Vector3(), q = new T.Quaternion(), s = new T.Vector3();
        matrix.decompose(p, q, s);
        binding.mesh.setMatrixAt(binding.instanceId, new T.Matrix4().compose(p, q, s.setScalar(0)));
        binding.mesh.instanceMatrix.needsUpdate = true;
      }
      return;
    }
    throw new Error(`live delete is not supported for ${target.kind}`);
  }

  async function restore(target) {
    const key = keyFor(target);
    const live = standalone.get(key);
    if (live) {
      live.visible = hiddenVisibility.get(key) ?? true;
      hiddenVisibility.delete(key);
      return;
    }
    if (target.kind === 'wmo') {
      const root = wmoRoots(target)[0];
      if (!root) throw notHydrated(`WMO ${target.model} is not loaded`);
      root.visible = hiddenVisibility.get(key) ?? true;
      hiddenVisibility.delete(key);
      return;
    }
    if (target.kind === 'm2') {
      for (const binding of doodadBindings(target)) {
        const bindingKey = `${binding.mesh.uuid}:${binding.instanceId}`;
        const matrix = hiddenMatrices.get(bindingKey);
        if (!matrix) continue;
        binding.mesh.setMatrixAt(binding.instanceId, matrix);
        binding.mesh.instanceMatrix.needsUpdate = true;
        hiddenMatrices.delete(bindingKey);
      }
      return;
    }
  }

  function materialMatches(root, locator, kind) {
    let slot = 0;
    const matches = [];
    root.traverse((object) => {
      if (!object.isMesh || !object.material) return;
      const meta = kind === 'wmo' ? object.userData?.wmoPick : object.userData?.wowDoodad;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((_material, index) => {
        const exact = slot === locator.slot;
        const metadata = kind === 'wmo'
          ? (locator.groupIndex !== undefined || locator.textureIndex !== undefined) &&
            (locator.groupIndex === undefined || Number(meta?.groupIndex) === locator.groupIndex) &&
            (locator.textureIndex === undefined || Number(meta?.tex ?? meta?.textureIndex) === locator.textureIndex)
          : (locator.meshIndex !== undefined || locator.partIndex !== undefined) &&
            (locator.meshIndex === undefined || Number(meta?.meshIndex) === locator.meshIndex) &&
            (locator.partIndex === undefined || Number(meta?.part ?? meta?.partIndex) === locator.partIndex);
        if (exact || metadata) matches.push({ mesh: object, index });
        slot++;
      });
    });
    return matches;
  }

  function cloneSlot(mesh, index) {
    const list = Array.isArray(mesh.material) ? [...mesh.material] : [mesh.material];
    let material = list[index];
    if (!material) return null;
    if (!material.userData?.wowserglExternalClone) material = cloneMaterial(material);
    list[index] = material;
    mesh.material = Array.isArray(mesh.material) ? list : material;
    return material;
  }

  async function setMaterialValues(material, spec) {
    const T = await THREE();
    if (spec.color) {
      const color = new T.Color(spec.color);
      if (material.color?.copy) material.color.copy(color);
      else if (material.uniforms?.uM2Color?.value?.set) {
        const current = material.uniforms.uM2Color.value;
        current.set(color.r, color.g, color.b, current.w ?? 1);
      }
    }
    if (spec.opacity !== undefined) {
      material.opacity = Math.max(0, Math.min(1, Number(spec.opacity)));
      material.transparent = material.opacity < 0.999;
    }
    if (spec.emissive && material.emissive?.set) material.emissive.set(spec.emissive);
    if (spec.textureUrl) {
      const texture = await new T.TextureLoader().loadAsync(spec.textureUrl);
      texture.colorSpace = T.NoColorSpace;
      texture.flipY = false;
      if (material.isShaderMaterial && material.uniforms?.uMap) {
        material.uniforms.uMap.value = texture;
        if (material.uniforms.uHasMap) material.uniforms.uHasMap.value = 1;
      } else if ('map' in material) material.map = texture;
    }
    material.needsUpdate = true;
  }

  async function applyMaterial(target, spec) {
    let roots = [];
    if (target.kind === 'wmo') roots = spec.scope === 'asset' ? wmoRoots(target, true) : [standalone.get(keyFor(target)) ?? wmoRoots(target)[0]].filter(Boolean);
    else if (target.kind === 'm2' && spec.scope === 'instance') roots = [await standaloneDoodad(target)];
    else if (target.kind === 'm2') {
      const rootScene = requireScene();
      const pending = [];
      rootScene.traverse((object) => {
        const meta = object.userData?.wowDoodad;
        if (!object.isInstancedMesh || !meta || isStudioObject(object)) return;
        if (String(meta.tileKey ?? '') !== target.tileKey || normalize(meta.source) !== normalize(target.model)) return;
        const list = Array.isArray(object.material) ? [...object.material] : [object.material];
        for (let index = 0; index < list.length; index++) {
          list[index] = list[index].userData?.wowserglExternalClone ? list[index] : cloneMaterial(list[index]);
          pending.push(setMaterialValues(list[index], spec));
        }
        object.material = Array.isArray(object.material) ? list : list[0];
      });
      if (!pending.length) throw notHydrated(`M2 ${target.model} is not loaded`);
      await Promise.all(pending);
      return;
    }
    if (!roots.length) throw notHydrated(`${target.kind.toUpperCase()} ${target.model} is not loaded`);
    let changed = 0;
    for (const root of roots) {
      for (const match of materialMatches(root, spec.locator ?? { slot: 0 }, target.kind)) {
        const material = cloneSlot(match.mesh, match.index);
        if (!material) continue;
        await setMaterialValues(material, spec);
        changed++;
      }
    }
    if (!changed) throw new Error(`material slot ${spec.locator?.slot ?? 0} not found`);
  }

  async function applyAdvanced(target, spec) {
    const T = await THREE();
    let roots = [];
    if (target.kind === 'wmo') roots = spec.scope === 'asset' ? wmoRoots(target, true) : [standalone.get(keyFor(target)) ?? wmoRoots(target)[0]].filter(Boolean);
    else if (target.kind === 'm2') roots = spec.scope === 'instance'
      ? [await standaloneDoodad(target)]
      : [...new Set(doodadBindings(target, true).map((binding) => binding.mesh))];
    if (!roots.length) throw notHydrated(`${target.model} is not loaded`);
    let changed = 0;
    for (const root of roots) {
      for (const match of materialMatches(root, spec.locator ?? { slot: 0 }, target.kind)) {
        const material = cloneSlot(match.mesh, match.index);
        if (!material) continue;
        if (spec.opacity !== undefined) {
          material.opacity = Math.max(0, Math.min(1, Number(spec.opacity)));
          material.transparent = material.opacity < 0.999;
        }
        if (spec.doubleSided !== undefined) material.side = spec.doubleSided ? T.DoubleSide : T.FrontSide;
        if (spec.depthWrite !== undefined) material.depthWrite = !!spec.depthWrite;
        if (material.emissive?.set && spec.emissive) material.emissive.set(spec.shaderMode === 'emissive' ? spec.emissive : '#000000');
        const map = material.map ?? material.uniforms?.uMap?.value;
        if (map) {
          map.wrapS = map.wrapT = T.RepeatWrapping;
          if (spec.uvScale) map.repeat.set(spec.uvScale[0], spec.uvScale[1]);
          if (spec.uvOffset) map.offset.set(spec.uvOffset[0], spec.uvOffset[1]);
          map.needsUpdate = true;
        }
        material.userData.wowserglShaderMode = spec.shaderMode ?? 'vanilla';
        material.needsUpdate = true;
        changed++;
      }
    }
    if (!changed) throw new Error(`advanced material slot ${spec.locator?.slot ?? 0} not found`);
  }

  async function applyEnvironment(environment) {
    environmentOverride = { ...environment };
    const T = await THREE();
    const rootScene = scene();
    if (!rootScene) return;
    g.wowTune?.({ time: T.MathUtils.clamp(environment.hour, 0, 24) * 120 });
    if (rootScene.fog) {
      rootScene.fog.near = Math.max(0, Number(environment.fogNear));
      rootScene.fog.far = Math.max(Number(environment.fogNear) + 1, Number(environment.fogFar));
      rootScene.fog.color?.set?.(environment.fogColor);
    }
    const type = environment.weather === 'rain' ? 1 : environment.weather === 'snow' ? 2 : 0;
    g.__wowWeather?.setWeather?.({ type, grade: type ? 1 : 0, soundId: 0, instant: true });
  }

  async function focus(target) {
    const T = await THREE();
    const cam = camera();
    const ctl = controls();
    if (!cam || !ctl) throw notHydrated('VanillaGL QA camera is not ready');
    const object = standalone.get(keyFor(target)) ?? (target.kind === 'wmo' ? wmoRoots(target)[0] : null);
    let point = object?.getWorldPosition?.(new T.Vector3()) ?? null;
    if (!point && target.kind === 'm2') {
      const binding = doodadBindings(target)[0];
      if (binding) {
        const matrix = new T.Matrix4();
        binding.mesh.getMatrixAt(binding.instanceId, matrix);
        point = new T.Vector3().setFromMatrixPosition(binding.mesh.matrixWorld.clone().multiply(matrix));
      }
    }
    if (!point) throw notHydrated(`${target.model} is not loaded`);
    const offset = cam.position.clone().sub(ctl.target);
    ctl.target.copy(point);
    cam.position.copy(point).add(offset.lengthSq() > 1 ? offset : new T.Vector3(12, 12, 8));
    ctl.update();
  }

  async function targetPosition(target) {
    const T = await THREE();
    const object = standalone.get(keyFor(target)) ?? (target.kind === 'wmo' ? wmoRoots(target)[0] : null);
    if (object) return object.getWorldPosition(new T.Vector3());
    if (target.kind === 'm2') {
      const binding = doodadBindings(target)[0];
      if (binding) {
        const matrix = new T.Matrix4();
        binding.mesh.getMatrixAt(binding.instanceId, matrix);
        return new T.Vector3().setFromMatrixPosition(binding.mesh.matrixWorld.clone().multiply(matrix));
      }
    }
    const cam = camera();
    if (!cam) return new T.Vector3();
    return cam.position.clone().add(new T.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).multiplyScalar(4));
  }

  async function previewLight(target, spec) {
    const T = await THREE();
    const rootScene = requireScene();
    const key = keyFor(target);
    const existing = lights.get(key);
    if (!spec.enabled) {
      existing?.removeFromParent();
      lights.delete(key);
      return;
    }
    const light = existing ?? new T.PointLight();
    if (!existing) {
      light.name = `wowsergl-light:${key}`;
      rootScene.add(light);
      lights.set(key, light);
    }
    light.color.set(spec.color || '#ffffff');
    light.intensity = Math.max(0, Number(spec.intensity) || 0);
    light.distance = Math.max(0, Number(spec.radius) || 0);
    light.position.copy(await targetPosition(target));
  }

  async function worldPoint(tileKey, point) {
    const T = await THREE();
    const origin = await renderOrigin(tileKey);
    return new T.Vector3(point.x - origin.x, point.y - origin.y, point.z);
  }

  async function startBehavior(target, spec) {
    stopBehavior(target);
    const T = await THREE();
    const rootScene = requireScene();
    const center = await targetPosition(target);
    const marker = new T.Mesh(new T.SphereGeometry(0.5, 14, 10), new T.MeshBasicMaterial({ wireframe: true, depthTest: false }));
    marker.position.copy(center);
    marker.renderOrder = 10000;
    rootScene.add(marker);
    const points = await Promise.all((spec.waypoints ?? []).map((point) => worldPoint(target.tileKey, point)));
    let line;
    if (points.length > 1) {
      line = new T.Line(new T.BufferGeometry().setFromPoints(points), new T.LineBasicMaterial({ transparent: true, opacity: 0.8, depthTest: false }));
      line.renderOrder = 9999;
      rootScene.add(line);
    }
    behaviors.set(keyFor(target), { marker, line, spec: structuredClone(spec), target, elapsed: 0, segment: 0, center, points });
  }

  function stopBehavior(target) {
    const runtime = behaviors.get(keyFor(target));
    if (!runtime) return;
    runtime.marker.geometry?.dispose?.();
    runtime.marker.material?.dispose?.();
    runtime.marker.removeFromParent();
    runtime.line?.geometry?.dispose?.();
    runtime.line?.material?.dispose?.();
    runtime.line?.removeFromParent();
    behaviors.delete(keyFor(target));
  }

  async function previewCharacter(target, spec) {
    await clearCharacter(target);
    const T = await THREE();
    const { loadBakedCharacterModel } = await import('/src/model-loader.ts');
    const info = {
      guid: `wowsergl-${target.recordId}`, guidBytes: [0,0,0,0,0,0,0,0], name: 'StudioPreview',
      race: Math.max(1, Math.min(8, Math.floor(spec.race))), classId: Math.max(1, Math.floor(spec.classId)),
      gender: spec.gender === 1 ? 1 : 0, skin: Math.max(0, Math.floor(spec.skin)), face: Math.max(0, Math.floor(spec.face)),
      hairStyle: Math.max(0, Math.floor(spec.hairStyle)), hairColor: Math.max(0, Math.floor(spec.hairColor)),
      facialHair: Math.max(0, Math.floor(spec.facialHair)), level: Math.max(1, Math.min(60, Math.floor(spec.level))),
      zone: 0, map: 0, x: 0, y: 0, z: 0, equipment: Array.isArray(spec.equipment) ? spec.equipment.map((item) => ({ ...item })) : [],
    };
    const model = await loadBakedCharacterModel(info, 8);
    const root = new T.Group();
    root.add(model.group);
    root.position.copy(await targetPosition(target));
    root.scale.setScalar(Math.max(0.1, Number(spec.scale ?? 1)));
    requireScene().add(root);
    model.animator?.update?.(0, 'stand');
    characters.set(keyFor(target), { root, model, animationId: Math.max(0, Math.floor(Number(spec.animationId ?? 0))) });
  }

  async function clearCharacter(target) {
    const runtime = characters.get(keyFor(target));
    if (!runtime) return;
    runtime.root.removeFromParent();
    runtime.model.dispose?.();
    characters.delete(keyFor(target));
  }

  async function applyProject(project, retry = true) {
    let missing = 0;
    for (const item of project.objects ?? []) {
      try {
        if (item.state === 'deleted') await remove(item.target);
        else if (item.state === 'added' && item.transform) await spawn(item.target, item.transform);
        else if (item.transform) await applyTransform(item.target, item.transform);
      } catch (error) {
        if (isNotHydrated(error)) missing++;
        else throw error;
      }
    }
    for (const override of project.materials ?? []) {
      const target = { recordId: override.recordId, tileKey: override.tileKey, kind: override.kind, model: override.model, sourceId: override.sourceId };
      try {
        await applyMaterial(target, override);
        if (override.shaderMode || override.doubleSided !== undefined || override.depthWrite !== undefined || override.uvScale || override.uvOffset || override.emissive) {
          await applyAdvanced(target, override);
        }
      } catch (error) {
        if (isNotHydrated(error)) missing++;
        else throw error;
      }
    }
    if (project.environment) await applyEnvironment(project.environment);
    if (retry && missing) {
      pendingProject = project;
      clearTimeout(projectRetryTimer);
      projectRetryTimer = setTimeout(() => void applyProject(project, true).catch(console.warn), 1200);
    } else if (!missing && pendingProject === project) pendingProject = null;
    return missing;
  }

  function tick(now) {
    const dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;
    for (const runtime of characters.values()) {
      if (runtime.animationId > 0 && runtime.model.animator?.updateAnimationId) runtime.model.animator.updateAnimationId(dt, runtime.animationId, camera() ?? undefined, runtime.model.group);
      else runtime.model.animator?.update?.(dt, 'stand');
    }
    for (const runtime of [...behaviors.values()]) {
      runtime.elapsed += dt;
      const spec = runtime.spec;
      if (spec.mode === 'idle' || spec.mode === 'guard') continue;
      if (spec.mode === 'wander') {
        const radius = Math.max(0.25, Number(spec.wanderDistance) || 0.25);
        const speed = Math.max(0.1, Number(spec.speed) || 0.1);
        runtime.marker.position.set(runtime.center.x + Math.cos(runtime.elapsed * speed / radius) * radius, runtime.center.y + Math.sin(runtime.elapsed * speed / radius) * radius, runtime.center.z + 0.5);
        continue;
      }
      if (runtime.points.length < 2) continue;
      const a = runtime.points[runtime.segment % runtime.points.length];
      const b = runtime.points[(runtime.segment + 1) % runtime.points.length];
      const source = spec.waypoints?.[(runtime.segment + 1) % runtime.points.length];
      const duration = Math.max(0.05, a.distanceTo(b) / Math.max(0.1, Number(source?.speed ?? spec.speed) || 0.1));
      const t = Math.min(1, runtime.elapsed / duration);
      runtime.marker.position.lerpVectors(a, b, t);
      runtime.marker.position.z += 0.5;
      if (t >= 1) {
        runtime.elapsed = 0;
        runtime.segment++;
        if (!spec.loop && runtime.segment >= runtime.points.length - 1) stopBehavior(runtime.target);
      }
    }
    frame = requestAnimationFrame(tick);
  }

  async function handle(command) {
    switch (command?.type) {
      case 'transform.set': await applyTransform(command.target, command.transform); return 'transform updated through external adapter';
      case 'object.spawn': await spawn(command.target, command.transform); return 'object spawned through external adapter';
      case 'object.delete': await remove(command.target); return 'object hidden through external adapter';
      case 'object.restore': await restore(command.target); return 'object restored through external adapter';
      case 'material.set': await applyMaterial(command.target, command.override); return 'material override applied through external adapter';
      case 'material.advanced': await applyAdvanced(command.target, command.material); return 'advanced material applied through external adapter';
      case 'environment.set': await applyEnvironment(command.environment); return 'environment preview applied through external adapter';
      case 'project.apply': {
        const missing = await applyProject(command.project, true);
        return missing ? `project applied; ${missing} target(s) waiting for VanillaGL streaming` : 'project applied through external adapter';
      }
      case 'playmode.set': g.__wowFreeCam?.(!command.playing); return command.playing ? 'VanillaGL gameplay camera enabled' : 'VanillaGL QA free camera enabled';
      case 'selection.focus': await focus(command.target); return 'VanillaGL QA camera focused';
      case 'light.preview': await previewLight(command.target, command.light); return 'point-light preview applied through external adapter';
      case 'behavior.preview': await startBehavior(command.target, command.behavior); return 'NPC behavior preview applied through external adapter';
      case 'behavior.stop': stopBehavior(command.target); return 'NPC behavior preview stopped';
      case 'character.preview': await previewCharacter(command.target, command.character); return 'character preview composed by VanillaGL development modules';
      case 'character.clear': await clearCharacter(command.target); return 'character preview cleared';
      default: throw new Error(`Unsupported WowserGL live command: ${command?.type ?? 'unknown'}`);
    }
  }

  function state() {
    return {
      version: VERSION,
      sceneReady: !!scene() && !!camera(),
      source: 'wowsergl-external-cdp',
      capabilities: [
        'transform.set','object.spawn','object.delete','object.restore','material.set','material.advanced',
        'environment.set','project.apply','playmode.set','selection.focus','light.preview','behavior.preview',
        'behavior.stop','character.preview','character.clear',
      ],
    };
  }

  async function cleanup() {
    clearInterval(environmentTimer);
    clearTimeout(projectRetryTimer);
    if (frame) cancelAnimationFrame(frame);
    for (const light of lights.values()) light.removeFromParent();
    for (const runtime of [...behaviors.values()]) stopBehavior(runtime.target);
    for (const [key, runtime] of [...characters.entries()]) {
      runtime.root.removeFromParent();
      runtime.model.dispose?.();
      characters.delete(key);
    }
    delete g.__wowserglExternalRuntime;
  }

  const api = { version: VERSION, handle, state, cleanup };
  g.__wowserglExternalRuntime = api;
  environmentTimer = setInterval(() => { if (environmentOverride) void applyEnvironment(environmentOverride); }, 300);
  frame = requestAnimationFrame(tick);
  return api.state();
}

export const runtimeBootstrapSource = () => `(${installVanillaGLCompatibilityRuntime.toString()})()`;
