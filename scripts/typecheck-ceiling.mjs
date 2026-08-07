#!/usr/bin/env bun
/**
 * packages/core TEST-TREE typecheck gate — A CEILING, NOT A CLEAN BILL OF HEALTH.
 *
 * WHY THIS FILE EXISTS AT ALL. `packages/core/tsconfig.json` excludes "test",
 * so `tsc --noEmit -p tsconfig.json` — the check the root `typecheck` script
 * runs, and the one the CI step advertises — never opened a single one of the
 * 116 files under packages/core/test. Verified the blunt way: a file containing
 * `const x: number = "definitely not a number"` dropped into that directory was
 * typechecked green. `bun test` erases types rather than checking them, so
 * nothing in the repo covered that tree. The same file under apps/web/lib IS
 * caught, because apps/web's tsconfig includes `**​/*.ts` and therefore checks
 * its 67 test files. The gate's coverage was asymmetric between the two
 * workspaces and the step name overstated what it did.
 *
 * WHY A CEILING RATHER THAN A CLEAN CHECK. Turning the tree on produces 264
 * errors on day one. They are not fake, but they are also not news: 116 of them
 * are one-per-file `TS2307: Cannot find module 'bun:test'`, because this
 * workspace has no `@types/bun` — apps/web works around exactly this with a
 * `// @ts-expect-error no @types/bun in this workspace` line above the import,
 * and packages/core never needed one because it was never checked. The
 * remaining ~148 are real type drift inside test fixtures (test objects missing
 * fields that were later added to the types they stand in for, implicit `any`
 * in callbacks, and so on) that 1906 passing tests are entirely happy with.
 *
 * Making all 264 blocking would put this gate in the red on its first run,
 * which is the failure mode the whole verification design is built to avoid —
 * see the same argument at the top of scripts/lint-ceiling.mjs. Leaving the
 * tree unchecked keeps a real hole open. So: pin the count. New type errors in
 * core's test tree fail the build; the existing ones do not.
 *
 * HOW TO MAKE THE NUMBER GO DOWN. Adding `@types/bun` as a devDependency of
 * packages/core deletes 116 of the 264 in one move (it needs a lockfile update,
 * which is why this branch does not do it). The rest come off a file at a time.
 * Either way this script notices, says so, and asks you to lower the ceiling.
 *
 * A DROP IS NEVER A FAILURE. Same reasoning as the lint ceiling: refusing to
 * merge a fix because it made the pinned number stale is self-defeating.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Lower this when the backlog shrinks. It may never be raised — that is the
// single thing this file exists to prevent, and a PR that does it has to touch
// this line, which is what makes it visible in review.
const CEILING = 264;

// The other half of the gate, for the same reason scripts/lint-ceiling.mjs has
// a MIN_FILES floor: a ceiling counts findings, not coverage. If `include`
// stops matching packages/core/test — a typo, a moved directory, someone
// "fixing" this config back to the excluding one — the error count falls to
// zero and a pure ceiling check reports that as an improvement and exits green.
// So prove the test files were actually opened before trusting the count.
const MIN_TEST_FILES = 110; // 116 today

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = resolve(repoRoot, "packages/core");
const testDirPrefix = resolve(coreDir, "test") + sep;
const inActions = process.env.GITHUB_ACTIONS === "true";

// `bunx --bun` rather than a bare `tsc`: there is no `node` on the maintainer's
// PATH, so the `#!/usr/bin/env node` shebang on tsc's bin cannot be trusted to
// resolve, and `--bun` makes the runtime the same one everywhere instead of
// "node if the machine happens to have one".
//
// `--pretty false` keeps diagnostics to one machine-readable line each instead
// of ANSI code frames.
//
// TWO PASSES, NOT ONE — SO A DYING TYPECHECKER CANNOT FAKE A COVERAGE FAILURE.
//
// This used to be a single `--noEmit --listFiles` run producing both halves.
// In CI that run was being cut short, and because the file list came out of the
// SAME process, a truncated run looked exactly like "the include globs stopped
// matching the test tree". Measured across four runs on identical committed
// content: 57, 118, 109, then 0 test files "loaded" — a number that cannot vary
// unless the process producing it is being killed. Three of those four failed
// as COVERAGE COLLAPSED and sent two investigations after a tsconfig that was
// never wrong.
//
// The coverage half does not need type checking at all: `--listFilesOnly`
// resolves the program, prints what it would have checked, and stops. So the
// floor is now measured by a cheap pass whose output is nothing but paths, and
// the expensive pass produces only diagnostics. If the typechecker dies, the
// file list is still whole and `run.signal` says what happened.
//
// WHAT THIS DOES NOT DO IS SAVE MEMORY, and it was written believing it would.
// Peak RSS, measured: old combined 1.08 GB, listing pass 431 MB, typecheck pass
// 1.10 GB. The typechecker alone costs what the combined run cost. So this
// isolates the measurement from the failure; it does not prevent the failure,
// and 1.1 GB should not be exhausting a runner in the first place. The signal
// check below is what will finally name the cause.
//
// Same project file for both, so the two cannot disagree about what is in
// scope — which is the property the floor depends on.
const tscArgs = (...extra) => [
  "--bun",
  "tsc",
  "-p",
  "tsconfig.typecheck.json",
  "--pretty",
  "false",
  ...extra,
];
const spawnTsc = (extra, what) => {
  const r = spawnSync("bunx", tscArgs(...extra), {
    cwd: coreDir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.signal) {
    const message =
      `typecheck-ceiling: the ${what} pass was KILLED by ${r.signal} — it did not finish, so ` +
      `its output is truncated and neither the coverage floor nor the error count means ` +
      `anything. This is an INFRASTRUCTURE failure, not a coverage or type finding. Most ` +
      `likely the runner ran out of memory. NEXT STEP: give the compiler more headroom; do ` +
      `not touch tsconfig.typecheck.json and do not lower MIN_TEST_FILES.`;
    console.error(inActions ? `::error::${message}` : `\n${message}`);
    process.exit(1);
  }
  return r;
};

const listRun = spawnTsc(["--listFilesOnly"], "file-listing");
const run = spawnTsc(["--noEmit"], "typecheck");

// WHICH COMPILER ACTUALLY RAN, printed always. This workspace declares TWO
// TypeScript majors (packages/core wants ^6, apps/web wants ^5), so `bunx tsc`
// has more than one thing it could legitimately resolve to, and which one it
// picks depends on how the install laid out node_modules. A gate whose result
// depends on that must say which one it got — on a green run as well as a red
// one, because the version is exactly the fact you want from the LAST green run
// when a later one disagrees.
const versionRun = spawnSync("bunx", tscArgs("--version"), {
  cwd: coreDir,
  encoding: "utf8",
});
const tscVersion = (versionRun.stdout ?? "").trim() || "unknown";

if (run.error) {
  console.error(`typecheck-ceiling: could not start tsc: ${run.error.message}`);
  process.exit(1);
}

const stdout = run.stdout ?? "";

// `file(line,col): error TSxxxx: message` — anchored, so the indented
// continuation lines of a multi-line elaboration are not counted as separate
// errors. The second form catches config-level diagnostics, which carry no file
// position (e.g. TS5083 "Cannot read file").
const positioned = /^(.+)\((\d+),(\d+)\): (error|message) (TS\d+): (.*)$/;
const global = /^(error|message) (TS\d+): (.*)$/;

const loadedFiles = [];
const diagnostics = [];

// Paths from the LISTING pass, diagnostics from the CHECK pass — they are two
// processes now and their outputs are no longer interleaved.
for (const line of (listRun.stdout ?? "").split("\n")) {
  if (line.startsWith("/")) loadedFiles.push(line);
}

for (const line of stdout.split("\n")) {
  if (!line) continue;
  if (line.startsWith("/")) continue;
  const m = positioned.exec(line);
  if (m && m[4] === "error") {
    diagnostics.push({ where: `${m[1]}(${m[2]},${m[3]})`, code: m[5], message: m[6] });
    continue;
  }
  const g = global.exec(line);
  if (g && g[1] === "error") {
    diagnostics.push({ where: "(config)", code: g[2], message: g[3] });
  }
}

// tsc's exit codes: 0 clean, 1/2 diagnostics reported, 3+ a project/config
// failure. A crash that produced no file list at all must never be read as
// "zero type errors" — that is the same fail-open this script's floor exists to
// close, arriving through a different door.
if (loadedFiles.length === 0) {
  console.error(`typecheck-ceiling: tsc exited ${run.status} without listing any files.`);
  console.error(stdout.slice(0, 4000));
  console.error((run.stderr ?? "").slice(0, 4000));
  process.exit(1);
}

const testFiles = loadedFiles.filter((f) => f.startsWith(testDirPrefix));

console.log(
  `tsc ${tscVersion} -p packages/core/tsconfig.typecheck.json: ${loadedFiles.length} files ` +
    `loaded, ${testFiles.length} of them under packages/core/test (floor ${MIN_TEST_FILES})\n`,
);

// IS THE TREE ACTUALLY THERE? Counting it on disk separates the two failures
// the old single message conflated: a test tree that really did move or shrink,
// versus a compiler that never opened one sitting right where it always was.
// Measured: CI reports 545 files loaded and 0 under test/, while a clean clone
// with a frozen install on macOS reports 667 and 118 from the same commit — so
// the tree is present and the program is simply not including it. Saying
// "the include globs have stopped matching" there is a false accusation, and it
// cost two investigations.
const onDisk = (() => {
  try {
    return readdirSync(resolve(coreDir, "test")).filter((f) => f.endsWith(".ts")).length;
  } catch {
    return 0;
  }
})();

// Coverage before counts — see MIN_TEST_FILES.
if (testFiles.length < MIN_TEST_FILES && onDisk >= MIN_TEST_FILES) {
  const message =
    `packages/core TEST TYPECHECK: the compiler loaded ${testFiles.length} test files, but ` +
    `${onDisk} .ts files are present under packages/core/test RIGHT NOW. The tree did not ` +
    `move — tsc did not include it. This is a TOOLCHAIN RESOLUTION problem, not a config or ` +
    `coverage one. tsc reported itself as "${tscVersion}"; this workspace declares two ` +
    `TypeScript majors (packages/core ^6, apps/web ^5), so compare that version against the ` +
    `last green run. NEXT STEP: pin the compiler; do not edit tsconfig.typecheck.json and do ` +
    `not lower MIN_TEST_FILES.`;
  console.error(inActions ? `::error::${message}` : `\n${message}`);
  process.exit(1);
}

if (testFiles.length < MIN_TEST_FILES) {
  const message =
    `packages/core TEST TYPECHECK COVERAGE COLLAPSED: ${testFiles.length} test files loaded, ` +
    `floor is ${MIN_TEST_FILES}. The include globs in packages/core/tsconfig.typecheck.json ` +
    "have stopped matching the test tree, so the error count below proves nothing. Fix the " +
    "config rather than lowering MIN_TEST_FILES.";
  console.error(inActions ? `::error::${message}` : `\n${message}`);
  process.exit(1);
}

// Print everything being tolerated. A ceiling that hides its contents teaches
// nobody which files carry the debt, and the first question anyone asks when
// the number moves is "moved because of what?".
if (diagnostics.length) {
  for (const d of diagnostics) console.log(`  ${d.where}  ${d.code}  ${d.message}`);
  console.log("");
}

const byCode = new Map();
for (const d of diagnostics) byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1);
console.log("errors by code:");
for (const [code, count] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${code}`);
}

console.log(`\ncore test-tree type errors ${diagnostics.length}/${CEILING}`);

if (diagnostics.length > CEILING) {
  const message =
    `packages/core test-tree typecheck went UP: ${diagnostics.length} errors against a ceiling ` +
    `of ${CEILING}. Fix the new ones above. Raising the ceiling in ` +
    "scripts/typecheck-ceiling.mjs is not the fix.";
  console.error(inActions ? `::error::${message}` : `\n${message}`);
  process.exit(1);
}

if (diagnostics.length < CEILING) {
  const message =
    `packages/core test-tree typecheck went DOWN to ${diagnostics.length} errors. ` +
    "Lower CEILING in scripts/typecheck-ceiling.mjs to lock the improvement in. " +
    "Not failing the build for this — a fix should never be harder to merge than the defect.";
  console.log(inActions ? `::warning::${message}` : `\n${message}`);
}

console.log("\npackages/core test-tree typecheck is at or under its ceiling.");
