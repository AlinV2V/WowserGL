import type { EditorApp } from '../editor-app';
import type { GlobalAssetBrowser } from './global-asset-browser';
import type { ProjectWorkspace } from './project-workspace';

export class PrefabBrowser {
  private overlay: HTMLElement;

  constructor(private readonly app: EditorApp, private readonly workspace: ProjectWorkspace, private readonly assets: GlobalAssetBrowser, root: HTMLElement) {
    const button = document.createElement('button');
    button.className = 'folder-button';
    button.textContent = 'Prefabs';
    button.title = 'Browse reusable Studio prefabs';
    root.querySelector('[data-project] .project-toolbar')?.prepend(button);
    this.overlay = document.createElement('div');
    this.overlay.className = 'global-asset-browser prefab-browser';
    this.overlay.hidden = true;
    root.querySelector('[data-project]')?.append(this.overlay);
    button.addEventListener('click', () => { this.overlay.hidden = !this.overlay.hidden; this.render(); });
    workspace.addEventListener('change', () => { if (!this.overlay.hidden) this.render(); });
    workspace.addEventListener('prefab', () => { if (!this.overlay.hidden) this.render(); });
    this.render();
  }

  private render() {
    this.overlay.replaceChildren();
    const head = document.createElement('div');
    head.className = 'global-assets-head';
    head.innerHTML = `<strong>Prefabs</strong><span>${this.workspace.prefabs.length} reusable authored object(s)</span>`;
    const close = document.createElement('button');
    close.textContent = '×';
    close.addEventListener('click', () => { this.overlay.hidden = true; });
    head.append(close);
    this.overlay.append(head);
    const list = document.createElement('div');
    list.className = 'global-assets-list';
    if (!this.workspace.prefabs.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Create a prefab from Project → Prefabs or from the selected entity component workflow.';
      list.append(empty);
    }
    for (const prefab of this.workspace.prefabs) {
      const row = document.createElement('div');
      row.className = 'prefab-row';
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = prefab.name;
      const model = document.createElement('small');
      model.textContent = prefab.model;
      copy.append(name, model);
      const place = document.createElement('button');
      place.className = 'accent';
      place.textContent = 'Place';
      place.addEventListener('click', async () => {
        try {
          const record = await this.assets.instantiatePrefab(prefab);
          this.app.store.select(record);
          this.app.bottomPanel.log({ level: 'info', message: `Instantiated prefab ${prefab.name}.`, time: new Date() });
        } catch (error) {
          this.app.bottomPanel.log({ level: 'error', message: `Prefab placement failed: ${error instanceof Error ? error.message : String(error)}`, time: new Date() });
        }
      });
      const remove = document.createElement('button');
      remove.textContent = '×';
      remove.title = 'Delete prefab definition';
      remove.addEventListener('click', () => this.workspace.removePrefab(prefab.id));
      row.append(copy, place, remove);
      list.append(row);
    }
    this.overlay.append(list);
  }
}
