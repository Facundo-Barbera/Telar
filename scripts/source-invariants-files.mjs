import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const read = (path) => readFile(join(ROOT, path), "utf8");

/** Every test file under a directory, repo-relative; build outputs hold copies of web tests and are skipped. */
export async function testFilesUnder(directory) {
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
export const CEILING_PRELOAD = "scripts/test-ceiling.mjs";

/** The one file an engine test's wait budget lives in, repo-relative (#760). */
export const SHARED_WAIT_MODULE = "apps/engine/test/wait.ts";

/** A file's wait budget against its tightest per-test ceiling, or `null` when sound or there is nothing to compare. */
export function waitBudgetFailure(name, source, sharedBudgetMs) {
  const budgets = [...source.matchAll(/(?:ms|timeoutMs|deadlineMs) = ([0-9_]+)/g)].map((m) => Number(m[1].replace(/_/g, "")));
  const importsShared = /from "(?:\.\/|(?:\.\.\/)+test\/)wait"/.test(source);
  if (importsShared) budgets.push(sharedBudgetMs);
  const ceilings = [...source.matchAll(/^\}, *([0-9_]+)\);/gm)].map((m) => Number(m[1].replace(/_/g, "")));
  if (budgets.length === 0 || ceilings.length === 0) return null;
  const budget = Math.max(...budgets);
  const ceiling = Math.min(...ceilings);
  if (budget < ceiling) return null;
  const whose = budget === sharedBudgetMs && importsShared ? ` (${SHARED_WAIT_MODULE}'s WAIT_BUDGET_MS)` : "";
  return (
    `${name}: a wait budget of ${budget}ms${whose} runs under a per-test ceiling of ${ceiling}ms. ` +
    "The test dies before the wait can report, so the real reason is discarded and the run only says it timed out. " +
    "Lower the budget below every ceiling in this file, or raise the ceiling above the budget."
  );
}

/**
 * Every directory a bunfig.toml would be read from: the repo root and each
 * workspace. Enumerated rather than listed, so a workspace added next year is
 * covered without anyone remembering to come back here.
 */
