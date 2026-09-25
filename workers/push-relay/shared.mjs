// What v1 (`worker.mjs`) and v2 (`v2.mjs`) both need, so neither imports the other.
export const reply = (status, body = {}, headers = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
export const DAY = 86400000;
/** Apple names a rejection in its JSON body. ONLY that word travels back to the
 *  host: no provider body, no credential, no device token, no payload. */
export async function appleReason(response) {
  try {
    const value = JSON.parse(await response.text())?.reason;
    return typeof value === 'string' && /^[A-Za-z]{1,64}$/.test(value) ? value : undefined;
  } catch { return undefined; }
}
/** The four Apple reasons that mean the token itself is gone, so this relay can
 *  drop its own copy of the registration rather than hold it for a dead phone. */
export const DEAD_TOKEN = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered', 'ExpiredToken']);
export const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
/** Standard or URL-safe base64, padded or not. Throws on anything else. */
export const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes));
}
export async function digest(value) {
  return [...await sha256(value)].map(x => x.toString(16).padStart(2,'0')).join('');
}
export async function readText(request, max = 16384) {
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
  return new TextDecoder().decode(bytes);
}
export async function readJSON(request, max = 16384) { return JSON.parse(await readText(request, max)); }
