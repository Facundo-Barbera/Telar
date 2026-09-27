// WHERE A BUILD PUBLISHES ITS FEED (#1042), pinned against the real functions in
// scripts/feed-prefix.sh and the real lines of build-desktop.sh that use them.
// Run under /bin/bash, the 3.2 macOS ships, like shell-array-expansion.test.js.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPTS = import.meta.dir;
const FEED = path.join(SCRIPTS, "feed-prefix.sh");
const BUILD = path.join(SCRIPTS, "build-desktop.sh");

const bash = (body, env = {}) => {
  const result = spawnSync("/bin/bash", ["-c", `set -euo pipefail\n. ${JSON.stringify(FEED)}\n${body}`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
    timeout: 15_000,
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
};

/** The one non-comment line of build-desktop.sh containing `anchor`. */
const buildLine = (anchor) => {
  const hits = fs
    .readFileSync(BUILD, "utf8")
    .split("\n")
    .filter((line) => line.includes(anchor) && !line.trimStart().startsWith("#"));
  if (hits.length !== 1) throw new Error(`build-desktop.sh: ${hits.length} lines contain ${JSON.stringify(anchor)}`);
  return hits[0];
};

describe("the feed prefix", () => {
  test("a relative key path is accepted", () => {
    for (const ok of ["io.github.novarix.telar", "staging/io.github.novarix.telar", "a-b_c.d"]) {
      expect(bash(`feed_prefix_valid ${JSON.stringify(ok)}`).status).toBe(0);
    }
  });

  test("anything that would escape or blur the key is refused", () => {
    for (const bad of ["", "/abs", "trailing/", "a//b", "..", "a/../b", "./a", "a b", "a;b", "a$b"]) {
      expect(bash(`feed_prefix_valid '${bad}'`).status).toBe(1);
    }
  });

  test("objects and the baked feed URL move under the prefix together", () => {
    expect(bash('feed_object_key "io.github.novarix.telar" "/out/beta-mac.yml"').stdout).toBe("io.github.novarix.telar/beta-mac.yml");
    expect(bash('feed_publish_url "https://updates.example/" "io.github.novarix.telar"').stdout).toBe(
      "https://updates.example/io.github.novarix.telar",
    );
  });

  test("with no prefix both stay at the root, as every build before #1042 did", () => {
    expect(bash('feed_object_key "" "/out/Telar-1.0.0-arm64-mac.zip"').stdout).toBe("Telar-1.0.0-arm64-mac.zip");
    expect(bash('feed_publish_url "https://updates.example" ""').stdout).toBe("https://updates.example");
  });
});

describe("the bucket root is the legacy id's alone", () => {
  test("the legacy id may publish to the root", () => {
    expect(bash('feed_refuse "com.telar.desktop" ""').status).toBe(0);
  });

  test("any other id is refused at the root, and names why", () => {
    const refused = bash('feed_refuse "io.github.novarix.telar" ""');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("--feed-prefix");
  });

  test("any id may publish under a prefix", () => {
    expect(bash('feed_refuse "io.github.novarix.telar" "io.github.novarix.telar"').status).toBe(0);
    expect(bash('feed_refuse "com.telar.desktop" "staging/com.telar.desktop"').status).toBe(0);
  });
});

describe("build-desktop.sh uses the prefix where it matters", () => {
  test("the upload names the prefixed key", () => {
    const line = buildLine('aws s3 cp "$1"');
    const out = bash(`aws() { printf '%s\\n' "$@"; }\nR2_BUCKET=bucket; R2_ENDPOINT=e; FEED_PREFIX=io.github.novarix.telar\nset -- /out/beta-mac.yml\n${line.trim()}`);
    expect(out.stdout.split("\n")).toContain("s3://bucket/io.github.novarix.telar/beta-mac.yml");
  });

  test("the baked publish.url carries the prefix", () => {
    const line = buildLine("-c.publish.url=");
    const out = bash(`CONFIG_OVERRIDES=()\nUPDATE_PROXY_URL=https://u.example; UPDATE_PROXY_KEY=k; FEED_PREFIX=p\n${line.trim()}\nprintf '%s\\n' "\${CONFIG_OVERRIDES[@]}"`);
    expect(out.stdout.split("\n")).toContain("-c.publish.url=https://u.example/p");
  });

  test("the root refusal runs for every publish, before the build", () => {
    const script = fs.readFileSync(BUILD, "utf8");
    const refusal = script.indexOf('feed_refuse "$APP_ID" "$FEED_PREFIX" || exit 2');
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(script.indexOf("bun install --frozen-lockfile"));
  });

  test("a malformed prefix is refused before anything is fetched", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "telar-feed-bin-"));
    fs.writeFileSync(path.join(bin, "aws"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = { R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "a", R2_BUCKET: "b", UPDATE_PROXY_URL: "u", UPDATE_PROXY_KEY: "k" };
    const result = spawnSync("/bin/bash", [BUILD, "--publish-r2", "--feed-prefix", "../escape"], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, ...env },
      timeout: 15_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not a relative key path");
    expect(result.stdout).not.toContain("git fetch");
  });
});
