// Read the runtime identity only into process memory; never print it.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const config=JSON.parse(execFileSync('/usr/bin/security',['find-generic-password','-s','com.telar.push-relay','-a','host','-w'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:15000}));
assert.equal(config.url,'https://telar-push-relay.facundo-barbera.workers.dev');
async function call(path,method='GET',body,authenticated=true) {
  return fetch(config.url+path,{method,headers:{...(authenticated?{authorization:`Bearer ${config.token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(20000)});
}
assert.equal((await call('/health','GET',undefined,false)).status,200);
assert.equal((await call('/v1/status','GET',undefined,false)).status,401);
const status=await call('/v1/status');
assert.equal(status.status,200);
assert.deepEqual(await status.json(),{configured:true,sandbox:false});
const path='/v1/devices/verification-'+crypto.randomUUID();
try {
  const registered=await call(path,'PUT',{token:'0'.repeat(64),topic:'com.telar.mobile',sandbox:false,activities:[]});
  assert.equal(registered.status,200);
  const sent=await call(path+'/push','POST',{token:'0'.repeat(64),topic:'com.telar.mobile',sandbox:false,kind:'alert',collapseId:'0'.repeat(64),payload:{aps:{alert:'Telar transport verification'}}});
  assert.equal(sent.status,200);
  assert.deepEqual(await sent.json(),{status:400,reason:'BadDeviceToken'});
  console.log('PASS: health, anonymous refusal, authenticated configuration, registration, APNs dummy-token rejection. No real notification sent.');
} finally {
  assert.equal((await call(path,'DELETE')).status,200);
  console.log('PASS: temporary device registration removed.');
}
