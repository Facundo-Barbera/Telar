import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MANAGED_TECTONIC_RELEASES,
  MANAGED_TECTONIC_VERSION,
  ManagedTectonic,
  managedRelease,
  managedTectonicBinary,
} from "./managed";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-managed-tectonic-"));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fakeArchive(body: string): Buffer {
  const stage = root();
  fs.writeFileSync(path.join(stage, "tectonic"), body);
  fs.chmodSync(path.join(stage, "tectonic"), 0o755);
  const archive = path.join(stage, "out.tar.gz");
  const made = spawnSync("tar", ["-czf", archive, "-C", stage, "tectonic"], { timeout: 5_000, killSignal: "SIGKILL" });
  if (made.status !== 0) throw new Error(`could not build the fixture archive: ${String(made.stderr)}`);
  return fs.readFileSync(archive);
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const asArrayBuffer = (bytes: Buffer): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

function stubFetch(bytes: Buffer) {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, arrayBuffer: async () => asArrayBuffer(bytes) };
    },
  };
}

function installer(engineRoot: string, bytes: Buffer, overrides: { digest?: string } = {}) {
  const stub = stubFetch(bytes);
  return {
    stub,
    managed: new ManagedTectonic({
      root: engineRoot,
      fetch: stub.fetch,
      platform: "darwin",
      arch: "arm64",
      release: { target: "fixture", url: "https://example.invalid/tectonic.tar.gz", sha256: overrides.digest ?? sha256(bytes) },
    }),
  };
}

test("the release table is pinned: a version and a digest per platform, and each digest is a real sha256", () => {
  expect(Object.keys(MANAGED_TECTONIC_RELEASES).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
  for (const release of Object.values(MANAGED_TECTONIC_RELEASES)) {
    expect(release.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(release.url).toContain(MANAGED_TECTONIC_VERSION);
    expect(release.url).toContain(release.target);
    expect(release.url.startsWith("https://")).toBe(true);
  }
  const digests = Object.values(MANAGED_TECTONIC_RELEASES).map((release) => release.sha256);
  expect(new Set(digests).size).toBe(digests.length);
});

test("a platform with no release is refused rather than half-installed", async () => {
  expect(managedRelease("win32", "x64")).toBeUndefined();
  const home = root();
  const managed = new ManagedTectonic({
    root: home,
    platform: "win32",
    arch: "x64",
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });
  expect(managed.status().supported).toBe(false);

  const after = await managed.install();
  expect(after.installed).toBe(false);
  expect(after.error).toContain("win32-x64");
});

test("a verified download is unpacked, made executable, and becomes the resolved binary", async () => {
  const home = root();
  const bytes = fakeArchive("#!/bin/sh\nexit 0\n");
  const { managed, stub } = installer(home, bytes);

  expect(managed.status().installed).toBe(false);

  const after = await managed.install();
  expect(after.installed).toBe(true);
  expect(after.error).toBeUndefined();
  expect(after.version).toBe(MANAGED_TECTONIC_VERSION);
  expect(stub.calls.length).toBe(1);

  const binary = managedTectonicBinary(home, MANAGED_TECTONIC_VERSION);
  expect(after.path).toBe(binary);
  expect(binary).toBe(path.join(home, "tools", "tectonic", MANAGED_TECTONIC_VERSION, "tectonic"));
  expect(fs.readFileSync(binary, "utf8")).toBe("#!/bin/sh\nexit 0\n");
  expect(fs.statSync(binary).mode & 0o111).toBeGreaterThan(0);
  expect(managed.found()?.path).toBe(binary);

  expect(fs.readdirSync(path.dirname(binary)).sort()).toEqual(["tectonic"]);
  expect(fs.readdirSync(path.join(home, "tools", "tectonic")).sort()).toEqual([MANAGED_TECTONIC_VERSION]);
});

test("A DOWNLOAD THAT DOES NOT MATCH ITS PINNED DIGEST INSTALLS NOTHING", async () => {
  const home = root();
  const bytes = fakeArchive("#!/bin/sh\necho not-tectonic\n");
  const wrong = "0".repeat(64);
  const { managed } = installer(home, bytes, { digest: wrong });

  const after = await managed.install();
  expect(after.installed).toBe(false);
  expect(after.error).toContain("checksum");
  expect(after.error).toContain(wrong);
  expect(after.error).toContain(sha256(bytes));

  expect(fs.existsSync(managedTectonicBinary(home, MANAGED_TECTONIC_VERSION))).toBe(false);
  expect(managed.found()).toBeUndefined();
  const parent = path.join(home, "tools", "tectonic");
  expect(fs.existsSync(parent) ? fs.readdirSync(parent) : []).toEqual([]);
});

test("INSTALLING IS IDEMPOTENT — a second call downloads nothing", async () => {
  const home = root();
  const bytes = fakeArchive("#!/bin/sh\nexit 0\n");
  const { managed, stub } = installer(home, bytes);

  await managed.install();
  expect(stub.calls.length).toBe(1);

  const again = await managed.install();
  expect(again.installed).toBe(true);
  expect(stub.calls.length).toBe(1);

  const reopened = new ManagedTectonic({
    root: home,
    platform: "darwin",
    arch: "arm64",
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });
  expect(reopened.status().installed).toBe(true);
  expect(reopened.found()?.version).toBe(MANAGED_TECTONIC_VERSION);
});

test("ONE INSTALL AT A TIME — concurrent callers share the attempt", async () => {
  const home = root();
  const bytes = fakeArchive("#!/bin/sh\nexit 0\n");
  const { managed, stub } = installer(home, bytes);

  const [first, second] = await Promise.all([managed.install(), managed.install()]);
  expect(first.installed).toBe(true);
  expect(second.installed).toBe(true);
  expect(stub.calls.length).toBe(1);
});

test("a failed attempt is reported, and the RETRY is an ordinary install", async () => {
  const home = root();
  const bytes = fakeArchive("#!/bin/sh\nexit 0\n");
  let fail = true;
  const managed = new ManagedTectonic({
    root: home,
    platform: "darwin",
    arch: "arm64",
    release: { target: "fixture", url: "https://example.invalid/tectonic.tar.gz", sha256: sha256(bytes) },
    fetch: async () =>
      fail
        ? { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) }
        : { ok: true, status: 200, arrayBuffer: async () => asArrayBuffer(bytes) },
  });

  const failed = await managed.install();
  expect(failed.installed).toBe(false);
  expect(failed.installing).toBe(false);
  expect(failed.error).toContain("503");

  fail = false;
  const recovered = await managed.install();
  expect(recovered.installed).toBe(true);
  expect(recovered.error).toBeUndefined();
  expect(fs.readdirSync(path.join(home, "tools", "tectonic")).sort()).toEqual([MANAGED_TECTONIC_VERSION]);
});

test("an archive without a tectonic binary is refused, not published empty", async () => {
  const home = root();
  const stage = root();
  fs.writeFileSync(path.join(stage, "README"), "no binary here");
  const archive = path.join(stage, "out.tar.gz");
  spawnSync("tar", ["-czf", archive, "-C", stage, "README"], { timeout: 5_000, killSignal: "SIGKILL" });
  const { managed } = installer(home, fs.readFileSync(archive));

  const after = await managed.install();
  expect(after.installed).toBe(false);
  expect(after.error).toContain("did not contain a tectonic binary");
  expect(fs.existsSync(managedTectonicBinary(home, MANAGED_TECTONIC_VERSION))).toBe(false);
});
