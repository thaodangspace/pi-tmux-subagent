# pi-tmux-subagent — Implementation Plan

## Thesis

**Durable Pi workers, controlled through Pi RPC, supervised by tmux.**

This project intentionally does not compete with `pi-interactive-subagents` on workflow orchestration, multi-multiplexer UX, or high-level planning flows.

The core idea is to provide a small, predictable primitive:

- Pi subagents run as persistent worker processes.
- tmux provides process/session supervision and human observability.
- Pi RPC is the control protocol.
- Worker state is durable and recoverable after the parent Pi process exits or restarts.
- Terminal scraping and `tmux send-keys` are not used as the agent communication protocol.

## Why this project should exist

`HazAT/pi-interactive-subagents` already covers the general “spawn Pi subagents in terminal multiplexer panes” use case very well.

Its strengths include:

- asynchronous parallel agents,
- tmux / cmux / zellij / WezTerm support,
- agent definitions,
- session resume,
- turn interruption,
- parent/child coordination,
- status widgets,
- planning workflows,
- integration tests.

This project should therefore not duplicate that surface area.

The differentiation is the control plane:

```text
pi-interactive-subagents

Parent Pi
   │
   ├── multiplexer control
   │
   └── child Pi CLI
        ├── session JSONL
        ├── activity snapshot
        └── completion sidecars


pi-tmux-subagent

Parent Pi
   │
   ▼
Subagent Manager
   │
   ├── durable registry / IPC
   │
   ▼
tmux-supervised runner
   │
   ▼
pi --mode rpc
```

tmux is the supervisor and human inspection surface, not the message bus.

---

## MVP scope

Expose one conceptual subagent primitive with these operations:

```ts
subagent({
  action:
    | "spawn"
    | "send"
    | "steer"
    | "status"
    | "result"
    | "stop"
    | "list",
  // ...
});
```

The first version should support:

- spawning a Pi worker in a dedicated tmux session,
- sending prompts programmatically,
- steering a running turn,
- checking worker state,
- reading the final result,
- aborting/stopping a worker,
- listing existing workers,
- recovering workers after the parent manager exits and restarts.

### Explicit non-goals for MVP

- workflow DSL,
- `/plan` replacement,
- planner/executor orchestration framework,
- cmux / zellij / WezTerm support,
- terminal screen scraping,
- `tmux send-keys` as the agent protocol,
- autonomous git merge,
- fleet scheduling,
- agent marketplace,
- recursive delegation beyond a small controlled depth.

---

## Target architecture

```text
┌──────────────────────────────┐
│          Parent Pi           │
│                              │
│  pi-tmux-subagent extension  │
│  ┌────────────────────────┐  │
│  │ subagent tool          │  │
│  │ manager                │  │
│  │ durable registry       │  │
│  └───────────┬────────────┘  │
└──────────────┼───────────────┘
               │
      durable commands/events
               │
               ▼
┌──────────────────────────────┐
│ tmux session                 │
│                              │
│   runner process             │
│          │                   │
│          │ JSONL RPC         │
│          ▼                   │
│     pi --mode rpc            │
│                              │
│   persistent Pi session      │
└──────────────────────────────┘
```

### Design rules

1. The parent manager must not parse terminal output.
2. The runner owns the stdin/stdout pipes of `pi --mode rpc`.
3. tmux is used for:
   - persistence,
   - attachability,
   - process boundaries,
   - human-readable inspection.
4. Durable files or another simple local IPC mechanism connect the parent manager and runner.
5. All command/event records are sequenced.
6. State snapshots are caches, not the source of history.

---

## Phase 1 — prove the RPC worker

Before building the Pi extension, build a standalone CLI.

Example:

```bash
pi-tmux-subagent spawn "inspect authentication"
pi-tmux-subagent status <id>
pi-tmux-subagent send <id> "also check tests"
pi-tmux-subagent stop <id>
```

Suggested initial structure:

```text
src/
├── cli.ts
├── runner/
│   ├── runner.ts
│   ├── rpc-client.ts
│   └── events.ts
├── tmux/
│   └── adapter.ts
└── state/
    ├── store.ts
    └── types.ts
```

Runner lifecycle:

