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

const agentChips = document.getElementById('agent-chips');
const agentBarShowAll = document.getElementById('agent-bar-show-all');
const issueTree = document.getElementById('issue-tree');
const listPanel = document.getElementById('list-panel');
const divider = document.getElementById('divider');
const transcriptEl = document.getElementById('transcript');
const transcriptHeader = document.getElementById('transcript-header');
const transcriptTitle = document.getElementById('transcript-title');
const transcriptSub = document.getElementById('transcript-sub');
const transcriptLog = document.getElementById('transcript-log');
const segAll = document.getElementById('seg-all');
const segMine = document.getElementById('seg-mine');
const issueFilterInput = document.getElementById('issue-filter');
const autoScrollCheckbox = document.getElementById('auto-scroll');
const statWorking = document.getElementById('stat-working');
const statAgents = document.getElementById('stat-agents');
const statOpen = document.getElementById('stat-open');
const connEl = document.getElementById('conn');
const menuEl = document.getElementById('menu');
const menuToggle = document.getElementById('menu-toggle');
const themeToggle = document.getElementById('theme-toggle');
const sheetBackdrop = document.getElementById('sheet-backdrop');
const commentForm = document.getElementById('comment-form');
const commentInput = document.getElementById('comment-input');
const commentButton = commentForm.querySelector('button');

let agents = new Map();          // id -> agent
let workingIssueIds = new Map(); // issue_id -> agent_id
let issues = [];
let selectedIssueId = null;
let selectedTaskId = null;
let collapsed = new Set();
let onlyMine = false;
let issueFilterText = '';
let autoScroll = true;
let hiddenAgentIds = new Set();
let issueUrlBase = null;
let meId = null;
let replyTargetCommentId = null;

const isPhone = window.matchMedia('(max-width: 860px)');

// /api/open launches the URL on the machine running the server, which is
// right for a desktop tab and wrong for a phone — there the link must open in
// the phone's own browser.
function openExternal(e, href) {
  if (isPhone.matches) return;
  e.preventDefault();
  fetch(`/api/open?url=${encodeURIComponent(href)}`);
}

function parseAgentName(full) {
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec((full || '').trim());
  if (!m) return { name: (full || '').trim(), role: '' };
  const parts = m[2].split(' - ').map((p) => p.trim());
  if (parts.length > 1 && /^[A-Z]{2}$/.test(parts[parts.length - 1])) parts.pop();
  return { name: m[1], role: parts.join(' · ') };
}

function chipLabel(fullName) {
  const { name, role } = parseAgentName(fullName);
  const parts = role.split(' · ');
  return parts.length > 1 ? `${name} · ${parts[parts.length - 1]}` : name;
}

function agentAvatar(agent) {
  const url = agent?.avatar_url || '';
  if (url.startsWith('emoji:')) return escapeHtml(url.slice(6));
  return escapeHtml((agent?.name || '?').trim().charAt(0).toUpperCase());
}

