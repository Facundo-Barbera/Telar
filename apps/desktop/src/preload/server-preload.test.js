const { describe, expect, test } = require("bun:test");
const { spawnSync, spawn } = require("node:child_process");
const path = require("node:path");

const PRELOAD = path.join(__dirname, "server-preload.js");

const NEXT_ASSIGNMENT = 'process.title = "next-server (v16.3.0)"; console.log(process.title);';

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
