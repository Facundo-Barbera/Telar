// Personal relay: unique revocable host credentials, production Telar destinations only.
const reply = (status, body = {}, headers = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
/**
 * ONE HOST'S DAILY CEILING — issue #584.
 *
 * The per-minute limiter (120) is 172,800 a day, which is exactly what one Mac
 * spent the day pinned against, taking the whole Cloudflare account past its
 * 100k free-plan quota and breaking the desktop updater with it. A daily budget
 * is the limit that actually corresponds to the thing being protected. 5,000 is
 * two orders of magnitude above ordinary use and two below the ceiling that
 * caused the outage.
 */
const DAILY_BUDGET = 5000;
const DAY = 86400000;
/** Apple names a rejection in its JSON body. ONLY that word travels back to the
 *  host: no provider body, no credential, no device token, no payload. */
async function appleReason(response) {
  try {
    const value = JSON.parse(await response.text())?.reason;
    return typeof value === 'string' && /^[A-Za-z]{1,64}$/.test(value) ? value : undefined;
  } catch { return undefined; }
}
/** The four Apple reasons that mean the token itself is gone, so this relay can
 *  drop its own copy of the registration rather than hold it for a dead phone. */
const DEAD_TOKEN = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered', 'ExpiredToken']);
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
    const now = Date.now();
    const minute = Math.floor(now/60000);
    const day = Math.floor(now/DAY);
    // THE BURST LIMIT AND THE BILL ARE DIFFERENT LIMITS. The minute limiter
    // keeps one bad loop from saturating an isolate; the daily budget is what
    // keeps a month of bad loops off the account's quota (#584). Counted in one
    // transaction so a host cannot spend past either by racing itself.
    const allowed = await this.state.storage.transaction(async tx => {
      const rate = await tx.get('rate');
      const count = rate?.minute === minute ? rate.count : 0;
      if (count >= 120) return 'minute';
      const budget = await tx.get('budget');
      const spent = budget?.day === day ? budget.count : 0;
      if (spent >= DAILY_BUDGET) return 'day';
      await tx.put('rate', { minute, count: count+1 });
      await tx.put('budget', { day, count: spent+1 });
      return 'ok';
    });
    // `Retry-After` IS THE POINT, not decoration: the host pauses this Mac's
    // sends until it elapses rather than discovering the refusal per push.
    if (allowed === 'day') return reply(429, { error: 'daily_budget' }, { 'retry-after': String(Math.max(1, Math.ceil(((day+1)*DAY - now)/1000))) });
    if (allowed !== 'ok') return reply(429, {}, { 'retry-after': String(Math.max(1, 60 - Math.floor((now%60000)/1000))) });
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
      // APPLE'S OWN `reason` IS THE ONE EXCEPTION AND THE POINT OF #584: without
      // it the host cannot tell a permanently dead device token from a bad hour,
      // so it retried two rejected tokens 627 and 17 times over. A bare enum word.
      let reason;
      if (response.status === 200) await response.body?.cancel();
      else reason = await appleReason(response);
      // A token Apple has disowned is dropped HERE too, so this relay stops
      // holding a registration for a phone that no longer exists.
      if (response.status === 410 || DEAD_TOKEN.has(reason)) {
        if (isStart) { delete registration.pushToStartToken; await this.state.storage.put(deviceKey,registration); }
        else if (isAlert) await this.state.storage.delete(deviceKey);
        else { registration.activities = registration.activities.filter(t => t !== body.token); await this.state.storage.put(deviceKey,registration); }
      }
      return reply(200, { status:response.status, ...(reason === undefined ? {} : { reason }) });
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
