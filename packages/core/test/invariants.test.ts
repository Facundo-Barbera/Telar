// THE LOAD-BEARING INVARIANTS, MADE EXECUTABLE (AD-19 / CAP-6 / NFR-X-14).
// AD-19's FIVE, plus INV-6 (AD-10), which story 2.1's AC6 added here by name.
//
// WHY THIS FILE EXISTS. brownfield.md states the gap in one sentence: "'No
// accept tool anywhere' and 'the verifier stack holds no write tools' are true
// today by construction and by review, but NOTHING RE-CHECKS THEM." There is no
// CI in this repo — declined at spine-authoring time (AD-19, SPEC.md non-goals)
// — so the only gate is the MANUAL pre-commit trio (`bun test`,
// `bunx tsc --noEmit` in both workspaces, `bun run lint` in web). AD-19 is the
// decision to put the five rules that cannot be allowed to quietly become false
// inside that trio. This file is that decision, executed.
//
// THE FIVE, in AC1's clause order. Note the AD numbers do NOT run in order —
// AD-19's own `Binds:` list reads AD-1, AD-2, AD-3, AD-5, AD-20 while the AC
// swaps the middle two, and mixing them up files two invariants under the wrong
// rule:
//   INV-1  no MCP surface exposes an accept tool ................... AD-1
//   INV-2  the verifier stack is granted no write or edit tools .... AD-2
//   INV-3  no module reads another module's TELAR_HOME subtree ..... AD-5
//   INV-4  client components import no core runtime ................ AD-3
//   INV-5  no module writes a shared runtime service's state ....... AD-20
//
// AND A SIXTH, WHICH AD-19 DOES NOT NAME — read the count above as "the five
// AD-19 names", not as "everything in this file". AD-19's list is closed
// because it enumerates the five rules that were load-bearing when the spine
// was written; it is not a ceiling on what may be made executable here.
//   INV-6  no SessionProfile field can widen a tool grant ........... AD-10
//   INV-7  no TEST reaches the operator's real state root ........... AD-5
//   INV-8  the Conversation shell owns no session semantics ......... AD-12, AD-13
// INV-6 arrived with story 2.1, whose AC6 says in as many words that "the
// invariant suite" is where that assertion belongs — and it belongs with the
// other five rather than beside the type it guards because it is the same KIND
// of claim: a structural rule that is true today by construction and that
// nothing would re-check. AD-10's failure mode is the moat "degrading from
// structural to configurable", and making session config into DATA is exactly
// the move that could cause it.
//
// INV-8 arrived with story 3.1 for the reason AD-19 itself gives. AD-12 (the
// Conversation shell's four slots, and the rule that a registered item renderer
// reads nothing from ambient context) and AD-13 (module-namespaced kind ids)
// are load-bearing and were checked by NOTHING. They were frozen precisely so
// epics 4, 5 and 6 could build owner adapters in parallel without coordinating,
// and two of story 3.1's acceptance criteria are claims about CODE SHAPE that no
// unit test can reach: with no DOM harness here, "this renderer reads no
// context" is provable only by a static scan. AD-19's own `Binds:` list does not
// name AD-12 — that is the gap, not a licence to leave it. INV-8's scope is
// deliberately narrow: components/conversation/** and session-view.tsx, never
// the whole tree.
//
// INV-7 is INV-3's MIRROR and arrived for a blunter reason: a test reaching the
// operator's real ~/.telar has now happened FOUR separate times in one run (the
// tally is in INV-7's own header). The fourth occurrence was story 2.2's code
// review catching it in the very story that was actively watching for the
// class, which is the argument: the rule has to stop being something people
// remember and start being something the suite enforces. Note the SCOPE
// INVERSION — INV-7 is the one violation scan in this file that reads *.test.ts
// and EXCLUDES production source, because a production module reaching the real
// reader is the product working.
//
// THE ANTI-VACUITY RULE, which is the most important thing in this file. Every
// invariant here is a source scan or a pinned inventory, and the characteristic
// failure of that shape is VACUOUS GREEN: a bad root path, a typo in a glob, an
// excluded directory — and the assertion now holds over the empty set, forever,
// silently. So every scan asserts a FLOOR on what it found (files walked, tool
// names collected, client components visited, edges traversed) BEFORE it
// asserts anything about violations, and every scan additionally carries a
// permanent positive control ("the scan discriminates") that feeds a synthetic
// fixture through the SAME code path the real scan uses and requires it to be
// reported. A scanner that stops matching — a regex edited, a parser rewritten
// — then fails immediately instead of going quietly green. The house precedent
// for both halves is apps/web/lib/state-root.test.ts's "the TELAR_HOME read
// idiom, across every source tree that resolves it" block.
//
// THE SELF-REFERENCE RULE. This file necessarily CONTAINS the literals it
// searches for. packages/core/test is one of the roots the index walks, so a
// violation scan that reused the whole index would report this scanner as a
// violator of every invariant at once. The resolution is two rules that are not
// the same rule:
//   - the FLOOR counts are asserted over the WHOLE index, so a broken walk fails;
//   - the VIOLATION sets are computed over a per-invariant FILTERED SCOPE, and
//     every one of those scopes excludes *.test.ts / *.test.tsx — including this
//     file. Do not "fix" that exclusion.
// INV-7 is the ONE exception, by construction: its subject IS the test files, so
// it scans this file too. That is deliberate and it is why its section carries
// its own editing rule — never write a reader-surface name immediately followed
// by `(` anywhere in here, in prose or in a template.
// The discriminator fixtures are passed as in-memory strings assembled at
// runtime rather than written as literal source, for the same reason.
//
// FAILURE MESSAGES (AC2). No test in this repo passes a message argument to
// `expect` (measured across all core suites), so that is not the house idiom
// whatever bun:test may support. Instead the DIAGNOSIS IS BUILT INTO THE
// ASSERTED VALUE: violation objects carry their own explanation, so the diff bun
// prints IS the message. Each carries, in order: the AD id, the rule in one
// clause, the consequence if it is false, and the actionable next step. The
// target reader is someone hitting this in six months with no context.
//
// COST (AC3). The source tree is walked ONCE into a cached in-memory index at
// module scope; all six invariants read that index. No tsc invocation, no
// spawned process (see §5.5-D8 of the story: a compile-time invariant must run
// the compiler over generated fixtures in BOTH directions, and this story has
// none — L4's `done`-not-assignable claim is already pinned by
// session-lease.test.ts's tsc test and is CITED there, not re-run).
//
// Set TELAR_INVARIANTS_VERBOSE=1 to print the full T-A0 inventory (every
// collected tool name, every path-composition site, both client-file counts,
// the BFS edge count) instead of the one-line summary.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

// ── the repo root ───────────────────────────────────────────────────────────
// Walk up until a directory holds BOTH bunfig.toml and packages/, and THROW at
// the filesystem root. A test that silently scans nothing is precisely the
// failure the anti-vacuity rule exists to prevent, and a wrong root is the
// cheapest way to get one.
function repoRoot(): string {
  let dir = import.meta.dir;
  for (;;) {
    if (
      fs.existsSync(path.join(dir, "bunfig.toml")) &&
      fs.existsSync(path.join(dir, "packages"))
    ) {
      return dir;
    }
    const up = path.dirname(dir);
    if (up === dir) {
      throw new Error(
        "invariants.test.ts: walked to the filesystem root without finding a directory holding " +
          "both bunfig.toml and packages/. The scan index would be empty and every invariant " +
          "below would hold vacuously. Fix the root resolution; do not relax the assertions.",
      );
    }
    dir = up;
  }
}

const REPO = repoRoot();

// ── the shared scan index (one walk, cached at module scope) ────────────────
type SourceFile = {
  rel: string; // repo-relative, POSIX separators
  abs: string;
  text: string; // verbatim source
  code: string; // source with comments blanked out (see stripComments)
  isClient: boolean; // by DIRECTIVE, never by substring — see the T-5 note below
};

// docs/ is deliberately NOT a root: it is prose, and it is STALE prose in
// exactly the places that matter (architecture-web.md still says lib/store.ts
// owns usage.ndjson, which story 1.1 moved into core). An invariant that scans
// prose fails on documentation of itself.
// `apps/web_old` is deliberately NOT a root. The legacy cockpit was frozen as a
// read-only design source for the Telar rebuild and retired from verification
// wholesale — no typecheck, no lint ceiling, no test suite, and no invariant.
// Every invariant that read it was retired WITH it in the same change rather
// than left pointing at the renamed tree, because an invariant over a frozen
// tree can only ever report that the freeze held. The retired set is named in
// the RETIRED-WITH-apps/web note below so a reader can see what stopped being
// checked and what has to come back when Telar grows the same surface.
//
// `apps/web` IN THIS FILE MEANS THE FROZEN TREE, which lives at `apps/web_old`
// today. Every path and note here was written while the legacy cockpit still
// held that name, and the rebuild has since taken it (`apps/vnext-web` →
// `apps/web`). They were left as written rather than rewritten to point at a
// tree nothing scans: a retired invariant is a record of what WAS checked, and
// silently repointing eighty-seven of them at the live app would read as though
// they still applied to it. Chase any `apps/web/...` path below under
// `apps/web_old/`.
const ROOTS = [
  "packages/core/src",
  "packages/core/test",
  "apps/desktop",
  "scripts",
];
const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs"]);
// Matched by DIRECTORY NAME anywhere in the path. `_bmad-output` is here for a
// reason of its own: it holds reference implementations preserved beside a SPEC,
// carrying the relative imports of the location they were written for. It is
// excluded from test discovery by bunfig.toml for the same reason, and scanning
// it would make an invariant fail on documentation.
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".next",
  ".next-desktop",
  ".next-build",
  "release",
  "dist",
  "build",
  ".git",
  "out",
  "coverage",
  "_bmad-output",
]);

// …AND A PATTERN BESIDE THE LIST, because Next's dist directory is CONFIGURABLE.
// `apps/web/next.config.ts` sets `distDir: process.env.NEXT_DIST_DIR ?? ".next"`
// and its own comments advertise `NEXT_DIST_DIR=.next-build` and
// `NEXT_DIST_DIR=.next-desktop` as the way to run a build beside a dev server.
// A list of literal names is therefore a list of the dist dirs somebody has
// already thought of. The moment a developer follows the config's own example
// with a name nobody added here, the walk reads minified build chunks and the
// scans over apps/web fail on them — INV-8c reports hundreds of pseudo-contexts
// (`creates React context "r"`) and a green gate turns red for a reason that has
// nothing to do with the code. (Not hypothetical: story 3.1's own code review
// produced exactly that with `NEXT_DIST_DIR=.next-review`.) So the rule is
// BOTH — the literal set above, plus any `.next-*` sibling of it. INV-8j
// re-derives the names the config advertises and fails if one is not covered.
// The separator is `[-.]`, NOT `-`, and the dot half was paid for in RAM. A
// `.next.bak` (the ordinary way anyone snapshots a dist dir before deleting it —
// `mv .next .next.bak`) matched neither the literal set nor `^\.next-`, so the
// walk descended into it and read 4,615 minified chunks / 1.09 GB of .js into
// the module-scope index — twice each, `text` plus comment-blanked `code`, as
// UTF-16 — before the scans ran their regexes over the result. Measured on
// 2026-08-04: 28 GB resident on a 16 GB machine, killed before it took the
// machine down. The failure is silent up to that point, which is why it reads as
// a hung test rather than a bad path.
const isExcludedDir = (name: string): boolean =>
  EXCLUDED_DIRS.has(name) || /^\.next[-.]/.test(name);

// ONE TOKENIZER, two uses. It walks source once and can blank comments, string
// contents, or both — length and line structure always preserved, so offsets
// still line up.
//
// WHY BLANK COMMENTS: a scan for a CALL SITE must not be tripped by prose that
// merely mentions it — panel.ts's header says "must inject an agent() call
// here", store.ts's says "route.ts's teardown always calls logUsage()", and a
// naive substring scan reads both as violations.
//
// WHY IT TRACKS REGEX LITERALS, which is not a nicety. `const isUrl =
// /^https?:\/\//;` contains the two-character sequence `//`. A tokenizer that
// knows only about quotes reads that as the start of a line comment and BLANKS
// THE REST OF THAT PHYSICAL LINE — so any `path.join(`, `logUsage(` or
// `releaseAdmission(` sharing the line becomes invisible to every scan that
// reads `.code`. Blanking real code is a much worse failure than missing a
// comment: it is silent, and it makes an invariant PASS.
//
// The remaining honest limit: `${…}` inside a template literal is treated as
// string content, not as code. Deciding regex-vs-division is the standard
// lookback heuristic (the preceding significant character or keyword); when it
// guesses wrong the literal is merely copied verbatim, which can only ever leave
// a scan seeing MORE text, never less.
const REGEX_PREV_CHARS = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^",
]);
const REGEX_PREV_KEYWORD =
  /(?:^|[^A-Za-z0-9_$])(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await|throw)$/;

function tokenize(text: string, blankComments: boolean, blankStrings: boolean): string {
  let out = "";
  let i = 0;
  const n = text.length;
  // The last few NON-WHITESPACE characters emitted, kept rolling so the
  // regex-vs-division decision is O(1) rather than a re-scan of `out`.
  let tail = "";
  const mark = (ch: string) => {
    tail = (tail + ch).slice(-24);
  };
  while (i < n) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        const d = text[i]!;
        if (d === "\\") {
          // Length AND line structure are preserved even when blanking: an
          // escaped newline stays a newline.
          const next = i + 1 < n ? text[i + 1]! : "";
          out += blankStrings ? (next === "\n" ? " \n" : " ".repeat(1 + next.length)) : d + next;
          i += 1 + next.length;
          continue;
        }
        if (d === quote) {
          out += d;
          i++;
          break;
        }
        if (d === "\n") {
          out += "\n";
          i++;
          if (quote !== "`") break; // unterminated: do not swallow the file
          continue;
        }
        out += blankStrings ? " " : d;
        i++;
      }
      mark(quote);
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") {
        out += blankComments ? " " : text[i]!;
        i++;
      }
      if (!blankComments) mark("/");
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (; i < stop; i++) out += text[i] === "\n" ? "\n" : blankComments ? " " : text[i]!;
      if (!blankComments) mark("/");
      continue;
    }
    if (c === "/") {
      const last = tail.slice(-1);
      const opensRegex = last === "" || REGEX_PREV_CHARS.has(last) || REGEX_PREV_KEYWORD.test(tail);
      if (opensRegex) {
        // A regex literal is CODE: copied verbatim whatever the flags say.
        out += c;
        i++;
        let inClass = false;
        while (i < n) {
          const d = text[i]!;
          if (d === "\n") break; // unterminated: bounded to one physical line
          out += d;
          i++;
          if (d === "\\") {
            if (i < n) {
              out += text[i]!;
              i++;
            }
            continue;
          }
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) break;
        }
        while (i < n && /[a-z]/.test(text[i]!)) {
          out += text[i]!;
          i++;
        }
        mark("/");
        continue;
      }
      out += c;
      i++;
      mark("/");
      continue;
    }
    out += c;
    i++;
    if (c > " ") mark(c);
  }
  return out;
}

const stripComments = (text: string): string => tokenize(text, true, false);

// String CONTENTS blanked, quotes and length kept. Used where the question is
// "does this file DO x" rather than "does it mention x": a thrown error that
// says `"caller must supply restrictTools: true"` documents the wall, it does
// not mint a capability, and an invariant that fires on correct code gets
// deleted rather than fixed.
const stripStringLiterals = (code: string): string => tokenize(code, true, true);

// T-5 — "use client" appears INSIDE COMMENTS in this repo, and the difference is
// not academic: apps/web/lib/permissions.ts discusses the boundary in a comment
// and imports node:fs / node:os / node:path / node:crypto, so a substring match
// reports a SERVER-ONLY module as a client component and INV-4 fails on today's
// tree for a reason that is not a violation. The mirror-image hazard is
// components/looms/godview.ts, which contains the phrase, is NOT a client file,
// and is the one file whose transitive obligation matters most. So: detect the
// DIRECTIVE — the first non-comment, non-blank statement — never the substring.
function firstStatement(text: string): string {
  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      if (nl === -1) return "";
      i = nl + 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i);
      if (end === -1) return "";
      i = end + 2;
      continue;
    }
    break;
  }
  return text.slice(i, i + 48);
}

const hasUseClientDirective = (text: string): boolean =>
  /^["']use client["']/.test(firstStatement(text));

function walk(rootRel: string, into: SourceFile[]): void {
  const rootAbs = path.join(REPO, rootRel);
  if (!fs.existsSync(rootAbs)) return;
  const stack = [rootAbs];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (isExcludedDir(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!EXTENSIONS.has(path.extname(entry.name))) continue;
      const text = fs.readFileSync(abs, "utf8");
      into.push({
        rel: path.relative(REPO, abs).split(path.sep).join("/"),
        abs,
        text,
        code: stripComments(text),
        isClient: hasUseClientDirective(text),
      });
    }
  }
}

// ONE real, scannable file from inside a tree the walk is supposed to skip,
// located on disk at test time. INDEX-1 uses it as a positive control: without
// it, "nothing leaked" is satisfied by an index that never looked. Bounded — it
// stops at the first hit and gives up after a fixed number of directories.
function firstScannableUnder(rootAbs: string): string | null {
  const stack = [rootAbs];
  let budget = 500;
  while (stack.length && budget-- > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
        return path.relative(REPO, abs).split(path.sep).join("/");
      }
    }
  }
  return null;
}

const INDEX: SourceFile[] = (() => {
  const files: SourceFile[] = [];
  for (const root of ROOTS) walk(root, files);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return files;
})();

const byRel = new Map(INDEX.map((f) => [f.rel, f]));
const isTestFile = (rel: string): boolean => /\.test\.tsx?$/.test(rel);
// EVERY violation scan runs over this, never over the whole index — see the
// self-reference rule in the header. This file is a *.test.ts, so it excludes
// itself, which is the only reason the scanner can search for the literals it
// is made of.
const NON_TEST = INDEX.filter((f) => !isTestFile(f.rel));

// The substring count exists only so the T-A0 inventory can report BOTH numbers
// and a reader can see the directive check is doing real work.
const SUBSTRING_USE_CLIENT = INDEX.filter(
  (f) => f.rel.startsWith("apps/web/") && f.text.includes("use client"),
).length;
const CLIENT_FILES = INDEX.filter((f) => f.isClient);
const MCP_FILENAMES = INDEX.filter(
  (f) => /\/[^/]*-mcp\.ts$/.test(f.rel) && !isTestFile(f.rel),
);
const CORE_FILES = INDEX.filter((f) => f.rel.startsWith("packages/core/"));

// ── shared extraction primitives ────────────────────────────────────────────
// Each of these is called BOTH by the real scan and by that invariant's
// discriminator fixture. A discriminator that called a different function would
// prove nothing, so they are functions of a source STRING, never of a file.

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// AN IMPORT RENAME IS A ONE-TOKEN HOLE IN THIS WHOLE INVARIANT, so both
// extractors below take the local BINDING NAMES rather than assuming the
// canonical spelling. `import { createSdkMcpServer as makeServer }` used to be
// enough for a fourth MCP surface never to enter MCP_SURFACES at all — INV-1a's
// "exactly the three we know about" would still pass while an agent-callable
// accept tool shipped behind a green moat test.
const MCP_SDK = "@anthropic-ai/claude-agent-sdk";
const MCP_FACTORY = "createSdkMcpServer";
const TOOL_FACTORY = "tool";
const fromMcpSdk = (spec: string): boolean => spec === MCP_SDK;

// Local names bound to an SDK export in this file, canonical spelling included.
function sdkBindings(source: string, exported: string): string[] {
  const names = new Set([exported]);
  if (!source.includes(exported)) return [...names];
  for (const local of localNamesFor(source, exported, fromMcpSdk).direct) names.add(local);
  return [...names];
}

// Every `tool("<name>", …)` first string-literal argument, under any binding.
// The negative lookbehind keeps `createTool(`, `.tool(` and `mockTool(` out.
// Hits are returned in SOURCE ORDER across bindings, because the pinned
// inventory below is compared as an ordered list.
function toolNameLiterals(source: string, bindings: string[] = [TOOL_FACTORY]): string[] {
  const hits: Array<{ at: number; name: string }> = [];
  for (const binding of bindings) {
    const re = new RegExp(
      `(?<![A-Za-z0-9_$.])${escapeRe(binding)}\\s*\\(\\s*(["'])((?:\\\\.|(?!\\1).)*)\\1`,
      "g",
    );
    for (let m = re.exec(source); m; m = re.exec(source)) hits.push({ at: m.index, name: m[2]! });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.name);
}

// Every `createSdkMcpServer({ name: "<server>" … })`, under any binding. All
// three call sites in the repo put `name` first; if that ever changes, the
// pinned inventory below fails loudly rather than silently dropping a surface.
function mcpServerNameLiterals(source: string, bindings: string[] = [MCP_FACTORY]): string[] {
  const hits: Array<{ at: number; name: string }> = [];
  for (const binding of bindings) {
    const re = new RegExp(
      `(?<![A-Za-z0-9_$.])${escapeRe(binding)}\\s*\\(\\s*\\{\\s*name\\s*:\\s*(["'])([^"']+)\\1`,
      "g",
    );
    for (let m = re.exec(source); m; m = re.exec(source)) hits.push({ at: m.index, name: m[2]! });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.name);
}

// Does this file stand up an MCP server under ANY binding? The cheap substring
// gate is not a shortcut that reintroduces the hole: a file that binds the
// factory must NAME it in the import statement to rename it.
function callsMcpFactory(source: string): boolean {
  if (!source.includes(MCP_FACTORY)) return false;
  return sdkBindings(source, MCP_FACTORY).some((n) =>
    new RegExp(`(?<![A-Za-z0-9_$.])${escapeRe(n)}\\s*\\(`).test(source),
  );
}

// The belt to the pinned inventory's braces (the inventory is the actual
// mechanism — a substring deny-list alone would let `mark_delivered` through if
// it were only checked as a whole word). Tokens are matched by STEM so
// "delivered"/"completed"/"accepting" cannot walk past a whole-word check.
// This is the ONLY assertion that judges a tool name on its own semantic merits
// — INV-1b merely requires that a human added the name to MCP_INVENTORY — so the
// ordinary English synonyms for "accept" belong here too. `finish_loom` is a
// name someone would plausibly write, and without `finish` it registers, gets
// pinned per this file's own ADDING_A_TOOL instructions, and the one semantic
// gate on the Human-Accept Moat says nothing.
const ACCEPT_STEMS = [
  "accept",
  "approve",
  "done",
  "complete",
  "land",
  "merge",
  "ship",
  "deliver",
  "finalize",
  "promote",
  "finish",
  "resolve",
  "close",
  "confirm",
  "sign",
  "ack",
  "clear",
];
function acceptShapedTokens(toolName: string): string[] {
  return toolName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase())
    .filter((t) => ACCEPT_STEMS.some((stem) => t.startsWith(stem)));
}

// Whole import STATEMENTS, not lines. T-4: nearly every @telar/core import in
// apps/web spans five or more lines, so a line-based check sees
// `} from "@telar/core";`, finds no `type` keyword, and reports EVERY COMPLIANT
// FILE as a violation. The inverse error is just as bad: "does the file contain
// `import type` and `@telar/core`" passes a file that has one of each.
function importStatements(source: string): string[] {
  const lines = source.split("\n");
  const out: string[] = [];
  const complete = (s: string): boolean =>
    /\bfrom\s*["'][^"']+["']/.test(s) || /^\s*import\s*["'][^"']+["']/.test(s);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*import[\s{*"']/.test(lines[i]!)) continue;
    let stmt = lines[i]!;
    let lookahead = 0;
    while (!complete(stmt) && i + 1 < lines.length && lookahead < 80) {
      i++;
      lookahead++;
      stmt += "\n" + lines[i]!;
    }
    if (complete(stmt)) out.push(stmt);
  }
  return out;
}

// `export { X } from "./y"` and `export * from "./y"` are MODULE EDGES exactly
// as imports are, and a scan anchored on the word `import` is blind to them.
// That blindness is not theoretical: a shim whose entire contents are
// `export { logUsage } from "@telar/core";`, value-imported by a "use client"
// component, drags core's runtime barrel into the browser bundle with no
// `import` line in it for INV-4 to find. This file already proves it knows the
// construct exists — INV-5c asserts store.ts contains exactly that shape.
function reExportStatements(source: string): string[] {
  const lines = source.split("\n");
  const out: string[] = [];
  const complete = (s: string): boolean => /\bfrom\s*["'][^"']+["']/.test(s);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*export\s+(?:type\s+)?[{*]/.test(lines[i]!)) continue;
    let stmt = lines[i]!;
    let lookahead = 0;
    // A LOCAL `export { a, b };` has no `from` and must not run away looking
    // for one on a later line, so accumulation stops at the first `;`.
    while (!complete(stmt) && !stmt.includes(";") && i + 1 < lines.length && lookahead < 80) {
      i++;
      lookahead++;
      stmt += "\n" + lines[i]!;
    }
    if (complete(stmt)) out.push(stmt);
  }
  return out;
}

// Both kinds, which is what a graph traversal wants.
const moduleEdgeStatements = (source: string): string[] => [
  ...importStatements(source),
  ...reExportStatements(source),
];

function importSource(statement: string): string | null {
  const m = /["']([^"']+)["']\s*;?\s*$/.exec(statement.trim());
  return m ? m[1]! : null;
}

// What an import/export-from statement actually BINDS, with renames resolved.
// A scan that only looks for the exported NAME in the statement text is defeated
// by `import { acceptLoom as land }` and by `import * as admission`, and both
// forms are exactly the ones an invariant about "who can call this" must see.
type EdgeBinding = { imported: string; local: string; typeOnly: boolean; namespace: boolean };
function edgeBindings(statement: string): EdgeBinding[] {
  const fromAt = statement.search(/\bfrom\b/);
  const head = (fromAt === -1 ? statement : statement.slice(0, fromAt)).replace(/\n/g, " ");
  const kw = /\b(import|export)\b/.exec(head);
  if (!kw) return [];
  let body = head.slice(kw.index + kw[0].length);
  const headTypeOnly = /^\s*type\b/.test(body);
  if (headTypeOnly) body = body.replace(/^\s*type\b/, "");
  const ns = /^\s*\*\s*as\s+([A-Za-z0-9_$]+)/.exec(body);
  if (ns) return [{ imported: "*", local: ns[1]!, typeOnly: headTypeOnly, namespace: true }];
  // `export * from "…"` — every export forwarded, no local binding.
  if (/^\s*\*/.test(body)) {
    return [{ imported: "*", local: "*", typeOnly: headTypeOnly, namespace: true }];
  }
  const out: EdgeBinding[] = [];
  const open = body.indexOf("{");
  const close = body.lastIndexOf("}");
  const beforeBrace = (open === -1 ? body : body.slice(0, open)).replace(/,\s*$/, "").trim();
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(beforeBrace)) {
    out.push({ imported: "default", local: beforeBrace, typeOnly: headTypeOnly, namespace: false });
  }
  if (open !== -1 && close > open) {
    for (const raw of body.slice(open + 1, close).split(",")) {
      const spec = raw.trim();
      if (!spec) continue;
      const typeOnly = headTypeOnly || /^type\s/.test(spec);
      const m = /^(?:type\s+)?([A-Za-z0-9_$]+)(?:\s+as\s+([A-Za-z0-9_$]+))?$/.exec(spec);
      if (!m) continue;
      out.push({ imported: m[1]!, local: m[2] ?? m[1]!, typeOnly, namespace: false });
    }
  }
  return out;
}

