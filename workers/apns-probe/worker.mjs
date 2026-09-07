// Disposable transport probe. No real device tokens, user payloads, or public sender API.
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const json64 = value => encode(new TextEncoder().encode(JSON.stringify(value)));
export async function jwt(env) {
  const pem = atob(env.APNS_KEY_BASE64);
  const der = Uint8Array.from(atob(pem.replace(/-----[^\n]+-----|\s/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const message = `${json64({ alg: 'ES256', kid: env.APNS_KEY_ID })}.${json64({ iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) })}`;
  return `${message}.${encode(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(message)))}`;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/probe') return new Response(null, { status: 404 });
    if (!env.PROBE_TOKEN || request.headers.get('authorization') !== `Bearer ${env.PROBE_TOKEN}`) return new Response(null, { status: 401 });
    // A forgotten test deployment expires automatically even if CI cleanup is interrupted.
    if (Date.now() > Number(env.PROBE_EXPIRES_AT)) return new Response(null, { status: 410 });
    try {
      const authorization = url.searchParams.get('unsigned') === '1' ? undefined : `bearer ${await jwt(env)}`;
      const response = await fetch(`https://api.push.apple.com/3/device/${'0'.repeat(64)}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { ...(authorization ? { authorization } : {}), 'apns-topic': 'com.telar.mobile', 'apns-push-type': 'alert', 'apns-priority': '10' },
        body: JSON.stringify({ aps: { alert: 'Telar transport probe' } }),
      });
      const body = await response.json().catch(() => ({}));
      const reasons = ['BadDeviceToken', 'MissingProviderToken', 'InvalidProviderToken', 'ExpiredProviderToken', 'DeviceTokenNotForTopic', 'Forbidden', 'TooManyProviderTokenUpdates'];
      return Response.json({ status: response.status, reason: reasons.includes(body.reason) ? body.reason : 'Other', apnsResponse: response.headers.has('apns-id') });
    } catch (error) {
      const message = String(error?.message ?? '').toLowerCase();
      const errorKind = message.includes('connection') ? 'Connection failure' : message.includes('timeout') || message.includes('abort') ? 'Timeout' : message.includes('key') ? 'Key import or signing failure' : 'Fetch failure';
      let detail = String(error?.message ?? '');
      for (const value of Object.values(env)) if (typeof value === 'string' && value) detail = detail.split(value).join('[redacted]');
      detail = detail.replace(/[A-Za-z0-9_+\/=-]{20,}/g, '[redacted]').slice(0, 160);
      return Response.json({ error: errorKind, detail }, { status: 502 });
    }
  },
};
