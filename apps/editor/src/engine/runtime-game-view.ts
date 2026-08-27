import type { EditorApp } from '../editor-app';

export class RuntimeGameView extends EventTarget {
  readonly iframe: HTMLIFrameElement;
  visible = false;
  private loaded = false;
  private sceneTab: HTMLButtonElement;
  private gameTab: HTMLButtonElement;

  constructor(private readonly app: EditorApp, private readonly root: HTMLElement) {
    const viewport = root.querySelector<HTMLElement>('[data-viewport]')!;
    this.iframe = document.createElement('iframe');
    this.iframe.className = 'runtime-game-iframe';
    this.iframe.title = 'CleanClientMMO Game View';
    this.iframe.allow = 'autoplay; fullscreen; gamepad';
    this.iframe.hidden = true;
    viewport.append(this.iframe);
    this.gameTab = root.querySelector<HTMLButtonElement>('[data-game-tab]')!;
    this.sceneTab = root.querySelector<HTMLButtonElement>('.scene-tabs button:first-child')!;
    this.gameTab.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.showGame();
    }, true);
    this.sceneTab.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.showScene();
    }, true);
    app.bridge.addEventListener('runtime-state', (event) => {
      const state = (event as CustomEvent<{ sceneReady: boolean }>).detail;
      this.iframe.classList.toggle('runtime-ready', state.sceneReady);
    });
  }

  showGame() {
    if (!this.loaded) this.load();
    this.visible = true;
    this.iframe.hidden = false;
    this.app.renderer.domElement.style.visibility = 'hidden';
    this.root.classList.add('embedded-game-view');
    this.gameTab.classList.add('active');
    this.sceneTab.classList.remove('active');
    this.dispatchEvent(new CustomEvent('view', { detail: 'game' }));
  }

  showScene() {
    this.visible = false;
    this.iframe.hidden = true;
    this.app.renderer.domElement.style.visibility = '';
    this.root.classList.remove('embedded-game-view');
    this.sceneTab.classList.add('active');
    this.gameTab.classList.remove('active');
    this.dispatchEvent(new CustomEvent('view', { detail: 'scene' }));
  }

  reload() {
    this.loaded = false;
    this.iframe.src = 'about:blank';
    if (this.visible) this.load();
  }

  private load() {
    const gameUrl = import.meta.env.VITE_VANILLAGL_GAME_URL ?? 'http://localhost:5173/';
    const url = new URL(gameUrl, location.href);
    url.searchParams.set('studioBridge', this.app.bridge.url);
    url.searchParams.set('studioEmbedded', '1');
    url.searchParams.set('debugtools', '');
    this.iframe.src = url.toString();
    this.loaded = true;
  }
}
