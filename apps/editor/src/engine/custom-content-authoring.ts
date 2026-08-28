import * as THREE from 'three';
import type { EditorApp } from '../editor-app';
import { liveTargetFor } from '../editor-live-bridge';
import type { StudioBehaviorPreview, StudioBehaviorWaypoint, StudioCharacterPreview, StudioLightPreview } from '../live-protocol';
import type { EditorRecord, MaterialOverride } from '../types';
import type { SceneComponentModel } from './component-model';
import type { StudioPluginHost } from './plugin-host';
import type { ProjectWorkspace } from './project-workspace';
import type { StudioSimulationClock } from './simulation-clock';
import type { TerrainAuthoring, TerrainTilePatch } from './terrain-authoring';

export type BehaviorAction = {
  id: string;
  trigger: 'onSpawn' | 'playerNear' | 'combatStart' | 'healthBelow' | 'waypoint' | 'timer';
  action: 'say' | 'emote' | 'cast' | 'face' | 'wait' | 'flee' | 'assist' | 'returnHome';
  value: string;
};

export type CustomBehaviorProfile = {
  mode: 'idle' | 'wander' | 'waypoints' | 'guard';
  speed: number;
  wanderDistance: number;
  aggroRadius: number;
  leashRadius: number;
  loop: boolean;
  actions: BehaviorAction[];
};

export type CharacterAuthoringProfile = StudioCharacterPreview & {
  name: string;
  customSkinTexture?: string;
  customHairTexture?: string;
};

export type QuestAuthoringProfile = {
  enabled: boolean;
  questId: number;
  title: string;
  details: string;
  objectives: string;
  rewards: string;
  prerequisiteQuest: number;
  nextQuest: number;
  gossipText: string;
};

export type InteractionProfile = {
  type: 'none' | 'door' | 'chest' | 'quest' | 'portal' | 'chair' | 'gather' | 'scripted';
  scriptHook: string;
  targetMap: number;
  targetX: number;
  targetY: number;
  targetZ: number;
};

export type CustomEntityProfile = {
  id: string;
  tileKey: string;
  kind: EditorRecord['kind'];
  model: string;
  sourceId?: string | number;
  anchor: [number, number, number];
  behavior: CustomBehaviorProfile;
  character: CharacterAuthoringProfile;
  quest: QuestAuthoringProfile;
  interaction: InteractionProfile;
};

export type MaterialVariant = {
  id: string;
  name: string;
  model: string;
  createdAt: string;
  overrides: MaterialOverride[];
};

export type CustomWorldPackage = {
  version: 1;
  format: 'vanillagl-custom-content';
  createdAt: string;
  project: { name: string; mapId: number; tileKey: string };
  entities: CustomEntityProfile[];
  materialVariants: MaterialVariant[];
  terrain: TerrainTilePatch[];
  notes: string[];
};

