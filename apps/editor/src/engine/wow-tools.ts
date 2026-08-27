import * as THREE from 'three';
import type { EditorApp } from '../editor-app';
import type { EditorRecord } from '../types';
import type { SceneComponentModel, StudioComponentType } from './component-model';

export class WowWorldTools extends EventTarget {
  pathMode = false;
  private helperRoot = new THREE.Group();
  private selected: EditorRecord | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pathButton: HTMLButtonElement;

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
    app.store.addEventListener('selection', (event) => { this.selected = (event as CustomEvent<EditorRecord | null>).detail; this.rebuildHelpers(); });
    components.addEventListener('change', () => this.rebuildHelpers());
    app.renderer.domElement.addEventListener('pointerdown', (event) => this.pathPointer(event), true);
  }

  togglePathMode(force?: boolean) {
    this.pathMode = force ?? !this.pathMode;
    this.pathButton.classList.toggle('active', this.pathMode);
    this.app.renderer.domElement.style.cursor = this.pathMode ? 'crosshair' : '';
    if (this.pathMode && this.selected) this.ensurePath(this.selected);
    this.dispatchEvent(new CustomEvent('path-mode', { detail: this.pathMode }));
  }

  private add(type: StudioComponentType) {
    const record = this.app.store.selected;
    if (!record) {
      this.app.bottomPanel.log({ level: 'warn', message: `Select a scene object before adding ${type}.`, time: new Date() });
      return;
    }
    this.components.addComponent(record, type);
  }

  private ensurePath(record: EditorRecord) {
    const entity = this.components.entities.get(record.id);
    if (!entity || !this.components.getComponent(entity, 'Path')) this.components.addComponent(record, 'Path');
  }

  private pathPointer(event: PointerEvent) {
    if (!this.pathMode || event.button !== 0 || event.altKey) return;
    const record = this.app.store.selected;
    if (!record) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = this.app.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.app.camera.active);
    const hit = this.raycaster.intersectObjects(this.app.scene.children, true).find((candidate) => candidate.object.userData.editorTerrain);
    if (!hit) return;
    this.ensurePath(record);
    const entity = this.components.entities.get(record.id)!;
    const path = this.components.getComponent(entity, 'Path');
    const before = Array.isArray(path?.data.waypoints) ? structuredClone(path!.data.waypoints) as number[][] : [];
    const after = [...before, hit.point.toArray().map((value) => Number(value.toFixed(4)))];
    this.components.setComponentValue(record, 'Path', 'waypoints', after);
    this.rebuildHelpers();
  }

  private rebuildHelpers() {
    for (const child of [...this.helperRoot.children]) {
      child.removeFromParent();
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      if (mesh.material && !Array.isArray(mesh.material)) mesh.material.dispose();
    }
    const record = this.app.store.selected;
    if (!record) return;
    const entity = this.components.entities.get(record.id);
    if (!entity) return;
    const path = this.components.getComponent(entity, 'Path');
    const points = Array.isArray(path?.data.waypoints) ? (path!.data.waypoints as number[][]).filter((point) => point.length >= 3).map((point) => new THREE.Vector3(point[0], point[1], point[2])) : [];
    if (points.length) {
      const pointGeometry = new THREE.BufferGeometry().setFromPoints(points);
      const pointMaterial = new THREE.PointsMaterial({ size: 0.7, sizeAttenuation: true });
      const pointCloud = new THREE.Points(pointGeometry, pointMaterial);
      pointCloud.userData.editorNonSelectable = true;
      this.helperRoot.add(pointCloud);
      if (points.length > 1) {
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial());
        line.userData.editorNonSelectable = true;
        this.helperRoot.add(line);
      }
    }
    const trigger = this.components.getComponent(entity, 'AreaTrigger');
    if (trigger) {
      const radius = Math.max(0.1, Number(trigger.data.radius ?? 5));
      const height = Math.max(0.1, Number(trigger.data.height ?? 3));
      const shape = String(trigger.data.shape ?? 'cylinder');
      const geometry = shape === 'box' ? new THREE.BoxGeometry(radius * 2, radius * 2, height) : shape === 'sphere' ? new THREE.SphereGeometry(radius, 20, 12) : new THREE.CylinderGeometry(radius, radius, height, 28, 1, true);
      if (shape === 'cylinder') geometry.rotateX(Math.PI / 2);
      const material = new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.55, depthWrite: false });
      const helper = new THREE.Mesh(geometry, material);
      record.object.getWorldPosition(helper.position);
      helper.position.z += shape === 'sphere' ? 0 : height * 0.5;
      helper.userData.editorNonSelectable = true;
      this.helperRoot.add(helper);
    }
  }
}
