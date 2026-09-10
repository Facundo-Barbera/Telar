// Read-only sanctioned client. Never persist text, arguments, paths, raw frames or credentials.
import fs from "node:fs";
import { connectEngine } from "../../packages/engine-client/src/node";
const allowed = new Set(["session_014be402e6cc4fc5bc49b83c8205bb9a", "session_b9ff824fd6054512934e7ac06a667c52", "session_c8f3027237b2447a96c459785fe53d68"]);
const id = process.argv[2] ?? "session_014be402e6cc4fc5bc49b83c8205bb9a";
if (!allowed.has(id)) throw new Error("session outside audit scope");
if (!process.env.TELAR_HOME) throw new Error("missing authorized discovery root");
const c = await connectEngine(process.env.TELAR_HOME + "/engine");
const started = performance.now();
const snapshot = await c.session(id);
const snapshotMs = performance.now() - started;
const bound = snapshot.cursor ?? 0;
let cursor = 0;
const events: any[] = [];
const readMs: number[] = [];
for (let page = 0; page < 300; page++) {
  const at = performance.now();
  const r = await c.events(id, cursor);
  readMs.push(performance.now() - at);
  for (const e of r.events) {
    if (bound && e.id > bound) break;
    events.push({ id: e.id, at: e.at, type: e.type, runId: e.runId,
      ...(e.type === "usage.updated" ? { usage: e.usage } : {}),
      ...("itemId" in e ? { itemId: e.itemId } : {}),
      ...("item" in e ? { itemId: e.item.id, itemType: e.item.detail.type, task: !!e.item.taskId } : {}),
      ...(e.type === "content.delta" ? { stream: e.stream, bytes: Buffer.byteLength(e.text) } : {}),
      ...(e.providerRefs ? { refKeys: Object.keys(e.providerRefs) } : {}),
    });
  }
  if (!r.more || r.cursor >= bound || r.cursor <= cursor) break;
  cursor = r.cursor;
}
const stringBytes = (v: unknown): number => typeof v === "string" ? Buffer.byteLength(v) : Array.isArray(v) ? v.reduce((n,x)=>n+stringBytes(x),0) : v && typeof v === "object" ? Object.values(v).reduce<number>((n,x)=>n+stringBytes(x),0) : 0;
const items = snapshot.items.map(i=>({id:i.id,runId:i.runId,type:i.detail.type,status:i.status,task:!!i.taskId,startedAt:i.startedAt,completedAt:i.completedAt,durationMs:i.completedAt === undefined ? null : i.completedAt-i.startedAt,detailBytes:stringBytes(i.detail),refKeys:Object.keys(i.providerRefs??{})}));
const result={capturedAt:new Date().toISOString(),sessionId:id,bound,snapshotMs,readMs,
  model:snapshot.session.model,driver:snapshot.session.driver,
  turns:snapshot.turns.map(t=>({runId:t.runId,sequence:t.sequence,state:t.state,origin:t.origin,kind:t.kind,acceptedAt:t.acceptedAt,startedAt:t.startedAt,completedAt:t.completedAt,model:t.model,inputBytes:Buffer.byteLength(t.input),attachments:t.attachments?.map(a=>({mediaType:a.mediaType})),usage:t.usage})),
  requests:snapshot.requests.map(r=>({kind:r.detail.kind,state:r.state,openedAt:r.openedAt,resolvedAt:r.resolvedAt})),items,events};
const out=new URL(`./${id}-sanitized.json`,import.meta.url);
fs.writeFileSync(out,JSON.stringify(result,null,2));
console.log(JSON.stringify({file:out.pathname,capturedAt:result.capturedAt,model:result.model,events:events.length,items:items.length,snapshotMs,readMs,turns:result.turns,requests:result.requests}));
