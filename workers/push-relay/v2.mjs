/**
 * RELAY v2: PHONES REGISTER THEMSELVES, MACS NEVER SEE A DEVICE TOKEN.
 *
 * v1 needs every Mac hand-provisioned (a Keychain token plus an entry in
 * `TELAR_PUSH_HOSTS` plus a redeploy). v2 turns that around:
 *
 *   1. The phone asks for a one-time challenge and proves with App Attest that
 *      it is a genuine Telar build (`POST /v2/devices`). It gets back an opaque
 *      `handle` for its registration; its APNs tokens stay here.
 *   2. For each paired Mac, the phone asks for a `sendKey`
 *      (`POST /v2/devices/:handle/keys`) and hands `{handle, keyId, sendKey}`
 *      to that Mac over the pairing channel it already has.
 *   3. The Mac sends by handle, HMAC-signing each request with its sendKey. It
 *      names WHAT to send (an alert, a Live Activity), never WHERE: the token
 *      and the topic are chosen here.
 *
 * Every request the phone makes after registering carries an App Attest
 * assertion, so only that phone can change its tokens or mint and revoke keys.
 * A compromised Mac can reach only the phones that gave it a key, and revoking
 * one pair leaves the others alone.
 *
 * LIMITS, because the registration endpoint is public:
 *   - per IP, for each kind of request (`IP_LIMITS`);
 *   - per handle: 120 sends a minute and 5,000 a day, as for a v1 host;
 *   - one global daily budget across all of v2 that answers 503 well before the
 *     Cloudflare account's 100k-a-day quota, which is shared with the updater
 *     (#584 took that down once).
 *
 * v1 is untouched and keeps serving Macs that were provisioned by hand.
 */
import { verifyAssertion, verifyAttestation } from './appattest.mjs';
import { DAY, DEAD_TOKEN, appleReason, b64url, readText, reply, unb64 } from './shared.mjs';

/** Bundles a phone may register as. Debug builds are `.dev` and use APNs sandbox. */
const BUNDLES = new Set(['com.telar.mobile', 'com.telar.mobile.dev']);
const hex = /^[a-f0-9]{64,512}$/i;
const id = /^[a-zA-Z0-9_-]{1,128}$/;
const HANDLE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes
const KEY_ID = /^[A-Za-z0-9_-]{22}$/; // 16 random bytes
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const CHALLENGE_TTL = 300000;
/** A registration the phone has not refreshed in this long is gone, and so is a
 *  send key nobody has used in this long. The phone refreshes on every launch
 *  and token change, so this only catches phones that are gone for good. */
const STALE = 60 * DAY;
/** How far a Mac's clock may be from ours before its signature is refused. */
const SKEW = 300000;
const KEYS_PER_HANDLE = 16;
const HANDLE_MINUTE = 120, HANDLE_DAY = 5000;
/** [requests, per window in ms] for each IP (IPv6 by /64). */
export const IP_LIMITS = { challenge: [30, 3600000], register: [10, 3600000], phone: [240, 3600000], send: [3000, 3600000] };
/** Every v2 request counts. Well below the account's shared 100k a day. */
export const GLOBAL_DAILY_BUDGET = 40000;

const random = n => b64url(crypto.getRandomValues(new Uint8Array(n)));
const retryAfter = ms => ({ 'retry-after': String(Math.max(1, Math.ceil(ms / 1000))) });
const configured = env => Boolean(env.APNS_KEY_BASE64 && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.SIGNER && env.GATE && env.DEVICE_STATE);
const teamOf = env => env.APPATTEST_TEAM_ID || env.APNS_TEAM_ID;

/** An IPv6 client is limited by its /64, which is what one subscriber gets. */
export function ipKey(ip) {
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const front = head ? head.split(':') : [], back = tail ? tail.split(':') : [];
  return [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill('0'), ...back].slice(0, 4).join(':') + '::/64';
}

/** The tokens a phone registers. The same shape at registration and on refresh. */
function tokens(body) {
  if (!body || typeof body.token !== 'string' || !hex.test(body.token)) return;
  if (body.pushToStartToken !== undefined && (typeof body.pushToStartToken !== 'string' || !hex.test(body.pushToStartToken))) return;
  const activities = body.activities ?? [];
  if (!Array.isArray(activities) || activities.length > 8 || !activities.every(a => a && typeof a.id === 'string' && id.test(a.id) && typeof a.token === 'string' && hex.test(a.token))) return;
  return { token: body.token, activities: activities.map(a => ({ id: a.id, token: a.token })), ...(body.pushToStartToken === undefined ? {} : { pushToStartToken: body.pushToStartToken }) };
}

