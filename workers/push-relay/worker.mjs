// Personal relay: unique revocable host credentials, production Telar destinations only.
const reply = (status, body = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const hex = /^[a-f0-9]{64,512}$/i;
const id = /^[a-zA-Z0-9_-]{1,128}$/;
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const json64 = value => encode(new TextEncoder().encode(JSON.stringify(value)));
export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2,'0')).join('');
}
let provider;
async function providerToken(env, storage) {
  const now = Math.floor(Date.now() / 1000);
  const identity = await digest(`${env.APNS_KEY_ID}:${env.APNS_TEAM_ID}:${env.APNS_KEY_BASE64}`);
  if (storage) provider = await storage.get('provider');
  if (provider?.identity === identity && now >= provider.at && now - provider.at < 2700) return provider.jwt;
  const der = Uint8Array.from(atob(atob(env.APNS_KEY_BASE64).replace(/-----[^\n]+-----|\s/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const message = `${json64({alg:'ES256',kid:env.APNS_KEY_ID})}.${json64({iss:env.APNS_TEAM_ID,iat:now})}`;
  const jwt = `${message}.${encode(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode(message)))}`;
  provider = { identity, at: now, jwt };
  if (storage) await storage.put('provider', provider);
  return jwt;
}
export async function readJSON(request, max = 16384) {
  const reader = request.body?.getReader();
  if (!reader) throw Error('body');
  const chunks = []; let length = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    length += value.byteLength;
    if (length > max) { await reader.cancel(); throw Error('size'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/health') return reply(200, { service: 'telar-push', version: 1 });
    // Fail closed. No public enrollment endpoint and no app-wide embedded secret.
    let hosts;
    try { hosts = JSON.parse(env.HOSTS); } catch { return reply(503); }
    const bearer = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
    if (!bearer) return reply(401);
    const hash = await digest(bearer);
    const host = Array.isArray(hosts) && hosts.find(h => h && typeof h.id === 'string' && id.test(h.id) && h.sha256 === hash);
    if (!host) return reply(401);
    // Revocation applies at every invocation, before accessing host state or sending.
    const target = env.HOST_STATE.get(env.HOST_STATE.idFromName(host.id));
    return target.fetch(new Request(request.url, { method: request.method, body: request.body, headers: { 'content-type': 'application/json' }, duplex: 'half' }));
  },
};
export class RelayHost {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/v1/status' && request.method === 'GET') return reply(200, { configured: Boolean(this.env.APNS_KEY_BASE64 && this.env.APNS_KEY_ID && this.env.APNS_TEAM_ID), sandbox: false });
    const match = path.match(/^\/v1\/devices\/([a-zA-Z0-9_-]{1,128})(\/push)?$/);
    if (!match) return reply(404);
    const deviceKey = `device:${match[1]}`;
    const minute = Math.floor(Date.now()/60000);
    const allowed = await this.state.storage.transaction(async tx => {
      const rate = await tx.get('rate');
      const count = rate?.minute === minute ? rate.count : 0;
      if (count >= 120) return false;
      await tx.put('rate', { minute, count: count+1 }); return true;
    });
    if (!allowed) return reply(429);
    if (!match[2] && request.method === 'DELETE') { await this.state.storage.delete(deviceKey); return reply(200); }
    let body;
    try { body = await readJSON(request); } catch { return reply(400); }
    if (!match[2] && request.method === 'PUT') {
      if (!body || typeof body.token !== 'string' || !hex.test(body.token) || body.topic !== 'com.telar.mobile' || body.sandbox !== false || !Array.isArray(body.activities) || body.activities.length > 8 || !body.activities.every(t => typeof t === 'string' && hex.test(t))) return reply(400);
      if (body.pushToStartToken !== undefined && (typeof body.pushToStartToken !== 'string' || !hex.test(body.pushToStartToken))) return reply(400);
      // Bound each trusted host's registrations. Existing device updates never consume another slot.
      const registered = await this.state.storage.transaction(async tx => {
        if (!await tx.get(deviceKey) && (await tx.list({prefix:'device:',limit:33})).size >= 32) return false;
        await tx.put(deviceKey, { token: body.token, activities: body.activities, pushToStartToken: body.pushToStartToken, updatedAt: Date.now() });
        return true;
      });
      return reply(registered ? 200 : 409);
    }
    if (!match[2] || request.method !== 'POST') return reply(405);
    const registration = await this.state.storage.get(deviceKey);
    // Expired/offline registrations need the host to register them again.
    if (!registration || Date.now() - registration.updatedAt > 86400000) return reply(409);
    const isStart = body?.kind === 'liveactivity' && body.payload?.aps?.event === 'start';
    const isAlert = body?.kind === 'alert', isActivity = body?.kind === 'liveactivity';
    if ((!isAlert && !isActivity) || body.sandbox !== false || body.topic !== (isAlert ? 'com.telar.mobile' : 'com.telar.mobile.push-type.liveactivity') || typeof body.collapseId !== 'string' || !/^[a-f0-9]{64}$/.test(body.collapseId) || typeof body.token !== 'string' || !(isAlert ? registration.token === body.token : (isStart ? registration.pushToStartToken === body.token : registration.activities.includes(body.token))) || !body.payload?.aps || new TextEncoder().encode(JSON.stringify(body.payload)).length > 4096) return reply(400);
    try {
      let jwt;
      if (this.env.SIGNER) {
        const signed = await this.env.SIGNER.get(this.env.SIGNER.idFromName('apns')).fetch('https://internal/token');
        if (!signed.ok) return reply(503);
        jwt = await signed.text();
      } else jwt = await providerToken(this.env); // In-process test adapter; deployments bind SIGNER.
      const response = await fetch(`https://api.push.apple.com/3/device/${body.token}`, {
        method:'POST', redirect:'manual', signal:AbortSignal.timeout(10000),
        headers: { authorization:`bearer ${jwt}`, 'apns-topic':body.topic, 'apns-push-type':body.kind, 'apns-priority':isAlert||isStart||body.payload.aps.event==='end'?'10':'5', 'apns-expiration':String(Math.floor(Date.now()/1000)+3600), 'apns-collapse-id':body.collapseId },
        body:JSON.stringify(body.payload),
      });
      // Do not return provider bodies, credentials, device tokens, or session content.
      await response.body?.cancel();
      if (response.status === 410) {
        if (isStart) { delete registration.pushToStartToken; await this.state.storage.put(deviceKey,registration); }
        else if (isAlert) await this.state.storage.delete(deviceKey);
        else { registration.activities = registration.activities.filter(t => t !== body.token); await this.state.storage.put(deviceKey,registration); }
      }
      return reply(200, { status:response.status });
    } catch { return reply(503); }
  }
}

// One serialized signer across all hosts and isolates. Reuse survives eviction.
// No public route resolves to this class.
export class RelaySigner {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch() {
    const jwt = await this.state.blockConcurrencyWhile(() => this.state.storage.transaction(tx => providerToken(this.env, tx)));
    return new Response(jwt, { headers: { 'cache-control': 'no-store' } });
  }
}
