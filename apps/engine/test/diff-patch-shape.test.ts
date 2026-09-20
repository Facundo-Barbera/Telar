/**
 * WHAT ONE ROW'S PATCH ACTUALLY SAYS — issue #694's correctness pass.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * REAL REPOSITORIES, NOT PATCH STRINGS, AND THAT IS THE WHOLE POINT OF THE FILE.
 *
 * Every defect below is a bug in the COMMAND — which pathspec was passed, which
 * exit status was believed, which config git was run under. A fixture that
 * starts from a hand-written patch has already skipped the part that was wrong,
 * which is exactly why `git.test.ts`'s fake runners — correct, thorough, and
 * green throughout — could not see any of this. So each test here builds a
 * throwaway git repository in a temp directory and reads what git really
 * printed.
 *
 * The sibling suite keeps the fakes: they cover the PARSING of git's output,
 * where a real repository buys nothing and costs a subprocess.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionFilePatch, sessionFilePatchAsync } from "../src/git";
import { createAsyncGitRunner, createGitRunner } from "../src/worktree";

const roots: string[] = [];
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/**
 * A throwaway repository with one commit, so `HEAD` resolves.
 *
 * `config` IS APPLIED BEFORE THE COMMIT, which matters for exactly one caller
 * and is the reason it is a parameter: `core.autocrlf` decides what goes INTO
 * the index, so setting it afterwards produces a repository whose index and
 * config disagree — a real state, but not the one the CRLF fixture is about.
 */
function repo(
  seed: Record<string, string> = { "seed.txt": "seed\n" },
  config: Record<string, string> = {},
): { root: string; git: (...args: string[]) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-694-"));
  roots.push(root);
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  for (const [key, value] of Object.entries(config)) git("config", key, value);
  for (const [name, body] of Object.entries(seed)) fs.writeFileSync(path.join(root, name), body);
  git("add", "-A");
  git("commit", "-qm", "initial");
  return { root, git };
}

const async = createAsyncGitRunner();
const sync = createGitRunner();

/**
 * A PATCH LARGER THAN THE RUNNER'S OUTPUT BOUND IS NOT A PATCH — §2.1, and the
 * worst of the six because it is the only one that renders as hunks.
 *
 * The runner stops collecting at 1 MiB, kills git and returns status 1 with the
 * megabyte it had. `1` is also how `--no-index` says "the files differ", so
 * `assemblePatch` took the prefix for a complete answer: real hunks, ending
 * mid-line, `incomplete` absent, and a reader shown a quarter of a change with
 * nothing anywhere saying so.
 *
 * THE ASSERTION THAT IS NOT VACUOUS is the COMPARISON: `incomplete` alone could
 * be set by a fix that also threw the hunks away, and a length alone proves
 * nothing without git's own figure to measure it against. Both, or neither.
 */
test("a patch cut at the engine's output bound says so, on both runners (#694)", async () => {
  // ~64 chars a line over 30,000 lines ≈ 1.9 MB, rewritten end to end, so git's
  // patch is both sides at once — past the async runner's 1 MiB bound and past
  // the 1.5 MiB at which `spawnSync` stops collecting under Bun, so BOTH
  // runners are genuinely short of the answer rather than one of them.
  const lines = 30_000;
  const before = Array.from({ length: lines }, (_, index) => `line ${index} ${"a".repeat(50)}`).join("\n");
  const after = Array.from({ length: lines }, (_, index) => `LINE ${index} ${"b".repeat(50)}`).join("\n");
  const { root, git } = repo({ "big.txt": `${before}\n` });
  fs.writeFileSync(path.join(root, "big.txt"), `${after}\n`);

  /**
   * WHAT GIT REALLY HAS TO SAY, read THROUGH A FILE rather than through a pipe:
   * `maxBuffer` is not honoured by Bun's `spawnSync`, which stops collecting at
   * its own 1.5 MiB whatever it is passed — so a pipe here would measure the
   * test harness's bound instead of git's answer and the comparison below would
   * be against the wrong number.
   */
  const spill = path.join(root, "..", `${path.basename(root)}-whole.patch`);
  const handle = fs.openSync(spill, "w");
  try {
    execFileSync("git", ["diff", "--unified=3", "HEAD", "--", "big.txt"], { cwd: root, stdio: ["ignore", handle, "pipe"] });
  } finally {
    fs.closeSync(handle);
  }
  const whole = fs.readFileSync(spill, "utf8");
  fs.rmSync(spill, { force: true });
  expect(whole.length).toBeGreaterThan(2 * 1024 * 1024);

  for (const [runner, answer] of [
    ["async", await sessionFilePatchAsync(async, { cwd: root, path: "big.txt" })],
    ["sync", sessionFilePatch(sync, { cwd: root, path: "big.txt" })],
  ] as const) {
    expect(answer.incomplete, `${runner} runner reports the bound`).toBe("truncated");
    // What arrived is KEPT (#650) and is a real prefix of a real answer...
    expect(answer.patch.length, `${runner} kept what it read`).toBeGreaterThan(0);
    // ...and is SHORTER than what git was saying, which is the fact the old
    // answer could not express at all.
    expect(answer.patch.length, `${runner} did not get the whole patch`).toBeLessThan(whole.length);
    expect(whole.startsWith(answer.patch.slice(0, 200)), `${runner} read the real patch's start`).toBe(true);
    // And it is not mistaken for a binary file, which is #654's failure.
    expect(answer.binary).toBe(false);
  }
});

