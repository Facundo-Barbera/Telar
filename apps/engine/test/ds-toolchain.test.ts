import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Exec } from "../src/ds/python-env";
import { adoptBinaryDir, compareVersions, findBinary, listPythons, scanPathPythons, toolchainStatus } from "../src/ds/toolchain";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-toolchain-"));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function bin(dir: string, name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return file;
}

const UV_LIST = JSON.stringify([
  { key: "cpython-3.15.0rc1-macos-aarch64-none", version: "3.15.0rc1", path: null, variant: "default", implementation: "cpython" },
  { key: "cpython-3.14.7-macos-aarch64-none", version: "3.14.7", path: "/opt/homebrew/bin/python3.14", variant: "default", implementation: "cpython" },
  { key: "cpython-3.14.7-macos-aarch64-none", version: "3.14.7", path: "/opt/homebrew/bin/python3", variant: "default", implementation: "cpython" },
  { key: "cpython-3.14.7-macos-aarch64-none", version: "3.14.7", path: null, variant: "default", implementation: "cpython" },
  { key: "cpython-3.14.7+freethreaded", version: "3.14.7", path: null, variant: "freethreaded", implementation: "cpython" },
  { key: "cpython-3.13.15-macos-aarch64-none", version: "3.13.15", path: null, variant: "default", implementation: "cpython" },
  { key: "cpython-3.12.13-macos-aarch64-none", version: "3.12.13", path: null, variant: "default", implementation: "cpython" },
  { key: "cpython-3.12.13-macos-aarch64-none", version: "3.12.13", path: "/Users/x/.local/share/uv/python/cpython-3.12/bin/python3.12", variant: "default", implementation: "cpython" },
  { key: "pypy-3.10", version: "3.10.14", path: null, variant: "default", implementation: "pypy" },
]);

const exec = (answers: Record<string, string>): Exec => async (file, args) => {
  const key = `${path.basename(file)} ${args.join(" ")}`;
  const hit = Object.entries(answers).find(([pattern]) => key.startsWith(pattern));
  return hit ? { status: 0, stdout: hit[1], stderr: "" } : { status: 127, stdout: "", stderr: "not scripted" };
};

test("uv's python list collapses to one row per version, installed winning over downloadable, newest first", async () => {
  const pythons = await listPythons("/opt/homebrew/bin/uv", exec({ "uv python list": UV_LIST }));
  expect(pythons.map((p) => [p.version, p.installed, p.prerelease])).toEqual([
    ["3.15.0rc1", false, true],
    ["3.14.7", true, false],
    ["3.13.15", false, false],
    ["3.12.13", true, false],
  ]);
  expect(pythons[1]!.path).toBe("/opt/homebrew/bin/python3.14");
  expect(pythons[1]!.minor).toBe("3.14");
});

test("findBinary looks on PATH first, then in the known install directories", () => {
  const dir = root();
  const uv = bin(dir, "uv");
  expect(findBinary("uv", { PATH: dir })).toBe(uv);
  // Off PATH, the fallbacks are consulted: found or not depending on the machine, never a throw.
  const fallback = findBinary("uv", { PATH: root() });
  expect(fallback === undefined || fallback.endsWith("/uv")).toBe(true);
  expect(findBinary("definitely-not-a-tool", { PATH: dir })).toBeUndefined();
});

test("toolchainStatus reports what it found and falls back to a PATH scan without uv", async () => {
  const dir = root();
  bin(dir, "python3.12");
  bin(dir, "python3.11");
  bin(dir, "python3");
  const withoutUv = await toolchainStatus(exec({}), { PATH: dir });
  expect(withoutUv.uv).toBeUndefined();
  expect(withoutUv.pythons.map((p) => p.version)).toEqual(["3.12", "3.11"]);
  expect(scanPathPythons({ PATH: dir }).every((p) => p.installed)).toBe(true);

  bin(dir, "uv");
  bin(dir, "conda");
  bin(dir, "brew");
  const full = await toolchainStatus(exec({ "uv --version": "uv 0.12.5 (Homebrew 2026-08-14)\n", "conda --version": "conda 24.11.0\n", "brew --version": "Homebrew 4.4.0\n", "uv python list": UV_LIST }), { PATH: dir });
  expect(full.uv?.version).toBe("0.12.5");
  expect(full.conda).toEqual({ path: path.join(dir, "conda"), version: "24.11.0", flavour: "conda" });
  expect(full.brew?.version).toBe("4.4.0");
  expect(full.pythons.length).toBe(4);
});

test("adoptBinaryDir prepends once; compareVersions orders numerically", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  adoptBinaryDir("/Users/x/.local/bin/uv", env);
  adoptBinaryDir("/Users/x/.local/bin/uv", env);
  expect(env.PATH).toBe(`/Users/x/.local/bin${path.delimiter}/usr/bin`);
  expect(compareVersions("3.10.1", "3.9.9")).toBeGreaterThan(0);
  expect(compareVersions("3.12", "3.12.0")).toBe(0);
});
