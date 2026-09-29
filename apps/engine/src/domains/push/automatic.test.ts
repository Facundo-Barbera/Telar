import { expect, test } from "bun:test";
import { AUTOMATIC_ACTIVITY, CARD_LINGER_S, parseRegistration, saveRegistration, readPushRecords, type PushRecord, type Delivery } from "./push";
import { deliverRecord } from "./worker";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const record = (): PushRecord => ({ hostId:"12345678-1234-1234-1234-123456789abc",hostName:"Studio Mac",token:"a".repeat(64),pushToStartToken:"b".repeat(64),topic:"io.github.novarix.telar",sandbox:false,enabled:false,completions:false,previews:false,liveActivities:true,mutedSessions:[],deviceId:"phone",revision:"r1",updatedAt:0,seen:{},activitySent:{} });
const work = {id:"one",title:"Private task",activity:"working",activityAt:1};
const card = {token:"c".repeat(64),startedAt:1000};
function recorder() {
  const sent: Delivery[]=[];
  return { sent, send: async (d: Delivery) => { sent.push(d); return { status: 200 }; } };
}

test("work starts one card without a notification opt-in, and never a second while work goes on",async()=>{
  const {sent,send}=recorder();
  let r=(await deliverRecord(record(),[work],send,1000))!;
  expect(sent).toHaveLength(1);
  expect(sent[0]!.token).toBe(r.pushToStartToken!);
  expect(sent[0]!.payload.aps).toMatchObject({event:"start","attributes-type":"SessionActivityAttributes","input-push-token":1,attributes:{hostId:r.hostId,sessionId:AUTOMATIC_ACTIVITY,hostName:"Studio Mac"}});
  expect(JSON.stringify(sent[0])).not.toContain(work.title);
  for (const at of [1010, 1300, 1600, 100000]) r=(await deliverRecord(r,[work],send,at))!;
  expect(sent).toHaveLength(1);
  r=(await deliverRecord(r,[],send,100010))!;
  await deliverRecord(r,[work],send,100020);expect(sent).toHaveLength(2);
});

test("a card on the phone is updated, never started over",async()=>{
  const {sent,send}=recorder();
  const busy=[work,{...work,id:"two",activity:"blocked"}];
  let r=(await deliverRecord({...record(),card},busy,send,1010))!;
  expect(sent).toHaveLength(1);
  expect(sent[0]!.token).toBe(card.token);
  expect(sent[0]!.payload.aps).toMatchObject({event:"update","content-state":{title:"2 active sessions",activeCount:2,sessionId:"two",status:"Needs you",ended:false}});
  r=(await deliverRecord(r,busy,send,1015))!;expect(sent).toHaveLength(1);
  expect(r.automaticStartedAt).toBe(1000);
});

test("finished work leaves the card on screen, and new work updates that same card",async()=>{
  const {sent,send}=recorder();
  let r=(await deliverRecord({...record(),card},[work],send,1010))!;
  r=(await deliverRecord(r,[],send,1020))!;
  expect(sent[1]!.payload.aps).toMatchObject({event:"update","content-state":{status:"Finished",ended:true}});
  expect(r.card).toEqual(card);expect(r.cardFinishedAt).toBe(1020);
  r=(await deliverRecord(r,[],send,1100))!;expect(sent).toHaveLength(2);
  r=(await deliverRecord(r,[work],send,1200))!;
  expect(sent.map(d=>[d.token,d.payload.aps.event])).toEqual([[card.token,"update"],[card.token,"update"],[card.token,"update"]]);
  expect(r.cardFinishedAt).toBeUndefined();
});

test("a finished card is closed after it lingers, and only then may the next work start one",async()=>{
  const {sent,send}=recorder();
  let r=(await deliverRecord({...record(),card},[],send,1000))!;
  r=(await deliverRecord(r,[],send,1000+CARD_LINGER_S-1))!;expect(sent).toHaveLength(1);
  r=(await deliverRecord(r,[],send,1000+CARD_LINGER_S))!;
  expect(sent[1]!.payload.aps).toMatchObject({event:"end","dismissal-date":1000+CARD_LINGER_S});
  expect(r.card).toBeUndefined();
  await deliverRecord(r,[work],send,2000);
  expect(sent[2]!.payload.aps.event).toBe("start");
});

test("switching Live Activities off ends the card at once",async()=>{
  const {sent,send}=recorder();
  const r=(await deliverRecord({...record(),card,liveActivities:false},[work],send,1030))!;
  expect(sent[0]!.payload.aps.event).toBe("end");expect(r.card).toBeUndefined();
});

test("start failures retry, expired start tokens preserve notifications, disabled and old clients never start",async()=>{
  let r=(await deliverRecord(record(),[work],async()=>({status:503}),1000))!;
  expect(r.automaticStartedAt).toBeUndefined();expect(r.retryAt).toBeGreaterThan(1000);
  r=(await deliverRecord(r,[work],async()=>({status:410}),1040))!;
  expect(r.token).toBe(record().token);expect(r.pushToStartToken).toBeUndefined();
  let sent=0;
  for(const patch of [{liveActivities:false},{pushToStartToken:undefined},{liveActivities:undefined}]) await deliverRecord({...record(),...patch},[work],async()=>{sent++;return {status:200};},1000);
  expect(sent).toBe(0);
});

test("a start survives any re-registration, including a new start token, until the work stops",async()=>{
  for(const patch of [{liveActivities:"yes"},{pushToStartToken:"bad"},{hostName:42}]) expect(()=>parseRegistration({...record(),...patch})).toThrow();
  const dir=mkdtempSync(path.join(os.tmpdir(),"telar-auto-")),file=path.join(dir,"push.json");
  try {
    saveRegistration("phone",record(),file);
    const r=readPushRecords(file)[0]!;r.automaticStartedAt=1000;
    writeFileSync(file,JSON.stringify([r]));
    saveRegistration("phone",{...record(),pushToStartToken:"d".repeat(64)},file);
    const fresh=readPushRecords(file)[0]!;
    expect(fresh.automaticStartedAt).toBe(1000);
    const {sent,send}=recorder();
    await deliverRecord(fresh,[work],send,2000);
    expect(sent).toHaveLength(0);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("a re-registration of the same card keeps its finish time; a new card starts fresh",()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),"telar-auto-")),file=path.join(dir,"push.json");
  try {
    saveRegistration("phone",{...record(),card},file);
    const r=readPushRecords(file)[0]!;r.cardFinishedAt=1500;
    writeFileSync(file,JSON.stringify([r]));
    saveRegistration("phone",{...record(),card},file);
    expect(readPushRecords(file)[0]!.cardFinishedAt).toBe(1500);
    saveRegistration("phone",{...record(),card:{token:"e".repeat(64),startedAt:2000}},file);
    expect(readPushRecords(file)[0]!.cardFinishedAt).toBeUndefined();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