function setTranscriptTitle(title, issue, subHtml) {
  transcriptSub.innerHTML = subHtml || '';
  if (issue && issueUrlBase) {
    const href = issueUrlBase + issue.identifier;
    transcriptTitle.innerHTML = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`;
    transcriptTitle.querySelector('a').addEventListener('click', (e) => openExternal(e, href));
  } else {
    transcriptTitle.textContent = title;
  }
}

function resetTranscript() {
  selectedIssueId = null;
  selectedTaskId = null;
  transcriptLog.innerHTML = '';
  transcriptEl.classList.add('no-selection');
  document.body.classList.remove('has-selection');
  setSheet(false);
  setTranscriptTitle('Task log', null, 'Tap a running task to watch it work');
  commentInput.disabled = true;
  commentButton.disabled = true;
}

function setSheet(open) {
  transcriptEl.classList.toggle('expanded', open);
  transcriptHeader.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('sheet-open', open && isPhone.matches);
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
  if (selectedIssueId && !issues.some((i) => i.id === selectedIssueId)) resetTranscript();
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
  agentChips.innerHTML = '';
  const workingAgentIds = [...new Set(workingIssueIds.values())];
  agentBarShowAll.hidden = !hiddenAgentIds.size;
  if (!workingAgentIds.length) {
    agentChips.innerHTML = '<span class="empty">No agents currently working</span>';
    return;
  }
  for (const id of workingAgentIds) {
    const agent = agents.get(id);
    if (!agent) continue;
    const taskCount = [...workingIssueIds.values()].filter((a) => a === id).length;
    const chip = document.createElement('div');
    chip.className = 'agent-chip' + (hiddenAgentIds.has(id) ? ' hidden-agent' : '');
    chip.title = `${agent.name} — ${hiddenAgentIds.has(id) ? 'hidden, tap to show' : 'tap to hide'}`;
    chip.innerHTML = `<span class="av">${agentAvatar(agent)}</span><span>${escapeHtml(chipLabel(agent.name))}</span><span class="count">${taskCount}</span><button type="button" class="chip-only">only</button>`;
    chip.addEventListener('click', () => {
      if (hiddenAgentIds.has(id)) hiddenAgentIds.delete(id); else hiddenAgentIds.add(id);
      renderAgentBar();
      renderIssueTree();
    });
    chip.querySelector('.chip-only').addEventListener('click', (e) => {
      e.stopPropagation();
      hiddenAgentIds = new Set(workingAgentIds.filter((otherId) => otherId !== id));
      renderAgentBar();
      renderIssueTree();
    });
    agentChips.appendChild(chip);
  }
}

agentBarShowAll.addEventListener('click', () => {
  hiddenAgentIds = new Set();
  renderAgentBar();
  renderIssueTree();
});

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

function isMine(issue) {
  return issue.creator_type === 'member' && issue.creator_id === meId;
}

// "Only mine" narrows which live issues count as live — it never replaces the
// live filter, so it can never surface a not-currently-running issue.
function filterToMine(liveIds, byId) {
  const filtered = new Map();
  for (const [issueId, agentId] of liveIds) {
    const issue = byId.get(issueId);
    if (issue && isMine(issue)) filtered.set(issueId, agentId);
  }
  return filtered;
}

function matchesFilterText(issue) {
  if (!issueFilterText) return true;
  return `${issue.identifier} ${issue.title}`.toLowerCase().includes(issueFilterText);
}

function filterByText(liveIds, byId) {
  if (!issueFilterText) return liveIds;
  const filtered = new Map();
  for (const [issueId, agentId] of liveIds) {
    const issue = byId.get(issueId);
    if (issue && matchesFilterText(issue)) filtered.set(issueId, agentId);
  }
  return filtered;
}

function renderIssueTree() {
  const { byParent, byId } = buildTree();
  const liveIds = visibleWorkingIssueIds();
  let relevantLiveIds = onlyMine ? filterToMine(liveIds, byId) : liveIds;
  relevantLiveIds = filterByText(relevantLiveIds, byId);
  const keep = liveKeepSet(byId, relevantLiveIds);
  const scrollTop = issueTree.scrollTop;
  issueTree.innerHTML = '';
  const roots = byParent.get('root') || [];
  let shown = 0;
  for (const issue of roots) {
    const node = renderIssueNode(issue, byParent, 0, keep, relevantLiveIds);
    if (node) {
      issueTree.appendChild(node);
      shown++;
    }
  }
  if (!shown) {
    const message = issueFilterText
      ? 'Nothing matches that filter.'
      : onlyMine
        ? 'Nothing of yours is running right now.'
        : 'Nothing actively worked on right now.';
    issueTree.innerHTML = `<div class="empty-state"><div class="empty-title">All quiet</div><div>${message}</div></div>`;
  }
  issueTree.scrollTop = scrollTop;
  const shownLive = [...relevantLiveIds].filter(([issueId]) => byId.has(issueId));
  statWorking.textContent = shownLive.length;
  statAgents.textContent = new Set(shownLive.map(([, agentId]) => agentId)).size;
  statOpen.textContent = issues.length;
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
  row.setAttribute('role', 'listitem');
  row.className = `issue-row status-${issue.status_category || issue.status}`
    + (isLive ? ' is-live' : ' context-row')
    + (issue.id === selectedIssueId ? ' selected' : '');
  const parsedAgent = agent ? parseAgentName(agent.name) : null;
  row.innerHTML = `
    ${visibleChildren.length ? `<span class="issue-toggle${isCollapsed ? '' : ' open'}">›</span>` : ''}
    <span class="status-icon"></span>
    <div class="issue-main">
      <div class="issue-meta">
        <span class="issue-id">${escapeHtml(issue.identifier)}</span>
        ${isLive ? '<span class="live-pill"><i></i>Live</span>' : ''}
        ${isLive && agent ? `<span class="issue-agent" title="${escapeHtml(agent.name)}"><span class="av">${agentAvatar(agent)}</span><span class="nm">${escapeHtml(parsedAgent.name)}</span>${parsedAgent.role ? `<span class="role">${escapeHtml(parsedAgent.role)}</span>` : ''}</span>` : ''}
      </div>
      <div class="issue-title" title="${escapeHtml(issue.title)}">${escapeHtml(issue.title)}</div>
    </div>
  `;
  row.addEventListener('click', () => {
    if (visibleChildren.length) {
      if (isCollapsed) collapsed.delete(issue.id); else collapsed.add(issue.id);
      renderIssueTree();
    } else {
      selectIssue(issue);
    }
  });
  wrapper.appendChild(row);

  if (!isCollapsed && visibleChildren.length) {
    const childrenEl = document.createElement('div');
    childrenEl.className = 'children';
    for (const child of visibleChildren) {
      const childNode = renderIssueNode(child, byParent, depth + 1, keep, liveIds);
      if (childNode) childrenEl.appendChild(childNode);
    }
    wrapper.appendChild(childrenEl);
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
  transcriptEl.classList.remove('no-selection');
  document.body.classList.add('has-selection');
  if (isPhone.matches) setSheet(true);
  const idHtml = `<span class="issue-id">${escapeHtml(issue.identifier)}</span>`;
  setTranscriptTitle(issue.title, issue, `${idHtml}<span class="sep">·</span><span>loading…</span>`);

  const agentId = workingIssueIds.get(issue.id);
  let task = null;
  if (agentId) {
    const tasks = await getJSON(`/api/agents/${agentId}/tasks`);
    task = tasks.find((t) => t.status === 'running' && t.issue_id === issue.id);
  }

  if (task) {
    selectedTaskId = task.id;
    const agent = agents.get(agentId);
    const agentName = agent?.name || agentId;
    setTranscriptTitle(issue.title, issue, `${idHtml}<span class="sep">·</span><span>${agent ? agentAvatar(agent) : ''} ${escapeHtml(chipLabel(agentName))}</span><span class="live-pill"><i></i>Live</span>`);
    const messages = await getJSON(`/api/tasks/${task.id}/messages`);
    for (const m of messages.filter((m) => NARRATION_TYPES.has(m.type))) appendMessage(m);
    ws?.send(JSON.stringify({ type: 'subscribe', scope: 'task', id: task.id }));
  } else {
    const reason = agentId ? 'no running task found' : 'no active agent session';
    setTranscriptTitle(issue.title, issue, `${idHtml}<span class="sep">·</span><span>${reason}</span>`);
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
  if (myThreads.length) replyTargetCommentId = myThreads[myThreads.length - 1].id;

  if (!myThreads.length) return;

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

function setOnlyMine(value) {
  onlyMine = value;
  segAll.setAttribute('aria-pressed', String(!value));
  segMine.setAttribute('aria-pressed', String(value));
  renderIssueTree();
}
segAll.addEventListener('click', () => setOnlyMine(false));
segMine.addEventListener('click', () => setOnlyMine(true));

issueFilterInput.addEventListener('input', () => {
  issueFilterText = issueFilterInput.value.trim().toLowerCase();
  renderIssueTree();
});

autoScrollCheckbox.addEventListener('change', () => {
  autoScroll = autoScrollCheckbox.checked;
});

const DIVIDER_STORAGE_KEY = 'multica-dashboard:issue-tree-width';
listPanel.style.width = (localStorage.getItem(DIVIDER_STORAGE_KEY) || 460) + 'px';
divider.addEventListener('mousedown', (e) => {
  e.preventDefault();
  divider.classList.add('dragging');
  document.body.style.userSelect = 'none';
  const onMove = (moveEvent) => {
    const width = Math.min(Math.max(moveEvent.clientX - 12, 320), window.innerWidth - 400);
    listPanel.style.width = width + 'px';
  };
  const onUp = () => {
    divider.classList.remove('dragging');
    document.body.style.userSelect = '';
    localStorage.setItem(DIVIDER_STORAGE_KEY, parseInt(listPanel.style.width, 10));
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

document.getElementById('restart-server').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = 'Restarting…';
  const oldPid = (await getJSON('/api/boot')).pid;
  fetch('/api/restart', { method: 'POST' }).catch(() => {});
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      if ((await getJSON('/api/boot')).pid !== oldPid) return location.reload();
    } catch {}
  }
  btn.disabled = false;
  btn.textContent = 'Restart failed — retry';
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

function setConn(state, text) {
  connEl.dataset.state = state;
  connEl.querySelector('.conn-text').textContent = text;
  connEl.title = text;
}

function connectWS() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  // A tab left open across the local server dying and coming back (a crash,
  // an overnight sleep/wake) would otherwise keep showing whatever was in
  // memory from before the outage — nothing else re-polls on reconnect.
  ws.addEventListener('open', () => {
    setConn('live', 'Live');
    refreshAll().catch((err) => console.error(err));
  });
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
  ws.addEventListener('close', () => {
    setConn('connecting', 'Reconnecting');
    setTimeout(connectWS, 3000);
  });
}

// Rendered markdown can contain real links (GitHub PRs, Linear tickets, other
// Multica issues) — route them through the same external-open path as the
// issue title, one delegated listener instead of one per rendered link.
transcriptLog.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a || !/^https?:\/\//i.test(a.href)) return;
  if (isPhone.matches) {
    a.target = '_blank';
    a.rel = 'noopener';
    return;
  }
  openExternal(e, a.href);
});

const THEME_KEY = 'multica-dashboard:theme';
themeToggle.addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme
    ? root.dataset.theme === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, root.dataset.theme);
});

function setMenu(open) {
  menuEl.hidden = !open;
  menuToggle.setAttribute('aria-expanded', String(open));
}
menuToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  setMenu(menuEl.hidden);
});
document.addEventListener('click', (e) => {
  if (!menuEl.hidden && !menuEl.contains(e.target)) setMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setMenu(false);
});
isPhone.addEventListener('change', () => {
  if (!isPhone.matches) setSheet(false);
});

transcriptHeader.addEventListener('click', (e) => {
  if (!isPhone.matches || e.target.closest('a')) return;
  setSheet(!transcriptEl.classList.contains('expanded'));
});
transcriptHeader.addEventListener('keydown', (e) => {
  if (e.target !== transcriptHeader || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  if (isPhone.matches) setSheet(!transcriptEl.classList.contains('expanded'));
});
sheetBackdrop.addEventListener('click', () => setSheet(false));

let dragStartY = null;
transcriptHeader.addEventListener('touchstart', (e) => { dragStartY = e.touches[0].clientY; }, { passive: true });
transcriptHeader.addEventListener('touchend', (e) => {
  if (dragStartY === null) return;
  const dy = e.changedTouches[0].clientY - dragStartY;
  dragStartY = null;
  if (dy > 40) setSheet(false);
  else if (dy < -40) setSheet(true);
}, { passive: true });

getJSON('/api/config').then((cfg) => {
  issueUrlBase = cfg.issueUrlBase;
  if (onlyMine) renderIssueTree();
}).catch((err) => console.error(err));
getJSON('/api/me').then((me) => { meId = me.id; }).catch((err) => console.error(err));

// The local Node server not running yet (machine just woke, hasn't been
// started today) looks identical to it being genuinely broken, so retry
// silently instead of leaving a dead error behind on a page nobody reloads.
async function bootLoop() {
  try {
    await refreshAll();
  } catch (err) {
    setConn('down', 'Server unreachable');
    if (!issues.length) {
      issueTree.innerHTML = `<div class="empty-state"><div class="empty-title">Can't reach the dashboard server</div><div>Retrying… (${escapeHtml(err.message)})</div></div>`;
    }
    setTimeout(bootLoop, 3000);
  }
}
bootLoop();
connectWS();
