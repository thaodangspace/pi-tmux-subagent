# pi-tmux-subagent

Durable Pi RPC workers supervised by tmux. The package provides a standalone CLI and a Pi extension with one `subagent` tool.

Unlike interactive multiplexer orchestration, tmux here is only a process supervisor and human inspection surface. Commands and events travel through append-only JSONL files; the manager never scrapes panes and never uses `tmux send-keys`. When spawned from inside tmux, a worker runs in a detached pane in the current window. Outside tmux, it runs in its own detached session.

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
pi-tmux-subagent delete <id>
```

Output is JSON. Set `PI_TMUX_REGISTRY` to override the default `~/.pi/tmux-subagents` registry.

## Pi extension

The `subagent` tool supports `spawn`, `send`, `steer`, `status`, `result`, `stop`, `delete`, and `list`. Deletion is limited to terminal workers and permanently removes their registry directory. Human commands are:

- `/subagents` — open the complete worker selector to send, steer, stop, inspect, or delete a terminal worker
- `/subagent-inspect <id>` — show bounded durable activity, result, and worktree metadata
- `/subagent-attach <id>` — print a safe attach command for another terminal

In interactive Pi sessions, a compact Subagents widget remains below the editor, shows `running`, `waiting`, and `failed` workers, and refreshes as durable worker state changes:

```text
Subagents  2 agents
● auth-scout  running  turn 2  00:34
  [tool] grep refreshToken
○ reviewer  waiting  turn 1  01:12
  ready for next instruction
```

The widget is reconstructed after parent restarts and is omitted in headless modes. `/subagents` remains the detailed selection/control surface. Direct attach is not attempted inside the active Pi TUI because nested terminal control can corrupt the session; `/subagent-attach` provides the equivalent `pi-tmux-subagent attach` command to run in another terminal. tmux remains supervision and optional human inspection only: UI activity comes from `commands.jsonl`, `events.jsonl`, state, and result data—never pane scraping or `tmux send-keys`.

Agent definitions live at `.pi/agents/<name>.md`:

```markdown
---
name: worker
provider: anthropic
model: claude-sonnet-4-5
thinking: low
tools: read, grep, find, bash
workspace: worktree
---

Implement the requested change and report concise evidence.
```

Explicit spawn options override definition fields. Recursive spawning is disabled for definitions by default (`maxDepth: 0`) and unnamed workers default to a maximum depth of one.

To restrict workers to approved provider/model pairs, add `.pi/agent/sub-agents.json`:

```json
{
  "models": [
    { "provider": "anthropic", "model": "claude-sonnet-4-5", "thinking": "high" },
    { "provider": "openai-codex", "model": "gpt-5.6-sol", "thinking": "low" }
  ],
  "default": { "provider": "openai-codex", "model": "gpt-5.6-sol" }
}
```

The same file may be placed globally at `~/.pi/agent/sub-agents.json`. A project-local file completely overrides the global file. When a configuration exists, `models` must be a non-empty list. Provider/model pairs supplied by the tool or an agent definition must appear in that list. Each entry may provide a default `thinking` level. An explicit spawn or agent-definition thinking level overrides it. The optional `default` must also appear in the list and is used when a spawn specifies neither provider nor model.

## Durability and recovery

Each worker uses:

```text
~/.pi/tmux-subagents/<id>/
  meta.json
  state.json
  commands.jsonl
  events.jsonl
  result.json
  completion.json
  runner.log
```

`commands.jsonl` and `events.jsonl` are the authoritative command/event history. `result.json` is the authoritative complete response for the latest settled turn, including workspace metadata. `completion.json` is the durable, compact notification for that result (or a worker failure); `meta.json` and `state.json` are rebuildable caches. Snapshot files are written atomically. A manager restart can discover a live tmux worker and enqueue more commands.

Completion summaries are whitespace-normalized and limited to 512 UTF-8 bytes. A producer may pass an explicit final-output summary to `completionSummary`; when it does not, the same deterministic limit is applied to the full assistant response. The complete response is never truncated in `result.json`. `resultSeq` ties a completion to the event that finalized its result or failure, while `turn` and `commandSeq` identify the corresponding interaction. Streaming `message_update` events are neither persisted nor used for completion delivery. Stale heartbeat, process, or tmux evidence transitions an active worker to `orphaned`.

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
