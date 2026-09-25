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
import { engineTestFiles, shardOf } from "./engine-shard.mjs";

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

/** The one file an engine test's wait budget lives in, repo-relative (#760). */
const SHARED_WAIT_MODULE = "apps/engine/test/wait.ts";

/**
 * One engine test file's wait budget against its own tightest per-test ceiling,
 * or `null` when the pair is sound or there is nothing to compare.
 *
 * Pure, and separate from the check that walks the tree, so the samples proving
 * it fires live in a check of their own rather than in a paragraph.
 */
function waitBudgetFailure(name, source, sharedBudgetMs) {
  const budgets = [...source.matchAll(/(?:ms|timeoutMs|deadlineMs) = ([0-9_]+)/g)].map((m) => Number(m[1].replace(/_/g, "")));
  const importsShared = /from "\.\/wait"/.test(source);
  if (importsShared) budgets.push(sharedBudgetMs);
  const ceilings = [...source.matchAll(/^\}, *([0-9_]+)\);/gm)].map((m) => Number(m[1].replace(/_/g, "")));
  if (budgets.length === 0 || ceilings.length === 0) return null;
  const budget = Math.max(...budgets);
  const ceiling = Math.min(...ceilings);
  if (budget < ceiling) return null;
  const whose = budget === sharedBudgetMs && importsShared ? ` (${SHARED_WAIT_MODULE}'s WAIT_BUDGET_MS)` : "";
  return (
    `apps/engine/test/${name}: a wait budget of ${budget}ms${whose} runs under a per-test ceiling of ${ceiling}ms. ` +
    "The test dies before the wait can report, so the real reason is discarded and the run only says it timed out. " +
    "Lower the budget below every ceiling in this file, or raise the ceiling above the budget."
  );
}

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
  for (const { script, command } of bunTestScripts(scripts)) {
    for (const match of command.matchAll(/--timeout[= ]+([0-9_]+)/g)) {
      found.push({ script, ms: Number(match[1].replace(/_/g, "")) });
    }
  }
  return found;
}

/**
 * The scripts that actually invoke bun's test runner — the same reading
 * `bunTestTimeouts` does, minus the flag, so "carries a rival number" and
 * "carries no number at all" are answered off one notion of what a test script
 * is. A script that delegates to another (`bun run test:desktop:unit`) is not
 * one of these: the ceiling belongs on the script that runs bun test.
 */
