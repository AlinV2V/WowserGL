import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { WebSocket, WebSocketServer } from 'ws';

const port = Number(process.env.STUDIO_BRIDGE_PORT ?? 5191);
const host = process.env.STUDIO_BRIDGE_HOST ?? '127.0.0.1';
const projectPath = path.resolve(process.env.STUDIO_PROJECT_PATH ?? 'project/live-project.json');
const clients = new Map();
let cachedProject = null;

try {
  cachedProject = JSON.parse(await readFile(projectPath, 'utf8'));
  console.log(`[bridge] restored ${projectPath}`);
} catch {
  // A new workspace has no saved live project yet.
}

const counts = () => {
  let runtimes = 0, studios = 0;
  for (const client of clients.values()) {
    if (client.role === 'runtime') runtimes++;
    if (client.role === 'studio') studios++;
  }
  return { runtimes, studios };
};

const send = (socket, packet) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(packet));
};

const broadcast = (role, packet) => {
  for (const [socket, client] of clients) if (client.role === role) send(socket, packet);
};

const announcePeers = () => {
  const peers = { type: 'bridge.peers', ...counts() };
  for (const socket of clients.keys()) send(socket, peers);
};

const server = http.createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (request.url === '/health') {
    response.end(JSON.stringify({ ok: true, ...counts(), projectPath, projectCached: !!cachedProject }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ ok: false, error: 'not found' }));
});

const wss = new WebSocketServer({ server });
wss.on('connection', (socket, request) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`);
  const role = url.searchParams.get('role') === 'runtime' ? 'runtime' : 'studio';
  const name = url.searchParams.get('client') || (role === 'runtime' ? 'VanillaGL Runtime' : 'Studio');
  const id = randomUUID();
  clients.set(socket, { id, role, name });
  const peerCounts = counts();
  send(socket, { type: 'bridge.hello', role, id, ...peerCounts, cachedProject: cachedProject ?? undefined });
  announcePeers();
  console.log(`[bridge] ${role} connected: ${name} (${peerCounts.studios} studio / ${peerCounts.runtimes} runtime)`);

  socket.on('message', async (data) => {
    let packet;
    try {
      packet = JSON.parse(String(data));
    } catch {
      send(socket, { type: 'bridge.log', level: 'error', message: 'Ignored malformed JSON packet.' });
      return;
    }
    const client = clients.get(socket);
    if (!client) return;

    if (client.role === 'studio' && packet.type === 'bridge.command') {
      if (packet.command?.type === 'project.apply' && packet.persist) cachedProject = packet.command.project;
      broadcast('runtime', packet);
      if (counts().runtimes === 0) {
        send(socket, { type: 'bridge.log', level: 'warn', message: `${packet.command?.type ?? 'command'} queued with no runtime connected.` });
      }
      return;
    }

    if (client.role === 'studio' && packet.type === 'project.save') {
      try {
        cachedProject = packet.project;
        await mkdir(path.dirname(projectPath), { recursive: true });
        await writeFile(projectPath, `${JSON.stringify(packet.project, null, 2)}\n`, 'utf8');
        send(socket, { type: 'project.saved', id: packet.id, path: projectPath, ok: true });
        console.log(`[bridge] saved project: ${projectPath}`);
      } catch (error) {
        send(socket, { type: 'project.saved', id: packet.id, path: projectPath, ok: false, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (client.role === 'runtime' && (packet.type === 'bridge.ack' || packet.type === 'bridge.log' || packet.type === 'runtime.state')) {
      const enriched = { ...packet, runtime: client.name };
      broadcast('studio', enriched);
    }
  });

  socket.on('close', () => {
    const client = clients.get(socket);
    clients.delete(socket);
    console.log(`[bridge] ${client?.role ?? 'client'} disconnected: ${client?.name ?? id}`);
    announcePeers();
  });
});

server.listen(port, host, () => {
  console.log(`[bridge] VanillaGL Studio live bridge ws://${host}:${port}`);
  console.log(`[bridge] project store: ${projectPath}`);
});

const shutdown = () => {
  for (const socket of clients.keys()) socket.close(1001, 'bridge shutdown');
  wss.close(() => server.close(() => process.exit(0)));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