export async function handleV2(request, env, path) {
  const method = request.method;
  const route = path.match(/^\/v2\/devices\/([A-Za-z0-9_-]{43})(\/push|\/keys(?:\/([A-Za-z0-9_-]{22}))?)?$/);
  const kind = method === 'GET' && path === '/v2/challenge' ? 'challenge'
    : method === 'POST' && path === '/v2/devices' ? 'register'
    : route ? (route[2] === '/push' ? 'send' : 'phone') : undefined;
  if (!kind) return reply(404);
  if (!configured(env)) return reply(503);
  let text = '';
  if (method !== 'GET' && method !== 'DELETE') { try { text = await readText(request); } catch { return reply(400); } }
  let body;
  if (kind === 'register') { try { body = JSON.parse(text); } catch { return reply(400); } }
  if (kind === 'register' && (typeof body?.challenge !== 'string' || !CHALLENGE.test(body.challenge))) return reply(400);

  // The gate first, always: nothing below runs for a request over a limit.
  const gate = await env.GATE.get(env.GATE.idFromName('gate')).fetch('https://gate/admit', { method: 'POST', body: JSON.stringify({ kind, ip: ipKey(request.headers.get('cf-connecting-ip')), challenge: body?.challenge }) });
  if (kind === 'challenge' || !gate.ok) return gate;
  await gate.body?.cancel();

  if (kind === 'register') {
    if (!BUNDLES.has(body.bundle) || typeof body.sandbox !== 'boolean' || typeof body.keyId !== 'string' || typeof body.attestation !== 'string' || body.attestation.length > 12000) return reply(400);
    const registered = tokens(body);
    if (!registered) return reply(400);
    let attested;
    try {
      attested = await verifyAttestation({ attestation: unb64(body.attestation), keyId: body.keyId, challenge: body.challenge, teamId: teamOf(env), bundle: body.bundle, ...(env.APPATTEST_ROOT ? { root: env.APPATTEST_ROOT } : {}) });
    } catch { return reply(401); }
    const handle = random(32);
    const now = Date.now();
    const device = { bundle: body.bundle, sandbox: body.sandbox, environment: attested.environment, publicKey: b64url(attested.publicKey), counter: 0, ...registered, createdAt: now, updatedAt: now };
    const stored = await env.DEVICE_STATE.get(env.DEVICE_STATE.idFromName(handle)).fetch('https://device/internal/register', { method: 'POST', body: JSON.stringify(device) });
    if (!stored.ok) return reply(503);
    return reply(201, { handle });
  }
  const headers = new Headers();
  for (const name of ['x-telar-assertion', 'x-telar-key', 'x-telar-timestamp', 'x-telar-signature']) { const value = request.headers.get(name); if (value) headers.set(name, value); }
  return env.DEVICE_STATE.get(env.DEVICE_STATE.idFromName(route[1])).fetch(new Request(`https://device${path}`, { method, headers, ...(text ? { body: text } : {}) }));
}

/**
 * One instance for all of v2: the global budget, the per-IP counters and the
 * outstanding challenges. Each admitted request costs one call here.
 */
export class RelayGate {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    const { kind, ip, challenge } = await request.json();
    const limit = IP_LIMITS[kind];
    if (!limit) return reply(400);
    const now = Date.now(), day = Math.floor(now / DAY), window = Math.floor(now / limit[1]);
    const budget = Number(this.env.GLOBAL_DAILY_BUDGET) || GLOBAL_DAILY_BUDGET;
    const verdict = await this.state.storage.transaction(async tx => {
      const spent = await tx.get('budget');
      const count = spent?.day === day ? spent.count : 0;
      if (count >= budget) return 'budget';
      const key = `ip:${kind}:${ip}`;
      const seen = await tx.get(key);
      const used = seen?.window === window ? seen.count : 0;
      if (used >= limit[0]) return 'ip';
      if (kind === 'register') {
        // Single use: taken out before the attestation is even looked at.
        const issued = await tx.get(`challenge:${challenge}`);
        if (!issued || issued.expires < now) return 'challenge';
        await tx.delete(`challenge:${challenge}`);
      }
      await tx.put('budget', { day, count: count + 1 });
      await tx.put(key, { window, count: used + 1, until: (window + 1) * limit[1] });
      if (kind !== 'challenge') return 'ok';
      const value = random(32);
      await tx.put(`challenge:${value}`, { expires: now + CHALLENGE_TTL });
      return { challenge: value };
    });
    if (await this.state.storage.getAlarm() === null) await this.state.storage.setAlarm(now + 3600000);
    if (verdict === 'budget') return reply(503, { error: 'relay_budget' }, retryAfter((day + 1) * DAY - now));
    if (verdict === 'ip') return reply(429, { error: 'rate_limited' }, retryAfter((window + 1) * limit[1] - now));
    if (verdict === 'challenge') return reply(400, { error: 'challenge' });
    return reply(200, verdict === 'ok' ? {} : verdict);
  }
  /** Sweeps spent counters and expired challenges, so neither grows for ever. */
  async alarm() {
    const now = Date.now();
    let left = false;
    for (const prefix of ['ip:', 'challenge:']) {
      const entries = await this.state.storage.list({ prefix, limit: 1000 });
      const stale = [...entries].filter(([, v]) => (v.until ?? v.expires) < now).map(([k]) => k);
      if (stale.length) await this.state.storage.delete(stale);
      if (entries.size > stale.length) left = true;
    }
    if (left) await this.state.storage.setAlarm(now + 3600000);
  }
}