const STORAGE = 'wowsergl:custom-world:v1';
const uuid = () => crypto.randomUUID?.() ?? `content-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const normalized = (value: string) => value.replaceAll('\\', '/').toLowerCase();
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const asNumber = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

const defaultBehavior = (): CustomBehaviorProfile => ({ mode: 'idle', speed: 2.5, wanderDistance: 5, aggroRadius: 20, leashRadius: 45, loop: true, actions: [] });
const defaultCharacter = (): CharacterAuthoringProfile => ({
  name: 'Custom Character', race: 1, classId: 1, gender: 0, skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0,
  level: 1, animationId: 0, scale: 1, equipment: [],
});
const defaultQuest = (): QuestAuthoringProfile => ({ enabled: false, questId: 0, title: '', details: '', objectives: '[]', rewards: '[]', prerequisiteQuest: 0, nextQuest: 0, gossipText: '' });
const defaultInteraction = (): InteractionProfile => ({ type: 'none', scriptHook: '', targetMap: 0, targetX: 0, targetY: 0, targetZ: 0 });

export class CustomWorldAuthoring extends EventTarget {
  private profiles: CustomEntityProfile[] = [];
  private variants: MaterialVariant[] = [];
  private panel: HTMLElement | null = null;
  private behaviorMarkers = new Map<string, { object: THREE.Mesh; elapsed: number; segment: number; wait: number }>();

  constructor(
    private readonly app: EditorApp,
    private readonly components: SceneComponentModel,
    private readonly workspace: ProjectWorkspace,
    private readonly simulation: StudioSimulationClock,
    private readonly terrain: TerrainAuthoring,
    private readonly plugins: StudioPluginHost,
  ) {
    super();
    this.load();
    plugins.activate({
      id: 'builtin-custom-world-authoring',
      name: 'Custom World Authoring',
      version: '1.0.0',
      activate: ({ registerToolTab, registerValidator, registerCommand }) => {
        registerToolTab({ id: 'content', label: 'Content', render: (host) => this.render(host) });
        registerValidator(() => this.validate());
        registerCommand({ id: 'export-package', label: 'Export Custom Content Package', execute: () => this.exportPackage() });
        registerCommand({ id: 'push-preview', label: 'Push Custom Content Preview', execute: () => this.pushSelectedPreview() });
      },
    });
    app.store.addEventListener('selection', () => this.renderCurrent());
    app.store.addEventListener('change', () => this.persist());
    terrain.addEventListener('change', () => this.persist());
    simulation.addEventListener('tick', (event) => this.updateBehaviorMarkers((event as CustomEvent<{ dt: number }>).detail.dt));
  }

  package(): CustomWorldPackage {
    const params = new URLSearchParams(location.search);
    return {
      version: 1,
      format: 'vanillagl-custom-content',
      createdAt: new Date().toISOString(),
      project: { name: this.workspace.name, mapId: Number(params.get('map') ?? 0), tileKey: this.app.store.tileKey },
      entities: this.profiles.map((profile) => structuredClone(profile)),
      materialVariants: this.variants.map((variant) => structuredClone(variant)),
      terrain: this.terrain.snapshot(),
      notes: [
        'Transforms/material overrides still use custom_map_patch.json/live project.',
        'Terrain deltas are package-backed and are not hot-applied to CleanClientMMO yet.',
        'Behavior metadata beyond vMaNGOS waypoint/random movement requires a server script/compiler consumer.',
        'Character preview data uses CleanClientMMO baked character rendering through the Studio runtime extension.',
      ],
    };
  }

  exportPackage() {
    const payload = this.package();
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${this.workspace.name.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase() || 'custom_world'}.vanillagl-content.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    this.app.bottomPanel.log({ level: 'info', message: `Exported custom content package with ${payload.entities.length} authored entities, ${payload.materialVariants.length} material variants and ${payload.terrain.length} terrain tile patches.`, time: new Date() });
  }

  private selectedProfile(create = true) {
    const record = this.app.store.selected;
    if (!record) return null;
    let profile = this.findProfile(record);
    if (!profile && create) {
      const world = record.object.getWorldPosition(new THREE.Vector3());
      profile = {
        id: uuid(), tileKey: record.tileKey, kind: record.kind, model: record.model, sourceId: record.sourceId,
        anchor: world.toArray() as [number, number, number],
        behavior: defaultBehavior(), character: defaultCharacter(), quest: defaultQuest(), interaction: defaultInteraction(),
      };
      this.profiles.push(profile);
      this.persist();
    }
    return profile;
  }

  private findProfile(record: EditorRecord) {
    if (record.sourceId !== undefined) return this.profiles.find((profile) => profile.tileKey === record.tileKey && profile.kind === record.kind && profile.sourceId !== undefined && String(profile.sourceId) === String(record.sourceId) && normalized(profile.model) === normalized(record.model)) ?? null;
    const position = record.object.getWorldPosition(new THREE.Vector3());
    let best: { profile: CustomEntityProfile; distance: number } | null = null;
    for (const profile of this.profiles) {
      if (profile.tileKey !== record.tileKey || profile.kind !== record.kind || normalized(profile.model) !== normalized(record.model) || profile.sourceId !== undefined) continue;
      const distance = position.distanceTo(new THREE.Vector3().fromArray(profile.anchor));
      if (distance <= 3 && (!best || distance < best.distance)) best = { profile, distance };
    }
    return best?.profile ?? null;
  }

  private captureVariant(record: EditorRecord, name: string) {
    const overrides = this.app.materialInspector.getOverrides().filter((override) => override.recordId === record.id || (override.scope === 'asset' && normalized(override.model) === normalized(record.model)));
    if (!overrides.length) {
      this.app.bottomPanel.log({ level: 'warn', message: 'No material overrides exist on this object. Change a material first, then capture a variant.', time: new Date() });
      return;
    }
    const variant: MaterialVariant = { id: uuid(), name: name.trim() || `${record.model.split(/[\\/]/).pop() || 'Asset'} Variant`, model: record.model, createdAt: new Date().toISOString(), overrides: overrides.map((override) => structuredClone(override)) };
    this.variants.push(variant);
    this.persist();
    this.app.bottomPanel.log({ level: 'info', message: `Captured material variant “${variant.name}” with ${variant.overrides.length} slots.`, time: new Date() });
  }

  private applyVariant(record: EditorRecord, variant: MaterialVariant, push: boolean) {
    for (const source of variant.overrides) {
      const override: MaterialOverride = {
        ...structuredClone(source),
        id: `variant:${variant.id}:${record.id}:${source.locator.slot}`,
        recordId: record.id,
        tileKey: record.tileKey,
        kind: record.kind,
        model: record.model,
        sourceId: record.sourceId,
        scope: 'instance',
      };
      this.app.materialInspector.applyOverride(record, override);
      if (push) this.app.bridge.pushMaterial(record, override);
    }
    this.app.bottomPanel.log({ level: 'info', message: `${push ? 'Applied and pushed' : 'Applied'} material variant “${variant.name}”.`, time: new Date() });
  }

  private duplicateVariant(record: EditorRecord, variant: MaterialVariant) {
    if (record.object.userData.studioLocked || record.object.userData.studioLayerLocked) {
      this.app.bottomPanel.log({ level: 'warn', message: 'Unlock the selected object/layer before duplicating a variant.', time: new Date() });
      return;
    }
    const copy = this.app.store.duplicate(record, record.object.position.clone().add(new THREE.Vector3(2, 2, 0)));
    this.applyVariant(copy, variant, this.app.bridge.runtimes > 0);
  }

  private behaviorFor(record: EditorRecord, profile: CustomEntityProfile): StudioBehaviorPreview {
    const entity = this.components.entities.get(record.id);
    const path = entity ? this.components.getComponent(entity, 'Path') : null;
    const raw = Array.isArray(path?.data.waypoints) ? path!.data.waypoints as unknown[] : [];
    const waypoints: StudioBehaviorWaypoint[] = raw.flatMap((entry) => {
      if (Array.isArray(entry) && entry.length >= 3) return [{ x: asNumber(entry[0]), y: asNumber(entry[1]), z: asNumber(entry[2]), speed: profile.behavior.speed }];
      if (entry && typeof entry === 'object') {
        const point = entry as Record<string, unknown>;
        return [{ x: asNumber(point.x), y: asNumber(point.y), z: asNumber(point.z), waitMs: asNumber(point.waitMs), speed: asNumber(point.speed, profile.behavior.speed), orientation: point.orientation === undefined ? undefined : asNumber(point.orientation), emoteId: point.emoteId === undefined ? undefined : asNumber(point.emoteId) }];
      }
      return [];
    });
    return { ...structuredClone(profile.behavior), waypoints };
  }

  private pushSelectedPreview() {
    const record = this.app.store.selected;
    const profile = this.selectedProfile(false);
    if (!record || !profile) return;
    this.app.bridge.previewBehavior(record, this.behaviorFor(record, profile));
    const entity = this.components.entities.get(record.id);
    const light = entity ? this.components.getComponent(entity, 'Light') : null;
    if (light) {
      const spec: StudioLightPreview = { enabled: light.enabled !== false, color: String(light.data.color ?? '#ffffff'), intensity: asNumber(light.data.intensity, 1), radius: asNumber(light.data.radius, 18) };
      this.app.bridge.previewLight(record, spec);
    }
  }

  private startStudioBehavior(record: EditorRecord, profile: CustomEntityProfile) {
    this.stopStudioBehavior(record.id);
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 10), new THREE.MeshBasicMaterial({ wireframe: true, depthTest: false }));
    marker.name = '__studio_behavior_preview';
    marker.renderOrder = 1000;
    marker.userData.editorNonSelectable = true;
    marker.position.copy(record.object.getWorldPosition(new THREE.Vector3()));
    this.app.scene.add(marker);
    this.behaviorMarkers.set(record.id, { object: marker, elapsed: 0, segment: 0, wait: 0 });
  }

  private stopStudioBehavior(recordId: string) {
    const preview = this.behaviorMarkers.get(recordId);
    if (!preview) return;
    preview.object.geometry.dispose();
    (preview.object.material as THREE.Material).dispose();
    preview.object.removeFromParent();
    this.behaviorMarkers.delete(recordId);
  }

  private updateBehaviorMarkers(dt: number) {
    for (const [recordId, preview] of this.behaviorMarkers) {
      const record = this.app.store.records.get(recordId);
      if (!record) { this.stopStudioBehavior(recordId); continue; }
      const profile = this.findProfile(record);
      if (!profile) continue;
      preview.elapsed += dt;
      const spec = this.behaviorFor(record, profile);
      if (spec.mode === 'idle' || spec.mode === 'guard') {
        preview.object.position.copy(record.object.getWorldPosition(new THREE.Vector3()));
        continue;
      }
      if (spec.mode === 'wander') {
        const center = record.object.getWorldPosition(new THREE.Vector3());
        const radius = Math.max(0.25, spec.wanderDistance);
        preview.object.position.set(center.x + Math.cos(preview.elapsed * spec.speed / radius) * radius, center.y + Math.sin(preview.elapsed * spec.speed / radius) * radius, center.z + 0.5);
        continue;
      }
      if (spec.waypoints.length < 2) continue;
      const a = spec.waypoints[preview.segment % spec.waypoints.length];
      const b = spec.waypoints[(preview.segment + 1) % spec.waypoints.length];
      const av = new THREE.Vector3(a.x, a.y, a.z + 0.5), bv = new THREE.Vector3(b.x, b.y, b.z + 0.5);
      const distance = Math.max(0.001, av.distanceTo(bv));
      const speed = Math.max(0.1, b.speed ?? spec.speed);
      const duration = distance / speed;
      const t = Math.min(1, preview.elapsed / duration);
      preview.object.position.lerpVectors(av, bv, t);
      if (t >= 1) {
        preview.segment++;
        preview.elapsed = 0;
        if (!spec.loop && preview.segment >= spec.waypoints.length - 1) this.stopStudioBehavior(recordId);
      }
    }
  }

  private render(host: HTMLElement) {
    this.panel = host;
    const record = this.app.store.selected;
    if (!record) {
      host.innerHTML = '<div class="bottom-empty">Select a scene object to author custom Vanilla content.</div>';
      return;
    }
    const profile = this.selectedProfile()!;
    const modelVariants = this.variants.filter((variant) => normalized(variant.model) === normalized(record.model));
    const behavior = profile.behavior;
    const character = profile.character;
    const quest = profile.quest;
    const interaction = profile.interaction;
    host.innerHTML = `<div class="engine-tool-header"><strong>Custom World Authoring</strong><span>${escapeHtml(record.model)} · package v1</span><div><button data-content-preview class="accent">Push Preview</button><button data-content-export>Export Package</button></div></div>
      <div class="custom-author-grid custom-content-grid">
      <section><h3>Building / Material Variants</h3><div class="project-actions"><input data-variant-name placeholder="Red Roof House"/><button data-capture-variant>Capture Current Materials</button></div>${modelVariants.map((variant) => `<div class="content-variant" data-variant="${variant.id}"><b>${escapeHtml(variant.name)}</b><span>${variant.overrides.length} slots</span><button data-variant-apply>Apply</button><button data-variant-push>Push</button><button data-variant-duplicate>Duplicate Variant</button><button data-variant-remove>×</button></div>`).join('') || '<p>No saved material variants for this asset yet.</p>'}<p>Use Renderer / Materials in Inspector for tint/texture changes, then capture them here as reusable building variants.</p></section>
      <section><h3>NPC / Monster Behavior</h3><label>Mode <select data-behavior-mode><option value="idle">Idle</option><option value="wander">Random Wander</option><option value="waypoints">Waypoint Patrol</option><option value="guard">Guard Position</option></select></label><label>Speed <input data-behavior-speed type="number" min="0.1" step="0.1" value="${behavior.speed}"/></label><label>Wander radius <input data-behavior-wander type="number" min="0" step="0.5" value="${behavior.wanderDistance}"/></label><label>Aggro radius <input data-behavior-aggro type="number" min="0" step="0.5" value="${behavior.aggroRadius}"/></label><label>Leash radius <input data-behavior-leash type="number" min="1" step="1" value="${behavior.leashRadius}"/></label><label><input data-behavior-loop type="checkbox" ${behavior.loop ? 'checked' : ''}/> Loop patrol</label><div class="project-actions"><button data-behavior-studio>Preview in Scene</button><button data-behavior-stop>Stop Preview</button><button data-behavior-game>Preview in Game</button></div><h4>Behavior actions</h4><div data-behavior-actions>${behavior.actions.map((action) => `<div class="behavior-action" data-action-id="${action.id}"><span>${action.trigger}</span><b>${action.action}</b><span>${escapeHtml(action.value)}</span><button>×</button></div>`).join('') || '<p>No scripted actions. Movement still works independently.</p>'}</div><div class="behavior-add"><select data-action-trigger>${['onSpawn','playerNear','combatStart','healthBelow','waypoint','timer'].map((value) => `<option>${value}</option>`).join('')}</select><select data-action-type>${['say','emote','cast','face','wait','flee','assist','returnHome'].map((value) => `<option>${value}</option>`).join('')}</select><input data-action-value placeholder="text / spell / parameter"/><button data-action-add>Add</button></div><p>Waypoint positions come from the existing Path tool. Scripted actions are compiled into the custom content package for a server behavior consumer.</p></section>
      <section><h3>Player / Humanoid Character</h3><label>Name <input data-char-name value="${escapeHtml(character.name)}"/></label><div class="character-grid"><label>Race <input data-char-race type="number" min="1" max="8" value="${character.race}"/></label><label>Class <input data-char-class type="number" min="1" max="11" value="${character.classId}"/></label><label>Gender <select data-char-gender><option value="0">Male</option><option value="1">Female</option></select></label><label>Skin <input data-char-skin type="number" min="0" value="${character.skin}"/></label><label>Face <input data-char-face type="number" min="0" value="${character.face}"/></label><label>Hair Style <input data-char-hair type="number" min="0" value="${character.hairStyle}"/></label><label>Hair Color <input data-char-hair-color type="number" min="0" value="${character.hairColor}"/></label><label>Facial Hair <input data-char-facial type="number" min="0" value="${character.facialHair}"/></label><label>Level <input data-char-level type="number" min="1" max="60" value="${character.level}"/></label><label>Animation ID <input data-char-animation type="number" min="0" value="${character.animationId ?? 0}"/></label><label>Scale <input data-char-scale type="number" min="0.1" step="0.05" value="${character.scale ?? 1}"/></label></div><label>Equipment JSON <textarea data-char-equipment rows="5">${escapeHtml(JSON.stringify(character.equipment, null, 2))}</textarea></label><label>Custom body texture <input data-char-skin-texture value="${escapeHtml(character.customSkinTexture ?? '')}" placeholder="project texture path"/></label><label>Custom hair texture <input data-char-hair-texture value="${escapeHtml(character.customHairTexture ?? '')}" placeholder="project texture path"/></label><div class="project-actions"><button data-char-preview class="accent">Preview in CleanClient</button><button data-char-clear>Clear Preview</button></div><p>Appearance fields match CleanClientMMO's real CharacterInfo/model-compositing pipeline. Custom texture paths are package metadata until the production character compositor exposes those override slots.</p></section>
      <section><h3>Quest / Dialogue</h3><label><input data-quest-enabled type="checkbox" ${quest.enabled ? 'checked' : ''}/> Quest giver content enabled</label><label>Quest ID <input data-quest-id type="number" min="0" value="${quest.questId}"/></label><label>Title <input data-quest-title value="${escapeHtml(quest.title)}"/></label><label>Gossip <textarea data-quest-gossip rows="3">${escapeHtml(quest.gossipText)}</textarea></label><label>Details <textarea data-quest-details rows="4">${escapeHtml(quest.details)}</textarea></label><label>Objectives JSON <textarea data-quest-objectives rows="4">${escapeHtml(quest.objectives)}</textarea></label><label>Rewards JSON <textarea data-quest-rewards rows="4">${escapeHtml(quest.rewards)}</textarea></label><label>Prerequisite <input data-quest-prev type="number" min="0" value="${quest.prerequisiteQuest}"/></label><label>Next quest <input data-quest-next type="number" min="0" value="${quest.nextQuest}"/></label><p>Quest/dialogue authoring is validated and packaged; it does not claim direct vMaNGOS quest-table mutation yet.</p></section>
      <section><h3>GameObject Interaction</h3><label>Type <select data-interaction-type>${['none','door','chest','quest','portal','chair','gather','scripted'].map((value) => `<option value="${value}">${value}</option>`).join('')}</select></label><label>Script Hook <input data-interaction-script value="${escapeHtml(interaction.scriptHook)}"/></label><label>Portal Map <input data-interaction-map type="number" min="0" value="${interaction.targetMap}"/></label><label>Target X <input data-interaction-x type="number" step="0.1" value="${interaction.targetX}"/></label><label>Target Y <input data-interaction-y type="number" step="0.1" value="${interaction.targetY}"/></label><label>Target Z <input data-interaction-z type="number" step="0.1" value="${interaction.targetZ}"/></label><p>Interaction metadata travels in the custom package; normal GameObject placement still exports through the vMaNGOS SQL component.</p></section>
      <section><h3>Pipeline Status</h3><p><strong>Live now:</strong> transforms, spawn/delete, material tint/texture, environment, custom light preview, behavior path preview, character appearance preview.</p><p><strong>Server SQL now:</strong> Creature/GameObject placement and idle/random/waypoint movement.</p><p><strong>Package now:</strong> material variants, terrain sculpt deltas, advanced behaviors, character definitions, quests/dialogue, interactions and custom texture references.</p><p><strong>Intentionally not faked:</strong> direct quest DB mutation, arbitrary AI script execution, custom character texture injection, and live terrain patching.</p></section></div>`;

    this.bindPanel(record, profile, modelVariants);
  }

  private bindPanel(record: EditorRecord, profile: CustomEntityProfile, variants: MaterialVariant[]) {
    const host = this.panel!;
    const input = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector: string) => host.querySelector<T>(selector)!;
    input<HTMLSelectElement>('[data-behavior-mode]').value = profile.behavior.mode;
    input<HTMLSelectElement>('[data-char-gender]').value = String(profile.character.gender);
    input<HTMLSelectElement>('[data-interaction-type]').value = profile.interaction.type;
    const save = () => { this.persist(); this.renderCurrent(); };
    const number = (selector: string, apply: (value: number) => void) => input<HTMLInputElement>(selector).addEventListener('change', () => { apply(asNumber(input<HTMLInputElement>(selector).value)); save(); });
    const text = (selector: string, apply: (value: string) => void) => input<HTMLInputElement | HTMLTextAreaElement>(selector).addEventListener('change', () => { apply(input<HTMLInputElement | HTMLTextAreaElement>(selector).value); save(); });

    host.querySelector('[data-content-preview]')!.addEventListener('click', () => this.pushSelectedPreview());
    host.querySelector('[data-content-export]')!.addEventListener('click', () => this.exportPackage());
    host.querySelector('[data-capture-variant]')!.addEventListener('click', () => { this.captureVariant(record, input<HTMLInputElement>('[data-variant-name]').value); this.renderCurrent(); });
    for (const variant of variants) {
      const row = host.querySelector<HTMLElement>(`[data-variant="${variant.id}"]`)!;
      row.querySelector('[data-variant-apply]')!.addEventListener('click', () => this.applyVariant(record, variant, false));
      row.querySelector('[data-variant-push]')!.addEventListener('click', () => this.applyVariant(record, variant, true));
      row.querySelector('[data-variant-duplicate]')!.addEventListener('click', () => this.duplicateVariant(record, variant));
      row.querySelector('[data-variant-remove]')!.addEventListener('click', () => { this.variants = this.variants.filter((item) => item.id !== variant.id); save(); });
    }

    input<HTMLSelectElement>('[data-behavior-mode]').addEventListener('change', () => { profile.behavior.mode = input<HTMLSelectElement>('[data-behavior-mode]').value as CustomBehaviorProfile['mode']; save(); });
    number('[data-behavior-speed]', (value) => profile.behavior.speed = Math.max(0.1, value));
    number('[data-behavior-wander]', (value) => profile.behavior.wanderDistance = Math.max(0, value));
    number('[data-behavior-aggro]', (value) => profile.behavior.aggroRadius = Math.max(0, value));
    number('[data-behavior-leash]', (value) => profile.behavior.leashRadius = Math.max(1, value));
    input<HTMLInputElement>('[data-behavior-loop]').addEventListener('change', () => { profile.behavior.loop = input<HTMLInputElement>('[data-behavior-loop]').checked; save(); });
    host.querySelector('[data-behavior-studio]')!.addEventListener('click', () => this.startStudioBehavior(record, profile));
    host.querySelector('[data-behavior-stop]')!.addEventListener('click', () => { this.stopStudioBehavior(record.id); this.app.bridge.stopBehavior(record); });
    host.querySelector('[data-behavior-game]')!.addEventListener('click', () => this.app.bridge.previewBehavior(record, this.behaviorFor(record, profile)));
    host.querySelector('[data-action-add]')!.addEventListener('click', () => {
      profile.behavior.actions.push({ id: uuid(), trigger: input<HTMLSelectElement>('[data-action-trigger]').value as BehaviorAction['trigger'], action: input<HTMLSelectElement>('[data-action-type]').value as BehaviorAction['action'], value: input<HTMLInputElement>('[data-action-value]').value.trim() });
      save();
    });
    host.querySelectorAll<HTMLElement>('[data-action-id]').forEach((row) => row.querySelector('button')!.addEventListener('click', () => { profile.behavior.actions = profile.behavior.actions.filter((action) => action.id !== row.dataset.actionId); save(); }));

    text('[data-char-name]', (value) => profile.character.name = value);
    number('[data-char-race]', (value) => profile.character.race = Math.max(1, Math.min(8, Math.floor(value))));
    number('[data-char-class]', (value) => profile.character.classId = Math.max(1, Math.floor(value)));
    input<HTMLSelectElement>('[data-char-gender]').addEventListener('change', () => { profile.character.gender = Number(input<HTMLSelectElement>('[data-char-gender]').value); save(); });
    number('[data-char-skin]', (value) => profile.character.skin = Math.max(0, Math.floor(value)));
    number('[data-char-face]', (value) => profile.character.face = Math.max(0, Math.floor(value)));
    number('[data-char-hair]', (value) => profile.character.hairStyle = Math.max(0, Math.floor(value)));
    number('[data-char-hair-color]', (value) => profile.character.hairColor = Math.max(0, Math.floor(value)));
    number('[data-char-facial]', (value) => profile.character.facialHair = Math.max(0, Math.floor(value)));
    number('[data-char-level]', (value) => profile.character.level = Math.max(1, Math.min(60, Math.floor(value))));
    number('[data-char-animation]', (value) => profile.character.animationId = Math.max(0, Math.floor(value)));
    number('[data-char-scale]', (value) => profile.character.scale = Math.max(0.1, value));
    text('[data-char-skin-texture]', (value) => profile.character.customSkinTexture = value.trim() || undefined);
    text('[data-char-hair-texture]', (value) => profile.character.customHairTexture = value.trim() || undefined);
    input<HTMLTextAreaElement>('[data-char-equipment]').addEventListener('change', () => {
      try {
        const parsed = JSON.parse(input<HTMLTextAreaElement>('[data-char-equipment]').value);
        if (!Array.isArray(parsed)) throw new Error('equipment must be an array');
        profile.character.equipment = parsed;
        save();
      } catch (error) { this.app.bottomPanel.log({ level: 'error', message: `Character equipment JSON: ${(error as Error).message}`, time: new Date() }); }
    });
    host.querySelector('[data-char-preview]')!.addEventListener('click', () => this.app.bridge.previewCharacter(record, profile.character));
    host.querySelector('[data-char-clear]')!.addEventListener('click', () => this.app.bridge.clearCharacter(record));

    input<HTMLInputElement>('[data-quest-enabled]').addEventListener('change', () => { profile.quest.enabled = input<HTMLInputElement>('[data-quest-enabled]').checked; save(); });
    number('[data-quest-id]', (value) => profile.quest.questId = Math.max(0, Math.floor(value)));
    text('[data-quest-title]', (value) => profile.quest.title = value);
    text('[data-quest-gossip]', (value) => profile.quest.gossipText = value);
    text('[data-quest-details]', (value) => profile.quest.details = value);
    text('[data-quest-objectives]', (value) => profile.quest.objectives = value);
    text('[data-quest-rewards]', (value) => profile.quest.rewards = value);
    number('[data-quest-prev]', (value) => profile.quest.prerequisiteQuest = Math.max(0, Math.floor(value)));
    number('[data-quest-next]', (value) => profile.quest.nextQuest = Math.max(0, Math.floor(value)));

    input<HTMLSelectElement>('[data-interaction-type]').addEventListener('change', () => { profile.interaction.type = input<HTMLSelectElement>('[data-interaction-type]').value as InteractionProfile['type']; save(); });
    text('[data-interaction-script]', (value) => profile.interaction.scriptHook = value);
    number('[data-interaction-map]', (value) => profile.interaction.targetMap = Math.max(0, Math.floor(value)));
    number('[data-interaction-x]', (value) => profile.interaction.targetX = value);
    number('[data-interaction-y]', (value) => profile.interaction.targetY = value);
    number('[data-interaction-z]', (value) => profile.interaction.targetZ = value);
  }

  private validate() {
    const issues: Array<{ severity: 'error' | 'warning' | 'info'; code: string; message: string }> = [];
    for (const profile of this.profiles) {
      if (profile.behavior.leashRadius < profile.behavior.aggroRadius) issues.push({ severity: 'warning', code: 'content.behavior-leash', message: `${profile.model}: leash radius is smaller than aggro radius.` });
      for (const action of profile.behavior.actions) if (!action.value && !['flee','returnHome'].includes(action.action)) issues.push({ severity: 'warning', code: 'content.behavior-action', message: `${profile.model}: ${action.trigger}/${action.action} has no parameter.` });
      if (profile.quest.enabled) {
        if (profile.quest.questId <= 0) issues.push({ severity: 'error', code: 'content.quest-id', message: `${profile.model}: enabled quest content needs a positive quest ID.` });
        if (!profile.quest.title.trim()) issues.push({ severity: 'error', code: 'content.quest-title', message: `${profile.model}: enabled quest content needs a title.` });
        for (const [label, json] of [['objectives', profile.quest.objectives], ['rewards', profile.quest.rewards]] as const) try { JSON.parse(json); } catch { issues.push({ severity: 'error', code: `content.quest-${label}`, message: `${profile.model}: ${label} must be valid JSON.` }); }
      }
      if (profile.interaction.type === 'portal' && profile.interaction.targetMap < 0) issues.push({ severity: 'error', code: 'content.portal-map', message: `${profile.model}: portal target map is invalid.` });
      if (profile.character.race < 1 || profile.character.race > 8 || ![0, 1].includes(profile.character.gender)) issues.push({ severity: 'error', code: 'content.character-appearance', message: `${profile.model}: character race/gender is outside Vanilla character ranges.` });
    }
    return issues;
  }

  private renderCurrent() { if (this.panel?.isConnected) this.render(this.panel); }

  private persist() {
    try { localStorage.setItem(STORAGE, JSON.stringify({ profiles: this.profiles, variants: this.variants })); } catch { /* quota */ }
    this.dispatchEvent(new Event('change'));
  }

  private load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE) ?? '{}') as { profiles?: CustomEntityProfile[]; variants?: MaterialVariant[] };
      this.profiles = Array.isArray(data.profiles) ? data.profiles : [];
      this.variants = Array.isArray(data.variants) ? data.variants : [];
    } catch { this.profiles = []; this.variants = []; }
  }
}
