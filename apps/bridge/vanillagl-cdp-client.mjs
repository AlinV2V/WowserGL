import { WebSocket } from 'ws';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalizeOrigin = (value) => {
  try { return new URL(value).origin; } catch { return String(value ?? '').replace(/\/+$/, ''); }
};

export class CdpSession {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.contexts = new Map();
  }

  async connect(timeout = 4000) {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error(`Timed out connecting CDP ${this.url}`));
      }, timeout);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    socket.on('message', (raw) => this.#onMessage(raw));
    socket.on('close', () => {
      for (const entry of this.pending.values()) entry.reject(new Error('CDP connection closed'));
      this.pending.clear();
      this.emit('close', {});
    });
  }

  on(method, callback) {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, set = new Set());
    set.add(callback);
    return () => set.delete(callback);
  }

  emit(method, params) {
    for (const callback of this.listeners.get(method) ?? []) {
      try { callback(params); } catch (error) { console.error('[adapter] CDP event listener failed', error); }
    }
  }

  request(method, params = {}, timeout = 6000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP socket is not open'));
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  async evaluate(expression, contextId, { awaitPromise = true, returnByValue = true } = {}) {
    const response = await this.request('Runtime.evaluate', {
      expression,
      contextId,
      awaitPromise,
      returnByValue,
      userGesture: true,
    }, 15000);
    if (response?.exceptionDetails) {
      const text = response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.text
        ?? 'Runtime.evaluate failed';
      throw new Error(text);
    }
    return response?.result?.value;
  }

  close() {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, 'adapter detach');
    this.socket = null;
  }

  #onMessage(raw) {
    let packet;
    try { packet = JSON.parse(String(raw)); } catch { return; }
    if (packet.id) {
      const pending = this.pending.get(packet.id);
      if (!pending) return;
      this.pending.delete(packet.id);
      if (packet.error) pending.reject(new Error(packet.error.message ?? JSON.stringify(packet.error)));
      else pending.resolve(packet.result);
      return;
    }
    if (packet.method === 'Runtime.executionContextCreated') {
      const context = packet.params?.context;
      if (context?.id !== undefined) this.contexts.set(context.id, context);
    } else if (packet.method === 'Runtime.executionContextDestroyed') {
      this.contexts.delete(packet.params?.executionContextId);
    } else if (packet.method === 'Runtime.executionContextsCleared') {
      this.contexts.clear();
    }
    if (packet.method) this.emit(packet.method, packet.params ?? {});
  }
}

export async function listCdpTargets(cdpHttpUrl) {
  const base = String(cdpHttpUrl).replace(/\/+$/, '');
  const response = await fetch(`${base}/json/list`);
  if (!response.ok) throw new Error(`CDP target list HTTP ${response.status}`);
  const targets = await response.json();
  return Array.isArray(targets) ? targets : [];
}

export async function discoverVanillaGLContext({
  cdpHttpUrl = 'http://127.0.0.1:9222',
  targetOrigin = 'http://localhost:5173',
  settleMs = 120,
} = {}) {
  const expected = normalizeOrigin(targetOrigin);
  const targets = await listCdpTargets(cdpHttpUrl);
  const candidates = targets.filter((target) => target.webSocketDebuggerUrl && ['page', 'iframe'].includes(target.type));

  for (const target of candidates) {
    const session = new CdpSession(target.webSocketDebuggerUrl);
    try {
      await session.connect();
      await session.request('Runtime.enable');
      await sleep(settleMs);

      let match = [...session.contexts.values()].find((context) => normalizeOrigin(context.origin) === expected);
      if (!match && normalizeOrigin(target.url) === expected) {
        match = [...session.contexts.values()].find((context) => context.auxData?.isDefault) ?? [...session.contexts.values()][0];
      }
      if (match) return { session, contextId: match.id, context: match, target };
    } catch {
      session.close();
      continue;
    }
    session.close();
  }

  throw new Error(`No VanillaGL QA execution context found for ${expected}. Launch Chrome/Edge with --remote-debugging-port=9222 and keep the VanillaGL Vite dev page open.`);
}

export { normalizeOrigin, sleep };
