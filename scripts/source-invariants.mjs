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
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

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

/** The one file the per-test ceiling lives in, repo-relative (#740). */
const CEILING_PRELOAD = "scripts/test-ceiling.mjs";

/**
 * Every directory a bunfig.toml would be read from: the repo root and each
 * workspace. Enumerated rather than listed, so a workspace added next year is
 * covered without anyone remembering to come back here.
 */
async function workspaceDirectories() {
  const found = [""];
  for (const group of ["apps", "packages", "workers"]) {
    let entries;
    try {
      entries = await readdir(join(ROOT, group), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "node_modules") found.push(`${group}/${entry.name}`);
    }
  }
  return found;
}

/**
 * The `[test] preload` list of a bunfig, as written. No TOML parser here on
 * purpose: the only shapes in this repo are a one-line array and a multi-line
 * one, and a dependency to read four files would be its own liability.
 */
function testPreloads(source) {
  if (!/^\s*\[test\]\s*$/m.test(source)) return null;
  const list = /(?:^|\n)\s*preload\s*=\s*\[([^\]]*)\]/.exec(source);
  if (!list) return [];
  return [...list[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/**
 * Every `--timeout N` a package's scripts hand to `bun test`.
 *
 * WHAT IS NOT PARSED is the list of test files, and that is deliberate: it was
 * 36 filenames typed out by hand until #763 made it `./*.test.js`, and a check
 * that cared which would have broken on a change that had nothing to do with
 * it. `//`-prefixed keys are this repo's comment convention, not commands —
 * three of them discuss `--timeout` in prose, so reading them would report a
 * flag that does not exist.
 */
function bunTestTimeouts(scripts) {
  const found = [];
  for (const [name, command] of Object.entries(scripts ?? {})) {
    if (name.startsWith("//") || typeof command !== "string") continue;
    if (!/\bbun test\b/.test(command)) continue;
    for (const match of command.matchAll(/--timeout[= ]+([0-9_]+)/g)) {
      found.push({ script: name, ms: Number(match[1].replace(/_/g, "")) });
    }
  }
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
 * THE SPELLINGS OF AN ABSOLUTE SIZE (#721). A digit after the colon is still
 * the whole test — a number is absolute, a property is not — but `.system` is
 * not the only call that takes one, and #674 shipped a guard that knew exactly
 * one spelling. These are the ones that qualify, and the ones that were
 * considered and deliberately left out are recorded below them, because a
 * guard's exclusions are the part people later mistake for oversight.
 *
 * WHAT COUNTS IS "DOES IT SCALE", NOT "IS IT A LITERAL". That distinction
 * decides every row, and it is the one I got wrong first time round: #721 was
 * filed arguing `.custom(_:size:)` probably did not belong because a hard size
 * in a non-system face might be a deliberate type treatment. That reasoning is
 * irrelevant, because Apple's own documentation settles it — see EXCLUDED.
 */
const ABSOLUTE_SIZES = [
  {
    /**
     * `.system(size: 14)`. Whitespace-tolerant now: the #674 pattern required
     * `.system(` and `size:` tight, so `.system (size: 14)` and
     * `.system(size : 14)` both walked straight past it.
     */
    what: ".system(size:)",
    re: /\.system\s*\(\s*size\s*:\s*\d/g,
    uikit: false,
  },
  {
    /**
     * `.custom("Inter", fixedSize: 14)`. Apple: "Create a custom font with the
     * given name and a fixed size that DOES NOT SCALE with Dynamic Type." It
     * is the one `Font.custom` overload that is unambiguously this defect, and
     * the one #721 never thought to name.
     */
    what: ".custom(_:fixedSize:)",
    re: /\.custom\s*\([^()]*,\s*fixedSize\s*:\s*\d/g,
    uikit: false,
  },
  {
    /**
     * `UIFont.systemFont(ofSize: 14)` and its bold/italic/monospaced
     * siblings, all of which end in `ystemFont(ofSize:`. Apple: "Instead of
     * using this method… it's often more appropriate to use
     * preferredFont(forTextStyle:) because that method respects the user's
     * selected content size category."
     */
    what: "UIFont…systemFont(ofSize:)",
    re: /\.\w*[sS]ystemFont\s*\(\s*ofSize\s*:\s*\d/g,
    uikit: true,
  },
  {
    /** `UIFont(name: "Inter", size: 14)` — same, by the other constructor. */
    what: "UIFont(name:size:)",
    re: /\bUIFont\s*\(\s*name\s*:[^()]*\bsize\s*:\s*\d/g,
    uikit: true,
  },
];

/**
 * EXCLUDED, AND ON PURPOSE — these hold a literal and still scale, so adding
 * them would make the guard fire on correct code:
 *
 *   - `.custom("Inter", size: 14)` — Apple: "Create a custom font with the
 *     given name and size that SCALES WITH THE BODY text style." A literal
 *     here is not the defect; it is the seed the system scales from.
 *   - `.custom("Inter", size: 14, relativeTo: .caption)` — the same, against a
 *     style you choose.
 *
 * Also not covered, and not coverable from source text: a literal passed as a
 * call-site ARGUMENT rather than written as a font size, e.g.
 * `ProviderIconView(driver: …, size: 11)` where the view multiplies it into a
 * font internally. No regex over font calls can see those. #718 is the record.
 *
 * `.preferredFont(forTextStyle:)` and `UIFontMetrics` are the UIKit ways to
 * scale, and are what the failure text points at.
 */

/**
 * THE UIKIT CARVE-OUT, deliberately coarse and deliberately LOUD. Wrapping a
 * fixed UIFont in `UIFontMetrics` is the documented way to make it scale, and
 * the wrapper contains the literal:
 *
 *     UIFontMetrics.default.scaledFont(for: .systemFont(ofSize: 17))
 *
 * So a UIKit hit on a line that also says `UIFontMetrics` is skipped. LINE
 * level, not file level, and that choice is the point: a file-level carve-out
 * would let one legitimate `UIFontMetrics` blind a whole file to every other
 * UIKit literal in it, which is a hole. Line level errs the other way — split
 * that call across two lines and the guard fires on correct code. A guard that
 * occasionally asks a question you can answer is worth more than one that
 * quietly stops looking, and the failure text says so.
 *
 * The app uses no UIKit font construction at all today, so this costs nothing
 * now; it exists so that the first one to arrive is noticed.
 */
const UIKIT_SCALING = /UIFontMetrics/;

/** Every absolute-size hit in one source file, already carved out. */
function absoluteSizesIn(source) {
  const hits = [];
  for (const { what, re, uikit } of ABSOLUTE_SIZES) {
    for (const match of source.matchAll(re)) {
      if (uikit) {
        const lineStart = source.lastIndexOf("\n", match.index) + 1;
        let lineEnd = source.indexOf("\n", match.index);
        if (lineEnd === -1) lineEnd = source.length;
        if (UIKIT_SCALING.test(source.slice(lineStart, lineEnd))) continue;
      }
      hits.push(what);
    }
  }
  return hits;
}

/**
 * THE GUARD ABOVE, GUARDED (#721). A check that reports "ok" has proved that
 * it found nothing — which is a different claim from "there is nothing", and
 * the two only coincide while the patterns actually fire. #674's evidence for
 * that was a person pasting an absolute into a file by hand, watching it go
 * red, and taking it out again. That worked once and protects nothing after.
 *
 * So the samples live here and run on every CI pass. Each MUST row is a
 * positive control; each MUST-NOT row is a negative one, and the negatives
 * matter more, because a pattern that is too greedy fires on correct code and
 * the next person's fix is to delete the pattern.
 *
 * If you widen `ABSOLUTE_SIZES`, add both kinds of row here. A new pattern
 * with no sample is a claim with no evidence.
 */
const GUARD_SAMPLES = [
  // Fires: these genuinely do not scale.
  { fires: true, why: "the plain absolute", code: `Text("x").font(.system(size: 14))` },
  { fires: true, why: "space before the paren", code: `Text("x").font(.system (size: 14))` },
  { fires: true, why: "space before the colon", code: `Text("x").font(.system(size : 14))` },
  { fires: true, why: "wrapped onto the next line", code: `Text("x").font(.system(\n    size: 14))` },
  { fires: true, why: "Font.system spelt in full", code: `let f = Font.system(size: 14)` },
  { fires: true, why: "a custom face pinned with fixedSize", code: `Text("x").font(.custom("Inter", fixedSize: 14))` },
  { fires: true, why: "UIKit's system font", code: `label.font = .systemFont(ofSize: 14)` },
  { fires: true, why: "UIKit's bold system font", code: `label.font = .boldSystemFont(ofSize: 14)` },
  { fires: true, why: "UIKit's monospaced system font", code: `label.font = .monospacedSystemFont(ofSize: 14, weight: .regular)` },
  { fires: true, why: "UIKit by font name", code: `label.font = UIFont(name: "Inter", size: 14)` },

  // Silent: these hold a literal and scale anyway. A hit on any of them is the
  // guard failing on correct code, which is worse than the hole it closes.
  { fires: false, why: "custom(_:size:) scales with body", code: `Text("x").font(.custom("Inter", size: 14))` },
  { fires: false, why: "custom(_:size:relativeTo:) scales", code: `Text("x").font(.custom("Inter", size: 14, relativeTo: .caption))` },
  { fires: false, why: "a @ScaledMetric driving the size", code: `Text("x").font(.system(size: glyph))` },
  { fires: false, why: "a fraction of the caller's own box", code: `Text("OC").font(.system(size: size * 0.65))` },
  { fires: false, why: "UIFontMetrics is the scaling path", code: `let f = UIFontMetrics.default.scaledFont(for: .systemFont(ofSize: 17))` },
  { fires: false, why: "the UIKit text-style path", code: `label.font = .preferredFont(forTextStyle: .body)` },
  { fires: false, why: "prose about the sweep", code: `/// was .system(size:) before the sweep` },
];

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
    name: "ios-type-scale-self-test",
    protects: "#721: the absolute-size patterns still fire on what they claim, and stay quiet on correct code",
    async run() {
      const failures = [];
      for (const { fires, why, code } of GUARD_SAMPLES) {
        const hits = absoluteSizesIn(code);
        if (fires && hits.length === 0) {
          failures.push(
            `the guard MISSED a sample it must catch (${why}): ${JSON.stringify(code)}. ` +
              "A pattern in ABSOLUTE_SIZES has stopped matching, so ios-type-scale below is now reporting green " +
              "for a spelling it no longer sees.",
          );
        }
        if (!fires && hits.length > 0) {
          failures.push(
            `the guard FIRED on a sample it must ignore (${why}): ${JSON.stringify(code)} — matched ${hits.join(", ")}. ` +
              "This spelling scales; flagging it makes the guard wrong about correct code, and the next person to " +
              "hit it will delete the pattern rather than argue with it.",
          );
        }
      }
      return failures;
    },
  },
  {
    name: "ios-type-scale",
    protects: "the Dynamic Type sweep (#248, #674, #721): no swept iOS file holds an absolute font size",
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
        const hits = absoluteSizesIn(source);
        if (hits.length === 0) continue;
        const spellings = [...new Set(hits)].join(", ");
        failures.push(
          `${path}: ${hits.length} absolute font size${hits.length === 1 ? "" : "s"} (${spellings}). ` +
            "Use a Dynamic Type style (Theme.captionTiny/caption/footnote/subhead), or — if the number has to survive, " +
            "as it does for a glyph locked in a fixed frame — a named @ScaledMetric seeded with it, which keeps the " +
            "size and still scales; see apps/ios/TelarMobile/Views/ScaledFrame.swift. In UIKit the scaling paths are " +
            "UIFont.preferredFont(forTextStyle:) and UIFontMetrics — if this IS a UIFontMetrics call split across " +
            `lines, put it on one line and the guard will read it correctly.${note ? ` (note on this file: ${note})` : ""}`,
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
   * ONE WAIT FOR THE CHECKOUT, NOT SIX — #706's regression guard.
   *
   * `worktree-ready.ts` was written to be the single answer to "how do you know
   * the cut landed", and its own comment says why: six copies would drift. They
   * did. Two suites grew a private `settled()` with the same loop and the same
   * two-second ceiling, and it was a drifted copy — not the shared helper —
   * that failed under full-suite load, twice in one afternoon.
   *
   * WHY A COPY IS WORSE THAN A WRONG NUMBER. The shared helper's budget is
   * derived from `DEFAULT_GIT_TIMEOUT_MS`, so it moves when the bound it is
   * waiting on moves. A copy freezes whatever the author measured on an idle
   * machine, and the git pool it is waiting on is shared by the whole suite —
   * so the copy's budget is wrong as soon as anyone adds a test. Re-tuning the
   * number only moves the next failure; there has to be one number, and it has
   * to be derived.
   *
   * WHAT IS COUNTED is the shape, not the helper's name: a `for` loop whose
   * body polls `preparation?.state`. A suite that needs to wait imports
   * `worktreeReady`; one that genuinely needs its own bound imports
   * `WORKTREE_READY_TIMEOUT_MS` and says why.
   */
  {
    name: "worktree-wait-is-shared",
    protects: "the wait for a session's checkout (#706): one derived budget, not a copy per suite",
    async run() {
      const failures = [];
      const files = (await readdir(join(ROOT, "apps/engine/test"))).filter((name) => name.endsWith(".ts"));
      for (const name of files) {
        if (name === "worktree-ready.ts") continue;
        const source = await read(join("apps/engine/test", name));
        if (!/preparation\?\.state/.test(source)) continue;
        if (!/for \([^)]*\)\s*\{[\s\S]{0,200}?preparation\?\.state/.test(source)) continue;
        failures.push(
          `apps/engine/test/${name}: this file polls \`preparation?.state\` in its own loop instead of using \`worktreeReady\` from ./worktree-ready. That copy carries its own ceiling, and a fixed ceiling against the suite-wide git pool is what #706 is. Import the shared helper; if you truly need a different bound, import WORKTREE_READY_TIMEOUT_MS and say why.`,
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
   * A WAIT MUST FIT UNDER THE CEILING IT RUNS UNDER — #706's other half.
   *
   * `scripts/test-ceiling.mjs` sets the 20 s ceiling — it was `--timeout 20000`
   * on `apps/engine`'s test script until #740 — and its comment explains the
   * pairing: the per-test `until` / `eventually` helpers hold a smaller
   * wall-clock bound "so a wait can outlast a loaded runner without outlasting
   * the ceiling". The pairing is right. Nothing was checking it.
   *
   * `run-manager.test.ts` had a 15 s helper and capped three of its own tests
   * at 10 s. When the predicate did not come true, bun killed the test at its
   * ceiling while the wait was still running — so the assertion resolved into
   * a dead test and surfaced as "Unhandled error between tests", with the run
   * reporting a timeout and discarding the actual reason. An inverted pair
   * cannot fail honestly, which is worse than failing.
   *
   * WHAT IS COMPARED is the largest default budget a file's own helpers carry
   * against the smallest per-test ceiling that file sets. Equal is a failure
   * too: a wait that ends exactly when the test dies is a coin toss on a
   * loaded machine, which is the condition #706 was filed about.
   *
   * A file with no per-test ceiling is fine — it inherits the suite's 20 s,
   * which every helper here is already well under.
   */
  {
    name: "test-wait-fits-its-ceiling",
    protects: "engine test timeouts (#706): a wait's budget is strictly under the ceiling of the test running it",
    async run() {
      const failures = [];
      const files = (await readdir(join(ROOT, "apps/engine/test"))).filter((name) => name.endsWith(".test.ts"));
      for (const name of files) {
        const source = await read(join("apps/engine/test", name));
        const budgets = [...source.matchAll(/(?:ms|timeoutMs|deadlineMs) = ([0-9_]+)/g)].map((m) => Number(m[1].replace(/_/g, "")));
        const ceilings = [...source.matchAll(/^\}, *([0-9_]+)\);/gm)].map((m) => Number(m[1].replace(/_/g, "")));
        if (budgets.length === 0 || ceilings.length === 0) continue;
        const budget = Math.max(...budgets);
        const ceiling = Math.min(...ceilings);
        if (budget < ceiling) continue;
        failures.push(
          `apps/engine/test/${name}: a wait budget of ${budget}ms runs under a per-test ceiling of ${ceiling}ms. The test dies before the wait can report, so the real reason is discarded and the run only says it timed out. Lower the helper's default below every ceiling in this file, or raise the ceiling above the budget.`,
        );
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

  /**
   * THE CEILING IS REGISTERED WHEREVER TESTS ARE RUN FROM — #740's guard.
   *
   * The per-test ceiling is one `setDefaultTimeout` in scripts/test-ceiling.mjs,
   * reached through `preload` in each bunfig.toml. That makes it configuration,
   * and the history here is entirely configuration failing without a word:
   * #414's `[test] timeout` was ignored for days while everyone believed the
   * engine suite ran at 20 s. Two ways this one rots, both quiet:
   *
   *   - A BUNFIG STOPS LISTING IT, or lists a path that no longer resolves. Bun
   *     reads bunfig.toml only from the directory it was invoked in, so each
   *     workspace's list is a copy, and a copy is a thing that falls out of step.
   *     The suite run from that directory silently drops to bun's 5 s default.
   *
   *   - A `--timeout` FLAG COMES BACK onto a test script carrying a DIFFERENT
   *     number. The flag still works — the preload reads it back off the
   *     operating system and stands aside for it — so the danger is not that it
   *     does nothing, but that one suite runs at a ceiling nobody reproduces by
   *     running the same test any other way, with the difference invisible in the
   *     failure.
   *
   * THE THIRD CASE #740 ASKED THIS TO NOTICE: packages/env and
   * packages/engine-client set no ceiling at all, which is consistent rather than
   * a trap — until someone adds `--timeout` to one of them for a good reason
   * without knowing any of this. The second rule is what has something to say
   * then, and it says it at the moment the flag is added rather than months later
   * in a misread duration.
   *
   * WHAT IS DELIBERATELY NOT CHECKED HERE is the other direction — that the
   * preload cannot silently CLAMP an explicit `--timeout` down to its own
   * ceiling, which is the defect this fix was one edit away from shipping. That
   * claim is about behaviour rather than text, and the only honest check of it is
   * a run: apps/engine/test/test-ceiling.test.ts puts a flag on a child's command
   * line and asserts what the child reported, and both of its cases were
   * confirmed to FAIL against an implementation calling `setDefaultTimeout`
   * unconditionally. A regex here that tried to recognise "does this code clamp"
   * would be satisfiable by code that clamps — the vacuous shape #772 deleted,
   * where a "prove the block ran" grep matched the skipped block's own name.
   */
  {
    name: "test-ceiling-is-registered",
    protects: "#740: every bunfig that runs tests preloads the one ceiling, and no script sets a rival number",
    async run() {
      const failures = [];
      const ceilingSource = await read(CEILING_PRELOAD).catch(() => null);
      if (ceilingSource === null) {
        return [
          `${CEILING_PRELOAD} is missing. It is where the per-test ceiling lives (#740); without it every suite is on ` +
            "bun's 5 s default and the bunfig preloads below point at nothing.",
        ];
      }
      const canonical = /export const TEST_CEILING_MS = ([0-9_]+);/.exec(ceilingSource);
      if (!canonical) {
        return [
          `${CEILING_PRELOAD} no longer declares \`export const TEST_CEILING_MS = <number>\`, so this check cannot read ` +
            "the canonical ceiling and must not pretend the numbers below agree with it. Restore the export, or teach " +
            "this check where the number moved to.",
        ];
      }
      const ceilingMs = Number(canonical[1].replace(/_/g, ""));

      for (const directory of await workspaceDirectories()) {
        const bunfig = directory ? `${directory}/bunfig.toml` : "bunfig.toml";
        const source = await read(bunfig).catch(() => null);
        if (source === null) continue;
        const preloads = testPreloads(source);
        if (preloads === null) continue; // no [test] table: bun reads nothing about tests from here
        const resolved = preloads.map((entry) => relative(ROOT, resolve(join(ROOT, directory), entry)).split("\\").join("/"));
        if (!resolved.includes(CEILING_PRELOAD)) {
          failures.push(
            `${bunfig} has a [test] table but does not preload ${CEILING_PRELOAD}. Tests run from this directory get ` +
              `bun's 5 s default instead of ${ceilingMs}ms, and nothing says so — that is #740 exactly. Add it to the ` +
              "preload list.",
          );
        }
        for (const [index, entry] of resolved.entries()) {
          const exists = await stat(join(ROOT, entry)).then(() => true).catch(() => false);
          if (exists) continue;
          failures.push(
            `${bunfig} preloads ${JSON.stringify(preloads[index])}, which does not exist. Bun fails the run on a ` +
              "missing preload, so this is loud rather than silent — but it is loud in every suite run from here.",
          );
        }
      }

      for (const directory of await workspaceDirectories()) {
        const manifest = directory ? `${directory}/package.json` : "package.json";
        const source = await read(manifest).catch(() => null);
        if (source === null) continue;
        let scripts;
        try {
          scripts = JSON.parse(source).scripts;
        } catch {
          failures.push(`${manifest} is not valid JSON, so this check cannot read its scripts.`);
          continue;
        }
        for (const { script, ms } of bunTestTimeouts(scripts)) {
          if (ms === ceilingMs) continue;
          failures.push(
            `${manifest}: \`${script}\` passes --timeout ${ms}, but the repo's ceiling is ${ceilingMs}ms ` +
              `(${CEILING_PRELOAD}). A flag on a script still works — the preload stands aside for an explicit one — ` +
              `which is exactly why a rival number is a problem: this suite would run at ${ms}ms while the same test ` +
              `run any other way runs at ${ceilingMs}ms, and the difference is invisible in the failure. Match the ` +
              `canonical number, or change it in ${CEILING_PRELOAD}, where every invocation reads it.`,
          );
        }
      }
      return failures;
    },
  },

  /**
   * The standard #721 holds every other scan here to: one that has never been
   * shown to fail has demonstrated nothing. The shapes that matter are the two
   * the desktop script has actually had — 36 hand-typed filenames before #763
   * and a glob after — and the `//` comment keys, three of which discuss
   * `--timeout` in prose and would otherwise be read as commands.
   */
  {
    name: "test-ceiling-scan-self-test",
    protects: "#740: the script scan still sees a flag through either desktop shape, and ignores prose about one",
    async run() {
      const samples = [
        { expect: [20_000], why: "the glob shape (#763)", scripts: { t: "bun test --timeout 20000 ./*.test.js" } },
        { expect: [20_000], why: "the hand-listed shape it replaced", scripts: { t: "bun test --timeout 20000 ./a.test.js ./b.test.js" } },
        { expect: [20_000], why: "the = spelling", scripts: { t: "bun test --timeout=20000" } },
        { expect: [5_000], why: "a rival number", scripts: { t: "bun test --timeout 5000" } },
        { expect: [], why: "an env prefix and no flag", scripts: { t: "NODE_ENV=test bun test" } },
        { expect: [], why: "a bare run", scripts: { t: "bun test" } },
        { expect: [], why: "delegation to another script", scripts: { t: "bun run test:desktop:unit" } },
        { expect: [], why: "an electron suite", scripts: { t: "env -u ELECTRON_RUN_AS_NODE electron ./x.electron-test.js" } },
        { expect: [], why: "prose in a // comment key", scripts: { "//t": "--timeout IS THE ONLY WAY, bun test aside" } },
        { expect: [], why: "node's runner rather than bun's", scripts: { t: "node --test workers/push-relay/worker.test.mjs" } },
      ];
      const failures = [];
      for (const { expect: wanted, why, scripts } of samples) {
        const got = bunTestTimeouts(scripts).map((hit) => hit.ms);
        if (JSON.stringify(got) === JSON.stringify(wanted)) continue;
        failures.push(
          `the scan read ${JSON.stringify(got)} where ${JSON.stringify(wanted)} was right (${why}): ` +
            `${JSON.stringify(Object.values(scripts)[0])}.`,
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
