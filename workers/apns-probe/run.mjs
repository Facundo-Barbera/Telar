import { readFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import http2 from 'node:http2';
import { jwt } from './worker.mjs';
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const name = `telar-apns-probe-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
if (!/^[a-f0-9]{32}$/.test(account ?? '') || !/^telar-apns-probe-\d+-\d+$/.test(name)) throw Error('Invalid test configuration');
for (const field of ['CLOUDFLARE_API_TOKEN', 'TELAR_APNS_KEY_P8_BASE64', 'TELAR_APNS_KEY_ID', 'TELAR_APNS_TEAM_ID']) if (!process.env[field]) throw Error(`Missing ${field}`);
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/workers`;
async function api(path, init = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers }, signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (!response.ok || result.success === false) throw Error(`Cloudflare ${init.method ?? 'GET'} ${path}: HTTP ${response.status}; codes ${(result.errors ?? []).map(e => e.code).join(',')}`);
  return result.result;
}
const probeToken = randomBytes(32).toString('hex');
const report = line => { console.log(line); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n'); };
let attempted = false;
try {
  const bindings = Object.entries({ PROBE_TOKEN: probeToken, PROBE_EXPIRES_AT: String(Date.now() + 600000), APNS_KEY_BASE64: process.env.TELAR_APNS_KEY_P8_BASE64, APNS_KEY_ID: process.env.TELAR_APNS_KEY_ID, APNS_TEAM_ID: process.env.TELAR_APNS_TEAM_ID }).map(([name, text]) => ({ name, text, type: 'secret_text' }));
  const form = new FormData();
  // Inherit the existing Free account plan. No databases, queues, containers, or subscription changes.
  form.set('metadata', JSON.stringify({ main_module: 'worker.mjs', compatibility_date: '2026-09-01', bindings, observability: { enabled: false } }));
  form.set('worker.mjs', new Blob([readFileSync(new URL('./worker.mjs', import.meta.url))], { type: 'application/javascript+module' }), 'worker.mjs');
  attempted = true;
  await api(`/scripts/${name}`, { method: 'PUT', body: form });
  await api(`/scripts/${name}/subdomain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, previews_enabled: false }) });
  const { subdomain } = await api('/subdomain');
  const url = `https://${name}.${subdomain}.workers.dev/probe`;
  report(`Temporary Worker: ${name}`);
  // DNS/edge propagation may take a short time after creation. Retry the unauthenticated guard only.
  let ready = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    try { const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5000) }); if (response.status === 401) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (!ready) throw Error('Worker endpoint did not become ready');
  report('Unauthenticated probe rejected: 401');
  const directJWT = await jwt({ APNS_KEY_BASE64: process.env.TELAR_APNS_KEY_P8_BASE64, APNS_KEY_ID: process.env.TELAR_APNS_KEY_ID, APNS_TEAM_ID: process.env.TELAR_APNS_TEAM_ID });
  const direct = await new Promise((resolve, reject) => {
    const client = http2.connect('https://api.push.apple.com');
    const timer = setTimeout(() => { client.destroy(); reject(Error('Direct APNs timeout')); }, 10000);
    client.on('error', () => { clearTimeout(timer); reject(Error('Direct APNs transport failure')); });
    const request = client.request({ ':method': 'POST', ':path': `/3/device/${'0'.repeat(64)}`, authorization: `bearer ${directJWT}`, 'apns-topic': 'com.telar.mobile', 'apns-push-type': 'alert' });
    let status = 0, body = '';
    request.on('response', h => { status = h[':status']; });
    request.on('data', d => { if (body.length < 2048) body += d; });
    request.on('error', () => { clearTimeout(timer); client.destroy(); reject(Error('Direct APNs request failure')); });
    request.on('end', () => { clearTimeout(timer); client.close(); resolve({ status, badDevice: body.includes('BadDeviceToken') }); });
    request.end(JSON.stringify({ aps: { alert: 'Telar transport probe' } }));
  });
  report(`Direct Node HTTP/2 control: Apple status ${direct.status}; BadDeviceToken ${direct.badDevice}`);
  let signedPassed = false;
  for (const unsigned of [true, false]) {
    const response = await fetch(url + (unsigned ? '?unsigned=1' : ''), { method: 'POST', headers: { authorization: `Bearer ${probeToken}` }, signal: AbortSignal.timeout(20000) });
    const result = await response.json();
    // Only the fixed, redacted Worker response is printed. Never raw provider or API responses.
    report(`${unsigned ? 'Unsigned' : 'Signed'} APNs probe: HTTP ${response.status}; Apple status ${Number(result.status) || 0}; reason ${String(result.reason ?? result.error).replace(/[^A-Za-z ]/g, '').slice(0,60)}; APNs response ${result.apnsResponse === true}`);
    if (!unsigned) signedPassed = response.ok && result.apnsResponse && result.status === 400 && result.reason === 'BadDeviceToken';
  }
  if (!signedPassed) throw Error('Signed Worker APNs transport did not meet acceptance criteria');
  report('Transport/signing probe passed. No real-device delivery was tested.');
} finally {
  if (attempted) {
    await api(`/scripts/${name}`, { method: 'DELETE' });
    report('Temporary Worker and its secret bindings deleted.');
  }
}
