import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile, type Executor } from "../tmux/adapter.js";
import type { WorkspaceMetadata } from "../protocol/types.js";
import { SubagentError } from "../types.js";
export class WorktreeAdapter {
  constructor(private readonly exec: Executor = execFile) {}
  private async git(cwd: string, args: string[]) {
    const result = await this.exec("git", args, { cwd });
    if (result.code !== 0)
      throw new SubagentError(
        "GIT_FAILED",
        result.stderr.trim() || `git ${args.join(" ")} failed`,
      );
    return result.stdout.trim();
  }
  async prepare(repoCwd: string, id: string): Promise<WorkspaceMetadata> {
    const root = await this.git(repoCwd, ["rev-parse", "--show-toplevel"]);
    const commit = await this.git(root, ["rev-parse", "HEAD"]);
    const branch = `pi-sa/${id}`;
    const worktree = resolve(root, ".pi", "worktrees", id);
    await mkdir(join(root, ".pi", "worktrees"), { recursive: true });
    await this.git(root, ["worktree", "add", "-b", branch, worktree, commit]);
    return {
      mode: "worktree",
      root,
      branch,
      worktree,
      commit,
      changedFiles: [],
    };
  }
  async inspect(workspace: WorkspaceMetadata): Promise<WorkspaceMetadata> {
    if (!workspace.worktree) return workspace;
    const commit = await this.git(workspace.worktree, ["rev-parse", "HEAD"]);
    const output = await this.git(workspace.worktree, [
      "status",
      "--porcelain",
    ]);
    return {
      ...workspace,
      commit,
      changedFiles: output
        ? output.split("\n").map((x) => x.replace(/^\S{1,2}\s+/, ""))
        : [],
    };
  }
  async cleanup(workspace: WorkspaceMetadata): Promise<void> {
    if (!workspace.worktree || !workspace.branch)
      throw new SubagentError("INVALID_WORKSPACE", "Missing worktree metadata");
    const current = await this.inspect(workspace);
    if (current.changedFiles?.length)
      throw new SubagentError(
        "DIRTY_WORKTREE",
        "Refusing to remove a dirty worktree",
      );
    await this.git(workspace.root, ["worktree", "remove", workspace.worktree]);
    await rm(workspace.worktree, { recursive: true, force: true });
  }
}
