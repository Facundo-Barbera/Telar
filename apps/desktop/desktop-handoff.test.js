// THE IDENTITY HAND-OFF'S DECISIONS, PINNED (#1042). desktop-handoff-core.js
// is the Electron-free half. The swap helper and the signature gate run for
// real on macOS against throwaway fake bundles, with `open` replaced by a stub.

const { describe, expect, test } = require("bun:test");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("./desktop-handoff-core");

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const SHA = Buffer.alloc(64, 1).toString("base64");
const TEAM = "MM74W7WGAM";
const goodManifest = (over = {}) => ({
  version: "0.2.0-nightly.20261001.1",
  channel: "nightly",
  zip: "Telar-0.2.0-nightly.20261001.1-arm64-mac.zip",
  sha512: SHA,
  size: 150_000_000,
  bundleId: core.NEW_BUNDLE_ID,
  teamId: TEAM,
  ...over,
});

describe("where the hand-off looks", () => {
  test("the feed URL is read from app-update.yml and the manifest sits under N's prefix", () => {
    const feed = core.readFeedUrl("provider: generic\nurl: https://updates.example/\nchannel: nightly\n");
    expect(feed).toBe("https://updates.example");
    expect(core.manifestUrl(feed, "beta")).toBe("https://updates.example/io.github.novarix.telar/handoff-beta-mac.json");
    expect(core.zipUrl(feed, goodManifest())).toBe(`https://updates.example/io.github.novarix.telar/${goodManifest().zip}`);
  });

  test("no url line is no feed", () => {
    expect(core.readFeedUrl("provider: generic\n")).toBeNull();
  });
});

describe("the manifest is checked field by field", () => {
  test("a well-formed manifest for this channel passes", () => {
    expect(core.validateManifest(goodManifest(), { channel: "nightly" })).toEqual({ ok: true, manifest: goodManifest() });
  });

  test("any bundle id but N's is refused, the old one included", () => {
    for (const bundleId of [core.LEGACY_BUNDLE_ID, "com.evil.telar", undefined]) {
      const verdict = core.validateManifest(goodManifest({ bundleId }), { channel: "nightly" });
      expect(verdict.ok).toBe(false);
      expect(verdict.error).toContain("bundleId");
    }
  });

  test("a zip name that could leave the prefix is refused", () => {
    for (const zip of ["../Telar.zip", "a/Telar.zip", ".hidden.zip", "Telar.dmg", "Telar zip.zip"]) {
      expect(core.validateManifest(goodManifest({ zip }), { channel: "nightly" }).ok).toBe(false);
    }
  });

  test("a bad sha512, size, team, version or channel is refused", () => {
    const bad = [
      { sha512: "abc" },
      { sha512: Buffer.alloc(32).toString("base64") },
      { size: 0 },
      { size: 1.5 },
      { size: 3 * 1024 ** 3 },
      { teamId: "not set" },
      { version: "latest" },
      { channel: "beta" },
    ];
    for (const over of bad) expect(core.validateManifest(goodManifest(over), { channel: "nightly" }).ok).toBe(false);
  });
});

describe("the requirement N must satisfy", () => {
  test("names N's id, a Developer ID leaf and the given team", () => {
    const req = core.designatedRequirement(core.NEW_BUNDLE_ID, TEAM);
    expect(req).toContain(`identifier "${core.NEW_BUNDLE_ID}"`);
    expect(req).toContain("anchor apple generic");
    expect(req).toContain("certificate leaf[field.1.2.840.113635.100.6.1.13]");
    expect(req).toContain(`certificate leaf[subject.OU] = "${TEAM}"`);
  });

  test("the team is read off codesign's output, and an unsigned app has none", () => {
    expect(core.parseTeam(`Identifier=com.telar.desktop\nTeamIdentifier=${TEAM}\n`)).toBe(TEAM);
    expect(core.parseTeam("Identifier=x\nTeamIdentifier=not set\n")).toBeNull();
    expect(core.parseTeam("")).toBeNull();
  });
});