// Every local name in `source` that is bound to `exported` from a module the
// predicate accepts, plus every namespace binding of such a module. Renames and
// `import * as ns` both land here, which is the point.
function localNamesFor(
  source: string,
  exported: string,
  fromModule: (spec: string) => boolean,
): { direct: string[]; namespaces: string[] } {
  const direct: string[] = [];
  const namespaces: string[] = [];
  for (const stmt of moduleEdgeStatements(source)) {
    const spec = importSource(stmt);
    if (!spec || !fromModule(spec)) continue;
    for (const b of edgeBindings(stmt)) {
      if (b.typeOnly) continue;
      if (b.namespace && b.local !== "*") namespaces.push(b.local);
      else if (b.imported === exported) direct.push(b.local);
    }
  }
  return { direct, namespaces };
}

// True for the CORE PACKAGE SPECIFIER and its subpaths, and for nothing else.
//
// IT DELIBERATELY DOES NOT MATCH RELATIVE PATHS, which is what its two callers
// depend on and is easy to "fix" wrongly:
//   - INV-1e asks for every module that imports `acceptLoom` FROM THE PACKAGE.
//     Widening this to relative specifiers would pull in core's own intra-package
//     edges and turn a precise empty-set assertion into noise.
//   - INV-5f composes it as `isCoreSpecifier(spec) || /(^|\/)<module>$/` — the
//     second arm is what handles `./admission` and `../src/admission`. Widening
//     the first arm makes the second unreachable and the pair meaningless.
//
// THIS FUNCTION WAS RECONSTRUCTED, not moved. It was declared inside INV-4's
// block and was deleted with it before anyone noticed INV-1e and INV-5f also
// called it; both failed with a ReferenceError. Its behaviour is re-derived from
// those two call sites, so if a third caller ever wants relative-path matching,
// it takes a NEW predicate rather than an edit here.
function isCoreSpecifier(spec: string): boolean {
  return spec === "@telar/core" || spec.startsWith("@telar/core/");
}

// A type-only edge is ERASED at build and cannot smuggle runtime. Accepted only
// if the statement opens `import type` / `export type`, or every specifier
// inside the braces is individually prefixed `type `. A default binding, a
// namespace binding, a bare `export * from` and a side-effect `import "x"` are
// all VALUE edges whatever the braces say. Applies to `export … from` as well as
// to `import` — same erasure question, same answer.
function isTypeOnlyImport(statement: string): boolean {
  const bindings = edgeBindings(statement);
  if (bindings.length === 0) return false;
  return bindings.every((b) => b.typeOnly);
}

// A TELAR_HOME path-composition site: `path.join(<root resolver>(), "<literal>")`.
// The assertable unit for AD-5 is the composition site, NOT the resolver —
// newer code deliberately IMPORTS telarDir instead of re-deriving it
// (sessions.ts says so in-source), so nine core modules reach the root without
// containing a resolver at all.
const ROOT_RESOLVERS = ["telarDir", "stateRoot", "telarHome", "home"];
type CompositionSite = { resolver: string; composes: string };
// TWO SHAPES, because composing off the root by template is composing off the
// root: `${telarDir()}/looms/<id>/spec.json` is a textbook AD-5 cross-module
// read by path, and a path.join-only matcher leaves the 19-site inventory
// unchanged while it happens. INV-5's sibling helper composesStateFile already
// handled the template form, so the asymmetry was internal to this file.
// `resolvers` is per-file so an ALIASED resolver (`import { telarDir as root }`)
// cannot walk past the check either.
function rootCompositionSites(
  source: string,
  resolvers: readonly string[] = ROOT_RESOLVERS,
): CompositionSite[] {
  const alt = resolvers.map(escapeRe).join("|");
  const hits: Array<{ at: number; site: CompositionSite }> = [];
  const joined = new RegExp(
    `path\\.join\\(\\s*(${alt})\\(\\)\\s*,\\s*(["'\`])([^"'\`]*)\\2`,
    "g",
  );
  for (let m = joined.exec(source); m; m = joined.exec(source)) {
    hits.push({ at: m.index, site: { resolver: m[1]!, composes: m[3]! } });
  }
  const templated = new RegExp(`\\$\\{\\s*(${alt})\\(\\)\\s*\\}/([A-Za-z0-9_.\\-]+)`, "g");
  for (let m = templated.exec(source); m; m = templated.exec(source)) {
    hits.push({ at: m.index, site: { resolver: m[1]!, composes: m[2]! } });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.site);
}

// The resolver spellings LIVE IN THIS FILE, so a rename at the import site is
// invisible to a fixed list: `import { telarDir as root }` then
// `path.join(root(), "sessions")` composes another module's subtree and reports
// nothing. Canonical names always included; short-circuits on files that never
// mention one.
function resolverNamesIn(source: string): string[] {
  const names = new Set<string>(ROOT_RESOLVERS);
  if (!ROOT_RESOLVERS.some((r) => source.includes(r))) return [...names];
  for (const stmt of moduleEdgeStatements(source)) {
    for (const b of edgeBindings(stmt)) {
      if (!b.typeOnly && !b.namespace && ROOT_RESOLVERS.includes(b.imported)) names.add(b.local);
    }
  }
  return [...names];
}

