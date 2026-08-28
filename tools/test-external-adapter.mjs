import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { resolve, join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'));
const adapterPath = join(root, 'apps', 'bridge', 'external-runtime-adapter.mjs');
const bootstrapPath = join(root, 'apps', 'bridge', 'vanillagl-runtime-bootstrap.mjs');
const gameViewPath = join(root, 'apps', 'editor', 'src', 'engine', 'runtime-game-view.ts');
const editorBridgePath = join(root, 'apps', 'editor', 'src', 'editor-live-bridge.ts');

const commands = [
  'transform.set','object.spawn','object.delete','object.restore','material.set','material.advanced',
  'environment.set','project.apply','playmode.set','selection.focus','light.preview','behavior.preview',
  'behavior.stop','character.preview','character.clear',
];

const bootstrapSource = readFileSync(bootstrapPath, 'utf8');
const adapterSource = readFileSync(adapterPath, 'utf8');
const gameViewSource = readFileSync(gameViewPath, 'utf8');
const editorBridgeSource = readFileSync(editorBridgePath, 'utf8');

for (const command of commands) assert.ok(bootstrapSource.includes(`case '${command}'`), `bootstrap must consume ${command}`);
assert.ok(bootstrapSource.includes('__wowScene'), 'adapter must use VanillaGL existing QA scene hook');
assert.ok(bootstrapSource.includes('__wowCamera'), 'adapter must use VanillaGL existing QA camera hook');
assert.ok(bootstrapSource.includes("import('/src/model-loader.ts')"), 'character preview must call VanillaGL dev module without modifying VanillaGL');
assert.ok(adapterSource.includes('Runtime.evaluate'), 'Node adapter must control runtime through CDP');
assert.ok(adapterSource.includes("role', 'runtime'"), 'external adapter must be the bridge runtime peer');
assert.ok(!gameViewSource.includes('studioBridge'), 'Game view must not require VanillaGL source integration');
assert.ok(!editorBridgeSource.includes('studioBridge'), 'Open Game must not inject a VanillaGL Studio query contract');
assert.ok(gameViewSource.includes('debugtools'), 'Game view should request only VanillaGL existing debug tooling');

const freePort = () => new Promise((resolvePort, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolvePort(port));
  });
});

class Inbox {
  queue = [];
  waiters = [];
  constructor(socket) {
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      const index = this.waiters.findIndex((entry) => entry.predicate(packet));
      if (index >= 0) {
        const [entry] = this.waiters.splice(index, 1);
        clearTimeout(entry.timer);
        entry.resolve(packet);
      } else this.queue.push(packet);
    });
  }
  wait(predicate, timeout = 7000) {
    const index = this.queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    return new Promise((resolvePacket, reject) => {
      const entry = { predicate, resolve: resolvePacket, timer: null };
      entry.timer = setTimeout(() => {
        const at = this.waiters.indexOf(entry);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error(`Timed out waiting for packet; queued=${JSON.stringify(this.queue)}`));
      }, timeout);
      this.waiters.push(entry);
    });
  }
}

const connect = (url) => new Promise((resolvePeer, reject) => {
  const socket = new WebSocket(url);
  const inbox = new Inbox(socket);
  const timer = setTimeout(() => reject(new Error(`Timed out opening ${url}`)), 5000);
  socket.once('open', () => { clearTimeout(timer); resolvePeer({ socket, inbox }); });
  socket.once('error', (error) => { clearTimeout(timer); reject(error); });
});

