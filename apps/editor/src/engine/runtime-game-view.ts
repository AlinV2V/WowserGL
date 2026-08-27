import type { EditorApp } from '../editor-app';

export class RuntimeGameView extends EventTarget {
  readonly iframe: HTMLIFrameElement;
  visible = false;
  maximized = false;
  private loaded = false;
  private sceneTab: HTMLButtonElement;
  private gameTab: HTMLButtonElement;
  private status: HTMLElement;
  private overlay: HTMLElement;
  private readinessTimer = 0;

  constructor(private readonly app: EditorApp, private readonly root: HTMLElement) {
    super();
    const viewport = root.querySelector<HTMLElement>('[data-viewport]')!;
    this.iframe = document.createElement('iframe');
    this.iframe.className = 'runtime-game-iframe';
    this.iframe.title = 'CleanClientMMO Game View';
    this.iframe.allow = 'autoplay; fullscreen; gamepad';
    this.iframe.hidden = true;
    this.overlay = document.createElement('div');
    this.overlay.className = 'runtime-game-toolbar';
    this.overlay.hidden = true;
    this.overlay.innerHTML = `<span class="runtime-game-state" data-game-state>Game view is not loaded.</span><div><button data-game-reload title="Reload CleanClientMMO">↻ Reload</button><button data-game-maximize title="Maximize Game view">Maximize</button><button data-game-window title="Open CleanClientMMO in its own tab">Open Window</button></div>`;
    viewport.append(this.iframe, this.overlay);
    this.status = this.overlay.querySelector<HTMLElement>('[data-game-state]')!;
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
    this.overlay.querySelector('[data-game-reload]')!.addEventListener('click', () => this.reload());
    this.overlay.querySelector('[data-game-window]')!.addEventListener('click', () => app.bridge.openGame());
    this.overlay.querySelector('[data-game-maximize]')!.addEventListener('click', () => this.toggleMaximized());
    this.iframe.addEventListener('load', () => {
      if (this.iframe.src === 'about:blank') return;
      this.setStatus(this.app.bridge.runtimes ? 'CleanClientMMO loaded · runtime bridge ready.' : 'CleanClientMMO loaded · waiting for runtime bridge…', this.app.bridge.runtimes ? 'ready' : 'waiting');
      this.iframe.focus();
    });
    app.bridge.addEventListener('status', () => this.updateBridgeState());
    app.bridge.addEventListener('peers', () => this.updateBridgeState());
    app.bridge.addEventListener('runtime-state', (event) => {
      const state = (event as CustomEvent<{ sceneReady: boolean }>).detail;
      this.iframe.classList.toggle('runtime-ready', state.sceneReady);
      this.setStatus(state.sceneReady ? 'Runtime scene ready · live edits are authoritative.' : 'Runtime connected · world scene is still initializing…', state.sceneReady ? 'ready' : 'waiting');
    });
  }

  showGame() {
    if (!this.loaded) this.load();
    this.visible = true;
    this.iframe.hidden = false;
    this.overlay.hidden = false;
    this.app.renderer.domElement.style.visibility = 'hidden';
    this.root.classList.add('embedded-game-view');
    this.gameTab.classList.add('active');
    this.sceneTab.classList.remove('active');
    this.updateBridgeState();
    window.clearTimeout(this.readinessTimer);
    this.readinessTimer = window.setTimeout(() => {
      if (this.visible && !this.app.bridge.runtimes) this.setStatus('CleanClientMMO did not join the bridge. Make sure the game dev server is running on port 5173, then Reload.', 'error');
    }, 5000);
    window.setTimeout(() => this.iframe.focus(), 0);
    this.dispatchEvent(new CustomEvent('view', { detail: 'game' }));
  }

  showScene() {
    this.visible = false;
    this.iframe.hidden = true;
    this.overlay.hidden = true;
    this.app.renderer.domElement.style.visibility = '';
    this.root.classList.remove('embedded-game-view');
    this.sceneTab.classList.add('active');
    this.gameTab.classList.remove('active');
    window.clearTimeout(this.readinessTimer);
    this.app.renderer.domElement.focus();
    this.dispatchEvent(new CustomEvent('view', { detail: 'scene' }));
  }

  reload() {
    this.loaded = false;
    this.iframe.src = 'about:blank';
    this.setStatus('Reloading CleanClientMMO…', 'waiting');
    if (this.visible) window.setTimeout(() => this.load(), 30);
  }

  toggleMaximized(force?: boolean) {
    this.maximized = force ?? !this.maximized;
    this.root.classList.toggle('game-view-maximized', this.maximized);
    const button = this.overlay.querySelector<HTMLButtonElement>('[data-game-maximize]');
    if (button) button.textContent = this.maximized ? 'Restore' : 'Maximize';
    this.dispatchEvent(new CustomEvent('maximize', { detail: this.maximized }));
  }

  private load() {
    const gameUrl = import.meta.env.VITE_VANILLAGL_GAME_URL ?? 'http://localhost:5173/';
    const url = new URL(gameUrl, location.href);
    url.searchParams.set('studioBridge', this.app.bridge.url);
    url.searchParams.set('studioEmbedded', '1');
    url.searchParams.set('debugtools', '');
    this.setStatus(`Loading ${url.host}…`, 'waiting');
    this.iframe.src = url.toString();
    this.loaded = true;
  }

  private updateBridgeState() {
    if (this.app.bridge.runtimes > 0) this.setStatus('CleanClientMMO runtime connected · live sync available.', 'ready');
    else if (this.app.bridge.status === 'connected') this.setStatus('Studio bridge ready · waiting for CleanClientMMO runtime…', 'waiting');
    else if (this.app.bridge.status === 'connecting') this.setStatus('Connecting Studio live bridge…', 'waiting');
    else this.setStatus('Studio bridge offline. Start `npm run dev` and reload the Game view.', 'error');
  }

  private setStatus(message: string, tone: 'ready' | 'waiting' | 'error' = 'waiting') {
    this.status.textContent = message;
    this.status.dataset.tone = tone;
  }
}
