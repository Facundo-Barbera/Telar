/**
 * TELAR'S OWN TECTONIC — the install, not the plumbing around it.
 *
 * NOTHING HERE TOUCHES THE NETWORK. Every case hands `ManagedTectonic` a fetch
 * that answers from a tarball built in a temp directory, which is what lets the
 * checksum case exist at all: the point of the digest is that a WRONG payload
 * is refused, and a test that downloaded the real one could only ever assert
 * the happy path.
 *
 * The properties asserted are the ones an installer gets wrong: it verifies, it
 * is idempotent, it publishes atomically (so a failure leaves nothing that
 * looks installed), and it runs one at a time.
 */
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
} from "../src/latex/managed";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-managed-tectonic-"));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A one-file `tectonic` tar.gz, exactly the shape the real release ships. */
function fakeArchive(body: string): Buffer {
  const stage = root();
  fs.writeFileSync(path.join(stage, "tectonic"), body);
  fs.chmodSync(path.join(stage, "tectonic"), 0o755);
  const archive = path.join(stage, "out.tar.gz");
  // BOUNDED FOR #807: a sync child wait blocks this thread in `wait4`, where
  // bun's per-test ceiling — an event-loop timer — cannot reach it, so an
  // unbounded `tar` is a hang no ceiling above it can end. Five seconds is
  // enormous for one small file in a temp directory; SIGKILL because a `tar`
  // that has stopped answering is not about to handle a polite signal.
  const made = spawnSync("tar", ["-czf", archive, "-C", stage, "tectonic"], { timeout: 5_000, killSignal: "SIGKILL" });
  if (made.status !== 0) throw new Error(`could not build the fixture archive: ${String(made.stderr)}`);
  return fs.readFileSync(archive);
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const asArrayBuffer = (bytes: Buffer): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** A fetch that answers with `bytes`, and counts how many times it was asked. */
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

/**
 * A `ManagedTectonic` pointed at a fixture rather than at the real release.
 *
 * THE PINNED TABLE IS NEVER MUTATED. The `release` override exists for exactly
 * this: a fixture's digest cannot be a constant in the shipped table, and
 * writing one in and restoring it afterwards would leave a window in which
 * another test verified against the wrong value.
 */
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
  // The whole security property of this installer is that the digest is a
  // CONSTANT IN THE REPOSITORY rather than something fetched beside the
  // download. A placeholder, a truncated paste, or an entry that drifted off
  // the version in its own URL would each silently defeat it.
  expect(Object.keys(MANAGED_TECTONIC_RELEASES).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
  for (const release of Object.values(MANAGED_TECTONIC_RELEASES)) {
    expect(release.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(release.url).toContain(MANAGED_TECTONIC_VERSION);
    expect(release.url).toContain(release.target);
    expect(release.url.startsWith("https://")).toBe(true);
  }
  // Every digest distinct — one pasted twice would install the wrong
  // architecture's binary on whichever platform it was pasted onto.
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

  // Where the spec says, and executable — a binary the OS refuses to exec is
  // not an install, which is why `found()` checks X_OK rather than existence.
  const binary = managedTectonicBinary(home, MANAGED_TECTONIC_VERSION);
  expect(after.path).toBe(binary);
  expect(binary).toBe(path.join(home, "tools", "tectonic", MANAGED_TECTONIC_VERSION, "tectonic"));
  expect(fs.readFileSync(binary, "utf8")).toBe("#!/bin/sh\nexit 0\n");
  expect(fs.statSync(binary).mode & 0o111).toBeGreaterThan(0);
  expect(managed.found()?.path).toBe(binary);

  // The archive and the scratch directory are gone: the publish is a rename of
  // a finished directory, not a copy into a live one.
  expect(fs.readdirSync(path.dirname(binary)).sort()).toEqual(["tectonic"]);
  expect(fs.readdirSync(path.join(home, "tools", "tectonic")).sort()).toEqual([MANAGED_TECTONIC_VERSION]);
});

test("A DOWNLOAD THAT DOES NOT MATCH ITS PINNED DIGEST INSTALLS NOTHING", async () => {
  // The one case the digest exists for: the bytes that arrived are not the
  // bytes we committed to. Nothing may be published, and the message has to
  // name both digests or a person cannot tell a corrupt download from a
  // release whose asset was replaced.
  const home = root();
  const bytes = fakeArchive("#!/bin/sh\necho not-tectonic\n");
  const wrong = "0".repeat(64);
  const { managed } = installer(home, bytes, { digest: wrong });

  const after = await managed.install();
  expect(after.installed).toBe(false);
  expect(after.error).toContain("checksum");
  expect(after.error).toContain(wrong);
  expect(after.error).toContain(sha256(bytes));

  // Nothing published, and no scratch left behind for a later run to trip on.
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
  // Not a second fetch, and not an error either: "already here" is success.
  expect(stub.calls.length).toBe(1);

  // And a fresh instance over the same root finds it without downloading —
  // the install survives the process that made it.
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

  // Both presses happen before either resolves, which is the race two open
  // settings panes actually produce.
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

  // RESUMABLE: no special recovery path, and the scratch the failure left does
  // not get in the way of the next attempt.
  fail = false;
  const recovered = await managed.install();
  expect(recovered.installed).toBe(true);
  // The previous attempt's error does not linger on a success.
  expect(recovered.error).toBeUndefined();
  expect(fs.readdirSync(path.join(home, "tools", "tectonic")).sort()).toEqual([MANAGED_TECTONIC_VERSION]);
});

test("an archive without a tectonic binary is refused, not published empty", async () => {
  const home = root();
  const stage = root();
  fs.writeFileSync(path.join(stage, "README"), "no binary here");
  const archive = path.join(stage, "out.tar.gz");
  // Bounded for the same reason as `fakeArchive` above — see #807.
  spawnSync("tar", ["-czf", archive, "-C", stage, "README"], { timeout: 5_000, killSignal: "SIGKILL" });
  const { managed } = installer(home, fs.readFileSync(archive));

  const after = await managed.install();
  expect(after.installed).toBe(false);
  expect(after.error).toContain("did not contain a tectonic binary");
  expect(fs.existsSync(managedTectonicBinary(home, MANAGED_TECTONIC_VERSION))).toBe(false);
});
