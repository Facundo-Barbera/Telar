import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runStructured } from "./textgen-run";

const roots: string[] = [];
let previous: string | undefined;
beforeAll(() => {
  previous = process.env.TELAR_ALLOW_CLI;
  process.env.TELAR_ALLOW_CLI = "1";
});
afterAll(() => {
  if (previous === undefined) delete process.env.TELAR_ALLOW_CLI;
  else process.env.TELAR_ALLOW_CLI = previous;
});
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("a CLI that floods stdout is killed past 4 MB and logged, not buffered", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "telar-tg-flood-"));
  roots.push(bin);
  const binaryPath = path.join(bin, "claude");
  fs.writeFileSync(binaryPath, `#!/bin/sh\n[ "$1" = "--version" ] && echo "2.1.270 (fake)" && exit 0\ncat > /dev/null\nwhile :; do head -c 1048576 /dev/zero | tr '\\0' x; done\n`);
  fs.chmodSync(binaryPath, 0o755);
  const logged: string[] = [];
  const original = console.error;
  console.error = (line: string) => logged.push(line);
  try {
    expect(await runStructured({ driver: "claude", binaryPath }, "title this", {})).toBeUndefined();
  } finally {
    console.error = original;
  }
  expect(logged).toEqual(["[engine] claude text generation failed: output passed 4 MB"]);
});
