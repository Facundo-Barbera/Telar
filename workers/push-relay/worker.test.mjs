import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker, { RelayHost, RelaySigner, digest } from './worker.mjs';
function store() {
  const data = new Map();
  const storage = { get:async k=>structuredClone(data.get(k)), put:async(k,v)=>{data.set(k,structuredClone(v));}, delete:async k=>data.delete(k), list:async({prefix,limit})=>new Map([...data].filter(([k])=>k.startsWith(prefix)).slice(0,limit)), transaction:async fn=>fn(storage) };
  return {storage};
}
const registration = { token:'a'.repeat(64), topic:'com.telar.mobile', sandbox:false, activities:['b'.repeat(64)] };
const delivery = { ...registration, kind:'alert', collapseId:'c'.repeat(64), payload:{aps:{alert:'Test'}} };
const request = (path, method='PUT', body=registration) => new Request('https://relay'+path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});
test('host authentication is checked before durable state; host identities are isolated', async()=>{
  let selected;
  const secret='d'.repeat(64);
  const env={HOSTS:JSON.stringify([{id:'mac-one',sha256:await digest(secret)}]),HOST_STATE:{idFromName:n=>n,get:n=>({fetch:async()=>{selected=n;return new Response(null,{status:200});}})}};
  assert.equal((await worker.fetch(request('/v1/devices/phone'),env)).status,401);
  assert.equal(selected,undefined);
  const valid=new Request(request('/v1/devices/phone'),{headers:{authorization:`Bearer ${secret}`}});
  assert.equal((await worker.fetch(valid,env)).status,200);assert.equal(selected,'mac-one');
  env.HOSTS='[]';
  assert.equal((await worker.fetch(new Request('https://relay/v1/status',{headers:{authorization:`Bearer ${secret}`}}),env)).status,401);
});
test('only registered production destinations can receive pushes',async()=>{
  const host=new RelayHost(store(),{});
  assert.equal((await host.fetch(request('/v1/devices/phone/push','POST',delivery))).status,409);
  assert.equal((await host.fetch(request('/v1/devices/phone','PUT',{...registration,sandbox:true}))).status,400);
  assert.equal((await host.fetch(request('/v1/devices/phone'))).status,200);
  assert.equal((await host.fetch(request('/v1/devices/phone/push','POST',{...delivery,token:'e'.repeat(64)}))).status,400);
  assert.equal((await host.fetch(request('/v1/devices/phone/push','POST',{...delivery,topic:'another.app'}))).status,400);
  assert.equal((await host.fetch(request('/v1/devices/phone','DELETE',undefined))).status,200);
  assert.equal((await host.fetch(request('/v1/devices/phone/push','POST',delivery))).status,409);
});
test('host rate and device limits are bounded',async()=>{
  const host=new RelayHost(store(),{});
  for(let n=0;n<32;n++) assert.equal((await host.fetch(request('/v1/devices/p'+n))).status,200);
  assert.equal((await host.fetch(request('/v1/devices/extra'))).status,409);
  for(let n=33;n<120;n++) await host.fetch(request('/v1/devices/p0'));
  assert.equal((await host.fetch(request('/v1/devices/p0'))).status,429);
});
test('APNs delivery uses fixed host; expired activity tokens do not revoke phone alerts',async()=>{
  const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const host=new RelayHost(store(),{APNS_KEY_BASE64:Buffer.from(privateKey.export({format:'pem',type:'pkcs8'})).toString('base64'),APNS_KEY_ID:'TEST',APNS_TEAM_ID:'TEAM'});
  await host.fetch(request('/v1/devices/phone'));
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async(url,init)=>{assert.equal(url,`https://api.push.apple.com/3/device/${'b'.repeat(64)}`);assert.equal(init.redirect,'manual');return new Response(null,{status:410});};
    const activity={...delivery,kind:'liveactivity',topic:'com.telar.mobile.push-type.liveactivity',token:'b'.repeat(64)};
    assert.deepEqual(await (await host.fetch(request('/v1/devices/phone/push','POST',activity))).json(),{status:410});
    assert.equal((await host.fetch(request('/v1/devices/phone/push','POST',activity))).status,400);
    globalThis.fetch=async()=>new Response(null,{status:200});
    assert.deepEqual(await (await host.fetch(request('/v1/devices/phone/push','POST',delivery))).json(),{status:200});
  } finally {globalThis.fetch=original;}
});

