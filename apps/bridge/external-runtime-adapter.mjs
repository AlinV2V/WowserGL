import process from 'node:process';
import { WebSocket } from 'ws';
import { discoverVanillaGLContext, sleep } from './vanillagl-cdp-client.mjs';
import { runtimeBootstrapSource } from './vanillagl-runtime-bootstrap.mjs';

const cdpHttpUrl = process.env.VANILLAGL_CDP_URL ?? 'http://127.0.0.1:9222';
const targetOrigin = process.env.VANILLAGL_TARGET_ORIGIN ?? 'http://localhost:5173';
const bridgeUrl = process.env.STUDIO_BRIDGE_URL ?? 'ws://127.0.0.1:5191';
const retryMs = Math.max(500, Number(process.env.VANILLAGL_ADAPTER_RETRY_MS ?? 1200));
const clientName = process.env.VANILLAGL_ADAPTER_NAME ?? 'WowserGL External VanillaGL Adapter';

let stopped = false;
let active = null;
let bridge = null;
let stateTimer = null;
let queue = Promise.resolve();

const log = (level, message) => {
  const writer = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  writer(`[adapter] ${message}`);
  if (bridge?.readyState === WebSocket.OPEN) {
    bridge.send(JSON.stringify({ type: 'bridge.log', level, message }));
  }
};

const send = (packet) => {
  if (bridge?.readyState === WebSocket.OPEN) bridge.send(JSON.stringify(packet));
};

async function evaluate(expression, options) {
  if (!active) throw new Error('VanillaGL CDP context is not attached');
  return await active.session.evaluate(expression, active.contextId, options);
}

async function runtimeState() {
  try {
    const state = await evaluate('globalThis.__wowserglExternalRuntime?.state?.() ?? { sceneReady: false, source: "missing" }');
    return state && typeof state === 'object' ? state : { sceneReady: false };
  } catch {
    return { sceneReady: false };
  }
}

async function sendRuntimeState() {
  const state = await runtimeState();
  send({
    type: 'runtime.state',
    runtime: clientName,
    sceneReady: !!state.sceneReady,
    capabilities: Array.isArray(state.capabilities) ? state.capabilities : undefined,
    source: state.source ?? 'wowsergl-external-cdp',
  });
}

function commandExpression(command) {
  return `globalThis.__wowserglExternalRuntime.handle(${JSON.stringify(command)})`;
}

async function applyCommand(packet) {
  const command = packet.command;
  try {
    const message = await evaluate(commandExpression(command));
    send({
      type: 'bridge.ack',
      id: packet.id,
      commandType: command.type,
      ok: true,
      message: typeof message === 'string' ? message : 'applied through external VanillaGL adapter',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({ type: 'bridge.ack', id: packet.id, commandType: command.type, ok: false, message });
    log('error', `${command.type}: ${message}`);
    if (/context|session|closed|destroyed|Cannot find context/i.test(message)) void detach('VanillaGL execution context was lost');
  }
}

function connectBridge() {
  if (!active || stopped || bridge?.readyState === WebSocket.OPEN || bridge?.readyState === WebSocket.CONNECTING) return;
  const url = new URL(bridgeUrl);
  url.searchParams.set('role', 'runtime');
  url.searchParams.set('client', clientName);
  const socket = new WebSocket(url);
  bridge = socket;

  socket.on('open', () => {
    log('info', `Attached externally to VanillaGL through CDP (${targetOrigin}); VanillaGL source remains unmodified.`);
    void sendRuntimeState();
    clearInterval(stateTimer);
    stateTimer = setInterval(() => void sendRuntimeState(), 1000);
  });

  socket.on('message', (raw) => {
    let packet;
    try { packet = JSON.parse(String(raw)); } catch { return; }

    if (packet.type === 'bridge.hello') {
      void sendRuntimeState();
      if (packet.cachedProject) {
        queue = queue.then(() => applyCommand({
          type: 'bridge.command',
          id: `cached-${Date.now()}`,
          command: { type: 'project.apply', project: packet.cachedProject },
        }));
      }
      return;
    }

    if (packet.type === 'bridge.command') {
      queue = queue.then(() => applyCommand(packet));
    }
  });

  socket.on('close', () => {
    if (bridge === socket) bridge = null;
    clearInterval(stateTimer);
    stateTimer = null;
    if (!stopped && active) setTimeout(connectBridge, 800).unref?.();
  });

  socket.on('error', (error) => {
    console.warn(`[adapter] Studio bridge connection failed: ${error.message}`);
  });
}

async function attach() {
  const discovered = await discoverVanillaGLContext({ cdpHttpUrl, targetOrigin });
  const state = await discovered.session.evaluate(runtimeBootstrapSource(), discovered.contextId);
  if (!state || typeof state !== 'object') {
    discovered.session.close();
    throw new Error('VanillaGL compatibility bootstrap did not return runtime state');
  }

  active = discovered;
  const destroyed = discovered.session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
    if (executionContextId === discovered.contextId) void detach('VanillaGL page reloaded');
  });
  const cleared = discovered.session.on('Runtime.executionContextsCleared', () => void detach('VanillaGL execution contexts cleared'));
  const closed = discovered.session.on('close', () => void detach('Chrome DevTools connection closed'));
  active.unsubscribe = () => { destroyed(); cleared(); closed(); };

  log('info', `Found VanillaGL QA context in ${discovered.target.title || discovered.target.url}.`);
  connectBridge();
}

async function detach(reason) {
  const current = active;
  if (!current) return;
  active = null;
  current.unsubscribe?.();
  try {
    await current.session.evaluate('globalThis.__wowserglExternalRuntime?.cleanup?.()', current.contextId).catch(() => {});
  } finally {
    current.session.close();
  }
  if (bridge) {
    bridge.close(1012, 'VanillaGL context detached');
    bridge = null;
  }
  clearInterval(stateTimer);
  stateTimer = null;
  log('warn', `${reason}; waiting to reattach.`);
}

async function main() {
  console.log('[adapter] WowserGL owns this compatibility process; VanillaGL is treated as a read-only development target.');
  console.log(`[adapter] CDP: ${cdpHttpUrl} | target: ${targetOrigin} | bridge: ${bridgeUrl}`);
  while (!stopped) {
    if (!active) {
      try {
        await attach();
      } catch (error) {
        console.log(`[adapter] waiting for VanillaGL QA page: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await sleep(retryMs);
  }
}

const shutdown = async () => {
  if (stopped) return;
  stopped = true;
  clearInterval(stateTimer);
  if (active) {
    const current = active;
    active = null;
    try { await current.session.evaluate('globalThis.__wowserglExternalRuntime?.cleanup?.()', current.contextId); } catch {}
    current.session.close();
  }
  if (bridge && bridge.readyState < WebSocket.CLOSING) bridge.close(1000, 'adapter shutdown');
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await main();