/** One instance per handle: the phone's tokens, its attested key and its send keys. */
export class RelayDevice {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    const storage = this.state.storage;
    const path = new URL(request.url).pathname;
    if (path === '/internal/register') {
      await storage.put('device', await request.json());
      return reply(200);
    }
    const now = Date.now();
    const device = await storage.get('device');
    if (!device) return reply(404);
    if (now - device.updatedAt > STALE) { await storage.deleteAll(); return reply(410); }
    const route = path.match(/^\/v2\/devices\/[A-Za-z0-9_-]{43}(\/push|\/keys(?:\/([A-Za-z0-9_-]{22}))?)?$/);
    if (!route) return reply(404);
    const text = request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
    if (route[1] === '/push') return this.send(request, path, text, device, now);

    // Everything else is the phone itself, proven by an assertion over exactly this request.
    let counter;
    try {
      counter = await verifyAssertion({ assertion: unb64(request.headers.get('x-telar-assertion') ?? ''), clientData: `${request.method} ${path}\n${text}`, publicKey: unb64(device.publicKey), teamId: this.env.APPATTEST_TEAM_ID || this.env.APNS_TEAM_ID, bundle: device.bundle });
    } catch { return reply(401); }
    // The counter only rises. Checked and stored together, so a replayed
    // assertion loses even when it races the original.
    const fresh = await storage.transaction(async tx => {
      const current = await tx.get('device');
      if (!current || counter <= current.counter) return false;
      current.counter = counter;
      await tx.put('device', current);
      return true;
    });
    if (!fresh) return reply(401);
    let body;
    if (text) { try { body = JSON.parse(text); } catch { return reply(400); } }

