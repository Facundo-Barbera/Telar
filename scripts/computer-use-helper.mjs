#!/usr/bin/env bun
/**
 * BUILD "Computer Use for Telar" — cua-driver, rebuilt as Telar's own helper.
 *
 *   bun scripts/computer-use-helper.mjs [--out DIR] [--sign auto|adhoc|<identity>]
 *                                       [--keychain PATH] [--tarball PATH] [--pin PATH]
 *
 * Downloads the release pinned in apps/desktop/computer-use-helper.json, REFUSES
 * it unless its sha256 matches the pin, and turns cua's CuaDriver.app into
 * `<out>/<appName>.app`: Telar's bundle id and name, cua's MIT notice inside,
 * cua's provisioning profile and notarization ticket removed (both belong to
 * cua's team), thinned to arm64 (Telar ships arm64 only), and re-signed with
 * hardened runtime and cua's two public entitlements.
 *
 * WHY A NEW IDENTITY AND NOT A COPY. macOS keys Accessibility and Screen
 * Recording grants to bundle id + team. A copy under `com.trycua.driver` would
 * share (or fight over) the grants of a CuaDriver.app the person installed
 * themselves; ours are separate, and survive Telar updates because neither the
 * id nor the team ever changes.
 *
 * SIGNED HERE, BEFORE electron-builder, because electron-builder would sign it
 * with Telar's inherit entitlements, whose `com.apple.security.inherit` belongs
 * to a sandboxed parent's child — not to an app LaunchServices starts on its
 * own. `mac.signIgnore` keeps electron-builder's hands off it; its signature is
 * still sealed into Telar's.
 *
 * `--sign auto` uses the Developer ID Application identity in --keychain (or
 * $CSC_KEYCHAIN), and falls back to ad-hoc when there is none — the same rule
 * electron-builder applies to Telar itself, so the two never disagree.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const DESKTOP = path.join(REPO, "apps", "desktop");
export const DEFAULT_PIN = path.join(DESKTOP, "computer-use-helper.json");
export const DEFAULT_OUT = path.join(DESKTOP, "vendor", "computer-use");
export const ENTITLEMENTS = path.join(DESKTOP, "build", "computer-use", "entitlements.plist");
export const LICENSE = path.join(DESKTOP, "build", "computer-use", "LICENSE-cua.txt");
/** Files that only make sense under cua's own signature. */
export const CUA_ONLY = ["embedded.provisionprofile", "_CodeSignature", "CodeResources"];

export function readPin(file = DEFAULT_PIN) {
  const pin = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const key of ["tag", "version", "url", "sha256", "bundleId", "appName", "displayName"]) {
    if (typeof pin[key] !== "string" || !pin[key]) throw new Error(`${file}: missing "${key}"`);
  }
  if (!/^[0-9a-f]{64}$/.test(pin.sha256)) throw new Error(`${file}: sha256 is not 64 hex characters`);
  return pin;
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function assertChecksum(buffer, expected, label) {
  const actual = sha256(buffer);
  if (actual !== expected) throw new Error(`${label}: sha256 ${actual} does not match the pinned ${expected} — refusing it`);
}

/** The Info.plist rewrite, as `plutil -replace` argument lists. */
export function plistEdits(pin) {
  return [
    ["CFBundleIdentifier", "-string", pin.bundleId],
    ["CFBundleName", "-string", pin.appName],
    ["CFBundleDisplayName", "-string", pin.displayName],
    ["NSHumanReadableCopyright", "-string", `cua-driver ${pin.version} © Cua AI, Inc. (MIT), bundled with Telar`],
  ];
}

/** codesign argv for one path. Ad-hoc gets no timestamp: there is no identity to stamp. */
export function codesignArgs({ identity, keychain, entitlements, target }) {
  const adhoc = identity === "-";
  return [
    "--force",
    "--options",
    "runtime",
    ...(adhoc ? [] : ["--timestamp"]),
    ...(keychain && !adhoc ? ["--keychain", keychain] : []),
    ...(entitlements ? ["--entitlements", entitlements] : []),
    "--sign",
    identity,
    target,
  ];
}

