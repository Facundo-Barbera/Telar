import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENGINE_EXIT_LOCK_HELD } from "./platform/process/daemon-lock";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

test("a store another engine holds makes the entry point exit with the lock code, naming the lock", async () => {
  const home = tempDir("telar-main-home-");
  const lock = path.join(home, "engine", "engine.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, token: "held", hostname: "another-mac", startedAt: 0 }));

  const child = Bun.spawn(["bun", path.join(import.meta.dir, "main.ts")], {
    env: { ...process.env, TELAR_HOME: home, HOME: tempDir("telar-main-user-"), TELAR_EMBEDDED_WORKER: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 20_000);
  const code = await child.exited;
  clearTimeout(timer);

  expect(code).toBe(ENGINE_EXIT_LOCK_HELD);
  expect(await new Response(child.stderr).text()).toContain(fs.realpathSync(lock));
}, 30_000);
