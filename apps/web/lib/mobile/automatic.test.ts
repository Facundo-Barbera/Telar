// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { AUTOMATIC_ACTIVITY, parseRegistration, saveRegistration, readPushRecords, type PushRecord, type Delivery } from "./push";
import { deliverRecord } from "./worker";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const record = (): PushRecord => ({ hostId:"12345678-1234-1234-1234-123456789abc",hostName:"Studio Mac",token:"a".repeat(64),pushToStartToken:"b".repeat(64),topic:"com.telar.mobile",sandbox:false,enabled:false,completions:false,previews:false,liveActivities:true,mutedSessions:[],activities:[],deviceId:"phone",revision:"r1",updatedAt:0,seen:{},activitySent:{} });
const work = {id:"one",title:"Private task",activity:"working",activityAt:1};
test("automatic work starts once without a follow or notification opt-in; idle permits the next run",async()=>{
  const sent: Delivery[]=[];const send=async(d:Delivery)=>{sent.push(d);return 200;};
  let r=(await deliverRecord(record(),[work],send,1000))!;
  expect(sent).toHaveLength(1);
  expect(sent[0]!.token).toBe(r.pushToStartToken);
  expect(sent[0]!.payload.aps).toMatchObject({event:"start","attributes-type":"SessionActivityAttributes","input-push-token":1,attributes:{hostId:r.hostId,sessionId:AUTOMATIC_ACTIVITY,hostName:"Studio Mac"}});
  expect(JSON.stringify(sent[0])).not.toContain(work.title);
  r=(await deliverRecord(r,[work],send,1010))!;expect(sent).toHaveLength(1);
  r=(await deliverRecord(r,[],send,1020))!;
  await deliverRecord(r,[work],send,1030);expect(sent).toHaveLength(2);
});
test("one host card aggregates work, gives attention precedence, and ends when idle or disabled",async()=>{
  const r=record();r.activities=[{sessionId:AUTOMATIC_ACTIVITY,token:"c".repeat(64),startedAt:1000}];
  const sent: Delivery[]=[];const send=async(d:Delivery)=>{sent.push(d);return 200;};
  const busy=[work,{...work,id:"two",activity:"blocked"}];
  let next=(await deliverRecord(r,busy,send,1010))!;
  expect(sent).toHaveLength(1);
  expect(sent[0]!.payload.aps).toMatchObject({event:"update","content-state":{title:"2 active sessions",activeCount:2,sessionId:"two",status:"Needs you",ended:false}});
  next=(await deliverRecord(next,busy,send,1015))!;expect(sent).toHaveLength(1);
  next=(await deliverRecord(next,[],send,1020))!;
  expect(sent[1]!.payload.aps.event).toBe("end");expect(next.activities).toHaveLength(0);
  await deliverRecord({...r,liveActivities:false},busy,send,1030);
  expect(sent[2]!.payload.aps.event).toBe("end");
});
test("start failures retry, expired start tokens preserve notifications, disabled and old clients never start",async()=>{
  let r=(await deliverRecord(record(),[work],async()=>503,1000))!;
  expect(r.automaticStartedAt).toBeUndefined();expect(r.retryAt).toBeGreaterThan(1000);
  r=(await deliverRecord(r,[work],async()=>410,1010))!;
  expect(r.token).toBe(record().token);expect(r.pushToStartToken).toBeUndefined();
  let sent=0;
  for(const patch of [{liveActivities:false},{pushToStartToken:undefined},{liveActivities:undefined}]) await deliverRecord({...record(),...patch},[work],async()=>{sent++;return 200;},1000);
  expect(sent).toBe(0);
});
test("a start receipt survives a refresh of the same start token, dies with a new one, and validates its fields",async()=>{
  for(const patch of [{liveActivities:"yes"},{pushToStartToken:"bad"},{hostName:42}]) expect(()=>parseRegistration({...record(),...patch})).toThrow();
  const dir=mkdtempSync(path.join(os.tmpdir(),"telar-auto-")),file=path.join(dir,"push.json");
  try {
    saveRegistration("phone",record(),file);
    const r=readPushRecords(file)[0]!;r.automaticStartedAt=1000;r.automaticStarts=1;
    // Persist the worker's completed start, then emulate the token callback registration.
    writeFileSync(file,JSON.stringify([r]));
    saveRegistration("phone",record(),file);
    expect(readPushRecords(file)[0]!.automaticStartedAt).toBe(1000);
    expect(readPushRecords(file)[0]!.automaticStarts).toBe(1);
    // A reinstall mints a new start token: the receipt belongs to the old one, which this
    // install never had, so it must not keep the gate shut on an activity it never ran.
    saveRegistration("phone",{...record(),pushToStartToken:"d".repeat(64)},file);
    const fresh=readPushRecords(file)[0]!;
    expect(fresh.automaticStartedAt).toBeUndefined();
    expect(fresh.automaticStarts).toBeUndefined();
    expect(fresh.seen).toEqual(r.seen);
    const sent: Delivery[]=[];
    await deliverRecord(fresh,[work],async d=>{sent.push(d);return 200;},2000);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.aps.event).toBe("start");
    expect(sent[0]!.token).toBe("d".repeat(64));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test("a start the phone never ran is retried after five minutes, three times per token, then idle resets it",async()=>{
  const sent: Delivery[]=[];const send=async(d:Delivery)=>{sent.push(d);return 200;};
  let r=(await deliverRecord(record(),[work],send,1000))!;
  expect(sent).toHaveLength(1);expect(r.automaticStarts).toBe(1);
  // Inside the window the phone may still report the activity's token.
  r=(await deliverRecord(r,[work],send,1299))!;expect(sent).toHaveLength(1);
  r=(await deliverRecord(r,[work],send,1300))!;
  expect(sent).toHaveLength(2);expect(sent[1]!.payload.aps.event).toBe("start");expect(r.automaticStarts).toBe(2);
  r=(await deliverRecord(r,[work],send,1600))!;expect(sent).toHaveLength(3);expect(r.automaticStarts).toBe(3);
  // Capped: a phone that cannot start activities at all is not pushed every five minutes forever.
  r=(await deliverRecord(r,[work],send,1900))!;expect(sent).toHaveLength(3);
  r=(await deliverRecord(r,[work],send,100000))!;expect(sent).toHaveLength(3);
  r=(await deliverRecord(r,[],send,100010))!;expect(r.automaticStarts).toBeUndefined();
  await deliverRecord(r,[work],send,100020);expect(sent).toHaveLength(4);
});
test("a registered automatic activity is updated, never restarted",async()=>{
  const sent: Delivery[]=[];const send=async(d:Delivery)=>{sent.push(d);return 200;};
  const r={...record(),automaticStartedAt:1000,automaticStarts:1,activities:[{sessionId:AUTOMATIC_ACTIVITY,token:"c".repeat(64),startedAt:1000}]};
  const next=(await deliverRecord(r,[work],send,9000))!;
  expect(sent).toHaveLength(1);
  expect(sent[0]!.payload.aps.event).toBe("update");
  expect(sent[0]!.token).toBe("c".repeat(64));
  expect(next.automaticStartedAt).toBe(1000);expect(next.automaticStarts).toBeUndefined();
});
