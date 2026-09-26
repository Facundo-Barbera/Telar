import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker, { RelayHost, RelaySigner, RelayGate, RelayDevice, digest } from './worker.mjs';
import { readFileSync } from 'node:fs';
import { APPLE_APP_ATTEST_ROOT, cbor, certificate, verifyAttestation } from './appattest.mjs';
import { IP_LIMITS } from './v2.mjs';
function store() {
  const data = new Map(); let alarm = null;
  const storage = { get:async k=>structuredClone(data.get(k)), put:async(k,v)=>{data.set(k,structuredClone(v));}, delete:async k=>Array.isArray(k)?k.forEach(x=>data.delete(x)):data.delete(k), deleteAll:async()=>data.clear(), list:async({prefix,limit})=>new Map([...data].filter(([k])=>k.startsWith(prefix)).slice(0,limit)), transaction:async fn=>fn(storage), getAlarm:async()=>alarm, setAlarm:async t=>{alarm=t;} };
  return {storage, data};
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

// ── v2: App Attest registration, per-pair send keys ─────────────────────────
// A throwaway PKI stands in for Apple's: a P-384 root and intermediate, and a
// P-256 leaf per phone carrying the App Attest nonce extension. Only the root
// differs from production (env.APPATTEST_ROOT); every check still runs.
const subtle=crypto.subtle, DAY=86400000, TEAM='TEAMID1234';
const u8=(...a)=>new Uint8Array(a.flat());
const cat=(...parts)=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;};
const utf8=s=>new TextEncoder().encode(s);
const sha=async b=>new Uint8Array(await subtle.digest('SHA-256',typeof b==='string'?utf8(b):b));
const fromHex=h=>Uint8Array.from(h.match(/../g),x=>parseInt(x,16));
const tlv=(tag,...parts)=>{const body=cat(...parts);const n=body.length;return cat(u8(tag,n<128?[n]:n<256?[0x81,n]:[0x82,n>>8,n&255]),body);};
const seq=(...p)=>tlv(0x30,...p), oid=h=>tlv(0x06,fromHex(h));
const int=b=>tlv(0x02,b[0]&0x80?cat(u8(0),b):b);
const trim=b=>{let i=0;while(i<b.length-1&&b[i]===0)i++;return b.subarray(i);};
const derSig=raw=>seq(int(trim(raw.subarray(0,raw.length/2))),int(trim(raw.subarray(raw.length/2))));
const utc=t=>tlv(0x17,utf8(new Date(t).toISOString().replace(/[-:T]/g,'').slice(2,14)+'Z'));
const dn=cn=>seq(tlv(0x31,seq(oid('550403'),tlv(0x0c,utf8(cn)))));
async function cert({subject,issuer,publicKey,signer,extensions}) {
  const alg='2a8648ce3d040303'; // ecdsa-with-SHA384, signed by a P-384 key
  const tbs=seq(tlv(0xa0,int(u8(2))),int(u8(1)),seq(oid(alg)),dn(issuer),seq(utc(Date.now()-DAY),utc(Date.now()+DAY)),dn(subject),new Uint8Array(await subtle.exportKey('spki',publicKey)),...(extensions?[tlv(0xa3,seq(...extensions))]:[]));
  return seq(tbs,seq(oid(alg)),tlv(0x03,u8(0),derSig(new Uint8Array(await subtle.sign({name:'ECDSA',hash:'SHA-384'},signer,tbs)))));
}
function enc(v) {
  const head=(major,n)=>n<24?u8(major<<5|n):n<256?u8(major<<5|24,n):u8(major<<5|25,n>>8,n&255);
  if(v instanceof Uint8Array) return cat(head(2,v.length),v);
  if(typeof v==='string'){const b=utf8(v);return cat(head(3,b.length),b);}
  if(Array.isArray(v)) return cat(head(4,v.length),...v.map(enc));
  const entries=Object.entries(v);return cat(head(5,entries.length),...entries.flatMap(([k,x])=>[enc(k),enc(x)]));
}
async function pki() {
  const p384={name:'ECDSA',namedCurve:'P-384'};
  const root=await subtle.generateKey(p384,true,['sign','verify']), mid=await subtle.generateKey(p384,true,['sign','verify']);
  const rootDer=await cert({subject:'Test Root',issuer:'Test Root',publicKey:root.publicKey,signer:root.privateKey});
  return {root:Buffer.from(rootDer).toString('base64'),mid,midDer:await cert({subject:'Test CA',issuer:'Test Root',publicKey:mid.publicKey,signer:root.privateKey})};
}
/** A phone: an attested key for `challenge`, and a signer for later assertions. */
async function phone(p,{challenge,bundle='com.telar.mobile',environment='production'}) {
  const key=await subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const keyHash=await sha(new Uint8Array(await subtle.exportKey('raw',key.publicKey)));
  const rp=await sha(`${TEAM}.${bundle}`);
  const authData=cat(rp,u8(0x40),u8(0,0,0,0),utf8(environment==='production'?'appattest\0\0\0\0\0\0\0':'appattestdevelop'),u8(0,32),keyHash);
  const nonce=await sha(cat(authData,await sha(challenge)));
  const leaf=await cert({subject:'leaf',issuer:'Test CA',publicKey:key.publicKey,signer:p.mid.privateKey,extensions:[seq(oid('2a864886f763640802'),tlv(0x04,seq(tlv(0xa1,tlv(0x04,nonce)))))]});
  let counter=0;
  return {
    keyId:Buffer.from(keyHash).toString('base64'),
    attestation:Buffer.from(enc({fmt:'apple-appattest',attStmt:{x5c:[leaf,p.midDer],receipt:u8()},authData})).toString('base64'),
    async assert(method,path,text='') {
      const ad=cat(rp,u8(0x40),u8(0,0,0,++counter));
      const signature=new Uint8Array(await subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,await sha(cat(ad,await sha(`${method} ${path}\n${text}`)))));
      return Buffer.from(enc({signature:derSig(signature),authenticatorData:ad})).toString('base64');
    },
  };
}
function relayEnv(extra={}) {
  const namespace=(Class,env)=>{const live=new Map();return {idFromName:n=>n,get:n=>({fetch:(input,init)=>{if(!live.has(n)) live.set(n,new Class(store(),env));return live.get(n).fetch(input instanceof Request?input:new Request(input,init));}})};};
  const env={APNS_KEY_BASE64:'k',APNS_KEY_ID:'KEY',APNS_TEAM_ID:TEAM,SIGNER:{idFromName:n=>n,get:()=>({fetch:async()=>new Response('jwt')})},...extra};
  env.GATE=namespace(RelayGate,env);env.DEVICE_STATE=namespace(RelayDevice,env);
  return env;
}
const call=(env,path,init={})=>worker.fetch(new Request('https://relay'+path,init),env);
const challengeFor=async(env,ip)=>(await (await call(env,'/v2/challenge',ip?{headers:{'cf-connecting-ip':ip}}:{})).json()).challenge;
const tokensOf={token:'a'.repeat(64),pushToStartToken:'b'.repeat(64),activities:[{id:'session_1',token:'c'.repeat(64)}]};
async function enroll({bundle='com.telar.mobile',sandbox=false,environment,extra={}}={}) {
  const p=await pki(), env=relayEnv({APPATTEST_ROOT:p.root,...extra});
  const challenge=await challengeFor(env);
  const ph=await phone(p,{challenge,bundle,environment});
  const registered=await call(env,'/v2/devices',{method:'POST',body:JSON.stringify({keyId:ph.keyId,attestation:ph.attestation,challenge,bundle,sandbox,...tokensOf})});
  assert.equal(registered.status,201);
  const {handle}=await registered.json();
  return {p,env,ph,handle,challenge};
}
async function asPhone({env,ph},method,path,body) {
  const text=body===undefined?'':JSON.stringify(body);
  return call(env,path,{method,headers:{'x-telar-assertion':await ph.assert(method,path,text)},...(text?{body:text}:{})});
}
async function pairKey(enrolled,pairing='mac-one') {
  const answer=await asPhone(enrolled,'POST',`/v2/devices/${enrolled.handle}/keys`,{pairing});
  assert.equal(answer.status,201);
  return answer.json();
}
/** Strictly increasing, as the Mac's must be: two identical requests signed in
 *  the same millisecond ARE a replay, and the relay refuses the second. */
