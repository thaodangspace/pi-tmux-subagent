import { mkdtemp, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProtocolStore } from "../../src/protocol/store.js";
import { workerId } from "../../src/types.js";
const cleanup:{root:string,child?:ChildProcess}[]=[]; afterEach(async()=>{for(const x of cleanup.splice(0)){x.child?.kill();await rm(x.root,{recursive:true,force:true});}});
async function waitFor<T>(fn:()=>Promise<T|undefined>,timeout=8000):Promise<T>{const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,50));}throw new Error("timeout");}
describe("durable lifecycle",()=>{it("runner outlives managers and accepts follow-up commands",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi-sa-int-"));const store=new ProtocolStore(root);const id=workerId("integration1");
 await store.create({version:1,id,tmuxSession:"pi-sa-integration1",createdAt:new Date().toISOString(),cwd:root,launch:{task:"first"}},{version:1,id,status:"starting",turn:0,lastCommandSeq:0,lastEventSeq:0});await store.appendCommand(id,{type:"prompt",text:"first"});
 const child=spawn(process.execPath,[resolve("dist/runner/main.js"),store.dir(id)],{env:{...process.env,PI_TMUX_RPC_COMMAND:process.execPath,PI_TMUX_RPC_ARGS:JSON.stringify([resolve("test/fixtures/fake-rpc-child.mjs")])},stdio:"ignore"});cleanup.push({root,child});
 await waitFor(async()=>((await store.readState(id)).lastCommandSeq===1?true:undefined));
 // A new store instance represents a restarted parent manager.
 const restarted=new ProtocolStore(root);await restarted.appendCommand(id,{type:"send",text:"second"});
 await waitFor(async()=>((await restarted.readState(id)).lastCommandSeq===2?true:undefined));
 const result=await waitFor(async()=>{const value=await restarted.readResult(id);return value?.text==="reply-2:second"?value:undefined;});expect(result.text).toBe("reply-2:second");
 const acks=(await restarted.readLog<any>(id,"events")).filter(x=>x.type==="command_ack");expect(acks.map(x=>x.commandSeq)).toEqual([1,2]);
 await restarted.appendCommand(id,{type:"stop"});await waitFor(async()=>((await restarted.readState(id)).status==="stopped"?true:undefined));
});});
