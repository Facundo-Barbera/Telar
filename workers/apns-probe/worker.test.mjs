import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import worker, { jwt } from './worker.mjs';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const env = { PROBE_TOKEN: 'test-only', PROBE_EXPIRES_AT: String(Date.now() + 60000), APNS_KEY_BASE64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'), APNS_KEY_ID: 'TESTKEY', APNS_TEAM_ID: 'TESTTEAM' };
test('provider token is verifiable ES256 with Apple claims', async () => {
  const token = await jwt(env);
  const [head, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { alg: 'ES256', kid: 'TESTKEY' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.iss, 'TESTTEAM');
  assert.ok(Math.abs(claims.iat - Date.now() / 1000) < 5);
  assert.ok(verify('sha256', Buffer.from(`${head}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
});
test('wrong paths, missing authentication, and expired probes cannot send', async () => {
  assert.equal((await worker.fetch(new Request('https://test/probe'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://test/probe', { method: 'POST' }), env)).status, 401);
  assert.equal((await worker.fetch(new Request('https://test/probe', { method: 'POST', headers: { authorization: 'Bearer test-only' } }), { ...env, PROBE_EXPIRES_AT: '0' })).status, 410);
});
test('only fixed Apple destination and test token are used; result excludes provider data', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, `https://api.push.apple.com/3/device/${'0'.repeat(64)}`);
      assert.equal(init.headers['apns-topic'], 'com.telar.mobile');
      assert.ok(init.headers.authorization.startsWith('bearer '));
      return Response.json({ reason: 'BadDeviceToken', privateData: 'DO NOT RETURN' }, { status: 400, headers: { 'apns-id': 'test-id' } });
    };
    const result = await worker.fetch(new Request('https://test/probe?target=evil', { method: 'POST', headers: { authorization: 'Bearer test-only' } }), env);
    assert.deepEqual(await result.json(), { status: 400, reason: 'BadDeviceToken', apnsResponse: true });
  } finally { globalThis.fetch = original; }
});
