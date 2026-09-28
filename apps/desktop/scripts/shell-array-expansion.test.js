const { describe, expect, test } = require("bun:test");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPTS = path.join(__dirname, "..", "..", "..", "scripts");
const WORKFLOWS = path.join(__dirname, "..", "..", "..", ".github", "workflows");

const systemBash = (body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-shell-array-"));
  const outPath = path.join(dir, "stdout");
  const errPath = path.join(dir, "stderr");
  const out = fs.openSync(outPath, "w");
  const err = fs.openSync(errPath, "w");
  try {
    const result = spawnSync("/bin/bash", ["-c", body], { stdio: ["ignore", out, err], timeout: 15_000 });
    return {
      status: result.status,
      signal: result.signal,
      error: result.error,
      stdout: fs.readFileSync(outPath, "utf8"),
      stderr: fs.readFileSync(errPath, "utf8"),
    };
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const emptyArrayIsUnbound = (() => {
  const probe = systemBash('set -u; a=(); echo "${a[@]}"');
  return probe.status !== 0 && /unbound variable/.test(probe.stderr);
})();

const lineContaining = (file, anchor, root = SCRIPTS) => {
  const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
  const hits = lines.filter((line) => line.includes(anchor) && !line.trimStart().startsWith("#"));
  if (hits.length !== 1) {
    throw new Error(
      `${file}: ${hits.length} non-comment lines contain ${JSON.stringify(anchor)}, expected exactly 1 — ` +
        "the anchor no longer names one line, so this test would be asserting against the wrong text.",
    );
  }
  return hits[0];
};

const unguard = (line) =>
  line
    .replace(/\$\{(\w+)\[@\]\+"\$\{\1\[@\]\}"\}/g, '"${$1[@]}"')
    .replace(/\$\{(\w+)\[\*\]-\}/g, "${$1[*]}");

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

const SIGNING_KEYCHAIN = "/tmp/rt/signing.keychain-db";
const EXISTING_KEYCHAINS = [
  "/Users/runner/Library/Keychains/login.keychain-db",
  "/Users/Ada Lovelace/Library/Keychains/login.keychain-db",
];

const savedSearchList = (paths) =>
  paths.length === 0
    ? ': > "$RUNNER_TEMP/keychain-search-list.txt"'
    : `printf '    "%s"\\n' ${paths.map((p) => `'${p}'`).join(" ")} > "$RUNNER_TEMP/keychain-search-list.txt"`;

const keychainCase = (file) => ({
  what: `${file}: the signing keychain is set alone when the user search list comes back empty`,
  root: WORKFLOWS,
  file,
  anchor: "list-keychains -d user -s",

  also: ["read -rd '' -a EXISTING", "${#EXISTING[@]}"],
  stub: "security",
  scope: ['RUNNER_TEMP="$(mktemp -d)"', `KEYCHAIN=${SIGNING_KEYCHAIN}`],
  emptyState: savedSearchList([]),
  filledState: savedSearchList(EXISTING_KEYCHAINS),
  whenEmpty: ["list-keychains", "-d", "user", "-s", SIGNING_KEYCHAIN],
  whenFilled: ["list-keychains", "-d", "user", "-s", SIGNING_KEYCHAIN, ...EXISTING_KEYCHAINS],
});

const CASES = [
  {
    what: "package-desktop.sh: electron-builder gets no stray argument when CONFIG_OVERRIDES is empty",
    file: "package-desktop.sh",
    anchor: "electron-builder --dir --publish never",
    stub: "bunx",
    scope: [],
    emptyState: "CONFIG_OVERRIDES=()",
    filledState: 'CONFIG_OVERRIDES=("-c.productName=Telar Dev" "-c.appId=io.github.novarix.telar.dev")',
    whenEmpty: ["electron-builder", "--dir", "--publish", "never"],
    whenFilled: [
      "electron-builder",
      "--dir",
      "--publish",
      "never",
      "-c.productName=Telar Dev",
      "-c.appId=io.github.novarix.telar.dev",
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
  keychainCase("nightly-ios.yml"),
  keychainCase("ios-export-probe.yml"),
];

describe("the shell scripts expand their arrays safely under the bash macOS ships", () => {
  for (const testCase of CASES) {
    const line = () => lineContaining(testCase.file, testCase.anchor, testCase.root);

    const setupFor = (state) => [
      ...testCase.scope,
      state,
      ...(testCase.also ?? []).map((anchor) => lineContaining(testCase.file, anchor, testCase.root)),
    ];

    test(`${testCase.what} — and is unchanged when it is not`, () => {
      const empty = argumentsPassedTo({
        line: line(),
        stub: testCase.stub,
        setup: setupFor(testCase.emptyState),
      });
      expect(empty.result.stderr).not.toContain("unbound variable");
      expect(empty.result.status).toBe(0);
      expect(empty.args).toEqual(testCase.whenEmpty);
      expect(empty.count).toBe(testCase.whenEmpty.length);

      const filled = argumentsPassedTo({
        line: line(),
        stub: testCase.stub,
        setup: setupFor(testCase.filledState),
      });
      expect(filled.result.status).toBe(0);
      expect(filled.args).toEqual(testCase.whenFilled);
    });
  }
});

const describeControl = emptyArrayIsUnbound ? describe : describe.skip;

describeControl("the guards are load-bearing: removing one reproduces #808", () => {
  for (const testCase of CASES) {
    test(`${testCase.file}: ${testCase.anchor} fails unguarded`, () => {
      const guarded = lineContaining(testCase.file, testCase.anchor, testCase.root);
      const stripped = unguard(guarded);

      expect(stripped).not.toBe(guarded);

      const broken = argumentsPassedTo({
        line: stripped,
        stub: testCase.stub,
        setup: [
          ...testCase.scope,
          testCase.emptyState,
          ...(testCase.also ?? []).map((anchor) => lineContaining(testCase.file, anchor, testCase.root)),
        ],
      });
      expect(broken.result.status).not.toBe(0);
      expect(broken.result.stderr).toContain("unbound variable");
    });
  }
});

describe("this file can tell whether it proved anything", () => {
  test("on macOS, /bin/bash is a bash that can actually reproduce #808", () => {
    if (process.platform !== "darwin") return;
    expect(emptyArrayIsUnbound).toBe(true);
  });

  test("the child's stdout and stderr are files, so nothing it wrote can be left unread", () => {
    const fds = systemBash("[ -f /dev/fd/1 ] && [ -f /dev/fd/2 ]");
    expect(fds.status).toBe(0);
  });

  test("the probe is measuring the system bash, not whatever PATH offers", () => {
    const version = systemBash("echo $BASH_VERSION");
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).not.toBe("");

    expect(emptyArrayIsUnbound).toBe(version.stdout.trim().startsWith("3."));
  });
});
