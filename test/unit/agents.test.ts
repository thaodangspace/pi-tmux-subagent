import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents, parseAgent, resolveLaunch } from "../../src/agents/discover.js";
const roots:string[]=[]; afterEach(async()=>Promise.all(roots.splice(0).map(x=>rm(x,{recursive:true,force:true}))));
describe("agent definitions",()=>{
 it("parses frontmatter",()=>expect(parseAgent("---\nname: scout\ntools: read, grep\nworkspace: worktree\n---\nExplore.")).toMatchObject({name:"scout",tools:["read","grep"],workspace:"worktree",systemPrompt:"Explore."}));
 it("discovers and applies override precedence",async()=>{const root=await mkdtemp(join(tmpdir(),"agents-"));roots.push(root);await mkdir(join(root,".pi/agents"),{recursive:true});await writeFile(join(root,".pi/agents/scout.md"),"---\nname: scout\nmodel: old\nthinking: low\n---\nExplore.");expect((await discoverAgents(root)).has("scout")).toBe(true);expect(await resolveLaunch(root,"task","scout",{model:"new"})).toMatchObject({task:"task",model:"new",thinking:"low",maxDepth:0});});
 it("rejects malformed and missing definitions",async()=>{expect(()=>parseAgent("no yaml")).toThrow(/frontmatter/);const root=await mkdtemp(join(tmpdir(),"agents-"));roots.push(root);await expect(resolveLaunch(root,"x","missing")).rejects.toThrow(/not found/);});
});
