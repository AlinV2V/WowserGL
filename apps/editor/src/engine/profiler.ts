import * as THREE from 'three';

export type ProfilerSample = {
  fps: number;
  frameMs: number;
  calls: number;
  triangles: number;
  points: number;
  lines: number;
  geometries: number;
  textures: number;
  programs: number;
  objects: number;
  meshes: number;
  instancedMeshes: number;
  materials: number;
};

export type FrameDrawRecord = { name: string; type: string; triangles: number; instances: number; material: string; textures: number; visible: boolean };

function textureCount(material: THREE.Material) {
  const textures = new Set<string>();
  for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value.uuid);
  if (material instanceof THREE.ShaderMaterial) for (const uniform of Object.values(material.uniforms)) if (uniform?.value instanceof THREE.Texture) textures.add(uniform.value.uuid);
  return textures.size;
}

export class StudioProfiler extends EventTarget {
  sample: ProfilerSample = { fps: 0, frameMs: 0, calls: 0, triangles: 0, points: 0, lines: 0, geometries: 0, textures: 0, programs: 0, objects: 0, meshes: 0, instancedMeshes: 0, materials: 0 };
  history: ProfilerSample[] = [];
  private last = performance.now();
  private frames = 0;
  private frameTotal = 0;
  private previousFrame = performance.now();
  private raf = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene) {
    super();
    this.loop();
  }

  captureFrame(): FrameDrawRecord[] {
    const rows: FrameDrawRecord[] = [];
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh) return;
      const geometry = mesh.geometry;
      const baseTriangles = Math.floor((geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0) / 3);
      const instances = (mesh as THREE.InstancedMesh).isInstancedMesh ? Math.max(1, (mesh as THREE.InstancedMesh).count) : 1;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      rows.push({
        name: object.name || object.userData.editorMeta?.model || object.uuid.slice(0, 8),
        type: (mesh as THREE.InstancedMesh).isInstancedMesh ? 'InstancedMesh' : 'Mesh',
        triangles: baseTriangles * instances,
        instances,
        material: materials.map((material) => material?.type ?? 'None').join(', '),
        textures: materials.reduce((sum, material) => sum + (material ? textureCount(material) : 0), 0),
        visible: object.visible,
      });
    });
    return rows.sort((a, b) => b.triangles - a.triangles);
  }

  dispose() { cancelAnimationFrame(this.raf); }

  private loop = () => {
    const now = performance.now();
    const dt = now - this.previousFrame;
    this.previousFrame = now;
    this.frames++;
    this.frameTotal += dt;
    if (now - this.last >= 500) {
      const materials = new Set<string>();
      let objects = 0, meshes = 0, instancedMeshes = 0;
      this.scene.traverse((object) => {
        objects++;
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) {
          meshes++;
          if ((mesh as THREE.InstancedMesh).isInstancedMesh) instancedMeshes++;
          const list = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
          list.forEach((material) => materials.add(material.uuid));
        }
      });
      const info = this.renderer.info;
      this.sample = {
        fps: this.frames * 1000 / Math.max(1, now - this.last),
        frameMs: this.frameTotal / Math.max(1, this.frames),
        calls: info.render.calls,
        triangles: info.render.triangles,
        points: info.render.points,
        lines: info.render.lines,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: info.programs?.length ?? 0,
        objects,
        meshes,
        instancedMeshes,
        materials: materials.size,
      };
      this.history.push({ ...this.sample });
      if (this.history.length > 120) this.history.shift();
      this.frames = 0;
      this.frameTotal = 0;
      this.last = now;
      this.dispatchEvent(new CustomEvent('sample', { detail: this.sample }));
    }
    this.raf = requestAnimationFrame(this.loop);
  };
}