let lastStamp=0;
const nextStamp=()=>lastStamp=Math.max(Date.now(),lastStamp+1);
async function macSend({env,handle},{keyId,sendKey},body,{stamp=nextStamp(),tamper=false}={}) {
  const path=`/v2/devices/${handle}/push`, text=JSON.stringify(body);
  const key=await subtle.importKey('raw',Buffer.from(sendKey,'base64url'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=Buffer.from(await subtle.sign('HMAC',key,utf8(`${stamp}\nPOST\n${path}\n${text}`))).toString('hex');
  return call(env,path,{method:'POST',headers:{'x-telar-key':keyId,'x-telar-timestamp':String(stamp),'x-telar-signature':tamper?'0'.repeat(64):signature},body:text});
}
const alert={kind:'alert',collapseId:'d'.repeat(64),payload:{aps:{alert:'Session needs you'}}};
async function withApple(answer,fn) {
  const original=globalThis.fetch, calls=[];
  globalThis.fetch=async(url,init)=>{calls.push({url,headers:init.headers});return answer();};
  try { await fn(calls); } finally { globalThis.fetch=original; }
}

test('v2: the embedded root is Apple App Attestation Root CA, byte for byte',async()=>{
  assert.equal(Buffer.from(await sha(Buffer.from(APPLE_APP_ATTEST_ROOT,'base64'))).toString('hex'),'1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932');
});
test('v2: an attested phone hands a Mac a key, and the Mac sends without ever holding a token',async()=>{
  const enrolled=await enroll();
  const key=await pairKey(enrolled);
  await withApple(()=>new Response(null,{status:200}),async calls=>{
    assert.deepEqual(await (await macSend(enrolled,key,alert)).json(),{status:200});
    assert.deepEqual(await (await macSend(enrolled,key,{...alert,kind:'liveactivity',activity:'session_1',payload:{aps:{event:'update'}}})).json(),{status:200});
    assert.deepEqual(await (await macSend(enrolled,key,{...alert,kind:'liveactivity',start:true,payload:{aps:{event:'start'}}})).json(),{status:200});
    assert.equal((await macSend(enrolled,key,{...alert,kind:'liveactivity',activity:'session_2',payload:{aps:{event:'update'}}})).status,409);
    // The destination and topic are the relay's choice, from what the phone registered.
    assert.deepEqual(calls.map(c=>[c.url,c.headers['apns-topic'],c.headers['apns-priority']]),[
      [`https://api.push.apple.com/3/device/${'a'.repeat(64)}`,'com.telar.mobile','10'],
      [`https://api.push.apple.com/3/device/${'c'.repeat(64)}`,'com.telar.mobile.push-type.liveactivity','5'],
      [`https://api.push.apple.com/3/device/${'b'.repeat(64)}`,'com.telar.mobile.push-type.liveactivity','10'],
    ]);
  });
});
const background={kind:'background',collapseId:'e'.repeat(64),payload:{aps:{'content-available':1},read:{host:'h',sessions:['session_1']}}};
test('v2: a background push is silent, priority 5, to the phone\'s own bundle, and carries no collapse id',async()=>{
  const enrolled=await enroll();
  const key=await pairKey(enrolled);
  await withApple(()=>new Response(null,{status:200}),async calls=>{
    assert.deepEqual(await (await macSend(enrolled,key,background)).json(),{status:200});
    assert.deepEqual([calls[0].url,calls[0].headers['apns-topic'],calls[0].headers['apns-push-type'],calls[0].headers['apns-priority'],calls[0].headers['apns-collapse-id']],
      [`https://api.push.apple.com/3/device/${'a'.repeat(64)}`,'com.telar.mobile','background','5',undefined]);
    // Anything a person would see is refused: this kind is never an alert in disguise.
    for(const aps of [{'content-available':1,alert:'hi'},{'content-available':1,sound:'default'},{alert:'hi'},{'content-available':0}])
      assert.equal((await macSend(enrolled,key,{...background,payload:{aps}})).status,400);
    assert.equal((await macSend(enrolled,key,{...background,payload:{aps:{'content-available':1},pad:'x'.repeat(4096)}})).status,400,'bounded');
    assert.equal(calls.length,1);
  });
});
test('v2: background pushes stop at their ceiling and the rest of the day stays for alerts, without pausing the Mac',async()=>{
  const enrolled=await enroll({extra:{HANDLE_BACKGROUND_CEILING:'2'}});
  const key=await pairKey(enrolled);
  await withApple(()=>new Response(null,{status:200}),async()=>{
    assert.equal((await macSend(enrolled,key,background)).status,200);
    assert.equal((await macSend(enrolled,key,alert)).status,200);
    const refused=await macSend(enrolled,key,background);
    assert.equal(refused.status,429);
    assert.equal(refused.headers.get('retry-after'),null,'a Retry-After would pause every alert on the Mac');
    assert.equal((await refused.json()).error,'background_budget');
    assert.equal((await macSend(enrolled,key,alert)).status,200,'alerts still go');
  });
});
test('v2: a dead token found by a background push is dropped like an alert\'s',async()=>{
  const enrolled=await enroll();
  const key=await pairKey(enrolled);
  await withApple(()=>Response.json({reason:'Unregistered'},{status:410}),async()=>{
    assert.equal((await (await macSend(enrolled,key,background)).json()).status,410);
    assert.equal((await macSend(enrolled,key,alert)).status,409);
  });
});
test('v2: a Debug build registers under the dev bundle and is sent through the sandbox host',async()=>{
  const enrolled=await enroll({bundle:'com.telar.mobile.dev',sandbox:true,environment:'development'});
  const key=await pairKey(enrolled);
  await withApple(()=>new Response(null,{status:200}),async calls=>{
    assert.equal((await macSend(enrolled,key,alert)).status,200);
    assert.equal(calls[0].url,`https://api.sandbox.push.apple.com/3/device/${'a'.repeat(64)}`);
    assert.equal(calls[0].headers['apns-topic'],'com.telar.mobile.dev');
  });
});
test('v2: an attestation is refused unless it is Apple-rooted, for our App ID, over a challenge we issued once',async()=>{
  const p=await pki(), env=relayEnv({APPATTEST_ROOT:p.root});
  const register=(ph,challenge,extra={})=>call(env,'/v2/devices',{method:'POST',body:JSON.stringify({keyId:ph.keyId,attestation:ph.attestation,challenge,bundle:'com.telar.mobile',sandbox:false,...tokensOf,...extra})});
  const challenge=await challengeFor(env);
  const good=await phone(p,{challenge});
  assert.equal((await register(good,challenge)).status,201);
  assert.equal((await register(good,challenge)).status,400,'a challenge is single use');
  assert.equal((await register(good,'x'.repeat(43))).status,400,'never issued');
  const other=await challengeFor(env);
  assert.equal((await register(good,other)).status,401,'attested over a different challenge');
  const devBuild=await challengeFor(env);
  assert.equal((await register(await phone(p,{challenge:devBuild,bundle:'com.telar.mobile.dev'}),devBuild)).status,401,'minted for another bundle than claimed');
  const forged=await challengeFor(env);
  assert.equal((await register(await phone(await pki(),{challenge:forged}),forged)).status,401,'not our root');
  const wrongKey=await challengeFor(env);
  assert.equal((await register(await phone(p,{challenge:wrongKey}),wrongKey,{keyId:good.keyId})).status,401,'key id of another key');
  const noBundle=await challengeFor(env);
  assert.equal((await register(await phone(p,{challenge:noBundle}),noBundle,{bundle:'com.example.app'})).status,400);
});
test('v2: only the phone changes its registration, and an assertion is good once',async()=>{
  const enrolled=await enroll();
  const path=`/v2/devices/${enrolled.handle}`;
  assert.equal((await call(enrolled.env,path,{method:'PUT',body:JSON.stringify(tokensOf)})).status,401);
  const header=await enrolled.ph.assert('PUT',path,JSON.stringify(tokensOf));
  const put=()=>call(enrolled.env,path,{method:'PUT',headers:{'x-telar-assertion':header},body:JSON.stringify(tokensOf)});
  assert.equal((await put()).status,200);
  assert.equal((await put()).status,401,'replayed counter');
  const bodyForged=await enrolled.ph.assert('PUT',path,JSON.stringify(tokensOf));
  assert.equal((await call(enrolled.env,path,{method:'PUT',headers:{'x-telar-assertion':bodyForged},body:JSON.stringify({...tokensOf,token:'e'.repeat(64)})})).status,401,'signed a different body');
  assert.equal((await asPhone(enrolled,'DELETE',path)).status,200);
  assert.equal((await asPhone(enrolled,'PUT',path,tokensOf)).status,404);
});
test('v2: a send key signs one request, within five minutes, until re-pairing or revocation',async()=>{
  const enrolled=await enroll();
  const first=await pairKey(enrolled);
  await withApple(()=>new Response(null,{status:200}),async()=>{
    assert.equal((await macSend(enrolled,first,alert,{tamper:true})).status,401);
    assert.equal((await macSend(enrolled,first,alert,{stamp:Date.now()-400000})).status,401);
    const stamp=nextStamp();
    assert.equal((await macSend(enrolled,first,alert,{stamp})).status,200);
    assert.equal((await macSend(enrolled,first,alert,{stamp})).status,401,'replayed');
    const other=await pairKey(enrolled,'mac-two');
    const rotated=await pairKey(enrolled);
    assert.equal((await macSend(enrolled,first,alert)).status,401,'re-pairing rotates the key');
    assert.equal((await macSend(enrolled,rotated,alert)).status,200);
    assert.equal((await asPhone(enrolled,'DELETE',`/v2/devices/${enrolled.handle}/keys/${rotated.keyId}`)).status,200);
    assert.equal((await macSend(enrolled,rotated,alert)).status,401);
    assert.equal((await macSend(enrolled,other,alert)).status,200,'the other pair is untouched');
  });
});
test('v2: a dead token is dropped, and the phone\'s next refresh restores the pair',async()=>{
  const enrolled=await enroll();
  const key=await pairKey(enrolled);
  await withApple(()=>Response.json({reason:'BadDeviceToken'},{status:400}),async()=>{
    assert.deepEqual(await (await macSend(enrolled,key,alert)).json(),{status:400,reason:'BadDeviceToken'});
    assert.equal((await macSend(enrolled,key,alert)).status,409);
  });
  assert.equal((await asPhone(enrolled,'PUT',`/v2/devices/${enrolled.handle}`,tokensOf)).status,200);
  await withApple(()=>new Response(null,{status:200}),async()=>{
    assert.equal((await macSend(enrolled,key,alert)).status,200);
  });
});
test('v2: limits per IP, per handle, and a global budget that answers 503 first',async()=>{
  const env=relayEnv();
  for(let n=0;n<IP_LIMITS.challenge[0];n++) assert.ok(await challengeFor(env,'203.0.113.7'));
  assert.equal((await call(env,'/v2/challenge',{headers:{'cf-connecting-ip':'203.0.113.7'}})).status,429);
  assert.ok(await challengeFor(env,'203.0.113.8'));
  for(let n=0;n<IP_LIMITS.challenge[0];n++) await challengeFor(env,`2001:db8:1:2::${n.toString(16)}`);
  assert.equal((await call(env,'/v2/challenge',{headers:{'cf-connecting-ip':'2001:db8:1:2:ffff::1'}})).status,429,'one /64 is one client');
  const small=relayEnv({GLOBAL_DAILY_BUDGET:'2'});
  await challengeFor(small,'198.51.100.1');await challengeFor(small,'198.51.100.2');
  const over=await call(small,'/v2/challenge',{headers:{'cf-connecting-ip':'198.51.100.3'}});
  assert.equal(over.status,503);assert.ok(Number(over.headers.get('retry-after'))>0);
  const enrolled=await enroll();
  const key=await pairKey(enrolled);
  await withApple(()=>new Response(null,{status:200}),async()=>{
    for(let n=0;n<120;n++) assert.equal((await macSend(enrolled,key,{...alert,collapseId:n.toString(16).padStart(64,'0')})).status,200);
    assert.equal((await macSend(enrolled,key,alert)).status,429);
  });
});
test('v2: without its bindings or APNs key, v2 answers 503 and v1 is unaffected',async()=>{
  assert.equal((await call({HOSTS:'[]'},'/v2/challenge')).status,503);
  assert.equal((await call({HOSTS:'[]'},'/v2/nothing')).status,404);
  assert.equal((await call({HOSTS:'[]'},'/v1/status')).status,401);
});
test('v2: a real attestation from a real iPhone verifies against the embedded Apple root',async()=>{
  // Public test vector (MIT, see the fixture's own `license`). Its leaf is
  // long expired, so the check runs at a moment inside its validity.
  const vector=JSON.parse(readFileSync(new URL('./fixtures/apple-attestation-production.json',import.meta.url),'utf8'));
  const attestation=Buffer.from(vector.attestation,'base64');
  const [leaf]=cbor(attestation).get('attStmt').get('x5c').map(certificate);
  const args={attestation,keyId:vector.keyId,challenge:Buffer.from(vector.challenge,'base64').toString('utf8'),teamId:vector.teamId,bundle:vector.bundle,now:leaf.notBefore+1000};
  assert.equal((await verifyAttestation(args)).environment,'production');
  await assert.rejects(verifyAttestation({...args,teamId:'MM74W7WGAM'}));
  await assert.rejects(verifyAttestation({...args,now:leaf.notAfter+1000}));
});
test('v2: a refresh without a start token leaves starts refused as not_registered, and one with it restores them',async()=>{
  const enrolled=await enroll();
  const key=await pairKey(enrolled);
  const start={...alert,kind:'liveactivity',start:true,payload:{aps:{event:'start'}}};
  const {pushToStartToken:_,...withoutStart}=tokensOf;
  assert.equal((await asPhone(enrolled,'PUT',`/v2/devices/${enrolled.handle}`,withoutStart)).status,200);
  await withApple(()=>new Response(null,{status:200}),async calls=>{
    const refused=await macSend(enrolled,key,start);
    assert.equal(refused.status,409);
    // The word is what lets the phone tell a lost start token from a full key ring.
    assert.deepEqual(await refused.json(),{error:'not_registered'});
    assert.equal(calls.length,0,'nothing reached Apple');
    assert.equal((await asPhone(enrolled,'PUT',`/v2/devices/${enrolled.handle}`,tokensOf)).status,200);
    assert.equal((await macSend(enrolled,key,start)).status,200);
    assert.equal(calls[0].url,`https://api.push.apple.com/3/device/${'b'.repeat(64)}`);
  });
});
