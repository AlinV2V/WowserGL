import type { EditorObjectStore } from '../editor-store';
import type { EditorRecord } from '../types';
import type { ComponentField, SceneComponentModel, StudioComponent, StudioComponentType } from './component-model';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

export class ComponentInspectorPanel {
  private host: HTMLElement;
  private record: EditorRecord | null = null;

  constructor(root: HTMLElement, private readonly store: EditorObjectStore, private readonly model: SceneComponentModel) {
    this.host = document.createElement('div');
    this.host.className = 'studio-component-stack';
    root.querySelector('[data-inspector] [data-content]')?.append(this.host);
    store.addEventListener('selection', (event) => { this.record = (event as CustomEvent<EditorRecord | null>).detail; this.render(); });
    model.addEventListener('change', () => this.render());
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
    title.innerHTML = `<strong>Components</strong><span>${entity.components.length}</span>`;
    this.host.append(title);
    for (const entry of entity.components) this.host.append(this.componentCard(record, entry));
    this.host.append(this.addComponentRow(record));
  }

  private componentCard(record: EditorRecord, entry: StudioComponent) {
    const schema = this.model.schema(entry.type);
    const card = document.createElement('section');
    card.className = 'component-card engine-component';
    const header = document.createElement('div');
    header.className = 'component-head';
    const removable = !['EditorMetadata','Renderable','M2Renderer','WmoRenderer'].includes(entry.type);
    header.innerHTML = `<span class="component-toggle">▾</span><strong>${escapeHtml(schema?.label ?? entry.type)}</strong><span class="component-badge">${escapeHtml(schema?.category ?? 'Engine')}</span>`;
    if (removable) {
      const remove = document.createElement('button');
      remove.className = 'component-menu component-remove';
      remove.textContent = '×';
      remove.title = 'Remove component';
      remove.addEventListener('click', () => this.model.removeComponent(record, entry.type));
      header.append(remove);
    }
    const body = document.createElement('div');
    body.className = 'component-body';
    for (const field of schema?.fields ?? []) body.append(this.field(record, entry, field));
    if (entry.type === 'Path') {
      const note = document.createElement('div');
      note.className = 'component-help';
      const waypoints = Array.isArray(entry.data.waypoints) ? entry.data.waypoints.length : 0;
      note.textContent = `${waypoints} waypoint${waypoints === 1 ? '' : 's'} · use Path Tool in the toolbar to author points directly on terrain.`;
      body.append(note);
    }
    card.append(header, body);
    return card;
  }

  private field(record: EditorRecord, entry: StudioComponent, field: ComponentField) {
    const row = document.createElement('label');
    row.className = 'unity-property engine-property';
    const label = document.createElement('span');
    label.textContent = field.label;
    const control = document.createElement('div');
    control.className = 'property-control';
    const value = entry.data[field.key];
    let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (field.type === 'select') {
      const select = document.createElement('select');
      for (const option of field.options ?? []) {
        const element = document.createElement('option');
        element.value = option.value;
        element.textContent = option.label;
        select.append(element);
      }
      select.value = String(value ?? '');
      input = select;
    } else if (field.type === 'textarea') {
      const textarea = document.createElement('textarea');
      textarea.rows = 3;
      textarea.value = String(value ?? '');
      input = textarea;
    } else {
      const element = document.createElement('input');
      element.type = field.type === 'boolean' ? 'checkbox' : field.type === 'number' ? 'number' : field.type === 'color' ? 'color' : 'text';
      if (field.type === 'boolean') element.checked = value !== false;
      else element.value = String(value ?? '');
      if (field.min !== undefined) element.min = String(field.min);
      if (field.max !== undefined) element.max = String(field.max);
      if (field.step !== undefined) element.step = String(field.step);
      input = element;
    }
    input.disabled = field.readonly === true;
    const commit = () => {
      if (field.readonly) return;
      let next: unknown;
      if (input instanceof HTMLInputElement && field.type === 'boolean') next = input.checked;
      else if (field.type === 'number') next = Number(input.value);
      else next = input.value;
      this.model.setComponentValue(record, entry.type, field.key, next);
    };
    input.addEventListener(field.type === 'color' ? 'input' : 'change', commit);
    control.append(input);
    row.append(label, control);
    return row;
  }

  private addComponentRow(record: EditorRecord) {
    const row = document.createElement('div');
    row.className = 'add-component-row';
    const select = document.createElement('select');
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Add Component…';
    select.append(placeholder);
    const entity = this.model.entities.get(record.id);
    for (const schema of this.model.schemas) {
      if (['EditorMetadata','Renderable','M2Renderer','WmoRenderer'].includes(schema.type)) continue;
      if (schema.unique && entity?.components.some((entry) => entry.type === schema.type)) continue;
      const option = document.createElement('option');
      option.value = schema.type;
      option.textContent = `${schema.category} / ${schema.label}`;
      select.append(option);
    }
    const button = document.createElement('button');
    button.className = 'accent';
    button.textContent = 'Add';
    button.addEventListener('click', () => {
      if (!select.value) return;
      this.model.addComponent(record, select.value as StudioComponentType);
      select.value = '';
    });
    row.append(select, button);
    return row;
  }
}
