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
pi-tmux-subagent events <id> [fromSeq] [limit]
pi-tmux-subagent attach <id>
pi-tmux-subagent stop <id>
pi-tmux-subagent delete <id>
```

Output is JSON. Set `PI_TMUX_REGISTRY` to override the default `~/.pi/tmux-subagents` registry.

## Pi extension

The `subagent` tool supports `spawn`, `send`, `steer`, `status`, `result`, `events`, `stop`, `kill`, `delete`, and `list`. `stop` is a cooperative durable command; `kill` force-terminates the tagged tmux pane/session and its runner/RPC process tree, records terminal `killed` state, and is safe to repeat when tmux is already gone. Deletion is limited to terminal workers and permanently removes their registry directory. Human commands are:

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
    {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5",
      "thinking": "high"
    },
    { "provider": "openai-codex", "model": "gpt-5.6-sol", "thinking": "low" }
  ],
  "default": { "provider": "openai-codex", "model": "gpt-5.6-sol" }
}
```

The same file may be placed globally at `~/.pi/agent/sub-agents.json`. A project-local file completely overrides the global file. When a configuration exists, `models` must be a non-empty list. Provider/model pairs supplied by the tool or an agent definition must appear in that list. Each entry may provide a default `thinking` level. An explicit spawn or agent-definition thinking level overrides it. The optional `default` must also appear in the list and is used when a spawn specifies neither provider nor model.

## Durability and recovery

Worker lifetime and turn delivery are separate state machines. A settled turn does not terminate its worker:

```text
worker: starting -> waiting <-> running
                          \\-> stopped | failed | orphaned

turn: queued -> accepted -> running -> settled
      -> immutable result persisted -> compact completion published
      -> owning parent enqueue checkpointed
```

`completed` may still appear as a legacy terminal worker status in registries created by older releases. New runners never produce it; they emit a `completed` turn completion while returning the worker to `waiting`. This compatibility state remains delete-eligible, but completion publication never implies RPC or tmux termination.

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
~/.pi/tmux-subagents/
  completions.jsonl
  consumers/<name>.json
```

`commands.jsonl` and `events.jsonl` are the authoritative command/event history. `completions.jsonl` is the authoritative, globally ordered compact completion history; every entry carries the owning Pi session key (or `null` for an unbound CLI worker), and `consumers/<name>.json` stores each session-scoped consumer's durable acknowledged cursor. Immutable `results/<turn>-<resultSeq>.json` records are the authoritative complete settled-turn history, including successful assistant text, failure details, and workspace metadata. `result.json` remains a backward-compatible latest-result cache. Per-worker `completion.json`, `meta.json`, and `state.json` are rebuildable/latest-value caches. Snapshot files are written atomically. Worker deletion removes the entire worker directory, including result history. A manager restart can discover a live tmux worker and enqueue more commands.

Consumers call `manager.completions({ consumer, ownerSessionKey })`, handle only that owner's entries in cursor order, and call `manager.ackCompletion(consumer, ownerSessionKey, cursor)` only after successful handling. The extension creates a fresh notifier only after each `session_start`, disposes it on that session's shutdown, and derives both routing values from Pi's durable session UUID. Reloading or resuming the same session reconnects to its unacknowledged completions; `/new` and fork/clone create a different owner and do not inherit delivery. CLI-created workers are unbound and never inject automatic notifications into a Pi session. An unacknowledged entry is delivered again after restart, while each owner has an independent checkpoint. The feed includes completed and failed turns and contains no full result payload or automatic full-result injection.

Completion summaries are whitespace-normalized and limited to 512 UTF-8 bytes. A producer may pass an explicit final-output summary to `completionSummary`; when it does not, the same deterministic limit is applied to the full assistant response. The complete response is never truncated in immutable result history. `resultSeq` ties a completion to the event that finalized its result or failure, while `turn` and `commandSeq` identify the corresponding interaction. Use `subagent({ action: "result", id, turn, resultSeq })` for correlation-safe retrieval; omitting both correlation fields explicitly requests the latest-result convenience view. Existing latest-only workers remain readable when their cached result matches the requested identity. Streaming `message_update` events are neither persisted nor used for completion delivery. Stale heartbeat, process, or tmux evidence transitions an active worker to `orphaned`.

Completion notification checkpointing is **enqueue-once under normal operation, with retry only for detectable synchronous failures**. Pi's `sendMessage` API provides synchronous enqueue but no awaited durable delivery/render confirmation. The extension checkpoints after that enqueue returns. A synchronous throw leaves the cursor unacknowledged and retries; a crash or downstream failure after return can either lose the visible message or cause a duplicate. The payload's stable `completionKey` (`worker:turn:resultSeq:status`) allows duplicate-aware consumers. Notifier errors are sent to the configured error hook or logged to stderr.

Command acknowledgement is **at-least-once around the external RPC boundary**: a command is acknowledged only after Pi accepts it, and acknowledged commands are skipped after runner restart. A crash after Pi accepts a command but before the local acknowledgement is durable can cause that command to be retried because those two effects cannot be one transaction.

Turn correlation is frozen at `agent_start`: the next accepted `prompt`/`send` command becomes that turn's immutable `commandSeq`, while `steer` and `abort` are persisted as related-command events and cannot replace it. A queued follow-up remains pending for the next `agent_start`. The `agent_start` event persists the complete turn context for restart/debugging. If Pi emits a start without a pending initiating command, the turn is retained without `commandSeq`; if it settles without a start, no previous turn identity is reused.

## Worktrees

`workspace: worktree` creates `.pi/worktrees/<worker-id>` on branch `pi-sa/<worker-id>`. Results report worktree, branch, commit, and changed files. The package never merges, cherry-picks, or force-removes dirty work. Deleting a terminal worktree worker first cleans a clean managed worktree. Dirty cleanup is refused before registry deletion, preserving both user changes and the metadata pointer needed for manual recovery. Users retain integration control.

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
