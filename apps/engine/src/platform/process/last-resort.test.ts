import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

const MODULE = path.join(import.meta.dir, "last-resort.ts");

async function run(body: string) {
  const script = `import { installLastResortHandlers } from ${JSON.stringify(MODULE)};\ninstallLastResortHandlers();\n${body}`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

test("a rejection nobody handled is logged and the engine keeps running", async () => {
  const { code, stdout, stderr } = await run(
    `void Promise.reject(new Error("nobody awaited me"));\nsetTimeout(() => { console.log("still serving"); process.exit(0); }, 20);`,
  );
  expect(code).toBe(0);
  expect(stdout).toContain("still serving");
  expect(stderr).toContain("kept running past an unhandled rejection: Error: nobody awaited me");
});

test("a throw in a timer exits 1 with the reason the desktop reports", async () => {
  const { code, stderr } = await run(`setTimeout(() => { throw new TypeError("x is not a function"); }, 0);`);
  expect(code).toBe(1);
  expect(stderr).toContain("Telar engine stopped: uncaught TypeError: x is not a function\n");
});
