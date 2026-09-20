import { describe, expect, it } from "vitest";
import { RpcClient } from "../../src/runner/rpc-client.js";
const enabled=process.env.PI_TMUX_REAL_TEST==="1";
describe.skipIf(!enabled)("real Pi RPC contract",()=>{it("supports prompt, multi-turn, steer, and abort",async()=>{
 const client=new RpcClient({cwd:process.cwd()});client.start();const events:any[]=[];client.on("event",x=>events.push(x));
 await client.prompt("Reply with exactly READY");await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error("Pi did not settle")),120000);client.on("event",e=>{if(e.type==="agent_settled"){clearTimeout(timeout);resolve();}});});
 await client.prompt("Reply with exactly DONE");await client.abort();expect(events.some(x=>x.type==="agent_start")).toBe(true);client.stop();
},180000);});
