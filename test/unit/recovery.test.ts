import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Recovery } from "../../src/manager/recovery.js";
import { ProtocolStore } from "../../src/protocol/store.js";
import { TmuxAdapter, type Executor } from "../../src/tmux/adapter.js";
import { workerId } from "../../src/types.js";
const roots: string[]=[]; afterEach(async()=>Promise.all(roots.splice(0).map(x=>rm(x,{recursive:true,force:true}))));
describe("recovery",()=>{ it("reconstructs history and marks stale workers orphaned",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi-sa-")); roots.push(root); const store=new ProtocolStore(root); const id=workerId("recover1");
 await store.create({version:1,id,tmuxSession:"pi-sa-recover1",createdAt:new Date().toISOString(),cwd:root,launch:{task:"x"},runnerPid:999999,piPid:999998,heartbeatAt:"2000-01-01T00:00:00Z"},{version:1,id,status:"running",turn:99,lastCommandSeq:0,lastEventSeq:0});
 await store.appendEvent(id,{type:"rpc_started"});
 const exec=vi.fn<Executor>().mockResolvedValue({code:1,stdout:"",stderr:""}); const state=await new Recovery(store,new TmuxAdapter(exec)).recover(id);
 expect(state).toMatchObject({status:"orphaned",turn:0,lastEventSeq:2});
});});
