// Zero provider calls. Runs production driver against an injected fake SDK.
import assert from "node:assert/strict";
import fs from "node:fs";
import { z } from "zod";
import { createClaudeDriver } from "../../apps/engine/src/driver";
import { ClaudeRuntimeStore, MessageFeed, taskMemoryFrom } from "../../apps/engine/src/claude-runtime";
import { readUsageReport } from "../../apps/engine/src/usage";
const results: Record<string, unknown> = {};
const server = (id:string) => ({id,label:id,enabled:true,createdAt:1,updatedAt:1,spec:{transport:"http",url:`https://${id}.invalid/mcp`,headers:{"X-A":"a","X-B":"b"}}});
function fixture() {
  const calls:any[]=[]; const heard:any[]=[]; const switches:any[]=[];
  const d=createClaudeDriver(async()=>({
    query(input:any) {
      calls.push(input.options);
      return Object.assign((async function*(){
        let n=0;
        for await (const m of input.prompt) {
          heard.push(m.message.content); n++;
          const usage={input_tokens:2,output_tokens:2,cache_read_input_tokens:1000,cache_creation_input_tokens:20};
          // Parallel content envelopes repeat one API response's usage.
          for(let k=0;k<2;k++) yield {type:"assistant",message:{id:`api-${n}`,content:[],usage}};
          yield {type:"result",subtype:"success",session_id:"fake-provider",usage:{...usage,output_tokens:100},total_cost_usd:n===1?0.1:0.3};
        }
      })(),{setModel:async(m:any)=>{switches.push(m)}});
    }
  }) as never,{resolveExecutable:()=>"/fake/claude"});
  const obs:any[]=[];
  const run=(extra:any={})=>d.run({sessionId:"fake-session",cwd:"/tmp",prompt:"one",model:"opus[1m]",signal:new AbortController().signal,onObservations:async b=>{obs.push(...b)},...extra});
  return {d,calls,heard,switches,obs,run};
}
{
 const f=fixture();const a=await f.run(); const b=await f.run({prompt:"two",providerSessionId:"fake-provider"});
 assert.equal(f.calls.length,1);assert.deepEqual(f.heard,["one","two"]);
 assert.equal(a.usage!.costUsd!+b.usage!.costUsd!,0.4);
 results.continuityAndAccounting={queryCalls:f.calls.length,heard:f.heard,resumeOnWarmQuery:f.calls[0].resume??null,turnCosts:[a.usage!.costUsd,b.usage!.costUsd],incorrectSum:0.4,correctQueryTotal:0.3,usageObservations:f.obs.filter(o=>o.kind==="usage").length,turn2Tokens:b.usage!.tokens};f.d.dispose?.();
}
for(const [name,first,second,expected] of [
 ["restamped-server",{mcpServers:[server("a")]},{mcpServers:[{...server("a"),updatedAt:99,createdAt:99,label:"renamed"}]},1],
 ["server-array-order",{mcpServers:[server("a"),server("b")]},{mcpServers:[server("b"),server("a")]},2],
 ["header-key-order",{mcpServers:[server("a")]},{mcpServers:[{...server("a"),spec:{...server("a").spec,headers:{"X-B":"b","X-A":"a"}}}]},2],
 ["environment-key-order",{env:{AUDIT_A:"a",AUDIT_B:"b"}},{env:{AUDIT_B:"b",AUDIT_A:"a"}},2],
 ["undefined-env-deletion-collision",{env:{}},{env:{AUDIT_DELETE:undefined}},1],
 ["same-model",{model:"opus[1m]"},{model:"opus[1m]"},1],
 ["switch-model",{model:"opus[1m]"},{model:"sonnet[1m]"},1],
 ["change-effort",{effort:"medium"},{effort:"high"},2],
 ["stable-browser",{browserSocket:{url:"http://localhost:1/mcp",token:"fake"}},{browserSocket:{url:"http://localhost:1/mcp",token:"fake"}},1],
 ["rotate-browser-token",{browserSocket:{url:"http://localhost:1/mcp",token:"fake"}},{browserSocket:{url:"http://localhost:1/mcp",token:"fake-new"}},2],
 ] as const) {
 if(name==="undefined-env-deletion-collision")process.env.AUDIT_DELETE="synthetic-inherited-value";
 const f=fixture();await f.run(first);await f.run({...second,providerSessionId:"fake-provider"});assert.equal(f.calls.length,expected,name);
 results[name]={queryCalls:f.calls.length,modelControls:f.switches,resumes:f.calls.map(c=>c.resume??null),...(name==="undefined-env-deletion-collision"?{retainedValue:f.calls[0].env.AUDIT_DELETE,intendedDeleted:true}:{})};f.d.dispose?.();
 if(name==="undefined-env-deletion-collision")delete process.env.AUDIT_DELETE;
}
{
 const store=new ClaudeRuntimeStore();const destroyed:string[]=[];
 for(let n=0;n<5;n++) {
  const id=`fake-${n}`; const query=(async function*(){})();
  const runtime:any={sessionId:id,fingerprint:"fixed",query,iterator:query[Symbol.asyncIterator](),feed:new MessageFeed(),bindings:{current:{}},tasks:taskMemoryFrom([]),parked:[],streamEnded:false,busy:true,lastUsedAt:n,echoesUserMessageUuid:false,destroy:()=>destroyed.push(id)};
  if(n===0)runtime.tasks.known.set("background",{id:"background",state:"running",background:true});
  store.adopt(runtime);store.release(id);runtime.lastUsedAt=n;
 }
 assert.equal(store.size,4);assert.deepEqual(destroyed,["fake-0"]);
 results.idleEviction={idleAfterFiveTurns:store.size,destroyed:[...destroyed],backgroundWorkDidNotProtectFirst:true};store.destroyAll();
}
async function streamFixture(delayMs:number) {
 let frames=0;let batches=0;const obs:any[]=[];
 const d=createClaudeDriver(async()=>({async *query(){
  const frame=(event:any)=>({type:"stream_event",event});
  yield {type:"system",subtype:"api_retry",attempt:1,max_retries:3,retry_delay_ms:5000,error_status:429};
  yield {type:"rate_limit_event",rate_limit_info:{status:"rejected"}};
  yield frame({type:"content_block_start",index:0,content_block:{type:"text",text:""}});
  for(let i=0;i<40;i++){frames++;yield frame({type:"content_block_delta",index:0,delta:{type:"text_delta",text:"x"}})}
  yield frame({type:"message_delta",usage:{output_tokens:999},delta:{stop_reason:"end_turn"}});
  yield frame({type:"content_block_stop",index:0});
  yield {type:"result",subtype:"success",duration_ms:10000,duration_api_ms:9000};
 }}) as never,{resolveExecutable:()=>"/fake/claude"});
 const start=performance.now();await d.run({sessionId:"fake-stream",prompt:"x",cwd:"/tmp",signal:new AbortController().signal,onObservations:async b=>{batches++;obs.push(...b);if(delayMs)await new Promise(r=>setTimeout(r,delayMs));}});
 const ms=performance.now()-start;d.dispose?.();return {delayMs,frames,batches,ms,observationKinds:[...new Set(obs.map(o=>o.kind))],outputTokenUpdates:obs.filter(o=>o.kind==="usage").length};
}
results.streamingFast=await streamFixture(0);results.streamingSlowSink=await streamFixture(5);
assert.equal((results.streamingFast as any).batches,41);
assert.ok((results.streamingSlowSink as any).ms>180);
assert.equal((results.streamingFast as any).outputTokenUpdates,0);
{
 const catalogs: any[]=[];
 const d=createClaudeDriver(async()=>({
  tool:(name:string,description:string,schema:any)=>({name,description,inputSchema:z.toJSONSchema(z.object(schema),{unrepresentable:"any"})}),
  createSdkMcpServer:(config:any)=>{catalogs.push(config);return config},
  async *query(){yield {type:"result",subtype:"success"}}
 }) as never,{resolveExecutable:()=>"/fake/claude"});
 for(const extra of [{spool:{},sessions:{},display:{}},{spool:{},sessions:{},display:{},ds:{},latex:{}}]) {
  await d.run({sessionId:`catalog-${catalogs.length}`,cwd:"/tmp",prompt:"x",signal:new AbortController().signal,onObservations:async()=>{},...extra} as never);
 }
 results.telarCatalogs=catalogs.map(c=>({name:c.name,toolCount:c.tools.length,bytes:Buffer.byteLength(JSON.stringify(c.tools)),tools:c.tools.map((t:any)=>({name:t.name,descriptionBytes:Buffer.byteLength(t.description),schemaBytes:Buffer.byteLength(JSON.stringify(t.inputSchema))}))}));d.dispose?.();
}
{
 const root=fs.mkdtempSync("/tmp/telar-usage-fixture-");fs.mkdirSync(root+"/claude");fs.mkdirSync(root+"/codex");
 const row=(output:number)=>({type:"assistant",timestamp:"2026-09-08T00:00:00Z",sessionId:"fake",requestId:"fake-r",message:{id:"fake-m",model:"fake-model",usage:{input_tokens:2,output_tokens:output,cache_read_input_tokens:1000,cache_creation_input_tokens:20}}});
 fs.writeFileSync(root+"/claude/fake.jsonl",[row(2),row(100),row(100)].map(x=>JSON.stringify(x)).join("\n")+"\n");
 const report=await readUsageReport({sinceMs:Date.parse("2026-09-08T00:00:00Z"),untilMs:Date.parse("2026-09-09T00:00:00Z"),resolution:"day",timeZone:"UTC"},{roots:{claude:root+"/claude",codex:root+"/codex"},ratesCachePath:root+"/rates.json",loadRatesTable:async()=>({rates:new Map(),loadedAt:Date.now()} as never),memo:false});
 results.transcriptDedupe=report;
}
fs.writeFileSync(new URL("./fixture-results.json",import.meta.url),JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
