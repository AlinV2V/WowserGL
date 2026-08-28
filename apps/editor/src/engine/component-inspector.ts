import { isRecordLocked, type EditorObjectStore } from '../editor-store';
import type { EditorRecord } from '../types';
import type { ComponentField, SceneComponentModel, StudioComponent, StudioComponentType } from './component-model';
import type { ProjectWorkspace } from './project-workspace';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
type ComponentClipboard = { type: StudioComponentType; data: Record<string, unknown> };

export class ComponentInspectorPanel {
  private host: HTMLElement;
  private record: EditorRecord | null = null;
  private collapsed = new Set<string>();
  private clipboard: ComponentClipboard | null = null;
  private audio: HTMLAudioElement | null = null;

  constructor(root: HTMLElement, private readonly store: EditorObjectStore, private readonly model: SceneComponentModel, private readonly workspace: ProjectWorkspace) {
    this.host = document.createElement('div');
    this.host.className = 'studio-component-stack';
    root.querySelector('[data-inspector] [data-content]')?.append(this.host);
    store.addEventListener('selection', (event) => { this.stopAudio(); this.record = (event as CustomEvent<EditorRecord | null>).detail; this.render(); });
    store.addEventListener('change', () => this.render());
    model.addEventListener('change', () => this.render());
    workspace.addEventListener('change', () => this.render());
    this.record = store.selected;
    this.render();
  }

  private render() {
    this.host.replaceChildren();
    const record = this.record;
    if (!record) return;
    const entity = this.model.entities.get(record.id);
    if (!entity) return;
    const title = document.createElement('div');
    title.className = 'studio-component-heading';
    title.innerHTML = `<strong>Components</strong><span>${entity.components.length}${isRecordLocked(record) ? ' · locked' : ''}</span>`;
    this.host.append(title);
    for (const entry of entity.components) this.host.append(this.componentCard(record, entry));
    this.host.append(this.addComponentRow(record));
  }

  private componentCard(record: EditorRecord, entry: StudioComponent) {
    const schema = this.model.schema(entry.type);
    const key = `${record.id}:${entry.type}`;
    const isCollapsed = this.collapsed.has(key);
    const warning = this.warningFor(entry);
    const mutationLocked = isRecordLocked(record) && entry.type !== 'EditorMetadata';
    const card = document.createElement('section');
    card.className = `component-card engine-component${warning ? ' component-has-warning' : ''}${isCollapsed ? ' collapsed' : ''}`;
    const header = document.createElement('div');
    header.className = 'component-head';
    const removable = !['EditorMetadata','Renderable','M2Renderer','WmoRenderer'].includes(entry.type);
    header.innerHTML = `<button class="component-toggle" title="Collapse / expand">${isCollapsed ? '▸' : '▾'}</button><strong>${escapeHtml(schema?.label ?? entry.type)}</strong>${warning ? `<span class="component-warning" title="${escapeHtml(warning)}">!</span>` : ''}<span class="component-badge">${escapeHtml(schema?.category ?? 'Engine')}</span>`;
    const actions = document.createElement('div');
    actions.className = 'component-actions';
    const copy = document.createElement('button');
    copy.textContent = '⧉'; copy.title = 'Copy component values';
    copy.addEventListener('click', (event) => { event.stopPropagation(); this.clipboard = { type: entry.type, data: structuredClone(entry.data) }; this.render(); });
    actions.append(copy);
    if (this.clipboard?.type === entry.type) {
      const paste = document.createElement('button'); paste.textContent = '↧'; paste.title = 'Paste component values'; paste.disabled = mutationLocked;
      paste.addEventListener('click', (event) => { event.stopPropagation(); if (!mutationLocked) this.applyValues(record, entry.type, this.clipboard!.data); }); actions.append(paste);
    }
    if (schema?.defaults && Object.keys(schema.defaults).length) {
      const reset = document.createElement('button'); reset.textContent = '↺'; reset.title = 'Reset component to defaults'; reset.disabled = mutationLocked;
      reset.addEventListener('click', (event) => { event.stopPropagation(); if (!mutationLocked) this.applyValues(record, entry.type, schema.defaults); }); actions.append(reset);
    }
    if (removable) {
      const remove = document.createElement('button'); remove.className = 'component-remove'; remove.textContent = '×'; remove.title = 'Remove component'; remove.disabled = mutationLocked;
      remove.addEventListener('click', (event) => { event.stopPropagation(); if (mutationLocked) return; if (entry.type === 'AudioSource') this.stopAudio(); this.model.removeComponent(record, entry.type); }); actions.append(remove);
    }
    header.append(actions);
    header.querySelector('.component-toggle')!.addEventListener('click', () => { if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key); this.render(); });

