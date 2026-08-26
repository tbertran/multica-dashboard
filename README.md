# multica-dashboard

Live dashboard for a [Multica](https://github.com/multica-ai/multica) fleet: an issue
tree with nested sub-issues, an agent roster, and a rolling per-task transcript that
streams as an agent works.

## Why not just poll the CLI

Multica's server exposes a real WebSocket channel (`GET /ws?workspace_id=...`, JWT/PAT
auth over the first frame) that the web app itself uses — subscribe to the `workspace`
scope for issue/agent/task lifecycle events, or a `task:<id>` scope for that task's live
`task:message` frames (text, tool_use, tool_result, one per execution step). Combined
with `GET /api/tasks/{id}/messages` for the persisted transcript on load, this gives a
true push-based dashboard instead of a poller — confirmed by reading
`server/internal/realtime` and `server/pkg/protocol` in the upstream `multica-ai/multica`
source and by watching real events flow off `multica.apollok12.com`.

## Architecture

```
browser  <-- ws://127.0.0.1:4175/ws -->  src/server.js  <-- wss://<server>/ws -->  Multica
         <-- http (proxy) ------------->                <-- https (REST) ------->
```

`src/server.js` is a small Node HTTP server: it serves `public/` and proxies a handful
of REST reads, and it holds **one shared upstream WebSocket** to Multica
(`src/multica-client.js`) that every connected browser tab rides on. The PAT never
reaches the browser.

- `GET /api/agents` — the roster
- `GET /api/working-agents` — which agents currently have a running task, and on which issues
- `GET /api/issues` — `open_only=true` (every non-done/cancelled issue); the plain
  paginated endpoint caps at 100/page and this fleet's build-pipeline churn leaves
  thousands of historical rows a live board has no use for
- `GET /api/agents/:id/tasks` — used to resolve an issue's current running task id
- `GET /api/tasks/:id/messages` — the persisted transcript for a task
- `/ws` — relays Multica's workspace-scope events (issue/agent/task/comment lifecycle)
  and `task:message` frames to every connected browser tab

The issue tree is built client-side from `parent_issue_id` — Multica has no separate
"nesting" endpoint, an issue just has a parent.

## Setup

Needs an existing `multica` CLI profile — this reuses its token instead of holding a
second copy:

```sh
multica --profile team-apollo whoami   # confirms ~/.multica/profiles/team-apollo/config.json exists
npm install
npm run serve                          # http://127.0.0.1:4175
```

Set `MULTICA_PROFILE` to use a different profile, `MULTICA_DASHBOARD_PORT` to change
the port.
