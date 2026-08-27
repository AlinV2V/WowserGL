import * as THREE from 'three';
import type { EnvironmentState } from './types';

export type LightCurveSample = {
  ambient: THREE.ColorRepresentation;
  sun: THREE.ColorRepresentation;
  fog: THREE.ColorRepresentation;
  sunDirection: THREE.Vector3;
};

export type LightCurveProvider = (hour: number) => LightCurveSample;

const defaultCurve: LightCurveProvider = (hour) => {
  const angle = ((hour - 6) / 24) * Math.PI * 2;
  const altitude = Math.sin(angle);
  const daylight = THREE.MathUtils.clamp(altitude * 1.8 + 0.18, 0.08, 1);
  const warm = THREE.MathUtils.clamp(1 - Math.abs(altitude) * 4, 0, 1);
  const ambient = new THREE.Color(0x5e7590).multiplyScalar(0.25 + daylight * 0.7);
  const sun = new THREE.Color(0xffffff).lerp(new THREE.Color(0xffb46b), warm * 0.65).multiplyScalar(0.2 + daylight * 0.9);
  const fog = new THREE.Color(0x607992).multiplyScalar(0.35 + daylight * 0.65);
  const sunDirection = new THREE.Vector3(Math.cos(angle), 0.35, Math.sin(angle)).normalize();
  return { ambient, sun, fog, sunDirection };
};