    const body = document.createElement('div'); body.className = 'component-body'; body.hidden = isCollapsed;
    if (schema?.note) { const note = document.createElement('div'); note.className = 'component-help component-backend-note'; note.textContent = schema.note; body.append(note); }
    for (const field of schema?.fields ?? []) body.append(this.field(record, entry, field, mutationLocked));
    if (entry.type === 'AudioSource') body.append(this.audioPreview(entry));
    if (entry.type === 'Path') {
      const note = document.createElement('div'); note.className = 'component-help';
      const count = Array.isArray(entry.data.waypoints) ? entry.data.waypoints.length : 0;
      note.textContent = `${count} waypoint${count === 1 ? '' : 's'} · use Path Tool in Scene; Shift-click a handle to remove it.`; body.append(note);
    }
    if (entry.type === 'PrefabInstance') body.append(this.prefabActions(record, mutationLocked));
    card.append(header, body);
    return card;
  }

  private audioPreview(entry: StudioComponent) {
    const host = document.createElement('div'); host.className = 'component-preview-actions';
    const status = document.createElement('span'); status.className = 'component-help'; status.textContent = 'Stopped';
    const play = document.createElement('button'); play.textContent = '▶ Preview'; play.className = 'accent';
    play.addEventListener('click', async () => {
      this.stopAudio();
      const url = String(entry.data.url ?? '').trim();
      if (!url) { status.textContent = 'Set a Sound URL first.'; return; }
      const audio = new Audio(url); audio.volume = Math.max(0, Math.min(1, Number(entry.data.volume ?? 1))); audio.loop = entry.data.loop === true; this.audio = audio;
      audio.addEventListener('ended', () => { if (this.audio === audio) { this.audio = null; status.textContent = 'Finished'; } });
      audio.addEventListener('error', () => { if (this.audio === audio) { this.audio = null; status.textContent = 'Preview failed to load.'; } });
      try { await audio.play(); status.textContent = `Playing · ${Math.round(audio.volume * 100)}%${audio.loop ? ' · loop' : ''}`; }
      catch (error) { this.audio = null; status.textContent = `Preview failed: ${error instanceof Error ? error.message : String(error)}`; }
    });
    const stop = document.createElement('button'); stop.textContent = '■ Stop'; stop.addEventListener('click', () => { this.stopAudio(); status.textContent = 'Stopped'; });
    host.append(play, stop, status); return host;
  }

  private prefabActions(record: EditorRecord, locked: boolean) {
    const host = document.createElement('div'); host.className = 'prefab-actions';
    const prefab = this.workspace.prefabForRecord(record); const overridden = this.workspace.isPrefabOverridden(record);
    const status = document.createElement('div'); status.className = `component-help prefab-status${overridden ? ' overridden' : ''}`; status.textContent = prefab ? `${prefab.name}${overridden ? ' · instance overrides' : ' · synced'}` : 'Prefab definition is missing.'; host.append(status);
    const row = document.createElement('div'); row.className = 'project-actions';
    const apply = document.createElement('button'); apply.textContent = 'Apply'; apply.disabled = locked || !prefab || !overridden; apply.addEventListener('click', () => this.workspace.applyInstanceToPrefab(record));
    const revert = document.createElement('button'); revert.textContent = 'Revert'; revert.disabled = locked || !prefab || !overridden; revert.addEventListener('click', () => this.workspace.revertPrefabInstance(record));
    const unpack = document.createElement('button'); unpack.textContent = 'Unpack'; unpack.disabled = locked || !prefab; unpack.addEventListener('click', () => this.workspace.unpackPrefab(record));
    row.append(apply, revert, unpack); host.append(row); return host;
  }

  private field(record: EditorRecord, entry: StudioComponent, field: ComponentField, mutationLocked: boolean) {
    const row = document.createElement('label'); row.className = 'unity-property engine-property';
    const label = document.createElement('span'); label.textContent = field.label;
    const control = document.createElement('div'); control.className = 'property-control';
    const value = entry.data[field.key]; let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (field.type === 'select') {
      const select = document.createElement('select');
      for (const option of field.options ?? []) { const element = document.createElement('option'); element.value = option.value; element.textContent = option.label; select.append(element); }
      select.value = String(value ?? ''); input = select;
    } else if (field.type === 'textarea') {
      const textarea = document.createElement('textarea'); textarea.rows = 3; textarea.value = String(value ?? ''); input = textarea;
    } else {
      const element = document.createElement('input'); element.type = field.type === 'boolean' ? 'checkbox' : field.type === 'number' ? 'number' : field.type === 'color' ? 'color' : 'text';
      if (field.type === 'boolean') element.checked = value !== false; else element.value = String(value ?? '');
      if (field.min !== undefined) element.min = String(field.min); if (field.max !== undefined) element.max = String(field.max); if (field.step !== undefined) element.step = String(field.step); input = element;
    }
    const canUnlockSelf = entry.type === 'EditorMetadata' && field.key === 'locked';
    input.disabled = field.readonly === true || (mutationLocked && !canUnlockSelf);
    const commit = () => {
      if (field.readonly || (mutationLocked && !canUnlockSelf)) return;
      const next = input instanceof HTMLInputElement && field.type === 'boolean' ? input.checked : field.type === 'number' ? Number(input.value) : input.value;
      this.model.setComponentValue(record, entry.type, field.key, next);
    };
    input.addEventListener(field.type === 'color' ? 'input' : 'change', commit); control.append(input); row.append(label, control); return row;
  }

  private addComponentRow(record: EditorRecord) {
    const row = document.createElement('div'); row.className = 'add-component-row searchable';
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search components…';
    const select = document.createElement('select');
    const rebuild = () => {
      const query = search.value.trim().toLowerCase(); select.replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Add Component…'; select.append(placeholder);
      const entity = this.model.entities.get(record.id);
      for (const schema of this.model.schemas) {
        if (['EditorMetadata','Renderable','M2Renderer','WmoRenderer'].includes(schema.type)) continue;
        if (schema.unique && entity?.components.some((entry) => entry.type === schema.type)) continue;
        if (query && !`${schema.category} ${schema.label} ${schema.type}`.toLowerCase().includes(query)) continue;
        const option = document.createElement('option'); option.value = schema.type; option.textContent = `${schema.category} / ${schema.label}`; select.append(option);
      }
    };
    search.addEventListener('input', rebuild); rebuild();
    const button = document.createElement('button'); button.className = 'accent'; button.textContent = 'Add';
    const refreshLock = () => { const locked = isRecordLocked(record); search.disabled = locked; select.disabled = locked; button.disabled = locked; };
    button.addEventListener('click', () => { if (!select.value || isRecordLocked(record)) return; this.model.addComponent(record, select.value as StudioComponentType); search.value = ''; });
    row.append(search, select, button); refreshLock(); return row;
  }

  private applyValues(record: EditorRecord, type: StudioComponentType, values: Record<string, unknown>) {
    if (isRecordLocked(record) && type !== 'EditorMetadata') return;
    const schema = this.model.schema(type);
    for (const [key, value] of Object.entries(values)) { if (schema?.fields.find((field) => field.key === key)?.readonly) continue; this.model.setComponentValue(record, type, key, structuredClone(value)); }
  }

  private warningFor(entry: StudioComponent) {
    if ((entry.type === 'CreatureSpawn' || entry.type === 'GameObjectSpawn') && Number(entry.data.templateEntry ?? 0) <= 0) return 'A server template entry is required before vMaNGOS export.';
    if (entry.type === 'AudioSource' && !String(entry.data.url ?? '').trim()) return 'Set a Sound URL to use the audio preview.';
    if (entry.type === 'Script' && entry.data.enabled !== false && !String(entry.data.module ?? '').trim()) return 'Enabled script metadata has no module name.';
    if (entry.type === 'Path' && !Array.isArray(entry.data.waypoints)) return 'Waypoint payload is invalid.';
    return '';
  }

  private stopAudio() { if (!this.audio) return; this.audio.pause(); this.audio.currentTime = 0; this.audio = null; }
}
