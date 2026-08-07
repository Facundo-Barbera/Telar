#!/usr/bin/env bun
/**
 * apps/web lint gate — A CEILING, NOT A CLEAN BILL OF HEALTH.
 *
 * apps/web does not lint clean today. Measured on ci/verify-workflow at
 * 2026-08-05: 468 files linted, 45 with findings, 158 problems total —
 * 130 errors and 28 warnings (react-hooks/refs 52,
 * react-hooks/set-state-in-effect 33, no-explicit-any 30, no-unused-vars 19,
 * and a long tail). Most of the backlog is ERRORS, so "fail on errors, tolerate
 * warnings" is not an option that leaves anything running: it would red-X every
 * pull request from the first one, and a gate that is red on arrival gets
 * disabled within a week.
 *
 * The other obvious option — `continue-on-error: true`, lint reported but never
 * blocking — is worse in the opposite direction. It cannot tell the difference
 * between 158 problems and 900, so it makes the gate decorative and lets the
 * backlog grow silently while a green check claims otherwise.
 *
 * So: the current count is pinned as a CEILING. New lint problems fail the
 * build; the existing 158 do not. This is the only one of the three options
 * that is simultaneously honest about the backlog, non-blocking for work that
 * does not add to it, and actually load-bearing.
 *
 * Fixing the 158 is deliberately NOT part of the verification gate's job. When
 * they are fixed, the counts below drop; this script says so, loudly, and asks
 * you to lower them. A drop is never a failure — refusing to merge a lint FIX
 * because the ceiling is stale would be the same self-defeating mistake as
 * shipping a gate that is red on arrival.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Lower these when the backlog shrinks. They may never be raised: raising them
// is what this file exists to prevent, and a PR that does it is visible in
// review precisely because it has to touch this line.
const CEILING = { errors: 129, warnings: 28 };

// A CEILING ALONE FAILS OPEN, so this is the other half of the gate.
//
// Everything above counts FINDINGS. Nothing above counts what was LOOKED AT,
// and those are different numbers: if an ignore glob, a config edit or a typo
// in globalIgnores stops ESLint from walking apps/web, findings fall to zero,
// the "went DOWN" branch below fires, and this script prints a congratulatory
// message and exits 0 while verifying nothing at all. Demonstrated, not
// theorised — an over-broad globalIgnores in a throwaway copy of the config
// produced "4 files linted / 0 errors / 0 warnings" and a green exit.
//
// That is not a hypothetical risk for this branch in particular: the change
// that ships alongside this file adds a new ignore glob (`.next-*/**`) to
// apps/web/eslint.config.mjs. It is correct today — 468 files linted, same
// 130/28 as the old hand-scoped invocation — but a ceiling could not have told
// anyone if it were not.
//
// So: assert coverage before asserting counts. 468 files today; the floor sits
// a little below that so deleting a handful of files is not a build failure,
// while the collapse-to-near-zero that a bad ignore glob causes is.
const MIN_FILES = 460;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = resolve(repoRoot, "apps/web");
const inActions = process.env.GITHUB_ACTIONS === "true";

// `bunx` rather than `eslint`: this repo is Bun-only and there is no guarantee
// of a `node` on PATH (there is none on the maintainer's machine), so the
// eslint shebang cannot be trusted to resolve.
const run = spawnSync("bunx", ["eslint", "--format", "json"], {
  cwd: webDir,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});

if (run.error) {
  console.error(`lint-ceiling: could not start eslint: ${run.error.message}`);
  process.exit(1);
}

// eslint exits 1 merely because findings exist — that is the normal case here
// and is the whole point of the ceiling. Anything above 1 (config error, crash)
// is a real failure and must not be mistaken for "lots of lint problems".
if (run.status !== 0 && run.status !== 1) {
  console.error(`lint-ceiling: eslint exited ${run.status}`);
  console.error(run.stderr || run.stdout);
  process.exit(1);
}

let results;
try {
  results = JSON.parse(run.stdout);
} catch {
  console.error("lint-ceiling: eslint did not produce parseable JSON. Raw output:");
  console.error(run.stdout.slice(0, 4000));
  console.error(run.stderr.slice(0, 4000));
  process.exit(1);
}

let errors = 0;
let warnings = 0;
const byRule = new Map();
const lines = [];

for (const file of results) {
  errors += file.errorCount;
  warnings += file.warningCount;
  if (file.errorCount + file.warningCount === 0) continue;
  const relative = file.filePath.startsWith(repoRoot)
    ? file.filePath.slice(repoRoot.length + 1)
    : file.filePath;
  for (const m of file.messages) {
    const rule = m.ruleId ?? "(no rule)";
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
    const severity = m.severity === 2 ? "error" : "warn ";
    // First line only: the react-hooks rules attach multi-paragraph essays plus
    // a code frame to every finding, which turns 158 problems into ~1400 lines
    // of log nobody scrolls through. The rule name is enough to look the rest up.
    const summary = m.message.split("\n", 1)[0];
    lines.push(`  ${severity} ${relative}:${m.line}:${m.column}  ${rule}  ${summary}`);
  }
}

// Report every finding: a ceiling that hides what it is tolerating teaches
// nobody which files are carrying the debt.
console.log(`eslint: ${results.length} files linted in apps/web (floor ${MIN_FILES})\n`);

// Coverage first — see MIN_FILES above. Checked BEFORE the ceiling because a
// collapsed file count makes the ceiling comparison meaningless rather than
// merely optimistic, and reporting "lint went DOWN" in that state is worse
// than saying nothing.
if (results.length < MIN_FILES) {
  const message =
    `apps/web lint COVERAGE COLLAPSED: ${results.length} files linted, floor is ${MIN_FILES}. ` +
    "An ignore pattern, a globalIgnores edit or a moved directory has silently dropped files " +
    "from the lint run, so the counts below prove nothing. Fix the config — do not lower " +
    "MIN_FILES in scripts/lint-ceiling.mjs unless apps/web genuinely shrank by that much.";
  console.error(inActions ? `::error::${message}` : `\n${message}`);
  process.exit(1);
}
if (lines.length) console.log(lines.join("\n") + "\n");

const ranked = [...byRule.entries()].sort((a, b) => b[1] - a[1]);
console.log("findings by rule:");
for (const [rule, count] of ranked) console.log(`  ${String(count).padStart(4)}  ${rule}`);

const total = errors + warnings;
const ceilingTotal = CEILING.errors + CEILING.warnings;
console.log(
  `\nerrors ${errors}/${CEILING.errors}   warnings ${warnings}/${CEILING.warnings}   total ${total}/${ceilingTotal}`,
);

const over = errors > CEILING.errors || warnings > CEILING.warnings;
if (over) {
  const message =
    `apps/web lint went UP: ${errors} errors / ${warnings} warnings against a ceiling of ` +
    `${CEILING.errors} / ${CEILING.warnings}. Fix the new findings above. ` +
    "Raising the ceiling in scripts/lint-ceiling.mjs is not the fix.";
  console.error(inActions ? `::error::${message}` : `\n${message}`);
  process.exit(1);
}

if (errors < CEILING.errors || warnings < CEILING.warnings) {
  const message =
    `apps/web lint went DOWN to ${errors} errors / ${warnings} warnings. ` +
    "Lower CEILING in scripts/lint-ceiling.mjs to lock the improvement in. " +
    "Not failing the build for this — a lint fix should never be harder to merge than the lint.";
  console.log(inActions ? `::warning::${message}` : `\n${message}`);
}

console.log("\napps/web lint is at or under its ceiling.");