export class EditorEnvironment extends EventTarget {
  readonly hemisphere: THREE.HemisphereLight;
  readonly sun: THREE.DirectionalLight;
  readonly precipitation = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ size: 0.12, transparent: true, opacity: 0.75 }),
  );
  state: EnvironmentState = {
    hour: 12,
    fogNear: 220,
    fogFar: 1100,
    fogColor: '#70859a',
    weather: 'clear',
  };
  private curve: LightCurveProvider = defaultCurve;
  private precipitationVelocity = new Float32Array();
  private controls: HTMLElement | null = null;

  constructor(private readonly scene: THREE.Scene) {
    super();
    this.hemisphere = new THREE.HemisphereLight(0xc9d7e5, 0x343228, 1.2);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.castShadow = false;
    this.precipitation.frustumCulled = false;
    this.precipitation.userData.editorNonSelectable = true;
    scene.add(this.hemisphere, this.sun, this.precipitation);
    this.apply();
  }

  setLightCurveProvider(provider: LightCurveProvider) {
    this.curve = provider;
    this.apply();
  }

  setHour(hour: number) {
    this.state.hour = ((hour % 24) + 24) % 24;
    this.apply();
    this.syncControls();
  }

  setFog(near: number, far: number, color = this.state.fogColor) {
    this.state.fogNear = Math.max(0, near);
    this.state.fogFar = Math.max(this.state.fogNear + 1, far);
    this.state.fogColor = color;
    this.apply();
    this.syncControls();
  }

  setWeather(weather: EnvironmentState['weather']) {
    this.state.weather = weather;
    this.rebuildWeather();
    this.syncControls();
    this.changed();
  }

  update(dt: number, focus: THREE.Vector3) {
    if (this.state.weather === 'clear') return;
    const positions = this.precipitation.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!positions) return;
    this.precipitation.position.set(focus.x, focus.y, focus.z + 20);
    for (let i = 0; i < positions.count; i++) {
      let z = positions.getZ(i) + this.precipitationVelocity[i] * dt;
      if (z < -20) z = 45 + Math.random() * 15;
      positions.setZ(i, z);
      if (this.state.weather === 'snow') positions.setX(i, positions.getX(i) + Math.sin(performance.now() * 0.001 + i) * dt * 0.25);
    }
    positions.needsUpdate = true;
  }

  mountControls(container: HTMLElement) {
    this.controls = container;
    container.innerHTML = `
      <section class="component-card environment-component">
        <div class="component-head"><span class="component-toggle">▾</span><strong>Environment</strong><span class="component-badge">Live</span></div>
        <div class="component-body">
          <div class="unity-property"><span>Time of Day</span><div class="property-control time-control"><input data-time type="range" min="0" max="24" step="0.05" value="12" /><output data-hour>12:00</output></div></div>
          <div class="unity-property"><span>Fog Distance</span><div class="property-control dual-input"><input data-fog-near type="number" value="220" step="10" /><input data-fog-far type="number" value="1100" step="10" /></div></div>
          <div class="unity-property"><span>Fog Color</span><div class="property-control"><input data-fog-color type="color" value="#70859a" /></div></div>
          <div class="unity-property"><span>Weather</span><div class="property-control"><select data-weather><option value="clear">Clear</option><option value="rain">Rain</option><option value="snow">Snow</option></select></div></div>
          <div class="component-help">When Live Sync is enabled these values are sent to VanillaGL immediately. Game time uses VanillaGL's own <code>wowTune</code>/Light.dbc path when the runtime receiver is active.</div>
        </div>
      </section>`;
    const time = container.querySelector<HTMLInputElement>('[data-time]')!;
    const near = container.querySelector<HTMLInputElement>('[data-fog-near]')!;
    const far = container.querySelector<HTMLInputElement>('[data-fog-far]')!;
    const color = container.querySelector<HTMLInputElement>('[data-fog-color]')!;
    const weather = container.querySelector<HTMLSelectElement>('[data-weather]')!;
    time.addEventListener('input', () => this.setHour(Number(time.value)));
    const updateFog = () => this.setFog(Number(near.value), Number(far.value), color.value);
    near.addEventListener('change', updateFog);
    far.addEventListener('change', updateFog);
    color.addEventListener('input', updateFog);
    weather.addEventListener('change', () => this.setWeather(weather.value as EnvironmentState['weather']));
    this.syncControls();
  }

  private syncControls() {
    if (!this.controls) return;
    const time = this.controls.querySelector<HTMLInputElement>('[data-time]');
    const hour = this.controls.querySelector<HTMLOutputElement>('[data-hour]');
    const near = this.controls.querySelector<HTMLInputElement>('[data-fog-near]');
    const far = this.controls.querySelector<HTMLInputElement>('[data-fog-far]');
    const color = this.controls.querySelector<HTMLInputElement>('[data-fog-color]');
    const weather = this.controls.querySelector<HTMLSelectElement>('[data-weather]');
    if (time && document.activeElement !== time) time.value = String(this.state.hour);
    if (hour) {
      const h = Math.floor(this.state.hour);
      const m = Math.floor((this.state.hour - h) * 60);
      hour.value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    if (near && document.activeElement !== near) near.value = String(this.state.fogNear);
    if (far && document.activeElement !== far) far.value = String(this.state.fogFar);
    if (color && document.activeElement !== color) color.value = this.state.fogColor;
    if (weather) weather.value = this.state.weather;
  }

  private apply() {
    const sample = this.curve(this.state.hour);
    this.hemisphere.color.set(sample.ambient);
    this.hemisphere.groundColor.set(0x282821);
    this.hemisphere.intensity = 1.25;
    this.sun.color.set(sample.sun);
    this.sun.position.copy(sample.sunDirection).multiplyScalar(800);
    this.sun.intensity = 2.1;
    const fogColor = new THREE.Color(this.state.fogColor).lerp(new THREE.Color(sample.fog), 0.55);
    this.scene.background = fogColor.clone();
    this.scene.fog = new THREE.Fog(fogColor, this.state.fogNear, this.state.fogFar);
    this.changed();
  }

  private rebuildWeather() {
    if (this.state.weather === 'clear') {
      this.precipitation.visible = false;
      return;
    }
    const count = this.state.weather === 'rain' ? 1600 : 900;
    const positions = new Float32Array(count * 3);
    this.precipitationVelocity = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 90;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 90;
      positions[i * 3 + 2] = Math.random() * 65 - 20;
      this.precipitationVelocity[i] = this.state.weather === 'rain' ? -(28 + Math.random() * 22) : -(2 + Math.random() * 3);
    }
    this.precipitation.geometry.dispose();
    this.precipitation.geometry = new THREE.BufferGeometry();
    this.precipitation.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = this.precipitation.material as THREE.PointsMaterial;
    material.size = this.state.weather === 'rain' ? 0.08 : 0.22;
    material.opacity = this.state.weather === 'rain' ? 0.55 : 0.8;
    this.precipitation.visible = true;
  }

  private changed() {
    this.dispatchEvent(new CustomEvent<EnvironmentState>('change', { detail: { ...this.state } }));
  }
}
