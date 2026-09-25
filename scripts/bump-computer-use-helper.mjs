#!/usr/bin/env bun
/**
 * Move the cua-driver pin in apps/desktop/computer-use-helper.json forward when
 * trycua/cua cuts a new STABLE cua-driver-rs release.
 *
 *   bun scripts/bump-computer-use-helper.mjs [--check] [--pin PATH]
 *
 * Every cua-driver-rs release is marked "prerelease" on GitHub (so it never
 * steals the monorepo's "Latest" pointer) — a plain `cua-driver-rs-vX.Y.Z` tag
 * is the stable line; `nightly-cua-driver-rs-v...` is not and is ignored here.
 *
 * `--check` prints the pinned tag next to the latest stable one and exits 0
 * without touching anything. Otherwise, when a newer stable tag exists: the
 * darwin-universal tarball is downloaded, hashed locally, and that hash is
 * cross-checked against the release's own checksums.txt (never against the
 * hash we just computed from the same download) — a mismatch or a missing
 * entry aborts before the pin is touched. Only tag/version/asset/url/sha256
 * are rewritten; every other key (bundleId above all) is left exactly as it
 * was, in its original position.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_PIN = path.resolve(import.meta.dirname, "..", "apps", "desktop", "computer-use-helper.json");
const OWNER_REPO = "trycua/cua";
const STABLE_TAG_RE = /^cua-driver-rs-v(\d+)\.(\d+)\.(\d+)$/;

// ── pure ─────────────────────────────────────────────────────────────────

/** `{major,minor,patch}` for a stable `cua-driver-rs-vX.Y.Z` tag, or null — a
 *  nightly (`nightly-cua-driver-rs-v...`) or anything else does not match. */