function bunTestScripts(scripts) {
  const found = [];
  for (const [name, command] of Object.entries(scripts ?? {})) {
    if (name.startsWith("//") || typeof command !== "string") continue;
    if (!/\bbun test\b/.test(command)) continue;
    found.push({ script: name, command });
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

/**
 * EVERY SHELL SCRIPT IN THE TREE, repo-relative. Same exclusions as
 * `testFilesUnder` and for the same reason: `release/` and `.next-desktop/`
 * hold copies of source nobody can fix in place.
 */
async function shellFiles() {
  const found = [];
  const walk = async (from) => {
    let entries;
    try {
      entries = await readdir(join(ROOT, from), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = from ? `${from}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "release" || entry.name === ".git") continue;
        if (entry.name.startsWith(".next")) continue;
        await walk(next);
      } else if (entry.name.endsWith(".sh")) {
        found.push(next);
      }
    }
  };
  await walk("");
  return found.sort();
}

/** Does this script opt into `set -u`, where an empty array becomes fatal? */
const enablesNounset = (source) => /^\s*set\s+(-[a-zA-Z]*u|-o\s+nounset)/m.test(source);

/**
 * ARRAY EXPANSIONS THAT ARE NOT GUARDED AGAINST THE EMPTY CASE (#808).
 *
 * Under `set -u`, bash 3.2 — the 3.2.57 macOS ships as /bin/bash — treats
 * `"${A[@]}"` on an EMPTY array as an unbound variable and kills the script.
 * Bash 4.4 stopped doing it, so the failure is invisible to anyone with a
 * Homebrew bash earlier on PATH, and a script can carry it for years.
 *
 * Safe, and therefore not reported:
 *   `${#A[@]}`             a count, never unbound
 *   `${A[@]+"${A[@]}"}`    the portable guard — nothing when empty, the
 *                          elements with their quoting when not
 *   `${A[*]-}` `${A[@]:-}` the same thing for a `[*]` inside a message string
 *
 * The scan skips a guarded construct WHOLE, brace-matched, because the guard
 * contains a second copy of the bare expansion inside itself — counting that
 * copy would flag every correctly-written line in the repo.
 *
 * A `run:` block in `.github/workflows/*.yml` is scanned by the same two
 * questions, via `workflowRunBlocks` below. It used to be excluded, with a
 * comment here saying the blocks that set `-u` had been checked and expanded
 * only arrays a count had proven non-empty. That was not true when it was
 * written: `nightly-ios.yml` and `ios-export-probe.yml` each set `-euo` and
 * then expanded a bare `"${EXISTING[@]}"` read from `security list-keychains`
 * (#829). The comment is the reason nobody looked again, so the scan now looks
 * instead of the comment claiming it did.
 */
function unguardedArrayExpansions(source) {
  const hits = [];
  source.split("\n").forEach((line, index) => {
    if (line.trimStart().startsWith("#")) return; // a comment, including this file's own prose
    for (let i = 0; i < line.length; i += 1) {
      if (!line.startsWith("${", i)) continue;
      const opened = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\[([@*])\]/.exec(line.slice(i));
      if (!opened) continue;
      const after = line[i + opened[0].length];
      if (after === "}") {
        hits.push({ line: index + 1, name: opened[1], text: line.trim() });
        continue;
      }
      // Guarded: jump past the whole `${A[@]+…}` so the copy nested in it is
      // not read as a bare expansion of its own.
      let depth = 0;
      let end = i;
      for (let j = i; j < line.length; j += 1) {
        if (line.startsWith("${", j)) {
          depth += 1;
          j += 1;
          continue;
        }
        if (line[j] === "}") {
          depth -= 1;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      i = end;
    }
  });
  return hits;
}

const WORKFLOWS = ".github/workflows";

/** Every workflow definition, repo-relative. */
async function workflowFiles() {
  let entries;
  try {
    entries = await readdir(join(ROOT, WORKFLOWS), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")))
    .map((entry) => `${WORKFLOWS}/${entry.name}`)
    .sort();
}

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * Which interpreter a `run:` block gets, as GitHub resolves it.
 *
 * Absent `shell:` means `bash -e {0}` — `-e`, NOT `-u`, so a block only has
 * nounset if it says so itself. A block that names some other interpreter has
 * no bash arrays to get wrong, so it is not this check's business.
 */
const runsBash = (shell) => {
  if (shell === null) return true; // GitHub's default for a `run:` step
  const named = shell.trim().replace(/^["']|["']$/g, "").split(/\s+/)[0];
  return named === "bash" || named === "sh";
};

/**
 * The `run:` blocks of a workflow, each body line carrying the line number it
 * really has in the file so a failure names somewhere a person can open.
 *
 * `shell:` is a sibling key of `run:` in the same step mapping, so it is looked
 * for at EXACTLY the `run:` indent and only within the step — bounded by the
 * next or previous line that is shallower, or by the `- ` that starts a step.
 * Requiring the exact indent is also what stops `echo "shell: pwsh"` inside a
 * body, which is necessarily deeper, from being read as the step's shell.
 */
function workflowRunBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];

  const shellFor = (at, keyIndent) => {
    const leavesStep = (j) => {
      const raw = lines[j];
      if (raw.trim() === "") return false;
      return indentOf(raw) < keyIndent || raw.trimStart().startsWith("- ");
    };
    const declared = (j) => {
      const found = /^(\s*)shell:\s*(.+?)\s*$/.exec(lines[j]);
      return found && found[1].length === keyIndent ? found[2] : null;
    };
    for (let j = at - 1; j >= 0 && !leavesStep(j); j -= 1) {
      const found = declared(j);
      if (found !== null) return found;
    }
    for (let j = at + 1; j < lines.length && !leavesStep(j); j += 1) {
      const found = declared(j);
      if (found !== null) return found;
    }
    return null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const opened = /^(\s*)run:[ \t]*(?:[|>][-+]?\d*)?[ \t]*(.*)$/.exec(lines[i]);
    if (!opened) continue;
    const keyIndent = opened[1].length;
    const body = [];
    if (opened[2].trim() !== "") {
      body.push({ line: i + 1, text: opened[2] });
    } else {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim() === "") {
          body.push({ line: j + 1, text: "" });
          continue;
        }
        if (indentOf(lines[j]) <= keyIndent) break;
        body.push({ line: j + 1, text: lines[j] });
      }
    }
    blocks.push({ line: i + 1, shell: shellFor(i, keyIndent), body });
  }
  return blocks;
}

/**
 * The unguarded expansions in a `run:` block, reported at their file line.
 *
 * A block with no nounset is not scanned at all, and says so by returning null
 * rather than an empty list — the caller counts what it actually looked at, so
 * that "found nothing" and "looked at nothing" cannot be confused.
 */
function workflowBlockHits(block) {
  if (!runsBash(block.shell)) return null;
  const text = block.body.map((entry) => entry.text).join("\n");
  if (!enablesNounset(text)) return null;
  return unguardedArrayExpansions(text).map((hit) => ({ ...hit, line: block.body[hit.line - 1].line }));
}

const ARRAY_GUARD_SAMPLES = [
  { flags: true, why: "the #808 line as it was", code: 'bunx electron-builder --dir "${CONFIG_OVERRIDES[@]}"' },
  { flags: true, why: "a `[*]` in a message string is unbound on 3.2 too", code: 'log "--mac ${TARGET_ARGS[*]}"' },
  { flags: true, why: "an unquoted bare expansion is no safer", code: "for a in ${ARTIFACTS[@]}; do :; done" },
  { flags: false, why: "the portable guard", code: 'bunx electron-builder ${CONFIG_OVERRIDES[@]+"${CONFIG_OVERRIDES[@]}"}' },
  { flags: false, why: "the `-` guard for a string context", code: 'log "--mac ${TARGET_ARGS[*]-}"' },
  { flags: false, why: "a count is never unbound", code: 'if [ "${#ARTIFACTS[@]}" -gt 0 ]; then :; fi' },
  { flags: false, why: "positional parameters are special-cased by bash", code: 'install "$@"' },
  { flags: false, why: "a single element is not the empty-array case", code: 'echo "${ARTIFACTS[0]}"' },
  { flags: false, why: "prose in a comment", code: '# `"${A[@]}"` is what broke; see #808' },
];

/**
 * THE WORKFLOW READER, ON WORKFLOWS SMALL ENOUGH TO COUNT BY EYE.
 *
 * `hits` is `line:NAME` at the line number of the SAMPLE, so a reader that
 * reports the right variable at the wrong line fails here rather than sending
 * somebody to a line that says nothing. `scanned` is how many blocks the reader
 * should have looked at at all — the number the real check's non-vacuity rule
 * rests on, and the one a mishandled `shell:` would quietly change.
 */
const WORKFLOW_BLOCK_SAMPLES = [
  {
    why: "the #829 shape: a `run:` block that opts into -u and then expands a bare array",
    hits: ["7:EXISTING"],
    scanned: 1,
    yaml: [
      "jobs:",
      "  sign:",
      "    steps:",
      "      - name: Import",
      "        run: |",
      "          set -euo pipefail",
      '          security list-keychains -d user -s "$KEYCHAIN" "${EXISTING[@]}"',
    ],
  },
  {
    why: "the same block once guarded",
    hits: [],
    scanned: 1,
    yaml: [
      "jobs:",
      "  sign:",
      "    steps:",
      "      - name: Import",
      "        run: |",
      "          set -euo pipefail",
      '          security list-keychains -d user -s "$KEYCHAIN" ${EXISTING[@]+"${EXISTING[@]}"}',
    ],
  },
  {
    why: "GitHub's default shell is `bash -e {0}` — -e, not -u — so a block that never says `set -u` is not this check's business",
    hits: [],
    scanned: 0,
    yaml: [
      "jobs:",
      "  sign:",
      "    steps:",
      "      - name: Import",
      "        run: |",
      '          security list-keychains -d user -s "$KEYCHAIN" "${EXISTING[@]}"',
    ],
  },
  {
    why: "another interpreter has no bash arrays to get wrong",
    hits: [],
    scanned: 0,
    yaml: [
      "jobs:",
      "  sign:",
      "    steps:",
      "      - name: Import",
      "        shell: pwsh",
      "        run: |",
      "          set -euo pipefail",
      '          echo "${EXISTING[@]}"',
    ],
  },
  {
    why: "`shell:` governs its step from either side of the `run:` it belongs to",
    hits: [],
    scanned: 0,
    yaml: [
      "jobs:",
      "  sign:",
      "    steps:",
      "      - name: Import",
      "        run: |",
      "          set -euo pipefail",
      '          echo "${EXISTING[@]}"',
      "        shell: python",
    ],
  },
  {
    why: "a body line TALKING about a shell is not the step's shell",
    hits: ["8:EXISTING"],
    scanned: 1,
    yaml: [
      "jobs:",
      "  sign:",
      "    steps:",
      "      - name: Import",
      "        run: |",
      "          set -euo pipefail",
      '          echo "shell: pwsh"',
      '          echo "${EXISTING[@]}"',
    ],
  },
  {
    why: "the next step's `shell:` does not reach back over the step boundary",
    hits: ["7:EXISTING"],
    scanned: 1,
    yaml: [
      "jobs:",
      "  sign:",
      "    steps:",
      "      - name: One",
      "        run: |",
      "          set -euo pipefail",
      '          echo "${EXISTING[@]}"',
      "      - name: Two",
      "        shell: pwsh",
      "        run: echo hi",
    ],
  },
  {
    why: "a one-line `run:` is a block too, and is read without crashing on its missing body",
    hits: [],
    scanned: 0,
    yaml: ["jobs:", "  sign:", "    steps:", "      - name: One", "        run: apps/ios/nightly.sh"],
  },
];

/**
 * EVERY SYNCHRONOUS CHILD WAIT IN A SOURCE TEXT, with the text of its argument
 * list — #807.
 *
 * WHY A BALANCED-PAREN READ AND NOT A LINE REGEX: the call this exists for
 * spans six lines and the part being looked for is the options object at the
 * end of them. A per-line scan would see the opening line of every real call
 * site and none of their options.
 *
 * BOTH SPELLINGS, ONE HIT EACH. `spawnSync(` and `Bun.spawnSync(` are the two
 * the engine suite uses; the lookbehind is what stops the second being counted
 * twice, and stops `mySpawnSync(` being counted at all.
 */
function syncSpawnCalls(source) {
  const calls = [];
  const pattern = /(?<![\w$.])(?:Bun\.)?spawnSync\s*\(/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) continue;
    const args = source.slice(open + 1, end);
    calls.push({
      line: source.slice(0, match.index).split("\n").length,
      call: match[0].slice(0, -1).trim(),
      bounded: /\btimeout\s*:/.test(args),
      forceful: /\bkillSignal\s*:\s*"SIGKILL"/.test(args),
    });
  }
  return calls;
}

/**
 * The shapes that matter, held to #721's standard: a scan never shown to fail
 * has demonstrated nothing. The first three are the engine suite's own call
 * sites before #807 and after it; the rest are the ways a line scan gets this
 * wrong — an options object several lines below the call, a nested call inside
 * the arguments, and two names that merely end in the same letters.
 */
const SYNC_SPAWN_SAMPLES = [
  { flags: true, why: "the bare node call as latex-managed had it", code: `const made = spawnSync("tar", ["-czf", archive]);` },
  { flags: true, why: "the bare Bun call as project-identity had it", code: `Bun.spawnSync(["git", ...args], { cwd: checkout });` },
  { flags: true, why: "a timeout with a polite signal is still a process that may not answer", code: `spawnSync("tar", [], { timeout: 5_000 });` },
  { flags: true, why: "a killSignal with no ceiling never fires at all", code: `spawnSync("tar", [], { killSignal: "SIGKILL" });` },
  { flags: false, why: "the bounded node call", code: `spawnSync("tar", ["-czf", archive], { timeout: 5_000, killSignal: "SIGKILL" });` },
  { flags: false, why: "the bounded Bun call", code: `Bun.spawnSync(["git", ...args], { cwd: checkout, timeout: 5_000, killSignal: "SIGKILL" });` },
  {
    flags: false,
    why: "options several lines below the call, with a nested call in the arguments — the shape a line scan misses",
    code: `const run = spawnSync(process.execPath, ["test", ...(flag ? ["--timeout", flag] : [])], {\n  cwd: REPO_ROOT,\n  timeout: budgetMs,\n  killSignal: "SIGKILL",\n});`,
  },
  { flags: false, why: "a different function that merely ends the same way", code: `mySpawnSync("tar", []);` },
  { flags: false, why: "the async spawn, which no ceiling problem applies to", code: `spawn("tar", ["-czf", archive]);` },
  { flags: false, why: "the import, which is not a call", code: `import { spawnSync } from "node:child_process";` },
];

/**
 * THE ONE PUSH IN THIS ENGINE MAY ONLY EVER APPEND — issue #670.
 *
 * `pushSessionBranch` is the first subprocess here that leaves the machine, and
 * `git.ts`'s header argues it is inside the "additive and recoverable" rule on
 * exactly one ground: the argv is fixed and cannot destroy anything that was
 * already on the remote. A behavioural test proves the call site WE WROTE does
 * not force. This is what stops a SECOND one appearing — the same shape as the
 * sync-spawn rule, and the reason `check:source` runs in `verify`.
 *
 * A BRACKET-MATCHED SCAN, not a line grep, because an argv is often built
 * across several lines and an unrelated `.push(` must not be mistaken for a git
 * one. Only an array whose FIRST element is the literal `"push"` is read, which
 * is what makes it a git push rather than any other array in the file.
 */
const FORBIDDEN_PUSH_TOKENS = [
  { token: "--force", why: "a force push overwrites commits that were already on the remote" },
  { token: "--force-with-lease", why: "a lease is still an overwrite, and this engine has no reader to check the lease for" },
  { token: "--delete", why: "deleting a remote branch is not additive and is not recoverable" },
  { token: "-f", why: "`-f` is `--force` spelled shorter" },
];

/** Every git push argv in a source file, with whatever it should not carry. */
function pushArgvProblems(source) {
  const problems = [];
  const pattern = /\[\s*"push"/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const open = match.index;
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "[") depth += 1;
      else if (source[i] === "]" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) continue;
    const argv = source.slice(open, end + 1);
    const line = source.slice(0, open).split("\n").length;
    for (const { token, why } of FORBIDDEN_PUSH_TOKENS) {
      // Matched as a whole quoted element, so `--force-with-lease` is not also
      // reported as `--force` and a BRANCH whose name contains the letters is
      // not reported at all.
      if (argv.includes(`"${token}"`)) problems.push({ line, token, why });
    }
    // A `+`-prefixed refspec is a force push wearing no flag to grep for.
    if (/"\+[^"]+:/.test(argv)) {
      problems.push({ line, token: "a +refspec", why: "a leading + on a refspec forces the update with no flag to grep for" });
    }
  }
  return problems;
}

/**
 * The shapes that matter, held to the standard the scans above set: a rule
 * never shown to fire has demonstrated nothing. The last two are the ways a
 * naive grep gets this wrong — an unrelated `.push(` call, and a BRANCH whose
 * name merely contains the letters.
 */
const PUSH_ARGV_SAMPLES = [
  { flags: true, why: "the plain force", code: `git(cwd, ["push", "--force", "origin", branch]);` },
  { flags: true, why: "a lease is still an overwrite", code: `git(cwd, ["push", "--force-with-lease", "origin", branch]);` },
  { flags: true, why: "deleting a remote branch", code: `git(cwd, ["push", "origin", "--delete", branch]);` },
  { flags: true, why: "the short spelling", code: `git(cwd, ["push", "-f", "origin", branch]);` },
  { flags: true, why: "a +refspec forces with no flag to grep for", code: `git(cwd, ["push", "origin", "+refs/heads/x:refs/heads/x"]);` },
  {
    flags: true,
    why: "an argv built across several lines — the shape a line scan misses",
    code: `git(cwd, [\n  "push",\n  "--set-upstream",\n  "--force",\n  "origin",\n  branch,\n]);`,
  },
  { flags: false, why: "the one push this engine makes", code: `git(cwd, ["push", "--set-upstream", "origin", branch]);` },
  { flags: false, why: "an unrelated array push, which is not a git argv at all", code: `failures.push("--force is not allowed here");` },
  { flags: false, why: "a branch whose NAME contains the letters", code: `git(cwd, ["push", "--set-upstream", "origin", "telar/force-refresh"]);` },
];

/**
 * WARP IS RETIRED AND MAY NOT COME BACK — #877.
 *
 * The owner's words were "quiero que se vaya completamente, no quiero que quede
 * rastro o chance de usarlo de nuevo", and a deletion alone does not deliver the
 * second half: the modules are gone, but nothing stops the next person reaching
 * for the names again, and the four `warp-*.test.ts` files that would have
 * caught it are gone too. The unit tests pin the tool WALLS — no `warp` tool,
 * no `warp` capability, no `warp` on any registered toolkit. This is the
 * complement: no file anywhere may reach for the CODE.
 *
 * TWO SHAPES, because the feature had two ways of being referenced and they
 * fail differently. A path containing `/warp/` is the import that broke the
 * build when the folder went (#877's trap 2: `driver.ts` imported
 * `compileWarpScript` straight from `./warp/sandbox`, which is the one import
 * that did not look like a Warp import from outside the folder). An identifier
 * is the shape that would NOT break anything — a re-declared `createWarpSpawn`
 * or `WarpRunner` compiles perfectly well, which is exactly why a compiler
 * cannot be the guard here.
 *
 * WHAT THIS DELIBERATELY DOES NOT MATCH IS A BARE `warp`, and that is the whole
 * care in the pattern. Telar is a loom; `warp` and `weft` are its threads, and
 * `apps/ios/Shared/TelarMark.swift` draws the app icon with a `warp` path
 * variable while `apps/desktop/icon-candidates/` describes warp strands in
 * prose. Those are the BRAND. A grep-and-delete by name would have stripped
 * them, so one of five suffixes is REQUIRED: `…warpScript`, `…warpRunner`,
 * `…warpSpawn`, `…warpSandbox`, `…warpSurface`, in any case.
 *
 * THERE IS NO WORD BOUNDARY ON THE LEFT, and that is a deliberate widening of
 * the rule as #877 wrote it. The three names actually deleted were
 * `compileWarpScript`, `createWarpRunner` and `createWarpSpawn` — every one of
 * them a verb prefix followed by the noun, so a left-anchored `\bwarp…` would
 * have missed all three and matched only the types beside them. The right
 * boundary stays, which is what keeps `warped` and `warping` out.
 */
const RETIRED_WARP_PATH = /["'`][^"'`]*\/warp\/[^"'`]*["'`]/g;
const RETIRED_WARP_IDENTIFIER = /warp(Script|Runner|Spawn|Sandbox|Surface)\b/gi;

/** Every reference to the retired feature in one source text, with its line. */
function retiredWarpReferences(source) {
  const hits = [];
  const at = (index) => source.slice(0, index).split("\n").length;
  for (const match of source.matchAll(RETIRED_WARP_PATH)) {
    hits.push({ line: at(match.index), what: `a path through \`/warp/\` — ${match[0]}` });
  }
  for (const match of source.matchAll(RETIRED_WARP_IDENTIFIER)) {
    hits.push({ line: at(match.index), what: `the identifier \`${match[0]}\`` });
  }
  return hits;
}

/**
 * The shapes that matter, held to the standard every scan in this file is held
 * to: a rule never shown to fire has demonstrated nothing. The silent rows are
 * the ones that carry the weight — each is the loom metaphor or a word that
 * merely starts the same way, and a guard that fired on the app icon would be
 * deleted by the next person rather than argued with.
 */
const RETIRED_WARP_SAMPLES = [
  { flags: true, why: "the call site that broke the build", code: `import { compileWarpScript } from "./warp/sandbox";` },
  { flags: true, why: "the runner, imported from anywhere", code: `import { createWarpRunner } from "../../engine/src/warp/runner";` },
  { flags: true, why: "an identifier with no import at all — the shape a compiler cannot catch", code: `const spawn = createWarpSpawn({ cwd });` },
  { flags: true, why: "the verb-prefixed spellings, which a left-anchored \\b would miss", code: `const compiled = compileWarpScript(code);\nconst start = createWarpRunner(deps);` },
  { flags: true, why: "a type reference", code: `let surface: WarpSurface | undefined;` },
  { flags: true, why: "any case, since a re-add would not copy the old spelling", code: `const WARPRUNNER = 1;` },
  { flags: true, why: "a binding declared rather than imported", code: `type Bindings = { warpSpawn: unknown };` },

  { flags: false, why: "THE APP ICON — TelarMark's loom threads", code: `var warp = Path()\nwarp.move(to: CGPoint(x: 0, y: 0))` },
  { flags: false, why: "the icon's gradient id", code: `<linearGradient id="warp" x1="0" y1="0">` },
  { flags: false, why: "the weaving term in prose", code: `// Three bold warp strands and three bold weft strands interlock.` },
  { flags: false, why: "a dated record naming the retired feature", code: `// Measured on main: \`warp\` is 2,988 characters.` },
  { flags: false, why: "a directory that merely starts the same way", code: `import { x } from "./warping/thing";` },
  { flags: false, why: "a longer word containing the letters", code: `const warped = transform(image);` },
];

/** Every non-test source file under a directory. */
async function sourceFilesUnder(directory) {
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
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push(next);
      }
    }
  };
  await walk(directory);
  return found;
}

/**
 * EVERY CODE FILE under a directory, tests included, repo-relative.
 *
 * TESTS ARE IN, unlike `sourceFilesUnder`: the check this feeds is about a name
 * not coming back anywhere, and a helper resurrected in a test fixture is
 * exactly how a retired module finds its way back into product code.
 *
 * `DerivedData/` joins the usual build-output exclusions — it holds vendored
 * checkouts and Xcode's own copies of source, so a hit there names a file
 * nobody can fix in place.
 */
async function codeFilesUnder(directory) {
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
        if (entry.name === "node_modules" || entry.name === "release" || entry.name === "DerivedData") continue;
        // `apps/engine/dist/` is the bundled engine build-app.sh writes and git
        // ignores. On CI it never exists; on a developer's Mac it can be days
        // stale, and a stale bundle still names whatever the source has since
        // retired (#877's scan tripped on exactly that). It is not source, and
        // nothing found in it could be fixed there.
        if (entry.name === "dist") continue;
        if (entry.name.startsWith(".next")) continue;
        await walk(next);
      } else if (/\.(tsx?|jsx?|mjs|cjs|swift)$/.test(entry.name)) {
        found.push(next);
      }
    }
  };
  await walk(directory);
  return found;
}

/** `import dynamic from "next/dynamic"`, however the binding is spelled. */
const NEXT_DYNAMIC_IMPORT = /import\s+(?:\w+|\{[^}]*\}|\w+\s*,\s*\{[^}]*\})\s+from\s+["']next\/dynamic["']/;

/**
 * EVERY `dynamic(…)` IN A FILE THAT RENDERS NO BOUNDARY OF ITS OWN — #896.
 *
 * WHAT IS COUNTED, and why it is not simply "every dynamic()". Next's
 * `Loadable` adds a `Suspense` when the declaration carries `ssr: false` or a
 * `loading`, and a bare `Fragment` when it carries neither. Only the bare
 * spelling needs a boundary from us, and flagging the other two would make this
 * fire on declarations Next has already wrapped — the kind of false positive
 * that gets a check deleted rather than argued with.
 *
 * PAREN-BALANCED rather than matched with `[^)]*`, for the reason `ios-mark-sizes`
 * records: these calls nest (`dynamic(() => import("x").then((m) => m.Y))`), and
 * a character class stops at the first inner `)` — which would read every one of
 * this repo's declarations as optionless and be right by accident.
 *
 * THE BOUNDARY IS LOOKED FOR PER FILE, not per render site. A declaration and
 * the JSX that renders it are hundreds of lines apart here (the panel declares
 * twelve at the top and renders one, chosen by a ladder, at the bottom), so
 * pairing them textually would mean parsing the component. A file that declares
 * a bare `dynamic` and contains no `<Suspense` at all is the claim this can
 * make honestly, and it is the one that would have caught #896 in all four
 * files it affected.
 */
function bareDynamicWithoutBoundary(source) {
  if (!NEXT_DYNAMIC_IMPORT.test(source)) return [];
  if (/<Suspense[\s/>]/.test(source)) return [];
  const hits = [];
  for (const match of source.matchAll(/\bdynamic\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let at = open; at < source.length; at += 1) {
      if (source[at] === "(") depth += 1;
      else if (source[at] === ")") {
        depth -= 1;
        if (depth === 0) {
          close = at;
          break;
        }
      }
    }
    // An unbalanced call is a file this scan cannot read; say nothing rather
    // than guess, since the non-vacuity guard above is what catches a scan
    // that has stopped seeing its corpus.
    if (close === -1) continue;
    const call = source.slice(match.index, close + 1);
    if (/\bssr\s*:/.test(call) || /\bloading\s*:/.test(call)) continue;
    hits.push({ line: source.slice(0, match.index).split("\n").length, what: call.replace(/\s+/g, " ").slice(0, 80) });
  }
  return hits;
}

/** The shapes the scan above must and must not see. */
const BARE_DYNAMIC_SAMPLES = [
  {
    flags: true,
    why: "a bare declaration in a file with no boundary anywhere — #896 itself",
    code: `import dynamic from "next/dynamic";\nconst Editor = dynamic(() => import("./editor").then((m) => m.Editor));\nexport const P = () => <Editor />;`,
  },
  {
    flags: false,
    why: "the same declaration in a file that renders a Suspense",
    code: `import dynamic from "next/dynamic";\nimport { Suspense } from "react";\nconst Editor = dynamic(() => import("./editor").then((m) => m.Editor));\nexport const P = () => <Suspense fallback={null}><Editor /></Suspense>;`,
  },
  {
    flags: false,
    why: "a self-closing boundary, which is still a boundary",
    code: `import dynamic from "next/dynamic";\nconst E = dynamic(() => import("./e"));\nexport const P = () => <Suspense/>;`,
  },
  {
    flags: false,
    why: "`ssr: false`, which Next wraps itself",
    code: `import dynamic from "next/dynamic";\nconst E = dynamic(() => import("./e"), { ssr: false });\nexport const P = () => <E />;`,
  },
  {
    flags: false,
    why: "a `loading` declaration, which Next also wraps itself",
    code: `import dynamic from "next/dynamic";\nconst E = dynamic(() => import("./e"), { loading: () => null });\nexport const P = () => <E />;`,
  },
  {
    flags: false,
    why: "a file that never imports next/dynamic, however much it says `dynamic(`",
    code: `const dynamic = (f) => f;\nconst E = dynamic(() => import("./e"));\nexport const P = () => <E />;`,
  },
  {
    flags: true,
    why: "a nested loader, which a `[^)]*` match would read as carrying no options and pass for the wrong reason",
    code: `import dynamic from "next/dynamic";\nconst E = dynamic(() => import("./e").then((m) => m.E));\nexport const P = () => <E />;`,
  },
];

const CHECKS = [
  /**
   * A SYNC CHILD WAIT IS OUTSIDE EVERY CEILING ABOVE IT — #807.
   *
   * bun's per-test ceiling is a timer on the event loop. `spawnSync` blocks the
   * JS thread in `wait4`, so a thread parked there never reaches the timer:
   * `--timeout 20000` bounds a test and cannot bound this. Measured for #807,
   * none of the engine suite's four sync child waits passed a `timeout`, and
   * the worst of them spawns seven child `bun test` runs — one stuck child is
   * two unbounded `bun test` processes, neither bounded by anything.
   *
   * THE RULE IS NOT A BLANKET WRAPPER, which #807 rules out by name. It asks
   * each call site to name its own ceiling, the way src/worktree.ts's sync git
   * runner already does — that file is where the argument for SIGKILL over
   * SIGTERM is written out, and it is why this check wants both: a ceiling with
   * a signal the child may never get around to handling is a ceiling that can
   * miss, and a signal with no ceiling never fires.
   *
   * SCOPED TO THE ENGINE TESTS, which is where the gap was and where the
   * evidence is. src/ already passes; a rule over src/ would be a claim this
   * issue did not measure.
   */
  {
    name: "engine-test-spawn-sync-is-bounded",
    protects: "#807: no synchronous child wait in the engine suite can outlive its own call site",
    async run() {
      const failures = [];
      for (const file of (await testFilesUnder("apps/engine/test")).sort()) {
        for (const call of syncSpawnCalls(await read(file))) {
          if (call.bounded && call.forceful) continue;
          const missing = call.bounded ? '`killSignal: "SIGKILL"`' : call.forceful ? "a `timeout`" : "a `timeout` and `killSignal: \"SIGKILL\"`";
          failures.push(
            `${file}:${call.line}: \`${call.call}(…)\` is missing ${missing}. A synchronous child wait blocks the JS thread in wait4, ` +
              "where bun's per-test ceiling — an event-loop timer — can never reach it, so a child that does not exit is a test that never " +
              "fails and a `bun test` that never ends. Give this call site a ceiling it knows is generous for what it spawns, and SIGKILL " +
              "so the ceiling reaches a child that has stopped answering. See src/worktree.ts's sync git runner for the shape.",
          );
        }
      }
      return failures;
    },
  },

  {
    name: "engine-test-spawn-sync-scan-self-test",
    protects: "#807: the scan still fires on both unbounded spellings, and stays quiet on a bounded call whose options are lines below it",
    async run() {
      const failures = [];
      for (const { flags, why, code } of SYNC_SPAWN_SAMPLES) {
        const unbounded = syncSpawnCalls(code).filter((call) => !(call.bounded && call.forceful));
        if (flags && unbounded.length === 0) failures.push(`the scan MISSED a sample it must catch (${why}): ${JSON.stringify(code)}.`);
        if (!flags && unbounded.length > 0) {
          failures.push(`the scan FIRED on a sample it must ignore (${why}): ${JSON.stringify(code)}. Flagging a bounded call makes the check wrong about correct code.`);
        }
      }
      return failures;
    },
  },

  {
    name: "shell-empty-array-self-test",
    protects:
      "#808/#829: the scan below still fires on the shape that broke, stays quiet on the fix, and reads a workflow `run:` block at the line it really has",
    async run() {
      const failures = [];
      for (const { why, hits: expected, scanned: expectedScanned, yaml } of WORKFLOW_BLOCK_SAMPLES) {
        const blocks = workflowRunBlocks(yaml.join("\n"));
        const found = [];
        let scanned = 0;
        for (const block of blocks) {
          const hits = workflowBlockHits(block);
          if (hits === null) continue;
          scanned += 1;
          found.push(...hits.map((hit) => `${hit.line}:${hit.name}`));
        }
        if (found.join(", ") !== expected.join(", ")) {
          failures.push(
            `the workflow reader saw [${found.join(", ")}] where it must see [${expected.join(", ")}] (${why}). ` +
              "A reader that reports the wrong line sends the next person to text that says nothing about the failure, " +
              "and one that reports nothing makes shell-empty-array green over `.github/workflows` for free.",
          );
        }
        if (scanned !== expectedScanned) {
          failures.push(
            `the workflow reader scanned ${scanned} block(s) where it must scan ${expectedScanned} (${why}). ` +
              "Blocks scanned is what shell-empty-array's non-vacuity rule counts, so this number moving silently is " +
              "how that rule stops meaning anything.",
          );
        }
      }
      for (const { flags, why, code } of ARRAY_GUARD_SAMPLES) {
        const hits = unguardedArrayExpansions(code);
        if (flags && hits.length === 0) {
          failures.push(
            `the scan MISSED a sample it must catch (${why}): ${JSON.stringify(code)}. ` +
              "shell-empty-array below is now reporting green for a spelling it no longer sees.",
          );
        }
        if (!flags && hits.length > 0) {
          failures.push(
            `the scan FIRED on a sample it must ignore (${why}): ${JSON.stringify(code)}. ` +
              "This spelling is safe on bash 3.2; flagging it makes the check wrong about correct code, and the " +
              "next person to hit it will delete the check rather than argue with it.",
          );
        }
      }
      return failures;
    },
  },
  {
    name: "shell-empty-array",
    protects:
      "#808/#829: no `set -u` shell script or workflow `run:` block expands an array that could be empty, which aborts on the bash macOS ships",
    async run() {
      const failures = [];
      const report = (where, hit, closing) =>
        failures.push(
          `${where}: \`${hit.name}\` is expanded without a guard — ${hit.text}\n` +
            `        Write it as \${${hit.name}[@]+"\${${hit.name}[@]}"} (or \${${hit.name}[*]-} inside a message ` +
            "string). Under `set -u` bash 3.2 treats an expansion of an EMPTY array as an unbound variable and " +
            `kills the ${closing} Bash 4.4 stopped doing this, which is why it will very likely ` +
            "work when you try it. Do not reach for `set +u` (it drops the check for every variable on the line) " +
            "or for seeding the array (the seed becomes a real argument to the command).",
        );

      let scanned = 0;
      for (const path of await shellFiles()) {
        const source = await read(path);
        if (!enablesNounset(source)) continue;
        scanned += 1;
        for (const hit of unguardedArrayExpansions(source)) {
          report(
            `${path}:${hit.line}`,
            hit,
            "script; macOS ships 3.2.57 as /bin/bash, so `#!/usr/bin/env bash` gets it on any machine " +
              "without a newer bash earlier on PATH.",
          );
        }
      }

      let blocksScanned = 0;
      for (const path of await workflowFiles()) {
        const source = await read(path);
        for (const block of workflowRunBlocks(source)) {
          const hits = workflowBlockHits(block);
          if (hits === null) continue;
          blocksScanned += 1;
          for (const hit of hits) {
            report(
              `${path}:${hit.line}`,
              hit,
              "step; the `macos-*` runner images report bash 3.2.57 as their `bash`, and a `run:` block takes " +
                "its shell from PATH, so this is the bash the step gets.",
            );
          }
        }
      }

      // An empty result from a scan is a claim about the scan. If the walker
      // stopped finding shell scripts, this check would pass by finding nothing
      // to check — the failure mode that looks exactly like success. The same
      // holds a second time for workflows, where the reader has a YAML shape to
      // get wrong as well as a directory to find.
      if (scanned === 0) {
        failures.push(
          "no `set -u` shell script was found anywhere in the tree, which cannot be right — " +
            "shellFiles() has stopped walking, so this check is green because it read nothing.",
        );
      }
      if (blocksScanned === 0) {
        failures.push(
          "no `set -u` `run:` block was found in .github/workflows, which cannot be right — " +
            "workflowRunBlocks() has stopped reading the YAML, so the workflow half of this check is green " +
            "because it read nothing.",
        );
      }
      return failures;
    },
  },
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
   *
   * AND A BUDGET CAN NOW LIVE IN ANOTHER FILE — #760. The helpers were 26
   * private copies; one shared module replaced the copies in the files that
   * import it, and a budget that has moved out of the file is a budget this scan
   * stops seeing. That is how a guard is disabled without anyone deciding to:
   * the check goes on printing `ok` about a pairing it can no longer read. So a
   * file that imports the shared module is checked against the shared module's
   * own default as well as against whatever it still declares locally.
   */
  {
    name: "test-wait-fits-its-ceiling",
    protects: "engine test timeouts (#706, #760): a wait's budget — its own or the shared helper's — is strictly under the ceiling of the test running it",
    async run() {
      const shared = await read(SHARED_WAIT_MODULE).catch(() => null);
      if (shared === null) {
        return [
          `${SHARED_WAIT_MODULE} is missing. It is where the one wait budget lives (#760); without it this check ` +
            "cannot tell what budget the files importing it are running under, and must not pretend otherwise.",
        ];
      }
      const declared = /export const WAIT_BUDGET_MS = ([0-9_]+);/.exec(shared);
      if (!declared) {
        return [
          `${SHARED_WAIT_MODULE} no longer declares \`export const WAIT_BUDGET_MS = <number>\` as a plain literal, so ` +
            "this check cannot read the shared budget. Restore the declaration, or teach this check where it moved to.",
        ];
      }
      const sharedBudgetMs = Number(declared[1].replace(/_/g, ""));

      const failures = [];
      const files = (await readdir(join(ROOT, "apps/engine/test"))).filter((name) => name.endsWith(".test.ts"));
      for (const name of files) {
        const failure = waitBudgetFailure(name, await read(join("apps/engine/test", name)), sharedBudgetMs);
        if (failure) failures.push(failure);
      }
      return failures;
    },
  },

  /**
   * #721's standard, applied to the scan above: one that has never been shown to
   * fail has demonstrated nothing. The sample that matters is the third — a file
   * whose budget is entirely in the shared module, which is the exact shape the
   * old scan read as "no budget here" and passed.
   */
  {
    name: "test-wait-scan-self-test",
    protects: "#706/#760: the wait-budget scan still sees an inverted pair through the shared helper, and stays quiet on a correct one",
    async run() {
      const ceiling = (ms) => `test("x", async () => {\n  await eventually(() => {});\n}, ${ms});\n`;
      const importsShared = 'import { eventually } from "./wait";\n';
      const localBudget = "const deadlineMs = 15_000;\n";
      const samples = [
        { fires: true, why: "the original #706 shape: a local 15s budget under a 10s ceiling", source: localBudget + ceiling(10_000) },
        { fires: true, why: "equal is a coin toss, not a pass", source: localBudget + ceiling(15_000) },
        { fires: true, why: "the budget moved into the shared module and the ceiling did not move with it", source: importsShared + ceiling(10_000) },
        { fires: false, why: "the shared budget under the suite ceiling", source: importsShared + ceiling(20_000) },
        { fires: false, why: "a local budget under its ceiling", source: localBudget + ceiling(20_000) },
        { fires: false, why: "no ceiling at all inherits the suite's 20s", source: importsShared },
        { fires: false, why: "a file with neither a budget nor an import", source: ceiling(10_000) },
      ];
      const failures = [];
      for (const { fires, why, source } of samples) {
        const failure = waitBudgetFailure("sample.test.ts", source, 15_000);
        if (fires && failure === null) failures.push(`the scan MISSED a sample it must catch (${why}).`);
        if (!fires && failure !== null) failures.push(`the scan FIRED on a sample it must ignore (${why}): ${failure}`);
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
   *   - A `--timeout` FLAG ON A TEST SCRIPT CARRIES A DIFFERENT NUMBER. The flag
   *     works — the preload reads it back off the operating system and stands
   *     aside for it — so the danger is not that it does nothing, but that one
   *     suite runs at a ceiling nobody reproduces by running the same test any
   *     other way, with the difference invisible in the failure.
   *
   *   - A `--timeout` FLAG LEAVES A TEST SCRIPT ALTOGETHER, which is #792 and is
   *     the reason the second rule is no longer enough. #740 removed the flag
   *     from every workspace `test` script believing the preload had replaced
   *     it. Measured afterwards on bun 1.3.11: a preload's `setDefaultTimeout`
   *     reaches the FIRST test file of a run and no other, so the 182-file
   *     engine suite ran at bun's 5 s default for 181 of them while
   *     `__telarTestCeilingMs` reported 20 000 in every one. The preload is not
   *     a substitute for the flag on a multi-file suite; it is the cover for the
   *     single-file run a flag on a script cannot reach.
   *
   * THE THIRD CASE #740 ASKED THIS TO NOTICE: packages/engine-client
   * sets no ceiling at all, which is consistent rather than
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
    protects: "#740/#792: every bunfig that runs tests preloads the one ceiling, and every bun test script carries it — no rival number, and none missing",
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
        for (const { script, command } of bunTestScripts(scripts)) {
          if (/--timeout[= ]+[0-9_]+/.test(command)) continue;
          failures.push(
            `${manifest}: \`${script}\` runs \`bun test\` with no --timeout, so every file after the FIRST one it ` +
              `loads is on bun's 5000ms default (#792). The preload cannot cover this: bun applies a preload's ` +
              `setDefaultTimeout to the first file only, which is how #740 left the 182-file engine suite running at ` +
              `5 s while reporting ${ceilingMs}. Add \`--timeout ${ceilingMs}\`.`,
          );
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
    protects: "#740/#792: the script scan sees a flag through either desktop shape, sees a bun test run without one, and ignores prose about both",
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

      /**
       * AND THE SAME SAMPLES AGAINST "RUNS bun test AT ALL" — #792's rule needs
       * the shapes the flag rule ignores. The two that matter are the ones a
       * `--timeout`-less scan must NOT claim: a script that delegates, and one
       * that runs a different runner entirely. Getting those wrong would order
       * a flag onto a command that has nowhere to put it.
       */
      const runners = [
        { expect: ["t"], why: "a bare run is still a bun test run", scripts: { t: "bun test" } },
        { expect: ["t"], why: "an env prefix does not hide it", scripts: { t: "NODE_ENV=test bun test" } },
        { expect: ["t"], why: "the flag present is still a bun test run", scripts: { t: "bun test --timeout 20000" } },
        { expect: [], why: "delegation to another script", scripts: { t: "bun run test:desktop:unit" } },
        { expect: [], why: "an electron suite", scripts: { t: "env -u ELECTRON_RUN_AS_NODE electron ./x.electron-test.js" } },
        { expect: [], why: "node's runner rather than bun's", scripts: { t: "node --test workers/push-relay/worker.test.mjs" } },
        { expect: [], why: "prose in a // comment key", scripts: { "//t": "--timeout IS THE ONLY WAY, bun test aside" } },
      ];
      for (const { expect: wanted, why, scripts } of runners) {
        const got = bunTestScripts(scripts).map((hit) => hit.script);
        if (JSON.stringify(got) === JSON.stringify(wanted)) continue;
        failures.push(
          `the runner scan read ${JSON.stringify(got)} where ${JSON.stringify(wanted)} was right (${why}): ` +
            `${JSON.stringify(Object.values(scripts)[0])}.`,
        );
      }
      return failures;
    },
  },

  /**
   * EVERY ENGINE TEST FILE IS IN EXACTLY ONE SHARD — #760's option A.
   *
   * The engine suite runs as three jobs now. The failure worth fearing is not a
   * red shard; it is a shard that quietly runs fewer files than it should, which
   * looks from the outside like the split having made the suite faster. Three
   * things have to agree for that not to happen, and none of them is a comment:
   * the shard count in verify.yml, the partition scripts/engine-shard.mjs
   * computes, and the files actually on disk.
   *
   * WHAT IS CHECKED is the property, not the arithmetic that produces it — the
   * union of the shards is the whole suite, no file is in two of them, and no
   * shard is empty. A partition that satisfied those three by accident would
   * still be a correct split.
   *
   * THE WORKFLOW IS READ RATHER THAN TRUSTED because the two can drift in the
   * direction that is silent: raise `total` to 4 and forget the `shard` list and
   * a quarter of the suite stops running, with four green jobs to say so.
   */
  {
    name: "engine-shards-cover-every-test-file",
    protects: "#760: verify.yml's engine shard matrix and scripts/engine-shard.mjs partition every engine test file — union whole, none shared, none empty",
    async run() {
      const workflow = await read(".github/workflows/verify.yml").catch(() => null);
      if (workflow === null) return [".github/workflows/verify.yml is missing, so the engine shard matrix cannot be read."];

      const job = /\n {2}test-engine:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:\n)/.exec(workflow);
      if (!job) {
        return [
          "verify.yml no longer has a `test-engine:` job, so the engine suite is either unsharded or sharded " +
            "somewhere this check cannot see. If the split moved, teach this check where — an unchecked split is " +
            "how a shard starts dropping files without a red run (#760).",
        ];
      }
      const block = job[1];

      const failures = [];
      const shardAxis = /\n {8}shard: \[([0-9, ]+)\]\n/.exec(block);
      const totalAxis = /\n {8}total: \[([0-9]+)\]\n/.exec(block);
      if (!shardAxis || !totalAxis) {
        return [
          "verify.yml's `test-engine` job no longer declares both `shard: [ ... ]` and `total: [ N ]` matrix axes in " +
            "the shape this check reads. They are what tie the workflow's split to the one the script computes.",
        ];
      }
      const shards = shardAxis[1].split(",").map((entry) => Number(entry.trim()));
      const total = Number(totalAxis[1]);

      const wanted = Array.from({ length: total }, (_unused, at) => at + 1);
      if (JSON.stringify(shards) !== JSON.stringify(wanted)) {
        failures.push(
          `verify.yml runs engine shards ${JSON.stringify(shards)} out of a split of ${total}, which is not ` +
            `${JSON.stringify(wanted)}. Every shard of the split must run: the ones missing here are test files that ` +
            "no job opens, and the jobs that do run are green.",
        );
      }
      if (!/- run: bun scripts\/engine-shard\.mjs \$\{\{ matrix\.shard \}\} \$\{\{ matrix\.total \}\}/.test(block)) {
        failures.push(
          "verify.yml's `test-engine` job no longer runs `bun scripts/engine-shard.mjs ${{ matrix.shard }} " +
            "${{ matrix.total }}`. The matrix axes above are only meaningful if they are what the script is handed.",
        );
      }
      // Split rather than a \bengine\b word match: `engine-client` is a suite of
      // its own and a word boundary sits on the hyphen, so the naive pattern
      // reports the double-run that is not there.
      const suiteAxis = /\n {8}suite: \[([^\]]*)\]/.exec(workflow);
      const suites = suiteAxis ? suiteAxis[1].split(",").map((entry) => entry.trim()) : [];
      if (suites.includes("engine")) {
        failures.push(
          "verify.yml's `test` matrix still lists `engine` alongside the sharded `test-engine` job, so the engine " +
            "suite runs twice — once whole and once split. That is not wrong so much as invisible: the sharded jobs " +
            "could be dropping files and the whole-suite job would keep the run green.",
        );
      }
      if (!/needs: \[[^\]]*\btest-engine\b[^\]]*\]/.test(workflow)) {
        failures.push(
          "verify.yml's `verify-passed` job does not list `test-engine` in `needs`, so a red engine shard does not " +
            "stop the aggregate going green. A required check that cannot fail is the #772 shape.",
        );
      }

      const files = await engineTestFiles();
      const parts = wanted.map((index) => shardOf(files, index, total));
      const covered = parts.flat();
      const union = new Set(covered);
      const empty = wanted.filter((index) => parts[index - 1].length === 0);
      if (empty.length > 0) {
        failures.push(
          `engine shards ${JSON.stringify(empty)} of ${total} are empty. An empty shard is a green job that ran ` +
            "nothing, which reads as a pass.",
        );
      }
      if (covered.length !== union.size) {
        const twice = covered.filter((file, at) => covered.indexOf(file) !== at);
        failures.push(
          `these engine test files are in more than one shard: ${JSON.stringify([...new Set(twice)])}. Duplicated ` +
            "work is the harmless half of a broken partition; the other half is usually a gap.",
        );
      }
      const missed = files.filter((file) => !union.has(file));
      if (missed.length > 0) {
        failures.push(
          `these engine test files are in no shard, so nothing in CI runs them: ${JSON.stringify(missed)}. That is ` +
            "coverage lost with every job still green, which is exactly what #760's split had to not do.",
        );
      }
      return failures;
    },
  },

  /**
   * #721 again: the partition above is checked against the real tree, where it
   * has always held, so it has never been seen to fail. These samples are where
   * it is made to.
   */
  {
    name: "engine-shard-partition-self-test",
    protects: "#760: the shard function partitions — every item once, nothing invented, no shard left empty when there is work",
    async run() {
      const failures = [];
      const files = Array.from({ length: 7 }, (_unused, at) => `test/f${at}.test.ts`);
      for (const total of [1, 2, 3, 7]) {
        const parts = Array.from({ length: total }, (_unused, at) => shardOf(files, at + 1, total));
        const covered = parts.flat();
        if (covered.length !== files.length || new Set(covered).size !== files.length) {
          failures.push(`a split of ${total} over ${files.length} files covered ${JSON.stringify(covered)} — not a partition.`);
        }
        if (parts.some((part) => part.length === 0)) {
          failures.push(`a split of ${total} over ${files.length} files left an empty shard: ${JSON.stringify(parts)}.`);
        }
      }
      // More shards than files: some shards ARE empty, and the script refuses to
      // run one rather than reporting a green job that opened nothing.
      const sparse = shardOf(files, 9, 9);
      if (sparse.length !== 0) failures.push(`shard 9 of 9 over 7 files should be empty, got ${JSON.stringify(sparse)}.`);
      // And an index outside the split is a throw, not a quietly empty list.
      for (const [index, total] of [[0, 3], [4, 3], [1, 0]]) {
        let threw = false;
        try {
          shardOf(files, index, total);
        } catch {
          threw = true;
        }
        if (!threw) failures.push(`shardOf(files, ${index}, ${total}) returned instead of throwing; an impossible shard must not look empty.`);
      }
      return failures;
    },
  },
  {
    name: "git-push-argv-self-test",
    protects: "#670: the push-argv scan still fires on every way of forcing, and stays quiet on the one push this engine makes",
    async run() {
      const failures = [];
      for (const sample of PUSH_ARGV_SAMPLES) {
        const hits = pushArgvProblems(sample.code);
        const shown = sample.code.replace(/\n/g, " ");
        if (sample.flags && hits.length === 0) failures.push(`the scan missed ${sample.why}: ${shown}`);
        if (!sample.flags && hits.length > 0) failures.push(`the scan fired on ${sample.why}: ${shown}`);
      }
      return failures;
    },
  },
  {
    name: "git-push-argv",
    protects: "#670: no git push in the engine carries --force, --force-with-lease, --delete or a +refspec",
    async run() {
      const failures = [];
      for (const file of await sourceFilesUnder("apps/engine/src")) {
        const source = await readFile(join(ROOT, file), "utf8");
        for (const problem of pushArgvProblems(source)) {
          failures.push(
            `${file}:${problem.line}: a git push argv carries \`${problem.token}\` — ${problem.why}.\n` +
              "        `git.ts`'s header argues this engine's one push is inside the additive-and-recoverable rule on " +
              "exactly the ground that it cannot destroy what was already on the remote. A second push that can is not " +
              "a new feature; it retires that argument. If this is genuinely wanted, the header is what has to change first.",
          );
        }
      }
      return failures;
    },
  },

  {
    name: "warp-stays-retired-self-test",
    protects: "#877: the scan still catches both shapes of a Warp reference, and stays silent on the app icon's loom threads",
    async run() {
      const failures = [];
      for (const { flags, why, code } of RETIRED_WARP_SAMPLES) {
        const hits = retiredWarpReferences(code);
        const shown = JSON.stringify(code);
        if (flags && hits.length === 0) {
          failures.push(`the scan MISSED a sample it must catch (${why}): ${shown}. warp-stays-retired below is now green for a shape it no longer sees.`);
        }
        if (!flags && hits.length > 0) {
          failures.push(
            `the scan FIRED on a sample it must ignore (${why}): ${shown}. ` +
              "Telar is a loom and `warp` is one of its threads — a guard that flags the app icon is one the next person deletes rather than argues with.",
          );
        }
      }
      return failures;
    },
  },
  {
    name: "warp-stays-retired",
    protects: "#877: no file under apps/, packages/ or workers/ imports through `/warp/` or names a warpScript/Runner/Spawn/Sandbox/Surface",
    async run() {
      const failures = [];
      let scanned = 0;
      for (const group of ["apps", "packages", "workers"]) {
        for (const file of (await codeFilesUnder(group)).sort()) {
          scanned += 1;
          for (const hit of retiredWarpReferences(await read(file))) {
            failures.push(
              `${file}:${hit.line}: ${hit.what} — Warp was retired in #877 and may not come back.\n` +
                "        The owner asked for it to go completely, with no chance of using it again: the tool, the four " +
                "`src/warp/` modules, the protocol linkage and the surfaces that rendered it are all gone, and the tool " +
                "walls are pinned WITHOUT it in `tool-names.test.ts` and `tool-budgets.test.ts`. If a fan-out is genuinely " +
                "wanted again, that is a decision for the owner and a new name, not a resurrection of this one.\n" +
                "        If you are reading this because of the LOOM — Telar's warp-and-weft mark — you have hit a bug in " +
                "this check rather than the rule: a bare `warp` is deliberately allowed, and only the five suffixed " +
                "identifiers and a path through `/warp/` are not.",
            );
          }
        }
      }
      // An empty result from a scan is a claim about the scan. If the walker
      // stopped finding files, this check would pass by reading nothing — the
      // failure mode that looks exactly like success.
      if (scanned === 0) {
        failures.push("no code file was found under apps/, packages/ or workers/, which cannot be right — codeFilesUnder() has stopped walking, so this check is green because it read nothing.");
      }
      return failures;
    },
  },

  {
    name: "dynamic-render-sites-have-a-boundary-self-test",
    protects: "#896: the scan still fires on a bare `dynamic()` with no Suspense, and stays quiet on the two declarations that bring their own",
    async run() {
      const failures = [];
      for (const { flags, why, code } of BARE_DYNAMIC_SAMPLES) {
        const hits = bareDynamicWithoutBoundary(code);
        const shown = JSON.stringify(code);
        if (flags && hits.length === 0) {
          failures.push(`the scan MISSED a sample it must catch (${why}): ${shown}. dynamic-render-sites-have-a-boundary below is now green for a shape it no longer sees.`);
        }
        if (!flags && hits.length > 0) {
          failures.push(`the scan FIRED on a sample it must ignore (${why}): ${shown}. A guard that flags a declaration Next already wraps is one the next person deletes rather than argues with.`);
        }
      }
      return failures;
    },
  },
  {
    name: "dynamic-render-sites-have-a-boundary",
    protects: "#896: a file that declares a bare next/dynamic also declares the Suspense that catches its first render",
    async run() {
      const failures = [];
      const files = await sourceFilesUnder("apps/web");
      let declaring = 0;
      for (const file of files.sort()) {
        const source = await read(file);
        if (!NEXT_DYNAMIC_IMPORT.test(source)) continue;
        declaring += 1;
        for (const hit of bareDynamicWithoutBoundary(source)) {
          failures.push(
            `${file}:${hit.line}: \`${hit.what}\` is declared with neither \`ssr: false\` nor \`loading\`, and this file renders no \`<Suspense>\`.\n` +
              "        In that exact configuration Next's Loadable wraps its React.lazy in a Fragment and adds NO boundary " +
              "(node_modules/next/dist/shared/lib/lazy-dynamic/loadable.js: `hasSuspenseBoundary = !opts.ssr || !!opts.loading`), " +
              "so the first render of an unfetched chunk suspends up to the nearest one — the ROUTE's loading.tsx. The whole " +
              "page is replaced by its skeleton and drawn again when the chunk lands, and only ever on the first open, which is " +
              "why #896 was reported as a reload rather than as a bug.\n" +
              "        Wrap the render site in `<Suspense fallback={null}>`. Not a `loading:` spinner — the chunk comes off the " +
              "origin the page came from and a spinner that resolves in the next frame is a flash, not feedback — and not " +
              "`ssr: false`, which renders permanently nothing under this suite's environment (the header of " +
              "apps/web/components/right-panel.tsx argues both).",
          );
        }
      }

      /**
       * NON-VACUITY, in both directions. A walk that stopped walking and a
       * pattern that stopped matching both look exactly like a clean tree —
       * and this check's whole job is to notice an absence. (Measured when
       * written: four files under apps/web import next/dynamic.)
       */
      if (files.length === 0) {
        return ["apps/web: sourceFilesUnder() returned nothing, so this check swept no files and proved nothing. Fix the walk rather than trusting the pass."];
      }
      if (declaring === 0) {
        return [
          `apps/web: scanned ${files.length} source files and found none importing next/dynamic, which cannot be true while the panel, the settings panes, the sidebar and the annotate overlay are all code-split. Either the import was spelled a new way or NEXT_DYNAMIC_IMPORT has rotted; either way this check is now vacuous and must be re-anchored, not removed.`,
        ];
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
