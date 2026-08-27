import { marked } from '/vendor/marked.js';

marked.setOptions({ breaks: true });

// Narration and comment content is internal Multica output, not arbitrary
// public input, but sanitizing anyway is cheap insurance against a prompt
// injection landing raw HTML in a comment we then render verbatim.
function sanitizeHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const remove = [];
  for (const el of template.content.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED'].includes(el.tagName)) {
      remove.push(el);
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  }
  for (const el of remove) el.remove();
  return template.innerHTML;
}

function renderMarkdown(text) {
  return sanitizeHtml(marked.parse(text || ''));
}

const agentBar = document.getElementById('agent-bar');
const issueTree = document.getElementById('issue-tree');
const divider = document.getElementById('divider');
const transcriptTitle = document.getElementById('transcript-title');
const transcriptLog = document.getElementById('transcript-log');
const showAllCheckbox = document.getElementById('show-all');
const autoScrollCheckbox = document.getElementById('auto-scroll');
const issueCountEl = document.getElementById('issue-count');
const commentForm = document.getElementById('comment-form');
const commentInput = document.getElementById('comment-input');
const commentButton = commentForm.querySelector('button');

let agents = new Map();          // id -> agent
let workingIssueIds = new Map(); // issue_id -> agent_id
let issues = [];
let selectedIssueId = null;
let selectedTaskId = null;
let collapsed = new Set();
let showAll = false;
let autoScroll = true;
let hiddenAgentIds = new Set();
let issueUrlBase = null;
let meId = null;
let replyTargetCommentId = null;

function setTranscriptTitle(text, issue) {
  if (issue && issueUrlBase) {
    const href = issueUrlBase + issue.identifier;
    transcriptTitle.innerHTML = `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
    transcriptTitle.querySelector('a').addEventListener('click', (e) => {
      e.preventDefault();
      fetch(`/api/open?url=${encodeURIComponent(href)}`);
    });
  } else {
    transcriptTitle.textContent = text;
  }
}

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
  if (selectedIssueId && !issues.some((i) => i.id === selectedIssueId)) {
    selectedIssueId = null;
    selectedTaskId = null;
    transcriptTitle.textContent = 'Select an issue with an active agent to watch it work.';
    transcriptLog.innerHTML = '';
    commentInput.disabled = true;
    commentButton.disabled = true;
  }
  renderAgentBar();
  renderIssueTree();
}

// A chip toggled off mutes that agent everywhere the tree decides what's
// "live" (the working badge, the default context filter) without dropping
// the agent from the header — the point is narrowing focus, not losing track
// of who exists.
function visibleWorkingIssueIds() {
  if (!hiddenAgentIds.size) return workingIssueIds;
  const filtered = new Map();
  for (const [issueId, agentId] of workingIssueIds) {
    if (!hiddenAgentIds.has(agentId)) filtered.set(issueId, agentId);
  }
  return filtered;
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
    chip.className = 'agent-chip' + (hiddenAgentIds.has(id) ? ' hidden-agent' : '');
    chip.title = hiddenAgentIds.has(id) ? 'Hidden — click to show' : 'Click to hide';
    chip.innerHTML = `<span class="dot"></span><span>${escapeHtml(agent.name)}</span>`;
    chip.addEventListener('click', () => {
      if (hiddenAgentIds.has(id)) hiddenAgentIds.delete(id); else hiddenAgentIds.add(id);
      renderAgentBar();
      renderIssueTree();
    });
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
function liveKeepSet(byId, liveIds) {
  const keep = new Set();
  for (const issueId of liveIds.keys()) {
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
  const liveIds = visibleWorkingIssueIds();
  const keep = showAll ? null : liveKeepSet(byId, liveIds);
  issueTree.innerHTML = '';
  const roots = byParent.get('root') || [];
  let shown = 0;
  for (const issue of roots) {
    const node = renderIssueNode(issue, byParent, 0, keep, liveIds);
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
    : `${liveIds.size} being worked`;
}

function renderIssueNode(issue, byParent, depth, keep, liveIds) {
  if (keep && !keep.has(issue.id)) return null;
  const children = byParent.get(issue.id) || [];
  const visibleChildren = keep ? children.filter((c) => keep.has(c.id)) : children;
  const isCollapsed = collapsed.has(issue.id);
  const agent = issue.assignee_id ? agents.get(issue.assignee_id) : null;
  const isLive = liveIds.has(issue.id);

  const wrapper = document.createElement('div');
  const row = document.createElement('div');
  row.className = `issue-row status-${issue.status_category || issue.status}`
    + (isLive ? '' : ' context-row')
    + (issue.id === selectedIssueId ? ' selected' : '');
  row.style.paddingLeft = `${8 + depth * 16}px`;
  row.innerHTML = `
    <span class="issue-toggle">${visibleChildren.length ? (isCollapsed ? '▸' : '▾') : ''}</span>
    <span class="status-dot"></span>
    <span class="issue-id">${escapeHtml(issue.identifier)}</span>
    ${isLive ? '<span class="working-badge">● Working</span>' : ''}
    <span class="issue-title" title="${escapeHtml(issue.title)}">${escapeHtml(issue.title)}</span>
    ${isLive && agent ? `<span class="issue-agent">${escapeHtml(agent.name)}</span>` : ''}
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
      const childNode = renderIssueNode(child, byParent, depth + 1, keep, liveIds);
      if (childNode) wrapper.appendChild(childNode);
    }
  }
  return wrapper;
}

