# pi-tmux-subagent

Durable Pi RPC workers supervised by tmux. The package provides a standalone CLI and a Pi extension with one `subagent` tool.

Unlike interactive multiplexer orchestration, tmux here is only a process supervisor and human inspection surface. Commands and events travel through append-only JSONL files; the manager never scrapes panes and never uses `tmux send-keys`.

## Requirements

- Node.js 20+
- `tmux`
- `pi` configured with a model/provider
- Git when using worktree isolation

## Install and build

```bash
npm install
npm run build
npm link                 # optional, installs pi-tmux-subagent on PATH
```

The npm package declares `dist/extension/index.js` as a Pi extension. It can also be loaded directly:

```bash
pi -e ./dist/extension/index.js
```

## CLI

```bash
pi-tmux-subagent spawn "inspect authentication"
pi-tmux-subagent list
pi-tmux-subagent status <id>
pi-tmux-subagent send <id> "also inspect refresh tokens"
pi-tmux-subagent steer <id> "focus on OAuth"
pi-tmux-subagent result <id>
pi-tmux-subagent attach <id>
pi-tmux-subagent stop <id>
```

Output is JSON. Set `PI_TMUX_REGISTRY` to override the default `~/.pi/tmux-subagents` registry.

## Pi extension

The `subagent` tool supports `spawn`, `send`, `steer`, `status`, `result`, `stop`, and `list`. Human commands are:

- `/subagents`
- `/subagent-attach <id>`

Agent definitions live at `.pi/agents/<name>.md`:

```markdown
---
name: worker
model: anthropic/claude-sonnet-4-5
thinking: low
tools: read, grep, find, bash
workspace: worktree
---

Implement the requested change and report concise evidence.
```

Explicit spawn options override definition fields. Recursive spawning is disabled for definitions by default (`maxDepth: 0`) and unnamed workers default to a maximum depth of one.

## Durability and recovery

Each worker uses:

```text
~/.pi/tmux-subagents/<id>/
  meta.json
  state.json
  commands.jsonl
  events.jsonl
  result.json
  runner.log
```

`commands.jsonl` and `events.jsonl` are authoritative. Snapshots are atomic caches reconstructed from event history. A manager restart can discover a live tmux worker and enqueue more commands. Stale heartbeat, process, or tmux evidence transitions an active worker to `orphaned`.

Command acknowledgement is **at-least-once around the external RPC boundary**: a command is acknowledged only after Pi accepts it, and acknowledged commands are skipped after runner restart. A crash after Pi accepts a command but before the local acknowledgement is durable can cause that command to be retried because those two effects cannot be one transaction.

## Worktrees

`workspace: worktree` creates `.pi/worktrees/<worker-id>` on branch `pi-sa/<worker-id>`. Results report worktree, branch, commit, and changed files. The package never merges, cherry-picks, or force-removes dirty work. Users retain integration and cleanup control.

## Tests

```bash
npm run check
npm run test:integration
PI_TMUX_REAL_TEST=1 npm run test:real   # invokes configured Pi/model access
```

Default tests use a deterministic fake RPC child and do not make model calls.

## Architecture

```text
extension / CLI → manager → protocol store + tmux adapter
                                ↓
                         tmux runner → pi --mode rpc
```

See [docs/PLAN.md](docs/PLAN.md) and [AGENTS.md](AGENTS.md).
