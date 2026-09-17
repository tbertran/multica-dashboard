import WebSocket from 'ws';
import { execFile } from 'node:child_process';
import { loadProfile } from './config.js';

// "ready → Flight (delivery)" — the autopilot that fires when a Linear FLT ticket
// is dragged into "Ready for Agent". A lookup with no matching run here means the
// ticket simply hasn't been dragged yet, not that the lookup failed.
const FLIGHT_DELIVERY_AUTOPILOT_ID = process.env.MULTICA_FLIGHT_AUTOPILOT_ID || 'b22e8b25-3bff-4df1-a6db-09ac30bf0f1b';

// No REST equivalent exists for "the work-run task tied to this issue" (both
// plausible paths 404); the nearest REST substitute is one agent's entire,
// unbounded task history with no server-side issue filter. The CLI has a command
// built for exactly this, so this is the one deliberate CLI shell-out in a file
// that otherwise talks straight REST.
async function cli(...args) {
  const cfg = await loadProfile();
  return new Promise((resolve, reject) => {
    execFile('multica', ['--profile', cfg.profile, '--workspace-id', cfg.workspaceId, ...args, '--output', 'json'],
      { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`multica ${args.join(' ')} -> ${stderr || err.message}`));
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          reject(new Error(`multica ${args.join(' ')} returned non-JSON: ${parseErr.message}`));
        }
      });
  });
}

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
// only carries the workspace id, not its slug, so the slug has to come from
// somewhere else — set MULTICA_WORKSPACE_SLUG. Without it, issues just don't
// get a link (setTranscriptTitle already degrades to plain text).
export async function issueUrlBase() {
  const slug = process.env.MULTICA_WORKSPACE_SLUG;
  if (!slug) return null;
  const cfg = await loadProfile();
  return `${cfg.serverUrl}/${slug}/issues/`;
}

export async function getIssue(identifier) {
  return api(`/api/issues/${identifier}`);
}

// The runs list has no server-side search, so a lookup pages through the whole
// history and matches client-side. A short in-memory cache keeps repeated lookups
// (typos, re-checking the same ticket) from re-paging every time; 30s is short
// enough that a just-dragged ticket still shows up promptly.
let runsCache = { at: 0, runs: [] };
async function allFlightDeliveryRuns() {
  if (Date.now() - runsCache.at < 30_000) return runsCache.runs;
  const runs = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = await api(`/api/autopilots/${FLIGHT_DELIVERY_AUTOPILOT_ID}/runs?limit=${limit}&offset=${offset}`);
    runs.push(...page.runs);
    if (page.runs.length < limit) break;
  }
  runsCache = { at: Date.now(), runs };
  return runs;
}

// A ticket's delivery run is found by text-matching its identifier inside the
// gate run's own prose report — the runs API has no foreign key to either the
// triggering Linear ticket or the delivery issue it creates (both are stamped
// only in that free-text `result.output`). Multiple matches mean the ticket was
// dragged more than once (e.g. re-dispatched after being blocked).
export async function findFltDeliveryRuns(fltIdentifier) {
  const runs = await allFlightDeliveryRuns();
  const pattern = new RegExp(`\\b${fltIdentifier}\\b`);
  return runs.filter((r) => pattern.test(r.result?.output || ''));
}

export function extractEngIdentifier(runOutput) {
  const bold = runOutput.match(/\*\*(ENG-\d+)\*\*/);
  if (bold) return bold[1];
  const plain = runOutput.match(/ENG-\d+/);
  return plain ? plain[0] : null;
}

const LINEAR_HISTORY_QUERY = (identifier) => `query { issue(id:"${identifier}") {
  identifier updatedAt branchName url
  assignee { name }
  state { name }
  priority
  parent { identifier }
  history(first: 20) {
    nodes { createdAt fromState { name } toState { name } actor { name } updatedDescription }
  }
} }`;

// Linear groups an actor's edits: a later description edit can merge into a
// state-transition history entry and restamp its createdAt several minutes late.
// A node carrying both a state change AND updatedDescription is that restamped
// case — flagged here (never dropped) so the UI can mark its time as approximate
// rather than treat it as the authoritative drag moment (that's `run.triggered_at`).
function normalizeLinearHistory(nodes) {
  return (nodes || []).map((n) => ({
    createdAt: n.createdAt,
    fromState: n.fromState?.name || null,
    toState: n.toState?.name || null,
    actor: n.actor?.name || null,
    timestampApproximate: Boolean((n.fromState || n.toState) && n.updatedDescription),
  })).filter((n) => n.fromState || n.toState);
}

