import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  assetName,
  compareSemver,
  isNewer,
  latestStableTag,
  parseChecksums,
  parseSemver,
  releaseUrl,
  serializePin,
  updatePin,
  versionFromTag,
} from "./bump-computer-use-helper.mjs";

const WORKFLOW = path.join(import.meta.dirname, "..", ".github", "workflows", "bump-computer-use-helper.yml");

describe("stable tag filtering", () => {
  test("a stable cua-driver-rs-vX.Y.Z tag parses", () => {
    expect(parseSemver("cua-driver-rs-v0.28.2")).toEqual({ major: 0, minor: 28, patch: 2 });
  });

  test("a nightly tag is not stable", () => {
    expect(parseSemver("nightly-cua-driver-rs-v0.29.0-2026.01.01")).toBeNull();
  });

  test("a prerelease suffix (-rc1 etc.) is not stable", () => {
    expect(parseSemver("cua-driver-rs-v1.0.0-rc1")).toBeNull();
  });

  test("an unrelated tag is not stable", () => {
    expect(parseSemver("v1.2.3")).toBeNull();
    expect(parseSemver("some-other-release-v1.2.3")).toBeNull();
  });

  test("latestStableTag ignores nightlies and non-matching tags, and picks the highest semver", () => {
    const tags = [
      "cua-driver-rs-v0.27.0",
      "nightly-cua-driver-rs-v0.29.0-2026.02.03",
      "cua-driver-rs-v0.28.2",
      "cua-driver-rs-v1.0.0-rc1",
      "some-other-tag",
      "cua-driver-rs-v0.9.9",
    ];
    expect(latestStableTag(tags)).toBe("cua-driver-rs-v0.28.2");
  });

  test("latestStableTag is null when nothing is stable", () => {
    expect(latestStableTag(["nightly-cua-driver-rs-v0.29.0-abc", "v1.0.0"])).toBeNull();
  });
});

describe("semver comparison", () => {
  test("compareSemver orders major, then minor, then patch", () => {
    expect(compareSemver({ major: 1, minor: 0, patch: 0 }, { major: 0, minor: 99, patch: 99 })).toBeGreaterThan(0);
    expect(compareSemver({ major: 0, minor: 28, patch: 2 }, { major: 0, minor: 28, patch: 1 })).toBeGreaterThan(0);
    expect(compareSemver({ major: 0, minor: 28, patch: 1 }, { major: 0, minor: 28, patch: 2 })).toBeLessThan(0);
    expect(compareSemver({ major: 0, minor: 28, patch: 2 }, { major: 0, minor: 28, patch: 2 })).toBe(0);
  });

  test("isNewer is true only when latest actually outranks pinned", () => {
    expect(isNewer("cua-driver-rs-v0.28.2", "cua-driver-rs-v0.28.1")).toBe(true);
    expect(isNewer("cua-driver-rs-v0.28.2", "cua-driver-rs-v0.28.2")).toBe(false);
    expect(isNewer("cua-driver-rs-v0.28.1", "cua-driver-rs-v0.28.2")).toBe(false);
  });

  test("isNewer treats an unparsable pin as always behind", () => {
    expect(isNewer("cua-driver-rs-v0.1.0", "not-a-real-tag")).toBe(true);
  });

  test("isNewer refuses a latest tag that is not itself stable", () => {
    expect(() => isNewer("nightly-cua-driver-rs-v0.29.0-abc", "cua-driver-rs-v0.28.2")).toThrow();
  });

  test("versionFromTag / assetName / releaseUrl are exact", () => {
    expect(versionFromTag("cua-driver-rs-v0.28.2")).toBe("0.28.2");
    expect(() => versionFromTag("nightly-cua-driver-rs-v0.29.0-abc")).toThrow();
    expect(assetName("0.28.2")).toBe("cua-driver-rs-0.28.2-darwin-universal.tar.gz");
    expect(releaseUrl("cua-driver-rs-v0.28.2", assetName("0.28.2"))).toBe(
      "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.2/cua-driver-rs-0.28.2-darwin-universal.tar.gz",
    );
  });
});

