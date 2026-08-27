import * as THREE from 'three';
import type { EditorApp } from './editor-app';
import { applySnapshot, snapshotTransform } from './editor-store';
import type { EditorRecord, TileIndexEntry, TransformSnapshot } from './types';

const normalizedModel = (value: string) => value.replaceAll('\\', '/').toLowerCase();

function installStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .asset-categories{display:flex;gap:4px;padding:5px 7px;border-bottom:1px solid #242a31;overflow-x:auto}
    .asset-categories button{white-space:nowrap;font-size:10px;padding:4px 7px}
    .asset-thumbnail-3d{position:relative;overflow:hidden;background:radial-gradient(circle at 50% 42%,#3c444e,#20252b)}
    .asset-thumbnail-3d img{width:100%;height:100%;object-fit:contain;display:block}
    .asset-thumbnail-3d small{position:absolute;right:2px;bottom:2px;padding:1px 3px;border-radius:2px;background:#111a;color:#d8dde3;font-size:8px}
    .studio-marquee{position:fixed;z-index:80;border:1px solid #65a9ff;background:#4a9cff22;pointer-events:none}
    .multi-selection-badge{display:inline-flex;align-items:center;gap:5px;padding:4px 7px;border:1px solid #3c4652;border-radius:3px;color:#b9c6d4;font-size:11px}
    .multi-selection-badge.active{border-color:#4788ce;color:#dbeaff;background:#28578633}
    .vmangos-component input{width:100%;box-sizing:border-box}.vmangos-component .vmangos-model{word-break:break-all;color:#8794a2;font-size:10px}
    .stream-status{position:absolute;left:10px;top:40px;z-index:4;padding:4px 7px;border-radius:3px;background:#151a20d9;border:1px solid #343c46;color:#bac4cf;font-size:10px;pointer-events:none}
  `;
  document.head.append(style);
}

function readTileIndex(payload: unknown): TileIndexEntry[] {
  if (Array.isArray(payload)) return payload as TileIndexEntry[];
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of ['tiles', 'entries', 'index']) if (Array.isArray(record[key])) return record[key] as TileIndexEntry[];
  }
  return [];
}

function disposeGroup(root: THREE.Object3D) {
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    const list = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    for (const material of list) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      if (material instanceof THREE.ShaderMaterial) for (const uniform of Object.values(material.uniforms)) if (uniform?.value instanceof THREE.Texture) textures.add(uniform.value);
    }
  });
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
}

class NeighborhoodStreamer {
  private index: TileIndexEntry[] = [];
  private readonly streamed = new Map<string, THREE.Object3D>();
  private readonly loading = new Map<string, Promise<void>>();
  private lastCenter = '';
  private lastPrimary = '';
  private badge: HTMLElement;

  constructor(private readonly app: EditorApp, root: HTMLElement) {
    this.badge = document.createElement('div');
    this.badge.className = 'stream-status';
    this.badge.textContent = 'Streaming: waiting for tile index';
    root.querySelector('[data-viewport]')?.append(this.badge);
    void this.initialize();
    window.setInterval(() => void this.update(), 450);
  }

  private async initialize() {
    try {
      const response = await fetch('/terrain/index.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.index = readTileIndex(await response.json());
      this.badge.textContent = this.index.length ? `Streaming index: ${this.index.length.toLocaleString()} tiles` : 'Streaming index is empty';
    } catch (error) {
      this.badge.textContent = `3×3 streaming unavailable: ${(error as Error).message}`;
    }
  }

  private findTileAtWorld(map: number, x: number, y: number) {
    return this.index.find((entry) => entry.map === map && x <= entry.originX + 1 && x >= entry.originX - 533.33333 - 1 && y <= entry.originY + 1 && y >= entry.originY - 533.33333 - 1);
  }

  private neighborhood(center: TileIndexEntry) {
    const match = /_(\d+)_(\d+)$/.exec(center.key);
    if (!match) return new Set([center.key]);
    const cx = Number(match[1]), cy = Number(match[2]);
    return new Set(this.index.filter((candidate) => {
      if (candidate.map !== center.map || candidate.dir !== center.dir) return false;
      const c = /_(\d+)_(\d+)$/.exec(candidate.key);
      if (!c) return false;
      return Math.max(Math.abs(Number(c[1]) - cx), Math.abs(Number(c[2]) - cy)) <= 1;
    }).map((entry) => entry.key));
  }

  async update() {
    const primary = this.app.store.tileKey;
    if (!primary || !this.index.length) return;
    const map = Number(new URLSearchParams(location.search).get('map') ?? 0);
    const camera = this.app.camera.active.position;
    const center = this.findTileAtWorld(map, camera.x, camera.y) ?? this.index.find((entry) => entry.key === primary);
    if (!center) return;
    const target = this.neighborhood(center);
    if (center.key === this.lastCenter && primary === this.lastPrimary && [...target].every((key) => key === primary || this.streamed.has(key) || this.loading.has(key))) return;
    this.lastCenter = center.key;
    this.lastPrimary = primary;

    const duplicate = this.streamed.get(primary);
    if (duplicate) {
      this.app.scene.remove(duplicate);
      disposeGroup(duplicate);
      this.streamed.delete(primary);
    }

    for (const [key, group] of [...this.streamed]) {
      if (target.has(key)) continue;
      this.app.scene.remove(group);
      disposeGroup(group);
      this.streamed.delete(key);
    }

    for (const key of target) {
      if (key === primary || this.streamed.has(key) || this.loading.has(key)) continue;
      const pending = this.app.source.loadTile(key, map).then((tile) => {
        tile.group.userData.editorStreamedNeighbor = true;
        tile.group.userData.editorNonSelectable = true;
        this.app.scene.add(tile.group);
        this.streamed.set(key, tile.group);
      }).catch((error) => console.warn(`[Studio] neighbor ${key} failed`, error)).finally(() => this.loading.delete(key));
      this.loading.set(key, pending);
    }
    this.badge.textContent = `3×3 · center ${center.key} · ${1 + this.streamed.size}/${target.size} visible`;
  }
}

class MultiSelectionController {
  private selected = new Map<string, EditorRecord>();
  private helpers = new Map<string, THREE.BoxHelper>();
  private suppressStoreEvent = false;
  private marquee: HTMLElement | null = null;
  private start = new THREE.Vector2();
  private dragStartWorld = new Map<string, THREE.Matrix4>();
  private dragStartLocal = new Map<string, TransformSnapshot>();
  private primaryStartWorld: THREE.Matrix4 | null = null;
  private badge: HTMLElement;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  constructor(private readonly app: EditorApp, root: HTMLElement) {
    this.badge = document.createElement('span');
    this.badge.className = 'multi-selection-badge';
    this.badge.textContent = '1 object';
    root.querySelector('.transform-tools')?.append(this.badge);
    app.store.addEventListener('selection', (event) => {
      if (this.suppressStoreEvent) return;
      const record = (event as CustomEvent<EditorRecord | null>).detail;
      this.selected.clear();
      if (record) this.selected.set(record.id, record);
      this.refreshHelpers();
    });
    app.store.addEventListener('change', () => this.updateHelpers());
    this.bindPointer();
    this.bindClusterTransform();
  }

  private eventPoint(event: PointerEvent) {
    const rect = this.app.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  }

  private hitRecord(event: PointerEvent) {
    this.eventPoint(event);
    this.raycaster.setFromCamera(this.pointer, this.app.camera.active);
    const hits = this.raycaster.intersectObjects(this.app.scene.children, true);
    for (const hit of hits) {
      let blocked = false;
      for (let node: THREE.Object3D | null = hit.object; node; node = node.parent) if (node.userData.editorNonSelectable) { blocked = true; break; }
      if (blocked || hit.object.userData.editorTerrain) continue;
      const record = this.app.store.resolveHit(hit);
      if (record) return record;
    }
    return null;
  }

  private bindPointer() {
    const canvas = this.app.renderer.domElement;
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.altKey || (this.app.gizmo.controls as unknown as { dragging?: boolean }).dragging) return;
      const hit = this.hitRecord(event);
      if (event.shiftKey && hit) {
        event.stopImmediatePropagation();
        if (this.selected.has(hit.id) && this.selected.size > 1) this.selected.delete(hit.id); else this.selected.set(hit.id, hit);
        if (!this.app.store.selected || !this.selected.has(this.app.store.selected.id)) this.setPrimary(hit);
        this.refreshHelpers();
        return;
      }
      if (hit) return;
      event.stopImmediatePropagation();
      this.start.set(event.clientX, event.clientY);
      this.marquee = document.createElement('div');
      this.marquee.className = 'studio-marquee';
      this.marquee.style.left = `${event.clientX}px`;
      this.marquee.style.top = `${event.clientY}px`;
      document.body.append(this.marquee);
      canvas.setPointerCapture?.(event.pointerId);
    }, true);
    canvas.addEventListener('pointermove', (event) => {
      if (!this.marquee) return;
      const left = Math.min(this.start.x, event.clientX), top = Math.min(this.start.y, event.clientY);
      this.marquee.style.left = `${left}px`;
      this.marquee.style.top = `${top}px`;
      this.marquee.style.width = `${Math.abs(event.clientX - this.start.x)}px`;
      this.marquee.style.height = `${Math.abs(event.clientY - this.start.y)}px`;
    }, true);
    canvas.addEventListener('pointerup', (event) => {
      if (!this.marquee) return;
      event.stopImmediatePropagation();
      const end = new THREE.Vector2(event.clientX, event.clientY);
      this.marquee.remove();
      this.marquee = null;
      if (end.distanceTo(this.start) < 5) {
        this.selected.clear();
        this.setPrimary(null);
        this.refreshHelpers();
        return;
      }
      this.selectRectangle(this.start, end, event.shiftKey);
    }, true);
  }

  private selectRectangle(start: THREE.Vector2, end: THREE.Vector2, additive: boolean) {
    const rect = this.app.renderer.domElement.getBoundingClientRect();
    const left = Math.min(start.x, end.x), right = Math.max(start.x, end.x), top = Math.min(start.y, end.y), bottom = Math.max(start.y, end.y);
    if (!additive) this.selected.clear();
    const point = new THREE.Vector3();
    for (const record of this.app.store.records.values()) {
      if (!record.object.visible || record.state === 'deleted') continue;
      record.object.getWorldPosition(point);
      point.project(this.app.camera.active);
      const sx = rect.left + (point.x * 0.5 + 0.5) * rect.width;
      const sy = rect.top + (-point.y * 0.5 + 0.5) * rect.height;
      if (point.z >= -1 && point.z <= 1 && sx >= left && sx <= right && sy >= top && sy <= bottom) this.selected.set(record.id, record);
    }
    const primary = this.selected.values().next().value as EditorRecord | undefined;
    this.setPrimary(primary ?? null);
    this.refreshHelpers();
  }

  private setPrimary(record: EditorRecord | null) {
    this.suppressStoreEvent = true;
    this.app.store.select(record);
    this.suppressStoreEvent = false;
  }

  private bindClusterTransform() {
    this.app.gizmo.controls.addEventListener('mouseDown', () => {
      const primary = this.app.store.selected;
      if (!primary || this.selected.size < 2) return;
      primary.object.updateWorldMatrix(true, false);
      this.primaryStartWorld = primary.object.matrixWorld.clone();
      this.dragStartWorld.clear();
      this.dragStartLocal.clear();
      for (const record of this.selected.values()) {
        if (record === primary) continue;
        record.object.updateWorldMatrix(true, false);
        this.dragStartWorld.set(record.id, record.object.matrixWorld.clone());
        this.dragStartLocal.set(record.id, snapshotTransform(record.object));
      }
    });
    this.app.gizmo.controls.addEventListener('objectChange', () => {
      const primary = this.app.store.selected;
      if (!primary || !this.primaryStartWorld || this.selected.size < 2) return;
      primary.object.updateWorldMatrix(true, false);
      const delta = primary.object.matrixWorld.clone().multiply(this.primaryStartWorld.clone().invert());
      for (const [id, startWorld] of this.dragStartWorld) {
        const record = this.selected.get(id);
        if (!record) continue;
        const desired = delta.clone().multiply(startWorld);
        if (record.object.parent) {
          record.object.parent.updateWorldMatrix(true, false);
          desired.premultiply(record.object.parent.matrixWorld.clone().invert());
        }
        desired.decompose(record.object.position, record.object.quaternion, record.object.scale);
        record.object.updateMatrixWorld(true);
        this.app.store.markModified(record);
      }
      this.updateHelpers();
    });
    this.app.gizmo.controls.addEventListener('mouseUp', () => {
      if (!this.primaryStartWorld || !this.dragStartLocal.size) { this.primaryStartWorld = null; return; }
      const before = new Map(this.dragStartLocal);
      const after = new Map<string, TransformSnapshot>();
      for (const id of before.keys()) {
        const record = this.selected.get(id);
        if (record) after.set(id, snapshotTransform(record.object));
      }
      this.app.history.pushApplied({
        label: `Transform selection (${this.selected.size})`,
        undo: () => { for (const [id, snapshot] of before) { const record = this.selected.get(id); if (record) { applySnapshot(record.object, snapshot); this.app.store.markModified(record); } } this.updateHelpers(); },
        redo: () => { for (const [id, snapshot] of after) { const record = this.selected.get(id); if (record) { applySnapshot(record.object, snapshot); this.app.store.markModified(record); } } this.updateHelpers(); },
      });
      this.primaryStartWorld = null;
      this.dragStartWorld.clear();
      this.dragStartLocal.clear();
    });
  }

  private refreshHelpers() {
    for (const helper of this.helpers.values()) { this.app.scene.remove(helper); helper.dispose(); }
    this.helpers.clear();
    const primary = this.app.store.selected;
    for (const record of this.selected.values()) {
      if (record === primary || !record.object.visible) continue;
      const helper = new THREE.BoxHelper(record.object, 0x63a8ff);
      helper.userData.editorNonSelectable = true;
      this.app.scene.add(helper);
      this.helpers.set(record.id, helper);
    }
    const count = this.selected.size;
    this.badge.textContent = count > 1 ? `${count} objects · cluster` : count === 1 ? '1 object' : 'No selection';
    this.badge.classList.toggle('active', count > 1);
  }

  private updateHelpers() { this.helpers.forEach((helper) => helper.update()); }
}

class VmangosExporter {
  private readonly entries = new Map<string, number>();
  private readonly panel: HTMLElement;
  private selected: EditorRecord | null = null;

  constructor(private readonly app: EditorApp, root: HTMLElement) {
    try {
      const saved = JSON.parse(localStorage.getItem('vanillagl-studio:vmangos-entries') ?? '{}') as Record<string, number>;
      for (const [model, entry] of Object.entries(saved)) if (Number.isInteger(entry) && entry > 0) this.entries.set(model, entry);
    } catch {}
    this.panel = document.createElement('section');
    this.panel.className = 'component-card vmangos-component';
    root.querySelector('[data-environment]')?.append(this.panel);
    app.store.addEventListener('selection', (event) => { this.selected = (event as CustomEvent<EditorRecord | null>).detail; this.render(); });
    const toolbar = root.querySelector('.live-tools');
    const button = document.createElement('button');
    button.textContent = 'Export vMaNGOS SQL';
    button.title = 'Export custom placed objects as vMaNGOS gameobject rows';
    button.addEventListener('click', () => this.export());
    toolbar?.append(button);
    this.render();
  }

  private render() {
    const model = this.selected?.model ?? '';
    const key = normalizedModel(model);
    const entry = this.entries.get(key) ?? 0;
    this.panel.innerHTML = `<div class="component-head"><span class="component-toggle">▾</span><strong>vMaNGOS Spawn</strong><span class="component-badge">SQL</span></div><div class="component-body">
      <div class="unity-property"><span>GO Template Entry</span><div class="property-control"><input data-vmangos-entry type="number" min="0" step="1" value="${entry || ''}" placeholder="gameobject_template.entry" ${this.selected ? '' : 'disabled'} /></div></div>
      <div class="vmangos-model">${model ? model.replaceAll('<','&lt;') : 'Select a placed object to map its client model to an existing gameobject_template entry.'}</div>
      <div class="component-help">vMaNGOS spawns require a real <code>gameobject_template.entry</code>; a client M2/WMO path alone cannot safely invent one. The mapping is reused for identical models.</div>
      <button data-export-vmangos ${this.app.store.records.size ? '' : 'disabled'}>Export custom placements</button>
    </div>`;
    const input = this.panel.querySelector<HTMLInputElement>('[data-vmangos-entry]');
    input?.addEventListener('change', () => {
      if (!this.selected) return;
      const value = Math.max(0, Math.floor(Number(input.value)));
      const modelKey = normalizedModel(this.selected.model);
      if (value) this.entries.set(modelKey, value); else this.entries.delete(modelKey);
      localStorage.setItem('vanillagl-studio:vmangos-entries', JSON.stringify(Object.fromEntries(this.entries)));
    });
    this.panel.querySelector('[data-export-vmangos]')?.addEventListener('click', () => this.export());
  }

  private export() {
    const map = Number(new URLSearchParams(location.search).get('map') ?? 0);
    const added = [...this.app.store.records.values()].filter((record) => record.state === 'added' && record.object.visible);
    const rows: string[] = [];
    const skipped: string[] = [];
    let index = 0;
    for (const record of added) {
      const entry = this.entries.get(normalizedModel(record.model));
      if (!entry) { skipped.push(record.model); continue; }
      record.object.updateWorldMatrix(true, false);
      const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
      record.object.matrixWorld.decompose(position, quaternion, scale);
      const orientation = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ').z;
      rows.push(`(@WOWSER_GUID+${index++}, ${entry}, ${map}, ${position.x.toFixed(5)}, ${position.y.toFixed(5)}, ${position.z.toFixed(5)}, ${orientation.toFixed(7)}, ${quaternion.x.toFixed(7)}, ${quaternion.y.toFixed(7)}, ${quaternion.z.toFixed(7)}, ${quaternion.w.toFixed(7)}, 300, 300, 100, 1, 1, 0, 0, 10)`);
    }
    const header = `-- WowserGL Studio -> vMaNGOS gameobject export\n-- Generated ${new Date().toISOString()}\n-- Schema matches current vmangos/core development gameobject columns.\nSET @WOWSER_GUID := (SELECT COALESCE(MAX(guid), 0) FROM gameobject);\n`;
    const body = rows.length ? `INSERT INTO \`gameobject\` (\`guid\`,\`id\`,\`map\`,\`position_x\`,\`position_y\`,\`position_z\`,\`orientation\`,\`rotation0\`,\`rotation1\`,\`rotation2\`,\`rotation3\`,\`spawntimesecsmin\`,\`spawntimesecsmax\`,\`animprogress\`,\`state\`,\`spawn_flags\`,\`visibility_mod\`,\`patch_min\`,\`patch_max\`) VALUES\n${rows.join(',\n')};\n` : '-- No mapped custom placements were available.\n';
    const tail = skipped.length ? `\n-- Skipped ${skipped.length} placement(s) without a gameobject_template mapping:\n${[...new Set(skipped)].map((model) => `--   ${model}`).join('\n')}\n` : '';
    const blob = new Blob([header + body + tail], { type: 'text/sql' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `wowsergl_vmangos_map_${map}.sql`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}

export function installStudioRefinements(app: EditorApp, root: HTMLElement) {
  installStyles();
  new NeighborhoodStreamer(app, root);
  new MultiSelectionController(app, root);
  new VmangosExporter(app, root);
}
