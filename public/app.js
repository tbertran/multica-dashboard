const agentBar = document.getElementById('agent-bar');
const issueTree = document.getElementById('issue-tree');
const transcriptHeader = document.getElementById('transcript-header');
const transcriptLog = document.getElementById('transcript-log');
const showAllCheckbox = document.getElementById('show-all');
const issueCountEl = document.getElementById('issue-count');

let agents = new Map();          // id -> agent
let workingIssueIds = new Map(); // issue_id -> agent_id
let issues = [];
let selectedIssueId = null;
let selectedTaskId = null;
let collapsed = new Set();
let showAll = false;

// Only narration reaches the transcript panel — tool_use/tool_result frames
// are the agent's mechanics, not what a human watching the work wants to read.
const NARRATION_TYPES = new Set(['text', 'error']);

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function refreshAll() {
  const [agentList, working, issueList] = await Promise.all([
    getJSON('/api/agents'),
    getJSON('/api/working-agents'),
    getJSON('/api/issues'),
  ]);
  agents = new Map(agentList.map((a) => [a.id, a]));
  workingIssueIds = new Map();
  for (const w of working) {
    for (const issueId of w.issue_ids || []) workingIssueIds.set(issueId, w.id);
  }
  issues = issueList;
  renderAgentBar();
  renderIssueTree();
}

function renderAgentBar() {
  agentBar.innerHTML = '';
  const workingAgentIds = [...new Set(workingIssueIds.values())];
  if (!workingAgentIds.length) {
    agentBar.innerHTML = '<span class="empty">No agents currently working</span>';
    return;
  }
  for (const id of workingAgentIds) {
    const agent = agents.get(id);
    if (!agent) continue;
    const chip = document.createElement('div');
    chip.className = 'agent-chip';
    chip.innerHTML = `<span class="dot"></span><span>${escapeHtml(agent.name)}</span>`;
    agentBar.appendChild(chip);
  }
}

function buildTree() {
  const byParent = new Map();
  const byId = new Map(issues.map((i) => [i.id, i]));
  for (const issue of issues) {
    // A parent that isn't in the open set (already done/cancelled while this
    // child is still active) must not silently drop the child — treat it as
    // a root too, so it stays visible.
    const hasOpenParent = issue.parent_issue_id && byId.has(issue.parent_issue_id);
    const key = hasOpenParent ? issue.parent_issue_id : 'root';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(issue);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.position - b.position);
  return { byParent, byId };
}

// Default view: an issue plus the chain of ancestors that gives it context.
// Without the ancestor walk a live sub-issue would render as a root with its
// pipeline stripped of the delivery it belongs to.
function liveKeepSet(byId) {
  const keep = new Set();
  for (const issueId of workingIssueIds.keys()) {
    let cur = byId.get(issueId);
    while (cur && !keep.has(cur.id)) {
      keep.add(cur.id);
      cur = cur.parent_issue_id ? byId.get(cur.parent_issue_id) : null;
    }
  }
  return keep;
}

function renderIssueTree() {
  const { byParent, byId } = buildTree();
  const keep = showAll ? null : liveKeepSet(byId);
  issueTree.innerHTML = '';
  const roots = byParent.get('root') || [];
  let shown = 0;
  for (const issue of roots) {
    const node = renderIssueNode(issue, byParent, 0, keep);
    if (node) {
      issueTree.appendChild(node);
      shown++;
    }
  }
  if (!shown) {
    issueTree.innerHTML = '<div class="transcript-empty" style="padding:10px">Nothing actively worked on right now.</div>';
  }
  issueCountEl.textContent = showAll
    ? `${issues.length} open issues`
    : `${keep.size} shown (${workingIssueIds.size} active)`;
}

