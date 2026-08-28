import * as THREE from 'three';
import type { EditorApp } from '../editor-app';
import { isRecordLocked } from '../editor-store';
import type { EditorRecord } from '../types';
import type { SceneComponentModel, StudioComponentType } from './component-model';

export class WowWorldTools extends EventTarget {
  pathMode = false;
  private helperRoot = new THREE.Group();
  private selected: EditorRecord | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pathButton: HTMLButtonElement;
  private activeWaypoint: number | null = null;

  constructor(private readonly app: EditorApp, private readonly root: HTMLElement, private readonly components: SceneComponentModel) {
    super();
    this.helperRoot.name = '__studio_world_tools';
    this.helperRoot.userData.editorNonSelectable = true;
    app.scene.add(this.helperRoot);
    const group = document.createElement('div');
    group.className = 'tool-group wow-world-tools';
    group.innerHTML = `<span class="tool-separator"></span><button data-add-creature title="Add CreatureSpawn component">NPC</button><button data-add-go title="Add GameObjectSpawn component">GO</button><button data-path-tool title="Waypoint Path Tool">Path</button><button data-add-trigger title="Add AreaTrigger component">Trigger</button><button data-add-light title="Add Light component">Light</button><button data-add-collision title="Add Collision component">Collision</button>`;
    root.querySelector('.transform-tools')?.append(group);
    this.pathButton = group.querySelector<HTMLButtonElement>('[data-path-tool]')!;
    group.querySelector('[data-add-creature]')!.addEventListener('click', () => this.add('CreatureSpawn'));
    group.querySelector('[data-add-go]')!.addEventListener('click', () => this.add('GameObjectSpawn'));
    group.querySelector('[data-add-trigger]')!.addEventListener('click', () => this.add('AreaTrigger'));
    group.querySelector('[data-add-light]')!.addEventListener('click', () => this.add('Light'));
    group.querySelector('[data-add-collision]')!.addEventListener('click', () => this.add('Collision'));
    this.pathButton.addEventListener('click', () => this.togglePathMode());
    app.store.addEventListener('selection', (event) => { this.selected = (event as CustomEvent<EditorRecord | null>).detail; this.activeWaypoint = null; this.rebuildHelpers(); this.updateToolAvailability(); });
    app.store.addEventListener('change', () => this.updateToolAvailability());
    components.addEventListener('change', () => this.rebuildHelpers());
    app.renderer.domElement.addEventListener('pointerdown', (event) => this.pathPointer(event), true);
    window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && this.pathMode) { this.activeWaypoint = null; this.togglePathMode(false); } });
    this.updateToolAvailability();
  }

  togglePathMode(force?: boolean) {
    const next = force ?? !this.pathMode;
    if (next && (!this.selected || isRecordLocked(this.selected))) {
      this.app.bottomPanel.log({ level: 'warn', message: this.selected ? 'Unlock the selected object/layer before editing its path.' : 'Select a scene object before entering Path mode.', time: new Date() });
      return;
    }
    this.pathMode = next;
    this.pathButton.classList.toggle('active', this.pathMode);
    this.app.renderer.domElement.style.cursor = this.pathMode ? 'crosshair' : '';
    if (this.pathMode && this.selected) this.ensurePath(this.selected);
    if (!this.pathMode) this.activeWaypoint = null;
    this.rebuildHelpers();
    this.dispatchEvent(new CustomEvent('path-mode', { detail: this.pathMode }));
  }

  private updateToolAvailability() {
    const locked = !this.selected || isRecordLocked(this.selected);
    this.root.querySelectorAll<HTMLButtonElement>('.wow-world-tools button').forEach((button) => { button.disabled = locked; });
    if (locked && this.pathMode) this.togglePathMode(false);
  }

  private add(type: StudioComponentType) {
    const record = this.app.store.selected;
    if (!record) { this.app.bottomPanel.log({ level: 'warn', message: `Select a scene object before adding ${type}.`, time: new Date() }); return; }
    if (isRecordLocked(record)) { this.app.bottomPanel.log({ level: 'warn', message: `Unlock ${record.model} before adding ${type}.`, time: new Date() }); return; }
    this.components.addComponent(record, type);
  }

  private ensurePath(record: EditorRecord) {
    if (isRecordLocked(record)) return;
    const entity = this.components.entities.get(record.id);
    if (!entity || !this.components.getComponent(entity, 'Path')) this.components.addComponent(record, 'Path');
  }

  private pathPointer(event: PointerEvent) {
    if (!this.pathMode || event.button !== 0 || event.altKey) return;
    const record = this.app.store.selected;
    if (!record || isRecordLocked(record)) return;
    const rect = this.app.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.app.camera.active);
    const handleHit = this.raycaster.intersectObjects(this.helperRoot.children, true).find((candidate) => Number.isInteger(candidate.object.userData.studioWaypointIndex));
    if (handleHit) {
      event.preventDefault(); event.stopImmediatePropagation();
      const index = Number(handleHit.object.userData.studioWaypointIndex);
      if (event.shiftKey) this.removeWaypoint(record, index);
      else { this.activeWaypoint = this.activeWaypoint === index ? null : index; this.app.bottomPanel.log({ level: 'info', message: this.activeWaypoint === null ? 'Waypoint move cancelled.' : `Waypoint ${index + 1} selected. Click terrain to move it; Shift-click a handle to delete.`, time: new Date() }); this.rebuildHelpers(); }
      return;
    }
    const hit = this.raycaster.intersectObjects(this.app.scene.children, true).find((candidate) => candidate.object.userData.editorTerrain);
    if (!hit) return;
    event.preventDefault(); event.stopImmediatePropagation();
    this.ensurePath(record);
    const entity = this.components.entities.get(record.id)!;
    const path = this.components.getComponent(entity, 'Path');
    const before = Array.isArray(path?.data.waypoints) ? structuredClone(path!.data.waypoints) as number[][] : [];
    const point = hit.point.toArray().map((value) => Number(value.toFixed(4)));
    const after = [...before];
    if (this.activeWaypoint !== null && after[this.activeWaypoint]) { after[this.activeWaypoint] = point; this.activeWaypoint = null; } else after.push(point);
    this.components.setComponentValue(record, 'Path', 'waypoints', after);
    this.rebuildHelpers();
  }

  private removeWaypoint(record: EditorRecord, index: number) {
    if (isRecordLocked(record)) return;
    const entity = this.components.entities.get(record.id);
    const path = entity ? this.components.getComponent(entity, 'Path') : null;
    const before = Array.isArray(path?.data.waypoints) ? structuredClone(path!.data.waypoints) as number[][] : [];
    if (!before[index]) return;
    before.splice(index, 1); this.activeWaypoint = null; this.components.setComponentValue(record, 'Path', 'waypoints', before); this.rebuildHelpers();
  }

  private rebuildHelpers() {
    for (const child of [...this.helperRoot.children]) this.disposeHelper(child);
    const record = this.app.store.selected;
    if (!record) return;
    const entity = this.components.entities.get(record.id);
    if (!entity) return;
    const path = this.components.getComponent(entity, 'Path');
    const points = Array.isArray(path?.data.waypoints) ? (path!.data.waypoints as number[][]).filter((point) => point.length >= 3).map((point) => new THREE.Vector3(point[0], point[1], point[2])) : [];
    if (points.length) {
      if (points.length > 1) { const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial()); line.userData.editorNonSelectable = true; this.helperRoot.add(line); }
      points.forEach((point, index) => { const geometry = new THREE.SphereGeometry(index === this.activeWaypoint ? 0.72 : 0.48, 12, 8); const material = new THREE.MeshBasicMaterial({ wireframe: index !== this.activeWaypoint, depthTest: false }); const handle = new THREE.Mesh(geometry, material); handle.position.copy(point); handle.renderOrder = 999; handle.userData.editorNonSelectable = true; handle.userData.studioWaypointIndex = index; handle.name = `Waypoint ${index + 1}`; this.helperRoot.add(handle); });
    }
    const creature = this.components.getComponent(entity, 'CreatureSpawn');
    if (creature && String(creature.data.movementMode ?? 'idle') === 'random') {
      const radius = Math.max(0, Number(creature.data.wanderDistance ?? 5));
      if (radius > 0) { const circle: THREE.Vector3[] = []; const center = record.object.getWorldPosition(new THREE.Vector3()); for (let index = 0; index <= 64; index++) { const angle = index / 64 * Math.PI * 2; circle.push(new THREE.Vector3(center.x + Math.cos(angle) * radius, center.y + Math.sin(angle) * radius, center.z + 0.08)); } const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(circle), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.8 })); ring.userData.editorNonSelectable = true; ring.name = `Creature Wander Radius ${radius.toFixed(1)} yd`; this.helperRoot.add(ring); }
    }
    const trigger = this.components.getComponent(entity, 'AreaTrigger');
    if (trigger && trigger.enabled !== false) { const radius = Math.max(0.1, Number(trigger.data.radius ?? 5)); const height = Math.max(0.1, Number(trigger.data.height ?? 3)); const shape = String(trigger.data.shape ?? 'cylinder'); const geometry = shape === 'box' ? new THREE.BoxGeometry(radius * 2, radius * 2, height) : shape === 'sphere' ? new THREE.SphereGeometry(radius, 20, 12) : new THREE.CylinderGeometry(radius, radius, height, 28, 1, true); if (shape === 'cylinder') geometry.rotateX(Math.PI / 2); const helper = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.55, depthWrite: false })); record.object.getWorldPosition(helper.position); helper.position.z += shape === 'sphere' ? 0 : height * 0.5; helper.userData.editorNonSelectable = true; helper.name = 'Area Trigger Volume'; this.helperRoot.add(helper); }
    const light = this.components.getComponent(entity, 'Light');
    if (light && light.enabled !== false) { const radius = Math.max(0.1, Number(light.data.radius ?? 18)); const helper = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 14), new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.2, depthWrite: false })); record.object.getWorldPosition(helper.position); helper.userData.editorNonSelectable = true; helper.name = 'Light Radius'; this.helperRoot.add(helper); }
    const collision = this.components.getComponent(entity, 'Collision');
    if (collision && collision.enabled !== false && collision.data.enabled !== false && collision.data.mode !== 'none' && collision.data.debug === true) { const helper = new THREE.BoxHelper(record.object); helper.userData.editorNonSelectable = true; helper.name = 'Collision Bounds'; this.helperRoot.add(helper); }
    const portal = this.components.getComponent(entity, 'Portal');
    if (portal && portal.enabled !== false && portal.data.enabled !== false) { const center = new THREE.Box3().setFromObject(record.object).getCenter(new THREE.Vector3()); const helper = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), center, 6, undefined, 1.3, 0.7); helper.userData.editorNonSelectable = true; helper.name = `Portal ${portal.data.groupA ?? 0} → ${portal.data.groupB ?? 0}`; this.helperRoot.add(helper); }
  }

  private disposeHelper(child: THREE.Object3D) {
    child.traverse((object) => { const renderable = object as THREE.Mesh; renderable.geometry?.dispose(); const materials = renderable.material ? (Array.isArray(renderable.material) ? renderable.material : [renderable.material]) : []; materials.forEach((material) => material.dispose()); });
    child.removeFromParent();
  }
}
