"use strict";
const fs = require("node:fs");
const path = require("node:path");

const REMOTE_FILE_VERSION = 1;

function posture(state, { requireAuth, exposure = "local-only", tailscaleServe = false } = {}) {
  return { state, trusted: state === "trusted" || state === "fresh", requireAuth, exposure, tailscaleServe };
}

function remotePath(home) {
  return path.join(home, "remote", "remote.json");
}

function readRemotePosture(home, readFile = fs.readFileSync) {
  let text;
  try {
    text = readFile(remotePath(home), "utf8");
  } catch {
    return posture("fresh", { requireAuth: true });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return posture("unreadable", { requireAuth: false });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return posture("unreadable", { requireAuth: false });
  if (parsed.version !== REMOTE_FILE_VERSION) return posture("unknown-version", { requireAuth: false });
  return posture("trusted", {
    requireAuth: parsed.requireAuth === true,
    exposure: parsed.exposure === "network-accessible" ? "network-accessible" : "local-only",
    tailscaleServe: parsed.tailscaleServe === true,
  });
}

function serverBindHost(home, readFile) {
  const remote = readRemotePosture(home, readFile);
  return remote.trusted && remote.exposure === "network-accessible" && remote.requireAuth ? "0.0.0.0" : "127.0.0.1";
}

function tailscaleServeRequested(home, readFile) {
  const remote = readRemotePosture(home, readFile);
  return remote.trusted && remote.tailscaleServe && remote.requireAuth;
}

function gateWillRequireAuth(home, readFile) {
  return readRemotePosture(home, readFile).requireAuth;
}

module.exports = {
  REMOTE_FILE_VERSION,
  readRemotePosture,
  serverBindHost,
  tailscaleServeRequested,
  gateWillRequireAuth,
};
