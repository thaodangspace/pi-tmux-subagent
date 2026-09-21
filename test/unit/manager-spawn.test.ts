import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Manager } from "../../src/manager/manager.js";
import { ProtocolStore } from "../../src/protocol/store.js";
import { TmuxAdapter } from "../../src/tmux/adapter.js";
import { WorktreeAdapter } from "../../src/worktree/adapter.js";
import { workerId } from "../../src/types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("first-run registry creation and spawn rollback", () => {
  it("creates non-existent registry root on first worker spawn", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "pi-first-run-"));
    roots.push(parentDir);
    // Deeply nested registry root that does not yet exist on disk
    const nestedRoot = join(parentDir, "nested", "registry", "root");
    const store = new ProtocolStore(nestedRoot);

    const tmux = new TmuxAdapter();
    tmux.create = vi.fn(async () => "%9");
    const manager = new Manager({ store, tmux });

    const state = await manager.spawn({ task: "hello" }, parentDir, "first1");
    expect(state.status).toBe("starting");

    const meta = await store.readMeta(workerId("first1"));
    expect(meta.id).toBe("first1");
    expect(meta.launch.task).toBe("hello");
    expect(meta.tmuxPane).toBe("%9");
  });

  it("cleans up worktree on spawn rollback if registration fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rollback-"));
    roots.push(root);
    const store = new ProtocolStore(root);

    const cleanupSpy = vi.fn(async () => {});
    const fakeWorktree = {
      prepare: vi.fn(async (_cwd: string, id: string) => ({
        mode: "worktree" as const,
        root: root,
        worktree: join(root, `worktree-${id}`),
        branch: `subagent/${id}`,
      })),
      cleanup: cleanupSpy,
      inspect: vi.fn(async (ws: any) => ws),
    };

    // Force store.create to throw (simulating storage failure after worktree preparation)
    store.create = vi.fn(async () => {
      throw new Error("Disk full simulation");
    });

    const tmux = new TmuxAdapter();
    tmux.create = vi.fn(async () => "session-rollback");
    const manager = new Manager({
      store,
      tmux,
      worktree: fakeWorktree as unknown as WorktreeAdapter,
    });

    await expect(
      manager.spawn(
        { task: "worktree-task", workspace: "worktree" },
        root,
        "rb1",
      ),
    ).rejects.toThrow("Disk full simulation");

    // Verify worktree cleanup was called so no branch/worktree is leaked
    expect(fakeWorktree.prepare).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "worktree",
        worktree: join(root, "worktree-rb1"),
        branch: "subagent/rb1",
      }),
    );
  });
});
