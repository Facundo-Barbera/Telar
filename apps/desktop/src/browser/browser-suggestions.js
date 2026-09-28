const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function siteOrigin(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    // Suggestions remember sites, never login callback paths, queries or fragments.
    return url.origin + '/';
  } catch { return null; }
}

function listeningPorts(text) {
  return [...new Set(text.split('\n').flatMap(line => {
    const match = /^n(?:\*|127\.0\.0\.1|localhost|\[::1\]|\[::\]|0\.0\.0\.0):(\d+)$/.exec(line.trim());
    const port = match ? Number(match[1]) : 0;
    return port > 0 && port <= 65535 ? [port] : [];
  }))].slice(0, 64);
}

function scanPorts() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return Promise.resolve([]);
  return new Promise(resolve => {
    execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'], { timeout: 2000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? [] : listeningPorts(stdout));
    });
  });
}

function createBrowserSuggestions(userData, dependencies = {}) {
  const filename = path.join(userData, 'browser-recent-sites.json');
  let profiles = {};
  try {
    const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (data.version === 1 && data.profiles && typeof data.profiles === 'object') profiles = data.profiles;
  } catch { /* First run, or an unusable suggestions cache. */ }
  let discovery;
  let discoveredAt = 0;
  let servers = [];
  const persist = () => {
    try {
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(filename + '.tmp', JSON.stringify({ version: 1, profiles }));
      fs.renameSync(filename + '.tmp', filename);
    } catch { /* Suggestions do not gate browsing. */ }
  };
  const recent = profile => Array.isArray(profiles[profile]) ? profiles[profile].filter(entry => entry && typeof entry.url === "string" && siteOrigin(entry.url) === entry.url).slice(0, 8) : [];
  return {
    remember(profile, raw) {
      const url = siteOrigin(raw);
      if (!profile || !url) return;
      const entries = recent(profile);
      if (entries[0]?.url === url) return;
      // Use own-property assignment even for an unusual profile name.
      Object.defineProperty(profiles, profile, { value: [{ url }, ...entries.filter(entry => entry.url !== url)].slice(0, 8), enumerable: true, configurable: true, writable: true });
      persist();
    },
    /**
     * Metadata migration only: move one key's remembered sites to another
     * (a project key that became a named profile id). A no-op when the source
     * has nothing or the target already has history — this never merges two
     * identities' browsing into one list.
     */
    adopt(fromProfile, toProfile) {
      if (!fromProfile || !toProfile || fromProfile === toProfile) return;
      if (!Object.hasOwn(profiles, fromProfile) || Object.hasOwn(profiles, toProfile)) return;
      Object.defineProperty(profiles, toProfile, { value: recent(fromProfile), enumerable: true, configurable: true, writable: true });
      delete profiles[fromProfile];
      persist();
    },
    remove(profile, raw) {
      if (!Object.hasOwn(profiles, profile)) return;
      profiles[profile] = recent(profile).filter(entry => entry.url !== raw);
      persist();
    },
    async list(profile, excludedPorts = []) {
      if (!discovery && Date.now() - discoveredAt > 15000) {
        discovery = (async () => {
          const ports = await (dependencies.scanPorts || scanPorts)();
          const found = [];
          // Four bounded probes at once; HEAD only, no cookies or redirects.
          for (let index = 0; index < ports.length; index += 4) {
            await Promise.all(ports.slice(index, index + 4).filter(port => !excludedPorts.includes(port)).map(async port => {
              const url = `http://127.0.0.1:${port}/`;
              try {
                const response = await (dependencies.fetch || fetch)(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(400) });
                if (response.ok && /text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '')) found.push({ url, port });
                await response.body?.cancel();
              } catch { /* A listening socket need not be a web server. */ }
            }));
          }
          servers = found.sort((a, b) => a.port - b.port);
          discoveredAt = Date.now();
        })().finally(() => { discovery = undefined; });
      }
      await discovery;
      return { recent: recent(profile), servers: servers.filter(server => !excludedPorts.includes(server.port)) };
    },
  };
}
module.exports = { createBrowserSuggestions, siteOrigin, listeningPorts };