const waitForOutput = (child, token, timeout = 7000) => new Promise((resolveWait, reject) => {
  let output = '';
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${token}"\n${output}`)), timeout);
  const append = (chunk) => {
    output += String(chunk);
    if (output.includes(token)) {
      clearTimeout(timer);
      resolveWait(output);
    }
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.once('exit', (code) => {
    if (!output.includes(token)) {
      clearTimeout(timer);
      reject(new Error(`child exited ${code} before "${token}"\n${output}`));
    }
  });
});

const target = { recordId: 'r1', tileKey: 'Azeroth_30_49', kind: 'm2', model: 'World/Test/Test.m2', sourceId: 42 };
const transform = { model: target.model, position: [1,2,3], rotation: [0,0,0,1], scale: 1 };
const environment = { hour: 12, fogNear: 50, fogFar: 500, fogColor: '#778899', weather: 'clear' };
const material = { id:'m1', recordId:'r1', tileKey:target.tileKey, kind:'m2', model:target.model, sourceId:42, locator:{slot:0}, scope:'instance', color:'#ffffff' };
const project = { mapId:0, tileKey:target.tileKey, objects:[{target,state:'modified',transform}], materials:[material], environment };
const payloads = [
  {type:'transform.set',target,transform},
  {type:'object.spawn',target:{...target,recordId:'new',sourceId:undefined},transform},
  {type:'object.delete',target},
  {type:'object.restore',target},
  {type:'material.set',target,override:material},
  {type:'material.advanced',target,material:{locator:{slot:0},scope:'instance',shaderMode:'emissive'}},
  {type:'environment.set',environment},
  {type:'project.apply',project},
  {type:'playmode.set',playing:false},
  {type:'selection.focus',target},
  {type:'light.preview',target,light:{enabled:true,color:'#fff',intensity:1,radius:10}},
  {type:'behavior.preview',target,behavior:{mode:'idle',speed:1,wanderDistance:5,aggroRadius:20,leashRadius:40,loop:true,waypoints:[]}},
  {type:'behavior.stop',target},
  {type:'character.preview',target,character:{race:1,classId:1,gender:0,skin:0,face:0,hairStyle:0,hairColor:0,facialHair:0,level:1,equipment:[]}},
  {type:'character.clear',target},
];

let httpServer, cdpWss, bridgeChild, adapterChild, studio;
try {
  const [cdpPort, cdpWsPort, bridgePort] = await Promise.all([freePort(), freePort(), freePort()]);
  cdpWss = new WebSocketServer({ host: '127.0.0.1', port: cdpWsPort });
  cdpWss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const request = JSON.parse(String(raw));
      if (request.method === 'Runtime.enable') {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
        queueMicrotask(() => socket.send(JSON.stringify({
          method: 'Runtime.executionContextCreated',
          params: { context: { id: 7, origin: 'http://localhost:5173', name: '', auxData: { isDefault: true, frameId: 'vanilla-frame' } } },
        })));
        return;
      }
      if (request.method === 'Runtime.evaluate') {
        const expression = String(request.params?.expression ?? '');
        let value = { version:1, sceneReady:true, source:'wowsergl-external-cdp', capabilities:commands };
        if (expression.includes('.handle(')) {
          const type = commands.find((name) => expression.includes(`"type":"${name}"`)) ?? 'unknown';
          value = `mock external adapter applied ${type}`;
        }
        socket.send(JSON.stringify({ id: request.id, result: { result: { type: typeof value === 'string' ? 'string' : 'object', value } } }));
        return;
      }
      socket.send(JSON.stringify({ id: request.id, result: {} }));
    });
  });

  httpServer = createServer((request, response) => {
    if (request.url === '/json/list') {
      response.setHeader('Content-Type','application/json');
      response.end(JSON.stringify([{
        id:'page-1', type:'page', title:'WowserGL test host', url:'http://localhost:5180/',
        webSocketDebuggerUrl:`ws://127.0.0.1:${cdpWsPort}/devtools/page/page-1`,
      }]));
      return;
    }
    response.statusCode = 404; response.end();
  });
  await new Promise((resolveListen) => httpServer.listen(cdpPort, '127.0.0.1', resolveListen));

  bridgeChild = spawn(process.execPath, [join(root,'apps','bridge','server.mjs')], {
    cwd: root, env:{...process.env, STUDIO_BRIDGE_PORT:String(bridgePort), STUDIO_BRIDGE_HOST:'127.0.0.1'},
    stdio:['ignore','pipe','pipe'],
  });
  await waitForOutput(bridgeChild, `ws://127.0.0.1:${bridgePort}`);

  adapterChild = spawn(process.execPath, [adapterPath], {
    cwd: root,
    env:{
      ...process.env,
      VANILLAGL_CDP_URL:`http://127.0.0.1:${cdpPort}`,
      VANILLAGL_TARGET_ORIGIN:'http://localhost:5173',
      STUDIO_BRIDGE_URL:`ws://127.0.0.1:${bridgePort}`,
      VANILLAGL_ADAPTER_RETRY_MS:'300',
    },
    stdio:['ignore','pipe','pipe'],
  });
  await waitForOutput(adapterChild, 'Found VanillaGL QA context');

  const peer = await connect(`ws://127.0.0.1:${bridgePort}/?role=studio&client=External%20Adapter%20Test`);
  studio = peer.socket;
  const inbox = peer.inbox;
  await inbox.wait((packet) => packet.type === 'bridge.hello');
  await inbox.wait((packet) => packet.type === 'bridge.peers' && packet.runtimes === 1);
  const state = await inbox.wait((packet) => packet.type === 'runtime.state' && packet.sceneReady === true);
  assert.equal(state.runtime, 'WowserGL External VanillaGL Adapter');

  for (let i = 0; i < payloads.length; i++) {
    const command = payloads[i];
    const id = `external-${i}-${command.type}`;
    studio.send(JSON.stringify({type:'bridge.command',id,command}));
    const ack = await inbox.wait((packet) => packet.type === 'bridge.ack' && packet.id === id);
    assert.equal(ack.ok, true, `${command.type} should ACK through CDP adapter`);
    assert.equal(ack.runtime, 'WowserGL External VanillaGL Adapter');
    assert.match(ack.message, new RegExp(command.type.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  }

  console.log(`[engine-test] external CDP adapter round-tripped ${payloads.length} command families without modifying VanillaGL`);
} finally {
  if (studio) studio.close();
  for (const child of [adapterChild, bridgeChild]) {
    if (child && child.exitCode === null) child.kill('SIGTERM');
  }
  if (cdpWss) await new Promise((resolveClose) => cdpWss.close(resolveClose));
  if (httpServer) await new Promise((resolveClose) => httpServer.close(resolveClose));
}
