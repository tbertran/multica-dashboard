import WebSocket from 'ws';
import { loadProfile } from './config.js';

async function api(pathAndQuery, { method = 'GET' } = {}) {
  const cfg = await loadProfile();
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${cfg.serverUrl}${pathAndQuery}${sep}workspace_id=${cfg.workspaceId}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`multica ${method} ${pathAndQuery} -> ${res.status}: ${body.slice(0, 300)}`);
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

// One shared upstream connection multiplexes every locally-connected browser
// tab, mirroring how the Multica web app itself uses the hub: auth once,
// auto-subscribed to the workspace scope, plus on-demand task scopes.
export class UpstreamFeed {
  constructor() {
    this.ws = null;
    this.listeners = new Set();
    this.subscribedTasks = new Set();
    this.connect();
  }

  onMessage(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
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
      setTimeout(() => this.connect(), 3000);
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
