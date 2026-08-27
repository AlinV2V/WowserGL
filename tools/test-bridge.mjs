import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'));
const temp = mkdtempSync(join(tmpdir(), 'wowsergl-bridge-'));
const projectPath = join(temp, 'live-project.json');

const freePort = () => new Promise((resolvePort, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolvePort(port));
  });
});

const waitForOutput = (child, token, timeout = 5000) => new Promise((resolveWait, reject) => {
  let output = '';
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for bridge output: ${token}\n${output}`)), timeout);
  const onData = (chunk) => {
    output += String(chunk);
    if (!output.includes(token)) return;
    clearTimeout(timer);
    child.stdout.off('data', onData);
    resolveWait(output);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  child.once('exit', (code) => {
    if (!output.includes(token)) {
      clearTimeout(timer);
      reject(new Error(`Bridge exited before becoming ready (${code}).\n${output}`));
    }
  });
});

class Inbox {
  queue = [];
  waiters = [];

  constructor(socket) {
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      const index = this.waiters.findIndex((waiter) => waiter.predicate(packet));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(packet);
      } else this.queue.push(packet);
    });
  }

  wait(predicate, timeout = 3500) {
    const index = this.queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    return new Promise((resolvePacket, reject) => {
      const waiter = { predicate, resolve: resolvePacket, timer: null };
      waiter.timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error(`Timed out waiting for packet. Queue: ${JSON.stringify(this.queue)}`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }
}

const connect = (url) => new Promise((resolveSocket, reject) => {
  const socket = new WebSocket(url);
  const timer = setTimeout(() => { socket.terminate(); reject(new Error(`Timed out connecting ${url}`)); }, 3500);
  socket.once('open', () => { clearTimeout(timer); resolveSocket(socket); });
  socket.once('error', (error) => { clearTimeout(timer); reject(error); });
});

const send = (socket, packet) => socket.send(JSON.stringify(packet));
const close = (socket) => new Promise((resolveClose) => {
  if (socket.readyState === WebSocket.CLOSED) return resolveClose();
  socket.once('close', resolveClose);
  socket.close(1000, 'test complete');
  setTimeout(() => { if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); }, 500).unref();
});

const target = { recordId: 'record-1', tileKey: 'Azeroth_30_49', kind: 'm2', model: 'World/Test/Test.m2', sourceId: 42 };
const transform = { model: target.model, position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: 1 };
const environment = { hour: 18.5, fogNear: 120, fogFar: 900, fogColor: '#778899', weather: 'rain' };
const material = {
  id: 'material-1', recordId: target.recordId, tileKey: target.tileKey, kind: target.kind, model: target.model, sourceId: target.sourceId,
  locator: { slot: 0, materialIndex: 0 }, scope: 'instance', color: '#ff0000', textureUrl: '/textures/test.webp',
};
const project = {
  mapId: 0,
  tileKey: target.tileKey,
  objects: [{ target, state: 'modified', transform }],
  materials: [material],
  environment,
};

const commands = [
  { type: 'transform.set', target, transform },
  { type: 'object.spawn', target: { ...target, recordId: 'spawn-1', sourceId: undefined }, transform },
  { type: 'object.delete', target },
  { type: 'object.restore', target },
  { type: 'material.set', target, override: material },
  { type: 'environment.set', environment },
  { type: 'project.apply', project },
  { type: 'playmode.set', playing: true },
  { type: 'selection.focus', target },
];

let child;
let studio;
let runtime;
try {
  const port = await freePort();
  child = spawn(process.execPath, [join(root, 'apps', 'bridge', 'server.mjs')], {
    cwd: root,
    env: { ...process.env, STUDIO_BRIDGE_PORT: String(port), STUDIO_BRIDGE_HOST: '127.0.0.1', STUDIO_PROJECT_PATH: projectPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForOutput(child, `ws://127.0.0.1:${port}`);

  studio = await connect(`ws://127.0.0.1:${port}/?role=studio&client=Bridge%20Test%20Studio`);
  const studioInbox = new Inbox(studio);
  await studioInbox.wait((packet) => packet.type === 'bridge.hello' && packet.role === 'studio');

  runtime = await connect(`ws://127.0.0.1:${port}/?role=runtime&client=Bridge%20Test%20Runtime`);
  const runtimeInbox = new Inbox(runtime);
  await runtimeInbox.wait((packet) => packet.type === 'bridge.hello' && packet.role === 'runtime');
  await studioInbox.wait((packet) => packet.type === 'bridge.peers' && packet.runtimes === 1);

  for (let index = 0; index < commands.length; index++) {
    const command = commands[index];
    const id = `command-${index}-${command.type}`;
    send(studio, { type: 'bridge.command', id, command, persist: command.type === 'project.apply' });
    const forwarded = await runtimeInbox.wait((packet) => packet.type === 'bridge.command' && packet.id === id);
    assert.deepEqual(forwarded.command, command, `${command.type} must relay unchanged to the runtime`);
    send(runtime, { type: 'bridge.ack', id, commandType: command.type, ok: true, message: 'test ack' });
    const ack = await studioInbox.wait((packet) => packet.type === 'bridge.ack' && packet.id === id);
    assert.equal(ack.ok, true, `${command.type} ACK must return to Studio`);
    assert.equal(ack.runtime, 'Bridge Test Runtime', `${command.type} ACK must identify the runtime`);
  }

  send(runtime, { type: 'runtime.state', runtime: 'ignored-by-bridge', sceneReady: true, mapId: 0, tileKey: target.tileKey });
  const state = await studioInbox.wait((packet) => packet.type === 'runtime.state' && packet.sceneReady === true);
  assert.equal(state.runtime, 'Bridge Test Runtime', 'runtime.state must be enriched with the connected runtime name');

  const saveId = 'project-save-1';
  send(studio, { type: 'project.save', id: saveId, project });
  const saved = await studioInbox.wait((packet) => packet.type === 'project.saved' && packet.id === saveId);
  assert.equal(saved.ok, true, 'project.save must persist successfully');
  assert.deepEqual(JSON.parse(readFileSync(projectPath, 'utf8')), project, 'persisted live project must match Studio payload');

  const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.studios, 1);
  assert.equal(health.runtimes, 1);
  assert.equal(health.projectCached, true);

  console.log(`[engine-test] live bridge round-tripped ${commands.length} command families and project persistence`);
} finally {
  if (studio) await close(studio).catch(() => {});
  if (runtime) await close(runtime).catch(() => {});
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolveExit) => {
      child.once('exit', resolveExit);
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolveExit(); }, 1000).unref();
    });
  }
  rmSync(temp, { recursive: true, force: true });
}