describe("checksums.txt parsing", () => {
  const DARWIN_SHA = "e7af9433e5ae64ee167ad4385817d17f8d3f2262de47f3bb8b87c8c4b1afe7a9";
  const LINUX_SHA = "f199122fa13e8017490cece2eb3565089db63573179015e5010d4a27e38cfc41";

  test("reads both text-mode and binary-mode sha256sum lines, skips blanks and junk", () => {
    const text = [
      `${DARWIN_SHA}  cua-driver-rs-0.28.2-darwin-universal.tar.gz`,
      "",
      `${LINUX_SHA} *cua-driver-rs-0.28.2-linux-x86_64.tar.gz`,
      "not a checksum line at all",
      "deadbeef  too-short-to-be-a-sha256",
    ].join("\n");
    const map = parseChecksums(text);
    expect(map["cua-driver-rs-0.28.2-darwin-universal.tar.gz"]).toBe(DARWIN_SHA);
    expect(map["cua-driver-rs-0.28.2-linux-x86_64.tar.gz"]).toBe(LINUX_SHA);
    expect(Object.keys(map)).toHaveLength(2);
  });

  test("hex is lower-cased regardless of how it was published", () => {
    const map = parseChecksums(`${DARWIN_SHA.toUpperCase()}  archive.tar.gz\n`);
    expect(map["archive.tar.gz"]).toBe(DARWIN_SHA);
  });

  test("handles CRLF line endings", () => {
    const map = parseChecksums(`${DARWIN_SHA}  archive.tar.gz\r\n`);
    expect(map["archive.tar.gz"]).toBe(DARWIN_SHA);
  });
});

describe("pin rewrite", () => {
  // Shaped exactly like apps/desktop/computer-use-helper.json.
  const PIN = {
    "//": "THE cua-driver TELAR SHIPS, pinned.",
    tag: "cua-driver-rs-v0.28.2",
    version: "0.28.2",
    asset: "cua-driver-rs-0.28.2-darwin-universal.tar.gz",
    url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.2/cua-driver-rs-0.28.2-darwin-universal.tar.gz",
    sha256: "93b4bcccf0f3d1fbdb293d52fba4bf68beb7a66757ec7b6b2885f7e18b422c88",
    bundleId: "com.telar.desktop.computer-use",
    appName: "Computer Use for Telar",
    displayName: "Computer Use for Telar (cua)",
  };

  test("updatePin only touches tag/version/asset/url/sha256, and preserves key order", () => {
    const next = updatePin(PIN, {
      tag: "cua-driver-rs-v0.29.0",
      version: "0.29.0",
      asset: "cua-driver-rs-0.29.0-darwin-universal.tar.gz",
      url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.29.0/cua-driver-rs-0.29.0-darwin-universal.tar.gz",
      sha256: "f".repeat(64),
    });

    expect(Object.keys(next)).toEqual(Object.keys(PIN));
    expect(next.tag).toBe("cua-driver-rs-v0.29.0");
    expect(next.version).toBe("0.29.0");
    expect(next.asset).toBe("cua-driver-rs-0.29.0-darwin-universal.tar.gz");
    expect(next.sha256).toBe("f".repeat(64));

    // bundleId above all must never move: macOS keys Accessibility / Screen
    // Recording grants to it, and orphaning it is the one unrecoverable mistake.
    expect(next.bundleId).toBe(PIN.bundleId);
    expect(next.appName).toBe(PIN.appName);
    expect(next.displayName).toBe(PIN.displayName);
    expect(next["//"]).toBe(PIN["//"]);
  });

  test("updatePin does not mutate its input", () => {
    updatePin(PIN, { tag: "cua-driver-rs-v9.9.9" });
    expect(PIN.tag).toBe("cua-driver-rs-v0.28.2");
  });

  test("updatePin ignores unknown update keys", () => {
    const next = updatePin(PIN, { bundleId: "com.evil.hijack", tag: "cua-driver-rs-v0.28.3" });
    expect(next.bundleId).toBe(PIN.bundleId);
    expect(next.tag).toBe("cua-driver-rs-v0.28.3");
  });

  test("serializePin is 2-space-indented JSON with a trailing newline, and round-trips", () => {
    const text = serializePin(PIN);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('  "tag": "cua-driver-rs-v0.28.2"');
    expect(JSON.parse(text)).toEqual(PIN);
  });
});

describe("the scheduled workflow", () => {
  const workflow = fs.readFileSync(WORKFLOW, "utf8");

  test("triggers on both a schedule and workflow_dispatch", () => {
    expect(workflow).toMatch(/^\s*schedule:\s*$/m);
    expect(workflow).toMatch(/cron:\s*'[^']+'/);
    expect(workflow).toMatch(/^\s*workflow_dispatch:\s*$/m);
  });

  test("actually runs the bump script", () => {
    expect(workflow).toContain("bun scripts/bump-computer-use-helper.mjs");
  });

  test("grants only the permissions it needs to open a PR", () => {
    expect(workflow).toMatch(/^\s*contents:\s*write\s*$/m);
    expect(workflow).toMatch(/^\s*pull-requests:\s*write\s*$/m);
  });

  test("never auto-merges — a human always presses merge", () => {
    expect(workflow.toLowerCase()).not.toContain("auto-merge");
    expect(workflow.toLowerCase()).not.toContain("automerge");
    expect(workflow).not.toContain("--auto");
  });

  test("names the branch and PR after the version being bumped to", () => {
    expect(workflow).toContain("chore/bump-cua-driver-$VERSION");
    expect(workflow).toContain("$VERSION");
  });
});