/** The SHA-1 of the one Developer ID Application identity, parsed from `security find-identity -v -p codesigning`. */
export function pickDeveloperId(findIdentityOutput) {
  const hashes = [...findIdentityOutput.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"Developer ID Application:/gm)].map((m) => m[1]);
  return [...new Set(hashes)][0];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout || "").trim()}`);
  return result.stdout;
}

function resolveIdentity(sign, keychain) {
  if (sign === "adhoc") return "-";
  if (sign !== "auto") return sign;
  const args = ["find-identity", "-v", "-p", "codesigning", ...(keychain ? [keychain] : [])];
  const found = spawnSync("security", args, { encoding: "utf8" });
  return (found.status === 0 && pickDeveloperId(found.stdout)) || "-";
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download ${url} failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function findApp(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === "CuaDriver.app") return full;
    const nested = findApp(full);
    if (nested) return nested;
  }
  return undefined;
}

function thinToArm64(binary) {
  const archs = run("lipo", ["-archs", binary]).trim().split(/\s+/);
  const slice = archs.find((arch) => arch === "arm64") ?? archs.find((arch) => arch.startsWith("arm64"));
  if (!slice) throw new Error(`${binary} has no arm64 slice (${archs.join(" ")})`);
  if (archs.length > 1) run("lipo", [binary, "-thin", slice, "-output", binary]);
}

export async function buildHelper({ pinFile = DEFAULT_PIN, out = DEFAULT_OUT, sign = "auto", keychain = process.env.CSC_KEYCHAIN, tarball } = {}) {
  if (process.platform !== "darwin") throw new Error("the computer-use helper is built on macOS only");
  const pin = readPin(pinFile);
  const archive = tarball ? fs.readFileSync(tarball) : await download(pin.url);
  assertChecksum(archive, pin.sha256, tarball ?? pin.url);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telar-computer-use-"));
  try {
    const archivePath = path.join(scratch, "cua.tar.gz");
    fs.writeFileSync(archivePath, archive);
    run("tar", ["-xzf", archivePath, "-C", scratch]);
    const source = findApp(scratch);
    if (!source) throw new Error(`${pin.tag}: no CuaDriver.app in the release archive`);

    fs.mkdirSync(out, { recursive: true });
    const app = path.join(out, `${pin.appName}.app`);
    fs.rmSync(app, { recursive: true, force: true });
    run("ditto", [source, app]);

    const contents = path.join(app, "Contents");
    for (const name of CUA_ONLY) fs.rmSync(path.join(contents, name), { recursive: true, force: true });
    const plist = path.join(contents, "Info.plist");
    for (const [key, type, value] of plistEdits(pin)) run("plutil", ["-replace", key, type, value, plist]);
    const executable = run("plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", plist]).trim();
    fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });
    fs.copyFileSync(LICENSE, path.join(contents, "Resources", "LICENSE-cua.txt"));

    // Nested executables first, the bundle (its main executable) last; no --deep.
    const macos = path.join(contents, "MacOS");
    const identity = resolveIdentity(sign, keychain);
    const extras = fs.readdirSync(macos).filter((name) => name !== executable);
    for (const name of [...extras, executable]) thinToArm64(path.join(macos, name));
    for (const name of extras) run("codesign", codesignArgs({ identity, keychain, entitlements: ENTITLEMENTS, target: path.join(macos, name) }));
    run("codesign", codesignArgs({ identity, keychain, entitlements: ENTITLEMENTS, target: app }));
    run("codesign", ["--verify", "--strict", "--verbose=2", app]);

    return { app, identity: identity === "-" ? "ad-hoc" : "Developer ID", bundleId: pin.bundleId, version: pin.version };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = {};
  const keys = { "--out": "out", "--sign": "sign", "--keychain": "keychain", "--tarball": "tarball", "--pin": "pinFile" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = keys[argv[i]];
    if (!key || argv[i + 1] === undefined) throw new Error(`unknown or incomplete option: ${argv[i]}`);
    options[key] = path.resolve(argv[i + 1]);
    if (key === "sign") options.sign = argv[i + 1];
  }
  return options;
}

if (import.meta.main) {
  try {
    const built = await buildHelper(parseArgs(process.argv.slice(2)));
    console.log(`==> computer-use helper: cua-driver ${built.version} as ${built.bundleId}, ${built.identity}-signed, at ${built.app}`);
  } catch (error) {
    console.error(`!! computer-use helper: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
