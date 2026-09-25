/**
 * APP ATTEST, VERIFIED WITH NOTHING BUT WEBCRYPTO — relay v2.
 *
 * v2's registration endpoint is public, so App Attest is what stops anyone
 * from using this relay as a free sender to `com.telar.mobile`. An attestation
 * is accepted only if Apple's own root signed the chain, the key was minted by
 * a build of Telar signed by our team, and the nonce binds the one-time
 * challenge this relay issued. After that, each request the phone makes is
 * signed with the same key (an assertion) and must carry a higher counter.
 *
 * Follows Apple's "Validating apps that connect to your server", steps 1–9.
 * The CBOR and DER readers below only handle what App Attest emits, and throw
 * on anything else. Every failure is a thrown error; callers answer 401.
 */
import { sha256, unb64 } from './shared.mjs';

/** Apple App Attestation Root CA (valid 2020-03-18 to 2045-03-15), DER as
 *  base64. SHA-256 fingerprint 1CB9823BA28BA6AD2D33A006941DE2AE4F513EF1D4E831B9F7E0FA7B6242C932. */
export const APPLE_APP_ATTEST_ROOT = 'MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNaFw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlvbiBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdhNbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9auYen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijVoyFraWVIyd/dganmrduC1bmTBGwD';

const OID = {
  ecdsaSha256: '2a8648ce3d040302', ecdsaSha384: '2a8648ce3d040303',
  p256: '2a8648ce3d030107', p384: '2b81040022',
  nonce: '2a864886f763640802', // 1.2.840.113635.100.8.2
};
/** `appattest` followed by seven zero bytes in production, `appattestdevelop` in development. */
const AAGUID = { production: 'appattest\0\0\0\0\0\0\0', development: 'appattestdevelop' };

const fail = () => { throw Error('appattest'); };
const hexOf = bytes => [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const u32 = (bytes, at) => ((bytes[at] << 24) >>> 0) + (bytes[at+1] << 16) + (bytes[at+2] << 8) + bytes[at+3];

/** Definite-length CBOR: integers, byte and text strings, arrays, maps, true/false/null. */
export function cbor(bytes) {
  let at = 0;
  const take = n => { if (n > bytes.length - at) fail(); const v = bytes.subarray(at, at + n); at += n; return v; };
  const argument = info => {
    if (info < 24) return info;
    if (info > 27) fail();
    let n = 0; for (const b of take(1 << (info - 24))) n = n * 256 + b;
    return n;
  };
  const item = depth => {
    if (depth > 8) fail();
    const [head] = take(1), major = head >> 5, n = argument(head & 31);
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2) return take(n);
    if (major === 3) return new TextDecoder().decode(take(n));
    if (n > bytes.length - at) fail(); // every element is at least one byte
    if (major === 4) return Array.from({ length: n }, () => item(depth + 1));
    if (major === 5) { const map = new Map(); for (let i = 0; i < n; i++) { const key = item(depth + 1); map.set(key, item(depth + 1)); } return map; }
    if (major === 7 && n >= 20 && n <= 22) return [false, true, null][n - 20];
    fail();
  };
  const value = item(0);
  if (at !== bytes.length) fail();
  return value;
}

/** One DER TLV at `at`, bounded by `limit`. Single-byte tags only, which is all X.509 needs here. */
function der(buf, at = 0, limit = buf.length) {
  if (at + 2 > limit) fail();
  const tag = buf[at]; let length = buf[at+1], start = at + 2;
  if (length & 0x80) {
    const n = length & 0x7f; if (n < 1 || n > 3 || start + n > limit) fail();
    length = 0; for (let i = 0; i < n; i++) length = length * 256 + buf[start + i];
    start += n;
  }
  const end = start + length; if (end > limit) fail();
  return { buf, tag, start, end, whole: buf.subarray(at, end), content: buf.subarray(start, end) };
}
const kids = node => { const out = []; for (let at = node.start; at < node.end;) { const child = der(node.buf, at, node.end); out.push(child); at = child.end; } return out; };

function time(node) {
  const text = new TextDecoder().decode(node.content);
  const m = node.tag === 0x17 ? text.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/) : node.tag === 0x18 ? text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/) : null;
  if (!m) fail();
  let year = Number(m[1]); if (node.tag === 0x17) year += year < 50 ? 2000 : 1900;
  return Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

export function certificate(bytes) {
  const [tbs, algorithm, signature] = kids(der(bytes));
  let fields = kids(tbs); if (fields[0]?.tag === 0xa0) fields = fields.slice(1);
  const [, , issuer, validity, subject, spki, ...rest] = fields;
  if (!spki || signature.tag !== 0x03) fail();
  const [notBefore, notAfter] = kids(validity).map(time);
  const [keyAlgorithm, key] = kids(spki);
  const curve = { [OID.p256]: 'P-256', [OID.p384]: 'P-384' }[hexOf(kids(keyAlgorithm)[1]?.content ?? [])] ?? fail();
  const extensions = new Map();
  const wrapper = rest.find(node => node.tag === 0xa3);
  if (wrapper) for (const extension of kids(kids(wrapper)[0])) { const parts = kids(extension); extensions.set(hexOf(parts[0].content), parts[parts.length - 1].content); }
  return {
    tbs: tbs.whole, algorithm: hexOf(kids(algorithm)[0].content), signature: signature.content.subarray(1),
    issuer: hexOf(issuer.whole), subject: hexOf(subject.whole), spki: spki.whole, curve, point: key.content.subarray(1),
    notBefore, notAfter, extensions,
  };
}