export async function workspaceDirectories() {
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
export function testPreloads(source) {
  if (!/^\s*\[test\]\s*$/m.test(source)) return null;
  const list = /(?:^|\n)\s*preload\s*=\s*\[([^\]]*)\]/.exec(source);
  if (!list) return [];
  return [...list[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** Every `--timeout N` a package's scripts hand to `bun test`; `//` keys are comments, not commands. */
export function bunTestTimeouts(scripts) {
  const found = [];
  for (const { script, command } of bunTestScripts(scripts)) {
    for (const match of command.matchAll(/--timeout[= ]+([0-9_]+)/g)) {
      found.push({ script, ms: Number(match[1].replace(/_/g, "")) });
    }
  }
  return found;
}

/** Scripts that run bun's test runner themselves; one that delegates (`bun run test:x`) is not one. */
export function bunTestScripts(scripts) {
  const found = [];
  for (const [name, command] of Object.entries(scripts ?? {})) {
    if (name.startsWith("//") || typeof command !== "string") continue;
    if (!/\bbun test\b/.test(command)) continue;
    found.push({ script: name, command });
  }
  return found;
}

// Swept iOS files hold no absolute font size; a literal that must stay goes in a `@ScaledMetric`
// (see ScaledFrame.swift). Vendored DerivedData and sizes inside comments are not counted.
export const SWEPT_FILES = [
  ["apps/ios/TelarMobile/Features/Transcript/TranscriptViews.swift", ""],
  ["apps/ios/TelarMobile/Features/Sessions/SessionView.swift", ""],
  ["apps/ios/TelarMobile/Features/Plugins/NotebookSurface.swift", ""],
  ["apps/ios/TelarMobile/Features/Plugins/CellOutputView.swift", ""],
  ["apps/ios/TelarMobile/Features/Git/DiffView.swift", ""],
  ["apps/ios/TelarMobile/Features/Files/FilesSurface.swift", ""],
  ["apps/ios/TelarMobile/Features/Sessions/SessionSidebar.swift", ""],
  ["apps/ios/TelarMobile/UI/RowStyles.swift", ""],
  ["apps/ios/TelarMobile/Features/Turns/RequestViews.swift", ""],
  ["apps/ios/TelarMobile/Features/Plugins/LatexSurface.swift", ""],
  ["apps/ios/TelarMobile/Features/Plugins/DataSurface.swift", ""],
  ["apps/ios/TelarMobile/Features/Sessions/NewConversationView.swift", ""],
  ["apps/ios/TelarMobile/Features/Sessions/NewConversationPicker.swift", ""],
  ["apps/ios/TelarMobile/Features/Projects/AddProjectView.swift", ""],
  ["apps/ios/TelarMobile/Features/Worktrees/BranchPickerSheet.swift", ""],
  ["apps/ios/TelarMobile/UI/SettingsKit.swift", ""],
  ["apps/ios/TelarMobile/Features/Remote/DevicesView.swift", ""],
  ["apps/ios/TelarMobile/Features/Usage/UsageView.swift", ""],
  ["apps/ios/TelarMobile/Features/Files/TextFileView.swift", ""],
  [
    "apps/ios/TelarMobile/Features/Hosts/WelcomeView.swift",
    "holds one `.system(size: wordmark)` that this check does NOT count, and should not: `wordmark` is a @ScaledMetric(relativeTo: .largeTitle) seeded with 40. 40 has no rung (the ramp stops at 34) and mapping it down would shrink the brand. #674 gave TelarMark the same treatment so the logo and the word keep their ratio",
  ],
  ["apps/ios/TelarMobile/Features/Plugins/TableSurface.swift", ""],
  [
    "apps/ios/TelarMobile/Features/Projects/ProjectAvatar.swift",
    "holds four `.system(size:)` calls this check does NOT count: each is a fraction of the caller's `size`, so the glyph is proportional to its own square by construction. They were never waiting on #674 and are finished as they stand — this entry is the only record of that, since no digit regex will re-find them",
  ],
  ["apps/ios/TelarMobile/Features/Panel/PanelView.swift", ""],
  ["apps/ios/TelarMobile/Features/Files/FileBody.swift", ""],
  ["apps/ios/TelarMobile/Features/Prompts/StashMenu.swift", ""],
  ["apps/ios/TelarMobile/Features/Sessions/AgentsSurface.swift", ""],
  ["apps/ios/TelarMobile/Features/Composer/AttachmentChip.swift", ""],
  [
    "apps/ios/TelarMobile/Features/Providers/ModelPill.swift",
    "holds one `.system(size: size * 0.65)` this check does NOT count, proportional to its own square like ProjectAvatar's. The pill's capsule takes a @ScaledMetric of its own (#674) so the badge grows with the label beside it",
  ],
  ["apps/ios/TelarMobile/Features/Plugins/HtmlOutputView.swift", ""],
  ["apps/ios/TelarMobile/Features/Dictation/DictationSettingsView.swift", ""],
  ["apps/ios/TelarMobile/Features/Dictation/DictationCaretPill.swift", ""],
  ["apps/ios/TelarMobile/UI/MarkdownText.swift", ""],
  // Not a view: a `Font` stored on the highlighter's theme, which is why it
  // is the one swept file outside `Views/`. A count scoped to `Views/` misses
  // it — the sweep's last site was very nearly its least visible.
  ["apps/ios/TelarMobile/UI/CodeHighlighter.swift", ""],
  ["apps/ios/TelarMobile/UI/ScaledFrame.swift", ""],
];

// Font-size spellings that do not scale: a digit after the colon is absolute, a property is not.
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
    // UIFont.systemFont(ofSize:) and its bold, italic and monospaced siblings.
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

// Not listed: `.custom(_:size:)` scales with the body style, so its literal is a seed, not a defect.
// Call-site size arguments are ios-mark-sizes' job.

// Line level on purpose: a file-level carve-out would let one UIFontMetrics hide every other literal.
const UIKIT_SCALING = /UIFontMetrics/;

/** Every absolute-size hit in one source file, already carved out. */
export function absoluteSizesIn(source) {
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

// Positive and negative controls for ABSOLUTE_SIZES; widen the patterns only with both kinds of row.
export const GUARD_SAMPLES = [
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
export function markSizeArguments(source) {
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
