/**
 * WHICH BINARY TELAR RUNS, and whether it is the one the user's own shell runs.
 *
 * The bug this file exists to keep out is silent by construction: Telar
 * resolving a different `claude` than the terminal does, then reporting ITS
 * version on the settings pane. Nothing errors, the number is real, and it is
 * about an executable no turn touches.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { candidatePathsFor, findExecutable, isExecutableFile, resolveCli } from "../src/cli-resolution";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-cli-"));
  roots.push(directory);
  return directory;
};

const savedPath = process.env.PATH;
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  process.env.PATH = savedPath;
  delete process.env.CLAUDE_CODE_EXECUTABLE;
  delete process.env.CODEX_BIN;
});

/** A binary that reports a version, so a resolution gets all the way to `ok`. */
function fakeCli(directory: string, name: string, version: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = "--version" ] && echo "${version} (fake)"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test("PATH decides, and the well-known directories are only a net behind it", () => {
  /**
   * THE ORDERING THIS FILE GOT WRONG. `~/.local/bin`, `/opt/homebrew/bin` and
   * `/usr/local/bin` used to be searched BEFORE PATH, so a stale install in one
   * of them beat the nvm/mise/bun copy the user's shell actually resolves —
   * and the pane would report a version nobody could reproduce in a terminal.
   * T3 Code has no such list at all: bare name, PATH, done. The three survive
   * only as a last resort for a machine whose PATH could not be repaired.
   */
  const first = root();
  process.env.PATH = `${first}:/usr/bin`;
  const candidates = candidatePathsFor("claude");
  expect(candidates[0]).toBe(path.join(first, "claude"));
  expect(candidates.indexOf(path.join(os.homedir(), ".local", "bin", "claude"))).toBeGreaterThan(0);
  // Each directory once, even when PATH already contains a fallback.
  process.env.PATH = "/opt/homebrew/bin";
  expect(candidatePathsFor("claude").filter((entry) => entry === "/opt/homebrew/bin/claude")).toHaveLength(1);
});

test("an explicit pin beats PATH, and beats it whichever way PATH is ordered", () => {
  const onPath = root();
  const pinned = root();
  fakeCli(onPath, "claude", "2.1.100");
  const wanted = fakeCli(pinned, "claude", "2.1.232");
  process.env.PATH = onPath;
  expect(resolveCli("claude", { binaryPath: wanted }).path).toBe(wanted);
  // The login's own pin outranks the machine-wide env var, the same way an
  // instance's declared variable outranks an inherited one.
  process.env.CLAUDE_CODE_EXECUTABLE = path.join(onPath, "claude");
  expect(resolveCli("claude", { binaryPath: wanted }).path).toBe(wanted);
});

test("a bare name in the pin is a name to look up, not a file to open", () => {
  /**
   * T3 Code's rule, and what makes the settings field usable: "claude" means
   * "whichever one my shell finds" and travels between machines, while
   * "/opt/beta/claude" means that file and nothing else. A field that only
   * accepted absolute paths would make every export of these settings
   * machine-specific for no reason.
   */
  const directory = root();
  const beta = fakeCli(directory, "claude-beta", "2.2.0");
  process.env.PATH = directory;
  expect(resolveCli("claude", { binaryPath: "claude-beta" }).path).toBe(beta);
  // And a bare name that is nowhere on PATH says so, naming the name.
  const missing = resolveCli("claude", { binaryPath: "claude-nope" });
  expect(missing.status).toBe("missing");
  expect(missing.message).toContain("claude-nope");
});

test("a file without its executable bit is not found, it is refused", () => {
  /**
   * `existsSync` was never the question. A directory named `claude`, or a file
   * whose mode was dropped by an interrupted install or a copy off a FAT
   * volume, counted as found — and the failure arrived later as a spawn EACCES
   * with nothing anywhere naming the cause.
   */
  const directory = root();
  // A name nothing else on this machine has, so "not found" means this file was
  // skipped rather than some real install being picked up behind it.
  const file = path.join(directory, "claude-unreadable");
  fs.writeFileSync(file, "#!/bin/sh\necho hi\n");
  fs.chmodSync(file, 0o644);
  expect(isExecutableFile(file)).toBe(false);
  fs.mkdirSync(path.join(directory, "codex-dir"));
  expect(isExecutableFile(path.join(directory, "codex-dir"))).toBe(false);

  process.env.PATH = directory;
  expect(findExecutable("claude-unreadable")).toBeUndefined();

  // Pinned at it explicitly, the refusal says which of the two problems it is.
  const refused = resolveCli("claude", { binaryPath: file });
  expect(refused.status).toBe("missing");
  expect(refused.message).toContain("not an executable file");
  expect(refused.message).toContain("chmod +x");

  fs.chmodSync(file, 0o755);
  expect(isExecutableFile(file)).toBe(true);
  expect(findExecutable("claude-unreadable")).toBe(file);
});