/**
 * The other half of the same line — that `status === 1` on the TRACKED arm is
 * git failing — is in `git.test.ts` rather than here, and deliberately: no real
 * `git diff HEAD -- path` exits 1, which is exactly why the special case looked
 * harmless for as long as it did. The case is reachable only through a runner
 * that reports it, so a fake runner is the honest fixture for it.
 *
 * ...while `--no-index`'s own `1` still means the two files differ.
 */
test("an untracked file's patch is still read from --no-index's exit 1 (#694)", async () => {
  const { root } = repo();
  fs.writeFileSync(path.join(root, "fresh.txt"), "alpha\nbeta\n");
  const answer = await sessionFilePatchAsync(async, { cwd: root, path: "fresh.txt", untracked: true });
  expect(answer.incomplete).toBeUndefined();
  expect(answer.patch).toContain("+alpha");
  expect(answer.patch).toContain("+beta");
});

/** Every `diff --git` header in a patch, which is git's own count of how many
 *  files it decided to talk about. */
const filesIn = (patch: string): string[] => patch.split("\n").filter((line) => line.startsWith("diff --git "));

/**
 * A PATHSPEC IS A PATTERN — §2.6, and the defect that needs a real repository
 * most of all, because it is entirely a bug in the ARGUMENT. Hand-write the
 * patch string and you have already applied the fix.
 */
test("a row's patch describes that row's file and no other, whatever it is called (#694)", async () => {
  const { root } = repo({ "brack1.ts": "one\n", "brack[1].ts": "literal\n" });
  fs.appendFileSync(path.join(root, "brack1.ts"), "GLOBBED\n");
  fs.appendFileSync(path.join(root, "brack[1].ts"), "LITERAL\n");

  const bracket = await sessionFilePatchAsync(async, { cwd: root, path: "brack[1].ts" });
  // EXACTLY ONE is the assertion: as a pattern, `brack[1].ts` matches
  // `brack1.ts` as well, and the row drew both files' changes under one name.
  expect(filesIn(bracket.patch)).toHaveLength(1);
  expect(bracket.patch).toContain("+LITERAL");
  expect(bracket.patch).not.toContain("+GLOBBED");

  // ...and the neighbour is still perfectly readable on its own.
  const plain = await sessionFilePatchAsync(async, { cwd: root, path: "brack1.ts" });
  expect(filesIn(plain.patch)).toHaveLength(1);
  expect(plain.patch).toContain("+GLOBBED");
});

/**
 * `!` IS PATHSPEC MAGIC, not a character — the same defect's other end. A name
 * beginning with one inverts the match rather than over-matching it, so the row
 * comes back blank instead of wrong.
 */
