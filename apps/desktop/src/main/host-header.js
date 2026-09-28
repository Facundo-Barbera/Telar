const HOST_HEADER = "x-telar-host";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function parseUrl(value) {
  try {
    return new URL(String(value ?? ""));
  } catch {
    return null;
  }
}

function isOwnServer(target, appUrl) {
  const parsedTarget = parseUrl(target);
  const parsedApp = parseUrl(appUrl);
  if (!parsedTarget || !parsedApp) return false;
  if (parsedTarget.protocol !== parsedApp.protocol) return false;
  if (parsedTarget.port !== parsedApp.port) return false;
  return LOOPBACK_HOSTS.has(parsedTarget.hostname) && LOOPBACK_HOSTS.has(parsedApp.hostname);
}

function attachHostHeader(targetSession, { appUrl, token, header = HOST_HEADER } = {}) {
  if (!targetSession?.webRequest || !token || !parseUrl(appUrl)) return false;
  targetSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!isOwnServer(details.url, appUrl)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    callback({ requestHeaders: { ...details.requestHeaders, [header]: token } });
  });
  return true;
}

module.exports = { HOST_HEADER, isOwnServer, attachHostHeader };
