# Contributor architecture

Dependency direction is `extension/CLI → manager → protocol/store + tmux/runner → Pi RPC`.

Hard rules:

- tmux is supervision and human inspection only.
- Never communicate with workers using `tmux send-keys` or parse pane output.
- `commands.jsonl` and `events.jsonl` are authoritative append-only history; JSON snapshots are rebuildable caches.
- Use argument-array process spawning rather than shell interpolation.
- Keep real model tests opt-in.
