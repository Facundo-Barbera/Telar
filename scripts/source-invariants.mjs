#!/usr/bin/env bun
/**
 * THINGS THAT ARE TRUE OF THE SOURCE TEXT, asserted where no app has to run.
 *
 * Some invariants are about what the code SAYS rather than what it does: a
 * literal that must not come back, a call a view must still make. They need
 * no process, no simulator and no device — only the files. Asserting them
 * from inside a unit test is a trap, and one this repo has now fallen into
 * twice: a test that resolves its source root from `#filePath` is reading a
 * path baked in at COMPILE time on the machine that compiled it, while the
 * test itself runs in the app's process on the destination. On a simulator
 * sharing the Mac's filesystem that path happens to exist and the test
 * passes; on a device it does not exist and the test throws. The check looks
 * green exactly where it is not needed and red exactly where it is.
 *
 * So they live here, and run in `verify.yml`, which gates every pull request
 * and needs no Mac at all. A check moved here guards MORE than it did as a
 * Swift test, not less.
 *
 * ADDING ONE: append to CHECKS. A check is a name, a sentence saying what it
 * protects, and a `run` returning an array of human-readable failures (empty
 * when it holds). Keep the failure text actionable — it is read by someone
 * who has just been stopped by it and does not yet know why.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(join(ROOT, path), "utf8");

/**
 * A SWEPT FILE STAYS SWEPT — the Dynamic Type sweep's regression guard (#248).
 *
 * The sweep replaces absolute `.system(size:)` fonts with Dynamic Type styles,
 * one file group per pull request over many of them. The failure that invites
 * is silent: a file converted in March grows a fresh `.system(size:)` in April
 * and nobody notices, because nothing about an absolute size looks wrong until
 * a reader turns their text up.
 *
 * Every non-zero count below is a site deliberately held back because its
 * frame is fixed in BOTH dimensions and clips, so a glyph that grew with the
 * reader's text would only outgrow its own target. Those need a
 * `@ScaledMetric` frame — a layout change rather than a token swap — and are
 * tracked in #674. THESE NUMBERS ARE MEANT TO DROP as that work lands, and
 * the failure is how you find out it did.
 */
const SWEPT_FILES = [
  ["apps/ios/TelarMobile/Views/TranscriptViews.swift", 0, ""],
  [
    "apps/ios/TelarMobile/Views/SessionView.swift",
    9,
    "the composer's send/attach/stop circles, the model pill and the jump-to-bottom button — 44pt and 36pt (#449)",
  ],
  [
    "apps/ios/TelarMobile/Views/Panel/NotebookSurface.swift",
    2,
    "the run button's 44pt square and the markdown marker beside it",
  ],
  [
    "apps/ios/TelarMobile/Views/Panel/CellOutputView.swift",
    3,
    "DataframeGrid's 96×30 header and 96×22 cells",
  ],
  ["apps/ios/TelarMobile/Views/DiffView.swift", 0, ""],
  [
    "apps/ios/TelarMobile/Views/Panel/FilesSurface.swift",
    1,
    "the file strip's 28×28 tree toggle",
  ],
];

const LITERAL = ".system(size:";

const CHECKS = [
  {
    name: "ios-type-scale",
    protects: "the Dynamic Type sweep (#248): no swept iOS file regains an absolute font size",
    async run() {
      const failures = [];
      for (const [path, allowed, why] of SWEPT_FILES) {
        let source;
        try {
          source = await read(path);
        } catch {
          failures.push(`${path}: pinned at ${allowed} but the file is missing — was it moved or renamed?`);
          continue;
        }
        const found = source.split(LITERAL).length - 1;
        if (found === allowed) continue;
        failures.push(
          found > allowed
            ? `${path}: ${found} absolute sizes, expected ${allowed}. A ${LITERAL}) came back — use a Dynamic Type style, or if it genuinely belongs in a frame fixed in both dimensions, raise the pin in scripts/source-invariants.mjs and say why.`
            : `${path}: ${found} absolute sizes, expected ${allowed}. Fewer than pinned is good news — lower the number in scripts/source-invariants.mjs to lock it in.${why ? ` (held back: ${why})` : ""}`,
        );
      }
      return failures;
    },
  },
];

let failed = 0;
for (const check of CHECKS) {
  const failures = await check.run();
  if (failures.length === 0) {
    console.log(`  ok  ${check.name} — ${check.protects}`);
    continue;
  }
  failed += 1;
  console.error(`FAIL  ${check.name} — ${check.protects}`);
  for (const line of failures) console.error(`        ${line}`);
}

if (failed > 0) {
  console.error(`\n${failed} of ${CHECKS.length} source invariants failed.`);
  process.exit(1);
}