async function selectIssue(issue) {
  selectedIssueId = issue.id;
  selectedTaskId = null;
  replyTargetCommentId = null;
  renderIssueTree();
  transcriptLog.innerHTML = '';
  commentInput.disabled = false;
  commentButton.disabled = false;
  setTranscriptTitle(`${issue.identifier} — ${issue.title} — loading…`, issue);

  const agentId = workingIssueIds.get(issue.id);
  let task = null;
  if (agentId) {
    const tasks = await getJSON(`/api/agents/${agentId}/tasks`);
    task = tasks.find((t) => t.status === 'running' && t.issue_id === issue.id);
  }

  if (task) {
    selectedTaskId = task.id;
    const agentName = agents.get(agentId)?.name || agentId;
    setTranscriptTitle(`${issue.identifier} — ${issue.title} — ${agentName}`, issue);
    const messages = await getJSON(`/api/tasks/${task.id}/messages`);
    for (const m of messages.filter((m) => NARRATION_TYPES.has(m.type))) appendMessage(m);
    ws?.send(JSON.stringify({ type: 'subscribe', scope: 'task', id: task.id }));
  } else {
    const reason = agentId ? '(no running task found)' : '(no active agent session)';
    setTranscriptTitle(`${issue.identifier} — ${issue.title} ${reason}`, issue);
  }

  await loadConversations(issue.id);

  if (!transcriptLog.children.length) {
    transcriptLog.innerHTML = '<div class="transcript-empty">Nothing to show yet.</div>';
  }
}

function commentAuthorName(comment) {
  if (comment.author_id === meId) return 'You';
  if (comment.author_type === 'agent') return agents.get(comment.author_id)?.name || 'Agent';
  if (comment.author_type === 'system') return 'System';
  return 'Member';
}

function renderComment(comment) {
  const el = document.createElement('div');
  el.className = 'comment';
  el.innerHTML = `<div class="comment-meta">${escapeHtml(commentAuthorName(comment))} · ${escapeHtml(relativeTime(comment.created_at))}</div><div class="body">${renderMarkdown(comment.content)}</div>`;
  return el;
}