// A module deriving the state root FROM SCRATCH: `path.join(os.homedir(), ".telar")`.
// Sanctioned only inside the five known resolvers. servers.ts's
// `path.join(root, ".telar", …)` is a PROJECT-local .telar and must never be
// swept up, which is why this matches on homedir() specifically. The `os.`
// prefix is optional so a `import { homedir } from "node:os"` spelling is not a
// free pass.
function homeRootDerivations(source: string): number {
  const re = /path\.join\(\s*(?:os\.)?homedir\(\)\s*,\s*(["'])\.telar\1/g;
  let n = 0;
  for (let m = re.exec(source); m; m = re.exec(source)) n++;
  return n;
}

// ── the T-A0 inventory ──────────────────────────────────────────────────────
const VERBOSE = !!process.env.TELAR_INVARIANTS_VERBOSE?.trim();
const line = (s: string) => console.log(`[invariants] ${s}`);

const MCP_SURFACES = NON_TEST.filter((f) => callsMcpFactory(f.code));
const COMPOSITION_SITES: { file: string; site: CompositionSite }[] = [];
for (const f of NON_TEST) {
  for (const site of rootCompositionSites(f.code, resolverNamesIn(f.code))) {
    COMPOSITION_SITES.push({ file: f.rel, site });
  }
}
const HOME_DERIVERS = NON_TEST.filter((f) => homeRootDerivations(f.code) > 0).map((f) => f.rel);

line(
  `index: ${INDEX.length} files walked · ${CLIENT_FILES.length} "use client" by directive ` +
    `(${SUBSTRING_USE_CLIENT} by substring) · ${CORE_FILES.length} under packages/core · ` +
    `${MCP_FILENAMES.length} *-mcp.ts`,
);
line(
  `inventory: ${MCP_SURFACES.length} MCP surfaces · ${COMPOSITION_SITES.length} root-composition sites · ` +
    `${HOME_DERIVERS.length} home-root derivations`,
);
if (VERBOSE) {
  for (const f of MCP_SURFACES) {
    line(
      `  mcp ${f.rel}: servers=` +
        `${JSON.stringify(mcpServerNameLiterals(f.code, sdkBindings(f.code, MCP_FACTORY)))} ` +
        `tools=${JSON.stringify(toolNameLiterals(f.code, sdkBindings(f.code, TOOL_FACTORY)))}`,
    );
  }
  for (const c of COMPOSITION_SITES) {
    line(`  path ${c.file}: path.join(${c.site.resolver}(), "${c.site.composes}")`);
  }
  for (const d of HOME_DERIVERS) line(`  home-root derived in ${d}`);
  const substringOnly = INDEX.filter(
    (f) => f.rel.startsWith("apps/web/") && f.text.includes("use client") && !f.isClient,
  ).map((f) => f.rel);
  line(`  "use client" substring-but-not-directive: ${JSON.stringify(substringOnly)}`);
}

// ── T-A0: the index itself, before any invariant reads it ───────────────────
describe("the scan index — T-A0, asserted before any invariant so a broken walk cannot pass", () => {
  test("INDEX-0 the four anti-vacuity floors hold, so no invariant below is asserting over the empty set", () => {
    // These are LOWER BOUNDS to re-measure, never equalities: the tree grows.
    // Every message says the INDEX is broken rather than that a rule is
    // violated, because that is what a failure here actually means.
    // RE-MEASURED WHEN apps/web WAS RETIRED. The walk covered 776 files across
    // five roots; with the legacy cockpit removed from ROOTS it covers 228
    // across four. The floor moved 400 → 200 to match, and it is the ONLY floor
    // that moved by re-measurement rather than by deletion.
    //
    // TWO FLOORS WERE DELETED OUTRIGHT, and neither may be restored as-is:
    //   - the "use client" floor (was 100). Every client component in this repo
    //     lived in apps/web; the remaining roots hold ONE. A floor of 100 could
    //     not be met and a floor of 1 would assert nothing, so INV-4 was retired
    //     WITH the tree it scanned rather than left holding vacuously.
    //   - the *-mcp.ts floor (was 2: loom-mcp.ts, ultra-mcp.ts). Both files, and
    //     the other two MCP surfaces, were apps/web modules. ZERO remain, which
    //     is why INV-1a/b/c are retired too.
    // When Telar grows its own client components or MCP surfaces, restore these
    // floors AND the invariants they guard — a floor without its invariant is
    // just a file count.
    const broken: string[] = [];
    if (INDEX.length < 200) {
      broken.push(
        `only ${INDEX.length} files walked (floor 200) — the scan index is BROKEN, not the tree. ` +
          `Every invariant below reads this index, so they would all hold vacuously. ` +
          `Check ROOTS, EXTENSIONS and EXCLUDED_DIRS against ${REPO}.`,
      );
    }
    if (CORE_FILES.length < 100) {
      broken.push(
        `only ${CORE_FILES.length} files under packages/core (floor 100) — the walk is not ` +
          `reaching packages/core/src or packages/core/test. INV-2 and INV-5 scan there.`,
      );
    }
    expect(broken).toEqual([]);
  });

  test("INDEX-1 the excluded trees are genuinely absent, and _bmad-output is one of them", () => {
    // _bmad-output holds a preserved reference implementation whose imports
    // belong to another location; bunfig.toml excludes it from test discovery
    // for the same reason. Scanning it would report violations in documentation.
    //
    // SPELLED INDEPENDENTLY OF EXCLUDED_DIRS, and that is the whole point of
    // this test. Deriving the check from the same set walk() skipped with makes
    // `leaked` empty BY CONSTRUCTION: typo "node_modules" to "node_module" and
    // walk() indexes tens of thousands of third-party files while the test whose
    // stated purpose is to catch exactly that still passes. In the file whose
    // thesis is anti-vacuity, that is the one shape not to ship.
    const MUST_NOT_BE_INDEXED = [
      "node_modules",
      ".next",
      ".next-desktop",
      "release",
      "dist",
      "build",
      ".git",
      "out",
      "coverage",
      "_bmad-output",
    ];
    const leaked = INDEX.filter((f) =>
      f.rel.split("/").some((seg) => MUST_NOT_BE_INDEXED.includes(seg)),
    ).map((f) => f.rel);
    expect(leaked).toEqual([]);
    // A CEILING as well as INDEX-0's floor. node_modules alone is tens of
    // thousands of scannable files, so a broken exclusion blows past this even
    // if some future rename slips past the list above. Raise it deliberately
    // when the tree really grows; do not raise it to make a red test green.
    expect(INDEX.length).toBeLessThan(2000);
    // …and the exclusion is load-bearing: those trees really do exist on disk,
    // WITH REAL SCANNABLE FILES IN THEM, and a named one really is absent from
    // the index. That is the positive control the derived-set version lacked.
    expect(fs.existsSync(path.join(REPO, "_bmad-output"))).toBe(true);
    expect(fs.existsSync(path.join(REPO, "node_modules"))).toBe(true);
    const control = firstScannableUnder(path.join(REPO, "_bmad-output"));
    expect(control).not.toBe(null);
    expect(byRel.has(control!)).toBe(false);
  });

  test("INDEX-2 the index DISCRIMINATES — the directive detector fires on a directive and not on prose", () => {
    // The permanent positive control for the one classification every other
    // invariant depends on. Fed through the SAME function the walk uses.
    expect(hasUseClientDirective('"use client";\nexport const A = 1;\n')).toBe(true);
    expect(hasUseClientDirective("'use client';\n")).toBe(true);
    expect(
      hasUseClientDirective('// a comment about "use client"\n"use client";\nexport {};\n'),
    ).toBe(true);
    // The permissions.ts shape: the phrase in prose, no directive, node: imports.
    expect(
      hasUseClientDirective('// never imported by a "use client" component\nimport fs from "node:fs";\n'),
    ).toBe(false);
    expect(hasUseClientDirective('/* "use client" */\nimport fs from "node:fs";\n')).toBe(false);
    expect(hasUseClientDirective('import fs from "node:fs";\n// "use client"\n')).toBe(false);
  });

  test("INDEX-3 stripComments blanks prose without eating code, so a call-site scan is not tripped by a mention", () => {
    // panel.ts's header says "must inject an agent() call here"; store.ts's says
    // "route.ts's teardown always calls logUsage()". Both are prose. Without
    // this, INV-2 and INV-5 would each report a comment as a violation.
    expect(stripComments('const a = 1; // calls logUsage(\n').includes("logUsage(")).toBe(false);
    expect(stripComments('/* agent( */ const b = 2;\n').includes("agent(")).toBe(false);
    expect(stripComments('const c = "https://example.com";\n')).toContain("https://example.com");
    expect(stripComments('const d = tool("keep_me");\n')).toContain('tool("keep_me")');
    // Length is preserved, so nothing downstream can be thrown off by offsets.
    const src = 'const e = 1; // gone\nconst f = 2;\n';
    expect(stripComments(src).length).toBe(src.length);
  });

  test("INDEX-4 stripComments knows a regex literal from a comment, so it cannot BLANK REAL CODE", () => {
    // The sharper half of the same hazard, and the reason it outranks "misses a
    // comment": `/^https?:\/\//` contains the two-character sequence `//`. A
    // quote-only tokenizer reads that as a line comment and blanks the REST OF
    // THE PHYSICAL LINE, so every call site sharing the line disappears from
    // `.code` — and a scan that sees nothing PASSES.
    const g = String.fromCharCode(47); // "/", assembled so this fixture is not
    const url = `const isUrl = ${g}^https?:\\${g}\\${g}${g}; logUsage({ ts: 1 });`;
    expect(stripComments(url)).toContain("logUsage({ ts: 1 })");
    // A character class holding the delimiter does not end the literal early.
    const cls = `const re = ${g}[^${g}]+${g}g; path.join(telarDir(), "looms");`;
    expect(stripComments(cls)).toContain('path.join(telarDir(), "looms")');
    // …and division is still division: a real trailing comment after one is
    // still blanked, so the regex support did not cost the comment support.
    expect(stripComments("const r = a / b; // calls logUsage(\n")).not.toContain("logUsage(");
    expect(stripComments("const r = a / b;\n")).toContain("a / b");
    expect(stripComments(url).length).toBe(url.length);
  });

  test("INDEX-5 stripStringLiterals blanks what a file SAYS while keeping what it DOES", () => {
    // INV-2's marker scan runs over this. A file that throws
    // `new Error("caller must supply restrictTools: true")` DOCUMENTS the wall;
    // it mints no capability, and an invariant that fires on correct code gets
    // deleted rather than fixed.
    const marker = "restrict" + "Tools";
    expect(stripStringLiterals(`throw new Error("must supply ${marker}: true");`)).not.toContain(
      marker,
    );
    expect(stripStringLiterals(`const o = { ${marker}: true };`)).toContain(marker);
    // Quotes, length and line structure survive, so nothing downstream shifts.
    const src = 'const a = "one";\nconst b = 2;\n';
    expect(stripStringLiterals(src).length).toBe(src.length);
    expect(stripStringLiterals(src).split("\n").length).toBe(src.split("\n").length);
  });
});

// ── INV-1 — no MCP surface exposes an accept tool (AD-1 / NFR-X-1) ──────────
// AD-1 says the moat is ENFORCED TWICE — "by construction in packages/core
// (looms.ts, tick.ts) and at the tool layer by the chat route's PreToolUse
// hook" — so this invariant has THREE parts, not one. Today the whole rule is
// enforced by prose only (docs/integration-architecture.md: "No route or MCP
// tool lets a model call acceptLoom"); no test anywhere enumerates the MCP
// surface and asserts no accept tool. That is the gap.
//
// SCOPE, and the honest limit, stated because an invariant that silently claims
// more than it proves is the same defect as a vacuous scan:
// packages/core/src/mcp.ts's resolveProjectMcpServers mounts PER-PROJECT,
// EXTERNALLY CONFIGURED MCP servers into the route's mcpServers map. Their tools
// live outside this repo and cannot be statically enumerated. This invariant
// therefore bounds TELAR'S OWN surfaces; external servers are governed by
// `strictMcpConfig: true` and the PreToolUse hook, not by this test.
//
// Static extraction is safe here and that is a MEASURED fact, not an
// assumption: in all three servers every name is a bare string literal passed
// as tool(name, description, shape, handler) inside a literal `tools: [...]`
// array — no loop, no spread of a config-driven list, no template. The runtime
// alternative exists and is cited rather than used: apps/web/lib/ultra-mcp.test.ts's
// "registers exactly ultra / ultra_status / ultra_stop, matching ULTRA_AUTO_TOOLS"
// enumerates server.instance._registeredTools exhaustively for ONE server. A
// static scan covers all three from packages/core/test without importing an
// apps/web module and without depending on a private field.
const LOOM_MCP = "apps/web/lib/loom-mcp.ts";
const BROWSER_MCP = "apps/web/lib/browser-mcp.ts";
const ULTRA_MCP = "apps/web/lib/ultra-mcp.ts";
const WORKSPACE_MCP = "apps/web/lib/workspace-mcp.ts";
const ENGINE = "packages/core/src/engine.ts";
const LOOMS = "packages/core/src/looms.ts";
const TICK = "packages/core/src/tick.ts";
const CHAT_ROUTE = "apps/web/app/api/chat/route.ts";
// The PreToolUse guardrail's own module — AD-1's tool-layer half. Lifted out of
// the route so its closure surface is a signature rather than a 2,500-line
// scope; INV-1g checks the guard HERE and the wiring in the route.
const CHAT_TURN_HOOKS = "apps/web/lib/server/turn-hooks.ts";
const ACCEPT_ROUTE = "apps/web/app/api/looms/[id]/accept/route.ts";

// THE PINNED INVENTORY. A new tool fails this test until someone adds it here
// deliberately — that IS the mechanism, and the failure message says so. Pinning
// is a maintenance cost and the cost is the point: the deny-list below is the
// belt, but a name like `mark_delivered` is exactly what a pattern walks past.
const MCP_INVENTORY: Record<string, { file: string; tools: string[] }> = {
  browser: {
    file: BROWSER_MCP,
    tools: [
      // Read-only by construction: it lists open tabs and changes nothing —
      // it is in BROWSER_READ_TOOLS, and `browser_tabs` remains the only tool
      // that can create/close/select. AD-1 confirmed: a tab listing cannot move
      // a loom from ready to done, and cannot reach the loom surface at all.
      "browser_list_tabs",
      "browser_tabs",
      "browser_navigate",
      "browser_navigate_back",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_fill_form",
      "browser_select_option",
      "browser_press_key",
      "browser_hover",
      "browser_take_screenshot",
      "browser_console_messages",
      "browser_network_requests",
    ],
  },
  loom: {
    file: LOOM_MCP,
    tools: [
      "draft_bundle_file",
      "propose_contract",
      "read_bundle",
      "list_looms",
      "get_loom",
      "start_loom",
      "steer_loom",
      "reject_loom",
      "answer_loom",
      "answer_blocked",
      "resume_loom",
      "cancel_loom",
      "watch_loom",
    ],
  },
  // ORDERED, like every other row here: registration order in ultra-mcp.ts.
  // `ultra_inspect` is last because it was added last — it reads a run's own
  // journal and per-agent transcripts, which were written from the start and
  // reachable by nothing.
  ultra: { file: ULTRA_MCP, tools: ["ultra", "ultra_status", "ultra_stop", "ultra_inspect"] },
  // Story 5.1 — the workspace item store's tool surface, the ONLY path a session
  // has to TELAR_HOME/workspace. THE ORDER IS THE REGISTRATION ORDER and this
  // list is compared as an ORDERED one, which is deliberate here: the same four
  // names in the same sequence appear in core's WORKSPACE_AUTO_TOOL_NAMES, in
  // @/lib/workspace-mcp's WORKSPACE_AUTO_TOOLS, and in the tools[] array itself,
  // and session-profiles.test.ts pins the first two against each other unsorted
  // for exactly that reason.
  //
  // NONE OF THE FOUR IS AN ACCEPT PATH, and INV-1c below judges that
  // semantically rather than taking this comment's word for it. The near misses
  // are close enough to be worth naming: promote_subtask (NFR-OW-15 forbids an
  // agent promotion path AND `promote` is an ACCEPT_STEM), close_lane,
  // land_packet, merge_lane, mark_completed and list_deliverables all fail.
  //
  // STORY 5.5 ADDED A FIFTH, `weave_batch`, AND IT IS THE FIRST TOOL ON THIS
  // SERVER THAT IS NOT PRE-APPROVED. So the inventory (5) and
  // WORKSPACE_AUTO_TOOLS (still 4) deliberately DISAGREE by exactly that one
  // name — INV-11c below asserts the difference IS the moat tool rather than
  // letting the two lists drift apart quietly. It is not an accept path: a
  // weave plans a DRAFT loom and marks the rows that track it; the rows stay in
  // the queue and leave only when the loom lands and the human accepts.
  //
  // STORY 5.8 ADDED A SIXTH, `consult_expert` (CAP-9), and it goes on the
  // AUTO side: it asks the item's own project expert to re-read the packet and
  // writes back a brief, an advisory verdict and timeline events — all
  // proposals, none of them a state transition. `weave_batch` stays last,
  // which keeps "the auto list is the inventory MINUS the one gated name" a
  // suffix relation the arm below can compute rather than restate.
  workspace: {
    file: WORKSPACE_MCP,
    tools: ["list_items", "list_lanes", "create_item", "update_item", "consult_expert", "weave_batch"],
  },
  // engine.ts's agent() builds this per call. IT IS AN MCP SURFACE TOO, and
  // AC1 says "no MCP surface" — so it is in the inventory, not exempt from it.
  out: { file: ENGINE, tools: ["emit_result"] },
};

const ADDING_A_TOOL =
  "a tool was added to an MCP surface. AD-1 forbids an agent-callable accept path: confirm this " +
  "tool cannot move a loom from ready to done, then add it to MCP_INVENTORY in this test.";

// Pull `export const NAME = "literal";` out of source without importing the
// module — apps/web modules drag Next + the agent SDK in, and INV-1 is a static
// claim about text.
function exportedStringConst(source: string, name: string): string | null {
  const re = new RegExp(`export\\s+const\\s+${name}\\s*(?::[^=]*)?=\\s*(["'])([^"']*)\\1`);
  const m = re.exec(source);
  return m ? m[2]! : null;
}
function exportedStringArray(source: string, name: string): string[] | null {
  const re = new RegExp(`export\\s+const\\s+${name}\\s*(?::[^=]*)?=\\s*\\[([\\s\\S]*?)\\]`);
  const m = re.exec(source);
  if (!m) return null;
  return [...m[1]!.matchAll(/(["'])([^"']*)\1/g)].map((x) => x[2]!);
}

describe("INV-1 the Human-Accept Moat holds by construction — AD-1", () => {
  // The per-server collection that used to live here (MCP_SURFACES → server
  // name → tool names) went with INV-1a/b/c: MCP_SURFACES is empty now, so it
  // built an empty map that three deleted tests read. INV-1d assembles its own
  // fixtures at runtime and INV-1e/f read core directly, so nothing below needs
  // the scan.

  // RETIRED WITH apps/web — INV-1a and INV-1b. INV-1c SURVIVES, REDUCED.
  //
  // These pinned the MCP surface set and its per-server tool inventory. FOUR of
  // the five surfaces (browser, loom, ultra, workspace) were apps/web modules;
  // ONE remains — packages/core/src/run-server.ts, the "out" server. An
  // exact-set pin of five, and a per-server inventory of ~17 tool names, cannot
  // be re-measured into anything meaningful over a single surface that this
  // file already reads directly, so both are gone.
  //
  // INV-1c IS NOT GONE, AND THAT IS DELIBERATE. It is the actual moat check —
  // "no tool name anywhere is accept-shaped" — and it is the one part of the
  // surface half that still has something to scan. It is re-pointed at whatever
  // MCP_SURFACES holds and carries its own floor, so it fails rather than
  // passes if the surface set ever empties out. The near-miss controls
  // (reject_loom, answer_blocked) moved to literals since the loom server that
  // used to supply them is frozen.
  //
  // WHAT ELSE STILL HOLDS: the CONSTRUCTION half is untouched. INV-1e proves
  // acceptLoom is the only `done` writer in core and now that NOTHING imports
  // it, INV-1f proves it refuses a blank `by` at runtime, and INV-1d proves the
  // accept-shaped-name scanner reports a rogue tool.
  //
  // WHEN Telar GROWS MCP SURFACES, restore the exact-set pin and the inventory
  // together with a freshly measured MCP_INVENTORY. Do not restore the pin
  // alone: an inventory nothing scans is a comment.

  test("INV-1c no tool name on any surviving MCP surface is accept-shaped", () => {
    // ANTI-VACUITY FIRST, and at a floor of ONE surface rather than the old
    // seventeen tool names: the surviving surface is core's "out" server, and
    // if the surface scan ever collects nothing this must fail loudly instead
    // of reporting a clean deny-list over the empty set.
    if (MCP_SURFACES.length < 1) {
      throw new Error(
        `AD-1 / INV-1c: the MCP surface scan found ${MCP_SURFACES.length} files (floor 1). ` +
          `CONSEQUENCE: the accept-shaped deny check below holds over the empty set, so an accept ` +
          `tool could be added to any server without failing a test. NEXT STEP: this is the ` +
          `SCANNER that is broken, not the tree — check callsMcpFactory() and MCP_SURFACES. ` +
          `packages/core/src/run-server.ts is the known-present hit.`,
      );
    }
    const collected = MCP_SURFACES.flatMap((f) =>
      toolNameLiterals(f.code, sdkBindings(f.code, TOOL_FACTORY)).map((name) => ({ name, file: f.rel })),
    );
    const violations = collected
      .map((t) => ({ ...t, hits: acceptShapedTokens(t.name) }))
      .filter((t) => t.hits.length > 0)
      .map(
        (t) =>
          `${t.file} registers "${t.name}": token(s) ${JSON.stringify(t.hits)} are accept-shaped. ` +
            `AD-1 — ready to done is a HUMAN-ONLY transition and there is no agent-callable accept ` +
            `tool on any MCP surface. CONSEQUENCE: a model could complete its own work, which ` +
            `voids every verdict downstream of it. NEXT STEP: ${ADDING_A_TOOL}`,
      );
    expect(violations).toEqual([]);

    // THE NEAR-MISSES ARE NOW LITERALS, not entries read out of the collected
    // inventory. They used to come from the loom server, which is frozen — but
    // they are the whole reason the stem list is not a naive /done|complete/,
    // so they stay: a rewrite that trips on either is wrong, and there is no
    // longer a live tool name to catch it.
    expect(acceptShapedTokens("reject_loom")).toEqual([]);
    expect(acceptShapedTokens("answer_blocked")).toEqual([]);
  });

  test("INV-1d the tool scan DISCRIMINATES — it reports a rogue accept tool fed through the same code path", () => {
    // The permanent positive control. The fixture is assembled at RUNTIME from
    // fragments rather than written as literal source, because packages/core/test
    // is one of the roots the index walks and a real `createSdkMcpServer(` call
    // written here would be picked up by the very scan it is meant to test.
    const ctor = "createSdkMcpServer" + "(";
    const rogue =
      `${ctor}{ name: "rogue", version: "1.0.0", tools: [\n` +
      `  tool("accept_loom", "d", {}, async () => {}),\n` +
      `  tool("mark_delivered", "d", {}, async () => {}),\n` +
      `  tool("answer_blocked", "d", {}, async () => {}),\n` +
      `] })`;
    expect(mcpServerNameLiterals(rogue)).toEqual(["rogue"]);
    expect(toolNameLiterals(rogue)).toEqual(["accept_loom", "mark_delivered", "answer_blocked"]);
    expect(acceptShapedTokens("accept_loom")).toEqual(["accept"]);
    // The stem match is what stops "delivered" walking past a whole-word check.
    expect(acceptShapedTokens("mark_delivered")).toEqual(["delivered"]);
    expect(acceptShapedTokens("answer_blocked")).toEqual([]);
    // …and the extractor ignores the shapes that are not a tool registration.
    expect(toolNameLiterals('const x = createTool("nope");')).toEqual([]);
    expect(toolNameLiterals('registry.tool("nope");')).toEqual([]);

    // AND THE RENAME, which is the shape that used to walk straight past this
    // invariant's whole universe: MCP_SURFACES was a substring test for
    // "createSdkMcpServer(", so one `as` and a fourth server was never scanned
    // at all — INV-1a's "exactly the three we know about" would still pass.
    const sdk = "@anthropic-ai/" + "claude-agent-sdk";
    const aliased =
      `import { ${MCP_FACTORY} as makeServer, ${TOOL_FACTORY} as mkTool } from "${sdk}";\n` +
      `export const escalate = makeServer({ name: "escalate", version: "1.0.0", tools: [\n` +
      `  mkTool("accept_loom", "d", {}, async () => {}),\n` +
      `] });`;
    expect(sdkBindings(aliased, MCP_FACTORY)).toContain("makeServer");
    expect(sdkBindings(aliased, TOOL_FACTORY)).toContain("mkTool");
    expect(callsMcpFactory(aliased)).toBe(true);
    expect(mcpServerNameLiterals(aliased, sdkBindings(aliased, MCP_FACTORY))).toEqual(["escalate"]);
    expect(toolNameLiterals(aliased, sdkBindings(aliased, TOOL_FACTORY))).toEqual(["accept_loom"]);
    // A rename that does NOT come from the SDK binds nothing, so an unrelated
    // local helper called `makeServer` cannot drag a file into the surface set.
    expect(callsMcpFactory(`import { makeServer } from "./local";\nmakeServer({ name: "x" });`)).toBe(
      false,
    );
    // The added stems: the ordinary synonyms an author would actually reach for.
    expect(acceptShapedTokens("finish_loom")).toEqual(["finish"]);
    expect(acceptShapedTokens("close_loom")).toEqual(["close"]);
    expect(acceptShapedTokens("confirm_delivery")).toEqual(["confirm", "delivery"]);
    // …and the near-misses that must stay green under the widened list.
    for (const name of MCP_INVENTORY.loom!.tools) expect(acceptShapedTokens(name)).toEqual([]);
  });

  test("INV-1e the construction half — acceptLoom is the only done writer in core, and NOTHING imports it", () => {
    const doneWriters = NON_TEST.filter(
      (f) => f.rel.startsWith("packages/core/src/") && /\.state\s*=\s*["']done["']/.test(f.code),
    ).map((f) => f.rel);
    expect(doneWriters).toEqual([LOOMS]);

    // AD-1 names tick.ts as part of the construction half. It only ever READS
    // state === "done" for subgoal readiness; it must never assign it.
    expect(/\.state\s*=\s*["']done["']/.test(byRel.get(TICK)!.code)).toBe(false);

    // TWO ASSERTIONS WERE DROPPED HERE WITH apps/web, and they were different
    // in kind — the reader should not assume both come back the same way:
    //   - "loom-mcp.ts does not import acceptLoom" was a NEGATIVE about a file
    //     that no longer exists. It comes back with the loom MCP surface.
    //   - "…and has exactly one importer, apps/web's accept route, which
    //     hardcodes `by` to a server-derived value" was the load-bearing half:
    //     it proved the single call path into the only `done` writer could not
    //     be told WHO accepted by a request body. That route is gone, so the
    //     expectation is now the STRONGER one below — the importer set is EMPTY.
    //
    // An empty set is a real assertion here, not a vacuous one: the moment
    // anything in the scanned tree imports acceptLoom, this fails and whoever
    // added it has to restore the `by` pin at the new call site. That is the
    // exact review moment AD-1 exists to force.
    const importers = NON_TEST.filter((f) => {
      const { direct, namespaces } = localNamesFor(f.code, "acceptLoom", isCoreSpecifier);
      if (direct.length > 0) return true;
      return namespaces.some((ns) =>
        new RegExp(`(?<![A-Za-z0-9_$.])${escapeRe(ns)}\\.acceptLoom\\s*\\(`).test(f.code),
      );
    }).map((f) => f.rel);
    expect(importers).toEqual([]);
  });

  test("INV-1f acceptLoom refuses a blank by at runtime, not merely in a comment", async () => {
    // The only runtime assertion in INV-1. It throws on its first statement, so
    // no state root is resolved and nothing is read or written.
    const looms = await import("../src/looms");
    for (const blank of ["", "   ", "\t"]) {
      expect(() => looms.acceptLoom("inv1-probe", blank)).toThrow(
        "acceptLoom requires a non-blank `by`",
      );
    }
  });

  // RETIRED WITH apps/web — INV-1g.
  //
  // The HOOK half: it proved apps/web's chat route wired a PreToolUse guardrail
  // that named LOOM_START_TOOL and LOOM_ANSWER_BLOCKED_TOOL, that neither was
  // in LOOM_AUTO_TOOLS (which would have taken the SDK's pre-approved fast path
  // and skipped the human card), and that the guard was the head of a real
  // condition rather than a string literal. Every file it read — the route,
  // lib/server/turn-hooks.ts, lib/loom-mcp.ts — was an apps/web module.
  //
  // THIS IS THE LARGEST SINGLE THING THAT STOPPED BEING CHECKED, and it is the
  // one to restore FIRST when Telar grows a tool layer: the engine's driver
  // currently passes permissionMode "default" with no canUseTool and no hooks
  // at all (apps/engine/src/driver.ts), so there is no tool-layer gate in vNext
  // for an invariant to guard yet. When one lands, this test is the shape it
  // should be held to.
});

// ── INV-2 — the verifier stack is granted no write or edit tools (AD-2) ─────
// READ THIS BEFORE CHANGING ANYTHING HERE: MOST OF INV-2 ALREADY EXISTS. Four
// tests assert parts of this wall today, and duplicating them is waste that
// diverges on first edit. They are CITED below (and the citations are made
// executable — a renamed test fails INV-2h rather than rotting silently):
//
//   roster.test.ts        "VERIFIER_TOOLS grants no write/spawn capability"
//                         → VERIFIER_TOOLS excludes Write/Edit/Bash/Agent
//   roster.test.ts        "the schema OMITS restrictTools/settingSources/extraMcpServers
//                          — config can never widen or disable a capability wall"
//   m10-verify-lane.test.ts "VERIFIER_TOOLS carry NO mutate tools (no Write/Edit/Bash/Agent);
//                            critic reuses the same set"
//                         → also greps critic.ts for VERIFIER_TOOLS + restrictTools: true,
//                           and greps verify-lane.ts's imports to prove it never imports the judge
//   m10-lane-escalation.test.ts "accepted runbook → its narrative reaches EVERY critic
//                                prompt; tool wall unchanged"
//
// SO THIS INVARIANT IS THE GAP, PLUS ONE CONSOLIDATING ASSERTION — not a fifth
// copy. What is new here: the TEN-name deny set (the existing tests check four);
// the abstainers (verify-thread.ts and panel.ts introduce no grant of their own);
// and the EXTENSION CLAUSE — AD-2 says the wall "extends to new verification
// surfaces", so the surface inventory is pinned and every file classified, and a
// new file matching the pattern fails until someone classifies it.
//
// THE FIELD THAT IS ACTUALLY THE WALL is `restrictTools`, not `allowedTools`.
// engine.ts's own header states that under permissionMode: "bypassPermissions",
// allowedTools alone does NOT restrict availability. An invariant that checked
// only allowedTools or only disallowedTools would miss the load-bearing field.
const VERIFIER = "packages/core/src/verifier.ts";
const CRITIC = "packages/core/src/critic.ts";
const PANEL = "packages/core/src/panel.ts";
const VERIFY_THREAD = "packages/core/src/verify-thread.ts";
const VERIFY_LANE = "packages/core/src/verify-lane.ts";
const VERIFICATION_STRATEGY = "packages/core/src/verification-strategy.ts";

// AD-2's wall, stated as a set. The existing tests check four names; this checks
// ten, because "no write tools" has to survive the SDK growing new ones.
const WRITE_OR_SPAWN_TOOLS = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "BashOutput",
  "KillShell",
  "Agent",
  "Task",
  "TodoWrite",
];
function writeToolViolations(granted: readonly string[]): string[] {
  return granted
    .filter((t) => WRITE_OR_SPAWN_TOOLS.includes(t))
    .map(
      (t) =>
        `${t} is granted to the verifier stack. AD-2 — verifier.ts / verify-thread.ts / critic.ts / ` +
          `panel.ts and every loom-altitude lab agent are granted NO write or edit tools. ` +
          `CONSEQUENCE: a passing verdict becomes self-issuable — the judge could edit the code it ` +
          `is judging, which is the one property the verdict's trustworthiness rests on. ` +
          `NEXT STEP: this is a HALT condition in story-pipeline.md. Do not weaken this test; ` +
          `remove the grant.`,
    );
}

// AD-2 says the wall "extends to NEW verification surfaces", so the surface is
// an inventory rather than four hard-coded filenames, and every entry carries
// its classification IN SOURCE. A new file matching the pattern fails until
// someone classifies it — which is the only way "extends to new surfaces" can
// be executable rather than aspirational.
const VERIFICATION_SURFACES: Record<string, "judge" | "must-not-grant" | "setup-wall"> = {
  // JUDGE — grants VERIFIER_TOOLS with restrictTools: true. Read-only by
  // construction; drives the running app through its accessibility tree.
  [VERIFIER]: "judge",
  // JUDGE — same wall, and it IMPORTS VERIFIER_TOOLS from ./verifier rather
  // than re-declaring it. That shared identity is itself worth pinning: two
  // copies of the list is how one of them drifts.
  [CRITIC]: "judge",
  // MUST-NOT-GRANT — pure functions over already-produced verdicts
  // (panelSize / aggregatePanel / panelReason / classifyPanel). runPanel, the
  // thing that actually loops and calls runCritic, lives in critic.ts.
  [PANEL]: "must-not-grant",
  // MUST-NOT-GRANT — one indirection further out: it takes an injected
  // deps.runIntegrationVerify and an injected AutoRepairDeps.verify.
  [VERIFY_THREAD]: "must-not-grant",
  // MUST-NOT-GRANT — a PURE chooser over already-derived inputs; it picks the
  // METHOD evidence is gathered by and can never reach a verdict.
  [VERIFICATION_STRATEGY]: "must-not-grant",
  // SETUP-WALL, deliberately a capability and deliberately NOT a judge. Its own
  // header: "this is the EXECUTOR/SETUP-wall capability (spawn/re-spawn/kill
  // processes) — NOT a judge capability. The judge … only ever RECEIVES the
  // target URL." Its no-judge-import half is CITED to m10-verify-lane.test.ts's
  // "the judge producer RECEIVES only url:string — never startLane/superviseLane/lane functions",
  // not re-written here.
  [VERIFY_LANE]: "setup-wall",
};

const GRANT_FIELD_PATTERNS: Record<string, RegExp> = {
  tools: /\btools\s*:\s*VERIFIER_TOOLS\b/,
  restrictTools: /\brestrictTools\s*:\s*true\b/,
  disallowedTools: /\bdisallowedTools\s*:\s*\[/,
};

const callsAgent = (code: string): boolean => /(?<![A-Za-z0-9_$.])agent\s*\(/.test(code);

// Tool names granted INLINE as literals — `tools: ["Read", "Write"]` or
// `allowedTools: [...]`. The judges grant `tools: VERIFIER_TOOLS`, an
// identifier, so this returns [] for them and INV-2a checks that set at runtime
// instead. `disallowedTools` is deliberately NOT read: naming Write in a
// DENYlist is the wall working, not a grant.
function grantedToolLiterals(code: string): string[] {
  const out: string[] = [];
  const re = /\b(?:tools|allowedTools)\s*:\s*\[([\s\S]{0,600}?)\]/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    for (const q of m[1]!.matchAll(/(["'])([^"']*)\1/g)) out.push(q[2]!);
  }
  return out;
}

describe("INV-2 the verifier stack is granted no write or edit tools — AD-2, the capability wall", () => {
  test("INV-2a the ten-name deny set is disjoint from VERIFIER_TOOLS at runtime", async () => {
    const { VERIFIER_TOOLS } = await import("../src/verifier");
    // Anti-vacuity FIRST: an empty or renamed export would satisfy any
    // "contains no write tool" check forever.
    expect(VERIFIER_TOOLS.length).toBeGreaterThanOrEqual(3);
    expect(VERIFIER_TOOLS).toContain("Read");
    expect(writeToolViolations(VERIFIER_TOOLS)).toEqual([]);
    // The playwright tools DRIVE and READ, never write; browser_take_screenshot
    // is marked "evidence only" in-source. They must not be mistaken for a
    // write capability, and the deny set is why they are not.
    expect(VERIFIER_TOOLS.filter((t) => t.startsWith("mcp__playwright__")).length).toBeGreaterThan(
      0,
    );
  });

  test("INV-2b both grant sites carry all three fields, and restrictTools is one of them", () => {
    // The choke point is agent() in engine.ts and the availability wall is
    // restrictTools → the SDK's `tools` option. Checking only allowedTools or
    // only disallowedTools would miss it.
    const missing: string[] = [];
    for (const file of [VERIFIER, CRITIC]) {
      const code = byRel.get(file)!.code;
      for (const [field, re] of Object.entries(GRANT_FIELD_PATTERNS)) {
        if (!re.test(code)) {
          missing.push(
            `${file} no longer carries \`${field}\` on its agent() grant. AD-2 — the verifier ` +
              `stack's availability wall is \`restrictTools\` (engine.ts's header: under ` +
              `permissionMode "bypassPermissions", allowedTools alone does NOT restrict ` +
              `availability). CONSEQUENCE: the judge silently regains every built-in tool, ` +
              `including Write and Bash. NEXT STEP: restore the field; do not relax this test.`,
          );
        }
      }
      for (const banned of ["Write", "Edit", "MultiEdit", "Bash", "NotebookEdit", "Agent"]) {
        if (!new RegExp(`"${banned}"`).test(code)) {
          missing.push(`${file} dropped "${banned}" from its disallowedTools denylist (AD-2).`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("INV-2c critic.ts IMPORTS VERIFIER_TOOLS rather than re-declaring it", () => {
    // Two copies of the list is how one of them drifts, and the drifted one is
    // always the judge's.
    const critic = byRel.get(CRITIC)!;
    const importsIt = importStatements(critic.code).some(
      (s) => importSource(s) === "./verifier" && s.includes("VERIFIER_TOOLS"),
    );
    expect(importsIt).toBe(true);
    expect(/export\s+const\s+VERIFIER_TOOLS/.test(critic.code)).toBe(false);
    // Exactly one declaration in the whole of packages/core/src.
    const declarers = NON_TEST.filter(
      (f) =>
        f.rel.startsWith("packages/core/src/") && /export\s+const\s+VERIFIER_TOOLS/.test(f.code),
    ).map((f) => f.rel);
    expect(declarers).toEqual([VERIFIER]);
  });

  test("INV-2d the abstainers introduce no tool grant of their own", () => {
    // Genuinely new coverage. Checked against COMMENT-STRIPPED AND
    // STRING-STRIPPED source: panel.ts's header says "must inject an agent()
    // call here" (prose), and a thrown
    // `new Error("caller must supply restrictTools: true …")` DOCUMENTS the wall
    // rather than minting a capability. An invariant that fires on either gets
    // deleted rather than fixed.
    //
    // THE SET IS DERIVED FROM VERIFICATION_SURFACES, not hardcoded. A hardcoded
    // list is why "extends to new verification surfaces" did not actually extend:
    // a file added to the inventory tomorrow was enumerated by INV-2e and
    // inspected by nothing.
    const violations: string[] = [];
    const mustNotGrant = Object.entries(VERIFICATION_SURFACES)
      .filter(([, role]) => role === "must-not-grant")
      .map(([file]) => file);
    expect(mustNotGrant.length).toBeGreaterThanOrEqual(3); // floor: the map parsed
    for (const file of mustNotGrant) {
      const code = stripStringLiterals(byRel.get(file)!.code);
      for (const marker of ["tools:", "allowedTools", "restrictTools", "disallowedTools"]) {
        if (code.includes(marker)) {
          violations.push(
            `${file} introduced \`${marker}\`. AD-2 — this file is classified must-not-grant ` +
              `(see VERIFICATION_SURFACES): it takes injected deps / holds pure functions and ` +
              `must never mint a capability. CONSEQUENCE: a second, unreviewed grant site on the ` +
              `verification path. NEXT STEP: inject the capability instead, or reclassify the ` +
              `file here and justify it.`,
          );
        }
      }
      if (callsAgent(code)) {
        violations.push(
          `${file} calls agent( directly. AD-2 — a must-not-grant verification file injects its ` +
            `agent runner, never embeds one (panel.ts's own header says exactly this). ` +
            `NEXT STEP: take it as an injected dep.`,
        );
      }
    }
    // panel.ts's header claims "PURE functions only, no fs, no agent calls" —
    // pin the stated contract, not just the tool wall.
    if (byRel.get(PANEL)!.code.includes("node:fs")) {
      violations.push(`${PANEL} imported node:fs, contradicting its own "no fs" header claim.`);
    }
    expect(violations).toEqual([]);
  });

  test("INV-2e the verification-surface inventory is exact, and every file is classified", () => {
    // THE PATTERN IS SYMMETRIC, which the first version was not: it gave a
    // suffix wildcard to `verify-` and `verification-` only, and anchored on a
    // literal `.ts`. So packages/core/src/verification.ts — the un-hyphenated
    // sibling of the very file this story had to classify — plus verifier-utils.ts,
    // critics.ts, panel-view.ts, verify.ts and any .tsx/.mts verification surface
    // never matched `found`, were never forced into the inventory, and a write
    // grant hidden in one was invisible to the whole of INV-2.
    const found = NON_TEST.filter(
      (f) =>
        f.rel.startsWith("packages/core/src/") &&
        /^(verifier|verify|critic|panel|verification)[A-Za-z0-9_.-]*\.(ts|tsx|mts)$/.test(
          path.basename(f.rel),
        ),
    ).map((f) => f.rel);
    // A floor before the equality, so a broken filter cannot pass by matching
    // nothing.
    expect(found.length).toBeGreaterThanOrEqual(5);
    expect(found.sort()).toEqual(Object.keys(VERIFICATION_SURFACES).sort());

    // EVERY BUCKET IS CHECKED. "setup-wall" used to be a classification with no
    // branch behind it: a new packages/core/src/verify-runner.ts that genuinely
    // granted Write could be labelled setup-wall, satisfy the equality above by
    // merely being enumerated, and AD-2's "extends to new verification surfaces"
    // clause would silently not apply to it. A bucket nothing inspects is a
    // bucket that excuses anything.
    const violations: string[] = [];
    for (const [file, role] of Object.entries(VERIFICATION_SURFACES)) {
      const raw = byRel.get(file)!.code;
      const code = stripStringLiterals(raw);
      // Applies to every role, because no classification excuses an inline
      // literal grant of a write or spawn tool on a verification surface.
      for (const v of writeToolViolations(grantedToolLiterals(code))) {
        violations.push(`${file} is classified "${role}" and ${v}`);
      }
      if (role === "judge" && !GRANT_FIELD_PATTERNS.restrictTools!.test(code)) {
        violations.push(
          `${file} is classified "judge" but carries no \`restrictTools: true\`. AD-2 — that ` +
            `field IS the availability wall (engine.ts's header: under permissionMode ` +
            `"bypassPermissions", allowedTools alone does NOT restrict availability). ` +
            `CONSEQUENCE: the judge silently regains every built-in tool, Write and Bash ` +
            `included. NEXT STEP: restore the field, or reclassify the file and justify it here.`,
        );
      }
      if (role === "must-not-grant" && code.includes("restrictTools")) {
        violations.push(
          `${file} is classified "must-not-grant" but now mentions \`restrictTools\` outside a ` +
            `string. AD-2 — this file injects its capability or holds pure functions; it must ` +
            `never mint one. CONSEQUENCE: a second, unreviewed grant site on the verification ` +
            `path. NEXT STEP: inject the capability, or reclassify the file here and justify it.`,
        );
      }
      if (role === "setup-wall") {
        // The bucket's DEFINING claim, from verify-lane.ts's own header: it is
        // the EXECUTOR/SETUP-wall capability (spawn/re-spawn/kill), NOT a judge.
        // Its no-judge-import CONTENT half stays cited to m10-verify-lane.test.ts's
        // "the judge producer RECEIVES only url:string …"; what is asserted here
        // is the structural half, which that citation does not cover.
        if (code.includes("restrictTools") || callsAgent(code)) {
          violations.push(
            `${file} is classified "setup-wall" but mints a judge-shaped capability ` +
              `(\`restrictTools\` or a direct agent( call). AD-2 — a setup wall stands the lane ` +
              `up and hands the judge a URL; it never becomes the judge. CONSEQUENCE: the ` +
              `capability that can spawn and kill processes now also reaches a verdict, and the ` +
              `separation the whole wall rests on is gone. NEXT STEP: keep the judge in ` +
              `verifier.ts / critic.ts, or reclassify this file and justify it here.`,
          );
        }
        const judgeImports = importStatements(raw)
          .map((s) => importSource(s))
          .filter((s) => s === "./verifier" || s === "./critic");
        if (judgeImports.length) {
          violations.push(
            `${file} is classified "setup-wall" but imports ${JSON.stringify(judgeImports)}. ` +
              `AD-2 — standing up or repairing the lane grants the judge NOTHING, which is only ` +
              `true while the two do not reach each other. CONSEQUENCE: the setup wall can now ` +
              `invoke or configure the judge it is supposed to be walled off from. NEXT STEP: ` +
              `pass the target URL, not the judge.`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("INV-2f ULTRA_CHILD_TOOLS is deliberately write-capable and is NOT part of this wall", () => {
    // A "no Write anywhere" pattern would sweep this up, and that would be a
    // false positive on a CORRECT grant: the Ultra builder child is supposed to
    // write. The invariant is that it stays out of the verification surfaces.
    const runner = byRel.get("packages/core/src/ultra/runner.ts")!;
    const ultraChild = exportedStringArray(runner.code, "ULTRA_CHILD_TOOLS");
    expect(ultraChild).toContain("Write");
    expect(ultraChild).toContain("Bash");
    const leaked = Object.keys(VERIFICATION_SURFACES).filter((f) =>
      byRel.get(f)!.code.includes("ULTRA_CHILD_TOOLS"),
    );
    expect(leaked).toEqual([]);
  });

  test("INV-2g the wall scan DISCRIMINATES — a write tool in a grant list is reported", () => {
    // Same function the real check calls, fed a synthetic grant.
    expect(writeToolViolations(["Read", "Grep", "Glob"])).toEqual([]);
    expect(writeToolViolations(["Read", "Write"]).length).toBe(1);
    expect(writeToolViolations(["Read", "Write"])[0]).toContain("Write is granted");
    // Every one of the ten is really denied, not just the four the existing
    // tests cover.
    for (const banned of WRITE_OR_SPAWN_TOOLS) {
      expect(writeToolViolations(["Read", banned]).length).toBe(1);
    }
    // …and the agent-call detector ignores the shapes that are not a call.
    expect(callsAgent("const x = subagent(1);")).toBe(false);
    expect(callsAgent("deps.agent(1);")).toBe(false);
    expect(callsAgent("await agent({});")).toBe(true);
    // The inline-grant extractor, which is what makes the "setup-wall" bucket a
    // checked bucket rather than a label.
    expect(grantedToolLiterals('const o = { tools: ["Read", "Write"] };')).toEqual([
      "Read",
      "Write",
    ]);
    expect(writeToolViolations(grantedToolLiterals('{ allowedTools: ["Bash"] }')).length).toBe(1);
    // A DENYlist naming Write is the wall working, not a grant, so it must not
    // be swept up — INV-2b asserts those very names are present.
    expect(grantedToolLiterals('{ disallowedTools: ["Write", "Edit"] }')).toEqual([]);
    // `tools: VERIFIER_TOOLS` is an identifier, not a literal list: nothing to
    // read statically, which is why INV-2a checks that set at runtime instead.
    expect(grantedToolLiterals("{ tools: VERIFIER_TOOLS }")).toEqual([]);
    // And the marker scan reads what a file DOES, not what it SAYS.
    const marker = "restrict" + "Tools";
    expect(stripStringLiterals(`throw new Error("supply ${marker}: true");`).includes(marker)).toBe(
      false,
    );
    expect(stripStringLiterals(`query({ ${marker}: true });`).includes(marker)).toBe(true);
  });

  test("INV-2h the four tests this invariant CITES still exist, so the citation cannot rot", () => {
    // A citation is only load-bearing if it fails when the thing cited moves.
    // These are exact titles, read off the files at the time this was written.
    const cited: [string, string][] = [
      ["packages/core/test/roster.test.ts", "VERIFIER_TOOLS grants no write/spawn capability"],
      [
        "packages/core/test/roster.test.ts",
        "the schema OMITS restrictTools/settingSources/extraMcpServers — config can never widen or disable a capability wall",
      ],
      [
        "packages/core/test/m10-verify-lane.test.ts",
        "VERIFIER_TOOLS carry NO mutate tools (no Write/Edit/Bash/Agent); critic reuses the same set",
      ],
      [
        "packages/core/test/m10-verify-lane.test.ts",
        "the judge producer RECEIVES only url:string — never startLane/superviseLane/lane functions",
      ],
      [
        "packages/core/test/m10-lane-escalation.test.ts",
        "accepted runbook → its narrative reaches EVERY critic prompt; tool wall unchanged",
      ],
    ];
    const missing = cited
      .filter(([file, title]) => !byRel.get(file)?.text.includes(title))
      .map(
        ([file, title]) =>
          `INV-2 cites ${file} "${title}", which no longer exists there. AD-2's wall is asserted ` +
            `in five places on purpose and this file deliberately does NOT duplicate them. ` +
            `CONSEQUENCE: the cited coverage may be gone while INV-2 still reads as complete. ` +
            `NEXT STEP: find where it moved and update the citation, or take over the assertion here.`,
      );
    expect(missing).toEqual([]);
  });
});

// ── INV-3 — no module reads another module's TELAR_HOME subtree (AD-5) ──────
// The subtlest of the five, and the place where the obvious framing is WRONG in
// a way that matters: DO NOT build the allow-list out of the root RESOLVERS.
// Newer code deliberately IMPORTS telarDir instead of re-deriving it —
// sessions.ts says so in-source: "telarDir is IMPORTED, not re-derived … A sixth
// copy is how the guard and the thing it guards end up reading different values"
// — so nine core modules plus apps/web/lib/mcp-oauth-pending.ts reach the root
// without containing a resolver at all. THE ASSERTABLE UNIT IS THE
// PATH-COMPOSITION SITE, not the resolver.
//
// WHAT IS DELIBERATELY NOT ASSERTED: `projects/` and `workspace/`. They appear
// only in the spine's State root tree as the PLANNED AD-5 layout. Current code
// uses the flat `looms/<id>/` tree exclusively and no `projects/<id>/looms/` or
// `workspace/` composition exists anywhere. An invariant written against the
// planned layout asserts over the empty set — the anti-vacuity failure in its
// most seductive form, because the DOCUMENT says the subtree exists.
//
// And this stays STATIC. "No module reads another's subtree" is a claim about
// path composition; tracing reads at runtime would be a different, weaker test.
//
// THE MIRROR QUESTION — "does a TEST reach the real subtree at all?" — is INV-7,
// at the bottom of this file. Same AD, opposite scope: INV-3 scans production
// source and excludes tests; INV-7 scans tests and excludes production source.

// The 22 sites, as `<file> :: <composed literal>`. Re-derive this; do not trust
// it. It is the invariant's whole content.
const AD5_SITES = [
  // FIVE SITES WERE REMOVED WITH apps/web, and the subtrees they owned ARE
  // STILL ON DISK under TELAR_HOME. Nothing composes them any more, so nothing
  // owns them, and this table can no longer say who should:
  //   attachments               ← lib/attachments.ts (opaque composer blobs,
  //                               deliberately NOT inside chats.json because
  //                               they are destroyed on archive and swept when
  //                               orphaned — a lifetime of their own)
  //   mcp-oauth-pending.json    ← lib/mcp-oauth-pending.ts
  //   permissions.json          ← lib/permissions.ts
  //   sessions                  ← lib/session-log.ts (live.ndjson; see the
  //                               CO-TENANCY note in AD5_OWNERS)
  //   chats.json                ← lib/store.ts
  //
  // THIS IS THE ONE RETIREMENT THAT LEAVES REAL STATE UNATTENDED rather than
  // merely unchecked: an operator's ~/.telar still holds all five. Telar writes
  // none of them and reads none of them. When Telar grows persistence for
  // sessions/transcripts/permissions, do NOT re-add these paths from memory —
  // decide the layout fresh, then pin the new sites here.
  "packages/core/src/accounts.ts :: accounts.json",
  "packages/core/src/detect.ts :: providers.json",
  "packages/core/src/dispatcher.ts :: policy.json",
  "packages/core/src/dispatcher.ts :: roster.json",
  "packages/core/src/looms.ts :: looms",
  "packages/core/src/looms.ts :: runs",
  "packages/core/src/manifest.ts :: projects.json",
  "packages/core/src/mcp-oauth.ts :: mcp-oauth.json",
  "packages/core/src/secrets.ts :: credentials.json",
  "packages/core/src/sessions.ts :: sessions",
  "packages/core/src/ultra/journal.ts :: ultra",
  "packages/core/src/usage-ledger.ts :: usage.ndjson",
  "packages/core/src/vcs.ts :: worktrees",
  "packages/core/src/watches.ts :: watches.json",
  // Story 5.1 — the workspace site, in sorted position ("wa" < "wo"). The workspace
  // store composes `path.join(telarDir(), "workspace")` as a BARE QUOTED
  // LITERAL, in exactly one function in exactly one file, and its comment says
  // that the literal is a deliberate concession to THIS scanner: a const second
  // argument produces zero sites and would leave INV-3a, INV-3b and INV-3d all
  // green while the subtree was real on disk.
  "packages/core/src/workspace/store.ts :: workspace",
];

// Who OWNS each thing composed off the root. AD-5's rule is one owner per
// subtree; root-level FILES belonging to no module are AD-20's, not AD-5's, and
// are still listed here because the composing module is their sole writer.
const AD5_OWNERS: Record<string, string[]> = {
  "projects.json": ["packages/core/src/manifest.ts"],
  "accounts.json": ["packages/core/src/accounts.ts"],
  "credentials.json": ["packages/core/src/secrets.ts"],
  // Provider DETECTION's cache — the last `<bin> --version` answer
  // answer per provider, so the settings surface can render without re-probing
  // on every paint. A root-level FILE with a single writer: detect.ts is the
  // only module that composes it, and apps/web reaches it through the
  // /api/providers route calling readProviderCache/writeProviderCache, never by
  // path. It holds no credential — detection reads a version string and takes
  "providers.json": ["packages/core/src/detect.ts"],
  "watches.json": ["packages/core/src/watches.ts"],
  "mcp-oauth.json": ["packages/core/src/mcp-oauth.ts"],
  "policy.json": ["packages/core/src/dispatcher.ts"],
  "roster.json": ["packages/core/src/dispatcher.ts"],
  "usage.ndjson": ["packages/core/src/usage-ledger.ts"],
  looms: ["packages/core/src/looms.ts"],
  // The pre-1.1 layout, kept as a one-way migration SOURCE inside looms.ts.
  runs: ["packages/core/src/looms.ts"],
  worktrees: ["packages/core/src/vcs.ts"],
  ultra: ["packages/core/src/ultra/journal.ts"],
  // Story 5.1 — AD-5's one-owner rule for the workspace item store. ONE owner,
  // and only store.ts composes it: apps/web reaches this subtree through
  // @telar/core's exported functions and never by path, which is what makes
  // AC7 ("a session cannot reach the store with file tools") a structural fact
  // rather than a policy. lanes.yaml and packets/ never appear in this table
  // because rootCompositionSites captures only the FIRST segment — INV-11 arm 1
  // is what pins the deeper layout to this same module.
  workspace: ["packages/core/src/workspace/store.ts"],
  // CO-TENANCY 1 IS RESOLVED — BY DELETION, NOT BY DESIGN, so read this before
  // concluding the hole is fixed. AD-5 assigns sessions/<sessionId>/ to the
  // session module, but TWO modules wrote there: core owned `.runner-lease`
  // (sessions.ts) and apps/web/lib/session-log.ts owned `live.ndjson` in the
  // SAME directory. That was a real hole in WORK-SPLIT's disjoint-write-set
  // guarantee (story 1.2, Completion Note 1). Freezing apps/web left core as
  // the sole writer, so the list below is one entry — but the ASYMMETRY that
  // made it dangerous is still in core: sessions.ts guards the id and FAILS
  // CLOSED on ids the old log writer would happily have accepted. If vNext
  // grows its own session log, it must not become the second writer again.
  sessions: ["packages/core/src/sessions.ts"],
  // CO-TENANCY 2 went with apps/web/lib/store.ts, which resolved its root TWO
  // WAYS within one file — chats.json through its own stateRoot(), usage.ndjson
  // through core's telarDir() via the ledger port. The two expressions were
  // byte-identical, which is why it was recorded in deferred-work.md rather
  // than fixed. It is now moot, and the lesson is the one INV-3e still guards:
  // import the resolver, never re-derive it.
};

// The modules that legitimately derive the state root from scratch. Their
// duplication is deliberate-and-separately-tracked (deferred-work.md); new code
// takes the import instead.
//
// WAS FIVE, NOW TWO. permissions.ts, session-log.ts and store.ts were the three
// apps/web resolvers and they went with the freeze. The remaining duplication is
// entirely inside core, which is the direction this list was always supposed to
// move — INV-3e's floor moved with it and is documented at the assertion.
const SANCTIONED_ROOT_RESOLVERS = [
  "packages/core/src/looms.ts",
  "packages/core/src/manifest.ts",
];

// Each entry is a REAL violation of a real invariant, left in place because the
// file belongs to another track's write set (WORK-SPLIT). Recorded, not excused.
// EVERY ENTRY IS ASSERTED TO STILL VIOLATE: a stale exception — the file gone,
// or the violation fixed — FAILS, with a message saying to delete it. That is
// the difference between a quarantine and a suppression.
const KNOWN_VIOLATIONS = [
  {
    file: "scripts/backfill-tool-detail.ts",
    invariant: "INV-3",
    owner: "not Track A — a one-off maintenance script, outside packages/core/test",
    why:
      "its module-level TELAR_DIR is path.join(os.homedir(), \".telar\") with no TELAR_HOME " +
      "anywhere, and it then opens projects.json (manifest.ts's) and chats.json (store.ts's) by " +
      "raw path — the only remaining ~/.telar literal outside a sanctioned resolver.",
    recorded: "story 1.1 review findings; _bmad-output/implementation-artifacts/deferred-work.md",
  },
  {
    file: "scripts/dev.mjs",
    invariant: "INV-3",
    owner: "the dogfood launcher — a dev entry point, outside packages/core",
    why:
      "it composes path.join(os.homedir(), \".telar\") INSIDE a `legacyHomes` guard set whose " +
      "whole purpose is to REFUSE that root — the launcher defaults to ~/.telar-vnext-dogfood and " +
      "fails rather than touching ~/.telar or ~/.telar-dev. So it derives the legacy root only to " +
      "compare against it and never to read or write through it, which is the opposite of the " +
      "failure AD-5 is about. It is quarantined rather than SANCTIONED deliberately: sanctioning " +
      "would put a dev script in the same list as looms.ts and manifest.ts and invite the next " +
      "author to derive a root there for real.",
    recorded:
      "surfaced when apps/web was frozen and INV-3e's floor was re-measured. NOT a regression from " +
      "that change — the derivation predates it and this invariant was already red.",
  },
];

describe("INV-3 no module reads another module's TELAR_HOME subtree by path — AD-5", () => {
  const observed = COMPOSITION_SITES.map((c) => `${c.file} :: ${c.site.composes}`).sort();

  test("INV-3a the path-composition inventory is exact", () => {
    // Anti-vacuity FIRST. A scan finding nothing would make every ownership
    // claim below hold over the empty set.
    if (COMPOSITION_SITES.length < 15) {
      throw new Error(
        `AD-5 / INV-3: only ${COMPOSITION_SITES.length} TELAR_HOME path-composition sites found ` +
          `(floor 15, re-measured 19 in this pass). CONSEQUENCE: the ownership check below would pass while ` +
          `scanning nothing. NEXT STEP: the SCANNER is broken — check rootCompositionSites() and ` +
          `ROOT_RESOLVERS, which today are ${JSON.stringify(ROOT_RESOLVERS)}.`,
      );
    }
    // AC2 — a bare toEqual on two 19-element arrays prints a diff naming no AD,
    // no consequence and no next step. The diagnosis is thrown first; the
    // equality stays as the mechanism ("the 19-site table is exact").
    const appeared = observed.filter((s) => !AD5_SITES.includes(s));
    const vanished = AD5_SITES.filter((s) => !observed.includes(s));
    if (appeared.length || vanished.length) {
      throw new Error(
        `AD-5 / INV-3: the TELAR_HOME path-composition inventory MOVED. NEW sites: ` +
          `${JSON.stringify(appeared)}. GONE: ${JSON.stringify(vanished)}. THE RULE: one owner ` +
          `per TELAR_HOME subtree — no module reads or writes another's subtree by path, and the ` +
          `pinned table is what makes a new composition site a deliberate act. CONSEQUENCE: two ` +
          `modules end up disagreeing about a layout nobody owns, and the next layout change ` +
          `breaks the one that was not edited. NEXT STEP: if the new site is legitimate, reach ` +
          `the subtree through the owner's exported port (loomDir, runDir, sessionDir all exist ` +
          `and carry the traversal guard) — if it really is a new owner, add it to AD5_SITES and ` +
          `to AD5_OWNERS with a comment saying why. Do not delete the entry to make this pass.`,
      );
    }
    expect(observed).toEqual(AD5_SITES);
  });

  test("INV-3b every composing file is the declared owner of what it composes", () => {
    const violations = COMPOSITION_SITES.filter(
      (c) => !(AD5_OWNERS[c.site.composes] ?? []).includes(c.file),
    ).map(
      (c) =>
        `${c.file} composes path.join(${c.site.resolver}(), "${c.site.composes}"), which belongs ` +
          `to ${JSON.stringify(AD5_OWNERS[c.site.composes] ?? ["nobody — it is not in the table"])}. ` +
          `AD-5 — one owner per TELAR_HOME subtree; no module reads or writes another's subtree ` +
          `by path. CONSEQUENCE: two modules now disagree about a layout nobody owns, and the ` +
          `next layout change breaks the one that was not edited. NEXT STEP: reach it through the ` +
          `owner's exported port (looms.ts's loomDir, ultra/journal.ts's runDir, sessions.ts's ` +
          `sessionDir all exist and carry the traversal guard), or — if this really is a new ` +
          `owner — add it to AD5_OWNERS with a comment saying why.`,
    );
    expect(violations).toEqual([]);
  });

  test("INV-3c cross-module reuse goes through an exported port, not a re-composed root", () => {
    // The shape that keeps INV-3b true as the tree grows: executor.ts,
    // dispatcher.ts and bundle.ts build loom sub-paths off looms.ts's exported
    // loomDir(id); ultra/storage.ts builds off journal.ts's runDir(). A NEW
    // path.join(telarDir(), "looms", …) outside looms.ts is precisely the
    // violation INV-3b catches — this test pins the alternative that exists.
    const loomDirUsers = NON_TEST.filter(
      (f) => f.rel.startsWith("packages/core/src/") && /(?<![A-Za-z0-9_$.])loomDir\s*\(/.test(f.code),
    ).map((f) => f.rel);
    expect(loomDirUsers).toContain("packages/core/src/looms.ts");
    expect(loomDirUsers.length).toBeGreaterThanOrEqual(3);
    // runner/lease.ts and runner/runner-json.ts take a bare directory as a
    // PARAMETER and never resolve the root themselves — the strongest form of
    // the rule, and what makes AD-16's "one primitive, two lifetimes" possible.
    for (const rel of ["packages/core/src/runner/lease.ts", "packages/core/src/runner/runner-json.ts"]) {
      expect(rootCompositionSites(byRel.get(rel)!.code)).toEqual([]);
      expect(homeRootDerivations(byRel.get(rel)!.code)).toBe(0);
    }
  });

  test("INV-3d `workspace` is now OWNED and `projects` is still absent — the planned layout, half-landed", () => {
    // THIS TEST PREDICTED ITS OWN REWRITE. Until story 5.1 it read "nothing is
    // asserted about projects or workspace, because neither exists yet", and its
    // comment said: "When the planned AD-5 layout lands, these flip from absent
    // to owned and this test is where that shows up." Story 5.1 landed the
    // workspace half, so `workspace` flips and `projects` does not — and keeping
    // the two apart is the whole content, because a rewrite that simply deleted
    // the assertion would lose the still-absent half.
    const composed = observed.filter((s) => / :: (projects|workspace)$/.test(s));
    expect(composed).toEqual(["packages/core/src/workspace/store.ts :: workspace"]);

    // OWNED, and by exactly one module — the AD-5 claim, not merely "a site
    // exists". AD5_OWNERS is the table INV-3b enforces; this asserts the entry
    // says what this story says it says.
    expect(AD5_OWNERS.workspace).toEqual(["packages/core/src/workspace/store.ts"]);

    // `projects` STAYS ABSENT. There is no per-project TELAR_HOME subtree yet;
    // projects.json (manifest.ts's flat registry file) is a different thing and
    // is deliberately not what this pattern matches.
    expect(composed.filter((s) => s.endsWith(":: projects"))).toEqual([]);
    expect(observed).toContain("packages/core/src/manifest.ts :: projects.json");

    // …and the flat layout that DOES exist is present, so this is a statement
    // about today's tree rather than about a broken scan.
    expect(observed).toContain("packages/core/src/looms.ts :: looms");
  });

  test("INV-3e only the sanctioned resolvers derive the state root from scratch", () => {
    const unsanctioned = HOME_DERIVERS.filter((f) => !SANCTIONED_ROOT_RESOLVERS.includes(f));
    // FILTERED BY INVARIANT, not by filename. An entry quarantining an AD-20
    // violation in some file must not also excuse an entirely unrelated raw
    // ~/.telar derivation in that same file that nobody ever agreed to excuse —
    // a quarantine widens by one line otherwise, and silently.
    const quarantined = KNOWN_VIOLATIONS.filter((k) => k.invariant === "INV-3").map((k) => k.file);
    // Anti-vacuity: the derivations really are found, so a broken pattern cannot
    // pass. FLOOR MOVED 5 → 4 when apps/web was frozen, and the arithmetic is
    // worth stating because it is not "5 minus 3": the scan now finds FOUR
    // derivations — core's two sanctioned resolvers plus the two quarantined
    // KNOWN_VIOLATIONS entries, which are derivations that this invariant
    // reports and tolerates rather than derivations it approves. The floor
    // counts what the SCANNER sees, not what the allow-list permits.
    expect(HOME_DERIVERS.length).toBeGreaterThanOrEqual(4);
    for (const r of SANCTIONED_ROOT_RESOLVERS) expect(HOME_DERIVERS).toContain(r);
    const violations = unsanctioned
      .filter((f) => !quarantined.includes(f))
      .map(
        (f) =>
          `${f} derives the state root itself with path.join(os.homedir(), ".telar"). AD-5 — the ` +
            `root has five sanctioned resolvers and new code IMPORTS telarDir rather than making ` +
            `a sixth copy (sessions.ts states the rule in-source). CONSEQUENCE: this reader and ` +
            `the writers it reads disagree the moment TELAR_HOME is set, which is exactly how a ` +
            `synthetic billing line reached the operator's real ~/.telar during story 1.1. ` +
            `NEXT STEP: import telarDir from @telar/core.`,
      );
    expect(violations).toEqual([]);
  });

  test("INV-3f every KNOWN_VIOLATIONS entry still violates, so the quarantine cannot rot into a hole", () => {
    // THE LIST'S LENGTH IS PINNED, so growth is visible in the diff rather than
    // arriving as one more plausible-looking object literal. A quarantine that
    // can be extended quietly is a suppression with extra steps.
    //
    // RAISED 1 → 2 WHEN apps/web WAS FROZEN, and this mechanism did its job:
    // scripts/dev.mjs's `legacyHomes` derivation was ALREADY violating
    // and was already red before that change — it was simply not the first
    // failure INV-3e reported, so nobody had read it. Freezing apps/web moved
    // it to the front of the queue. It is quarantined with a full `why` (it
    // derives ~/.telar only to REFUSE it) rather than sanctioned, and this
    // count is raised deliberately here in the same pass, which is exactly what
    // the message below asks for.
    if (KNOWN_VIOLATIONS.length !== 2) {
      throw new Error(
        `KNOWN_VIOLATIONS holds ${KNOWN_VIOLATIONS.length} entries; this test was written when it ` +
          `held exactly 2 (scripts/backfill-tool-detail.ts and scripts/dev.mjs, both INV-3). ` +
          `Each entry is a REAL violation of a REAL invariant left in place only because the file ` +
          `belongs to another track's write set. CONSEQUENCE: a list that grows without a reviewer ` +
          `noticing is how an invariant becomes decorative. NEXT STEP: if the new entry is ` +
          `genuinely someone else's write set, record it in deferred-work.md the way the first one ` +
          `is, then update this count deliberately in the same commit.`,
      );
    }
    // An unfalsifiable quarantine is a suppression. If the underlying violation
    // is fixed or the file is gone, THIS fails and tells you to delete the entry.
    const stale = KNOWN_VIOLATIONS.filter((k) => {
      const f = byRel.get(k.file);
      return !f || homeRootDerivations(f.code) === 0;
    }).map(
      (k) =>
        `${k.file} is quarantined as a known ${k.invariant} violation, but it no longer violates ` +
          `(the file is gone, or the raw ~/.telar derivation was removed). THIS EXCEPTION NO ` +
          `LONGER APPLIES; DELETE IT from KNOWN_VIOLATIONS in this file. Recorded at: ${k.recorded}.`,
    );
    expect(stale).toEqual([]);
    // …and it is still doing the thing that makes it a CROSS-MODULE read, not
    // merely an unsanctioned resolver: it opens two other modules' state files.
    const backfill = byRel.get("scripts/backfill-tool-detail.ts")!;
    expect(backfill.code).toContain("projects.json");
    expect(backfill.code).toContain("chats.json");
  });

  test("INV-3g the path scan DISCRIMINATES — a composition off the root is reported, a sub-path off a port is not", () => {
    // Fed through the SAME extractors the real scan uses. Assembled from
    // fragments so this test file's own text cannot be picked up by the scan it
    // is testing (packages/core/test is one of the walked roots).
    const join = "path." + "join";
    expect(rootCompositionSites(`const d = ${join}(telarDir(), "workspace");`)).toEqual([
      { resolver: "telarDir", composes: "workspace" },
    ]);
    expect(rootCompositionSites(`const d = ${join}(stateRoot(), "chats.json");`)).toEqual([
      { resolver: "stateRoot", composes: "chats.json" },
    ]);
    // A sub-path off an exported PORT is the sanctioned shape and must not be
    // reported — reporting it would make the invariant fire on correct code,
    // and an invariant that fires on correct code gets deleted rather than fixed.
    expect(rootCompositionSites(`const d = ${join}(loomsDir(), id);`)).toEqual([]);
    expect(rootCompositionSites(`const d = ${join}(ownerDir, ".runner-lease");`)).toEqual([]);
    // THE TEMPLATE FORM composes off the root exactly as path.join does, and a
    // path.join-only matcher leaves the 19-site table unchanged while a new
    // module reads another's subtree by path — the textbook AD-5 breach.
    expect(rootCompositionSites("const p = `${telarDir()}/looms/${id}/spec.json`;")).toEqual([
      { resolver: "telarDir", composes: "looms" },
    ]);
    // AND THE RENAME. The resolver spellings live in THIS file, so an alias at
    // the import site is invisible to a fixed list unless the per-file binding
    // set is threaded through — which is what resolverNamesIn does.
    const aliasedSrc =
      `import { telarDir as root } from "@telar/core";\n` +
      `const p = ${join}(root(), "sessions");`;
    expect(rootCompositionSites(aliasedSrc)).toEqual([]); // canonical list alone: blind
    expect(resolverNamesIn(aliasedSrc)).toContain("root");
    expect(rootCompositionSites(aliasedSrc, resolverNamesIn(aliasedSrc))).toEqual([
      { resolver: "root", composes: "sessions" },
    ]);
    // A type-only import binds nothing at runtime and must not widen the set.
    expect(resolverNamesIn(`import type { telarDir as root } from "@telar/core";`)).not.toContain(
      "root",
    );
    // And the home-root derivation detector: homedir() only, never a
    // project-local .telar (servers.ts's path.join(root, ".telar", …)).
    expect(homeRootDerivations(`const R = ${join}(os.homedir(), ".telar");`)).toBe(1);
    expect(homeRootDerivations(`const R = ${join}(homedir(), ".telar");`)).toBe(1);
    expect(homeRootDerivations(`const R = ${join}(root, ".telar", "servers.yaml");`)).toBe(0);
  });
});

// ── INV-4 — RETIRED WITH apps/web ──────────────────────────────────────────
//
// AD-3, the CLIENT-BUNDLE RULE: no `"use client"` component may reach core
// runtime, directly or through a value edge. INV-4 proved it with a BFS over
// the local import graph starting from every client file, following value
// imports and ignoring type-only ones, and it carried three anti-vacuity floors
// plus a two-direction discriminator.
//
// WHY IT IS GONE RATHER THAN REPOINTED: every client component in this repo was
// an apps/web module. The remaining roots (packages/core, apps/desktop,
// scripts) hold ONE file with the directive. The rule needs a client tree to
// hold over, and there is not one here any more.
//
// THE RULE ITSELF DID NOT LAPSE — apps/web enforces the same boundary
// from the other side and more strictly, by source text rather than by import
// graph: apps/web/lib/engine/source-boundary.test.ts bans "@telar/core",
// the Claude Agent SDK and the legacy tree outright across app/, components/
// and lib/. That test is the live guard while Telar is small.
//
// RESTORE THIS INVARIANT when apps/web outgrows a blanket ban — the day
// it legitimately needs SOME core import on the server, the substring test
// stops being expressible and the BFS is what replaces it. INV-4e is the piece
// to read first: it MEASURED that a substring check for `"use client"` is wrong
// (it matches the string in prose and in non-directive position), which is why
// the detector keys on the first statement.


// ── INV-5 — no module writes a shared runtime service's state (AD-20) ───────
// AD-20 covers state that belongs to NO module's subtree — the usage ledger,
// bus subscriptions, admission accounting — and is written ONLY through its own
// service's port. It closes a hole AD-5 structurally cannot reach: AD-5 assigns
// an owner to each subtree, but these three have no subtree to assign.
// Each of the four services below gets the strongest assertion its shape allows.
const USAGE_LEDGER = "packages/core/src/usage-ledger.ts";
const LEASE = "packages/core/src/runner/lease.ts";
const SESSIONS = "packages/core/src/sessions.ts";
const EVENT_BUS = "packages/core/src/event-bus.ts";
const ADMISSION = "packages/core/src/admission.ts";
const STORE = "apps/web/lib/store.ts";
const WEAVE = "packages/core/src/weave.ts";
const ULTRA_STORAGE = "packages/core/src/ultra/storage.ts";
const SCHEMAS = "packages/core/src/schemas.ts";

// Does this source COMPOSE the given state file's path (a path.join or a
// template), as opposed to merely naming it in a string or a comment? Comments
// are already blanked by the index; this separates composition from mention.
function composesStateFile(code: string, literal: string): boolean {
  const quoted = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`path\\.join\\([^;]{0,200}?(["'\`])${quoted}\\1`).test(code) ||
    new RegExp("\\$\\{[^}]{0,120}\\}/" + quoted).test(code)
  );
}

// Call sites of a named function, ignoring its own declaration. Used for
// logUsage and releaseAdmission, where the question is "who else calls this".
// The negative lookbehind drops every DOTTED call, which is deliberate and
// correct for `deps.logUsage(…)` — an injected dependency is not a second
// writer — and wrong for a namespace binding of the owning module. See
// reachableCallSites.
function callSitesOf(code: string, fn: string): number {
  const re = new RegExp(`(?<![A-Za-z0-9_$.])${escapeRe(fn)}\\s*\\(`, "g");
  let n = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 24), m.index))) continue;
    n++;
  }
  return n;
}

// The same question, asked in the two spellings a bare-identifier scan cannot
// see: `import { releaseAdmission as free }` then `free(cls)`, and
// `import * as admission from "./admission"` then `admission.releaseAdmission(cls)`.
// The second is exactly the class-mismatch-prone form INV-5f exists to forbid,
// and it used to report `callers === [admission.ts]` and pass. The namespace
// branch fires ONLY for a namespace binding of the module that owns the
// function, so `deps.logUsage(…)` still — correctly — counts for nothing.
function reachableCallSites(
  code: string,
  fn: string,
  fromModule: (spec: string) => boolean,
): number {
  const { direct, namespaces } = localNamesFor(code, fn, fromModule);
  let n = callSitesOf(code, fn);
  for (const local of new Set(direct)) if (local !== fn) n += callSitesOf(code, local);
  for (const ns of new Set(namespaces)) {
    const re = new RegExp(`(?<![A-Za-z0-9_$.])${escapeRe(ns)}\\.${escapeRe(fn)}\\s*\\(`, "g");
    for (let m = re.exec(code); m; m = re.exec(code)) n++;
  }
  return n;
}

const ownsSymbol =
  (module: string) =>
  (spec: string): boolean =>
    isCoreSpecifier(spec) || new RegExp(`(^|/)${escapeRe(module)}$`).test(spec);

describe("INV-5 no module writes a shared runtime service's state directly — AD-20", () => {
  test("INV-5a the usage ledger has a file, and exactly one non-test module composes its path", () => {
    const composers = NON_TEST.filter((f) => composesStateFile(f.code, "usage.ndjson")).map(
      (f) => f.rel,
    );
    // NOTE ON SCOPE, so the next reader does not "fix" it: apps/web/lib/store.test.ts
    // PLANTS and reads usage.ndjson from outside — deliberately, to assert this
    // very sole-writer contract — and several core suites do the same. They are
    // TESTS, not second writers, and NON_TEST excludes them (as it excludes this
    // file). Do not remove that exclusion and do not "fix" those tests.
    const violations = composers
      .filter((rel) => rel !== USAGE_LEDGER)
      .map(
        (rel) =>
          `${rel} composes the path to usage.ndjson. AD-20 / AD-18 — the spend ledger is a SHARED ` +
            `RUNTIME SERVICE with exactly one writer (logUsage) and one reader path (usage-ledger.ts's ` +
            `projections). No module opens it by path, including apps/web, which re-exports the port ` +
            `from @telar/core rather than reimplementing it. CONSEQUENCE: a second reader or a ` +
            `second accumulator is the exact failure FR-RF-2 exists to end — two numbers for one ` +
            `spend, and the wrong one on screen. NEXT STEP: use logUsage / usageSummary / ` +
            `usageCostBySession / usageTokensBySession / ledgerSpendUsd.`,
      );
    expect(violations).toEqual([]);
    expect(composers).toEqual([USAGE_LEDGER]);
  });

  test("INV-5b the two production logUsage call sites are the only ones, one per non-session UsageOwnerKind", () => {
    const callers = NON_TEST.filter(
      (f) => reachableCallSites(f.code, "logUsage", ownsSymbol("usage-ledger")) > 0,
    ).map((f) => f.rel);
    // WAS THREE. apps/web's chat route was the "session" caller and it went
    // with the freeze, so the one-caller-per-owner-kind correspondence is now
    // BROKEN ON THE session ARM: the enum still has three kinds and only two
    // are written. That is not a bug to paper over — it is the honest state of
    // a tree whose only session-turn writer is gone. Telar logs no usage at all
    // (the engine's driver reports text and nothing else), so a `session`-owned
    // spend record cannot currently be produced by anything.
    expect(callers.sort()).toEqual([ULTRA_STORAGE, WEAVE].sort());
    // weave.ts and ultra/storage.ts pass their owner kind explicitly. The chat
    // route relied on the SCHEMA DEFAULT instead, which was LOAD-BEARING rather
    // than a placeholder — it is what made a pre-attribution record still fold
    // into the session-scoped projections. The default is still asserted below
    // because it is the contract Telar's eventual usage writer will inherit.
    expect(byRel.get(WEAVE)!.code).toContain('ownerKind: "loom"');
    expect(byRel.get(ULTRA_STORAGE)!.code).toContain('ownerKind: "ultra"');
    expect(byRel.get(SCHEMAS)!.code).toContain('UsageOwnerKind.default("session")');
    expect(byRel.get(SCHEMAS)!.code).toContain('z.enum(["session", "loom", "ultra"])');
  });

  // RETIRED WITH apps/web — INV-5c.
  //
  // AD-20/AD-18 across the WORKSPACE BOUNDARY: apps/web/lib/store.ts re-exported
  // logUsage/usageSummary from @telar/core instead of reimplementing them, so
  // the ledger kept exactly one writer and one reader path even though the
  // display lived in another package. It pinned the re-export lines verbatim,
  // pinned `ledgerReadDegraded`, and pinned that `sessionSpendUsd` reached the
  // session's cost THROUGH THE PORT rather than accumulating a second number.
  //
  // FR-RF-2 — "two numbers for one spend, and the wrong one on screen" — is the
  // failure this prevented, and it is the exact failure a new UI invites: the
  // fastest way to put a cost on a Telar screen is a local accumulator over the
  // event stream. INV-5a still holds the CORE half (exactly one module composes
  // usage.ndjson's path), so the port cannot be bypassed from inside core. What
  // lapsed is the guarantee that CONSUMERS go through it.
  //
  // WHEN Telar RENDERS SPEND, restore this against its store module — the pin
  // is three lines and it is the cheapest of all the retired invariants to
  // bring back.


  test("INV-5d the lease filename lives in exactly one module, and both lifetimes share it", () => {
    // MENTION is the assertable unit here, deliberately, and it is stricter
    // than composition: a second module that so much as NAMES the filename is a
    // second place that has to be kept in sync with the first.
    const composers = NON_TEST.filter((f) => f.code.includes(".runner-lease")).map((f) => f.rel);
    expect(composers).toEqual([LEASE]);
    // …and the one module that names it really does COMPOSE a path from it,
    // rather than only mentioning it in a message — otherwise "exactly one
    // module" would be satisfied by a file that had stopped doing the work.
    expect(composesStateFile(byRel.get(LEASE)!.code, ".runner-lease")).toBe(true);
    // AD-16 — one primitive, two lifetimes. sessions.ts composes a DIRECTORY
    // and hands it to the same function a loom root goes through; it never
    // names the filename itself. That shape must stay passing, and this is the
    // assertion that says so.
    const sessions = byRel.get(SESSIONS)!.code;
    expect(sessions).toContain("leaseFile(sessionDir(");
    expect(sessions.includes(".runner-lease")).toBe(false);
  });

  test("INV-5e the bus and the admission controller hold NO file at all", () => {
    // Their state is module-private and in-memory, so the assertable claim is
    // that nothing can reach it except through the port: neither module touches
    // the filesystem, so there is no path for a second writer to open.
    const offenders: string[] = [];
    for (const rel of [EVENT_BUS, ADMISSION]) {
      const code = byRel.get(rel)!.code;
      for (const marker of ["node:fs", "node:path", "fs.", "path.join"]) {
        if (code.includes(marker)) {
          offenders.push(
            `${rel} now references \`${marker}\`. AD-20 — the bus's subscriptions and admission's ` +
              `accounting are IN-PROCESS state belonging to no module's subtree; they persist ` +
              `nothing. CONSEQUENCE: a durable trace here is a second record of something a ` +
              `module-owned NDJSON stream already owns, and a file is a path a second writer can ` +
              `open. NEXT STEP: keep the state in-memory and expose it through the port ` +
              `(publish/subscribe, acquireAdmission/admissionSnapshot).`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
    // The immutability half is already proved elsewhere and is CITED rather
    // than duplicated. Both citations are executable: a renamed test fails here.
    const cited: [string, string][] = [
      ["packages/core/test/admission.test.ts", "snapshot does not leak mutable internals"],
      [
        "packages/core/test/event-bus.test.ts",
        "T-1 the bus persists NOTHING — a busy publish leaves the state root empty",
      ],
    ];
    expect(cited.filter(([f, t]) => !byRel.get(f)?.text.includes(t))).toEqual([]);
  });

  test("INV-5f only admission.ts hands a slot back by class — everyone else uses the handle", () => {
    // THE AD-20 COROLLARY THIS STORY IS UNIQUELY PLACED TO PIN. Story 1.2 left
    // an open residual: releaseAdmission(cls) CANNOT detect a class mismatch —
    // the only in-function evidence is occupancy[cls] === 0, which is
    // indistinguishable from the double release AC9 requires to floor silently.
    // Every way to close it breaks something the story requires, so the
    // mitigation shipped instead: acquireAdmission returns a release handle that
    // closes over the class actually charged. This invariant guards the
    // mitigation. It deliberately does NOT assert that a mismatch is detected —
    // it cannot be, by construction, and such a test would either fail or be
    // quietly satisfied by the double-release floor, which is worse because it
    // would look like coverage.
    const callers = NON_TEST.filter(
      (f) =>
        f.rel.startsWith("packages/core/src/") &&
        reachableCallSites(f.code, "releaseAdmission", ownsSymbol("admission")) > 0,
    ).map((f) => f.rel);
    const violations = callers
      .filter((rel) => rel !== ADMISSION)
      .map(
        (rel) =>
          `${rel} calls releaseAdmission( directly. AD-20 — shared state is written only through ` +
            `its port, in the SAFE form the port provides. CONSEQUENCE: releaseAdmission cannot ` +
            `detect a class mismatch (story 1.2 Completion Note 15): acquiring "loom-build" and ` +
            `releasing "other" leaks the build slot for the life of the process and floors the ` +
            `"other" decrement at zero, silently. NEXT STEP: use the handle acquireAdmission ` +
            `returns — it closes over the class actually charged and is idempotent — and call it ` +
            `in a finally, as engine.ts does.`,
      );
    expect(violations).toEqual([]);
    // Anti-vacuity: the scan really does find the one legitimate call site.
    expect(callers).toEqual([ADMISSION]);
    // …and engine.ts, the sole acquireAdmission caller in src, releases through
    // the handle rather than by class.
    const engine = byRel.get(ENGINE)!.code;
    expect(engine).toContain("await acquireAdmission(");
    expect(callSitesOf(engine, "releaseAdmission")).toBe(0);
  });

  test("INV-5g the ownership scan DISCRIMINATES — a second path composition and a stray release are reported", () => {
    const join = "path." + "join";
    const ledger = "usage" + ".ndjson";
    expect(composesStateFile(`const f = ${join}(telarDir(), "${ledger}");`, ledger)).toBe(true);
    expect(composesStateFile("const f = `${root}/" + ledger + "`;", ledger)).toBe(true);
    // A mere MENTION is not a composition — several modules name the file in
    // prose, and an invariant that fired on prose would be deleted rather than
    // fixed. (Comments are already blanked by the index; this covers strings.)
    expect(composesStateFile(`const msg = "we project over ${ledger} only";`, ledger)).toBe(false);
    // The call-site counter ignores a declaration and a member call, and counts
    // a real call.
    expect(callSitesOf("export function releaseAdmission(cls) {}", "releaseAdmission")).toBe(0);
    expect(callSitesOf("admission.releaseAdmission(cls);", "releaseAdmission")).toBe(0);
    expect(callSitesOf('releaseAdmission("loom-build");', "releaseAdmission")).toBe(1);
    expect(callSitesOf("const logged = logUsage({ ts: 1 });", "logUsage")).toBe(1);

    // …and the two forms the bare-identifier counter is BLIND to, which is what
    // reachableCallSites exists for. Both are the real hazard: a namespace or a
    // rename reaches the same function and INV-5f used to pass.
    const owns = ownsSymbol("admission");
    const viaNamespace =
      `import * as admission from "./admission";\nadmission.releaseAdmission("loom-build");`;
    expect(callSitesOf(viaNamespace, "releaseAdmission")).toBe(0); // blind, by design
    expect(reachableCallSites(viaNamespace, "releaseAdmission", owns)).toBe(1);
    const viaRename =
      `import { releaseAdmission as free } from "./admission";\nfree("loom-build");`;
    expect(callSitesOf(viaRename, "releaseAdmission")).toBe(0); // blind, by design
    expect(reachableCallSites(viaRename, "releaseAdmission", owns)).toBe(1);
    // An INJECTED dep is not a second writer and must stay uncounted — a scan
    // that fired on it would fire on the correct pattern engine.ts uses.
    expect(reachableCallSites("deps.releaseAdmission(cls);", "releaseAdmission", owns)).toBe(0);
    // …and a namespace of some OTHER module does not lend its name either.
    expect(
      reachableCallSites(
        `import * as other from "./other";\nother.releaseAdmission("x");`,
        "releaseAdmission",
        owns,
      ),
    ).toBe(0);
  });
});

// ── INV-6 — no SessionProfile field can widen a tool grant (AD-10) ──────────
// THE SIXTH, and it is not one of AD-19's five — see the header's own note on
// why it lives here anyway. AD-10's promise is that session config can become
// DATA without the moat becoming configurable, and the mechanism is a type: a
// profile carries AD-9's seven config fields plus the registry key, none of
// which can reach hook registration, and `toolPolicy` carries deny lists and
// allow-narrowing ONLY. The spine's rejected alternative was review — "'we will
// review for it' is not a mechanism" — so this is the mechanism.
//
// WHAT INV-6 DELIBERATELY DOES NOT ASSERT: that the COMPILER rejects a
// widening. That claim needs the compiler, it is proved in
// packages/core/test/session-profile.test.ts over generated fixtures in both
// directions, and duplicating it here would spend ~0.35 s per fixture against
// this file's 2000 ms budget for no new signal. It is CITED instead, executably
// — the same decision INV-2 made about the five suites it leans on, for the
// same reason.
const PROFILE_SRC = byRel.get("packages/core/src/session-profile.ts");
// ROUTE_SRC (apps/web's chat route) went with INV-6c and INV-6e — it was their
// only reader. Nothing in the remaining roots consumes a session profile, which
// is exactly why both halves of AD-9's consumer contract are unguarded today.

// Extracts a type-literal alias's declared FIELDS from a source string. Takes a
// SOURCE STRING and never a file, so INV-6d's discriminator fixtures run
// through this exact function — a discriminator that called a different
// extractor would prove nothing. Comments are blanked first, so a header
// paragraph that merely NAMES a field (this file's own prose says `hooks`, and
// session-profile.ts's header says it too) can never be read as a declaration.
function typeLiteralFields(
  source: string,
  typeName: string,
): Array<{ name: string; type: string }> | null {
  const code = stripComments(source);
  const head = new RegExp(`type\\s+${escapeRe(typeName)}\\s*=\\s*\\{`).exec(code);
  if (!head) return null;
  // Brace-match the body. Only {} () [] are tracked: `<` and `>` are ambiguous
  // in TS source (comparisons, arrows) and mis-counting them would silently
  // truncate the body, which is the failure mode that makes a scan pass.
  const start = head.index + head[0].length;
  let depth = 1;
  let i = start;
  for (; i < code.length && depth > 0; i++) {
    const ch = code[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
  }
  if (depth !== 0) return null;
  const body = code.slice(start, i - 1);

  const fields: Array<{ name: string; type: string }> = [];
  const take = (segment: string) => {
    const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:([\s\S]*)$/.exec(segment);
    if (m) fields.push({ name: m[1]!, type: m[2]!.trim() });
  };
  let seg = "";
  let d = 0;
  for (const ch of body) {
    if (ch === "{" || ch === "(" || ch === "[") d++;
    else if (ch === "}" || ch === ")" || ch === "]") d--;
    if ((ch === ";" || ch === ",") && d === 0) {
      take(seg);
      seg = "";
    } else {
      seg += ch;
    }
  }
  take(seg);
  return fields;
}

const fieldNames = (
  fields: Array<{ name: string; type: string }> | null,
): string[] => (fields ?? []).map((f) => f.name).sort();

// AD-9's seven config fields PLUS `kind`. EIGHT, and the distinction is
// load-bearing: `kind` is the REGISTRY KEY, not session configuration, so it
// can carry no grant. Describe this as "seven plus the registry key", never as
// "seven".
const PROFILE_FIELDS = [
  "cwd",
  "guardrails",
  "kind",
  "mcpServers",
  "requiredCapabilities",
  "settingSources",
  "systemPromptAppendix",
  "toolPolicy",
];

// What a surface AUTHORS. No `guardrails` (a spec may only ADD restriction) and
// no `cwd` (the context supplies it), which is why this list is not the one
// above.
const SPEC_FIELDS = [
  "addDisallowedTools",
  "addProtectedPaths",
  "kind",
  "mcpServers",
  "requiredCapabilities",
  "settingSources",
  "systemPromptAppendix",
  "toolPolicy",
];

// Anything on this list reaches hook registration, permission evaluation, or a
// bare tool grant. A profile field with one of these names would let a
// mis-authored profile skip the guardrail, which is exactly the degradation
// AD-10 forbids.
const GRANT_SHAPED_FIELDS = [
  "hooks",
  "canUseTool",
  "permissionMode",
  "skipGuardrail",
  "allowedTools",
  "bypassPermissions",
  "strictMcpConfig",
];

describe("INV-6 no SessionProfile field can widen a tool grant — AD-10, the moat outside the profile", () => {
  const profileFields = PROFILE_SRC ? typeLiteralFields(PROFILE_SRC.text, "SessionProfile") : null;
  const specFields = PROFILE_SRC ? typeLiteralFields(PROFILE_SRC.text, "SessionProfileSpec") : null;
  const policyFields = PROFILE_SRC ? typeLiteralFields(PROFILE_SRC.text, "ToolPolicy") : null;

  test("INV-6 the anti-vacuity floor — the port exists and the extractor found all three declarations", () => {
    if (!PROFILE_SRC) {
      throw new Error(
        `AD-10 / INV-6: packages/core/src/session-profile.ts is not in the scan index. ` +
          `CONSEQUENCE: every field pin below would hold over a null extraction, forever, ` +
          `silently. NEXT STEP: the port moved or the walk is broken — fix ROOTS or the path, ` +
          `do not relax the assertions.`,
      );
    }
    const found = {
      SessionProfile: profileFields?.length ?? 0,
      SessionProfileSpec: specFields?.length ?? 0,
      ToolPolicy: policyFields?.length ?? 0,
    };
    if (found.SessionProfile < 8 || found.SessionProfileSpec < 6 || found.ToolPolicy < 2) {
      throw new Error(
        `AD-10 / INV-6: the type-literal extractor came back thin — ${JSON.stringify(found)} ` +
          `(floors 8 / 6 / 2). CONSEQUENCE: the inventory pins below would compare two short ` +
          `lists and pass while a grant-shaped field sat in the file. NEXT STEP: typeLiteralFields ` +
          `is broken — check the brace matcher and the field regex, not the pinned lists.`,
      );
    }
    expect(found.SessionProfile).toBeGreaterThanOrEqual(8);
  });

  test("INV-6a the SessionProfile field inventory is EXACTLY AD-9's seven config fields plus the registry key", () => {
    const observed = fieldNames(profileFields);
    const appeared = observed.filter((f) => !PROFILE_FIELDS.includes(f));
    const vanished = PROFILE_FIELDS.filter((f) => !observed.includes(f));
    if (appeared.length || vanished.length) {
      throw new Error(
        `AD-10 / INV-6: the SessionProfile field set MOVED. NEW fields: ${JSON.stringify(appeared)}. ` +
          `GONE: ${JSON.stringify(vanished)}. THE RULE: a profile carries AD-9's seven config ` +
          `fields plus "kind", the registry key, and nothing else — the guardrail is wired ` +
          `OUTSIDE the profile and no field may reach hook registration. CONSEQUENCE: a field ` +
          `that reaches hooks, canUseTool or permissionMode turns the Human-Accept Moat from a ` +
          `STRUCTURAL invariant into a CONFIGURABLE one, and a mis-authored profile then omits ` +
          `it silently — AD-10's named failure. NEXT STEP: if the field is legitimate, add it ` +
          `here WITH a comment saying why it cannot widen a grant. Do not delete an entry to ` +
          `make this pass.`,
      );
    }
    expect(observed).toEqual([...PROFILE_FIELDS].sort());
  });

  test("INV-6a the SessionProfileSpec field inventory is exact, and neither type admits a grant-shaped field", () => {
    expect(fieldNames(specFields)).toEqual([...SPEC_FIELDS].sort());
    // The named-hazard check, stated separately from the inventory so the
    // failure reads as what it is rather than as "a list changed".
    const rogue = [...fieldNames(profileFields), ...fieldNames(specFields)].filter((f) =>
      GRANT_SHAPED_FIELDS.includes(f),
    );
    expect(rogue).toEqual([]);
  });

  test("INV-6b ToolPolicy has exactly `deny` and `allow`, and `allow` is keyed to the BASE union, not to string", () => {
    expect(fieldNames(policyFields)).toEqual(["allow", "deny"]);
    const allow = (policyFields ?? []).find((f) => f.name === "allow");
    const deny = (policyFields ?? []).find((f) => f.name === "deny");
    // `allow` narrows: its element type must be the base union. If this ever
    // reads `readonly string[]`, over-granting compiles and AC3 is dead while
    // every runtime test still passes.
    expect(allow?.type).toBe("readonly BaseAllowedTool[]");
    // `deny` may name ANYTHING — denying more is always safe, so it is
    // deliberately NOT keyed to the union.
    expect(deny?.type).toBe("readonly string[]");
  });

  // RETIRED WITH apps/web — INV-6c.
  //
  // It ordered four call sites inside apps/web's chat route: the session
  // profile had to RESOLVE before `new ReadableStream(` opened (after that,
  // a failure can only become an SSE error event, never a status code), and
  // `unmetCapabilities(` had to precede both the stream and `registerChatRun(`
  // (a 400 after registration leaks a run whose only cleanup is the stream's
  // `finally`). It also pinned the SIDE-EFFECT import `@/lib/session-profiles`,
  // which was the ONLY mechanical guard on a registry that, unpopulated, made
  // resolveSessionProfile throw on every chat request while tsc, lint and the
  // whole test suite stayed green.
  //
  // Telar HAS NO EQUIVALENT ROUTE YET AND WILL NEED THIS ORDERING WHEN IT DOES.
  // apps/web/app/api/sessions/[sessionId]/turns/route.ts accepts a turn
  // and returns; the engine owns execution, so there is no profile resolution,
  // no capability gate and no in-request stream to order against. The moment a
  // turn route grows a pre-stream failure path, restore this test against it.


  test("INV-6d the field scan DISCRIMINATES — a grant-shaped field and a widened allow are both reported", () => {
    // Assembled at runtime, never written as literal source: packages/core/test
    // is one of this scanner's own roots, and a literal declaration here would
    // make the file a fixture for itself.
    const ty = (name: string, body: string) => `export type ${name} = {\n${body}\n};\n`;
    const ro = (name: string, type: string) => `  readonly ${name}: ${type};`;
    const GOOD_PROFILE = ty(
      "Session" + "Profile",
      [
        ro("kind", "SessionKind"),
        ro("cwd", "string"),
        ro("guardrails", 'ProjectManifest["guardrails"]'),
        ro("settingSources", "readonly ProfileSettingSource[]"),
        ro("mcpServers", "Readonly<Record<string, SdkMcpServerConfig>>"),
        ro("toolPolicy", "ResolvedToolPolicy"),
        ro("requiredCapabilities", "readonly ProviderCapability[]"),
        ro("systemPromptAppendix", "string"),
      ].join("\n"),
    );
    // 1. A profile carrying a `hooks` field IS reported.
    const withHooks = GOOD_PROFILE.replace(
      ro("cwd", "string"),
      `${ro("cwd", "string")}\n${ro("hoo" + "ks", "{ PreToolUse: unknown[] }")}`,
    );
    const rogue = fieldNames(typeLiteralFields(withHooks, "Session" + "Profile")).filter((f) =>
      GRANT_SHAPED_FIELDS.includes(f),
    );
    expect(rogue).toEqual(["hooks"]);

    // 2. A ToolPolicy whose `allow` is `readonly string[]` IS reported — the
    //    widening AC3 exists to forbid, caught by the SAME type-text check
    //    INV-6b runs.
    const widened = ty(
      "Tool" + "Policy",
      [ro("deny", "readonly string[]"), "  readonly allow?: readonly string[];"].join("\n"),
    );
    const widenedAllow = typeLiteralFields(widened, "Tool" + "Policy")?.find(
      (f) => f.name === "allow",
    );
    expect(widenedAllow?.type).toBe("readonly string[]");
    expect(widenedAllow?.type).not.toBe("readonly BaseAllowedTool[]");

    // 3. A correctly-shaped declaration is NOT reported.
    expect(fieldNames(typeLiteralFields(GOOD_PROFILE, "Session" + "Profile"))).toEqual(
      [...PROFILE_FIELDS].sort(),
    );
    expect(
      fieldNames(typeLiteralFields(GOOD_PROFILE, "Session" + "Profile")).filter((f) =>
        GRANT_SHAPED_FIELDS.includes(f),
      ),
    ).toEqual([]);

    // 4. The extractor does not invent a declaration that is not there, and a
    //    COMMENT naming a field is not a declaration.
    expect(typeLiteralFields(GOOD_PROFILE, "NoSuch" + "Type")).toBeNull();
    const commented = ty(
      "Session" + "Profile",
      [ro("kind", "SessionKind"), `  // ${ro("hoo" + "ks", "unknown")}`].join("\n"),
    );
    expect(fieldNames(typeLiteralFields(commented, "Session" + "Profile"))).toEqual(["kind"]);
  });

  // RETIRED WITH apps/web — INV-6e.
  //
  // AD-9's negative half: the chat route branched on NO session kind — every
  // kind resolved through the profile registry instead of through a
  // conditional in the route. It is the invariant that kept the profile
  // abstraction from being quietly bypassed one `if (kind === ...)` at a time.
  //
  // The POSITIVE half of AD-9 survives and is directly above: INV-6a still pins
  // the SessionProfile and SessionProfileSpec field inventories, INV-6b still
  // pins ToolPolicy's `allow` to the BASE union rather than to string, and
  // INV-6d still proves the field scan reports a grant-shaped field. What
  // lapsed is only "…and no consumer routes around it", because the consumer
  // was an apps/web module.


  test("INV-6 the compile pins this invariant CITES still exist, so the citation cannot rot", () => {
    // INV-6 deliberately does not run tsc (see this block's header). That makes
    // these citations load-bearing: if session-profile.test.ts renames or drops
    // a pin, AC3 is unproved and this is the only thing that would say so.
    const cited: [string, string][] = [
      [
        "packages/core/test/session-profile.test.ts",
        "AC3 an `allow` naming a tool outside the base union does NOT typecheck",
      ],
      [
        "packages/core/test/session-profile.test.ts",
        "AC3 the SAME fixture with a base tool DOES compile, with empty output — the discriminator",
      ],
      [
        "packages/core/test/session-profile.test.ts",
        "AC3 ToolPolicy is EXACTLY { deny, allow? } — adding a field breaks this compile",
      ],
      [
        "packages/core/test/session-profile.test.ts",
        "AC3 the compile pin DISCRIMINATES — a wrong expectation really does fail",
      ],
      [
        "packages/core/test/session-profile.test.ts",
        "L6 a profile declaring a capability the provider port does not publish fails before the stream opens",
      ],
    ];
    const missing = cited
      .filter(([file, title]) => !byRel.get(file)?.text.includes(title))
      .map(
        ([file, title]) =>
          `INV-6 cites ${file} "${title}", which no longer exists there. AD-10's intersect-only ` +
            `claim is a claim about a TYPE and can only be proved by running the compiler, which ` +
            `this file deliberately does NOT do (a tsc spawn costs ~0.35 s against a 2000 ms ` +
            `budget). CONSEQUENCE: the compile-time half of AC3 may be gone while INV-6 still ` +
            `reads as complete. NEXT STEP: find where it moved and update the citation, or take ` +
            `over the assertion here and accept the cost.`,
      );
    expect(missing).toEqual([]);
  });
});

// ── INV-7 — no TEST reaches the operator's real state root (AD-5's sibling) ──
// INV-3 asks whether PRODUCTION code reads someone else's subtree. INV-7 asks
// the mirror question that four separate incidents in this repo have answered
// "yes" to: does a TEST reach the REAL subtree at all?
//
// THE FOUR, because a rule with a body count is not a style preference:
//   1. story 1.1 wrote a synthetic billing line into the operator's real
//      ~/.telar. It is still there.
//   2. story 1.3 re-armed the same weapon as an IN-PROCESS blank-TELAR_HOME
//      probe — the resolver falls back to os.homedir() the moment the pin is
//      blank, so "TELAR_HOME is set" and "TELAR_HOME is sandboxed" are not the
//      same claim. track-a-prove-run.test.ts's L5 block says so in-source and
//      spends a CHILD to avoid it.
//   3. story 2.2 self-reported that getLoom calls ensureMigrated, which RENAMES
//      DIRECTORIES under the resolved root — `runs/` becomes `looms/`, a
//      `runs -> looms` symlink is left behind, `run.json` becomes `loom.json`.
//      A read is a WRITE here.
//   4. story 2.2's own code review then proved apps/web/lib/session-prompts.test.ts
//      was executing exactly that. The negative-compile claim was written as
//      `// @ts-expect-error` above a CALL, and a ts directive is a comment to
//      the runtime: the call ran, injected no `read`, and fell through to the
//      real loom store. That is discipline failing on the very story that was
//      actively watching for this class — which is the whole argument for
//      moving the rule out of people's heads and into the suite.
//
// WHAT IS SCANNED, and the scope is the exact inverse of every other invariant
// in this file: *.test.ts / *.test.tsx ONLY. Production source is EXCLUDED
// deliberately — apps/web/lib/session-profiles.ts's buildSteererProfile reaching
// the real reader is not a bug, it is the product. The hazard is a TEST doing it.
//
// A NOTE FOR WHOEVER EDITS THIS SECTION. This file is a *.test.ts, so it is
// scanned by its own scanner. Never write a surface name immediately followed by
// `(` anywhere in this file — not in a message template, not in prose that
// survives into a string. The names below live in a string ARRAY (no paren
// follows) and every discriminator fixture is assembled from fragments at
// RUNTIME, which is the same rule the header states for INV-1..INV-6.
//
// WHAT INV-7 DOES NOT CATCH, stated because a scanner whose limits are unwritten
// gets trusted for things it never checked. This is a scan for CALL SITES BY
// NAME, so a reader reached TRANSITIVELY through a function that is not on the
// surface is invisible to it. The live example, measured rather than imagined:
// apps/web/lib/session-profiles.test.ts drives buildSteererProfile through the
// registry (`row.build(ctx(…))`, `resolveSessionProfile(ctx(…))`) dozens of
// times without ever spelling the builder as a call, and those calls are safe
// only because that file's `ctx()` helper never sets `loomId` AND never sets
// `sessionId` — the composers short-circuit to "" before reaching a reader when
// the id is absent. THE SECOND HALF OF THAT SENTENCE IS NEW AND IS NOT
// COSMETIC: story 4.1 gave projectAppendix / plannerAppendix / steererAppendix —
// and through them buildProjectProfile / buildPlannerProfile — a SECOND
// transitive route to the state root, keyed off `sessionId` rather than
// `loomId` (sessionId → ultraWakeAppendix → buildUltraWakeContext →
// pendingUltraWakes → listUltraRuns → getUltraManifest, which WRITES: it
// re-saves a stale `running` manifest as `stopped`).
//
// TWO of those five symbols are still absent from the surface below —
// projectAppendix and plannerAppendix. `buildProjectProfile` and
// `buildPlannerProfile` WERE absent when this note was written and story 5.1
// ADDED THEM, 54 lines down; this sentence is corrected here rather than left to
// contradict the list it introduces. The fifth, steererAppendix, IS listed, and
// so is buildSteererProfile, but both were added for the `loomId` chain and
// neither presence says anything about this one. And the two that remain absent
// are a recorded finding with a measured remedy, not an oversight — see the
// block at their place in the list.
// `INJECTED_READER` matches `read:`: it cannot match this seam's
// `readWake:` and does not require it. So adding `sessionId` to the helper above
// would read as a harmless widening and would silently point dozens of
// in-process calls at the operator's real root, with `safeLiveContext`
// swallowing every trace.
//
// LATENT TODAY, NOT LIVE — and the reason is two different mechanisms, not one.
// The IN-PROCESS calls that carry a `sessionId` all live in
// apps/web/lib/session-prompts.test.ts, and every one that reaches a
// wake-capable composer injects `readWake`; the single exception there calls
// escalationAppendix, which never composes the wake block at all and is safe by
// signature. The `sessionId`-carrying calls in session-profiles.test.ts inject
// nothing — they are safe because they run inside the SANDBOXED CHILD probe,
// spawned with `HOME` and `TELAR_HOME` both thrown away. Stating that as "every
// call also injects readWake" is what the story-4.1 review-fix round first wrote
// here, and its own adversarial pass caught it: the sentence is false and it
// credits the wrong guarantee, which is worse, because the next reader would
// look for an injection that is not there.
//
// Widening the surface and adding the second predicate is recorded in
// deferred-work.md with a named owner — story 4.1's write-set row for this file
// reads "Append INV-9 only", so its review round amended this comment and
// deliberately did not touch the guard.
// Both halves are a property of a test helper, not a sandbox, and INV-7 cannot
// see either. The same
// goes for looms.ts's acceptLoom / listChildLooms and bundle.ts's writeContract
// / quickBundle / snapshotBundle, each of which reaches a reader one hop down
// (every test file calling them today pins TELAR_HOME, checked at authoring
// time). Widening the surface to those names is a deliberate decision someone
// can make later; pretending the current scan already covers them is not.

// THE SURFACE, in two classes, because they fail differently.
//
// STATE_ROOT_READERS resolve the root THEMSELVES: getLoom, listLooms,
// readBundleFile and readContract go through looms.ts's telarDir(), and the two
// live-context readers plus the four appendix composers reach them by default —
// `read` is an injectable seam on the two composers, and production never passes
// one. Calling any of these decides which ~/.telar you touch by looking at the
// ambient environment, which is why the enclosing FILE has to have pinned it.
const STATE_ROOT_READERS: readonly string[] = [
  "getLoom",
  "listLooms",
  "readBundleFile",
  "readContract",
  "buildSteererContext",
  "buildEscalationContext",
  "steererAppendix",
  "escalationAppendix",
  "buildSteererProfile",
  "buildEscalationProfile",
  // TWO OF THE FOUR MISSING SYMBOLS, added by story 5.1 because it had this file
  // legitimately open. `buildSteererProfile`/`buildEscalationProfile` were
  // already listed; their project and planner siblings were not, even though
  // story 4.1 gave all four builders the same live ultra-wake read through their
  // composers. Both are called only from apps/web/lib/session-profiles.test.ts,
  // which INV-7 classifies `child`, so both land green.
  "buildProjectProfile",
  "buildPlannerProfile",
  // `projectAppendix` AND `plannerAppendix` ARE DELIBERATELY *NOT* HERE, AND
  // THE OMISSION IS A RECORDED FINDING RATHER THAN AN OVERSIGHT. Story 5.1
  // attempted them and reverted, per its own instruction to treat a red INV-7
  // as a finding:
  //
  //   Adding them turns INV-7b red on EIGHTEEN call sites in
  //   apps/web/lib/session-prompts.test.ts (10 `projectAppendix(` + 8
  //   `plannerAppendix(`). RE-DERIVED at review-fix time, because the first
  //   version of this note said all eighteen "pass no `sessionId`" and that is
  //   FALSE — the eighteen split into two groups with DIFFERENT remedies:
  //
  //     - TEN pass neither a seam nor a session id (`projectAppendix({
  //       ultraAnnotated: false })`). A composer with no session id has no wake
  //       to read BY CONSTRUCTION, so in FACT they reach no state root. The
  //       scanner cannot see that and is right not to guess.
  //     - EIGHT pass a stubbed reader seam, and SEVEN of those also pass
  //       `sessionId: "sess-1"` (`projectAppendix({ ultraAnnotated: false,
  //       sessionId: "sess-1", readWake: () => WAKE })`). They reach no state
  //       root because the SEAM IS STUBBED — the honest injected case. INV-7
  //       cannot see it only because INJECTED_READER is `/read\s*:/` and the
  //       seam is spelled `readWake:`, which that pattern does not match.
  //
  //   So the remedy is not one change but two, and the cheaper one is now
  //   named: widening INJECTED_READER to the `readWake:` spelling clears EIGHT
  //   of the eighteen on its own, leaving the ten genuinely seamless calls for
  //   either a threaded seam (Track B's apps/web/lib/session-prompts.ts and its
  //   suite) or INJECTABLE_COMPOSERS below. Both files were outside story 5.1's
  //   write-set fence. Recorded in deferred-work.md with these counts so the
  //   next story with either file open can close it in one pass.
  // ── story 5.1: the workspace item store (packages/core/src/workspace/store.ts)
  // Every one of these resolves TELAR_HOME through manifest.ts's telarDir() and
  // then opens a file, so calling any of them decides which ~/.telar you touch
  // by looking at the ambient environment — which is exactly the class this list
  // exists to police.
  //
  // THE PER-ID READER IS `getWorkspaceItem`, NOT `getItem`, and the name is
  // load-bearing: readerCallSites matches a bare `<name>(` seeded from this list
  // for EVERY file, and the tree is full of `localStorage.getItem`. That is safe
  // today only because of the `(?<![A-Za-z0-9_$.])` lookbehind excluding
  // dot-prefixed calls, and INV-7b should not be staked on it.
  //
  // The store's PURE PROJECTIONS are deliberately absent — rankOf, queueSlice,
  // deskSlice, attachmentTally and migratePacket take already-read data and
  // resolve nothing, so listing them would be a false claim about what they do
  // (and would make every pure projection test a violation). They are not
  // ROOT_PARAMETERIZED_READERS either: they take no root at all.
  "workspaceDir",
  "workspaceHomeDir",
  "ensureWorkspace",
  "readLanes",
  // The reporting half of the same read, added by story 5.1's review fix when
  // readLanes gained per-row tolerance. It opens lanes.yaml itself — readLanes
  // is now a thin caller of it — so leaving it off would put the ONLY function
  // that actually reads the file outside the surface this list polices.
  "readLanesReport",
  "writeLanes",
  "getWorkspaceItem",
  "listItems",
  "createItem",
  "updateItem",
  "readPacketAttachments",
];

// ROOT-PARAMETERIZED readers take the root as an ARGUMENT and resolve nothing.
// deriveDeliverableSignal is in the escalation live-read chain and belongs in
// the inventory, but it cannot reach the state root — and that is a property of
// its MODULE, re-checked by INV-7e rather than assumed. The day
// deliverable-signal.ts learns to resolve TELAR_HOME, the exemption dies and
// every call site in deliverable-signal.test.ts becomes a violation.
const ROOT_PARAMETERIZED_READERS: readonly string[] = ["deriveDeliverableSignal"];

const READER_SURFACE: readonly string[] = [...STATE_ROOT_READERS, ...ROOT_PARAMETERIZED_READERS];

// The two composers that take a `read` seam. buildSteererProfile /
// buildEscalationProfile take a resolution CONTEXT and have no seam, so they
// are never satisfiable by injection — only by a pin or a sandboxed child.
const INJECTABLE_COMPOSERS: readonly string[] = ["steererAppendix", "escalationAppendix"];

const INJECTED_READER = /(?<![A-Za-z0-9_$.])read\s*:/;

// AN IMPORT RENAME IS A ONE-TOKEN HOLE, a NAMESPACE binding is a second one, and
// a DYNAMIC import is a third — and the third is not hypothetical: measured on
// today's tree, track-a-prove-run.test.ts binds `const looms = await
// import("../src/looms")` and then calls `looms.getLoom(…)`. That file is
// correctly pinned, so it is not a violation; it was INVISIBLE, which is worse
// than a violation because the scan reads as complete while a whole binding form
// walks past it. moduleEdgeStatements only knows STATIC edges, so the dynamic
// forms are collected separately here.
//
// The honest remaining limit: a binding laundered through a call
// (`(await import("…")).then(m => m.getLoom)`, a destructure of a variable) is
// not resolved. Nothing in the tree does that, and widening to it would need
// real dataflow rather than a per-file binding set.
type ReaderBindings = { plain: Array<{ local: string; canonical: string }>; namespaces: string[] };
function readerBindings(source: string): ReaderBindings {
  const plain = READER_SURFACE.map((n) => ({ local: n, canonical: n }));
  const namespaces: string[] = [];
  for (const stmt of moduleEdgeStatements(source)) {
    for (const b of edgeBindings(stmt)) {
      if (b.typeOnly) continue;
      if (b.namespace) {
        if (b.local !== "*") namespaces.push(b.local);
      } else if (READER_SURFACE.includes(b.imported) && b.local !== b.imported) {
        plain.push({ local: b.local, canonical: b.imported });
      }
    }
  }
  // `const looms = await import("…")` — a namespace binding by another spelling.
  const dynNs = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*await\s+import\s*\(/g;
  for (let m = dynNs.exec(source); m; m = dynNs.exec(source)) namespaces.push(m[1]!);
  // `const { getLoom: load } = await import("…")` — the destructured form, which
  // renames exactly as a static specifier does.
  const dynDestructure = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\s*\(/g;
  for (let m = dynDestructure.exec(source); m; m = dynDestructure.exec(source)) {
    for (const raw of m[1]!.split(",")) {
      const spec = /^\s*([A-Za-z0-9_$]+)\s*(?::\s*([A-Za-z0-9_$]+)\s*)?$/.exec(raw);
      if (!spec || !READER_SURFACE.includes(spec[1]!)) continue;
      const local = spec[2] ?? spec[1]!;
      if (local !== spec[1]!) plain.push({ local, canonical: spec[1]! });
    }
  }
  return { plain, namespaces };
}

// The text between a call's parentheses. Depth counts () {} [] together, the
// same compromise typeLiteralFields makes and for the same reason: `<` and `>`
// are ambiguous in TS and mis-counting them truncates silently. Bounded, so a
// stray unbalanced paren cannot make this read the rest of the file.
function parenBody(source: string, openAt: number): string {
  let depth = 0;
  const limit = Math.min(source.length, openAt + 4000);
  for (let i = openAt; i < limit; i++) {
    const ch = source[i]!;
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return source.slice(openAt + 1, i);
    }
  }
  return source.slice(openAt + 1, limit);
}

type ReaderCall = { at: number; name: string; local: string; args: string };

// Takes a SOURCE STRING and never a file, so INV-7d's fixtures run this exact
// function. `bindings` is passed in because the import statements live in the
// comments-blanked text while the call sites are counted in the fully-blanked
// text — computing them from the latter would find no module specifiers at all.
function readerCallSites(source: string, bindings: ReaderBindings): ReaderCall[] {
  const hits: ReaderCall[] = [];
  const collect = (local: string, canonical: string, pattern: string) => {
    const re = new RegExp(pattern, "g");
    for (let m = re.exec(source); m; m = re.exec(source)) {
      const openAt = m.index + m[0].length - 1;
      hits.push({ at: m.index, name: canonical, local, args: parenBody(source, openAt) });
    }
  };
  for (const b of bindings.plain) {
    collect(b.local, b.canonical, `(?<![A-Za-z0-9_$.])${escapeRe(b.local)}\\s*\\(`);
  }
  for (const ns of bindings.namespaces) {
    for (const canonical of READER_SURFACE) {
      collect(
        `${ns}.${canonical}`,
        canonical,
        `(?<![A-Za-z0-9_$.])${escapeRe(ns)}\\s*\\.\\s*${escapeRe(canonical)}\\s*\\(`,
      );
    }
  }
  return hits.sort((a, b) => a.at - b.at || (a.local < b.local ? -1 : 1));
}

// ── is this root a sandbox? ─────────────────────────────────────────────────
// The question every mechanism below reduces to, and the one story 1.3 got
// wrong: "TELAR_HOME is assigned" is NOT the claim. looms.ts resolves
// `process.env.TELAR_HOME?.trim()` and falls back to os.homedir() the moment the
// value is empty or whitespace, so a blank pin IS the real store with extra
// steps. A root counts as sandboxed only if the expression reaches an
// mkdtemp/tmpdir construction, following local bindings a bounded number of hops
// (weave.test.ts pins `path.join(home, "not-a-dir")`, which is two).
// NOT the dot-excluding lookbehind the call-site scans use, and the difference
// is the whole detector: `fs.mkdtempSync(…)` and `os.tmpdir()` are MEMBER
// ACCESSES, so excluding `.` here matches nothing at all and every file in the
// tree reads as unpinned.
const TEMP_ROOT_CALL = /(?<![A-Za-z0-9_$])(?:mkdtemp|mkdtempSync|tmpdir)\s*\(/;
// `process`/`env` are property paths, not bindings; TELAR_HOME is an env KEY and
// tracing it would let one file's sandboxed pin vouch for another expression's
// blankness in the same file.
const NEVER_TRACED = new Set(["process", "env", "TELAR_HOME", "path", "os", "fs", "JSON", "String"]);

type RootKind = "sandboxed" | "blank" | "unknown";

// From `at` to the end of the expression: the first `;`, `,` or newline at depth
// zero. Bounded, for the same reason parenBody is.
function statementTail(code: string, at: number): string {
  let depth = 0;
  const limit = Math.min(code.length, at + 400);
  for (let i = at; i < limit; i++) {
    const ch = code[i]!;
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      if (depth === 0) return code.slice(at, i);
      depth--;
    } else if ((ch === ";" || ch === "," || ch === "\n") && depth === 0) {
      return code.slice(at, i);
    }
  }
  return code.slice(at, limit);
}

// Every initializer or re-assignment of `id` in this source. Six is plenty: a
// root pinned once at module scope and re-pinned in a beforeEach is the idiom.
function bindingInitializers(code: string, id: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![A-Za-z0-9_$.])${escapeRe(id)}\\s*=(?![=>])`, "g");
  for (let m = re.exec(code); m && out.length < 6; m = re.exec(code)) {
    out.push(statementTail(code, m.index + m[0].length));
  }
  return out;
}

function rootExprKind(code: string, expr: string, seen: Set<string> = new Set()): RootKind {
  const e = expr.trim().replace(/[;,]+$/, "").trim();
  if (e === "" || e === "undefined") return "blank";
  const literal = /^(["'`])([\s\S]*)\1$/.exec(e);
  // A literal is the whole answer: whitespace-only is story 1.3's shape, and any
  // other literal is a path nobody built with mkdtemp, so it is not a sandbox.
  if (literal) return literal[2]!.trim() === "" ? "blank" : "unknown";
  if (TEMP_ROOT_CALL.test(e)) return "sandboxed";
  if (seen.size > 8) return "unknown";
  let sawBlank = false;
  for (const id of new Set(e.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [])) {
    if (NEVER_TRACED.has(id) || seen.has(id)) continue;
    seen.add(id);
    for (const init of bindingInitializers(code, id)) {
      const kind = rootExprKind(code, init, seen);
      if (kind === "sandboxed") return "sandboxed";
      if (kind === "blank") sawBlank = true;
    }
  }
  return sawBlank ? "blank" : "unknown";
}

// ── the three sanctioned mechanisms ─────────────────────────────────────────

const lineAt = (code: string, at: number): string => {
  const start = code.lastIndexOf("\n", at) + 1;
  const end = code.indexOf("\n", at);
  return code.slice(start, end === -1 ? code.length : end);
};

// `const ORIGINAL_HOME = process.env.TELAR_HOME` — a SAVE. A `delete` or a blank
// assignment on a line that mentions one of these is putting the caller's
// environment back, which is hygiene (bun runs every suite in ONE process), not
// an unpinning. A BARE `delete process.env.TELAR_HOME` in the middle of a test
// is the other thing entirely, and stays counted.
function savedRootNames(code: string): string[] {
  const out: string[] = [];
  const re = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*process\.env\.TELAR_HOME/g;
  for (let m = re.exec(code); m; m = re.exec(code)) out.push(m[1]!);
  return out;
}

type PinAnalysis = { assignments: number; sandboxed: number; unpins: number };

function telarHomePins(code: string): PinAnalysis {
  const saved = savedRootNames(code);
  const restoreShaped = (at: number): boolean =>
    saved.some((n) =>
      new RegExp(`(?<![A-Za-z0-9_$.])${escapeRe(n)}(?![A-Za-z0-9_$])`).test(lineAt(code, at)),
    );
  let assignments = 0;
  let sandboxed = 0;
  let unpins = 0;
  const assign = /process\.env\.TELAR_HOME\s*=(?![=>])/g;
  for (let m = assign.exec(code); m; m = assign.exec(code)) {
    assignments++;
    const kind = rootExprKind(code, statementTail(code, m.index + m[0].length));
    if (kind === "sandboxed") sandboxed++;
    else if (kind === "blank" && !restoreShaped(m.index)) unpins++;
  }
  const del = /delete\s+process\.env\.TELAR_HOME/g;
  for (let m = del.exec(code); m; m = del.exec(code)) {
    if (!restoreShaped(m.index)) unpins++;
  }
  return { assignments, sandboxed, unpins };
}

const SPAWN_CALL = /(?<![A-Za-z0-9_$])(?:spawnSync|spawn|execFileSync|execFile|execSync|fork)\s*\(/;

// A child gets its own env, so it can be sandboxed TWO ways and both are in use
// here: TELAR_HOME pointed at a throwaway (session-profiles.test.ts) or HOME
// pointed at one so the os.homedir() FALLBACK lands in the throwaway too
// (track-a-prove-run.test.ts, whose child sets TELAR_HOME to whitespace ON
// PURPOSE — that is the property under test). HOME is a child-only mechanism:
// re-pointing it in the shared bun process would move the fallback for every
// other suite at once.
function sandboxedChildEnv(code: string): boolean {
  if (!SPAWN_CALL.test(code)) return false;
  for (const key of ["TELAR_HOME", "HOME"]) {
    const re = new RegExp(`(?<![A-Za-z0-9_$."'\`])${key}\\s*:`, "g");
    for (let m = re.exec(code); m; m = re.exec(code)) {
      if (rootExprKind(code, statementTail(code, m.index + m[0].length)) === "sandboxed") return true;
    }
  }
  return false;
}

// ── the per-file verdict ────────────────────────────────────────────────────

type ReaderScan = {
  file: string;
  exec: ReaderCall[]; // really executes in the shared bun process
  probe: ReaderCall[]; // source TEXT for another process
  pins: PinAnalysis;
  pinned: boolean;
  spawns: boolean;
  child: boolean;
  mechanisms: string[];
  violations: string[];
};

const lineOf = (text: string, at: number): number => text.slice(0, at).split("\n").length;

// A `${…}` INTERPOLATION IS CODE, and the tokenizer says otherwise. Its header
// states the limit in as many words — "`${…}` inside a template literal is
// treated as string content, not as code" — which is harmless for INV-2 and
// INV-5 and is a HOLE here: `` `${looms.getLoom(id)!.state} · …` `` in
// track-a-prove-run.test.ts really does call the reader, in this process, right
// there. Left unhandled it would be filed as child-probe text, and a file that
// spawns nothing would then owe nothing at all.
//
// Rather than change the tokenizer under INV-2 and INV-5, the classification is
// corrected here: walking back from the hit through the RAW text, an interpolation
// opened more recently than any backtick means the hit is inside `${…}` and
// executes. Fixing this direction matters more than the reverse — misfiling an
// exec site as a probe makes an invariant PASS.
const insideInterpolation = (text: string, at: number): boolean => {
  const before = text.slice(0, at);
  return before.lastIndexOf("${") > before.lastIndexOf("`");
};

// EXEC vs PROBE is decided by OFFSET, which is only possible because tokenize
// preserves length: a call site present in the comments-blanked text but absent
// from the fully-blanked text is inside a string literal, i.e. it is source code
// for a child process rather than code that runs here. Both classes matter and
// they carry different obligations.
function readerSafetyScan(rel: string, text: string, holdsExemption: boolean): ReaderScan {
  const code = stripComments(text); // strings intact — imports and pins live here
  const codeOnly = stripStringLiterals(text); // what actually EXECUTES
  const bindings = readerBindings(code);
  const everywhere = readerCallSites(code, bindings);
  const execKeys = new Set(readerCallSites(codeOnly, bindings).map((h) => `${h.at}:${h.local}`));
  const runsHere = (h: ReaderCall): boolean =>
    execKeys.has(`${h.at}:${h.local}`) || insideInterpolation(text, h.at);
  const exec = everywhere.filter(runsHere);
  const probe = everywhere.filter((h) => !runsHere(h));

  const pins = telarHomePins(code);
  const pinned = pins.sandboxed > 0 && pins.unpins === 0;
  const spawns = SPAWN_CALL.test(code);
  const child = sandboxedChildEnv(code);

  const violations: string[] = [];
  const mechanisms = new Set<string>();
  for (const call of exec) {
    if (holdsExemption && ROOT_PARAMETERIZED_READERS.includes(call.name)) {
      mechanisms.add("root-parameterized");
      continue;
    }
    if (INJECTABLE_COMPOSERS.includes(call.name) && INJECTED_READER.test(call.args)) {
      mechanisms.add("injected");
      continue;
    }
    if (pinned) {
      mechanisms.add("pinned");
      continue;
    }
    violations.push(
      `${rel}:${lineOf(text, call.at)} calls ${call.local} in the SHARED bun test process, and ` +
        `this file neither pins TELAR_HOME to an mkdtemp'd root nor injects a reader` +
        (pins.assignments > 0
          ? ` (it assigns TELAR_HOME ${pins.assignments}x, but ${pins.sandboxed} of those reach a ` +
            `temp dir and ${pins.unpins} blank or delete it outright — an unpinned root falls back ` +
            `to os.homedir() plus .telar)`
          : ` (it never assigns TELAR_HOME at all)`) +
        `. AD-5 — one owner per state-root subtree, and a test is not one of them. CONSEQUENCE: ` +
        `this runs against the operator's REAL ~/.telar. It is not merely a read: getLoom calls ` +
        `ensureMigrated, which RENAMES runs/ to looms/, leaves a runs -> looms symlink behind and ` +
        `renames run.json to loom.json. Story 1.1 put a synthetic billing line in the real store ` +
        `this way and it is still there. NEXT STEP: pick ONE of the three sanctioned mechanisms — ` +
        `pin process.env.TELAR_HOME to an fs.mkdtempSync root at module scope AND re-pin it in a ` +
        `beforeEach (the core house idiom; bun runs every suite in one process), or pass an ` +
        `injected read to the composer (the apps/web/lib/session-prompts.test.ts idiom), or move ` +
        `the call into a child spawned with a throwaway TELAR_HOME and HOME (the ` +
        `apps/web/lib/session-profiles.test.ts idiom). Do NOT blank TELAR_HOME in this process to ` +
        `"disable" the read — that is story 1.3's shape and it resolves to the real store.`,
    );
  }
  if (probe.length > 0 && spawns) {
    if (child) mechanisms.add("child");
    else {
      violations.push(
        `${rel}:${lineOf(text, probe[0]!.at)} writes ${probe.length} reader-reaching call site(s) ` +
          `as SOURCE TEXT for a child process (${probe.map((p) => p.local).join(", ")}) and spawns ` +
          `a child, but no spawn in this file hands the child a sandboxed TELAR_HOME or HOME. ` +
          `AD-5 — a child inherits the parent's env unless told otherwise, so an unsandboxed child ` +
          `resolves the OPERATOR's ~/.telar. CONSEQUENCE: the same directory renames as the ` +
          `in-process case, in a process whose output nobody reads. NEXT STEP: pass ` +
          `env: { ...process.env, HOME: <mkdtemp>, TELAR_HOME: <mkdtemp> } to the spawn.`,
      );
    }
  }
  return { file: rel, exec, probe, pins, pinned, spawns, child, mechanisms: [...mechanisms].sort(), violations };
}

// THE EXEMPTION, ASSERTED RATHER THAN ASSUMED. deriveDeliverableSignal walks the
// PROJECT root it is handed and resolves no state root — so its call sites need
// no sandbox. That is only true while its module stays root-parameterized, so
// the property is measured here and re-checked by INV-7e.
const DELIVERABLE_SIGNAL_SRC = byRel.get("packages/core/src/deliverable-signal.ts");
const ROOT_PARAMETERIZED_HOLDS =
  !!DELIVERABLE_SIGNAL_SRC &&
  !DELIVERABLE_SIGNAL_SRC.code.includes("TELAR_HOME") &&
  homeRootDerivations(DELIVERABLE_SIGNAL_SRC.code) === 0 &&
  rootCompositionSites(
    DELIVERABLE_SIGNAL_SRC.code,
    resolverNamesIn(DELIVERABLE_SIGNAL_SRC.code),
  ).length === 0 &&
  readerCallSites(
    DELIVERABLE_SIGNAL_SRC.code,
    readerBindings(DELIVERABLE_SIGNAL_SRC.code),
  ).every((c) => !STATE_ROOT_READERS.includes(c.name));

// THE SCANNED SCOPE — the exact inverse of NON_TEST, and the only violation
// scope in this file that is not filtered to production source.
const TEST_FILES = INDEX.filter((f) => isTestFile(f.rel));
const READER_SCANS = TEST_FILES.map((f) => readerSafetyScan(f.rel, f.text, ROOT_PARAMETERIZED_HOLDS))
  .filter((s) => s.exec.length + s.probe.length > 0);
const READER_EXEC_SITES = READER_SCANS.reduce((n, s) => n + s.exec.length, 0);
const READER_PROBE_SITES = READER_SCANS.reduce((n, s) => n + s.probe.length, 0);

line(
  `readers: ${READER_SCANS.length}/${TEST_FILES.length} test files reach the reader surface · ` +
    `${READER_EXEC_SITES} in-process call sites · ${READER_PROBE_SITES} child-probe call sites`,
);
if (VERBOSE) {
  for (const s of READER_SCANS) {
    line(
      `  ${s.file} — ${s.exec.length} exec / ${s.probe.length} probe · ` +
        `[${s.mechanisms.join("+") || "NONE"}]${s.violations.length ? " · VIOLATES" : ""}`,
    );
  }
}

describe("INV-7 no test reaches the operator's real state root — AD-5, INV-3's mirror", () => {
  test("INV-7a the anti-vacuity floor — the scan found the surface, and all three mechanisms are in use", () => {
    // Anti-vacuity FIRST, and with more than a count: this scan's characteristic
    // failure is that a renamed export or an edited regex quietly matches
    // nothing, and "no test reaches a reader" then holds forever over the empty
    // set. So the floors below assert the SHAPE of the result as well as its
    // size — if every safe file were safe by the same mechanism, two thirds of
    // the predicate would be untested by today's tree and free to rot.
    const broken: string[] = [];
    if (TEST_FILES.length < 100) {
      broken.push(
        `only ${TEST_FILES.length} *.test.ts files in the index (floor 100, re-measured 135 in this pass) — the ` +
          `WALK is broken, not the tree. INV-7 scans exactly this set.`,
      );
    }
    if (READER_SCANS.length < 25) {
      broken.push(
        `only ${READER_SCANS.length} test files reach the reader surface (floor 25, re-measured 32 in this pass) — ` +
          `readerCallSites or READER_SURFACE is broken. The violation set below would be empty ` +
          `because nothing was scanned, not because nothing is wrong.`,
      );
    }
    if (READER_EXEC_SITES < 100) {
      broken.push(
        `only ${READER_EXEC_SITES} in-process reader call sites found (floor 100, re-measured 475 in this pass) — ` +
          `the same failure, one level down.`,
      );
    }
    if (READER_PROBE_SITES < 3) {
      broken.push(
        `only ${READER_PROBE_SITES} child-probe call sites found (floor 3, re-measured 24 in this pass) — the ` +
          `EXEC/PROBE split is broken. Both halves are load-bearing: if every hit landed in the ` +
          `in-process class, the child-process mechanism below would never be exercised.`,
      );
    }
    // THE "injected" ARM LOST ITS LAST USER WITH apps/web, and it is listed
    // below as a KNOWN-DEAD mechanism rather than quietly dropped from the loop.
    //
    // The distinction matters: a mechanism with zero users is dead code that
    // nothing would notice breaking, which is exactly what this check is for.
    // Removing "injected" from the list entirely would hide that. Naming it here
    // keeps the fact in front of the next reader, and the moment a Telar test
    // injects a root, DELETE IT FROM THIS SET so the floor starts guarding it
    // again. The other three arms still have users and are still enforced.
    const MECHANISMS_WITHOUT_USERS = new Set(["injected"]);
    for (const mechanism of ["pinned", "injected", "child", "root-parameterized"]) {
      if (MECHANISMS_WITHOUT_USERS.has(mechanism)) continue;
      const users = READER_SCANS.filter((s) => s.mechanisms.includes(mechanism)).length;
      if (users === 0) {
        broken.push(
          `NO test file is safe by the "${mechanism}" mechanism, so that arm of the predicate is ` +
            `dead code and nothing would notice if it stopped working. Either the mechanism ` +
            `detector broke, or the last file using it changed — find out which before relaxing ` +
            `anything.`,
        );
      }
    }
    // …and the dead arm is asserted to REALLY be dead, so this exemption cannot
    // rot into a permanent hole: if something starts using it, this fails and
    // whoever added it removes the name above.
    for (const mechanism of MECHANISMS_WITHOUT_USERS) {
      const users = READER_SCANS.filter((s) => s.mechanisms.includes(mechanism)).length;
      if (users > 0) {
        broken.push(
          `${users} test file(s) are now safe by the "${mechanism}" mechanism, which is listed in ` +
            `MECHANISMS_WITHOUT_USERS as having none. This is GOOD NEWS and a required edit: ` +
            `remove "${mechanism}" from that set so the zero-users floor guards it again.`,
        );
      }
    }
    expect(broken).toEqual([]);
  });

  test("INV-7b every test file that reaches a reader is sandboxed, injected, or child-spawned", () => {
    // THE INVARIANT. Everything above is the machinery; this is the claim.
    const violations = READER_SCANS.flatMap((s) => s.violations);
    expect(violations).toEqual([]);
  });

  // RETIRED WITH apps/web — INV-7c, and this is the retirement that COSTS THE
  // MOST PER LINE, so read the trade before restoring anything else first.
  //
  // INV-7c was the anti-blindness control for INV-7b. INV-7b asserts "no test
  // file reaches the operator's REAL state root", which is a claim about an
  // EMPTY SET — it passes just as happily when the scanner has gone blind as
  // when the tree is clean. INV-7c stopped that by pinning the two files that
  // demonstrably DID reach a reader, by name and by mechanism:
  //
  //   apps/web/lib/session-profiles.test.ts — the CHILD-PROBE idiom. Its
  //     composer calls live inside a spawned child's template literal, so the
  //     scanner had to count them as probe sites and NOT as executing here.
  //     Pinned `pinned === false` too, so it could not pass by pinning a root
  //     in-process (its own header forbids mutating TELAR_HOME in the shared
  //     test process).
  //   apps/web/lib/session-prompts.test.ts — the INJECTION idiom, and the file
  //     the whole invariant comes from: before story 2.2's review it had one
  //     composer call that did not pass `read`, and THAT CALL EXECUTED AGAINST
  //     THE OPERATOR'S REAL LOOM STORE. INV-7 exists because of it.
  //
  // Both were apps/web test files. INV-7a's per-mechanism floor was loosened in
  // the same pass for the same reason — the "injected" arm now has no users at
  // all — so TWO of the three things keeping INV-7b honest went at once.
  // INV-7b and INV-7d still run: the invariant and its discriminator survive,
  // and INV-7d is now the ONLY thing proving the scanner is not blind.
  //
  // RESTORE A POSITIVE CONTROL AS SOON AS ANY Telar TEST TOUCHES STATE. It does
  // not have to be these two files — it has to be a real file, pinned by name
  // and mechanism, that the scanner is known to see.


  test("INV-7d the scan DISCRIMINATES — an un-injected call is reported, every sanctioned shape is not", () => {
    // Fed through the SAME function the real scan uses, from fixtures assembled
    // at RUNTIME so this file's own text cannot be picked up by the scan it is
    // testing (packages/core/test is one of the walked roots and *.test.ts is
    // exactly what INV-7 scans).
    const composer = "escalation" + "Appendix";
    const steerer = "steerer" + "Appendix";
    const reader = "get" + "Loom";
    const signal = "derive" + "DeliverableSignal";
    const temp = "fs.mkdtemp" + "Sync(path.join(os.tmpdir(), \"telar-fixture-\"))";
    const pin = "process.env.TELAR_HOME";
    const scan = (src: string) => readerSafetyScan("fixture.test.ts", src, ROOT_PARAMETERIZED_HOLDS);

    // THE SHAPE THAT BROKE: a composer call with no `read`, in a file that pins
    // nothing. This is session-prompts.test.ts's pre-review line, reconstructed.
    const bare = scan(`const a = ${composer}({ loomId: "loom_1", cwd: "/repos/demo" });`);
    expect(bare.exec.length).toBe(1);
    expect(bare.violations.length).toBe(1);
    expect(bare.violations[0]).toContain("neither pins TELAR_HOME");

    // …and the injected form of the SAME call is clean, because an invariant
    // that fires on correct code gets deleted rather than fixed.
    const injected = scan(
      `const a = ${composer}({ loomId: "loom_1", cwd: "/repos/demo", read: () => "x" });`,
    );
    expect(injected.exec.length).toBe(1);
    expect(injected.violations).toEqual([]);
    expect(injected.mechanisms).toEqual(["injected"]);
    // The steerer composer takes the same seam, and a `read` on a DIFFERENT call
    // must not vouch for this one — each call site is judged on its own args.
    expect(scan(`${steerer}({ loomId: "x", ultraAnnotated: false, read: () => "y" });`).violations)
      .toEqual([]);
    expect(
      scan(
        `${steerer}({ loomId: "x", ultraAnnotated: false, read: () => "y" });\n` +
          `${steerer}({ loomId: "x", ultraAnnotated: false });`,
      ).violations.length,
    ).toBe(1);

    // A bare state-root reader has no seam at all, so only a pin will do.
    expect(scan(`const l = ${reader}("loom_1");`).violations.length).toBe(1);
    expect(scan(`${pin} = ${temp};\nconst l = ${reader}("loom_1");`).violations).toEqual([]);
    // A `read` property cannot launder a reader that has no such parameter.
    expect(scan(`const l = ${reader}({ read: () => "x" });`).violations.length).toBe(1);

    // STORY 1.3's SHAPE, which is the one a naive "does it set TELAR_HOME" check
    // waves through: a blank pin resolves to os.homedir() plus .telar, i.e. the
    // real store. Whitespace and "" both.
    expect(scan(`${pin} = "";\nconst l = ${reader}("loom_1");`).violations.length).toBe(1);
    expect(scan(`${pin} = "   ";\nconst l = ${reader}("loom_1");`).violations.length).toBe(1);
    // A sandboxed pin plus a BARE delete leaves the process unpinned, and the
    // reader may run either side of it — reported.
    expect(
      scan(`${pin} = ${temp};\ndelete ${pin};\nconst l = ${reader}("loom_1");`).violations.length,
    ).toBe(1);
    // …but the GUARDED restore is hygiene, not an unpinning: bun runs every
    // suite in one process, so putting the caller's value back is required.
    expect(
      scan(
        `const ORIGINAL = ${pin};\n${pin} = ${temp};\nconst l = ${reader}("x");\n` +
          `if (ORIGINAL === undefined) delete ${pin}; else ${pin} = ORIGINAL;`,
      ).violations,
    ).toEqual([]);
    // Two hops of binding resolution, which weave.test.ts actually needs.
    expect(
      scan(`const box = ${temp};\nconst sub = path.join(box, "x");\n${pin} = sub;\n${reader}("i");`)
        .violations,
    ).toEqual([]);

    // A COMMENT is not a call site — thread-templates.test.ts and
    // m9-thread-workflow.test.ts both mention the readers in prose.
    expect(scan(`// a contract written by one test cannot bleed into another's ${reader}()\n`).exec)
      .toEqual([]);
    // Nor is a member access on some unrelated object.
    expect(scan(`const l = mock.${reader}("loom_1");`).exec).toEqual([]);
    // …but a NAMESPACE import is, and this repo uses that form.
    const ns =
      `import * as looms from "../src/looms";\n` + `const l = looms.${reader}("loom_1");`;
    expect(scan(ns).exec.length).toBe(1);
    expect(scan(ns).violations.length).toBe(1);
    // …and so is a RENAME, which a fixed-name list alone is blind to.
    const renamed = `import { ${reader} as loadIt } from "@telar/core";\nconst l = loadIt("x");`;
    expect(scan(renamed).exec.length).toBe(1);
    expect(scan(renamed).violations.length).toBe(1);
    // A type-only import binds nothing at runtime and must not widen the set.
    expect(
      scan(`import type { ${reader} as loadIt } from "@telar/core";\nconst l = loadIt("x");`).exec,
    ).toEqual([]);

    // AN INTERPOLATION IS CODE. `${…}` inside a template is string content to
    // the tokenizer and a live call to the runtime, so it must land in `exec`
    // and not in the child-probe class — track-a-prove-run.test.ts logs
    // `${looms.getLoom(id)!.state}` and really does read the store there.
    const interpolated = scan(`const msg = \`state: \${${reader}("loom_1")!.state}\`;`);
    expect(interpolated.exec.length).toBe(1);
    expect(interpolated.probe).toEqual([]);
    expect(interpolated.violations.length).toBe(1);
    // …and it is the INTERPOLATION that reclassifies it, not the backtick: the
    // same call as plain template text stays a probe.
    expect(scan(`const src = \`const l = ${reader}("loom_1");\`;`).probe.length).toBe(1);

    // THE CHILD-PROBE SPLIT. A reader call written INSIDE a string is source for
    // another process: it must not count as executing here, and the file's
    // obligation moves to the spawn's env.
    const probeSrc =
      `const src = \`const l = ${reader}("loom_1");\`;\n` +
      `fs.writeFileSync(p, src);\n` +
      `spawnSync(process.execPath, [p], { env: { ...process.env, TELAR_HOME: ${temp} } });`;
    const probed = scan(probeSrc);
    expect(probed.exec).toEqual([]);
    expect(probed.probe.length).toBe(1);
    expect(probed.violations).toEqual([]);
    expect(probed.mechanisms).toEqual(["child"]);
    // HOME alone sandboxes a child too, because the resolver's fallback is
    // os.homedir() plus .telar — track-a-prove-run.test.ts relies on exactly
    // this while pinning the child's TELAR_HOME to whitespace ON PURPOSE.
    expect(
      scan(
        `const src = \`const l = ${reader}("loom_1");\`;\n` +
          `spawnSync(process.execPath, [p], { env: { HOME: ${temp}, TELAR_HOME: "   " } });`,
      ).violations,
    ).toEqual([]);
    // An UNSANDBOXED child is reported: it inherits the operator's env.
    expect(
      scan(
        `const src = \`const l = ${reader}("loom_1");\`;\n` +
          `spawnSync(process.execPath, [p], { env: { ...process.env } });`,
      ).violations.length,
    ).toBe(1);

    // THE ROOT-PARAMETERIZED EXEMPTION, exercised in both directions. It is a
    // real exemption today, so it must be shown to be one…
    expect(scan(`const s = ${signal}(root);`).violations).toEqual([]);
    expect(scan(`const s = ${signal}(root);`).mechanisms).toEqual(["root-parameterized"]);
    // …and it must be shown to be CONDITIONAL: with the module property gone,
    // the identical call is a violation. Passing `false` here is exactly what
    // INV-7e's assertion would produce if deliverable-signal.ts ever learned to
    // resolve the state root.
    expect(readerSafetyScan("fixture.test.ts", `const s = ${signal}(root);`, false).violations.length)
      .toBe(1);
  });

  test("INV-7e the root-parameterized exemption is MEASURED, and it is load-bearing", () => {
    // The one call in READER_SURFACE that needs no sandbox needs none because of
    // a property of its MODULE, not because someone decided it was fine. If that
    // property goes, the exemption has to go with it — so it is re-derived here
    // rather than trusted.
    if (!DELIVERABLE_SIGNAL_SRC) {
      throw new Error(
        `INV-7e: packages/core/src/deliverable-signal.ts is not in the index. Its call sites are ` +
          `EXEMPT from INV-7 on the strength of it resolving no state root, and that claim can no ` +
          `longer be checked. NEXT STEP: find where the module moved and update this path, or ` +
          `remove deriveDeliverableSignal from ROOT_PARAMETERIZED_READERS so its call sites need ` +
          `a sandbox like everything else.`,
      );
    }
    if (!ROOT_PARAMETERIZED_HOLDS) {
      throw new Error(
        `INV-7e: packages/core/src/deliverable-signal.ts NOW REACHES THE STATE ROOT (it mentions ` +
          `TELAR_HOME, derives ~/.telar, composes a path off a root resolver, or calls a ` +
          `state-root reader). THE RULE: deriveDeliverableSignal is exempt from INV-7 only while ` +
          `it takes its root as an ARGUMENT and resolves nothing. CONSEQUENCE: every call site in ` +
          `packages/core/test/deliverable-signal.test.ts — which pins no TELAR_HOME, deliberately ` +
          `— is now running against the operator's real store. NEXT STEP: move ` +
          `deriveDeliverableSignal from ROOT_PARAMETERIZED_READERS into STATE_ROOT_READERS and ` +
          `sandbox that suite. Do not delete this check.`,
      );
    }
    // And the exemption is not decorative: the file it exempts really does call
    // the reader, really does not pin a root, and would fail without it.
    const ds = READER_SCANS.find((s) => s.file === "packages/core/test/deliverable-signal.test.ts");
    expect(ds?.exec.length ?? 0).toBeGreaterThanOrEqual(10);
    expect(ds?.pinned).toBe(false);
    expect(ds?.violations).toEqual([]);
    expect(
      readerSafetyScan(ds!.file, byRel.get(ds!.file)!.text, false).violations.length,
    ).toBeGreaterThan(0);
  });

  test("INV-7f the quarantine did not grow — INV-7 added no KNOWN_VIOLATIONS entry", () => {
    // INV-3f pins the LENGTH of KNOWN_VIOLATIONS; this pins the fact that INV-7
    // did not reach for it. Every reader-reaching test file in the tree turned
    // out to be safe by one of the three mechanisms — the predicate was widened
    // to see each of them rather than the files being excused — and a future
    // INV-7 entry appearing here should be an argument someone has, not a line
    // that lands quietly.
    expect(KNOWN_VIOLATIONS.filter((k) => k.invariant === "INV-7")).toEqual([]);
  });
});

// ── INV-8 — RETIRED WITH apps/web ──────────────────────────────────────────
//
// AD-12 / AD-13: the Conversation shell owns no session semantics. It scanned
// apps/web/components/conversation/**, apps/web/components/right-panel/** and
// session-view.tsx — never the whole tree — and asserted ten separate things:
// the shell fetches no data (8a), reads no ambient React context (8b) and
// neither do kind renderers registered outside it (8b2), the context inventory
// its denylist is built from is RE-DERIVED so it cannot go stale (8c), the
// scans discriminate in both directions (8d/8d2), the shell is configured by
// props and never by inheritance (8e), the barrel primitives and the seven
// built-in kind ids are exact-set pinned (8f), the adapter kept its STAYED set
// and lost its MOVED set (8g), ConversationProps is closed (8i), and the walk
// skips every dist dir next.config.ts advertises (8j).
//
// ALL OF IT SCANNED apps/web AND ONLY apps/web. Every file, every pinned id,
// every prop name. There is no Telar equivalent to repoint it at: the vNext
// cockpit renders a flat prompt/response journal (apps/web/lib/engine/
// journal.ts) with no kind registry, no shell/adapter split, and no right
// panel, because the engine contract carries no tool, thinking, or permission
// events for one to render.
//
// THIS IS THE INVARIANT TO REREAD WHEN THE VNEXT CONVERSATION SURFACE IS BUILT.
// The shell/adapter split it pins is the design worth keeping, and 8b2c — the
// FOUR ways an extractor like this can be defeated, each proved separately — is
// the part that took the longest to get right and should not be rediscovered.
//
// THERE IS NO GIT HISTORY TO RECOVER IT FROM. This checkout is an ORPHANED git
// worktree: .git points at /Users/bixku/Projects/Telar/.git/worktrees/telar-vnext
// and that parent repository no longer exists on disk, so `git show` cannot
// reach the deleted source. If this tree is ever re-attached to a repo that has
// the history, the INV-8 block is worth reading before rebuilding it.
//
// 8j IS THE ONE PIECE WITH LIVE VALUE ELSEWHERE: it proved the scan index skips
// every configurable Next dist dir, and the walk's `.next-*` exclusion still
// guards the index against reading minified chunks. That exclusion is retained
// in EXCLUDED_DIRS with its own header note; only the test that re-derived the
// names from next.config.ts is gone, along with the config it read.


// ── INV-9 (AD-21) ───────────────────────────────────────────────────────────
//
// PUBLISHED EVENT NAMES ARE CONTRACT, and story 4.1 is when that stopped being
// a rule about nothing. Until it landed, `declareEvents` had ZERO production
// call sites — the only event names in the tree were fixtures inside
// event-bus.test.ts — so AD-21 was a doctrine with no surface to bind. Ultra's
// `ultra:run-completed` is the first real one, and this is what keeps it from
// being renamed, re-classed or quietly joined by a second name.
//
// ATTRIBUTION, PRECISELY, because getting it wrong files this under the wrong
// rule. AD-19's own `Binds:` line is `AD-1, AD-2, AD-3, AD-5, AD-20` — AD-21 is
// NOT in it — and AD-19's rule is written as a FLOOR ("At minimum: …"). So
// INV-9 LIVES IN the AD-19 suite and PINS AD-21. It is not "an AD-19
// invariant".
//
// BUDGET. This file deliberately spawns no process and invokes no compiler
// (INV-*'s own constraint). INV-9 fits inside that: a static scan over the
// index, plus a runtime read of the bus registry after installing ultra's
// catalogue through its own self-healing accessor. The accessor is what makes
// the runtime half safe to run here at all — `bun test` runs every file in ONE
// process and `resetBus()` clears declarations globally, so a test that assumed
// another file had left the catalogue registered would pass or fail on file
// order. It installs its own.

const ULTRA_EVENTS_SRC = "packages/core/src/ultra/events.ts";

// The module namespace(s) a source file declares into. A function of a STRING,
// never of a file, so INV-9d can feed it a runtime-assembled fixture through the
// SAME function the real scan uses — a discriminator that called a different
// function would prove nothing.
//
// CAPTURES ARE FILTERED THROUGH THE BUS'S OWN SEGMENT SHAPE, and that is a real
// property rather than a convenience. Measured: without it this scan reports
// event-bus.ts itself, because its "no module declared it" error carries the
// literal `declareEvents("<module>", {...})` as the next step it tells the caller
// to take. `<module>` is a PLACEHOLDER — declareEvents would refuse it at the
// first character — so a string that cannot be a namespace is not a declaration
// site. The regex is the same lower-kebab segment event-bus.ts validates against;
// keeping the two in the same shape is what stops this scan drifting away from
// what the bus actually accepts.
const EVENT_SEGMENT = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
function declaredEventNamespaces(source: string): string[] {
  const out: string[] = [];
  const re = /declareEvents\(\s*(["'`])([^"'`]*)\1/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    if (EVENT_SEGMENT.test(m[2]!)) out.push(m[2]!);
  }
  return out;
}

// Which namespace a path is ENTITLED to declare into: the directory under
// packages/core/src that owns it. `packages/core/src/ultra/events.ts` → "ultra".
// A file directly under src/ owns no module subtree and is entitled to none,
// which is why it returns null rather than a guess.
function owningModuleNamespace(rel: string): string | null {
  const m = /^packages\/core\/src\/([a-z][a-z0-9-]*)\/[^/]+$/.exec(rel);
  return m ? m[1]! : null;
}

// The violation objects, carrying the AD id, the rule in one clause, the
// consequence, and the next step — in that order, and in the asserted VALUE
// rather than in an expect message (no suite in this repo passes one).
function eventNamespaceViolations(rel: string, source: string): string[] {
  const owner = owningModuleNamespace(rel);
  return declaredEventNamespaces(source)
    .filter((ns) => ns !== owner)
    .map(
      (ns) =>
        `${rel} calls declareEvents("${ns}") but the directory that owns it is ` +
        `${owner === null ? "not a module subtree of packages/core/src" : `"${owner}"`}. AD-21 — a ` +
        `module's published event names are as binding as its tool signatures, and the full name is ` +
        `COMPOSED inside declareEvents from the declaring module's own namespace precisely so a ` +
        `module cannot declare into another's. CONSEQUENCE: two modules can mint names in one ` +
        `namespace, so a subscriber cannot tell whose contract it is holding and a rename by either ` +
        `owner silently breaks the other. NEXT STEP: declare under "${owner ?? "<the owning module>"}", ` +
        `or move the declaration into the module that owns the namespace.`,
    );
}

// The module that DEFINES declareEvents is not a CALLER of it — the same
// definer/caller distinction INV-5b draws with ownsSymbol("usage-ledger").
// Belt-and-braces with the segment filter above: that filter is what actually
// excludes event-bus.ts today, and this is what keeps the scan honest if a
// future error message there ever quotes a real namespace.
const EVENT_DECL_SITES = NON_TEST.filter(
  (f) => f.rel !== EVENT_BUS && declaredEventNamespaces(f.code).length > 0,
).map((f) => f.rel);

describe("INV-9 a module's declared event names and delivery classes are contract — AD-21", () => {
  test("INV-9 floor — at least one PRODUCTION declareEvents call exists, so nothing below passes vacuously", () => {
    // A LOWER BOUND to re-measure, never an equality: a second module declaring
    // its own catalogue is expected and is not this invariant's business. What
    // is its business is that deleting the declaration cannot turn the whole
    // invariant green by emptying its input.
    const core = EVENT_DECL_SITES.filter((rel) => rel.startsWith("packages/core/src/"));
    if (core.length === 0) {
      throw new Error(
        `INV-9: NO production declareEvents call exists under packages/core/src. AD-21 governs ` +
          `published event names, and every assertion below reads this set — so with it empty they ` +
          `would all hold by visiting nothing. This is the state the repo was in before story 4.1, ` +
          `and event-bus.ts's own header recorded it. CONSEQUENCE: the delivery-class gate (AD-14) ` +
          `and the namespace rule are unenforced. NEXT STEP: find where the catalogue moved and ` +
          `update ${ULTRA_EVENTS_SRC}; do not delete this test.`,
      );
    }
    // …and the one that exists today is ultra's, which the arms below read.
    expect(core).toContain(ULTRA_EVENTS_SRC);
    expect(byRel.get(ULTRA_EVENTS_SRC)).toBeDefined();
  });

  test("INV-9a ultra's declared catalogue is an EXACT SET — a second name cannot appear quietly", async () => {
    // The runtime half, installed HERE through ultra's own self-healing accessor
    // rather than assuming another suite left it registered (bun runs every file
    // in one process; resetBus() clears declarations globally).
    const { ultraEvents, ULTRA_RUN_COMPLETED } = await import("../src/ultra/events");
    const { declaredEvents, resetBus } = await import("../src/event-bus");
    resetBus();
    ultraEvents();
    // AD-21 made mechanical: adding a name means editing this line, which is
    // exactly the "deliberate contract change" the rule asks for.
    expect(declaredEvents()).toEqual([ULTRA_RUN_COMPLETED]);
    expect(ULTRA_RUN_COMPLETED).toBe("ultra:run-completed");
    // The name is COMPOSED, never handed in pre-composed — so the source says
    // "ultra" and "run-completed" separately and never the joined literal.
    const src = byRel.get(ULTRA_EVENTS_SRC)!.code;
    expect(src).toContain('declareEvents("ultra"');
    expect(src).toContain('"run-completed"');
    expect(src.includes('declareEvents("ultra:run-completed"')).toBe(false);
    resetBus();
  });

  test("INV-9b the wake event is agent-facing — the class it exists to be", async () => {
    const { ultraEvents, ULTRA_RUN_COMPLETED } = await import("../src/ultra/events");
    const { eventDeclaration, canWake, resetBus } = await import("../src/event-bus");
    resetBus();
    ultraEvents();
    // A silent re-class would strip FR-UW-1 without failing anything else: a
    // human-facing wake is refused by subscribeAgentFacing at REGISTRATION, so
    // the recorder would simply never attach and the feature would go quiet.
    const decl = eventDeclaration(ULTRA_RUN_COMPLETED);
    expect(decl).toEqual({ deliveryClass: "agent-facing" });
    expect(canWake(decl!.deliveryClass)).toBe(true);
    resetBus();
  });

  test("INV-9c every production declaration's namespace matches the directory that owns it", () => {
    const violations = EVENT_DECL_SITES.flatMap((rel) =>
      eventNamespaceViolations(rel, byRel.get(rel)!.code),
    );
    expect(violations).toEqual([]);
    // Anti-vacuity: the scan really did visit the one site that exists.
    expect(EVENT_DECL_SITES).toContain(ULTRA_EVENTS_SRC);
    expect(declaredEventNamespaces(byRel.get(ULTRA_EVENTS_SRC)!.code)).toEqual(["ultra"]);
    // …and the definer is excluded because it DEFINES rather than calls — its
    // only `declareEvents("…")` text is the placeholder inside its own error.
    expect(EVENT_DECL_SITES).not.toContain(EVENT_BUS);
    expect(byRel.get(EVENT_BUS)!.code).toContain('declareEvents("<module>"');
    expect(declaredEventNamespaces(byRel.get(EVENT_BUS)!.code)).toEqual([]);
  });

  test("INV-9d the DISCRIMINATOR — both failure shapes are REPORTED, by the same functions", async () => {
    // Runtime-assembled fixtures, fed through the very functions the real check
    // above uses. A guard that cannot fail is worse than no guard.
    //
    // 1. A mis-namespaced declaration, in both directions.
    expect(
      eventNamespaceViolations("packages/core/src/ultra/events.ts", 'declareEvents("loom", {})')
        .length,
    ).toBe(1);
    expect(
      eventNamespaceViolations("packages/core/src/ultra/events.ts", 'declareEvents("ultra", {})'),
    ).toEqual([]);
    // A file directly under src/ owns no module subtree, so ANY namespace it
    // declares is a violation.
    expect(
      eventNamespaceViolations("packages/core/src/weave.ts", 'declareEvents("weave", {})').length,
    ).toBe(1);
    // The extractor itself discriminates, rather than matching everything or
    // nothing.
    expect(declaredEventNamespaces("nothing to see here")).toEqual([]);
    expect(declaredEventNamespaces("declareEvents('a', {}); declareEvents(`b`, {})")).toEqual([
      "a",
      "b",
    ]);
    // …and a string that could never BE a namespace is not a declaration site,
    // which is what keeps event-bus.ts's own error text out of the scan.
    expect(declaredEventNamespaces('declareEvents("<module>", {})')).toEqual([]);
    expect(declaredEventNamespaces('declareEvents("Ultra", {})')).toEqual([]);
    expect(declaredEventNamespaces('declareEvents("ultra:run", {})')).toEqual([]);
    // 2. A human-facing class on the wake channel, refused at REGISTRATION —
    // the load-bearing half of the gate, exercised through the real functions.
    const { z } = await import("zod");
    const { declareEvents, resetBus, subscribeAgentFacing } = await import("../src/event-bus");
    resetBus();
    declareEvents("fixture", {
      "run-completed": { deliveryClass: "human-facing", payload: z.object({}) },
      "wake-worthy": { deliveryClass: "agent-facing", payload: z.object({}) },
    });
    expect(() => subscribeAgentFacing("fixture:run-completed", () => {})).toThrow(/human-facing/);
    // …and the same call on an agent-facing name of the SAME shape succeeds, so
    // the throw is about the CLASS and not about the fixture.
    expect(() => subscribeAgentFacing("fixture:wake-worthy", () => {})).not.toThrow();
    resetBus();
  });

  test("INV-9e the quarantine did not grow — INV-9 added no KNOWN_VIOLATIONS entry", () => {
    // INV-3f pins the LENGTH of KNOWN_VIOLATIONS; this pins the fact that INV-9
    // did not reach for it, in the shape INV-7f and INV-8h already use. Ultra's
    // catalogue was written to the contract rather than excused from it, and a
    // future INV-9 entry appearing here should be an argument someone has, not a
    // line that lands quietly.
    expect(KNOWN_VIOLATIONS.filter((k) => k.invariant === "INV-9")).toEqual([]);
  });
});

// ── INV-10 — RETIRED WITH apps/web ─────────────────────────────────────────
//
// AD-13/AD-12: the ultra run anchor is registered in the ADAPTER and nowhere
// else. It pinned the kind id `ultra:run-anchor`, proved `ultra` was in the
// declared namespace vocabulary, proved the kind was registered in the
// adapter's registry and NOT in the demo gallery's, and proved it never
// migrated into the frozen shell — with the one legitimate mention named
// explicitly so the negative could not be satisfied by deleting the file.
//
// Its three files were apps/web/components/session/ultra-anchor.tsx,
// apps/web/lib/ultra-runs.ts and apps/web/lib/demo-gallery/conversation/
// shell.tsx. All three are frozen. Telar has no Ultra surface at all — the
// engine exposes no ultra entity — so there is nothing to re-anchor.
//
// RESTORE IT WITH THE ULTRA SURFACE, not before, and restore it together with
// INV-8: this invariant is a corollary of INV-8's registry design and asserts
// nothing on its own once that design is gone.


// ── INV-11 — the workspace item store is reachable ONLY through its port ─────
// Story 5.1, AC1/AC3/AC7/AC8. Six arms, and each one asserts something no other
// invariant in this file can:
//
//   a. ONE composing module. INV-3a/3b already pin the FIRST segment off the
//      root, but rootCompositionSites captures only that segment — `lanes.yaml`
//      and `packets/` never enter AD5_SITES at all, so the deeper layout has no
//      owner check without this.
//   b. NO GRANT EXPRESSION NAMES THE SUBTREE. This is AC7's executable half.
//      Scoping it to the story's own write set would return zero
//      unconditionally, which is the vacuity this file exists to refuse — so it
//      runs tree-wide over NON_TEST, and its negative control is real code that
//      already exists.
//   c. THE TOOL NAMES SURVIVE ACCEPT_STEMS, checked at the NAME rather than
//      downstream at INV-1c's inventory, so a rename in a later story is caught
//      where it is made.
//   d. NO writeFileSync / appendFileSync IN THE STORE. AC3's atomicity, as
//      source text.
//   e. NO z.object( AND NO DELETE CALL IN THE SERVER. AC3 proof 2 (schemas are
//      core's) and AC8 proof 2 (there is no deletion path).
//   f. THE QUARANTINE DID NOT GROW.
const WORKSPACE_STORE = "packages/core/src/workspace/store.ts";
const WORKSPACE_SRC_DIR = "packages/core/src/workspace/";

// ── the fs-call detector INV-11d and INV-11e both scan with ──────────────────
//
// WHY THIS IS NOT ONE REGEX. Both arms shipped as
// `/(?<![A-Za-z0-9_$.])(writeFileSync|…)\s*\(/` — a lookbehind that excludes a
// DOT PREFIX so the pattern would not fire on an unrelated `shim.writeFileSync`.
// It also excluded the one receiver that matters: `store.ts` imports fs as a
// NAMESPACE and spells every call `fs.`, so neither arm could fire on the code
// it was written to police. Both were proved vacuous by mutation — a
// `fs.writeFileSync` replacing atomicWrite, and an `fs.rmSync` delete path added
// to the MCP server, each left the whole suite green.
//
// The fix keeps the property the lookbehind was protecting and drops the one it
// was not entitled to: a member call matches when — and only when — its receiver
// is THAT FILE'S OWN binding for node:fs. `shim.writeFileSync` still does not
// match; `fs.writeFileSync` in a file that imported fs does.
// The SYNC and ASYNC spellings of the same two capabilities. `node:fs/promises`
// is a real import target — `writeFile`/`rm` there reach the same disk as
// `writeFileSync`/`rmSync` here — so a list of only the Sync names would leave
// the async half of both arms unguarded.
const WRITERS = ["writeFileSync", "appendFileSync", "writeFile", "appendFile"] as const;
const FS_MODULE = /^(node:)?fs(\/promises)?$/;
function fsBindings(code: string): string[] {
  const names: string[] = [];
  // `import fs from "node:fs"`, `import * as fs from "fs"`, and the mixed form.
  const importRe = /import\s+(?:(\*\s*as\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\s*,?\s*)?(?:\{[^}]*\}\s*)?from\s*["']([^"']+)["']/g;
  for (const m of code.matchAll(importRe)) {
    // `type` is the keyword in `import type { X } from "node:fs"`, not a binding.
    if (m[2] && m[2] !== "type" && FS_MODULE.test(m[3]!)) names.push(m[2]);
  }
  // `const fs = require("fs")` / `await import("node:fs")`, so a CJS or dynamic
  // spelling cannot walk past the scan.
  const requireRe = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:await\s+import|require)\s*\(\s*["']([^"']+)["']/g;
  for (const m of code.matchAll(requireRe)) {
    if (FS_MODULE.test(m[2]!)) names.push(m[1]!);
  }
  return [...new Set(names)];
}
// Which of `names` this file calls — BARE (a named import) or through its own fs
// binding. Returns the offending names so the failure message can print them.
function fsCallsIn(code: string, names: readonly string[]): string[] {
  const bindings = fsBindings(code);
  return names.filter((n) => {
    if (new RegExp(`(?<![A-Za-z0-9_$.])${n}\\s*\\(`).test(code)) return true;
    // `fs.promises.` is the third spelling of the same call and reaches the same
    // disk — without this segment, `fs.promises.rm(dir)` walks past a scan that
    // catches `fs.rmSync(dir)`.
    return bindings.some((b) =>
      new RegExp(`(?<![A-Za-z0-9_$.])${b}\\s*\\.\\s*(?:promises\\s*\\.\\s*)?${n}\\s*\\(`).test(code),
    );
  });
}

describe("INV-11 the workspace item store is reachable only through its port — AD-5/AD-6, story 5.1", () => {
  const workspaceFiles = NON_TEST.filter((f) => f.rel.startsWith(WORKSPACE_SRC_DIR));

  test("INV-11a exactly ONE module composes the workspace root, and one composes the layout under it", () => {
    // Anti-vacuity FIRST, on the shared scan: a composition scan finding nothing
    // would make every claim below hold over the empty set.
    if (COMPOSITION_SITES.length < 15) {
      throw new Error(
        `AD-5 / INV-11: only ${COMPOSITION_SITES.length} TELAR_HOME path-composition sites found ` +
          `(floor 15). CONSEQUENCE: the ownership claim below would pass while scanning nothing. ` +
          `NEXT STEP: the SCANNER is broken — check rootCompositionSites() and ROOT_RESOLVERS.`,
      );
    }
    const composing = COMPOSITION_SITES.filter((c) => c.site.composes === "workspace").map((c) => c.file);
    expect(composing).toEqual([WORKSPACE_STORE]);

    // THE DEEPER LAYOUT, which INV-3a structurally cannot see. `lanes.yaml` and
    // the `packets` directory are composed off workspaceDir(), not off the root,
    // so they produce no composition site — and a second module opening
    // `<root>/workspace/lanes.yaml` by hand would leave INV-3a green.
    const layoutHolders = NON_TEST.filter(
      (f) => /lanes\.yaml/.test(f.code) || /["'`]packets["'`]/.test(f.code),
    ).map((f) => f.rel);
    expect(layoutHolders).toEqual([WORKSPACE_STORE]);
    // …and the store really does hold both, so this is not passing over a scan
    // that matched nothing.
    expect(byRel.get(WORKSPACE_STORE)!.code).toContain("lanes.yaml");

    // DISCRIMINATES, in both directions, through the SAME extractor the real
    // scan uses. Assembled from fragments so this file's own text is never
    // picked up by the scan it is testing (packages/core/test is a walked root).
    const join = "path." + "join";
    expect(rootCompositionSites(`const d = ${join}(telarDir(), "workspace");`)).toEqual([
      { resolver: "telarDir", composes: "workspace" },
    ]);
    // A sub-path off the owner's exported PORT is the sanctioned shape and must
    // NOT be reported — an invariant that fires on correct code gets deleted
    // rather than fixed.
    //
    // THE PORT NAME IS ASSEMBLED FROM FRAGMENTS, for the same reason INV-3g
    // assembles `path.join`: `workspaceDir` is in STATE_ROOT_READERS, and
    // packages/core/test is a walked root, so a literal `workspaceDir(` in this
    // file would report THIS FILE as an un-sandboxed reader call site and turn
    // INV-7b red. (Measured, not reasoned about — the first draft of this arm
    // did exactly that.)
    const wsPort = "workspace" + "Dir";
    expect(rootCompositionSites(`const d = ${join}(${wsPort}(), "packets");`)).toEqual([]);
  });

  test("INV-11b NO grant expression anywhere in the tree hands a session the workspace subtree — AC7", () => {
    // Codex's sandbox boundary is PURELY PATH-BASED (working root + --add-dir),
    // so the only way a session could reach this store with file tools is if
    // some module added it to a writable-roots grant. brownfield.md: granting it
    // "would widen each session's write boundary across all projects' items —
    // the opposite of the isolation the rest of the system maintains."
    const GRANT = /(?:additionalDirectories|writableRoots|addDir|add-dir)/;
    const NAMES_WORKSPACE = /(?:workspaceDir|workspaceHomeDir|workspace\/packets|lanes\.yaml|["'`]workspace["'`])/;

    const granters = NON_TEST.filter((f) => GRANT.test(f.code)).map((f) => f.rel);
    // THE ANTI-VACUITY FLOOR IS GONE, AND THIS ARM IS VACUOUS TODAY. SAY SO.
    //
    // The floor required at least one file containing a sandbox-grant
    // expression, because "no grant names the workspace" is a statement about
    // an empty set otherwise. The ONLY granter in the tree was
    // apps/web/lib/codex-app-server.ts's writableRoots, and it was frozen with
    // the cockpit. There are ZERO grant expressions in the remaining roots —
    // Telar's driver hands the SDK a cwd and nothing else, no --add-dir, no
    // additionalDirectories — so the `violations` check below genuinely does
    // hold over the empty set.
    //
    // IT IS KEPT RATHER THAN DELETED for one reason: it is a NEGATIVE that
    // becomes live the instant Telar adds its first sandbox grant, and that is
    // precisely the change that would silently widen a session's write boundary
    // onto every project's items. The runtime discriminator below is what keeps
    // it from being decorative in the meantime — it proves both predicates
    // still classify correctly, which is the part a blind scan would fail.
    //
    // WHEN Telar GRANTS ITS FIRST DIRECTORY, restore the floor at 1 and pin the
    // new granter by name, exactly as the retired line did.
    expect(granters).toEqual([]);

    const violations = NON_TEST.filter((f) => GRANT.test(f.code) && NAMES_WORKSPACE.test(f.code)).map(
      (f) =>
        `${f.rel} contains BOTH a sandbox grant expression and a reference to the workspace store. ` +
          `AD-5 / CAP-12 — TELAR_HOME/workspace is reached through the in-process MCP server and ` +
          `through nothing else; it sits outside every session's cwd on purpose. CONSEQUENCE: a ` +
          `session granted this path can read and write EVERY project's items with file tools, ` +
          `which is the cross-project reach the tool surface exists to prevent. NEXT STEP: reach ` +
          `the store through @telar/core's exported functions; never widen a session's write ` +
          `boundary onto it.`,
    );
    expect(violations).toEqual([]);

    // TWO-DIRECTION DISCRIMINATOR, through the SAME predicates, on fixtures
    // assembled at RUNTIME so this file's own source cannot satisfy them.
    // Both the grant word and the port name are assembled from fragments — the
    // grant word so this file is not itself reported as a granter, the port name
    // because `workspaceDir` is in STATE_ROOT_READERS and a literal here would
    // turn INV-7b red on this very file (INV-3g's rule, same reason).
    const grantWord = "writable" + "Roots";
    const wsPort = "workspace" + "Dir";
    const bad = `const opts = { ${grantWord}: [cwd, ${wsPort}()] };`;
    expect(GRANT.test(bad) && NAMES_WORKSPACE.test(bad)).toBe(true);
    // THE NEGATIVE CONTROL IS NO LONGER REAL CODE, and that is a downgrade
    // worth naming rather than hiding. It used to assert against
    // apps/web/lib/codex-app-server.ts, whose `writableRoots: [cwd]` is a
    // CORRECT grant that must not fire — a naive co-occurrence scan flagging it
    // would be an invariant nobody keeps. That file is frozen and there is no
    // real grant expression left in the tree, so the control is now a fixture
    // only. Re-point it at the first genuine Telar grant site.
    const good = `const opts = { ${grantWord}: [cwd] };`;
    expect(GRANT.test(good)).toBe(true);
    expect(NAMES_WORKSPACE.test(good)).toBe(false);
  });

  // RETIRED WITH apps/web — INV-11c. READ THIS BEFORE BUILDING THE vNext
  // WORKSPACE SURFACE; it is the one retired invariant that guards the thing
  // being built next.
  //
  // It ran the ACCEPT_STEMS scan over the workspace MCP server's own EXPORTED
  // TOOL-NAME CONSTANTS in apps/web/lib/workspace-mcp.ts, rather than over the
  // collected inventory. The distinction was the point: INV-1c caught an
  // accept-shaped tool at the REGISTRATION, this caught it AT THE CONSTANT,
  // which is where a rename actually gets made.
  //
  // THE RULE IT ENFORCED, restated so it can be re-applied rather than
  // re-derived: no workspace tool may be named anything accept-shaped —
  // accept/approve/confirm/finish/close/complete/deliver(ed|y)/done. A human
  // moves a queue row to its terminal state; an agent proposes and never
  // ratifies. The near-misses that MUST stay legal are the ones a naive filter
  // breaks on, e.g. `reject_*` and `answer_blocked`.
  //
  // acceptShapedTokens() is still in this file and still tested by INV-1d. When
  // the Telar workspace tool surface exists, this test is roughly six lines:
  // read the constants, map them through acceptShapedTokens, expect empty.


  test("INV-11d the store writes ONLY through atomicWrite — no writeFileSync, no appendFileSync", () => {
    // ANTI-VACUITY: the directory really was found and really was walked.
    if (workspaceFiles.length < 3) {
      throw new Error(
        `AD-6 / INV-11d: only ${workspaceFiles.length} files found under ${WORKSPACE_SRC_DIR} ` +
          `(floor 3: schema.ts, store.ts, index.ts). CONSEQUENCE: the write-path scan below would ` +
          `hold over an empty set. NEXT STEP: the WALK is broken — check ROOTS and EXCLUDED_DIRS.`,
      );
    }
    // THE SCAN SEES `fs.writeFileSync`, NOT ONLY A BARE `writeFileSync`. The
    // store imports fs as a namespace; an arm that could not fire on the only
    // spelling the store uses was a comment wearing a test's clothes, and a
    // mutation proved exactly that.
    const violations = workspaceFiles
      .filter((f) => fsCallsIn(f.code, WRITERS).length > 0)
      .map(
        (f) =>
          `${f.rel} writes with writeFileSync/appendFileSync. AD-6 — every write to a persisted ` +
            `store is ATOMIC (.tmp then renameSync), through manifest.ts's exported atomicWrite. ` +
            `CONSEQUENCE: a crash or a concurrent read mid-write leaves a TRUNCATED packet.yaml, ` +
            `and a packet holds \`raw\` verbatim with no source to be rebuilt from. NEXT STEP: ` +
            `import { atomicWrite } from "../manifest". (project-context.md's append-only ` +
            `exception covers the NDJSON stream class only; nothing here is in it.)`,
      );
    expect(violations).toEqual([]);
    // The POSITIVE half: the store really does write, through the sanctioned
    // idiom. Without this the arm passes for a store that writes nothing at all.
    expect(byRel.get(WORKSPACE_STORE)!.code).toContain("atomicWrite(");
    // ANTI-VACUITY ON THE RECEIVER, which is the half whose absence made this
    // arm vacuous: the store's fs binding really was FOUND. Rename the import
    // and the member scan would hold over an empty binding set again — this
    // turns that back into a red test rather than a silent hole.
    expect(fsBindings(byRel.get(WORKSPACE_STORE)!.code)).toContain("fs");

    // DISCRIMINATOR, THREE DIRECTIONS, on runtime-assembled fixtures.
    const IMPORTED = 'import fs from "node:fs";\n';
    // 1. the MUTATION THAT WALKED PAST THE OLD PATTERN now matches…
    expect(fsCallsIn(IMPORTED + "fs." + "writeFileSync" + "(file, data);", ["writeFileSync"])).toEqual([
      "writeFileSync",
    ]);
    // 2. …the bare named-import spelling still matches…
    expect(fsCallsIn("write" + "FileSync" + "(file, data);", ["writeFileSync"])).toEqual(["writeFileSync"]);
    // 3. …and a member call on some OTHER object still does not, which is the
    //    property the original lookbehind was protecting and this keeps.
    expect(fsCallsIn(IMPORTED + "shim." + "writeFileSync" + "(x);", ["writeFileSync"])).toEqual([]);
    // 4. THE ASYNC SPELLINGS OF THE SAME CAPABILITY, which a Sync-only name list
    //    would have let straight through: `node:fs/promises`, and `fs.promises.`
    //    off a plain `node:fs` binding. Both reach the same disk.
    expect(
      fsCallsIn('import fsp from "node:fs/promises";\nawait fsp.' + "writeFile" + "(f, d);", WRITERS),
    ).toEqual(["writeFile"]);
    expect(fsCallsIn(IMPORTED + "await fs.promises." + "writeFile" + "(f, d);", WRITERS)).toEqual([
      "writeFile",
    ]);
    // …and the namespace form of the import is found too.
    expect(
      fsCallsIn('import * as nodefs from "node:fs";\nnodefs.' + "writeFileSync" + "(f, d);", WRITERS),
    ).toEqual(["writeFileSync"]);
  });

  // RETIRED WITH apps/web — INV-11e. ALSO DIRECTLY RELEVANT TO THE vNext
  // WORKSPACE WORK.
  //
  // TWO SEPARATE CLAIMS about apps/web/lib/workspace-mcp.ts, both worth
  // carrying forward:
  //
  //   1. THE MCP SERVER DECLARED NO ENTITY SCHEMA. Persisted workspace shapes
  //      are owned by @telar/core (packages/core/src/workspace/schema.ts) and
  //      the tool layer took RAW zod shapes for tool INPUTS only. A second
  //      definition of an item is how the store and its surface drift into
  //      disagreeing about what an item is — NFR-X-5.
  //   2. IT HAD NO DELETE CALL. The workspace store is append-and-amend; rows
  //      reach terminal states, they are not removed by a tool.
  //
  // Both survive as DESIGN CONSTRAINTS on packages/core/src/workspace/store.ts,
  // which is untouched and still tested by INV-11a and INV-11d. What lapsed is
  // the guarantee that the TOOL SURFACE over it honours them — and there is no
  // tool surface at all right now, in Telar or anywhere.


  // RETIRED WITH apps/web — INV-11g. THE MOST IMPORTANT ONE ON THIS LIST for
  // the workspace rebuild, because it is a HUMAN-GATE invariant and those are
  // the ones this project treats as the moat.
  //
  // THE RULE: a workspace WEAVE — handing a set of queue rows to a loom — is
  // approval-gated in EVERY permission mode, including full-access and auto.
  // It checked BOTH halves, because either alone is satisfiable with the gate
  // gone: the PreToolUse hook that forces the approval card, AND all four
  // route sites that could otherwise start a weave around it.
  //
  // THE FAILURE IT PREVENTED, in its own words: "a weave could auto-run in
  // full-access/auto mode with no human ever seeing which of their queue rows
  // were handed to a loom." That is the same class of failure as an
  // agent-callable accept tool — work committed without the human who owns it
  // ever seeing the scope.
  //
  // Telar HAS NO PERMISSION MODES AT ALL. apps/engine/src/driver.ts passes
  // permissionMode "default" with no canUseTool and no hooks, so there is
  // currently no mode for a weave to escape through and nothing to gate. THAT
  // IS THE POINT TO WATCH: the moment Telar grows permission modes AND a
  // workspace weave, this invariant has to exist BEFORE the two meet, not
  // after. Restoring it later means auditing a surface that already shipped.


  test("INV-11f the quarantine did not grow — INV-11 added no KNOWN_VIOLATIONS entry", () => {
    // The shape INV-7f / INV-9e already use (INV-8h and INV-10e went with
    // apps/web). KNOWN_VIOLATIONS held at exactly ONE entry across nine
    // stories and is now TWO — the second is scripts/dev.mjs under INV-3,
    // added when freezing apps/web surfaced a pre-existing derivation. INV-3f
    // pins the LENGTH and explains the raise; this still pins the thing it was
    // written to pin, which is that INV-11 did not reach for the quarantine.
    expect(KNOWN_VIOLATIONS.filter((k) => k.invariant === "INV-11")).toEqual([]);
    expect(KNOWN_VIOLATIONS.length).toBe(2);
  });
});
