import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents, loadAgentConfig, parseAgent, resolveLaunch } from "../../src/agents/discover.js";
const roots:string[]=[]; afterEach(async()=>Promise.all(roots.splice(0).map(x=>rm(x,{recursive:true,force:true}))));
describe("agent definitions",()=>{
 it("parses frontmatter",()=>expect(parseAgent("---\nname: scout\ntools: read, grep\nworkspace: worktree\n---\nExplore.")).toMatchObject({name:"scout",tools:["read","grep"],workspace:"worktree",systemPrompt:"Explore."}));
 it("discovers and applies override precedence",async()=>{const root=await mkdtemp(join(tmpdir(),"agents-"));roots.push(root);await mkdir(join(root,".pi/agents"),{recursive:true});await mkdir(join(root,".pi/agent"),{recursive:true});await writeFile(join(root,".pi/agent/sub-agents.json"),JSON.stringify({models:[{provider:"test",model:"new"}]}));await writeFile(join(root,".pi/agents/scout.md"),"---\nname: scout\nprovider: test\nmodel: old\nthinking: low\n---\nExplore.");expect((await discoverAgents(root)).has("scout")).toBe(true);expect(await resolveLaunch(root,"task","scout",{model:"new"})).toMatchObject({task:"task",provider:"test",model:"new",thinking:"low",maxDepth:0});});
 it("rejects malformed and missing definitions",async()=>{expect(()=>parseAgent("no yaml")).toThrow(/frontmatter/);const root=await mkdtemp(join(tmpdir(),"agents-"));roots.push(root);await expect(resolveLaunch(root,"x","missing")).rejects.toThrow(/not found/);});
 it("loads the provider/model allowlist and applies its default",async()=>{const root=await mkdtemp(join(tmpdir(),"agents-config-"));roots.push(root);await mkdir(join(root,".pi/agent"),{recursive:true});const first={provider:"provider-a",model:"model-a",thinking:"high"};const second={provider:"provider-b",model:"model-b",thinking:"low"};await writeFile(join(root,".pi/agent/sub-agents.json"),JSON.stringify({models:[first,second],default:first}));expect(await loadAgentConfig(root)).toEqual({models:[first,second],default:first});expect(await resolveLaunch(root,"task")).toMatchObject({task:"task",provider:"provider-a",model:"model-a",thinking:"high"});expect(await resolveLaunch(root,"task",undefined,{provider:"provider-b",model:"model-b",thinking:"max"})).toMatchObject({provider:"provider-b",model:"model-b",thinking:"max"});});
 it("rejects provider/models outside the configured allowlist",async()=>{const root=await mkdtemp(join(tmpdir(),"agents-config-"));roots.push(root);await mkdir(join(root,".pi/agent"),{recursive:true});await writeFile(join(root,".pi/agent/sub-agents.json"),JSON.stringify({models:[{provider:"provider-a",model:"allowed"}]}));await expect(resolveLaunch(root,"task",undefined,{provider:"provider-b",model:"allowed"})).rejects.toThrow(/not allowed/);});
 it("rejects invalid model configuration",async()=>{const root=await mkdtemp(join(tmpdir(),"agents-config-"));roots.push(root);await mkdir(join(root,".pi/agent"),{recursive:true});await writeFile(join(root,".pi/agent/sub-agents.json"),JSON.stringify({models:[{provider:"provider-a",model:"allowed"}],default:{provider:"provider-a",model:"other"}}));await expect(loadAgentConfig(root)).rejects.toThrow(/default/);});
});

  it("resolves thinking configuration from agent frontmatter and allows overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "agents-think-"));
    roots.push(root);
    await mkdir(join(root, ".pi/agents"), { recursive: true });
    await mkdir(join(root, ".pi/agent"), { recursive: true });
    await writeFile(join(root, ".pi/agent/sub-agents.json"), JSON.stringify({ models: [{ provider: "test", model: "claude-3-7" }] }));
    await writeFile(
      join(root, ".pi/agents/reasoner.md"),
      "---\nname: reasoner\nprovider: test\nthinking: high\nmodel: claude-3-7\n---\nReason carefully.",
    );
    const resolved = await resolveLaunch(root, "analyze", "reasoner");
    expect(resolved.thinking).toBe("high");
    expect(resolved.model).toBe("claude-3-7");

    const overridden = await resolveLaunch(root, "analyze", "reasoner", { thinking: "max" });
    expect(overridden.thinking).toBe("max");
  });
