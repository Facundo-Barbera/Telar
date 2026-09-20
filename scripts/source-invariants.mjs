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
 * WHAT IS COUNTED IS A DIGIT, NOT THE CALL. `.system(size:` followed by a
 * number is an absolute size. `.system(size: someProperty)` is not: it is a
 * `@ScaledMetric`, or a fraction of a caller's own box, and both of those
 * move when the reader's text does. Until #674 the check counted the string
 * and could not tell the two apart, so a swept file carried a non-zero pin
 * and a paragraph explaining that the number did not mean what it said. It
 * now means what it says.
 *
 * SO EVERY PIN IS ZERO, AND THAT IS THE WHOLE RULE. #674 scaled the frames
 * the sweep had to defer to — a glyph in a box fixed in both dimensions —
 * which was the only standing reason for a swept file to keep an absolute.
 * There is no longer a good one. If you need a literal point size for a
 * genuine reason, the answer is a named `@ScaledMetric` seeded with it (see
 * `ScaledFrame.swift`), which keeps the number, scales it, and passes here.
 *
 * WHAT "REMAINING" MEANS, because three different figures were circulating
 * on the day this was written and all three were arithmetically correct:
 *
 *     the queue = UNSWEPT APP SOURCE ONLY
 *
 * Excluded, and each excluded for its own reason:
 *   - files listed below. They are swept, and now provably so.
 *   - anything under `apps/ios/DerivedData/`. Vendored checkouts — at the
 *     time of writing swift-markdown-ui contributes ten hits that are not
 *     ours to convert and never will be.
 *   - `.system(size:)` inside comments and doc comments. `Theme.swift` and
 *     `TypeScaleTests.swift` between them hold four, written as prose about
 *     the sweep rather than as calls — and two of them DO carry a digit, in
 *     worked before/after examples. They are excluded because neither file is
 *     listed below, not because the digit rule is clever enough to see them.
 *     If either file is ever added to the list, those examples trip it.
 *
 * A raw `grep -rc '\.system(size:' apps/ios` counts all of it and answers a
 * question nobody asked. If you are re-deriving the queue, subtract them.
 */
const SWEPT_FILES = [
  ["apps/ios/TelarMobile/Views/TranscriptViews.swift", ""],
  ["apps/ios/TelarMobile/Views/SessionView.swift", ""],
  ["apps/ios/TelarMobile/Views/Panel/NotebookSurface.swift", ""],
  ["apps/ios/TelarMobile/Views/Panel/CellOutputView.swift", ""],
  ["apps/ios/TelarMobile/Views/DiffView.swift", ""],
  ["apps/ios/TelarMobile/Views/Panel/FilesSurface.swift", ""],
  ["apps/ios/TelarMobile/Views/SessionSidebar.swift", ""],
  ["apps/ios/TelarMobile/Views/AgentModelPickerSheet.swift", ""],
  ["apps/ios/TelarMobile/Views/InboxView.swift", ""],
  ["apps/ios/TelarMobile/Views/RequestViews.swift", ""],
  ["apps/ios/TelarMobile/Views/Panel/LatexSurface.swift", ""],
  ["apps/ios/TelarMobile/Views/Panel/DataSurface.swift", ""],
  ["apps/ios/TelarMobile/Views/NewSessionView.swift", ""],
  ["apps/ios/TelarMobile/Views/AddProjectView.swift", ""],
  ["apps/ios/TelarMobile/Views/BranchPickerSheet.swift", ""],
  ["apps/ios/TelarMobile/Views/SettingsKit.swift", ""],
  ["apps/ios/TelarMobile/Views/DevicesView.swift", ""],
  ["apps/ios/TelarMobile/Views/UsageView.swift", ""],
  ["apps/ios/TelarMobile/Views/Panel/TextFileView.swift", ""],
  [
    "apps/ios/TelarMobile/Views/WelcomeView.swift",
    "holds one `.system(size: wordmark)` that this check does NOT count, and should not: `wordmark` is a @ScaledMetric(relativeTo: .largeTitle) seeded with 40. 40 has no rung (the ramp stops at 34) and mapping it down would shrink the brand. #674 gave TelarMark the same treatment so the logo and the word keep their ratio",
  ],
  ["apps/ios/TelarMobile/Views/Panel/TableSurface.swift", ""],
  [
    "apps/ios/TelarMobile/Views/ProjectAvatar.swift",
    "holds four `.system(size:)` calls this check does NOT count: each is a fraction of the caller's `size`, so the glyph is proportional to its own square by construction. They were never waiting on #674 and are finished as they stand — this entry is the only record of that, since no digit regex will re-find them",
  ],
  ["apps/ios/TelarMobile/Views/Panel/PanelView.swift", ""],
  ["apps/ios/TelarMobile/Views/Panel/FileBody.swift", ""],
  ["apps/ios/TelarMobile/Views/StashMenu.swift", ""],
  ["apps/ios/TelarMobile/Views/Panel/AgentsSurface.swift", ""],
  ["apps/ios/TelarMobile/Views/AttachmentChip.swift", ""],
  [
    "apps/ios/TelarMobile/Views/ModelPill.swift",
    "holds one `.system(size: size * 0.65)` this check does NOT count, proportional to its own square like ProjectAvatar's. The pill's capsule takes a @ScaledMetric of its own (#674) so the badge grows with the label beside it",
  ],
  ["apps/ios/TelarMobile/Views/Panel/HtmlOutputView.swift", ""],
  ["apps/ios/TelarMobile/Views/DictationSettingsView.swift", ""],
  ["apps/ios/TelarMobile/Views/DictationCaretPill.swift", ""],
  ["apps/ios/TelarMobile/Views/AgentSettingsView.swift", ""],
  ["apps/ios/TelarMobile/Views/MarkdownText.swift", ""],
  // Not a view: a `Font` stored on the highlighter's theme, which is why it
  // is the one swept file outside `Views/`. A count scoped to `Views/` misses
  // it — the sweep's last site was very nearly its least visible.
  ["apps/ios/TelarMobile/Stores/CodeHighlighter.swift", ""],
  ["apps/ios/TelarMobile/Views/ScaledFrame.swift", ""],
];

/**
 * `.system(size:` followed by a digit. The digit is the whole test: a number
 * is absolute, a property is not. Global so `String.match` returns every hit
 * rather than the first — `match` resets `lastIndex` itself, so sharing one
 * compiled regex across files is safe here in a way `test` would not be.
 */
const ABSOLUTE_SIZE = /\.system\(\s*size:\s*\d/g;

const CHECKS = [
  {
    name: "ios-type-scale",
    protects: "the Dynamic Type sweep (#248, #674): no swept iOS file holds an absolute font size",
    async run() {
      const failures = [];
      for (const [path, note] of SWEPT_FILES) {
        let source;
        try {
          source = await read(path);
        } catch {
          failures.push(`${path}: listed as swept but the file is missing — was it moved or renamed?`);
          continue;
        }
        const found = (source.match(ABSOLUTE_SIZE) ?? []).length;
        if (found === 0) continue;
        failures.push(
          `${path}: ${found} absolute font size${found === 1 ? "" : "s"}. A .system(size: <number>) came back. ` +
            "Use a Dynamic Type style (Theme.captionTiny/caption/footnote/subhead), or — if the number has to survive, " +
            "as it does for a glyph locked in a fixed frame — a named @ScaledMetric seeded with it, which keeps the " +
            `size and still scales. See apps/ios/TelarMobile/Views/ScaledFrame.swift.${note ? ` (note on this file: ${note})` : ""}`,
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