test("Apple's rejection reason travels back, alone, and a disowned token drops the registration",async()=>{
  const host=new RelayHost(store(),{SIGNER:{idFromName:n=>n,get:()=>({fetch:async()=>new Response('test-jwt')})}});
  await host.fetch(request('/v1/devices/phone'));
  const original=globalThis.fetch;
  try {
    // Apple answers a rejection with a JSON body. Only `reason` is forwarded:
    // the host needs it to tell a dead token from a bad hour (#584), and
    // nothing else Apple says is any of the host's business.
    globalThis.fetch=async()=>new Response(JSON.stringify({reason:'BadDeviceToken',timestamp:1,'apns-id':'secret'}),{status:400});
    assert.deepEqual(await (await host.fetch(request('/v1/devices/phone/push','POST',delivery))).json(),{status:400,reason:'BadDeviceToken'});
    // The relay stops holding a registration for a phone Apple has disowned.
    assert.equal((await host.fetch(request('/v1/devices/phone/push','POST',delivery))).status,409);
    // A body that is not a reason is not quoted back in its place.
    await host.fetch(request('/v1/devices/phone'));
    globalThis.fetch=async()=>new Response('<html>gateway</html>',{status:503});
    assert.deepEqual(await (await host.fetch(request('/v1/devices/phone/push','POST',delivery))).json(),{status:503});
  } finally {globalThis.fetch=original;}
});
test('a host that spends its daily budget is refused with the seconds until it resets',async()=>{
  const host=new RelayHost(store(),{});
  const realNow=Date.now;
  try {
    // A fixed day, advanced a minute per hundred calls so the BURST limiter
    // never fires and only the daily budget can be what refuses (#584).
    const base=Date.UTC(2026,0,2,0,0,0);
    let calls=0;
    Date.now=()=>base+Math.floor(calls/100)*60000;
    for(;calls<5000;calls++) assert.equal((await host.fetch(request('/v1/devices/phone'))).status,200);
    const refused=await host.fetch(request('/v1/devices/phone'));
    assert.equal(refused.status,429);
    assert.equal((await refused.json()).error,'daily_budget');
    const after=Number(refused.headers.get('retry-after'));
    assert.ok(after>0&&after<=86400,`retry-after was ${after}`);
    // The next day is a fresh budget, not a permanently closed door.
    Date.now=()=>base+86400000;
    assert.equal((await host.fetch(request('/v1/devices/phone'))).status,200);
  } finally {Date.now=realNow;}
});
test('signing token survives signer eviction and rotates with credentials',async()=>{
  const key=()=>Buffer.from(generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'pem',type:'pkcs8'})).toString('base64');
  const state={...store(),blockConcurrencyWhile:fn=>fn()};
  const env={APNS_KEY_BASE64:key(),APNS_KEY_ID:'TEST',APNS_TEAM_ID:'TEAM'};
  const first=await (await new RelaySigner(state,env).fetch()).text();
  const second=await (await new RelaySigner(state,env).fetch()).text();
  assert.equal(first,second);
  const rotated=await (await new RelaySigner(state,{...env,APNS_KEY_BASE64:key()}).fetch()).text();
  assert.notEqual(first,rotated);
});
test('automatic starts require a separately registered start token and use immediate priority',async()=>{
  const host=new RelayHost(store(),{SIGNER:{idFromName:n=>n,get:()=>({fetch:async()=>new Response('test-jwt')})}});
  const startToken='f'.repeat(64);
  const start={...delivery,kind:'liveactivity',topic:'com.telar.mobile.push-type.liveactivity',token:startToken,payload:{aps:{event:'start'}}};
  await host.fetch(request('/v1/devices/phone'));
  assert.equal((await host.fetch(request('/v1/devices/phone/push','POST',start))).status,400);
  await host.fetch(request('/v1/devices/phone','PUT',{...registration,pushToStartToken:startToken}));
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async(url,init)=>{assert.equal(init.headers['apns-priority'],'10');return new Response(null,{status:410});};
    assert.deepEqual(await (await host.fetch(request('/v1/devices/phone/push','POST',start))).json(),{status:410});
    assert.equal((await host.fetch(request('/v1/devices/phone/push','POST',start))).status,400);
    globalThis.fetch=async()=>new Response(null,{status:200});
    assert.deepEqual(await (await host.fetch(request('/v1/devices/phone/push','POST',delivery))).json(),{status:200});
    await host.fetch(request('/v1/devices/phone','PUT',{...registration,pushToStartToken:startToken}));
    assert.equal((await host.fetch(request('/v1/devices/phone/push','POST',{...start,payload:{aps:{event:'update'}}}))).status,400);
    await host.fetch(request('/v1/devices/phone'));
    assert.equal((await host.fetch(request('/v1/devices/phone/push','POST',start))).status,400);
  } finally {globalThis.fetch=original;}
});