test("a pin that points nowhere is loud, and never falls through to another binary", () => {
  // The user most likely to set a pin is the user least able to notice it being
  // ignored: falling through would run a DIFFERENT binary and report a green
  // tick naming a path nobody chose.
  const directory = root();
  fakeCli(directory, "claude", "2.1.100");
  process.env.PATH = directory;
  const refused = resolveCli("claude", { binaryPath: "/nowhere/at/all/claude" });
  expect(refused.status).toBe("missing");
  expect(refused.path).toBeUndefined();
  expect(refused.message).toContain("nothing is there");
});

test("the realpath comes back with the link, because the install detector needs both", () => {
  // `~/.local/bin/claude` is a symlink into `~/.local/share/claude/versions/`,
  // and an npm global links a bin directory into `lib/node_modules`. The link
  // says where it is invoked from; the target says who put it there.
  const directory = root();
  const real = fakeCli(path.join(directory, "versions"), "2.1.232", "2.1.232");
  const link = path.join(directory, "claude");
  fs.symlinkSync(real, link);
  const resolution = resolveCli("claude", { binaryPath: link });
  expect(resolution.path).toBe(link);
  // Through macOS's own /var -> /private/var link as well as the one just made:
  // realpath follows every hop, which is what the install detector wants.
  expect(resolution.realPath).toBe(fs.realpathSync(real));
});

test("a second install is named when the chosen one is not usable", () => {
  /**
   * THE ONE THING THE SEARCH-ORDER CHANGE CAN BREAK. Telar used to prefer three
   * known directories over PATH; it now runs what the terminal runs. On a
   * machine with two installs whose versions disagree, that can flip a working
   * setup to `incompatible` — which refuses every turn, correctly, because the
   * wrapper and the CLI would otherwise misbehave at the protocol level rather
   * than fail cleanly.
   *
   * Refusing is right. Refusing without mentioning that a compatible copy is
   * sitting in the next directory along is not.
   */
  const first = root();
  const second = root();
  fakeCli(first, "claude", "2.0.5"); // a different major.minor: incompatible
  fakeCli(second, "claude", "2.1.224");
  process.env.PATH = `${first}:${second}`;

  const resolution = resolveCli("claude");
  expect(resolution.status).toBe("incompatible");
  // Plural or singular depending on what else this machine has; the load-bearing
  // part is that the OTHER path is named.
  expect(resolution.message).toMatch(/other cop(y|ies)|another copy/);
  expect(resolution.message).toContain(path.join(second, "claude"));
  // And it says what to do about it, in this app's own terms.
  expect(resolution.message).toContain("binary path");
});

test("a healthy install says nothing about copies it is not using", () => {
  // Duplicates are only worth a sentence when they might explain a problem;
  // otherwise this is a permanent note on a working row, which people stop
  // reading. Two Codex copies is the shape this machine actually has.
  const first = root();
  const second = root();
  fakeCli(first, "codex", "0.147.0");
  fakeCli(second, "codex", "0.145.0");
  process.env.PATH = `${first}:${second}`;

  const resolution = resolveCli("codex");
  expect(resolution.status).toBe("ok");
  expect(resolution.message).toBeUndefined();
});

test("a pinned login is not told about copies it deliberately did not choose", () => {
  // Pinning IS the choice. Listing the alternatives back would be noise.
  const first = root();
  const second = root();
  const pinned = fakeCli(first, "claude", "2.0.5");
  fakeCli(second, "claude", "2.1.224");
  process.env.PATH = `${first}:${second}`;

  const resolution = resolveCli("claude", { binaryPath: pinned });
  expect(resolution.status).toBe("incompatible");
  expect(resolution.message).not.toMatch(/other cop(y|ies)|another copy/);
});
