import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import * as multica from './multica-client.js';

export const PORT = Number(process.env.MULTICA_DASHBOARD_PORT) || 4175;
const HOST = '0.0.0.0';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };

// This runs unattended overnight with no one watching a terminal, so one bad
// error must not take the whole dashboard down with it — log and keep
// serving rather than let Node's default (crash the process) apply.
process.on('uncaughtException', (err) => console.error('uncaught exception (server kept running):', err));
process.on('unhandledRejection', (err) => console.error('unhandled rejection (server kept running):', err));

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

async function readJSONBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
}

async function sendJSON(res, fn) {
  try {
    const data = JSON.stringify(await fn());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(data);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
}

// The dashboard runs inside an isolated Brave app-mode profile, so a plain
// <a target="_blank"> opens a new window in THAT profile rather than a tab in
// the user's real browser. Handing the URL to the OS's own "open" verb opens
// it through the default browser instead, which reuses an already-running
// window as a normal new tab. Scheme-restricted to http(s) since this
// ultimately shells out — narration/comment markdown can link anywhere
// (GitHub, Linear, ...), not just back into Multica.
async function openExternal(res, rawUrl) {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    res.writeHead(400);
    res.end('url not allowed');
    return;
  }
  execFile('cmd.exe', ['/c', 'start', '', rawUrl], (err) => {
    if (err) {
      res.writeHead(500);
      res.end(String(err));
      return;
    }
    res.writeHead(204);
    res.end();
  });
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/open') return openExternal(res, url.searchParams.get('url'));
  if (url.pathname === '/api/config') return sendJSON(res, async () => ({ issueUrlBase: await multica.issueUrlBase() }));
  if (url.pathname === '/api/agents') return sendJSON(res, multica.listAgents);
  if (url.pathname === '/api/working-agents') return sendJSON(res, multica.listWorkingAgents);
  if (url.pathname === '/api/issues') return sendJSON(res, multica.listOpenIssues);
  const taskMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/tasks$/);
  if (taskMatch) return sendJSON(res, () => multica.listAgentTasks(taskMatch[1]));
  const msgMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/messages$/);
  if (msgMatch) return sendJSON(res, () => multica.listTaskMessages(msgMatch[1]));
  const commentMatch = url.pathname.match(/^\/api\/issues\/([^/]+)\/comments$/);
  if (commentMatch && req.method === 'POST') {
    return sendJSON(res, async () => {
      const body = await readJSONBody(req);
      return multica.createComment(commentMatch[1], body.content, body.parent_id);
    });
  }
  if (commentMatch && req.method === 'GET') {
    return sendJSON(res, () => multica.listComments(commentMatch[1]));
  }
  if (url.pathname === '/api/me') return sendJSON(res, multica.getMe);
  if (url.pathname === '/vendor/marked.js') {
    const body = await readFile(path.join(ROOT, 'node_modules/marked/lib/marked.esm.js'));
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(body);
    return;
  }
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
