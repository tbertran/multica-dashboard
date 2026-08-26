import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import * as multica from './multica-client.js';

export const PORT = Number(process.env.MULTICA_DASHBOARD_PORT) || 4175;
const HOST = '127.0.0.1';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

async function serveStatic(req, res) {
  const file = req.url === '/' ? '/index.html' : req.url;
  const full = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

async function sendJSON(res, fn) {
  try {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(await fn()));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/agents') return sendJSON(res, multica.listAgents);
  if (url.pathname === '/api/working-agents') return sendJSON(res, multica.listWorkingAgents);
  if (url.pathname === '/api/issues') return sendJSON(res, multica.listOpenIssues);
  const taskMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/tasks$/);
  if (taskMatch) return sendJSON(res, () => multica.listAgentTasks(taskMatch[1]));
  const msgMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/messages$/);
  if (msgMatch) return sendJSON(res, () => multica.listTaskMessages(msgMatch[1]));
  return serveStatic(req, res);
}

export async function startServer() {
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });

  const feed = new multica.UpstreamFeed();
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (client) => {
    const unsubscribe = feed.onMessage((msg) => {
      if (client.readyState === client.OPEN) client.send(JSON.stringify(msg));
    });
    client.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe' && msg.scope === 'task' && msg.id) {
          feed.subscribeTask(msg.id);
        }
      } catch {}
    });
    client.on('close', unsubscribe);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => resolve(server));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().then(() => {
    console.log(`multica-dashboard listening on http://${HOST}:${PORT}`);
  }).catch((err) => {
    console.error('failed to start:', err);
    process.exit(1);
  });
}