test("a path that begins with pathspec magic is still just a path (#694)", async () => {
  const { root } = repo({ "!bang.ts": "bang\n" });
  fs.appendFileSync(path.join(root, "!bang.ts"), "CHANGED\n");
  const answer = await sessionFilePatchAsync(async, { cwd: root, path: "!bang.ts" });
  expect(answer.incomplete).toBeUndefined();
  expect(filesIn(answer.patch)).toHaveLength(1);
  expect(answer.patch).toContain("+CHANGED");
});

/**
 * §2.7 — `core.quotePath` defaults to true and the header carries C escapes
 * rather than the name. Asserted on BOTH arms, because the untracked one builds
 * its header from a different command line.
 */
test("a non-ASCII filename reaches the patch header as itself (#694)", async () => {
  const { root } = repo({ "café.ts": "cafe\n" });
  fs.appendFileSync(path.join(root, "café.ts"), "accent\n");
  fs.writeFileSync(path.join(root, "naïve.ts"), "fresh\n");

  const tracked = await sessionFilePatchAsync(async, { cwd: root, path: "café.ts" });
  expect(tracked.patch).toContain("a/café.ts");
  // The shape of the wrong answer, named so the assertion cannot pass vacuously.
  expect(tracked.patch).not.toContain("caf\\303\\251");

  const untracked = await sessionFilePatchAsync(async, { cwd: root, path: "naïve.ts", untracked: true });
  expect(untracked.patch).toContain("b/naïve.ts");
  expect(untracked.patch).not.toContain("na\\303\\257ve");
});

/**
 * THE TWO ARMS MUST REPORT THE SAME LINE ENDINGS — §3, and this is a PIN on a
 * property that already holds rather than a fix, because the divergence the
 * investigation predicted does not reproduce.
 *
 * WHAT WAS PREDICTED: on Windows with `core.autocrlf=true`, a tracked file
 * diffs through the index and comes back LF while an untracked one goes through
 * `git diff --no-index`, reads the working file raw, and comes back CRLF — so
 * one file list would draw two different line endings depending on whether git
 * had seen the file before. The proposed fix was `--ignore-cr-at-eol` on the
 * `--no-index` arm.
 *
 * WHAT WAS MEASURED, on git 2.55: neither half holds. `--no-index` applies
 * `core.autocrlf` as well — under `autocrlf=true` BOTH arms come back LF, and
 * with it off BOTH keep the `\r` — and `--ignore-cr-at-eol` changes nothing
 * either way, because it is a COMPARISON option and every line of a new file is
 * an addition with nothing to compare against.
 *
 * So the flag was not added: it would have been a change that does nothing,
 * against a bug that is not there, carried by everyone who reads this code
 * afterwards. This pins the property the flag was meant to buy, which is the
 * part worth keeping — and it fails the moment either arm starts normalising on
 * its own.
 */
test("both patch arms report the same line endings, under either autocrlf (#694)", async () => {
  const carriesCR = (patch: string): boolean => patch.split("\n").some((line) => /^[+\- ].*\r$/.test(line));
  for (const autocrlf of ["false", "true"] as const) {
    // Set before the commit, so the INDEX is what this setting says it is —
    // see `repo`. Under `true` that means LF in the index and CRLF on disk,
    // which is the Windows arrangement §3 is about.
    const { root } = repo({ "tracked.txt": "a\r\nb\r\nc\r\n" }, { "core.autocrlf": autocrlf });
    fs.writeFileSync(path.join(root, "tracked.txt"), "a\r\nZ\r\nc\r\n");
    fs.writeFileSync(path.join(root, "untracked.txt"), "x\r\ny\r\n");

    const tracked = await sessionFilePatchAsync(async, { cwd: root, path: "tracked.txt" });
    const untracked = await sessionFilePatchAsync(async, { cwd: root, path: "untracked.txt", untracked: true });
    expect(carriesCR(tracked.patch), `autocrlf=${autocrlf}: the two arms agree`).toBe(carriesCR(untracked.patch));
    // ...and the pin is not vacuous: with autocrlf off git really does keep the
    // `\r`, so "they agree" is a claim about two true answers rather than two
    // empty ones.
    expect(carriesCR(tracked.patch), `autocrlf=${autocrlf}: git kept what the file has`).toBe(autocrlf === "false");
  }
});
