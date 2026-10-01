import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OWN_GROUP } from "../../platform/process/group";
import { CodexAppServer } from "./app-server";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// A silent app-server whose grandchild holds a FIFO open: the FIFO ends only when the grandchild is gone.
async function silentServerWithGrandchild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-codex-group-"));
  dirs.push(dir);
  const fifo = path.join(dir, "grandchild");
  spawnSync("mkfifo", [fifo], { timeout: 5_000, killSignal: "SIGKILL" });
  const bin = path.join(dir, "codex");
  fs.writeFileSync(bin, `#!/bin/sh\nsleep 60 > "$FIFO" &\nwait\n`, { mode: 0o755 });
  const grandchild = fs.createReadStream(fifo).resume();
  const opened = once(grandchild, "open");
  const gone = once(grandchild, "end");
  const server = new CodexAppServer(bin, { PATH: process.env.PATH, FIFO: fifo });
  await opened;
  return { server, gone };
}

test.skipIf(!OWN_GROUP)("kill reaps what the app-server spawned, not only the app-server", async () => {
  const { server, gone } = await silentServerWithGrandchild();
  server.kill();
  await gone;
});

test.skipIf(!OWN_GROUP)("a request the app-server never answers fails after its timeout", async () => {
  const { server, gone } = await silentServerWithGrandchild();
  await expect(server.request("initialize", {}, 20)).rejects.toThrow(/did not answer initialize within 20ms/);
  server.kill();
  await gone;
});
