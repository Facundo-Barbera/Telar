// THE DEV SELF-UPDATE'S DECISIONS, PINNED (DEV-005). Everything here runs
// without Electron: dev-update-core.js is the testable half by design. The
// swap helper is exercised as the real bash script against throwaway fake
// bundles, with the launcher stubbed so nothing actually opens.

const { describe, expect, test } = require("bun:test");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("./dev-update-core");

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

describe("the build child's environment is scrubbed of the running app's redirections", () => {
  test("ELECTRON_*/TELAR_*/NODE_OPTIONS go; the toolchain's variables stay", () => {
    const cleaned = core.cleanBuildEnv({
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      NODE_OPTIONS: "--max-old-space-size=1",
      TELAR_HOME: "/somewhere/live",
      TELAR_DESKTOP_URL: "http://127.0.0.1:3000",
      TELAR_DESKTOP_BROWSER_CONTROL_TOKEN: "secret",
      TELAR_HOST_TOKEN: "tlr_secret",
      PATH: "/usr/bin",
      HOME: "/Users/someone",
      TMPDIR: "/tmp",
    });
    expect(Object.keys(cleaned).sort()).toEqual(["HOME", "PATH", "TMPDIR"]);
  });
});

describe("finding bun from a GUI app's bare environment", () => {
  test("PATH wins, the known install dirs are the fallback, absence is null", () => {
    const exists = (candidate) => candidate === "/custom/bin/bun";
    expect(core.resolveBunDir({ PATH: "/custom/bin:/usr/bin", HOME: "/h" }, exists)).toBe("/custom/bin");
    const bunHome = (candidate) => candidate === "/h/.bun/bin/bun";
    expect(core.resolveBunDir({ PATH: "/usr/bin", HOME: "/h" }, bunHome)).toBe("/h/.bun/bin");
    expect(core.resolveBunDir({ PATH: "/usr/bin", HOME: "/h" }, () => false)).toBeNull();
  });
});

describe("what the update window promises to build", () => {
  const runner = (responses) => (_repo, args) => responses[args.join(" ")] ?? { status: 1, stdout: "", stderr: "boom" };

  test("branch, sha and dirtiness come from the checkout's own answers", () => {
    const info = core.readSourceInfo("/repo", runner({
      "rev-parse --short HEAD": { status: 0, stdout: "abc1234\n", stderr: "" },
      "rev-parse --abbrev-ref HEAD": { status: 0, stdout: "dev/local-dogfood\n", stderr: "" },
      "status --porcelain --untracked-files=normal": { status: 0, stdout: " M main.js\n", stderr: "" },
    }));
    expect(info).toEqual({ ok: true, repo: "/repo", sha: "abc1234", branch: "dev/local-dogfood", dirty: true });
  });

  test("a directory that is not a checkout is an error, not a guess", () => {
    const info = core.readSourceInfo("/repo", runner({}));
    expect(info.ok).toBe(false);
    expect(info.error).toContain("/repo");
  });
});

describe("which checkout an update builds from", () => {
  test("the baked repo is used when it looks like a Telar checkout", () => {
    const repo = tmp("telar-repo-");
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(repo, "scripts", "package-desktop.sh"), "");
    const config = core.configuredRepo({ packagedRepo: repo, devHome: tmp("telar-home-") });
    expect(config).toMatchObject({ ok: true, repo });
  });

  test("a dev-update.json in the Dev home overrides the baked path", () => {
    const baked = tmp("telar-baked-");
    const override = tmp("telar-override-");
    fs.mkdirSync(path.join(override, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(override, "scripts", "package-desktop.sh"), "");
    const home = tmp("telar-home-");
    fs.writeFileSync(path.join(home, "dev-update.json"), JSON.stringify({ repo: override }));
    expect(core.configuredRepo({ packagedRepo: baked, devHome: home })).toMatchObject({ ok: true, repo: override });
  });

  test("no repo, or a directory without the packaging script, is refused", () => {
    expect(core.configuredRepo({ packagedRepo: null, devHome: tmp("telar-home-") }).ok).toBe(false);
    const notRepo = tmp("telar-notrepo-");
    const config = core.configuredRepo({ packagedRepo: notRepo, devHome: tmp("telar-home-") });
    expect(config.ok).toBe(false);
    expect(config.error).toContain("package-desktop.sh");
  });
});

describe("swap planning refuses anything that could overwrite the running app", () => {
  const staged = "/repo/apps/desktop/release/dev/mac-arm64/Telar Dev.app";

  test("an installed copy elsewhere is swappable", () => {
    const plan = core.planSwap({ execPath: "/Applications/Telar Dev.app/Contents/MacOS/Telar Dev", stagedApp: staged });
    expect(plan).toEqual({ ok: true, target: "/Applications/Telar Dev.app", stagedApp: staged });
  });

  test("running straight out of the staging area is refused — the rebuild would overwrite it", () => {
    const plan = core.planSwap({ execPath: `${staged}/Contents/MacOS/Telar Dev`, stagedApp: staged });
    expect(plan.ok).toBe(false);
    expect(plan.error).toContain("staging");
  });

  test("not running from a bundle at all (checkout run) is refused", () => {
    expect(core.planSwap({ execPath: "/usr/local/bin/electron", stagedApp: staged }).ok).toBe(false);
  });

  test("bundle paths parse from the executable path alone", () => {
    expect(core.runningBundlePath("/Applications/Telar Dev.app/Contents/MacOS/Telar Dev")).toBe("/Applications/Telar Dev.app");
    expect(core.runningBundlePath("/usr/bin/true")).toBeNull();
  });
});