export async function linearIssue(fltIdentifier) {
  const raw = await new Promise((resolve, reject) => {
    execFile('linear', ['api', LINEAR_HISTORY_QUERY(fltIdentifier)], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`linear api -> ${stderr || err.message}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (parseErr) {
        reject(new Error(`linear api returned non-JSON: ${parseErr.message}`));
      }
    });
  });
  if (raw.errors?.length) throw new Error(raw.errors.map((e) => e.message).join('; '));
  const issue = raw.data?.issue;
  if (!issue) return null;
  return {
    identifier: issue.identifier,
    url: issue.url,
    state: issue.state?.name || null,
    assignee: issue.assignee?.name || null,
    priority: issue.priority,
    branchName: issue.branchName,
    parent: issue.parent?.identifier || null,
    updatedAt: issue.updatedAt,
    history: normalizeLinearHistory(issue.history?.nodes),
  };
}

// The single answer to "what's up with FLT-<n>": every delivery Flight has run
// for the ticket (newest first), each with its own gate-run and work-run timeline,
// plus Linear's current state as supplementary context. An empty `deliveries` list
// means the ticket has never been dragged into "Ready for Agent".
export async function fltStatus(rawNumber) {
  const fltIdentifier = `FLT-${String(rawNumber).replace(/^FLT-/i, '')}`;
  const [runs, linear] = await Promise.all([
    findFltDeliveryRuns(fltIdentifier),
    linearIssue(fltIdentifier).catch((err) => ({ error: err.message })),
  ]);

  const deliveries = await Promise.all(
    runs.sort((a, b) => new Date(b.triggered_at) - new Date(a.triggered_at)).map(async (run) => {
      const engIdentifier = extractEngIdentifier(run.result?.output || '');
      const [engIssue, workRuns] = await Promise.all([
        engIdentifier ? getIssue(engIdentifier).catch(() => null) : null,
        engIdentifier ? issueRuns(engIdentifier).catch(() => []) : [],
      ]);
      return {
        runId: run.id,
        status: run.status,
        failureReason: run.failure_reason,
        triggeredAt: run.triggered_at,
        completedAt: run.completed_at,
        gateOutput: run.result?.output || null,
        engIdentifier,
        engIssue: engIssue ? {
          id: engIssue.id,
          title: engIssue.title,
          status: engIssue.status,
          statusCategory: engIssue.status_category,
          createdAt: engIssue.created_at,
          updatedAt: engIssue.updated_at,
          assigneeId: engIssue.assignee_id,
        } : null,
        workRuns: workRuns.map((t) => ({
          id: t.id,
          status: t.status,
          attempt: t.attempt,
          maxAttempts: t.max_attempts,
          createdAt: t.created_at,
          dispatchedAt: t.dispatched_at,
          startedAt: t.started_at,
          completedAt: t.completed_at,
          error: t.error,
        })),
      };
    })
  );

  return { fltIdentifier, linear, deliveries };
}

// No REST path answers "the work-run task for this issue" (see the `cli()` note
// above), so this one goes through the CLI. Returns a bare array (empty once no
// task has been dispatched for the issue yet).
export async function issueRuns(issueUuid) {
  return cli('issue', 'runs', issueUuid);
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

// The "Origin" custom property carries the originating FLT identifier
// (e.g. "FLT-24") on every issue descended from a Linear ticket. Its id is
// workspace-specific, so it's looked up by name once and cached rather than
// hardcoded — a recreated workspace would otherwise silently break the filter.
let originPropertyIdCache = null;
export async function originPropertyId() {
  if (originPropertyIdCache) return originPropertyIdCache;
  const resp = await api('/api/properties');
  const prop = resp.properties.find((p) => p.name === 'Origin');
  originPropertyIdCache = prop ? prop.id : null;
  return originPropertyIdCache;
}

const LINEAR_ASSIGNEE = process.env.LINEAR_ASSIGNEE_USERNAME || 'tbertran';

// linear-cli has no bulk endpoint faster than one `issue query`, so this is
// cached briefly rather than re-shelling out on every dashboard refresh.
let myFltCache = { at: 0, ids: [] };
export async function myFltIdentifiers() {
  if (Date.now() - myFltCache.at < 60_000) return myFltCache.ids;
  const ids = await new Promise((resolve, reject) => {
    execFile('linear', [
      'issue', 'query', '--team', 'FLT', '--assignee', LINEAR_ASSIGNEE,
      '--all-states', '--limit', '0', '--json', '--no-pager',
    ], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`linear issue query -> ${stderr || err.message}`));
      try {
        resolve(JSON.parse(stdout).nodes.map((n) => n.identifier));
      } catch (parseErr) {
        reject(new Error(`linear issue query returned non-JSON: ${parseErr.message}`));
      }
    });
  });
  myFltCache = { at: Date.now(), ids };
  return ids;
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
