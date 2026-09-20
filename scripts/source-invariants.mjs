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
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(join(ROOT, path), "utf8");

/**
 * Every test file under a directory, repo-relative, POSIX-separated.
 *
 * BUILD OUTPUTS ARE SKIPPED, and not as tidiness: `release/` and `.next-desktop/`
 * hold COPIES of web source with the tests included, so a check that swept them
 * would report the same file twice — once as itself and once as a stale artefact
 * nobody can fix — which is why both bunfig.toml files exclude exactly these from
 * the test run too.
 */
async function testFilesUnder(directory) {
  const found = [];
  const walk = async (relative) => {
    let entries;
    try {
      entries = await readdir(join(ROOT, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "release" || entry.name.startsWith(".next")) continue;
        await walk(next);
      } else if (/\.test\.tsx?$/.test(entry.name)) {
        found.push(next);
      }
    }
  };
  await walk(directory);
  return found;
}

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

/** Views whose every glyph is a fraction of the `size:` their caller passes. */
const PROPORTIONAL_MARKS = ["ProjectAvatar", "ProviderIconView"];

/**
 * Every `size:` argument handed to one of those views as a LITERAL. Walks the
 * call with a paren counter rather than a character class, so a nested call in
 * an earlier argument cannot end the scan early.
 */
