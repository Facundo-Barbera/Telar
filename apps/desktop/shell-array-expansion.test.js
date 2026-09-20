// EMPTY ARRAYS, UNDER `set -u`, ON THE BASH macOS ACTUALLY SHIPS (#808).
//
// `scripts/package-desktop.sh` could not complete on a stock Mac. It sets
// `set -euo pipefail`, declares `CONFIG_OVERRIDES=()`, fills it only inside the
// `--dev` branch, and then expanded it as `"${CONFIG_OVERRIDES[@]}"`. Bash 3.2
// treats that — an expansion of an EMPTY array — as an unbound variable and
// aborts; bash 4.4 stopped doing so. macOS ships 3.2.57 as /bin/bash, so every
// non-`--dev` path (`pack`, `package:local`, `install:local`) died on that line
// while `package:dev` worked.
//
// TWO THINGS MAKE THIS FILE WORTH MORE THAN "THE SCRIPT DOES NOT CRASH":
//
//   1. It runs `/bin/bash` EXPLICITLY, never `bash` from PATH. On a machine
//      with a Homebrew bash 5.x ahead of /bin/bash — which is most machines
//      that have ever run a Homebrew formula — `bash` is 5.x, the bug cannot
//      reproduce, and a check written against PATH would be vacuous on exactly
//      the machine that has the bug.
//
//   2. It runs each protected line in BOTH directions. The real line, read out
//      of the real file, must pass the right arguments; the same line with its
//      guard mechanically stripped must die with "unbound variable". The
//      negative direction is what stops this file going quietly green if the
//      guards are removed, and it is exercised on every run rather than once by
//      hand — so it cannot rot into a test that could not fail.
//
// The lines are read from the scripts rather than transcribed, so a guard that
// is deleted or rewritten is tested as it now reads, not as it once did.

const { describe, expect, test } = require("bun:test");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SCRIPTS = path.join(__dirname, "..", "..", "scripts");

// /bin/bash, and the path is the point — see (1) above.
const systemBash = (body) => spawnSync("/bin/bash", ["-c", body], { encoding: "utf8", timeout: 15_000 });

/**
 * Does THIS /bin/bash have the behaviour the guards exist for?
 *
 * Only a 3.2-era bash does, so on Linux — where /bin/bash is 5.x and the whole
 * unit suite also runs — the negative direction below cannot fire. That is
 * stated and asserted rather than skipped silently: see the darwin test at the
 * bottom of this file, and the `prove` step in verify.yml's macOS job.
 */
const emptyArrayIsUnbound = (() => {
  const probe = systemBash('set -u; a=(); echo "${a[@]}"');
  return probe.status !== 0 && /unbound variable/.test(probe.stderr);
})();

/**
 * The one non-comment line of `file` containing `anchor`.
 *
 * Throws when it is not exactly one. An anchor that has stopped identifying a
 * single line means this test is reading some other text and asserting things
 * about it — which would look like a pass.
 */
const lineContaining = (file, anchor) => {
  const lines = fs.readFileSync(path.join(SCRIPTS, file), "utf8").split("\n");
  const hits = lines.filter((line) => line.includes(anchor) && !line.trimStart().startsWith("#"));
  if (hits.length !== 1) {
    throw new Error(
      `${file}: ${hits.length} non-comment lines contain ${JSON.stringify(anchor)}, expected exactly 1 — ` +
        "the anchor no longer names one line, so this test would be asserting against the wrong text.",
    );
  }
  return hits[0];
};

/** Rewrite a guarded expansion back to the unguarded form that #808 was. */
const unguard = (line) =>
  line
    .replace(/\$\{(\w+)\[@\]\+"\$\{\1\[@\]\}"\}/g, '"${$1[@]}"')
    .replace(/\$\{(\w+)\[\*\]-\}/g, "${$1[*]}");

/**
 * Run one line with its arrays in a chosen state, capturing what the command on
 * it was actually handed. The command is shadowed by a shell function, so
 * nothing is built, downloaded or installed — this is about argument expansion
 * and nothing else.
 */
const argumentsPassedTo = ({ line, stub, setup }) => {
  const body = [
    "set -euo pipefail",
    ...setup,
    `${stub}() { printf 'COUNT:%s\\n' "$#"; for a in "$@"; do printf 'ARG:%s\\n' "$a"; done; }`,
    line,
  ].join("\n");
  const result = systemBash(body);
  const args = [...result.stdout.matchAll(/^ARG:(.*)$/gm)].map((m) => m[1]);
  const count = result.stdout.match(/^COUNT:(\d+)$/m);
  return { result, args, count: count ? Number(count[1]) : null };
};