function renderIssueNode(issue, byParent, depth, keep) {
  if (keep && !keep.has(issue.id)) return null;
  const children = byParent.get(issue.id) || [];
  const visibleChildren = keep ? children.filter((c) => keep.has(c.id)) : children;
  const isCollapsed = collapsed.has(issue.id);
  const agent = issue.assignee_id ? agents.get(issue.assignee_id) : null;
  const isLive = workingIssueIds.has(issue.id);

  const wrapper = document.createElement('div');
  const row = document.createElement('div');
  row.className = `issue-row status-${issue.status_category || issue.status}` + (issue.id === selectedIssueId ? ' selected' : '');
  row.style.paddingLeft = `${8 + depth * 16}px`;
  row.innerHTML = `
    <span class="issue-toggle">${visibleChildren.length ? (isCollapsed ? '▸' : '▾') : ''}</span>
    <span class="status-dot"></span>
    <span class="issue-id">${escapeHtml(issue.identifier)}</span>
    ${isLive ? '<span class="working-badge">● Working</span>' : ''}
    <span class="issue-title" title="${escapeHtml(issue.title)}">${escapeHtml(issue.title)}</span>
    ${agent ? `<span class="issue-agent">${escapeHtml(agent.name)}</span>` : ''}
  `;
  row.querySelector('.issue-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!visibleChildren.length) return;
    if (isCollapsed) collapsed.delete(issue.id); else collapsed.add(issue.id);
    renderIssueTree();
  });
  row.addEventListener('click', () => selectIssue(issue));
  wrapper.appendChild(row);

  if (!isCollapsed) {
    for (const child of visibleChildren) {
      const childNode = renderIssueNode(child, byParent, depth + 1, keep);
      if (childNode) wrapper.appendChild(childNode);
    }
  }
  return wrapper;
}

async function selectIssue(issue) {
  selectedIssueId = issue.id;
  renderIssueTree();
  transcriptLog.innerHTML = '';
  const agentId = workingIssueIds.get(issue.id);
  if (!agentId) {
    selectedTaskId = null;
    transcriptHeader.textContent = `${issue.identifier} — ${issue.title} (no active agent session)`;
    return;
  }
  transcriptHeader.textContent = `${issue.identifier} — ${issue.title} — loading…`;
  const tasks = await getJSON(`/api/agents/${agentId}/tasks`);
  const task = tasks.find((t) => t.status === 'running' && t.issue_id === issue.id);
  if (!task) {
    selectedTaskId = null;
    transcriptHeader.textContent = `${issue.identifier} — ${issue.title} (no running task found)`;
    return;
  }
  selectedTaskId = task.id;
  const agentName = agents.get(agentId)?.name || agentId;
  transcriptHeader.textContent = `${issue.identifier} — ${issue.title} — ${agentName}`;
  const messages = await getJSON(`/api/tasks/${task.id}/messages`);
  const narration = messages.filter((m) => NARRATION_TYPES.has(m.type));
  if (!narration.length) {
    transcriptLog.innerHTML = '<div class="transcript-empty">No narration yet — the agent is working silently.</div>';
  }
  for (const m of narration) appendMessage(m);
  ws?.send(JSON.stringify({ type: 'subscribe', scope: 'task', id: task.id }));
}

function relativeTime(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function appendMessage(m) {
  if (!NARRATION_TYPES.has(m.type)) return;
  const empty = transcriptLog.querySelector('.transcript-empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'narration';
  const text = m.content || m.output || '';
  el.innerHTML = `<div class="body">${escapeHtml(text)}</div><div class="time">${escapeHtml(relativeTime(m.created_at))}</div>`;
  transcriptLog.appendChild(el);
  transcriptLog.scrollTop = transcriptLog.scrollHeight;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

showAllCheckbox.addEventListener('change', () => {
  showAll = showAllCheckbox.checked;
  renderIssueTree();
});

let ws;
let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshAll().catch((err) => console.error(err));
  }, 1500);
}

function connectWS() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'task:message' && msg.payload?.task_id === selectedTaskId) {
      appendMessage(msg.payload);
      return;
    }
    if (typeof msg.type === 'string' && (msg.type.startsWith('issue:') || msg.type.startsWith('task:') || msg.type.startsWith('agent:'))) {
      scheduleRefresh();
    }
  });
  ws.addEventListener('close', () => setTimeout(connectWS, 3000));
}

refreshAll().catch((err) => {
  transcriptHeader.textContent = `Failed to load: ${err.message}`;
});
connectWS();
