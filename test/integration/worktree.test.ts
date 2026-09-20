import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeAdapter } from "../../src/worktree/adapter.js";
import { execFile } from "../../src/tmux/adapter.js";
const roots:string[]=[];afterEach(async()=>Promise.all(roots.splice(0).map(x=>rm(x,{recursive:true,force:true}))));
describe("worktree isolation",()=>{it("creates metadata and refuses destructive dirty cleanup",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi-sa-git-"));roots.push(root);await execFile("git",["init","-q"],{cwd:root});await execFile("git",["config","user.email","test@example.com"],{cwd:root});await execFile("git",["config","user.name","Test"],{cwd:root});await writeFile(join(root,"file.txt"),"base\n");await execFile("git",["add","."],{cwd:root});await execFile("git",["commit","-qm","base"],{cwd:root});
 const adapter=new WorktreeAdapter();const workspace=await adapter.prepare(root,"worker11");expect(workspace).toMatchObject({branch:"pi-sa/worker11",mode:"worktree"});expect(await readFile(join(workspace.worktree!,"file.txt"),"utf8")).toBe("base\n");
 await writeFile(join(workspace.worktree!,"file.txt"),"changed\n");expect((await adapter.inspect(workspace)).changedFiles).toEqual(["file.txt"]);await expect(adapter.cleanup(workspace)).rejects.toThrow(/dirty/);
});});