describe("verifying a staged N, with codesign faked", () => {
  const helper = { helperAppName: "Computer Use for Telar", helperBundleId: "com.telar.desktop.computer-use" };
  const fakeExec = ({ id = core.NEW_BUNDLE_ID, fail = null, helperId = helper.helperBundleId, helperTeam = TEAM } = {}) => {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "plutil") return { status: 0, stdout: `${id}\n`, stderr: "" };
      if (cmd === "codesign" && args[0] === "-dv") return { status: 0, stdout: "", stderr: `Identifier=${helperId}\nTeamIdentifier=${helperTeam}\n` };
      const label = cmd === "spctl" ? "spctl" : args.includes("--test-requirement") ? "requirement" : "deep";
      return label === fail ? { status: 3, stdout: "", stderr: `${label} said no` } : { status: 0, stdout: "", stderr: "" };
    };
    return { exec, calls };
  };

  test("all checks pass, and the requirement carries the team it was given", async () => {
    const { exec, calls } = fakeExec();
    expect(await core.verifyCandidate("/s/Telar.app", { team: TEAM, ...helper, exec })).toEqual({ ok: true });
    const requirement = calls.find((call) => call.includes("--test-requirement"));
    expect(requirement.at(-2)).toBe(`=${core.designatedRequirement(core.NEW_BUNDLE_ID, TEAM)}`);
    expect(calls.some((call) => call[0] === "spctl")).toBe(true);
  });

  test("the wrong bundle id stops before any signature check", async () => {
    const { exec, calls } = fakeExec({ id: core.LEGACY_BUNDLE_ID });
    const verdict = await core.verifyCandidate("/s/Telar.app", { team: TEAM, ...helper, exec });
    expect(verdict.ok).toBe(false);
    expect(calls.length).toBe(1);
  });

  test("each failing check is named", async () => {
    for (const [fail, label] of [["deep", "signature"], ["requirement", "team requirement"], ["spctl", "Gatekeeper"]]) {
      const verdict = await core.verifyCandidate("/s/Telar.app", { team: TEAM, ...helper, exec: fakeExec({ fail }).exec });
      expect(verdict.ok).toBe(false);
      expect(verdict.error).toContain(label);
    }
  });

  test("the computer-use helper must keep its id and the team", async () => {
    const renamed = await core.verifyCandidate("/s/Telar.app", { team: TEAM, ...helper, exec: fakeExec({ helperId: "io.github.novarix.telar.computer-use" }).exec });
    expect(renamed.ok).toBe(false);
    const otherTeam = await core.verifyCandidate("/s/Telar.app", { team: TEAM, ...helper, exec: fakeExec({ helperTeam: "ABCDE12345" }).exec });
    expect(otherTeam.ok).toBe(false);
  });
});

describe("where the swap happens", () => {
  test("in place, with the incoming copy beside the target", () => {
    const plan = core.planHandoff({ execPath: "/Applications/Telar.app/Contents/MacOS/Telar", canWrite: () => true });
    expect(plan).toEqual({ ok: true, target: "/Applications/Telar.app", incoming: "/Applications/.Telar.handoff.app", execName: "Telar" });
  });

  test("a translocated app is refused", () => {
    const plan = core.planHandoff({ execPath: "/private/var/folders/x/AppTranslocation/ABC/d/Telar.app/Contents/MacOS/Telar", canWrite: () => true });
    expect(plan).toMatchObject({ ok: false, reason: "translocated" });
  });

  test("a folder the user can't write is refused and named", () => {
    const plan = core.planHandoff({ execPath: "/Applications/Telar.app/Contents/MacOS/Telar", canWrite: () => false });
    expect(plan).toMatchObject({ ok: false, reason: "not-writable", dir: "/Applications" });
  });

  test("not running from a bundle is refused", () => {
    expect(core.planHandoff({ execPath: "/usr/local/bin/electron", canWrite: () => true })).toEqual({ ok: false, reason: "not-bundle" });
  });
});

