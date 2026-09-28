import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { candidatePathsFor, cliUsable, expectedClaudeCliVersion, findExecutable, isExecutableFile, resolveCli } from "./cli";
import { OPENCODE_VERSION, openCodeVersionVerdict } from "../../drivers/opencode";

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
  delete process.env.OPENCODE_BIN;
});

function fakeCli(directory: string, name: string, version: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = "--version" ] && echo "${version} (fake)"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test("PATH decides, and the well-known directories are only a net behind it", () => {
  const first = root();
  process.env.PATH = `${first}:/usr/bin`;
  const candidates = candidatePathsFor("claude");
  expect(candidates[0]).toBe(path.join(first, "claude"));
  expect(candidates.indexOf(path.join(os.homedir(), ".local", "bin", "claude"))).toBeGreaterThan(0);
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
  process.env.CLAUDE_CODE_EXECUTABLE = path.join(onPath, "claude");
  expect(resolveCli("claude", { binaryPath: wanted }).path).toBe(wanted);
});

test("a bare name in the pin is a name to look up, not a file to open", () => {
  const directory = root();
  const beta = fakeCli(directory, "claude-beta", "2.2.0");
  process.env.PATH = directory;
  expect(resolveCli("claude", { binaryPath: "claude-beta" }).path).toBe(beta);
  const missing = resolveCli("claude", { binaryPath: "claude-nope" });
  expect(missing.status).toBe("missing");
  expect(missing.message).toContain("claude-nope");
});

test("a file without its executable bit is not found, it is refused", () => {
  const directory = root();
  const file = path.join(directory, "claude-unreadable");
  fs.writeFileSync(file, "#!/bin/sh\necho hi\n");
  fs.chmodSync(file, 0o644);
  expect(isExecutableFile(file)).toBe(false);
  fs.mkdirSync(path.join(directory, "codex-dir"));
  expect(isExecutableFile(path.join(directory, "codex-dir"))).toBe(false);

  process.env.PATH = directory;
  expect(findExecutable("claude-unreadable")).toBeUndefined();

  const refused = resolveCli("claude", { binaryPath: file });
  expect(refused.status).toBe("missing");
  expect(refused.message).toContain("not an executable file");
  expect(refused.message).toContain("chmod +x");

  fs.chmodSync(file, 0o755);
  expect(isExecutableFile(file)).toBe(true);
  expect(findExecutable("claude-unreadable")).toBe(file);
});

test("a pin that points nowhere is loud, and never falls through to another binary", () => {
  const directory = root();
  fakeCli(directory, "claude", "2.1.100");
  process.env.PATH = directory;
  const refused = resolveCli("claude", { binaryPath: "/nowhere/at/all/claude" });
  expect(refused.status).toBe("missing");
  expect(refused.path).toBeUndefined();
  expect(refused.message).toContain("nothing is there");
});

test("the realpath comes back with the link, because the install detector needs both", () => {
  const directory = root();
  const real = fakeCli(path.join(directory, "versions"), "2.1.232", "2.1.232");
  const link = path.join(directory, "claude");
  fs.symlinkSync(real, link);
  const resolution = resolveCli("claude", { binaryPath: link });
  expect(resolution.path).toBe(link);
  expect(resolution.realPath).toBe(fs.realpathSync(real));
});

test("a second install is named when the chosen one is not usable", () => {
  const first = root();
  const second = root();
  fakeCli(first, "claude", "2.0.5");
  fakeCli(second, "claude", "2.1.224");
  process.env.PATH = `${first}:${second}`;

  const resolution = resolveCli("claude");
  expect(resolution.status).toBe("incompatible");
  expect(resolution.message).toContain("Also on this machine");
  expect(resolution.message).toContain(path.join(second, "claude"));
  expect(resolution.message).toContain("binary path");
});

test("a healthy install says nothing about copies it is not using", () => {
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
  const first = root();
  const second = root();
  const pinned = fakeCli(first, "claude", "2.0.5");
  fakeCli(second, "claude", "2.1.224");
  process.env.PATH = `${first}:${second}`;

  const resolution = resolveCli("claude", { binaryPath: pinned });
  expect(resolution.status).toBe("incompatible");
  expect(resolution.message).not.toContain("Also on this machine");
});

test("the pairing version is readable at all, which the packaged app proved it was not", () => {
  expect(expectedClaudeCliVersion()).toMatch(/^2\.1\.\d+$/);
});

test("the messages are short enough to read on a settings row", () => {
  const directory = root();
  const pinned = fakeCli(directory, "claude", "2.0.5");
  process.env.PATH = directory;
  expect(resolveCli("claude", { binaryPath: pinned }).message!.length).toBeLessThan(140);

  expect(resolveCli("claude").message!.length).toBeLessThan(360);
});

test("a patch-ahead OpenCode drifts rather than refusing, and stays usable", () => {
  const directory = root();
  const [major, minor] = OPENCODE_VERSION.split(".");
  const pinned = fakeCli(directory, "opencode", `${major}.${minor}.999`);

  const resolution = resolveCli("opencode", { binaryPath: pinned });
  expect(resolution.status).toBe("drifted");
  expect(cliUsable(resolution)).toBe(true);
  expect(resolution.message).toContain(OPENCODE_VERSION);
  expect(resolution.message!.length).toBeLessThan(140);
});

test("a different OpenCode minor is still a refusal, and names the install that fixes it", () => {
  const directory = root();
  const [major, minor] = OPENCODE_VERSION.split(".");
  const pinned = fakeCli(directory, "opencode", `${major}.${Number(minor) + 1}.0`);

  const resolution = resolveCli("opencode", { binaryPath: pinned });
  expect(resolution.status).toBe("incompatible");
  expect(cliUsable(resolution)).toBe(false);
  expect(resolution.message).toContain(`opencode-ai@${OPENCODE_VERSION}`);
});

test("the exact tested OpenCode is plain `ok`, with nothing to say about it", () => {
  const directory = root();
  const pinned = fakeCli(directory, "opencode", OPENCODE_VERSION);

  const resolution = resolveCli("opencode", { binaryPath: pinned });
  expect(resolution.status).toBe("ok");
  expect(resolution.message).toBeUndefined();
});

test("an OpenCode that will not name its version is incompatible, not drifted", () => {
  expect(openCodeVersionVerdict(undefined)).toBe("incompatible");
  expect(openCodeVersionVerdict("")).toBe("incompatible");
  expect(openCodeVersionVerdict(OPENCODE_VERSION)).toBe("ok");
  expect(openCodeVersionVerdict("1.18.31", "1.18.30")).toBe("drifted");
  expect(openCodeVersionVerdict("1.19.0", "1.18.30")).toBe("incompatible");
  expect(openCodeVersionVerdict("2.18.30", "1.18.30")).toBe("incompatible");
});