function markSizeArguments(source) {
  const found = [];
  for (const name of PROPORTIONAL_MARKS) {
    let from = 0;
    for (;;) {
      const at = source.indexOf(`${name}(`, from);
      if (at === -1) break;
      const open = at + name.length;
      from = open;
      let depth = 0;
      let close = -1;
      for (let i = open; i < source.length; i += 1) {
        if (source[i] === "(") depth += 1;
        else if (source[i] === ")") {
          depth -= 1;
          if (depth === 0) {
            close = i;
            break;
          }
        }
      }
      if (close === -1) continue;
      const args = source.slice(open + 1, close);
      const size = args.match(/\bsize:\s*([^,]+?)\s*(?:,|$)/);
      if (!size || !/^\d/.test(size[1])) continue;
      found.push({
        name,
        value: size[1],
        line: source.slice(0, at).split("\n").length,
      });
    }
  }
  return found;
}

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
  /**
   * A TEST THAT TAKES THE GLOBAL DOM MUST GIVE IT BACK — #719's landmine.
   *
   * WHY THIS DEFECT IS SILENT, which is the whole reason it needs a machine and
   * not a reviewer. `GlobalRegistrator.register` is PROCESS-WIDE and throws on a
   * second call, and bun runs every `apps/web` test file in one process. So a
   * file that registers happy-dom and never unregisters does not fail: the NEXT
   * file to register dies, with `Failed to register. Happy DOM has already been
   * globally registered.` and no failing assertion anywhere to explain it. The
   * blame lands on whichever file bun happened to load afterwards — its author
   * reads a green local run of their own file and a red CI log about a global
   * they never touched.
   *
   * IT ALSO HIDES FROM ITS OWN PULL REQUEST. #719 introduced exactly this and
   * passed, because at that moment nothing registered after it in bun's ordering.
   * It detonated on the next branch to add a DOM test — a branch whose diff did
   * not contain the bug. Nothing about that is discoverable by reading either
   * diff, which is what makes it an invariant rather than a review note.
   *
   * WHY HERE AND NOT IN A LINT RULE OR THE TEST GUIDANCE: #691's lesson. The
   * wash contract lived in prose and in a stylesheet test that never looked at
   * the call sites, so a violating call site survived for months. A convention
   * written down is not enforcement; `bun run check:source` is, and verify.yml
   * runs it on every pull request.
   */
  {
    name: "web-test-dom-release",
    protects:
      "the web suite's shared process (#719): a test file that registers happy-dom also unregisters it",
    async run() {
      const files = await testFilesUnder("apps/web");
      const registers = [];
      const unbalanced = [];
      for (const path of files) {
        const source = await read(path);
        if (!/GlobalRegistrator\s*\.\s*register\s*\(/.test(source)) continue;
        registers.push(path);
        if (!/GlobalRegistrator\s*\.\s*unregister\s*\(/.test(source)) unbalanced.push(path);
      }

      /**
       * NON-VACUITY FIRST, because the failure this check is most likely to
       * suffer is the one it exists to catch, pointed the other way: a walk or a
       * pattern that quietly stops matching sweeps nothing, finds nothing wrong,
       * and reports `ok` forever. An empty result is a claim, and it needs a
       * positive control — so the check refuses to pass unless it can still see
       * the corpus it is about. (Measured when written: 270 test files under
       * apps/web, 32 of them registering.)
       */
      if (files.length === 0) {
        return [
          "apps/web: found no *.test.ts(x) files at all, so this check swept nothing and proved nothing. The walk in testFilesUnder has stopped matching — fix it in scripts/source-invariants.mjs rather than trusting the pass.",
        ];
      }
      if (registers.length === 0) {
        return [
          `apps/web: scanned ${files.length} test files and found none that call GlobalRegistrator.register, which cannot be true while this app has DOM tests. Either the call was renamed or the pattern here has rotted; either way this check is now vacuous and must be re-anchored, not removed.`,
        ];
      }

      return unbalanced.map(
        (path) =>
          `${path}: registers happy-dom and never unregisters it. Add \`afterAll(async () => { await GlobalRegistrator.unregister(); });\` — the registration is process-wide, so the file this breaks is the NEXT one to register, not this one, and the error it throws names that file instead. ${registers.length - unbalanced.length} other file${registers.length - unbalanced.length === 1 ? "" : "s"} in apps/web already pair the two.`,
      );
    },
  },
  /**
   * A MARK IS THE SIZE OF THE LINE IT LABELS — the call-site literal (#718).
   *
   * `ProjectAvatar` and `ProviderIconView` are both proportional to the `size`
   * they are handed: every glyph inside them is a fraction of that number, so
   * they are correct at any size and #674 rightly left them alone. The literal
   * is not inside them. It is in the CALLER, as an argument:
   *
   *     ProviderIconView(driver: row.session.driver, size: 11)
   *
   * The row's text scales; that 11 does not; the mark stops being the size of
   * the line it labels. #718 filed this and said in as many words that
   * `source-invariants.mjs` could never catch it, "because the literal is a
   * call-site argument rather than a font size, so no regex over font calls
   * will ever see it". That was true of a regex over FONT calls and false as a
   * general claim — a regex over THESE calls sees it perfectly well. The gap
   * was in where the guard was looking, not in what is knowable from source.
   *
   * SO IT IS NARROW ON PURPOSE. It knows two view names, and it will not
   * generalise to "any view taking a size:" — that would flag every deliberate
   * fixed-size caller in the app and be deleted within a week. Two names, both
   * proportional by construction, both drawn beside text. Add a third only
   * when a third genuinely has this shape.
   *
   * PAREN-BALANCED rather than regex-matched, because the first version of
   * this scan used `[^)]*` and silently missed four of the seven sites: these
   * calls contain nested calls (`api: settings.api(for: row.hostId)`), and the
   * character class stopped at the inner `)`. The miss looked exactly like a
   * clean result.
   */
  {
    name: "ios-mark-sizes",
    protects: "#718: a project or provider mark is never pinned to a literal at its call site",
    async run() {
      const failures = [];
      for (const [path] of SWEPT_FILES) {
        let source;
        try {
          source = await read(path);
        } catch {
          continue; // the type-scale check above already reports a missing file
        }
        for (const { line, name, value } of markSizeArguments(source)) {
          failures.push(
            `${path}:${line}: ${name}(… size: ${value}) is pinned to a literal. Both views are proportional to the ` +
              "size they are given, so the caller decides whether the mark scales — and a hard number means it does " +
              "not, while the text beside it does. Give it a @ScaledMetric relative to the style of the text it sits " +
              "next to (not one shared reference: a mark tracks its own line). See SessionSidebar.swift.",
          );
        }
      }
      return failures;
    },
  },
  /**
   * The same standard #721 holds the font patterns to: a scan that has never
   * been shown to fail has demonstrated nothing. The nested-call sample is the
   * one that matters — it is the exact shape that defeated the first attempt.
   */
  {
    name: "ios-mark-sizes-self-test",
    protects: "#718: the mark-size scan still sees a literal through a nested call, and ignores a scaled one",
    async run() {
      const samples = [
        { fires: true, why: "the plain literal", code: `ProviderIconView(driver: d, size: 11)` },
        {
          fires: true,
          why: "a literal behind a nested call — the shape that defeated the first scan",
          code: `ProjectAvatar(name: p.name, api: settings.api(for: row.hostId), size: 13)`,
        },
        { fires: true, why: "spaced out", code: `ProviderIconView( driver: d , size:  12 )` },
        { fires: false, why: "a @ScaledMetric", code: `ProviderIconView(driver: d, size: badge)` },
        { fires: false, why: "a scaled metric behind a nested call", code: `ProjectAvatar(api: settings.api(for: h), size: slimProjectMark)` },
        { fires: false, why: "a computed size", code: `ProviderIconView(driver: d, size: box * 0.5)` },
        { fires: false, why: "some other view's literal size", code: `SomeOtherThing(size: 11)` },
      ];
      const failures = [];
      for (const { fires, why, code } of samples) {
        const hits = markSizeArguments(code);
        if (fires && hits.length === 0) {
          failures.push(`the scan MISSED a sample it must catch (${why}): ${JSON.stringify(code)}.`);
        }
        if (!fires && hits.length > 0) {
          failures.push(
            `the scan FIRED on a sample it must ignore (${why}): ${JSON.stringify(code)}. ` +
              "Flagging a scaled size makes the check wrong about correct code.",
          );
        }
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
