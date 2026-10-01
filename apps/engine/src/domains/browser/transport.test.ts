import { afterEach, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OWN_GROUP } from "../../platform/process/group";
import { PlaywrightMcpTransport } from "./transport";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Stands in for playwright-mcp: answers every request and leaves a "browser" holding a FIFO open.
function fakeCliWithBrowser() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-browser-group-"));
  dirs.push(dir);
  const fifo = path.join(dir, "browser");
  spawnSync("mkfifo", [fifo], { timeout: 5_000, killSignal: "SIGKILL" });
  const cliPath = path.join(dir, "cli.js");
  fs.writeFileSync(cliPath, `
const { spawn } = require("node:child_process");
spawn("sh", ["-c", ${JSON.stringify(`exec sleep 60 > '${fifo}'`)}], { stdio: "ignore" });
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    const message = JSON.parse(line);
    if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
  }
});
`);
  const browser = fs.createReadStream(fifo).resume();
  return { cliPath, opened: once(browser, "open"), gone: once(browser, "end") };
}

for (const [name, stop] of [
  ["killNow", (transport: PlaywrightMcpTransport) => transport.killNow()],
  ["close", (transport: PlaywrightMcpTransport) => void transport.close()],
] as const) {
  test.skipIf(!OWN_GROUP)(`${name} takes down the browser the CLI launched, not only the CLI`, async () => {
    const { cliPath, opened, gone } = fakeCliWithBrowser();
    const transport = new PlaywrightMcpTransport({ cliPath, killGraceMs: 50 });
    await transport.start();
    await opened;
    stop(transport);
    await gone;
  });
}
