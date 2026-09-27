// Personal relay. Phones register themselves with App Attest (`v2.mjs`); no Mac is provisioned.
import { digest, reply } from './shared.mjs';
import { handleV2 } from './v2.mjs';
export { RelayGate, RelayDevice } from './v2.mjs';
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const json64 = value => encode(new TextEncoder().encode(JSON.stringify(value)));
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
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/health') return reply(200, { service: 'telar-push', version: 2 });
    // v2 authenticates per phone and per pair. Nothing else is served, v1 included.
    if (path.startsWith('/v2/')) return handleV2(request, env, path);
    return reply(404);
  },
};

// One serialized signer across all handles and isolates. Reuse survives eviction.
// No public route resolves to this class.
export class RelaySigner {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch() {
    const jwt = await this.state.blockConcurrencyWhile(() => this.state.storage.transaction(tx => providerToken(this.env, tx)));
    return new Response(jwt, { headers: { 'cache-control': 'no-store' } });
  }
}