// Each case names a line by an anchor, says what the script has in scope when
// it reaches that line, and states what the command must receive with the
// guarded array empty and with it filled.
const CASES = [
  {
    what: "package-desktop.sh: electron-builder gets no stray argument when CONFIG_OVERRIDES is empty",
    file: "package-desktop.sh",
    anchor: "electron-builder --dir --publish never",
    stub: "bunx",
    scope: [],
    emptyState: "CONFIG_OVERRIDES=()",
    filledState: 'CONFIG_OVERRIDES=("-c.productName=Telar Dev" "-c.appId=com.telar.desktop.dev")',
    whenEmpty: ["electron-builder", "--dir", "--publish", "never"],
    whenFilled: [
      "electron-builder",
      "--dir",
      "--publish",
      "never",
      "-c.productName=Telar Dev",
      "-c.appId=com.telar.desktop.dev",
    ],
  },
  {
    what: "package-desktop.sh: install-app.sh is invoked cleanly when INSTALL_ARGS is empty (`install:local`)",
    file: "package-desktop.sh",
    anchor: "install-app.sh",
    stub: "bash",
    scope: ['DESKTOP_DIR=/tmp/desktop', 'APP="/tmp/desktop/release/mac-arm64/Telar.app"'],
    emptyState: "INSTALL_ARGS=()",
    filledState: 'INSTALL_ARGS=("--destination" "/Applications" "--open")',
    whenEmpty: ["/tmp/desktop/install-app.sh", "--app", "/tmp/desktop/release/mac-arm64/Telar.app", "--verified"],
    whenFilled: [
      "/tmp/desktop/install-app.sh",
      "--app",
      "/tmp/desktop/release/mac-arm64/Telar.app",
      "--verified",
      "--destination",
      "/Applications",
      "--open",
    ],
  },
  {
    what: "build-desktop.sh: electron-builder gets only its targets when no --channel and no --publish-r2 were given",
    file: "build-desktop.sh",
    anchor: "bunx electron-builder --mac",
    stub: "bunx",
    scope: ["TARGET_ARGS=(zip dmg)"],
    emptyState: "CONFIG_OVERRIDES=()",
    filledState: 'CONFIG_OVERRIDES=("-c.publish.channel=beta")',
    whenEmpty: ["electron-builder", "--mac", "zip", "dmg"],
    whenFilled: ["electron-builder", "--mac", "zip", "dmg", "-c.publish.channel=beta"],
  },
  {
    // The log line is a `[*]` expansion inside a larger string rather than an
    // argument list, and `[*]` is unbound on an empty array on 3.2 too.
    what: "build-desktop.sh: the progress line survives an empty TARGET_ARGS",
    file: "build-desktop.sh",
    anchor: 'log "electron-builder --mac',
    stub: "log",
    scope: [],
    emptyState: "TARGET_ARGS=()",
    filledState: "TARGET_ARGS=(zip dmg)",
    whenEmpty: ["electron-builder --mac "],
    whenFilled: ["electron-builder --mac zip dmg"],
  },
];

describe("the shell scripts expand their arrays safely under the bash macOS ships", () => {
  for (const testCase of CASES) {
    const line = () => lineContaining(testCase.file, testCase.anchor);

    test(`${testCase.what} — and is unchanged when it is not`, () => {
      const empty = argumentsPassedTo({
        line: line(),
        stub: testCase.stub,
        setup: [...testCase.scope, testCase.emptyState],
      });
      expect(empty.result.stderr).not.toContain("unbound variable");
      expect(empty.result.status).toBe(0);
      expect(empty.args).toEqual(testCase.whenEmpty);
      expect(empty.count).toBe(testCase.whenEmpty.length);

      // The other half of the guard's contract: with the array filled it must
      // still pass exactly its elements, each as ONE argument whatever spaces
      // they carry. This is what rules out "seed the array with a placeholder",
      // which would show up here as an extra argument.
      const filled = argumentsPassedTo({
        line: line(),
        stub: testCase.stub,
        setup: [...testCase.scope, testCase.filledState],
      });
      expect(filled.result.status).toBe(0);
      expect(filled.args).toEqual(testCase.whenFilled);
    });
  }
});

/**
 * THE NEGATIVE DIRECTION, WHICH IS WHAT KEEPS THE BLOCK ABOVE HONEST.
 *
 * Strip each guard and the same line must die the way #808 died. Without this,
 * every assertion above would still pass on a script with no guards at all on a
 * bash that tolerates empty arrays — and would look exactly the same.
 *
 * Only a 3.2-era bash can produce the failure, so this is where /bin/bash's
 * actual behaviour decides whether the block runs. On macOS it must: see the
 * test below and verify.yml's `prove "the guards are load-bearing…"`.
 */
const describeControl = emptyArrayIsUnbound ? describe : describe.skip;

describeControl("the guards are load-bearing: removing one reproduces #808", () => {
  for (const testCase of CASES) {
    test(`${testCase.file}: ${testCase.anchor} fails unguarded`, () => {
      const guarded = lineContaining(testCase.file, testCase.anchor);
      const stripped = unguard(guarded);

      // If the rewrite changed nothing, the "control" would be re-running the
      // guarded line and passing for the wrong reason — either the guard is
      // gone from the script already, or `unguard` has stopped matching it.
      expect(stripped).not.toBe(guarded);

      const broken = argumentsPassedTo({
        line: stripped,
        stub: testCase.stub,
        setup: [...testCase.scope, testCase.emptyState],
      });
      expect(broken.result.status).not.toBe(0);
      expect(broken.result.stderr).toContain("unbound variable");
    });
  }
});

describe("this file can tell whether it proved anything", () => {
  /**
   * A SKIPPED CONTROL AND A RUN CONTROL LOOK THE SAME FROM A GREEN SUITE, so the
   * one platform where the control MUST run says so out loud. /bin/bash on macOS
   * is Apple's 3.2.57 and has been for eighteen years; if this ever fails
   * because Apple shipped a newer one, the premise under every guard in
   * scripts/*.sh has changed and #808 is worth re-reading before anything is
   * deleted.
   */
  test("on macOS, /bin/bash is a bash that can actually reproduce #808", () => {
    if (process.platform !== "darwin") return;
    expect(emptyArrayIsUnbound).toBe(true);
  });

  test("the probe is measuring the system bash, not whatever PATH offers", () => {
    const version = systemBash("echo $BASH_VERSION");
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).not.toBe("");
    // 3.x is the only family with the behaviour; anything newer must report the
    // probe as false, or the probe is not measuring what it claims to.
    expect(emptyArrayIsUnbound).toBe(version.stdout.trim().startsWith("3."));
  });
});