export function parseSemver(tag) {
  const m = STABLE_TAG_RE.exec(tag);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

export function compareSemver(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** The highest stable cua-driver-rs tag among `tagNames`, or null if none is stable. */
export function latestStableTag(tagNames) {
  let best = null;
  let bestVer = null;
  for (const tag of tagNames) {
    const ver = parseSemver(tag);
    if (ver && (!bestVer || compareSemver(ver, bestVer) > 0)) {
      best = tag;
      bestVer = ver;
    }
  }
  return best;
}

/** Is `latestTag` a newer stable release than whatever `pinnedTag` names? An
 *  unparsable pin (should not happen) is treated as always behind. */
export function isNewer(latestTag, pinnedTag) {
  const latest = parseSemver(latestTag);
  if (!latest) throw new Error(`not a stable cua-driver-rs tag: ${latestTag}`);
  const pinned = parseSemver(pinnedTag);
  return !pinned || compareSemver(latest, pinned) > 0;
}

export function versionFromTag(tag) {
  const m = STABLE_TAG_RE.exec(tag);
  if (!m) throw new Error(`not a stable cua-driver-rs tag: ${tag}`);
  return `${m[1]}.${m[2]}.${m[3]}`;
}

export const assetName = (version) => `cua-driver-rs-${version}-darwin-universal.tar.gz`;

export const releaseUrl = (tag, asset) => `https://github.com/${OWNER_REPO}/releases/download/${tag}/${asset}`;

/** `sha256sum`-style `checksums.txt` (`<hex>  <name>` or `<hex> *<name>`) to a
 *  filename -> lowercase hex sha256 map. Blank lines and stray text are skipped. */
export function parseChecksums(text) {
  const map = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(rawLine);
    if (m) map[m[2]] = m[1].toLowerCase();
  }
  return map;
}

/** A copy of `pin` with only tag/version/asset/url/sha256 replaced — same
 *  keys, same order, everything else untouched. */
export function updatePin(pin, updates) {
  const next = { ...pin };
  for (const key of ["tag", "version", "asset", "url", "sha256"]) {
    if (key in updates) next[key] = updates[key];
  }
  return next;
}

export const serializePin = (pin) => `${JSON.stringify(pin, null, 2)}\n`;

export const sha256Hex = (buffer) => createHash("sha256").update(buffer).digest("hex");

// ── impure ───────────────────────────────────────────────────────────────

function readPinFile(pinFile) {
  return JSON.parse(fs.readFileSync(pinFile, "utf8"));
}

/** `gh api repos/trycua/cua/releases?per_page=50`, parsed. Relies on `gh`'s own
 *  auth locally and on GH_TOKEN in CI. */
function fetchReleases() {
  const result = spawnSync("gh", ["api", `repos/${OWNER_REPO}/releases?per_page=50`], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`gh api releases failed: ${(result.stderr || result.stdout || "").trim()}`);
  return JSON.parse(result.stdout);
}

function assetDownloadUrl(release, name) {
  const asset = (release.assets ?? []).find((a) => a.name === name);
  if (!asset) throw new Error(`${release.tag_name}: release has no "${name}" asset`);
  return asset.browser_download_url;
}

async function downloadBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download ${url} failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function downloadText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download ${url} failed: HTTP ${response.status}`);
  return response.text();
}

export async function checkLatest({ pinFile = DEFAULT_PIN } = {}) {
  const pin = readPinFile(pinFile);
  const releases = fetchReleases();
  const latestTag = latestStableTag(releases.map((r) => r.tag_name));
  if (!latestTag) throw new Error(`no stable cua-driver-rs release found under ${OWNER_REPO}`);
  return { pinnedTag: pin.tag, latestTag, upToDate: !isNewer(latestTag, pin.tag) };
}

/**
 * Bump the pin if a newer stable release exists. Downloads and verifies the
 * tarball against the release's own checksums.txt before writing anything.
 */
export async function bump({ pinFile = DEFAULT_PIN } = {}) {
  const pin = readPinFile(pinFile);
  const releases = fetchReleases();
  const latestTag = latestStableTag(releases.map((r) => r.tag_name));
  if (!latestTag) throw new Error(`no stable cua-driver-rs release found under ${OWNER_REPO}`);
  if (!isNewer(latestTag, pin.tag)) return { updated: false, tag: pin.tag, version: pin.version };

  const release = releases.find((r) => r.tag_name === latestTag);
  const version = versionFromTag(latestTag);
  const asset = assetName(version);

  const archive = await downloadBuffer(assetDownloadUrl(release, asset));
  const computed = sha256Hex(archive);

  const checksums = parseChecksums(await downloadText(assetDownloadUrl(release, "checksums.txt")));
  const expected = checksums[asset];
  if (!expected) throw new Error(`${latestTag}: checksums.txt has no entry for ${asset} — refusing to trust the download alone`);
  if (expected !== computed) {
    throw new Error(`${latestTag}: ${asset} sha256 ${computed} does not match checksums.txt's ${expected} — refusing it`);
  }

  const nextPin = updatePin(pin, { tag: latestTag, version, asset, url: releaseUrl(latestTag, asset), sha256: computed });
  fs.writeFileSync(pinFile, serializePin(nextPin));
  return { updated: true, previousTag: pin.tag, tag: latestTag, version };
}

function parseArgs(argv) {
  const options = { check: false, pinFile: DEFAULT_PIN };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--check") options.check = true;
    else if (argv[i] === "--pin") options.pinFile = path.resolve(argv[(i += 1)]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return options;
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.check) {
      const { pinnedTag, latestTag, upToDate } = await checkLatest(options);
      console.log(`==> bump-computer-use-helper: pinned ${pinnedTag}, latest ${latestTag}${upToDate ? " — up to date" : " — update available"}`);
    } else {
      const result = await bump(options);
      console.log(
        result.updated
          ? `==> bump-computer-use-helper: bumped ${result.previousTag} -> ${result.tag} (${result.version})`
          : `==> bump-computer-use-helper: already at ${result.tag} (${result.version}); nothing to do`,
      );
    }
  } catch (error) {
    console.error(`!! bump-computer-use-helper: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
