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
  [
    "apps/ios/TelarMobile/Views/SessionSidebar.swift",
    2,
    "the footer's settings and usage glyphs, both 44pt squares",
  ],
  ["apps/ios/TelarMobile/Views/AgentModelPickerSheet.swift", 0, ""],
  ["apps/ios/TelarMobile/Views/InboxView.swift", 0, ""],
  [
    "apps/ios/TelarMobile/Views/RequestViews.swift",
    1,
    "the request row's 28pt ellipsis square",
  ],
  ["apps/ios/TelarMobile/Views/Panel/LatexSurface.swift", 0, ""],
  ["apps/ios/TelarMobile/Views/Panel/DataSurface.swift", 0, ""],
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
  /**
   * A BOUNDARY INTRODUCES THE WORK UNDER IT — the transcript's render order
   * (#675).
   *
   * `turnRenderOrder` describes the sequence; this pins that the VIEW follows
   * it. The two can drift — the helper goes on describing an order the view
   * has stopped emitting — and that drift is the exact failure the web's own
   * review caught once already. Nothing here needs the app process: it is a
   * statement about the order of a few anchors in one file.
   *
   * It was a Swift test until #675, and it read the view's source through
   * `#filePath`. That is the compiling machine's path, so it passed on a
   * simulator and threw on a device — and since the nightly device job landed,
   * the device is where this repo's iOS suite actually runs. It was failing
   * every run while asserting nothing.
   */
  {
    name: "ios-transcript-order",
    protects:
      "the transcript's render order (#675): TranscriptViews draws a boundary before the work under it",
    async run() {
      const path = "apps/ios/TelarMobile/Views/TranscriptViews.swift";
      let source;
      try {
        source = await read(path);
      } catch {
        return [`${path} is missing — if the view moved, point this check at its new path.`];
      }

      // Every anchor is load-bearing. A check cannot conclude anything about
      // an order it could not locate, so a vanished anchor is a failure and
      // never a silent pass — what the `#require`s did in the Swift original.
      const find = (needle, haystack) => {
        const at = haystack.indexOf(needle);
        return at === -1 ? null : at;
      };

      const loop = find("ForEach(Array(earlier.enumerated())", source);
      const answering = find("if let boundary = answering.boundary", source);
      const absent = [];
      if (loop === null) absent.push("the ForEach over `earlier`");
      if (answering === null) absent.push("the answering response's `if let boundary`");
      if (absent.length > 0) {
        return [
          `${path}: cannot find ${absent.join(" or ")}, so the render order cannot be checked at all. If the view was restructured, re-anchor this check in scripts/source-invariants.mjs rather than dropping it — it is the only thing pinning the view to turnRenderOrder.`,
        ];
      }
      if (answering < loop) {
        return [
          `${path}: the answering response's boundary is drawn before the loop over earlier responses. Finished work comes first, then the response being answered — see turnRenderOrder.`,
        ];
      }

      const failures = [];

      // Scoped to the loop body, so the `response.boundary` further down the
      // file — a different scope, in turnRenderOrder itself — cannot stand in
      // for the one that is supposed to be inside it.
      const body = source.slice(loop, answering);
      const eachBoundary = find("if let boundary = response.boundary", body);
      const eachWork = find("LiveActivityView(items: response.items", body);
      if (eachBoundary === null || eachWork === null) {
        failures.push(
          `${path}: the loop over earlier responses no longer draws ${
            eachBoundary === null ? "its boundary" : "its work"
          }. Each finished response is a boundary followed by the work under it; if that changed, re-anchor this check.`,
        );
      } else if (eachBoundary > eachWork) {
        failures.push(
          `${path}: inside the loop over earlier responses, LiveActivityView is drawn before the boundary it belongs to. A boundary introduces the work under it — move ItemRowView(item: boundary) above LiveActivityView.`,
        );
      }

      const live = find("LiveActivityView(items: answering.items", source);
      if (live === null) {
        failures.push(
          `${path}: the answering response's LiveActivityView is gone, so nothing pins that its boundary is drawn before the work answering it. Re-anchor this check if the live tail was restructured.`,
        );
      } else if (answering > live) {
        failures.push(
          `${path}: the answering response's work is drawn before its own boundary. The message that opened the response comes first — move the \`if let boundary = answering.boundary\` block above LiveActivityView(items: answering.items.`,
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
