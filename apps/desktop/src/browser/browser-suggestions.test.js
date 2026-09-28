const { test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBrowserSuggestions, siteOrigin, listeningPorts } = require('./browser-suggestions');

test('recent sites discard credentials and callback data', () => {
  expect(siteOrigin('https://example.com/oauth?code=secret#token')).toBe('https://example.com/');
  expect(siteOrigin('https://user:secret@example.com/')).toBeNull();
  expect(siteOrigin('chrome-extension://extension/popup.html')).toBeNull();
  expect(siteOrigin('about:blank')).toBeNull();
});
test('port discovery accepts local listeners, deduplicates and excludes external interfaces', () => {
  expect(listeningPorts('p100\nn*:3000\nn127.0.0.1:3000\nn[::1]:5173\nn192.168.0.5:80\nn[::]:8080')).toEqual([3000, 5173, 8080]);
});
test('history persists per project, supports removal, and only live HTML servers are suggested', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telar-suggestions-'));
  const probed = [];
  const dependencies = { scanPorts: async () => [3000, 4000, 5000], fetch: async (url, init) => {
    probed.push(url); expect(init.method).toBe('HEAD'); expect(init.redirect).toBe('manual');
    return new Response(null, { headers: { 'content-type': url.includes(':3000') ? 'text/html' : 'application/json' } });
  } };
  try {
    const store = createBrowserSuggestions(root, dependencies);
    store.remember('project-a', 'https://example.com/path?code=private');
    store.remember('project-b', 'https://another.example/');
    const a = await store.list('project-a', [5000]);
    expect(a.recent).toEqual([{ url: 'https://example.com/' }]);
    expect(a.servers).toEqual([{ url: 'http://127.0.0.1:3000/', port: 3000 }]);
    expect(probed).toHaveLength(2);
    const restored = createBrowserSuggestions(root, dependencies);
    expect((await restored.list('project-b')).recent).toEqual([{ url: 'https://another.example/' }]);
    restored.remove('project-a', 'https://example.com/');
    expect((await restored.list('project-a')).recent).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'browser-recent-sites.json'), 'utf8')).not.toContain('private');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
