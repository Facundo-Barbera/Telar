const { pathToFileURL } = require("node:url");
const { isProtectedUrl } = require("../protected-urls");

const SEARCH_URL = "https://www.google.com/search?q=";

const IP_HOST = /^(\d{1,3}(?:\.\d{1,3}){3}|\[[\da-fA-F:]+\])$/;

function looksLikeAddress(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) return true;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return true;
  if (/\s/.test(trimmed)) return false;
  if (trimmed.includes(".")) return true;
  const host = trimmed.split(/[/?#]/, 1)[0].replace(/:\d+$/, "");
  return host === "localhost" || IP_HOST.test(host);
}

const VIEW_SOURCE_PREFIX = "view-source:";

function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "about:blank") return "about:blank";

  if (trimmed.toLowerCase().startsWith(VIEW_SOURCE_PREFIX)) {
    const inner = parseUrl(trimmed.slice(VIEW_SOURCE_PREFIX.length));
    if (!inner || (inner.protocol !== "http:" && inner.protocol !== "https:")) {
      throw new Error("The integrated browser only views the source of http and https pages.");
    }
    return `${VIEW_SOURCE_PREFIX}${inner.href}`;
  }

  if (!looksLikeAddress(trimmed)) return `${SEARCH_URL}${encodeURIComponent(trimmed)}`;

  const candidate = trimmed.startsWith("/")
    ? pathToFileURL(trimmed).href
    : /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `http://${trimmed}`;
  const parsed = new URL(candidate);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "file:") {
    throw new Error("The integrated browser only opens http, https and file URLs.");
  }
  return parsed.href;
}

function normalizePopupUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "about:blank") return "about:blank";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (isProtectedUrl(parsed.href)) return null;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href;
}

const EXTERNAL_OPEN_DEDUPE_MS = 2_000;

function parseUrl(value) {
  try {
    return new URL(String(value ?? ""));
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function sameLoopbackServer(target, appUrl) {
  if (target.protocol !== appUrl.protocol) return false;
  if (target.port !== appUrl.port) return false;
  return LOOPBACK_HOSTS.has(target.hostname) && LOOPBACK_HOSTS.has(appUrl.hostname);
}

function createExternalLinkPolicy({ appUrl, now = Date.now, dedupeMs = EXTERNAL_OPEN_DEDUPE_MS } = {}) {
  const parsedAppUrl = parseUrl(appUrl);

  if (!parsedAppUrl || (parsedAppUrl.protocol !== "http:" && parsedAppUrl.protocol !== "https:")) {
    throw new Error(
      `External-link policy needs an http(s) app URL to recognise Telar's own UI; got ${JSON.stringify(appUrl ?? null)}.`,
    );
  }
  const appOrigin = parsedAppUrl.origin;
  let lastHref = null;
  let lastAt = 0;
  return {
    decide(target) {
      const parsed = parseUrl(target);

      if (
        parsed &&
        (parsed.href === "about:blank" || parsed.origin === appOrigin || sameLoopbackServer(parsed, parsedAppUrl))
      ) {
        return { action: "allow", openExternal: null };
      }

      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        return { action: "deny", openExternal: null };
      }
      const at = now();
      if (parsed.href === lastHref && at - lastAt < dedupeMs) {
        return { action: "deny", openExternal: null, duplicateOf: parsed.href };
      }
      lastHref = parsed.href;
      lastAt = at;

      return { action: "deny", openExternal: parsed.href };
    },
  };
}

function externalOpenTarget(value) {
  const parsed = parseUrl(value);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return null;
  return parsed.href;
}

module.exports = { SEARCH_URL, looksLikeAddress, VIEW_SOURCE_PREFIX, normalizeUrl, normalizePopupUrl, createExternalLinkPolicy, externalOpenTarget };
