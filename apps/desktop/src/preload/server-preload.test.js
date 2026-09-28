/**
 * THE COCKPIT'S OWN PROCESSES ARE NOT NAMED `next-server` (#835).
 *
 * Next sets `process.title = "next-server (vX)"` inside `startServer`, after
 * any `--require` preload has run. That put Telar's UI server in `ps` under
 * the same name as every dev server on the machine, and an agent's routine
 * `pkill -f next-server` closed the app. These run the preload in a real Node
 * child and let the child do exactly what Next does; the assertion is on what
 * the child reads back and, on macOS, on what `ps` reports — which is what
 * `pkill -f` matches.
 */
const { describe, expect, test } = require("bun:test");
const { spawnSync, spawn } = require("node:child_process");
const path = require("node:path");

const PRELOAD = path.join(__dirname, "server-preload.js");
/** What Next's own `startServer` does, verbatim in shape. */
const NEXT_ASSIGNMENT = 'process.title = "next-server (v16.3.0)"; console.log(process.title);';
/**
 * `node`, NOT `process.execPath`. This suite runs under bun, and bun does not
 * rewrite the argv region on `process.title` — so a child spawned with the
 * runner's own binary reads the guarded name back in JS while `ps` still shows
 * the command line. The processes main.js forks run under Node (Electron as
 * node), which does rewrite it; that is the behaviour under test.
 */
const NODE = "node";

function child(env, script = NEXT_ASSIGNMENT) {
  const result = spawnSync(NODE, ["--require", PRELOAD, "-e", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 10_000,
  });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

describe("server-preload keeps the process title main.js gave it", () => {
  test("Next's later assignment is ignored, and the child reads the guarded name back", () => {
    expect(child({ TELAR_PROCESS_TITLE: "telar-ui" })).toBe("telar-ui");
  });

  test("the name is whatever main.js said — the engine child is not called telar-ui", () => {
    // The same preload loads into the engine daemon; a default here would
    // rename that too and hand two processes one name.
    expect(child({ TELAR_PROCESS_TITLE: "telar-engine-dev" })).toBe("telar-engine-dev");
  });

  test("with no title from the parent the preload changes nothing", () => {
    const env = { ...process.env };
    delete env.TELAR_PROCESS_TITLE;
    const result = spawnSync(NODE, ["--require", PRELOAD, "-e", NEXT_ASSIGNMENT], { encoding: "utf8", env, timeout: 10_000 });
    expect(result.stdout.trim()).toBe("next-server (v16.3.0)");
  });

  test("an empty title is no title", () => {
    expect(child({ TELAR_PROCESS_TITLE: "  " })).toBe("next-server (v16.3.0)");
  });

  test.skipIf(process.platform !== "darwin")("what `ps` reports — which is what `pkill -f` matches — is the guarded name", async () => {
    // The whole point of the issue: the property being right inside JS is not
    // enough if the argv region the kernel shows still says next-server.
    const proc = spawn(NODE, ["--require", PRELOAD, "-e", `${NEXT_ASSIGNMENT} setTimeout(() => {}, 5000);`], {
      env: { ...process.env, TELAR_PROCESS_TITLE: "telar-ui" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      await new Promise((resolve) => proc.stdout.once("data", resolve));
      const ps = spawnSync("ps", ["-o", "command=", "-p", String(proc.pid)], { encoding: "utf8" }).stdout;
      expect(ps).toContain("telar-ui");
      expect(ps).not.toContain("next-server");
    } finally {
      proc.kill("SIGKILL");
    }
  });
});
