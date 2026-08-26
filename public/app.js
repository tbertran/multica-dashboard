const agentBar = document.getElementById('agent-bar');
const issueTree = document.getElementById('issue-tree');
const transcriptHeader = document.getElementById('transcript-header');
const transcriptLog = document.getElementById('transcript-log');

let agents = new Map();      // id -> agent
let workingIssueIds = new Map(); // issue_id -> agent_id
let issues = [];
let selectedIssueId = null;
let selectedTaskId = null;
let collapsed = new Set();

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function statusClass(issue) {
  return `status-${issue.status_category || issue.status}`;
}

async function refreshAll() {
  const [agentList, working, issueResp] = await Promise.all([
    getJSON('/api/agents'),
    getJSON('/api/working-agents'),
    getJSON('/api/issues'),
  ]);
  agents = new Map(agentList.map((a) => [a.id, a]));
  workingIssueIds = new Map();
  for (const w of working) {
    for (const issueId of w.issue_ids || []) workingIssueIds.set(issueId, w.id);
  }
  issues = issueResp;
  renderAgentBar();
  renderIssueTree();
}

function renderAgentBar() {
  agentBar.innerHTML = '';
  const workingAgentIds = new Set(workingIssueIds.values());
  for (const agent of agents.values()) {
    const chip = document.createElement('div');
    chip.className = 'agent-chip' + (workingAgentIds.has(agent.id) ? ' working' : '');
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

function renderIssueTree() {
  const { byParent } = buildTree();
  issueTree.innerHTML = '';
  const roots = byParent.get('root') || [];
  for (const issue of roots) issueTree.appendChild(renderIssueNode(issue, byParent, 0));
}

function renderIssueNode(issue, byParent, depth) {
  const wrapper = document.createElement('div');
  const children = byParent.get(issue.id) || [];
  const isCollapsed = collapsed.has(issue.id);
  const agent = issue.assignee_id ? agents.get(issue.assignee_id) : null;
  const isLive = workingIssueIds.has(issue.id);

  const row = document.createElement('div');
  row.className = 'issue-row' + (issue.id === selectedIssueId ? ' selected' : '');
  row.style.paddingLeft = `${6 + depth * 16}px`;
  row.innerHTML = `
    <span class="issue-toggle">${children.length ? (isCollapsed ? '▸' : '▾') : ''}</span>
    <span class="issue-id">${escapeHtml(issue.identifier)}</span>
    <span class="status-badge ${statusClass(issue)}">${escapeHtml(issue.status)}</span>
    ${isLive ? '<span class="live-marker"></span>' : ''}
    <span class="issue-title" title="${escapeHtml(issue.title)}">${escapeHtml(issue.title)}</span>
    ${agent ? `<span class="issue-agent">${escapeHtml(agent.name)}</span>` : ''}
  `;
  row.querySelector('.issue-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!children.length) return;
    if (isCollapsed) collapsed.delete(issue.id); else collapsed.add(issue.id);
    renderIssueTree();
  });
  row.addEventListener('click', () => selectIssue(issue));
  wrapper.appendChild(row);

  if (!isCollapsed) {
    for (const child of children) wrapper.appendChild(renderIssueNode(child, byParent, depth + 1));
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
  transcriptHeader.textContent = `${issue.identifier} — ${issue.title} — loading transcript…`;
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
  for (const m of messages) appendMessage(m);
  ws?.send(JSON.stringify({ type: 'subscribe', scope: 'task', id: task.id }));
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + `\n… truncated (${s.length} chars)` : s;
}

function appendMessage(m) {
  const el = document.createElement('div');
  el.className = `msg msg-${m.type}`;
  if (m.type === 'text') {
    el.innerHTML = `<div class="msg-body">${escapeHtml(m.content || '')}</div>`;
  } else if (m.type === 'tool_use') {
    el.innerHTML = `<div class="msg-kind">→ ${escapeHtml(m.tool || 'tool')}</div><div class="msg-body">${escapeHtml(truncate(JSON.stringify(m.input, null, 2), 2000))}</div>`;
  } else if (m.type === 'tool_result') {
    el.innerHTML = `<div class="msg-kind">← ${escapeHtml(m.tool || 'result')}</div><div class="msg-body">${escapeHtml(truncate(m.output || '', 4000))}</div>`;
  } else {
    el.innerHTML = `<div class="msg-body">${escapeHtml(m.content || m.output || '')}</div>`;
  }
  transcriptLog.appendChild(el);
  transcriptLog.scrollTop = transcriptLog.scrollHeight;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
