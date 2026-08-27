import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class EditorCameraController extends EventTarget {
  readonly perspective: THREE.PerspectiveCamera;
  readonly orthographic: THREE.OrthographicCamera;
  readonly orbit: OrbitControls;
  active: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  speed = 35;
  private yaw = Math.PI * 0.75;
  private pitch = -0.35;
  private looking = false;
  private keys = new Set<string>();
  private ortho = false;
  private orbitHeld = false;
  private focusPoint = new THREE.Vector3();

  constructor(private readonly dom: HTMLElement) {
    super();
    this.perspective = new THREE.PerspectiveCamera(60, 1, 0.1, 20000);
    this.perspective.up.set(0, 0, 1);
    this.perspective.position.set(35, 35, 28);
    this.orthographic = new THREE.OrthographicCamera(-100, 100, 100, -100, -10000, 20000);
    this.orthographic.up.set(0, 1, 0);
    this.active = this.perspective;
    this.orbit = new OrbitControls(this.perspective, dom);
    this.orbit.enabled = false;
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.bind();
    this.applyLook();
  }

  resize(width: number, height: number) {
    this.perspective.aspect = width / Math.max(1, height);
    this.perspective.updateProjectionMatrix();
    const aspect = width / Math.max(1, height);
    const half = Math.max(20, this.orthographic.top);
    this.orthographic.left = -half * aspect;
    this.orthographic.right = half * aspect;
    this.orthographic.bottom = -half;
    this.orthographic.top = half;
    this.orthographic.updateProjectionMatrix();
  }

  update(dt: number) {
    if (this.orbit.enabled) {
      this.orbit.update();
      return;
    }
    if (this.ortho) return;
    const move = new THREE.Vector3();
    if (this.keys.has('KeyW')) move.x += 1;
    if (this.keys.has('KeyS')) move.x -= 1;
    if (this.keys.has('KeyD')) move.y += 1;
    if (this.keys.has('KeyA')) move.y -= 1;
    if (this.keys.has('KeyQ')) move.z -= 1;
    if (this.keys.has('KeyE')) move.z += 1;
    if (move.lengthSq() === 0) return;
    move.normalize();
    const forward = new THREE.Vector3(Math.cos(this.yaw), Math.sin(this.yaw), 0);
    const right = new THREE.Vector3(-Math.sin(this.yaw), Math.cos(this.yaw), 0);
    const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 4 : 1;
    this.perspective.position.addScaledVector(forward, move.x * this.speed * boost * dt);
    this.perspective.position.addScaledVector(right, move.y * this.speed * boost * dt);
    this.perspective.position.z += move.z * this.speed * boost * dt;
    this.applyLook();
  }

  focus(object: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) object.getWorldPosition(this.focusPoint);
    else box.getCenter(this.focusPoint);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(2, sphere.radius || 2);
    this.orbit.target.copy(this.focusPoint);
    if (!this.ortho) {
      const direction = new THREE.Vector3().subVectors(this.perspective.position, this.focusPoint).normalize();
      if (!Number.isFinite(direction.x) || direction.lengthSq() < 0.5) direction.set(1, 1, 0.5).normalize();
      this.perspective.position.copy(this.focusPoint).addScaledVector(direction, radius * 2.6);
      this.perspective.lookAt(this.focusPoint);
      this.orbit.update();
    } else {
      this.orthographic.position.copy(this.focusPoint).add(new THREE.Vector3(0, 0, Math.max(500, radius * 6)));
      this.orthographic.lookAt(this.focusPoint);
    }
  }

  toggleTopDown(force?: boolean) {
    this.ortho = force ?? !this.ortho;
    if (this.ortho) {
      this.focusPoint.copy(this.orbit.target);
      this.orthographic.position.set(this.focusPoint.x, this.focusPoint.y, this.focusPoint.z + 1000);
      this.orthographic.lookAt(this.focusPoint);
      this.active = this.orthographic;
      this.orbit.enabled = false;
    } else {
      this.active = this.perspective;
      this.orbit.enabled = this.orbitHeld;
    }
    this.dispatchEvent(new CustomEvent('camera', { detail: this.active }));
    return this.ortho;
  }

  private bind() {
    this.dom.addEventListener('contextmenu', (event) => event.preventDefault());
    this.dom.addEventListener('pointerdown', (event) => {
      if (event.button === 2 && !this.ortho) {
        this.looking = true;
        this.dom.setPointerCapture?.(event.pointerId);
      }
    });
    this.dom.addEventListener('pointerup', (event) => {
      if (event.button === 2) this.looking = false;
    });
    this.dom.addEventListener('pointermove', (event) => {
      if (!this.looking || this.orbit.enabled || this.ortho) return;
      this.yaw -= event.movementX * 0.003;
      this.pitch = THREE.MathUtils.clamp(this.pitch + event.movementY * 0.003, -1.52, 1.52);
      this.applyLook();
    });
    this.dom.addEventListener('wheel', (event) => {
      if (this.ortho) {
        const next = THREE.MathUtils.clamp(this.orthographic.top * Math.exp(event.deltaY * 0.001), 5, 2000);
        const aspect = (this.orthographic.right - this.orthographic.left) / Math.max(1, this.orthographic.top - this.orthographic.bottom);
        this.orthographic.top = next;
        this.orthographic.bottom = -next;
        this.orthographic.left = -next * aspect;
        this.orthographic.right = next * aspect;
        this.orthographic.updateProjectionMatrix();
      } else {
        this.speed = THREE.MathUtils.clamp(this.speed * Math.exp(-event.deltaY * 0.001), 2, 600);
        this.dispatchEvent(new CustomEvent('speed', { detail: this.speed }));
      }
    }, { passive: true });
    window.addEventListener('keydown', (event) => {
      if ((event.target as HTMLElement)?.matches?.('input,textarea,select')) return;
      this.keys.add(event.code);
      if (event.key === 'Alt') {
        this.orbitHeld = true;
        if (!this.ortho) this.orbit.enabled = true;
      }
    });
    window.addEventListener('keyup', (event) => {
      this.keys.delete(event.code);
      if (event.key === 'Alt') {
        this.orbitHeld = false;
        this.orbit.enabled = false;
      }
    });
  }

  private applyLook() {
    const direction = new THREE.Vector3(
      Math.cos(this.pitch) * Math.cos(this.yaw),
      Math.cos(this.pitch) * Math.sin(this.yaw),
      -Math.sin(this.pitch),
    );
    this.perspective.lookAt(this.perspective.position.clone().add(direction));
  }
}
