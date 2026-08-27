import WebSocket from 'ws';
import { loadProfile } from './config.js';

async function api(pathAndQuery, { method = 'GET', body } = {}) {
  const cfg = await loadProfile();
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${cfg.serverUrl}${pathAndQuery}${sep}workspace_id=${cfg.workspaceId}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const responseBody = await res.text().catch(() => '');
    throw new Error(`multica ${method} ${pathAndQuery} -> ${res.status}: ${responseBody.slice(0, 300)}`);
  }
  return res.json();
}

export async function listAgents() {
  return api('/api/agents');
}

export async function listWorkingAgents() {
  return api('/api/working-agents');
}

// open_only=true returns every non-done/cancelled issue with no page limit —
// the workspace's paginated /api/issues caps at 100/page and this fleet's
// build-pipeline churn leaves 2000+ historical rows, most of them done noise
// a live dashboard has no use for.
export async function listOpenIssues() {
  const resp = await api('/api/issues?open_only=true');
  return resp.issues;
}

export async function listAgentTasks(agentId) {
  return api(`/api/agents/${agentId}/tasks`);
}

export async function listTaskMessages(taskId) {
  return api(`/api/tasks/${taskId}/messages`);
}

// Multica's issue URL is /{workspace_slug}/issues/{identifier}. The profile
// only carries the workspace id, not its slug — "engineering" is the Apollo
// Engineering workspace this whole dashboard is hardcoded to, same as
// workspaceId itself.
export async function issueUrlBase() {
  const cfg = await loadProfile();
  return `${cfg.serverUrl}/engineering/issues/`;
}

export async function createComment(issueId, content, parentId) {
  return api(`/api/issues/${issueId}/comments`, {
    method: 'POST',
    body: { content, type: 'comment', parent_id: parentId || null },
  });
}

export async function listComments(issueId) {
  return api(`/api/issues/${issueId}/comments`);
}

export async function getMe() {
  return api('/api/me');
}

// One shared upstream connection multiplexes every locally-connected browser
// tab, mirroring how the Multica web app itself uses the hub: auth once,
// auto-subscribed to the workspace scope, plus on-demand task scopes.
export class UpstreamFeed {
  constructor() {
    this.ws = null;
    this.listeners = new Set();
    this.subscribedTasks = new Set();
    this._connectSafe();
  }

  onMessage(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // connect() is never awaited by its caller (it runs for the connection's
  // whole lifetime), so any rejection — loadProfile failing, a bad URL, a
  // network blip right at reconnect time, all realistic after a sleep/wake
  // cycle — would otherwise be an unhandled rejection. Node kills the whole
  // process on those by default, taking the REST API down with the socket.
  _connectSafe() {
    this.connect().catch((err) => {
      console.error('multica upstream connect failed, retrying in 5s:', err.message || err);
      setTimeout(() => this._connectSafe(), 5000);
    });
  }

  async connect() {
    const cfg = await loadProfile();
    const wsUrl = cfg.serverUrl.replace(/^http/, 'ws') + `/ws?workspace_id=${cfg.workspaceId}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', payload: { token: cfg.token } }));
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'auth_ack') {
        for (const taskId of this.subscribedTasks) this._sendSubscribe(taskId);
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });

    ws.on('close', () => {
      setTimeout(() => this._connectSafe(), 3000);
    });
    ws.on('error', () => ws.close());
  }

  _sendSubscribe(taskId) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', payload: { scope: 'task', id: taskId } }));
    }
  }

  subscribeTask(taskId) {
    if (this.subscribedTasks.has(taskId)) return;
    this.subscribedTasks.add(taskId);
    this._sendSubscribe(taskId);
  }
}