```text
tmux session
    ↓
node runner.js <run-dir>
    ↓
spawn("pi", ["--mode", "rpc", ...])
    ↓
stdin/stdout JSONL
```

### Acceptance criteria

- A Pi worker starts inside tmux.
- Parent sends the initial prompt without `tmux send-keys`.
- RPC events are recorded.
- The running turn can be aborted.
- The tmux session can be attached for human inspection.
- Exiting the parent CLI does not kill the worker.

If this phase cannot be made reliable and simple, stop before building the extension layer.

---

## Phase 2 — durable protocol

Each worker gets a durable directory.

```text
~/.pi/tmux-subagents/
└── <worker-id>/
    ├── meta.json
    ├── state.json
    ├── commands.jsonl
    ├── events.jsonl
    ├── result.json
    └── runner.log
```

### `meta.json`

Example:

```json
{
  "id": "a31fc2",
  "tmuxSession": "pi-sa-a31fc2",
  "createdAt": "2026-09-20T00:00:00Z",
  "cwd": "/repo",
  "sessionFile": "/path/to/pi-session.jsonl",
  "pid": 1234
}
```

### `state.json`

Example:

```json
{
  "status": "running",
  "turn": 2,
  "lastEventAt": "2026-09-20T00:05:00Z",
  "lastCommandSeq": 4,
  "lastEventSeq": 27
}
```

### Command log

```json
{"seq":1,"type":"prompt","text":"inspect auth"}
{"seq":2,"type":"steer","text":"focus on oauth"}
{"seq":3,"type":"abort"}
```

### Event log

```json
{ "seq": 21, "type": "command_ack", "commandSeq": 2 }
```

### Storage rules

- `commands.jsonl` and `events.jsonl` are append-only.
- Every record has a monotonically increasing sequence.
- Snapshot files are written atomically.
- The runner can replay unseen commands after restart.
- Duplicate command execution must be prevented with sequence tracking.

---

## Phase 3 — recovery

Recovery is the core differentiation of this project.

A new parent process should be able to run:

```bash
pi-tmux-subagent list
```

and discover existing workers:

```text
a31fc2  running   scout-auth
99bd10  waiting   reviewer
```

### Recovery algorithm

```text
scan durable registry
        ↓
tmux session exists?
        ↓
runner heartbeat fresh?
        ↓
Pi RPC process alive?
        ↓
reconstruct worker state
```

### Worker states

```ts
type WorkerState =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "stopped"
  | "orphaned";
```

### Critical recovery test

```text
1. start worker
2. terminate parent manager
3. verify worker keeps running
4. start a new manager
5. manager discovers the worker
6. send another prompt
7. receive the final result
```

This scenario is the project's main definition of done.

---

## Phase 4 — Pi extension

Only after the CLI and recovery model are stable should the Pi extension be added.

Suggested structure:

```text
src/extension/
├── index.ts
├── tool.ts
├── commands.ts
└── render.ts
```

### Tool examples

Spawn:

```ts
subagent({
  action: "spawn",
  name: "auth-scout",
  task: "Inspect authentication implementation",
  agent: "scout",
});
```

Steer:

```ts
subagent({
  action: "steer",
  id: "a31fc2",
  message: "Check refresh token handling too",
});
```

Status:

```ts
subagent({
  action: "status",
  id: "a31fc2",
});
```

Human-facing commands may include:

```text
/subagents
/subagent-attach <id>
```

The LLM-facing API should not expose tmux implementation details unless needed for debugging.

---

## Phase 5 — agent definitions

Reuse the established Pi agent-definition convention.

```text
.pi/agents/
├── scout.md
├── worker.md
└── reviewer.md
```

Example:

```yaml
---
name: scout
model: ...
thinking: low
tools: read,grep,find,bash
---
Explore the assigned problem.
Return concise findings.
```

The manager should resolve:

```text
agent definition
       +
task
       +
RPC options
```

The project should not add a workflow engine at this stage.

---

## Phase 6 — optional git worktree isolation

Worktree isolation should be added only after RPC and recovery are reliable.

Example agent configuration:

```yaml
---
name: worker
workspace: worktree
---
```

Spawn flow:

```text
main repository
   │
   └── git worktree add
        .pi/worktrees/<worker-id>
              │
              └── worker cwd
```

Worker result metadata may contain:

```json
{
  "branch": "pi-sa/a31fc2",
  "worktree": "/repo/.pi/worktrees/a31fc2",
  "commit": "abc123",
  "changedFiles": []
}
```

MVP worktree behavior must not auto-merge.

The parent/user decides whether to:

- inspect,
- cherry-pick,
- merge,
- discard.

---

## Recursive spawning

Default policy:

```text
depth = 0
maxDepth = 1
```

Child workers should not spawn additional workers by default.

Future agent definitions may opt in:

```yaml
spawning: true
max-depth: 2
```

Recursive delegation is intentionally deferred because it quickly introduces scheduling, cost control, and runaway process-tree problems.

---

## Observability

A tmux session should present a human-readable projection of RPC events.

Example:

```text
worker auth-scout [a31fc2]

model: ...
cwd: /repo
state: running
turn: 2

> Inspect authentication implementation

[tool] grep ...
[tool] read ...
[assistant streaming...]

parent steer:
> Also inspect refresh tokens
```

This output is for humans only.

The terminal pane is not a machine-readable source of truth.

Human inspection remains simple:

```bash
tmux attach -t pi-sa-a31fc2
```

---

## Testing strategy

### Unit tests

Cover:

- RPC message parsing,
- worker state reducer,
- command sequencing,
- event sequencing,
- agent config parsing,
- tmux session naming,
- durable state writes,
- command replay deduplication.

### Integration tests with fake RPC child

Cover:

- runner IPC,
- manager/runner command delivery,
- runner crash/restart,
- parent crash/restart,
- command replay,
- event persistence.

### Integration tests with real Pi

Cover:

- spawn,
- initial prompt,
- multi-turn conversation,
- steer,
- abort,
- completion,
- result extraction,
- parent restart recovery.

### Required invariants

```text
parent death ≠ worker death
```

and:

```text
parent restart → reconnect → continue conversation
```

Until both are reliable, the project has not achieved its intended differentiation.

---

## Proposed final repository structure

```text
pi-tmux-subagent/
├── package.json
├── README.md
├── docs/
│   └── PLAN.md
├── src/
│   ├── extension/
│   │   ├── index.ts
│   │   ├── tool.ts
│   │   └── commands.ts
│   │
│   ├── manager/
│   │   ├── manager.ts
│   │   ├── recovery.ts
│   │   └── registry.ts
│   │
│   ├── runner/
│   │   ├── main.ts
│   │   ├── rpc-client.ts
│   │   └── renderer.ts
│   │
│   ├── protocol/
│   │   ├── commands.ts
│   │   ├── events.ts
│   │   └── state.ts
│   │
│   ├── tmux/
│   │   └── adapter.ts
│   │
│   ├── agents/
│   │   └── discover.ts
│   │
│   └── worktree/
│       └── adapter.ts
│
└── test/
    ├── unit/
    └── integration/
```

### Dependency direction

```text
Pi extension
     ↓
   manager
     ↓
 protocol/store
   ↙       ↘
tmux      runner
            ↓
          Pi RPC
```

The manager must never depend on terminal rendering or parse terminal output.

---

## Suggested commit roadmap

1. `chore: scaffold pi extension package`
2. `feat: add tmux session adapter`
3. `feat: add Pi RPC runner`
4. `feat: add durable worker registry`
5. `feat: add prompt and abort commands`
6. `feat: persist RPC event stream`
7. `feat: recover workers after parent restart`
8. `feat: expose subagent Pi tool`
9. `feat: add agent definition discovery`
10. `test: add restart and reconnect integration coverage`
11. `feat: add optional git worktree isolation`
12. `docs: document differences from pi-interactive-subagents`

Milestone proposal:

- **v0.1:** commits 1–10
- **v0.2:** worktree isolation and related ergonomics

---

## Product positioning

The project should remain easy to explain:

> **pi-interactive-subagents optimizes interactive multiplexer orchestration. pi-tmux-subagent optimizes durable, programmable Pi workers.**

That distinction should guide implementation decisions and prevent scope creep.