    if (!route[1] && request.method === 'PUT') {
      const refreshed = tokens(body);
      if (!refreshed) return reply(400);
      const current = await storage.get('device');
      delete current.pushToStartToken;
      await storage.put('device', { ...current, ...refreshed, updatedAt: now });
      return reply(200);
    }
    if (!route[1] && request.method === 'DELETE') { await storage.deleteAll(); return reply(200); }
    if (route[1] === '/keys' && request.method === 'POST') {
      if (typeof body?.pairing !== 'string' || !id.test(body.pairing)) return reply(400);
      // Re-pairing the same Mac rotates its key: the old one stops working.
      const keys = await storage.list({ prefix: 'key:' });
      const old = [...keys].filter(([, v]) => v.pairing === body.pairing).map(([k]) => k);
      if (keys.size - old.length >= KEYS_PER_HANDLE) return reply(409, { error: 'too_many_keys' });
      if (old.length) await storage.delete(old);
      const keyId = random(16), sendKey = random(32);
      await storage.put(`key:${keyId}`, { pairing: body.pairing, secret: sendKey, createdAt: now, usedAt: now });
      return reply(201, { keyId, sendKey });
    }
    if (route[2] && request.method === 'DELETE') { await storage.delete(`key:${route[2]}`); return reply(200); }
    return reply(405);
  }

  async send(request, path, text, device, now) {
    const storage = this.state.storage;
    if (request.method !== 'POST') return reply(405);
    const keyId = request.headers.get('x-telar-key') ?? '', stamp = request.headers.get('x-telar-timestamp') ?? '', signature = request.headers.get('x-telar-signature') ?? '';
    if (!KEY_ID.test(keyId) || !/^\d{13}$/.test(stamp) || !/^[a-f0-9]{64}$/.test(signature) || Math.abs(now - Number(stamp)) > SKEW) return reply(401);
    const key = await storage.get(`key:${keyId}`);
    if (!key || now - key.usedAt > STALE) return reply(401);
    const hmac = await crypto.subtle.importKey('raw', unb64(key.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const bytes = Uint8Array.from(signature.match(/../g), h => parseInt(h, 16));
    if (!await crypto.subtle.verify('HMAC', hmac, bytes, new TextEncoder().encode(`${stamp}\n${request.method}\n${path}\n${text}`))) return reply(401);

    // One transaction for the replay check and both limits, as in v1.
    const minute = Math.floor(now / 60000), day = Math.floor(now / DAY);
    const allowed = await storage.transaction(async tx => {
      // A signature is remembered for as long as its timestamp is accepted.
      if (await tx.get(`seen:${signature}`)) return 'replay';
      const rate = await tx.get('rate');
      const count = rate?.minute === minute ? rate.count : 0;
      if (count >= HANDLE_MINUTE) return 'minute';
      const budget = await tx.get('budget');
      const spent = budget?.day === day ? budget.count : 0;
      if (spent >= HANDLE_DAY) return 'day';
      await tx.put(`seen:${signature}`, { until: Number(stamp) + SKEW });
      await tx.put('rate', { minute, count: count + 1 });
      await tx.put('budget', { day, count: spent + 1 });
      if (now - key.usedAt > DAY) await tx.put(`key:${keyId}`, { ...key, usedAt: now });
      return 'ok';
    });
    if (await storage.getAlarm() === null) await storage.setAlarm(now + 2 * SKEW);
    if (allowed === 'replay') return reply(401);
    if (allowed === 'day') return reply(429, { error: 'daily_budget' }, retryAfter((day + 1) * DAY - now));
    if (allowed !== 'ok') return reply(429, {}, retryAfter(60000 - now % 60000));

    let body;
    try { body = JSON.parse(text); } catch { return reply(400); }
    const alert = body?.kind === 'alert', activity = body?.kind === 'liveactivity';
    const start = activity && body.start === true;
    if ((!alert && !activity) || typeof body.collapseId !== 'string' || !/^[a-f0-9]{64}$/.test(body.collapseId) || !body.payload?.aps || new TextEncoder().encode(JSON.stringify(body.payload)).length > 4096) return reply(400);
    if (activity && !start && (typeof body.activity !== 'string' || !id.test(body.activity))) return reply(400);
    // WHERE is decided here, from what the phone registered, never by the Mac.
    const token = alert ? device.token : start ? device.pushToStartToken : device.activities.find(a => a.id === body.activity)?.token;
    if (!token) return reply(409, { error: 'not_registered' });
    const topic = alert ? device.bundle : `${device.bundle}.push-type.liveactivity`;
    try {
      const signed = await this.env.SIGNER.get(this.env.SIGNER.idFromName('apns')).fetch('https://internal/token');
      if (!signed.ok) return reply(503);
      const jwt = await signed.text();
      // The key is "Sandbox & Production", so one JWT serves both hosts.
      const response = await fetch(`https://${device.sandbox ? 'api.sandbox.push.apple.com' : 'api.push.apple.com'}/3/device/${token}`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { authorization: `bearer ${jwt}`, 'apns-topic': topic, 'apns-push-type': body.kind, 'apns-priority': alert || start || body.payload.aps.event === 'end' ? '10' : '5', 'apns-expiration': String(Math.floor(now / 1000) + 3600), 'apns-collapse-id': body.collapseId },
        body: JSON.stringify(body.payload),
      });
      let reason;
      if (response.status === 200) await response.body?.cancel();
      else reason = await appleReason(response);
      if (response.status === 410 || DEAD_TOKEN.has(reason)) {
        // Only the dead token goes. The handle and its keys stay, so the next
        // refresh from the phone brings this pair back without re-pairing.
        const current = await storage.get('device');
        if (alert) delete current.token;
        else if (start) delete current.pushToStartToken;
        else current.activities = current.activities.filter(a => a.id !== body.activity);
        await storage.put('device', current);
      }
      return reply(200, { status: response.status, ...(reason === undefined ? {} : { reason }) });
    } catch { return reply(503); }
  }

  /** Forgets signatures whose timestamps would be refused anyway. */
  async alarm() {
    const now = Date.now();
    const seen = await this.state.storage.list({ prefix: 'seen:', limit: 1000 });
    const stale = [...seen].filter(([, v]) => v.until < now).map(([k]) => k);
    if (stale.length) await this.state.storage.delete(stale);
    if (seen.size > stale.length) await this.state.storage.setAlarm(now + 2 * SKEW);
  }
}