// A "conversation I've participated in" is any top-level thread where I
// authored the root or a reply. The most recently started one (by root
// created_at) is where a new message from the compose box lands, so posting
// never silently opens a second thread alongside one already in progress.
async function loadConversations(issueId) {
  let comments;
  try {
    comments = await getJSON(`/api/issues/${issueId}/comments`);
  } catch (err) {
    console.error(err);
    return;
  }
  if (issueId !== selectedIssueId) return;

  const roots = comments.filter((c) => !c.parent_id).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const repliesByRoot = new Map();
  for (const c of comments) {
    if (!c.parent_id) continue;
    if (!repliesByRoot.has(c.parent_id)) repliesByRoot.set(c.parent_id, []);
    repliesByRoot.get(c.parent_id).push(c);
  }
  for (const list of repliesByRoot.values()) list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const myThreads = roots.filter((root) => root.author_id === meId || (repliesByRoot.get(root.id) || []).some((r) => r.author_id === meId));
  if (!myThreads.length) return;

  replyTargetCommentId = myThreads[myThreads.length - 1].id;

  const details = document.createElement('details');
  details.className = 'conversations';
  details.open = true;
  const summary = document.createElement('summary');
  summary.textContent = `Your conversation${myThreads.length > 1 ? 's' : ''} (${myThreads.length})`;
  details.appendChild(summary);
  for (const root of myThreads) {
    const thread = document.createElement('div');
    thread.className = 'thread';
    thread.appendChild(renderComment(root));
    for (const reply of repliesByRoot.get(root.id) || []) {
      const replyEl = renderComment(reply);
      replyEl.classList.add('reply');
      thread.appendChild(replyEl);
    }
    details.appendChild(thread);
  }
  transcriptLog.appendChild(details);
  if (autoScroll) transcriptLog.scrollTop = transcriptLog.scrollHeight;
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
  el.innerHTML = `<div class="body">${renderMarkdown(text)}</div><div class="time">${escapeHtml(relativeTime(m.created_at))}</div>`;
  transcriptLog.appendChild(el);
  if (autoScroll) transcriptLog.scrollTop = transcriptLog.scrollHeight;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The first message on an issue opens a new top-level comment; every message
// after that replies inside whichever conversation I last started (tracked
// live from the comments themselves in loadConversations, not local state —
// a page reload or a second tab must land in the same place).
commentForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = commentInput.value.trim();
  if (!content || !selectedIssueId) return;
  const issueId = selectedIssueId;
  const parentId = replyTargetCommentId || undefined;
  commentInput.disabled = true;
  commentButton.disabled = true;
  try {
    const res = await fetch(`/api/issues/${issueId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, parent_id: parentId }),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const comment = await res.json();
    if (!parentId && issueId === selectedIssueId) replyTargetCommentId = comment.id;
    commentInput.value = '';
    if (issueId === selectedIssueId) {
      const empty = transcriptLog.querySelector('.transcript-empty');
      if (empty) empty.remove();
      const el = document.createElement('div');
      el.className = 'narration comment-sent';
      el.innerHTML = `<div class="body">${renderMarkdown(content)}</div><div class="time">posted just now${parentId ? ' (reply)' : ''}</div>`;
      transcriptLog.appendChild(el);
      if (autoScroll) transcriptLog.scrollTop = transcriptLog.scrollHeight;
    }
  } catch (err) {
    alert(`Failed to post comment: ${err.message}`);
  } finally {
    if (issueId === selectedIssueId) {
      commentInput.disabled = false;
      commentButton.disabled = false;
      commentInput.focus();
    }
  }
});

showAllCheckbox.addEventListener('change', () => {
  showAll = showAllCheckbox.checked;
  renderIssueTree();
});

autoScrollCheckbox.addEventListener('change', () => {
  autoScroll = autoScrollCheckbox.checked;
});

const DIVIDER_STORAGE_KEY = 'multica-dashboard:issue-tree-width';
issueTree.style.width = (localStorage.getItem(DIVIDER_STORAGE_KEY) || 440) + 'px';
divider.addEventListener('mousedown', (e) => {
  e.preventDefault();
  divider.classList.add('dragging');
  document.body.style.userSelect = 'none';
  const onMove = (moveEvent) => {
    const width = Math.min(Math.max(moveEvent.clientX, 220), window.innerWidth - 320);
    issueTree.style.width = width + 'px';
  };
  const onUp = () => {
    divider.classList.remove('dragging');
    document.body.style.userSelect = '';
    localStorage.setItem(DIVIDER_STORAGE_KEY, parseInt(issueTree.style.width, 10));
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
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
  // A tab left open across the local server dying and coming back (a crash,
  // an overnight sleep/wake) would otherwise keep showing whatever was in
  // memory from before the outage — nothing else re-polls on reconnect.
  ws.addEventListener('open', () => refreshAll().catch((err) => console.error(err)));
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

// Rendered markdown can contain real links (GitHub PRs, Linear tickets, other
// Multica issues) — route them through the same external-open path as the
// issue title, one delegated listener instead of one per rendered link.
transcriptLog.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a || !/^https?:\/\//i.test(a.href)) return;
  e.preventDefault();
  fetch(`/api/open?url=${encodeURIComponent(a.href)}`);
});

getJSON('/api/config').then((cfg) => { issueUrlBase = cfg.issueUrlBase; }).catch((err) => console.error(err));
getJSON('/api/me').then((me) => { meId = me.id; }).catch((err) => console.error(err));

// The local Node server not running yet (machine just woke, hasn't been
// started today) looks identical to it being genuinely broken, so retry
// silently instead of leaving a dead error behind on a page nobody reloads.
async function bootLoop() {
  try {
    await refreshAll();
  } catch (err) {
    const msg = `Can't reach the dashboard server — retrying… (${err.message})`;
    agentBar.innerHTML = `<span class="empty">${escapeHtml(msg)}</span>`;
    transcriptTitle.textContent = msg;
    setTimeout(bootLoop, 3000);
  }
}
bootLoop();
connectWS();