// A staged bundle with exactly the pieces validateCandidate looks for.
function fakeCandidate({ helper = true, channel = "dev" } = {}) {
  const app = path.join(tmp("telar-candidate-"), "Telar Dev.app");
  const write = (parts, content) => {
    const file = path.join(app, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write(["Contents", "MacOS", "Telar Dev"], "#!/bin/bash\ntrue\n");
  if (helper) write(["Contents", "Frameworks", "Telar Dev Helper.app", "Contents", "MacOS", "Telar Dev Helper"], "");
  write(["Contents", "Info.plist"], `...${core.DEV_BUNDLE_ID}...`);
  write(["Contents", "Resources", "standalone", "build-info.json"], JSON.stringify({ shortSha: "abc1234", channel, dirty: true }));
  return app;
}

describe("a candidate is re-checked off disk before anything is swapped", () => {
  test("the full shape passes and surfaces its stamp", () => {
    const verdict = core.validateCandidate(fakeCandidate());
    expect(verdict.ok).toBe(true);
    expect(verdict.info.shortSha).toBe("abc1234");
  });

  test("a missing helper fails — that is the duplicate-Dock regression", () => {
    const verdict = core.validateCandidate(fakeCandidate({ helper: false }));
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("Helper");
  });

  test("a non-dev stamp fails — a dev updater must never install anything else", () => {
    expect(core.validateCandidate(fakeCandidate({ channel: "local" })).ok).toBe(false);
  });
});

// GENUINELY macOS-ONLY, and the only such block in this suite (issue #752).
//
// `core.helperScript()` is a real bash script that calls `ditto`, which does
// not exist on Linux — so this runs the swap for real on a Mac and is skipped
// elsewhere. Everything else in this file is platform-independent and keeps
// running everywhere.
//
// IT MUST STILL RUN SOMEWHERE. `Verify`'s macOS leg exists for this block; if
// that leg is ever dropped, this stops executing at all rather than failing,
// which is the quiet kind of coverage loss. Do not skip it without checking
// what is left running it.
describe.skipIf(process.platform !== "darwin")("the swap helper, run for real against fake bundles", () => {
  // The launcher is a recording stub; "open" never runs in tests.
  const runSwap = ({ staged, target }) => {
    const work = tmp("telar-swapwork-");
    const log = path.join(work, "update.log");
    const launcher = path.join(work, "launcher.sh");
    const record = path.join(work, "launched.txt");
    fs.writeFileSync(launcher, `#!/bin/bash\necho "$1" >> "${record}"\n`, { mode: 0o755 });
    const script = path.join(work, "swap.sh");
    fs.writeFileSync(script, core.helperScript(), { mode: 0o755 });
    // The "quitting app" is a pid that has ALREADY been reaped: spawnSync
    // blocks bun's event loop, so a live child would linger as a zombie and
    // `kill -0` in the helper would wait on it forever.
    const parent = spawnSync("true");
    const result = spawnSync("bash", [script, String(parent.pid), staged, target, work, log, launcher], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return { result, work, log, launched: () => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n") : []) };
  };

  test("success: candidate installed, previous build kept as last-good, app relaunched", () => {
    const staged = fakeCandidate();
    const targetDir = tmp("telar-installed-");
    const target = path.join(targetDir, "Telar Dev.app");
    fs.mkdirSync(path.join(target, "Contents"), { recursive: true });
    fs.writeFileSync(path.join(target, "Contents", "OLD_MARKER"), "previous build");

    const { result, work, launched } = runSwap({ staged, target });
    expect(result.status).toBe(0);
    // The new build is at the target; the old one is intact as last-good.
    expect(fs.existsSync(path.join(target, "Contents", "MacOS", "Telar Dev"))).toBe(true);
    expect(fs.existsSync(path.join(target, "Contents", "OLD_MARKER"))).toBe(false);
    expect(fs.readFileSync(path.join(work, "last-good.app", "Contents", "OLD_MARKER"), "utf8")).toBe("previous build");
    expect(launched()).toEqual([target]);
  });

  test("copy failure: the running build is untouched and gets relaunched", () => {
    const targetDir = tmp("telar-installed-");
    const target = path.join(targetDir, "Telar Dev.app");
    fs.mkdirSync(path.join(target, "Contents"), { recursive: true });
    fs.writeFileSync(path.join(target, "Contents", "OLD_MARKER"), "previous build");

    const { result, work, launched } = runSwap({ staged: "/no/such/candidate.app", target });
    expect(result.status).toBe(1);
    expect(fs.readFileSync(path.join(target, "Contents", "OLD_MARKER"), "utf8")).toBe("previous build");
    expect(fs.existsSync(path.join(work, "last-good.app"))).toBe(false);
    expect(launched()).toEqual([target]);
  });
});