/** X.509 and assertions carry ECDSA signatures as DER (r, s); WebCrypto wants fixed-width r‖s. */
function rawSignature(signature, size) {
  const [r, s] = kids(der(signature)).map(({ content }) => {
    let v = content; while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) fail();
    const out = new Uint8Array(size); out.set(v, size - v.length); return out;
  });
  if (!s) fail();
  return concat(r, s);
}
async function verifyECDSA(spki, curve, hash, signature, data) {
  const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: curve }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash }, key, rawSignature(signature, curve === 'P-384' ? 48 : 32), data);
}
async function issuedBy(child, parent, now) {
  if (child.issuer !== parent.subject || now < child.notBefore || now > child.notAfter) fail();
  const hash = { [OID.ecdsaSha256]: 'SHA-256', [OID.ecdsaSha384]: 'SHA-384' }[child.algorithm] ?? fail();
  if (!await verifyECDSA(parent.spki, parent.curve, hash, child.signature, child.tbs)) fail();
}

const appId = (teamId, bundle) => sha256(`${teamId}.${bundle}`);

/**
 * A new App Attest key, or a throw. `challenge` is the string this relay
 * issued, and the phone hashes its UTF-8 bytes as the clientDataHash. `keyId`
 * is the base64 key identifier from `DCAppAttestService.generateKey`.
 * Returns the key to check later assertions against, and which App Attest
 * environment minted it.
 */
export async function verifyAttestation({ attestation, keyId, challenge, teamId, bundle, root = APPLE_APP_ATTEST_ROOT, now = Date.now() }) {
  const object = cbor(attestation);
  if (!(object instanceof Map) || object.get('fmt') !== 'apple-appattest') fail();
  const authData = object.get('authData'), x5c = object.get('attStmt')?.get?.('x5c');
  if (!(authData instanceof Uint8Array) || authData.length < 55 || !Array.isArray(x5c) || x5c.length !== 2 || !x5c.every(c => c instanceof Uint8Array)) fail();
  // 1. The chain ends at Apple's root, and every link is in date.
  const [leaf, intermediate] = x5c.map(certificate), anchor = certificate(unb64(root));
  if (now < anchor.notBefore || now > anchor.notAfter) fail();
  await issuedBy(intermediate, anchor, now);
  await issuedBy(leaf, intermediate, now);
  if (leaf.curve !== 'P-256') fail();
  // 2–4. The leaf's nonce extension is SHA256(authData ‖ SHA256(challenge)).
  const nonce = await sha256(concat(authData, await sha256(challenge)));
  const extension = leaf.extensions.get(OID.nonce) ?? fail();
  const tagged = kids(der(extension))[0];
  if (tagged?.tag !== 0xa1) fail();
  const octets = kids(tagged)[0];
  if (octets?.tag !== 0x04 || !equal(octets.content, nonce)) fail();
  // 5. The key identifier is the hash of the leaf's public key.
  const keyHash = await sha256(leaf.point);
  if (!equal(keyHash, unb64(keyId))) fail();
  // 6. Minted for our App ID: team plus bundle.
  if (!equal(authData.subarray(0, 32), await appId(teamId, bundle))) fail();
  // 7. A brand-new key has never signed anything.
  if (u32(authData, 33) !== 0) fail();
  // 8. App Attest's own environment marker.
  const aaguid = new TextDecoder().decode(authData.subarray(37, 53));
  const environment = Object.keys(AAGUID).find(name => AAGUID[name] === aaguid) ?? fail();
  // 9. The credential id is the key identifier again.
  const length = (authData[53] << 8) + authData[54];
  if (!equal(authData.subarray(55, 55 + length), keyHash)) fail();
  return { publicKey: leaf.spki, environment };
}

/**
 * A later request from the same phone, or a throw. `clientData` is exactly
 * what the phone hashed. Returns the assertion's counter; the caller must
 * refuse it unless it is higher than the last one it stored.
 */
export async function verifyAssertion({ assertion, clientData, publicKey, teamId, bundle }) {
  const object = cbor(assertion);
  const signature = object instanceof Map ? object.get('signature') : undefined, authData = object instanceof Map ? object.get('authenticatorData') : undefined;
  if (!(signature instanceof Uint8Array) || !(authData instanceof Uint8Array) || authData.length < 37) fail();
  if (!equal(authData.subarray(0, 32), await appId(teamId, bundle))) fail();
  const nonce = await sha256(concat(authData, await sha256(clientData)));
  if (!await verifyECDSA(publicKey, 'P-256', 'SHA-256', signature, nonce)) fail();
  return u32(authData, 33);
}