describe("the download is checked against the manifest", () => {
  const body = Buffer.from("the new app, zipped");
  const expectOf = (bytes) => ({ size: bytes.length, sha512: crypto.createHash("sha512").update(bytes).digest("base64") });
  const fetchOf = (bytes, status = 200) => async () =>
    new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes.subarray(0, 5))); c.enqueue(new Uint8Array(bytes.subarray(5))); c.close(); } }), { status });

  test("a matching body lands at dest, and the header is sent", async () => {
    const dest = path.join(tmp("telar-dl-"), "n.zip");
    let seen = null;
    const fetchImpl = async (url, init) => {
      seen = init.headers;
      return fetchOf(body)();
    };
    await core.download({ url: "u", headers: { "X-Telar-Update-Key": "k" }, dest, expect: expectOf(body), fetchImpl });
    expect(fs.readFileSync(dest)).toEqual(body);
    expect(seen).toEqual({ "X-Telar-Update-Key": "k" });
    expect(core.zipMatches(dest, expectOf(body))).toBe(true);
  });

  test("a wrong hash, a wrong size or an error status leaves nothing behind", async () => {
    const cases = [
      [fetchOf(body), { ...expectOf(body), sha512: SHA }, "sha512"],
      [fetchOf(body), { ...expectOf(body), size: body.length + 1 }, "bytes"],
      [fetchOf(body), { ...expectOf(body), size: 3 }, "larger"],
      [fetchOf(body, 403), expectOf(body), "403"],
    ];
    for (const [fetchImpl, expected, message] of cases) {
      const dir = tmp("telar-dl-");
      const dest = path.join(dir, "n.zip");
      await expect(core.download({ url: "u", headers: {}, dest, expect: expected, fetchImpl })).rejects.toThrow(message);
      expect(fs.readdirSync(dir)).toEqual([]);
    }
  });
});

describe("what H does with a manifest after a failed swap", () => {
  test("nothing failed: offer", () => {
    expect(core.offerDecision(tmp("telar-ho-"), goodManifest())).toEqual({ action: "offer" });
  });

  test("the version that failed is reported once, then not offered again", () => {
    const dir = tmp("telar-ho-");
    core.writeJson(core.paths(dir).failed, { version: goodManifest().version, reason: "did-not-confirm" });
    expect(core.offerDecision(dir, goodManifest())).toMatchObject({ action: "notify-failed", failed: { reason: "did-not-confirm" } });
    expect(core.offerDecision(dir, goodManifest())).toEqual({ action: "blocked" });
  });

  test("a newer manifest clears the block", () => {
    const dir = tmp("telar-ho-");
    core.writeJson(core.paths(dir).failed, { version: "0.2.0-nightly.20261001.1", noticeShown: true });
    expect(core.offerDecision(dir, goodManifest({ version: "0.2.0-nightly.20261002.1" }))).toEqual({ action: "offer" });
    expect(fs.existsSync(core.paths(dir).failed)).toBe(false);
  });
});

