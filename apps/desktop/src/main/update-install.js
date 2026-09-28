const QUIT_GRACE_MS = 10_000;

function createInstallGate({ now = Date.now, graceMs = QUIT_GRACE_MS } = {}) {
  let startedAt = null;
  return {
    press({ packaged = true, devBuild = false } = {}) {
      if (!packaged || devBuild) return "unsupported";
      const at = now();
      if (startedAt === null) {
        startedAt = at;
        return "install";
      }
      if (at - startedAt < graceMs) return "pending";
      startedAt = at;
      return "retry";
    },

    startedAt: () => startedAt,

    reset() {
      startedAt = null;
    },
  };
}

const PLANNED_RESTART_FILE = "planned-restart.json";

function plannedRestartPath(engineRoot) {
  return require("node:path").join(engineRoot, PLANNED_RESTART_FILE);
}

function writePlannedRestart(engineRoot, { now = Date.now, fs = require("node:fs") } = {}) {
  try {
    fs.mkdirSync(engineRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(plannedRestartPath(engineRoot), JSON.stringify({ version: 1, reason: "update", at: now() }), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function clearPlannedRestart(engineRoot, { fs = require("node:fs") } = {}) {
  try {
    fs.rmSync(plannedRestartPath(engineRoot), { force: true });
  } catch {
  }
}

module.exports = { QUIT_GRACE_MS, PLANNED_RESTART_FILE, createInstallGate, writePlannedRestart, clearPlannedRestart };