describe("N's boot record", () => {
  const DAY = 24 * 60 * 60 * 1000;

  test("the first N boot after a swap confirms it and clears pending", () => {
    const dir = tmp("telar-ho-");
    core.writeJson(core.paths(dir).pending, { version: "2.0.0", bundleId: core.NEW_BUNDLE_ID });
    expect(core.confirmBoot(dir, { bundleId: core.NEW_BUNDLE_ID, version: "2.0.0", now: 0 })).toEqual({ action: "confirmed" });
    expect(core.readJson(core.paths(dir).confirmed)).toEqual({ version: "2.0.0", bundleId: core.NEW_BUNDLE_ID, confirmedAt: 0 });
    expect(fs.existsSync(core.paths(dir).pending)).toBe(false);
  });

  test("the old app booting with a pending swap confirms nothing", () => {
    const dir = tmp("telar-ho-");
    core.writeJson(core.paths(dir).pending, { version: "2.0.0", bundleId: core.NEW_BUNDLE_ID });
    expect(core.confirmBoot(dir, { bundleId: core.LEGACY_BUNDLE_ID, version: "1.0.0", now: 0 })).toEqual({ action: "none" });
    expect(fs.existsSync(core.paths(dir).confirmed)).toBe(false);
  });

  test("a confirmed swap is cleaned up on every launch until it has been, then never again", () => {
    const dir = tmp("telar-ho-");
    // A record from before this rule, still counting launches toward the old week.
    core.writeJson(core.paths(dir).confirmed, { version: "2.0.0", bundleId: core.NEW_BUNDLE_ID, confirmedAt: 0, launches: 3 });
    const boot = () => core.confirmBoot(dir, { bundleId: core.NEW_BUNDLE_ID, version: "2.0.0", now: DAY }).action;
    expect(boot()).toBe("clean-up");
    expect(boot()).toBe("clean-up");
    core.markCleanedUp(dir);
    expect(boot()).toBe("none");
  });

  test("the old app never cleans up after a swap it rolled back to", () => {
    const dir = tmp("telar-ho-");
    core.writeJson(core.paths(dir).confirmed, { version: "2.0.0", bundleId: core.NEW_BUNDLE_ID, confirmedAt: 0 });
    expect(core.confirmBoot(dir, { bundleId: core.LEGACY_BUNDLE_ID, version: "1.0.0" })).toEqual({ action: "none" });
  });

  test("nothing on disk is nothing to do", () => {
    expect(core.confirmBoot(tmp("telar-ho-"), { bundleId: core.NEW_BUNDLE_ID, version: "2.0.0" })).toEqual({ action: "none" });
  });
});

describe("what the cleanup removes", () => {
  const work = "/Users/x/Library/Application Support/Telar/handoff";
  const home = "/Users/x";

  test("only the rollback copy, the stub, staging and exact old-id names in ~/Library", () => {
    expect(core.legacyLeftovers(work, home)).toEqual([
      `${work}/last-good.app`,
      `${work}/legacy-id.app`,
      `${work}/staged`,
      `${home}/Library/Caches/com.telar.desktop.ShipIt`,
      `${home}/Library/Saved Application State/com.telar.desktop.savedState`,
      `${home}/Library/HTTPStorages/com.telar.desktop`,
      `${home}/Library/Preferences/com.telar.desktop.plist`,
    ]);
  });

  test("never userData, the hand-off folder, the new id or the computer-use helper", () => {
    const userData = path.dirname(work);
    for (const target of core.legacyLeftovers(work, home)) {
      expect(target).not.toBe(userData);
      expect(target).not.toBe(work);
      expect(target.startsWith(`${work}/`) || target.startsWith(`${home}/Library/`)).toBe(true);
      expect(target).not.toContain("computer-use");
      expect(target).not.toContain(core.NEW_BUNDLE_ID);
      // Anything outside the hand-off folder names the old id exactly.
      if (!target.startsWith(`${work}/`)) expect(path.basename(target).replace(/\.(ShipIt|savedState|plist)$/, "")).toBe(core.LEGACY_BUNDLE_ID);
    }
  });

  test("the permission reset names the old id alone", () => {
    expect(core.TCC_RESET_ARGS).toEqual(["reset", "All", core.LEGACY_BUNDLE_ID]);
  });

  test("the stub carries the old id and an executable that does nothing", () => {
    const dir = tmp("telar-ho-");
    const stub = core.writeLegacyStub(dir);
    expect(stub).toBe(core.paths(dir).legacyStub);
    const plist = fs.readFileSync(path.join(stub, "Contents", "Info.plist"), "utf8");
    expect(plist).toContain(`<string>${core.LEGACY_BUNDLE_ID}</string>`);
    expect(plist).toContain("<key>CFBundleExecutable</key><string>stub</string>");
    expect(fs.readFileSync(path.join(stub, "Contents", "MacOS", "stub"), "utf8")).toBe("#!/bin/sh\n");
  });

  test("the swap helper is found by its script path, whatever else is running", () => {
    const script = `${work}/handoff.sh`;
    const ps = `/sbin/launchd\nbash ${script} 123 ${work}/../.Telar.handoff.app /Applications/Telar.app\n/usr/bin/tail -f x`;
    expect(core.helperRunning(ps, script)).toBe(true);
    expect(core.helperRunning("/sbin/launchd\nbash /tmp/other.sh", script)).toBe(false);
    expect(core.helperRunning("", script)).toBe(false);
  });
});

// GENUINELY macOS-ONLY: `ditto`, `codesign`, and `ps` naming an executable by
// its full path. verify.yml's macOS job proves both blocks ran there.
const darwin = process.platform === "darwin";

/** A bundle whose executable is a real, runnable copy of /bin/sleep. */
function fakeApp(dir, marker) {
  const app = path.join(dir, "Telar.app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.copyFileSync("/bin/sleep", path.join(app, "Contents", "MacOS", "Telar"));
  // A copied platform binary is killed on launch until it is re-signed.
  spawnSync("codesign", ["-s", "-", "-f", path.join(app, "Contents", "MacOS", "Telar")]);
  fs.writeFileSync(path.join(app, "Contents", "MARKER"), marker);
  return app;
}

describe.skipIf(!darwin)("the hand-off swap helper, run for real against fake bundles", () => {
  const runHelper = ({ parentPid, incoming, target, launcherBody, confirmSeconds = 2, parentSeconds = 5 }) => {
    const work = tmp("telar-handoff-work-");
    const log = path.join(work, "handoff.log");
    const record = path.join(work, "launched.txt");
    const launcher = path.join(work, "launcher.sh");
    fs.writeFileSync(launcher, `#!/bin/bash\necho "$1" >> "${record}"\n${launcherBody ?? ""}\n`, { mode: 0o755 });
    const script = path.join(work, "handoff.sh");
    fs.writeFileSync(script, core.helperScript(), { mode: 0o755 });
    core.writeJson(core.paths(work).pending, { version: "2.0.0", bundleId: core.NEW_BUNDLE_ID });
    const args = [script, String(parentPid), incoming, target, work, log, launcher, "2.0.0", String(confirmSeconds), "Telar", "2", String(parentSeconds)];
    const result = spawnSync("bash", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    const launched = () => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n") : []);
    return { result, work, log, launched };
  };
  // A pid that has already been reaped, so the "quitting app" is already gone.
  const gonePid = () => spawnSync("true").pid;

  const installed = () => fakeApp(tmp("telar-installed-"), "old");
  const incomingBeside = (target) => {
    const staged = fakeApp(tmp("telar-staged-"), "new");
    const incoming = path.join(path.dirname(target), ".Telar.handoff.app");
    fs.renameSync(staged, incoming);
    return incoming;
  };
  const marker = (app) => fs.readFileSync(path.join(app, "Contents", "MARKER"), "utf8");

  test("success: N installed at the same path, H kept as last-good, N confirms", () => {
    const target = installed();
    const incoming = incomingBeside(target);
    const { result, work, launched } = runHelper({
      parentPid: gonePid(),
      incoming,
      target,
      launcherBody: `echo '{}' > "$(dirname "$0")/confirmed.json"`,
    });
    expect(result.status).toBe(0);
    expect(marker(target)).toBe("new");
    expect(marker(path.join(work, "last-good.app"))).toBe("old");
    expect(fs.existsSync(incoming)).toBe(false);
    expect(fs.existsSync(path.join(work, "failed.json"))).toBe(false);
    expect(launched()).toEqual([target]);
  });

  test("install failure: last-good is restored and relaunched", () => {
    const target = installed();
    const { result, work, launched } = runHelper({ parentPid: gonePid(), incoming: path.join(path.dirname(target), ".missing.app"), target });
    expect(result.status).toBe(1);
    expect(marker(target)).toBe("old");
    expect(core.readJson(path.join(work, "failed.json"))).toEqual({ version: "2.0.0", reason: "install-failed" });
    expect(fs.existsSync(path.join(work, "pending.json"))).toBe(false);
    expect(launched()).toEqual([target]);
  });

  test("the old app never quitting abandons the swap without touching it", () => {
    const target = installed();
    const incoming = incomingBeside(target);
    // This test process is alive for the whole run, so it stands in for an H
    // that never quits.
    const { result, work, launched } = runHelper({ parentPid: process.pid, incoming, target, parentSeconds: 1 });
    expect(result.status).toBe(1);
    expect(marker(target)).toBe("old");
    expect(fs.existsSync(incoming)).toBe(false);
    expect(core.readJson(path.join(work, "failed.json")).reason).toBe("old-app-did-not-quit");
    expect(launched()).toEqual([]);
  });

  test("no confirmation: N is stopped by its own pid, H is restored and relaunched", async () => {
    const target = installed();
    const incoming = incomingBeside(target);
    // A decoy with the same executable name at another path must survive.
    const decoyApp = fakeApp(tmp("telar-decoy-"), "decoy");
    const decoy = spawn(path.join(decoyApp, "Contents", "MacOS", "Telar"), ["60"], { stdio: "ignore" });
    const pidFile = path.join(tmp("telar-npid-"), "pid");
    try {
      // The launcher starts "N" and returns, as `open` does.
      const { result, work, launched } = runHelper({
        parentPid: gonePid(),
        incoming,
        target,
        launcherBody: `if [ ! -f "${pidFile}" ]; then "$1/Contents/MacOS/Telar" 60 >/dev/null 2>&1 & echo $! > "${pidFile}"; fi`,
      });
      expect(result.status).toBe(2);
      expect(marker(target)).toBe("old");
      expect(marker(path.join(work, "failed.app"))).toBe("new");
      expect(core.readJson(path.join(work, "failed.json"))).toEqual({ version: "2.0.0", reason: "did-not-confirm" });
      expect(fs.existsSync(path.join(work, "pending.json"))).toBe(false);
      expect(launched()).toEqual([target, target]);
      const n = Number(fs.readFileSync(pidFile, "utf8"));
      expect(() => process.kill(n, 0)).toThrow();
      expect(fs.readFileSync(path.join(work, "handoff.log"), "utf8")).toContain(`SIGTERM ${n}`);
      expect(decoy.exitCode).toBeNull();
      expect(() => process.kill(decoy.pid, 0)).not.toThrow();
    } finally {
      decoy.kill("SIGKILL");
    }
  });
});

describe.skipIf(!darwin)("the signature gate, run for real against ad-hoc signed bundles", () => {
  const signed = (id) => {
    const app = path.join(tmp("telar-sig-"), "Telar.app");
    fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    fs.copyFileSync("/bin/sleep", path.join(app, "Contents", "MacOS", "Telar"));
    fs.writeFileSync(
      path.join(app, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>Telar</string></dict></plist>\n`,
    );
    const sign = spawnSync("codesign", ["-s", "-", "-f", "-i", id, app], { encoding: "utf8" });
    if (sign.status !== 0) throw new Error(sign.stderr);
    return app;
  };
  const helper = { helperAppName: "Computer Use for Telar", helperBundleId: "com.telar.desktop.computer-use" };

  test("an app with the old id is refused", async () => {
    const verdict = await core.verifyCandidate(signed(core.LEGACY_BUNDLE_ID), { team: TEAM, ...helper });
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain(core.LEGACY_BUNDLE_ID);
  });

  test("N's id with an ad-hoc signature passes codesign but fails the team requirement", async () => {
    const app = signed(core.NEW_BUNDLE_ID);
    expect(spawnSync("codesign", ["--verify", "--deep", "--strict", app]).status).toBe(0);
    const verdict = await core.verifyCandidate(app, { team: TEAM, ...helper });
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("team requirement");
  });
});
