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
const ROOTS = [
  "packages/core/src",
  "packages/core/test",
  "apps/web",
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
const isExcludedDir = (name: string): boolean =>
  EXCLUDED_DIRS.has(name) || /^\.next-/.test(name);

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
// read by path, and a path.join-only matcher leaves the 18-site inventory
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
    const broken: string[] = [];
    if (INDEX.length < 400) {
      broken.push(
        `only ${INDEX.length} files walked (floor 400) — the scan index is BROKEN, not the tree. ` +
          `Every invariant below reads this index, so they would all hold vacuously. ` +
          `Check ROOTS, EXTENSIONS and EXCLUDED_DIRS against ${REPO}.`,
      );
    }
    if (CLIENT_FILES.length < 100) {
      broken.push(
        `only ${CLIENT_FILES.length} files carry a "use client" directive (floor 100) — the ` +
          `directive detector is BROKEN. INV-4 scans exactly this set, so it would pass by ` +
          `visiting nothing. Check firstStatement()/hasUseClientDirective().`,
      );
    }
    if (MCP_FILENAMES.length < 2) {
      broken.push(
        `only ${MCP_FILENAMES.length} *-mcp.ts files found (floor 2: loom-mcp.ts, ultra-mcp.ts) — ` +
          `the walk is not reaching apps/web/lib. INV-1 would pin an empty surface.`,
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
const ULTRA_MCP = "apps/web/lib/ultra-mcp.ts";
const ENGINE = "packages/core/src/engine.ts";
const LOOMS = "packages/core/src/looms.ts";
const TICK = "packages/core/src/tick.ts";
const CHAT_ROUTE = "apps/web/app/api/chat/route.ts";
const ACCEPT_ROUTE = "apps/web/app/api/looms/[id]/accept/route.ts";

// THE PINNED INVENTORY. A new tool fails this test until someone adds it here
// deliberately — that IS the mechanism, and the failure message says so. Pinning
// is a maintenance cost and the cost is the point: the deny-list below is the
// belt, but a name like `mark_delivered` is exactly what a pattern walks past.
const MCP_INVENTORY: Record<string, { file: string; tools: string[] }> = {
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
  ultra: { file: ULTRA_MCP, tools: ["ultra", "ultra_status", "ultra_stop"] },
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

describe("INV-1 no MCP surface exposes an accept tool — AD-1, the Human-Accept Moat", () => {
  const surfaces = MCP_SURFACES;
  const collected = new Map<string, { file: string; tools: string[] }>();
  for (const f of surfaces) {
    const servers = mcpServerNameLiterals(f.code, sdkBindings(f.code, MCP_FACTORY));
    const tools = toolNameLiterals(f.code, sdkBindings(f.code, TOOL_FACTORY));
    for (const server of servers) collected.set(server, { file: f.rel, tools });
  }
  const allToolNames = [...collected.values()].flatMap((s) => s.tools);

  test("INV-1a the set of MCP surfaces in the tree is exactly the three we know about", () => {
    // A FOURTH surface must fail here rather than be silently unscanned — that
    // is the difference between "no accept tool on the servers I remembered"
    // and "no accept tool anywhere".
    expect(surfaces.map((f) => f.rel).sort()).toEqual([LOOM_MCP, ENGINE, ULTRA_MCP].sort());
    expect([...collected.keys()].sort()).toEqual(["loom", "out", "ultra"]);
  });

  test("INV-1b the collected tool inventory EQUALS the pinned one, per server", () => {
    // Anti-vacuity FIRST: a scan that collected nothing would satisfy a
    // deny-list forever.
    const total = allToolNames.length;
    if (total < 17) {
      throw new Error(
        `AD-1 / INV-1: the MCP tool scan collected only ${total} tool names (floor 17: 13 loom + ` +
          `3 ultra + 1 out). CONSEQUENCE: the deny check below would hold over the empty set and ` +
          `an accept tool could be added without ever failing a test. NEXT STEP: this is the ` +
          `SCANNER that is broken, not the tree — check toolNameLiterals() and MCP_SURFACES.`,
      );
    }
    const observed: Record<string, { file: string; tools: string[] }> = {};
    for (const [server, v] of collected) observed[server] = v;
    // AC2 — a bare toEqual on two nested objects prints a diff that names no AD,
    // no consequence and no next step, and AC1 requires the pin be asserted
    // EQUAL. So the DIAGNOSIS IS THROWN FIRST and the equality stays as the
    // mechanism: whichever fires, the reader gets a paragraph, not a diff.
    const drift: string[] = [];
    for (const server of new Set([...Object.keys(observed), ...Object.keys(MCP_INVENTORY)])) {
      const found = observed[server];
      const pinned = MCP_INVENTORY[server];
      if (!pinned) {
        drift.push(`server "${server}" (${found!.file}) is NEW and is not in the pinned inventory`);
        continue;
      }
      if (!found) {
        drift.push(`pinned server "${server}" (${pinned.file}) is GONE from the tree`);
        continue;
      }
      if (found.file !== pinned.file) {
        drift.push(`server "${server}" moved from ${pinned.file} to ${found.file}`);
      }
      const gained = found.tools.filter((t) => !pinned.tools.includes(t));
      const lost = pinned.tools.filter((t) => !found.tools.includes(t));
      if (gained.length) drift.push(`server "${server}" GAINED ${JSON.stringify(gained)}`);
      if (lost.length) drift.push(`server "${server}" LOST ${JSON.stringify(lost)}`);
      const reordered = JSON.stringify(found.tools) !== JSON.stringify(pinned.tools);
      if (!gained.length && !lost.length && reordered) {
        drift.push(
          `server "${server}" has the same tools in a DIFFERENT ORDER — cosmetic, not a moat ` +
            `breach; re-pin the order`,
        );
      }
    }
    if (drift.length) {
      throw new Error(
        `AD-1 / INV-1: the MCP tool inventory MOVED — ${drift.join("; ")}. THE RULE: ready to done ` +
          `is a HUMAN-ONLY transition and there is no agent-callable accept tool on any MCP ` +
          `surface; the pin is what makes a new tool a deliberate act rather than a diff nobody ` +
          `read. CONSEQUENCE: a model that can complete its own work voids every verdict ` +
          `downstream of it. NEXT STEP: ${ADDING_A_TOOL}`,
      );
    }
    expect(observed).toEqual(MCP_INVENTORY);
  });

  test("INV-1c no collected tool name is accept-shaped, and the near-misses still pass", () => {
    const violations = allToolNames
      .map((name) => ({ name, hits: acceptShapedTokens(name) }))
      .filter((v) => v.hits.length > 0)
      .map(
        (v) =>
          `${v.name}: token(s) ${JSON.stringify(v.hits)} are accept-shaped. AD-1 — ready to done ` +
            `is a HUMAN-ONLY transition and there is no agent-callable accept tool on any MCP ` +
            `surface. CONSEQUENCE: a model could complete its own work, which voids every verdict ` +
            `downstream of it. NEXT STEP: ${ADDING_A_TOOL}`,
      );
    expect(violations).toEqual([]);
    // reject_loom and answer_blocked are the near-misses that MUST stay
    // passing: a naive /done|complete/ over DESCRIPTIONS rather than names
    // trips on both, and an invariant that fires on correct code gets deleted.
    expect(allToolNames).toContain("reject_loom");
    expect(allToolNames).toContain("answer_blocked");
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

  test("INV-1e the construction half — acceptLoom is the only done writer in core and has one importer", () => {
    const doneWriters = NON_TEST.filter(
      (f) => f.rel.startsWith("packages/core/src/") && /\.state\s*=\s*["']done["']/.test(f.code),
    ).map((f) => f.rel);
    expect(doneWriters).toEqual([LOOMS]);

    // AD-1 names tick.ts as part of the construction half. It only ever READS
    // state === "done" for subgoal readiness; it must never assign it.
    expect(/\.state\s*=\s*["']done["']/.test(byRel.get(TICK)!.code)).toBe(false);

    // No MCP tool has a call path to acceptLoom: loom-mcp.ts does not import it.
    const loomMcpCoreSpecifiers = importStatements(byRel.get(LOOM_MCP)!.code)
      .filter((s) => importSource(s) === "@telar/core")
      .flatMap((s) => s.slice(s.indexOf("{") + 1, s.lastIndexOf("}")).split(","))
      .map((s) => s.trim().replace(/^type\s+/, ""))
      .filter(Boolean);
    expect(loomMcpCoreSpecifiers.length).toBeGreaterThanOrEqual(10); // floor: the list is real
    expect(loomMcpCoreSpecifiers).not.toContain("acceptLoom");

    // Exactly one importer in the whole tree, and it hardcodes `by`. Resolved
    // through the BINDINGS rather than by matching the name in the statement
    // text: `import { acceptLoom as land } from "@telar/core";` is a second call
    // path to the only `done` writer in core, and a text match for
    // `acceptLoom` followed by a comma or a closing brace never sees it. Same
    // for a namespace import that reaches it as `core.acceptLoom(`, and same for
    // an `export { acceptLoom } from "@telar/core"` re-export shim.
    const importers = NON_TEST.filter((f) => {
      const { direct, namespaces } = localNamesFor(f.code, "acceptLoom", isCoreSpecifier);
      if (direct.length > 0) return true;
      return namespaces.some((ns) =>
        new RegExp(`(?<![A-Za-z0-9_$.])${escapeRe(ns)}\\.acceptLoom\\s*\\(`).test(f.code),
      );
    }).map((f) => f.rel);
    expect(importers).toEqual([ACCEPT_ROUTE]);
    // `by` is server-derived, never read from the request body — the model
    // cannot name who approved its own commit.
    expect(byRel.get(ACCEPT_ROUTE)!.code).toContain('acceptLoom(id, "you"');
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

  test("INV-1g the hook half — the chat route wires PreToolUse and names both moat constants", () => {
    const route = byRel.get(CHAT_ROUTE)!;
    const loomMcp = byRel.get(LOOM_MCP)!;

    // Assert on the exported CONSTANTS, never on the reason strings: prose in a
    // route this story must not edit will change for unrelated reasons, and an
    // invariant that breaks on an unrelated edit gets deleted rather than fixed.
    const start = exportedStringConst(loomMcp.code, "LOOM_START_TOOL");
    const answerBlocked = exportedStringConst(loomMcp.code, "LOOM_ANSWER_BLOCKED_TOOL");
    const auto = exportedStringArray(loomMcp.code, "LOOM_AUTO_TOOLS");
    const routeImports = importStatements(route.code)
      .filter((s) => importSource(s) === "@/lib/loom-mcp")
      .join("\n");

    // AC2 — this block was twelve bare assertions whose output named nothing
    // ("expected route.code to contain …" is a failing grade for AC2 even when
    // the assertion is correct). Every check now carries the AD id, the rule,
    // the consequence and the next step INTO THE ASSERTED VALUE, so the diff bun
    // prints IS the message. This is AD-1's SECOND enforcement half; the first
    // is INV-1e.
    const HOOK =
      "AD-1 — the Human-Accept Moat is enforced TWICE: by construction in packages/core " +
      "(looms.ts, tick.ts) and at the TOOL LAYER by the chat route's PreToolUse hook, in every " +
      "SDK permission mode. This is the tool-layer half. ";
    const broken: string[] = [];
    const pinnedConstant = (name: string, got: string | null, want: string) => {
      if (got !== want) {
        broken.push(
          `${LOOM_MCP} no longer exports ${name} = "${want}" (found ${JSON.stringify(got)}). ` +
            HOOK +
            `CONSEQUENCE: the route's guardrail compares tool_name against a constant that no ` +
            `longer names the real tool, so the gate matches nothing while still looking wired. ` +
            `NEXT STEP: restore the export, or move BOTH the constant and the route's comparison ` +
            `together and re-pin them here.`,
        );
      }
    };
    pinnedConstant("LOOM_START_TOOL", start, "mcp__loom__start_loom");
    pinnedConstant("LOOM_ANSWER_BLOCKED_TOOL", answerBlocked, "mcp__loom__answer_blocked");

    if ((auto?.length ?? 0) < 8) {
      broken.push(
        `LOOM_AUTO_TOOLS parsed as ${auto?.length ?? "null"} entries (floor 8). This is the ` +
          `SCANNER failing, not the tree: exportedStringArray() no longer matches the ` +
          `declaration's shape. CONSEQUENCE: every "is not pre-approved" check below holds over ` +
          `the empty set. NEXT STEP: fix exportedStringArray(), do not lower the floor.`,
      );
    }
    for (const [name, value] of [
      ["LOOM_START_TOOL", start],
      ["LOOM_ANSWER_BLOCKED_TOOL", answerBlocked],
    ] as const) {
      const bare = (value ?? "").replace("mcp__loom__", "");
      if (value && !MCP_INVENTORY.loom!.tools.includes(bare)) {
        broken.push(
          `${name} points at "${bare}", which is not a tool on the loom server. ` +
            HOOK +
            `CONSEQUENCE: the hook guards a tool name nothing registers, so the tool it was meant ` +
            `to guard runs ungated. NEXT STEP: reconcile the constant with MCP_INVENTORY.`,
        );
      }
      if (value && auto?.includes(value)) {
        broken.push(
          `${name} appears in LOOM_AUTO_TOOLS. ` +
            HOOK +
            `CONSEQUENCE: a pre-approved tool takes the SDK's fast path and runs with no ` +
            `interactive card, which is precisely the human step the moat exists to require. ` +
            `NEXT STEP: remove it from LOOM_AUTO_TOOLS.`,
        );
      }
      if (!routeImports.includes(name)) {
        broken.push(
          `${CHAT_ROUTE} no longer imports ${name} from @/lib/loom-mcp. ` +
            HOOK +
            `CONSEQUENCE: the guardrail can only be comparing against a literal or against ` +
            `nothing; a literal drifts from the constant silently. NEXT STEP: import the symbol.`,
        );
      }
      if (!route.code.includes(`input.tool_name === ${name}`)) {
        broken.push(
          `${CHAT_ROUTE}'s guardrail no longer compares input.tool_name against ${name}. ` +
            HOOK +
            `CONSEQUENCE: that tool reaches the model ungated at the tool layer, leaving the moat ` +
            `resting entirely on the by-construction half. NEXT STEP: restore the comparison in ` +
            `preToolUseGuardrail.`,
        );
      }
    }
    if (!/hooks\s*:\s*\{\s*PreToolUse\s*:/.test(route.code)) {
      broken.push(
        `${CHAT_ROUTE} no longer wires a PreToolUse hook at all. ` +
          HOOK +
          `CONSEQUENCE: the entire tool-layer half of the moat is gone, in every permission mode. ` +
          `NEXT STEP: restore the hooks: { PreToolUse: … } wiring on the query options.`,
      );
    }
    if (!route.code.includes("preToolUseGuardrail")) {
      broken.push(
        `${CHAT_ROUTE} no longer references preToolUseGuardrail. ` +
          HOOK +
          `CONSEQUENCE: the hook may be wired to something that does not carry the moat's checks. ` +
          `NEXT STEP: restore the guardrail, or rename it here and in the route together.`,
      );
    }
    expect(broken).toEqual([]);
  });
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

// The 18 sites, as `<file> :: <composed literal>`. Re-derive this; do not trust
// it. It is the invariant's whole content.
const AD5_SITES = [
  "apps/web/lib/mcp-oauth-pending.ts :: mcp-oauth-pending.json",
  "apps/web/lib/permissions.ts :: permissions.json",
  "apps/web/lib/session-log.ts :: sessions",
  "apps/web/lib/store.ts :: chats.json",
  "apps/web/lib/store.ts :: plan-usage.json",
  "packages/core/src/accounts.ts :: accounts.json",
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
];

// Who OWNS each thing composed off the root. AD-5's rule is one owner per
// subtree; root-level FILES belonging to no module are AD-20's, not AD-5's, and
// are still listed here because the composing module is their sole writer.
const AD5_OWNERS: Record<string, string[]> = {
  "projects.json": ["packages/core/src/manifest.ts"],
  "accounts.json": ["packages/core/src/accounts.ts"],
  "credentials.json": ["packages/core/src/secrets.ts"],
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
  // CO-TENANCY 1, recorded as a NAMED FACT rather than as silence, because an
  // invariant that quietly permits it teaches the next reader it is fine.
  // AD-5 assigns sessions/<sessionId>/ to the session module; core owns
  // `.runner-lease` (sessions.ts) and apps/web/lib/session-log.ts owns
  // `live.ndjson` in the SAME directory. That is a real hole in WORK-SPLIT's
  // disjoint-write-set guarantee (story 1.2, Completion Note 1) and epics 2 and
  // 3 need to know. Core guards the id and FAILS CLOSED on an id session-log.ts
  // would happily write — a stated asymmetry, not an accident. A THIRD writer
  // fails this test, which is the point of listing exactly two.
  sessions: ["packages/core/src/sessions.ts", "apps/web/lib/session-log.ts"],
  "permissions.json": ["apps/web/lib/permissions.ts"],
  "mcp-oauth-pending.json": ["apps/web/lib/mcp-oauth-pending.ts"],
  // CO-TENANCY 2: store.ts resolves its root TWO WAYS within one file —
  // chats.json / plan-usage.json through its own stateRoot(), usage.ndjson
  // through core's telarDir() reached via the ledger port. The two expressions
  // are byte-identical today. Recorded in deferred-work.md; not fixed here.
  "chats.json": ["apps/web/lib/store.ts"],
  "plan-usage.json": ["apps/web/lib/store.ts"],
};

// The five modules that legitimately derive the state root from scratch. Their
// duplication is deliberate-and-separately-tracked (deferred-work.md); new code
// takes the import instead.
const SANCTIONED_ROOT_RESOLVERS = [
  "packages/core/src/looms.ts",
  "packages/core/src/manifest.ts",
  "apps/web/lib/permissions.ts",
  "apps/web/lib/session-log.ts",
  "apps/web/lib/store.ts",
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
];

describe("INV-3 no module reads another module's TELAR_HOME subtree by path — AD-5", () => {
  const observed = COMPOSITION_SITES.map((c) => `${c.file} :: ${c.site.composes}`).sort();

  test("INV-3a the path-composition inventory is exact", () => {
    // Anti-vacuity FIRST. A scan finding nothing would make every ownership
    // claim below hold over the empty set.
    if (COMPOSITION_SITES.length < 15) {
      throw new Error(
        `AD-5 / INV-3: only ${COMPOSITION_SITES.length} TELAR_HOME path-composition sites found ` +
          `(floor 15, measured 18). CONSEQUENCE: the ownership check below would pass while ` +
          `scanning nothing. NEXT STEP: the SCANNER is broken — check rootCompositionSites() and ` +
          `ROOT_RESOLVERS, which today are ${JSON.stringify(ROOT_RESOLVERS)}.`,
      );
    }
    // AC2 — a bare toEqual on two 18-element arrays prints a diff naming no AD,
    // no consequence and no next step. The diagnosis is thrown first; the
    // equality stays as the mechanism ("the 18-site table is exact").
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

  test("INV-3d nothing is asserted about projects or workspace, because neither exists yet", () => {
    // Documented as an assertion so a future reader does not "restore" a check
    // over the empty set. When the planned AD-5 layout lands, these flip from
    // absent to owned and this test is where that shows up.
    const planned = observed.filter((s) => / :: (projects|workspace)$/.test(s));
    expect(planned).toEqual([]);
    // …and the flat layout that DOES exist is present, so this is a statement
    // about today's tree rather than about a broken scan.
    expect(observed).toContain("packages/core/src/looms.ts :: looms");
  });

  test("INV-3e only the five sanctioned resolvers derive the state root from scratch", () => {
    const unsanctioned = HOME_DERIVERS.filter((f) => !SANCTIONED_ROOT_RESOLVERS.includes(f));
    // FILTERED BY INVARIANT, not by filename. An entry quarantining an AD-20
    // violation in some file must not also excuse an entirely unrelated raw
    // ~/.telar derivation in that same file that nobody ever agreed to excuse —
    // a quarantine widens by one line otherwise, and silently.
    const quarantined = KNOWN_VIOLATIONS.filter((k) => k.invariant === "INV-3").map((k) => k.file);
    // Anti-vacuity: the five really are found, so a broken pattern cannot pass.
    expect(HOME_DERIVERS.length).toBeGreaterThanOrEqual(5);
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
    if (KNOWN_VIOLATIONS.length !== 1) {
      throw new Error(
        `KNOWN_VIOLATIONS holds ${KNOWN_VIOLATIONS.length} entries; this test was written when it ` +
          `held exactly 1 (scripts/backfill-tool-detail.ts, INV-3). Each entry is a REAL ` +
          `violation of a REAL invariant left in place only because the file belongs to another ` +
          `track's write set. CONSEQUENCE: a list that grows without a reviewer noticing is how ` +
          `an invariant becomes decorative. NEXT STEP: if the new entry is genuinely someone ` +
          `else's write set, record it in deferred-work.md the way the first one is, then update ` +
          `this count deliberately in the same commit.`,
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
    // path.join-only matcher leaves the 18-site table unchanged while a new
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

// ── INV-4 — client components import no core runtime (AD-3 / NFR-X-3) ───────
// The highest-value of the five, because NOTHING enforces it today: no lint
// rule (apps/web/eslint.config.mjs is bare eslint-config-next core-web-vitals +
// typescript, with no consistent-type-imports), no build-time boundary test, no
// bundle inspection. It is held up by convention plus a dozen hand-written
// per-file comments — exactly the "true by review, re-checked by nothing"
// condition AD-19 exists to end.
//
// WHY IT MATTERS MECHANICALLY, so the failure message can say it:
// apps/web/next.config.ts sets transpilePackages: ["@telar/core"], so core is
// NOT treated as an external — Next transpiles its source straight into
// whichever bundle imports it. And packages/core/src/index.ts is a RUNTIME
// BARREL (export * from "./schemas" / "./providers" / "./secrets" / "./mcp" /
// "./mcp-oauth"), which instrumentation.ts's own comment describes as pulling in
// "Node-only modules (fs, child_process, the agent SDK)". ONE value import is
// the whole barrel. godview.ts's header states the consequence in one line: "a
// single runtime VALUE import drags async_hooks into the browser bundle and
// breaks the build."
//
// TWO HALVES, and the second is the one that bites.
//
// DIRECT: every @telar/core import in a client file must be type-only. T-4 —
// nearly every such import here spans five or more lines, so a LINE-based check
// sees `} from "@telar/core";`, finds no `type` keyword, and reports every
// compliant file as a violation. Whole STATEMENTS are parsed instead.
//
// TRANSITIVE: BFS following VALUE EDGES ONLY. This is the single decision that
// makes INV-4 usable rather than permanently red. A type-only import is erased
// at build and CANNOT smuggle runtime, so traversing it produces false
// positives on today's tree: apps/web/lib/store.ts is a local barrel that mixes
// fs/os/path AND a runtime @telar/core import AND
// `export { logUsage, usageSummary } from "@telar/core"`, and four client files
// import from @/lib/store — all four `import type`. Traverse those type-only
// edges and you report four violations that are not violations and cannot be
// fixed. Traverse only value edges and today's tree is clean WHILE THE REAL
// REGRESSION IS STILL CAUGHT: flip any one of those four to a plain import and
// fs, os, path and core's whole runtime barrel enter the client bundle through
// that one file. That is the invariant.
const GODVIEW = "apps/web/components/looms/godview.ts";

// `@/*` → `apps/web/*` (apps/web/tsconfig.json paths). Anything else bare is a
// package and is not traversed — except @telar/core, which is the target.
function resolveLocalImport(fromRel: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = `apps/web/${spec.slice(2)}`;
  else if (spec.startsWith("./") || spec.startsWith("../")) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  } else return null;
  for (const suffix of ["", ".ts", ".tsx", ".mts", ".js", ".mjs"]) {
    if (byRel.has(base + suffix)) return base + suffix;
  }
  for (const suffix of ["/index.ts", "/index.tsx", "/index.mts", "/index.js", "/index.mjs"]) {
    if (byRel.has(base + suffix)) return base + suffix;
  }
  return null;
}

const isCoreSpecifier = (spec: string): boolean =>
  spec === "@telar/core" || spec.startsWith("@telar/core/");
// The SAME runtime, reached by a different spelling. A relative
// `../../../packages/core/src/usage-ledger` import pulls core into the client
// bundle exactly as `@telar/core` does; gating the violation branch on the
// package specifier alone meant that form was merely TRAVERSED and never
// reported.
const CORE_SRC = "packages/core/src/";

const CLIENT_SCAN = (() => {
  const visited = new Set<string>();
  const parent = new Map<string, string>();
  const queue: string[] = [];
  for (const f of CLIENT_FILES) {
    if (visited.has(f.rel)) continue;
    visited.add(f.rel);
    queue.push(f.rel);
  }
  const roots = new Set(visited);
  const chain = (rel: string): string => {
    const parts = [rel];
    let cur = rel;
    while (parent.has(cur)) {
      cur = parent.get(cur)!;
      parts.unshift(cur);
    }
    return parts.map((p) => p.replace(/^apps\/web\//, "")).join(" → ");
  };

  let edges = 0;
  let clientCoreImports = 0;
  let coreImportsSeen = 0;
  const violations: string[] = [];

  for (let head = 0; head < queue.length; head++) {
    const rel = queue[head]!;
    const file = byRel.get(rel)!;
    // BOTH KINDS OF EDGE. `export { logUsage } from "@telar/core"` is a value
    // edge with no `import` line in it: a two-line shim of exactly that shape,
    // value-imported by a "use client" component, is a genuine AD-3 breach that
    // an import-anchored scan reports as [].
    for (const stmt of moduleEdgeStatements(file.code)) {
      const spec = importSource(stmt);
      if (!spec) continue;
      const target = resolveLocalImport(rel, spec);
      if (isCoreSpecifier(spec) || (!!target && target.startsWith(CORE_SRC))) {
        coreImportsSeen++;
        if (roots.has(rel)) clientCoreImports++;
        if (!isTypeOnlyImport(stmt)) {
          violations.push(
            `${chain(rel)} → ${spec} (VALUE import of core runtime). AD-3 — @telar/core is ` +
              `server-side only ` +
              `(fs, child_process, the agent SDK); client components import TYPES ONLY, which are ` +
              `erased at build. CONSEQUENCE: next.config.ts sets transpilePackages: ["@telar/core"], ` +
              `so core is transpiled straight into this bundle — one value import pulls the whole ` +
              `runtime barrel and drags async_hooks into the browser, breaking the build. ` +
              `NEXT STEP: make it \`import type\`, or move the runtime call into a Route Handler, ` +
              `a Server Component or instrumentation.ts and pass the result down as data.`,
          );
        }
        continue;
      }
      // A type-only edge is erased at build and cannot smuggle runtime, so it
      // is NOT traversed. Traversing it is what would make this invariant
      // permanently red on a tree that is actually correct.
      if (isTypeOnlyImport(stmt)) continue;
      if (!target || isTestFile(target)) continue;
      edges++;
      if (!visited.has(target)) {
        visited.add(target);
        parent.set(target, rel);
        queue.push(target);
      }
    }
  }
  return { visited, edges, clientCoreImports, coreImportsSeen, violations };
})();

if (VERBOSE) {
  line(
    `  INV-4 BFS: ${CLIENT_SCAN.visited.size} modules visited from ${CLIENT_FILES.length} client ` +
      `roots · ${CLIENT_SCAN.edges} value edges · ${CLIENT_SCAN.clientCoreImports} client→core ` +
      `import statements · ${CLIENT_SCAN.coreImportsSeen} core imports seen in total`,
  );
}

describe("INV-4 client components import no core runtime — AD-3, the CLIENT-BUNDLE RULE", () => {
  test("INV-4a the three anti-vacuity floors hold before any violation is claimed", () => {
    const broken: string[] = [];
    if (CLIENT_FILES.length < 100) {
      broken.push(`only ${CLIENT_FILES.length} client files (floor 100) — the directive detector is broken`);
    }
    if (CLIENT_SCAN.clientCoreImports < 20) {
      broken.push(
        `only ${CLIENT_SCAN.clientCoreImports} client→core import statements examined (floor 20, ` +
          `measured 36). This half finds ZERO violations on a correct tree, so the floor is the ` +
          `ONLY thing proving it ran. Check importStatements() and isTypeOnlyImport().`,
      );
    }
    if (CLIENT_SCAN.edges < 50) {
      broken.push(
        `only ${CLIENT_SCAN.edges} value edges traversed (floor 50) — the BFS is not walking the ` +
          `local module graph. Check resolveLocalImport(); "@/" maps to apps/web/.`,
      );
    }
    expect(broken).toEqual([]);
  });

  test("INV-4b the BFS reaches godview.ts, the file that proves the design", () => {
    // godview.ts is NOT a client file, is imported BY VALUE from client
    // components (they use its derivations and its isWoven/isTerminal
    // re-exports), and is the one file whose TRANSITIVE obligation matters
    // most. If it is not in the visited set the traversal is broken and the
    // whole second half of this invariant is asserting nothing.
    expect(CLIENT_SCAN.visited.has(GODVIEW)).toBe(true);
    expect(byRel.get(GODVIEW)!.isClient).toBe(false);
    // Its own header states the rule it is standing in for.
    expect(byRel.get(GODVIEW)!.text).toContain("import type");
  });

  test("INV-4c no client component reaches core runtime, directly or through a value edge", () => {
    expect(CLIENT_SCAN.violations).toEqual([]);
  });

  test("INV-4d the import scan DISCRIMINATES — multi-line type-only passes, one value specifier fails", () => {
    // T-4 in both directions, through the SAME parser the BFS uses.
    const CORE = "@telar/" + "core";
    const multiline = `import type {\n  Loom,\n  ProjectManifest,\n  RegistryEntry,\n} from "${CORE}";`;
    expect(importStatements(multiline).length).toBe(1);
    expect(isTypeOnlyImport(multiline)).toBe(true);
    expect(isTypeOnlyImport(`import { type Loom, type WorkUnitState } from "${CORE}";`)).toBe(true);
    // The inverse error: one type import and one value import in the same file,
    // or one value specifier among many type ones.
    expect(isTypeOnlyImport(`import { logUsage } from "${CORE}";`)).toBe(false);
    expect(isTypeOnlyImport(`import { type Loom, logUsage } from "${CORE}";`)).toBe(false);
    expect(isTypeOnlyImport(`import Store, { type Loom } from "@/lib/store";`)).toBe(false);
    expect(isTypeOnlyImport(`import * as core from "${CORE}";`)).toBe(false);
    // Two statements in one file are two statements, not one blob.
    expect(
      importStatements(`import type { A } from "${CORE}";\nimport { b } from "./b";\n`).length,
    ).toBe(2);
    // And the resolver really resolves — both spellings of the same target.
    expect(resolveLocalImport("apps/web/components/looms/thread-drawer.tsx", "./godview")).toBe(
      GODVIEW,
    );
    expect(resolveLocalImport("apps/web/app/looms/[id]/page.tsx", "@/components/looms/godview")).toBe(
      GODVIEW,
    );
    expect(resolveLocalImport("apps/web/components/x.tsx", "react")).toBe(null);

    // THE RE-EXPORT EDGE, which an import-anchored scan cannot see at all. A
    // shim whose entire contents are `export { logUsage } from "@telar/core";`
    // has no `import` line in it, so the first version of this scan neither
    // checked it for type-only-ness nor traversed it — while it drags core's
    // runtime barrel into whatever bundle imports the shim.
    const shim = `export { logUsage } from "${CORE}";\n`;
    expect(importStatements(shim)).toEqual([]);
    expect(reExportStatements(shim).length).toBe(1);
    expect(moduleEdgeStatements(shim).length).toBe(1);
    expect(isTypeOnlyImport(reExportStatements(shim)[0]!)).toBe(false);
    expect(isTypeOnlyImport(`export type { Loom } from "${CORE}";`)).toBe(true);
    expect(isTypeOnlyImport(`export * from "./looms";`)).toBe(false);
    // A LOCAL `export { a };` has no `from` and is not an edge — and must not
    // run away swallowing later lines looking for one.
    expect(reExportStatements("export { a, b };\nimport { c } from \"./c\";\n")).toEqual([]);

    // THE RELATIVE SPELLING of the same runtime. This resolves INTO the core
    // source tree, which is byte-for-byte the same bundle content as the package
    // specifier; the violation branch used to be gated on `@telar/core` alone,
    // so this form was merely traversed and never reported.
    expect(CORE_SRC).toBe("packages/core/src/");
    const viaRelative = resolveLocalImport(
      "apps/web/components/looms/godview.ts",
      "../../../../packages/core/src/usage-ledger",
    );
    expect(viaRelative).toBe("packages/core/src/usage-ledger.ts");
    expect(viaRelative!.startsWith(CORE_SRC)).toBe(true);
  });

  test("INV-4e the substring shortcut is measurably wrong, which is why the directive is used", () => {
    // T-5, pinned as a fact rather than a comment: the gap is four files and
    // one of them imports node:fs. A substring match would report a SERVER-ONLY
    // module as a client component and fail INV-4 on today's tree for a reason
    // that is not a violation.
    expect(SUBSTRING_USE_CLIENT).toBeGreaterThan(CLIENT_FILES.length);
    const substringOnly = INDEX.filter(
      (f) => f.rel.startsWith("apps/web/") && f.text.includes("use client") && !f.isClient,
    ).map((f) => f.rel);
    expect(substringOnly).toContain("apps/web/lib/permissions.ts");
    expect(byRel.get("apps/web/lib/permissions.ts")!.code).toContain("node:fs");
    // The mirror-image hazard: godview.ts contains the phrase and is not a
    // client file. Misclassifying it would replace a real check with a trivial
    // one, because a client file's own imports are checked directly while
    // godview.ts's only matter transitively.
    expect(substringOnly).toContain(GODVIEW);
  });
});

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

  test("INV-5b the three production logUsage call sites are the only ones, one per UsageOwnerKind", () => {
    const callers = NON_TEST.filter(
      (f) => reachableCallSites(f.code, "logUsage", ownsSymbol("usage-ledger")) > 0,
    ).map((f) => f.rel);
    expect(callers.sort()).toEqual([CHAT_ROUTE, ULTRA_STORAGE, WEAVE].sort());
    // A pleasing and checkable correspondence: one caller per owner kind.
    // weave.ts and ultra/storage.ts pass theirs explicitly; the chat route
    // relies on the schema default, which is LOAD-BEARING rather than a
    // placeholder — it is what makes a pre-attribution record still fold into
    // the session-scoped projections.
    expect(byRel.get(WEAVE)!.code).toContain('ownerKind: "loom"');
    expect(byRel.get(ULTRA_STORAGE)!.code).toContain('ownerKind: "ultra"');
    expect(byRel.get(SCHEMAS)!.code).toContain('UsageOwnerKind.default("session")');
    expect(byRel.get(SCHEMAS)!.code).toContain('z.enum(["session", "loom", "ultra"])');
  });

  test("INV-5c apps/web re-exports the ledger port instead of reimplementing it", () => {
    // This is what keeps the rule true across the workspace boundary.
    const store = byRel.get(STORE)!.code;
    expect(store).toContain('export { logUsage, usageSummary } from "@telar/core";');
    expect(store).toContain('export type { UsageEntry, UsageWindow } from "@telar/core";');
    expect(store).toContain("ledgerReadDegraded");
    expect(store).toContain("usageCostBySession");
    expect(composesStateFile(store, "usage.ndjson")).toBe(false);
  });

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
const ROUTE_SRC = byRel.get("apps/web/app/api/chat/route.ts");

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

  test("INV-6c the chat route resolves the session profile BEFORE the stream opens", () => {
    if (!ROUTE_SRC) {
      throw new Error(
        `AD-9 / INV-6: apps/web/app/api/chat/route.ts is not in the scan index. CONSEQUENCE: the ` +
          `ordering claim below would hold vacuously. NEXT STEP: fix the walk, not the assertion.`,
      );
    }
    // `.code` (comments blanked) and not `.text`: this route's own comments
    // NAME both `resolveSessionProfile` and `new ReadableStream`, and a scan
    // that read prose would compare a comment's position to a call site's.
    const code = ROUTE_SRC.code;
    const resolveAt = code.indexOf("resolveSessionProfile(");
    const unmetAt = code.indexOf("unmetCapabilities(");
    const streamAt = code.indexOf("new ReadableStream(");
    const registerAt = code.indexOf("registerChatRun(");
    if (resolveAt < 0 || unmetAt < 0 || streamAt < 0 || registerAt < 0) {
      throw new Error(
        `AD-9/AD-11 / INV-6: a call site this invariant orders is MISSING from the chat route — ` +
          `resolveSessionProfile@${resolveAt}, unmetCapabilities@${unmetAt}, ` +
          `new ReadableStream@${streamAt}, registerChatRun@${registerAt}. CONSEQUENCE: the ` +
          `"resolved before the route body" and "fails before the stream opens" claims would ` +
          `both pass over an absent call. NEXT STEP: if the route legitimately stopped resolving ` +
          `a profile, this invariant is what should be re-argued — not deleted.`,
      );
    }
    // AC1: "before the route body executes". `new ReadableStream({` IS the
    // route body — everything from there on is the SSE start(controller)
    // closure, and once it begins a failure can only become an SSE `error`
    // event, never a status code.
    expect(resolveAt).toBeLessThan(streamAt);
    // AD-11: the capability gate must also precede registerChatRun, whose only
    // cleanup is endChatRun inside the stream's `finally`. A 400 returned after
    // it leaves a registered run with no stream to end.
    expect(unmetAt).toBeLessThan(registerAt);
    expect(unmetAt).toBeLessThan(streamAt);
    // The registry is populated by a SIDE-EFFECT import, and without it
    // resolveSessionProfile throws on every chat request. There is no test file
    // for this route anywhere in the tree, so bun test / tsc / lint all stay
    // green while the app is broken — this line is the only mechanical guard.
    // `.code` and not `.text`, for the same reason the ordering scan uses it
    // and every INV-1g pin does: `// import "@/lib/session-profiles";` left
    // behind by a debugging session is a DEAD import that keeps the literal in
    // `.text`, so a `.text` check would stay green over an app that 500s on
    // every chat request. Deletion is caught either way; commenting-out is only
    // caught here.
    expect(ROUTE_SRC.code).toContain('import "@/lib/session-profiles";');
  });

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

  test("INV-6e the chat route branches on NO session kind — every kind resolves through the profile", () => {
    // AD-9's promise, made mechanical: "a new surface adds a profile; it does
    // not add an `if`." Story 2.2 is the story that made that true of the
    // handler that exists, and a prose claim about a ~1900-line file is not
    // checkable — so this is.
    //
    // BOTH HALVES ARE REQUIRED, and the second is the one story 1.1's Repair
    // Round 4 paid for: "a guard must read the same value as the thing it
    // guards." Deleting the three flags AND never consuming the profile would
    // satisfy the absence half alone, while the route quietly went back to
    // computing everything inline — so the presence half is the anti-vacuity
    // floor, not a bonus assertion.
    if (!ROUTE_SRC) {
      throw new Error(
        `AD-9 / INV-6e: apps/web/app/api/chat/route.ts is not in the scan index. CONSEQUENCE: ` +
          `both halves below would hold vacuously and the route could carry every session-kind ` +
          `conditional AD-9 forbids. NEXT STEP: fix the walk, not the assertion.`,
      );
    }
    // `.code` (comments blanked) and never `.text`, for the reason INV-6c
    // records and this test makes acute: after story 2.2 the route's own
    // comments legitimately DISCUSS isEscalationSession in the past tense
    // ("There is no isPlannerSession / isSteererSession / isEscalationSession
    // any more"), so a `.text` scan would fail over a correct file. The mirror
    // failure is the one that matters: a commented-out flag left by a debugging
    // session keeps the literal in `.text`, so a `.text` check stays green over
    // a route that still branches.
    const code = ROUTE_SRC.code;

    // Assembled at runtime, never written as a literal: packages/core/test is
    // one of this scanner's own roots, and a literal here would make this file
    // a fixture for itself. Same idiom INV-6d already uses.
    const KIND_FLAGS = ["is" + "PlannerSession", "is" + "SteererSession", "is" + "EscalationSession"];
    // THE predicate. The discriminator below runs this exact function, so a
    // scan that stopped matching fails immediately instead of going quiet.
    const kindFlagsIn = (src: string): string[] => KIND_FLAGS.filter((f) => src.includes(f));

    // The five profile reads that must be present. Each one is a decision the
    // route used to make for itself: cwd and settingSources were literals,
    // the two tool lists were a ternary over four constants, and the appendix
    // was a four-arm chain over three module-private prompts.
    const PROFILE_READS = [
      "sessionProfile.cwd",
      "sessionProfile.settingSources",
      "sessionProfile.toolPolicy.allow",
      "sessionProfile.toolPolicy.deny",
      "sessionProfile.systemPromptAppendix",
    ];

    const broken: string[] = [];

    const flags = kindFlagsIn(code);
    if (flags.length > 0) {
      broken.push(
        `AD-9 / INV-6e: the chat route still names ${JSON.stringify(flags)}. THE RULE: session ` +
          `configuration is a RESOLVED PROFILE, not a branch through the handler — every kind ` +
          `resolves through resolveSessionProfile before the stream opens. CONSEQUENCE: epics 4, ` +
          `5 and 6 each add a session kind against this same file, and the moment one kind is a ` +
          `conditional the next one lands as a second, in the ~103KB handler the Human-Accept ` +
          `Moat rides on. NEXT STEP: express what the branch decided as a field on the profile ` +
          `and read that field. A removal is only safe once the profile carries the decision.`,
      );
    }

    const missing = PROFILE_READS.filter((r) => !code.includes(r));
    if (missing.length > 0) {
      broken.push(
        `AD-9 / INV-6e: the chat route no longer reads ${JSON.stringify(missing)} off the ` +
          `resolved profile. THE RULE (and this is the ANTI-VACUITY FLOOR for the half above): ` +
          `"a guard must read the same value as the thing it guards" — deleting the three ` +
          `session-kind flags while ALSO dropping the profile consumption would pass the absence ` +
          `check while the route computed everything inline again. CONSEQUENCE: the profile ` +
          `becomes decorative, which is worse than not having it, because two sources of truth ` +
          `for session shape disagree silently. NEXT STEP: if a field legitimately moved, update ` +
          `this list AND say where the decision now lives. Do not shorten it to make this pass.`,
      );
    }

    // AC2's half: the manifest's guardrails and root reach the session BY
    // CONSTRUCTION, through the profile, and are no longer re-derived here.
    // `const workspace` was the second computation of `sessionProfile.cwd`;
    // `manifest.guardrails` was the second read of the deny set.
    const REDERIVATIONS = ["const workspace", "manifest.guardrails"];
    const rederived = REDERIVATIONS.filter((r) => code.includes(r));
    if (rederived.length > 0) {
      broken.push(
        `AD-9 / INV-6e: the chat route re-derives ${JSON.stringify(rederived)} instead of ` +
          `reading the profile. THE RULE: manifest.root maps onto the profile's cwd, guardrails ` +
          `and settingSources BY CONSTRUCTION — the fold already does it, so a second ` +
          `computation here is a second source of truth. CONSEQUENCE: a profile that narrows ` +
          `guardrails or relocates cwd would be silently overridden by whichever expression the ` +
          `handler happened to reach for. NEXT STEP: read sessionProfile.cwd / ` +
          `sessionProfile.toolPolicy.deny.`,
      );
    }

    // AD-1's tool-layer half, still wired and now driven from ONE resolved
    // guardrail set. Three call sites since story 2.2: canUseTool,
    // preToolUseGuardrail, and onCodexApproval (which is what closes the Codex
    // half of the gap — see deferred-work.md for the residual it does NOT
    // close). The floor is what makes "every site reads sessionProfile" mean
    // something: over zero sites it is trivially true.
    const guardSites = code.split("makeGuardrailDecision(").length - 1;
    if (guardSites < 3) {
      broken.push(
        `AD-1 / INV-6e: makeGuardrailDecision has ${guardSites} call sites in the chat route ` +
          `(floor 3: canUseTool, preToolUseGuardrail, onCodexApproval). THE RULE: the moat is ` +
          `enforced at the tool layer on BOTH providers — the Codex fork reaches the SDK through ` +
          `none of query()'s options, so its approval callback is the one pre-tool seam it has. ` +
          `CONSEQUENCE: a project's guardrails.disallowedTools / protectedPaths go silently ` +
          `inert on half the traffic, which is the gap story 2.2's AC6 closed. NEXT STEP: ` +
          `restore the call site; do not lower this floor.`,
      );
    }
    // …and every one of them is fed the PROFILE, not the raw manifest. Checked
    // over the text that follows each call, because the argument is on its own
    // line under the house formatting.
    const fedManifest = code
      .split("makeGuardrailDecision(")
      .slice(1)
      .map((tail, i) => [i, tail.slice(0, 120)] as const)
      .filter(([, window]) => !window.includes("sessionProfile"));
    if (fedManifest.length > 0) {
      broken.push(
        `AD-9/AD-1 / INV-6e: ${fedManifest.length} makeGuardrailDecision call site(s) are not ` +
          `driven from sessionProfile — first offending window: ` +
          `${JSON.stringify(fedManifest[0]![1])}. THE RULE: AC2's "by construction" — the ONE ` +
          `resolved guardrail set governs every seam that enforces it. CONSEQUENCE: the two ` +
          `enforcement points (canUseTool and the PreToolUse hook) would read different values, ` +
          `so AD-1's "enforced twice" becomes a belt and a decoration. NEXT STEP: pass ` +
          `sessionProfile (it is structurally a { guardrails } and that is why this works) and ` +
          `sessionProfile.cwd.`,
      );
    }

    expect(broken).toEqual([]);

    // THE DISCRIMINATOR — the same predicate, over a fixture assembled here, so
    // a scanner that stopped matching fails loudly instead of reporting a clean
    // route forever.
    const fixture =
      "if (" + "is" + "EscalationSession" + ") { return readOnlyTools; }\n" +
      "const x = " + "is" + "PlannerSession" + " ? A : B;\n";
    expect(kindFlagsIn(fixture).sort()).toEqual(
      ["is" + "EscalationSession", "is" + "PlannerSession"].sort(),
    );
    // …and a clean fixture is NOT reported, so the predicate is not simply
    // returning everything it was handed.
    expect(kindFlagsIn("const allowedTools = [...sessionProfile.toolPolicy.allow];")).toEqual([]);
  });

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
// only because that file's `ctx()` helper never sets `loomId` — the composers
// short-circuit to "" before reaching a reader when the id is absent. That is a
// property of a test helper, not a sandbox, and INV-7 cannot see it. The same
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
        `only ${TEST_FILES.length} *.test.ts files in the index (floor 100, measured 121) — the ` +
          `WALK is broken, not the tree. INV-7 scans exactly this set.`,
      );
    }
    if (READER_SCANS.length < 25) {
      broken.push(
        `only ${READER_SCANS.length} test files reach the reader surface (floor 25, measured 30) — ` +
          `readerCallSites or READER_SURFACE is broken. The violation set below would be empty ` +
          `because nothing was scanned, not because nothing is wrong.`,
      );
    }
    if (READER_EXEC_SITES < 100) {
      broken.push(
        `only ${READER_EXEC_SITES} in-process reader call sites found (floor 100, measured 179) — ` +
          `the same failure, one level down.`,
      );
    }
    if (READER_PROBE_SITES < 3) {
      broken.push(
        `only ${READER_PROBE_SITES} child-probe call sites found (floor 3, measured 13) — the ` +
          `EXEC/PROBE split is broken. Both halves are load-bearing: if every hit landed in the ` +
          `in-process class, the child-process mechanism below would never be exercised.`,
      );
    }
    for (const mechanism of ["pinned", "injected", "child", "root-parameterized"]) {
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
    expect(broken).toEqual([]);
  });

  test("INV-7b every test file that reaches a reader is sandboxed, injected, or child-spawned", () => {
    // THE INVARIANT. Everything above is the machinery; this is the claim.
    const violations = READER_SCANS.flatMap((s) => s.violations);
    expect(violations).toEqual([]);
  });

  test("INV-7c the POSITIVE CONTROLS — the two known-good idioms are really found, and by name", () => {
    // A scanner that silently matches nothing is worse than no scanner, so the
    // two files that already do this correctly are pinned BY NAME and BY
    // MECHANISM. If either stops being found, the scan has gone blind and this
    // fails before INV-7b can pass vacuously.
    const profiles = READER_SCANS.find((s) => s.file === "apps/web/lib/session-profiles.test.ts");
    if (!profiles) {
      throw new Error(
        `INV-7: apps/web/lib/session-profiles.test.ts is NOT in the reader scan at all. It spawns ` +
          `a child whose probe source composes a steerer and an escalation profile — the ` +
          `canonical child-process idiom in this repo. CONSEQUENCE: if the scanner cannot see ` +
          `THAT, it can see nothing, and INV-7b is passing over an empty set. NEXT STEP: the scan ` +
          `is broken (READER_SURFACE, readerCallSites, or the EXEC/PROBE offset split) — do not ` +
          `delete this assertion.`,
      );
    }
    // Found as a CHILD-PROBE site specifically: the composer calls live inside
    // the probe's template literal, so they must NOT be counted as executing
    // here, and the file must be credited with the sandboxed child.
    expect(profiles.probe.length).toBeGreaterThanOrEqual(2);
    expect(profiles.probe.map((p) => p.name).sort()).toContain("buildSteererProfile");
    expect(profiles.spawns).toBe(true);
    expect(profiles.child).toBe(true);
    expect(profiles.mechanisms).toContain("child");
    expect(profiles.violations).toEqual([]);
    // …and it is NOT quietly passing because it pins a root in-process: it does
    // not, deliberately (its header says "Never mutate process.env.TELAR_HOME in
    // the shared test process").
    expect(profiles.pinned).toBe(false);

    // The other idiom, and the file the whole invariant comes from. Every
    // composer call in session-prompts.test.ts passes `read`, and the file pins
    // NOTHING — so it is safe by injection ALONE. Before story 2.2's review it
    // had one call that did not, and that call reached the real loom store.
    const prompts = READER_SCANS.find((s) => s.file === "apps/web/lib/session-prompts.test.ts");
    if (!prompts) {
      throw new Error(
        `INV-7: apps/web/lib/session-prompts.test.ts is NOT in the reader scan. This is the file ` +
          `whose un-injected composer call executed against the operator's real loom store and is ` +
          `the reason INV-7 exists. CONSEQUENCE: the scanner cannot see the exact shape it was ` +
          `written to catch. NEXT STEP: fix readerCallSites; do not delete this assertion.`,
      );
    }
    expect(prompts.exec.length).toBeGreaterThanOrEqual(5);
    expect(prompts.pinned).toBe(false);
    expect(prompts.child).toBe(false);
    expect(prompts.mechanisms).toEqual(["injected"]);
    expect(prompts.violations).toEqual([]);
  });

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

// ===========================================================================
// INV-8 — the Conversation shell's contract, made executable. AD-12 / AD-13.
// ===========================================================================
//
// WHY THIS EXISTS, and why it is not gold-plating. Two of story 3.1's
// acceptance criteria are claims about CODE SHAPE rather than behaviour: "a
// registered renderer reads nothing from ambient context" and "kind ids carry
// their owning module and cannot collide" — the latter being a claim about
// EVERY FUTURE registration, not about today's six. There is no DOM harness in
// this repository, deliberately, so neither can be proven by rendering. AC5's
// runtime half is a unit test (components/conversation/registry.test.ts). AC4's
// purity is provable ONLY by a static scan, because a plain function called
// during render CAN legally call a hook: the type states the shape and nothing
// enforces it.
//
// AD-19 already mandates exactly this remedy for load-bearing invariants, and
// its own `Binds:` list — AD-1, AD-2, AD-3, AD-5, AD-20 — does not include
// AD-12. That is the gap, not a reason to leave it. The architecture froze this
// contract precisely so epics 4, 5 and 6 could build owner adapters IN PARALLEL
// without coordinating; a frozen contract that nothing re-checks is the failure
// AD-19 was written for. The readiness report's UX-8 predicted the shape:
// "verified by none of them individually — the classic shape of a constraint
// that passes every unit check and fails in integration."
//
// AND IT IS BOUNDED. INV-8 scans apps/web/components/conversation/** and
// session-view.tsx — a small, new, wholly-owned surface — never the whole tree.
// Pointing INV-8b at apps/web/components/** would make every legitimate
// useSidebar/useDock call in 100+ client files a violation, and the fix would be
// to weaken the predicate, which is how a guard becomes a decoration.
//
// SESSION-VIEW.TSX IS SCANNED AT THE RIGHT GRAIN, not as a whole file. The
// adapter's job IS to consume session context, so the file cannot be held to
// AC4; its REGISTERED KIND RENDERERS can, and INV-8b2 extracts exactly those.
//
// The sub-checks: a denylist (8a), ambient context in the shell (8b) and in the
// donor's own kind renderers (8b2), the re-derived inventory the denylist comes
// from (8c), the discriminator that keeps 8a/8b/8b2 from passing vacuously (8d),
// config-over-inheritance (8e), the barrel + kind-id exact sets (8f), the
// donor's stayed/moved split (8g), the closed prop list (8i), the walk's
// dist-dir exclusions (8j), and the quarantine floor (8h).
//
// KNOWN_VIOLATIONS: INV-8 adds none. See INV-8h.

const SHELL_ROOT = "apps/web/components/conversation/";
const SHELL_FILES = INDEX.filter((f) => f.rel.startsWith(SHELL_ROOT) && !isTestFile(f.rel));
const SESSION_VIEW_REL = "apps/web/components/session/session-view.tsx";

// ── the kind renderers that live OUTSIDE the shell directory ────────────────
// §5.5-D12 bounds INV-8 as scanning `components/conversation/**` AND
// `session-view.tsx`, and the second half was missing: story 3.1 registered
// `session:agent-bucket` in the donor, which is a file with `useDockOptional()`
// and `usePromptInputController()` in lexical scope — §5.6-T4 names that as the
// exact temptation INV-8b exists to catch, and it is the ONE place in the tree
// where the temptation is real rather than theoretical.
//
// The whole file cannot be scanned, and that is not a compromise: the adapter's
// JOB is to consume session context. What is scanned is each REGISTERED KIND's
// renderer, extracted by brace-matching from its `: ItemKind<…> = {` declaration
// — the renderer is the thing AC4 makes a claim about, and its boundary is
// exactly where the claim starts applying.
type KindSlice = { name: string; src: string };

// RESIDUAL, STATED RATHER THAN IMPLIED — the brace match ends at the OBJECT
// LITERAL, so this extractor sees a renderer only when the renderer is written
// INLINE. A kind declared `render: someTopLevelFn` yields a slice holding no
// hook-call text at all: `ambientContextScan` returns `[]` and INV-8b2 passes
// over the exact violation it exists to catch. Neither guard below closes it —
// the anti-vacuity floor still counts one slice, the name still comes from the
// declaration so `toContain("agentBucketKind")` still holds, and a bare
// `{ id, render: fn }` literal clears the 40-character body control (62 on a
// probe of that shape). Nor does any sibling: INV-8b is scoped to
// components/conversation/** by design, and the donor is the one file outside it.
// NOT HYPOTHETICAL: `renderAgentBucket`, the top-level function story 3.1
// deleted, was precisely that shape, and session-view.tsx's own comment records
// it as the file's prior pattern. Recorded, deliberately not fixed here — the
// day a donor kind delegates to a top-level renderer, follow the identifier and
// scan that function's body too, rather than widening the brace match or
// deleting the check.
function kindRendererSlices(text: string): KindSlice[] {
  // Comments AND string bodies blanked first, so a `{` inside either cannot
  // unbalance the brace match and a kind merely DISCUSSED in prose is not found.
  const code = tokenize(text, true, true);
  const out: KindSlice[] = [];
  const DECL = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*:\s*ItemKind\s*</g;
  for (const m of code.matchAll(DECL)) {
    const open = code.indexOf("{", (m.index ?? 0) + m[0].length);
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end === -1) continue;
    out.push({ name: m[1]!, src: code.slice(open, end) });
  }
  return out;
}

const DONOR_KIND_SLICES = kindRendererSlices(byRel.get(SESSION_VIEW_REL)?.text ?? "");

// THE CLOSED DENYLIST. This is the executable form of "the shell owns no data
// fetching and no session semantics" (AD-12). If you legitimately need a term on
// this list inside components/conversation/**, you have almost certainly put
// session semantics in the shell — the adapter owns those and hands the shell a
// projection. Changing this list is a decision to record, not a detail to slip
// in.
const SHELL_DENYLIST: ReadonlyArray<[string, string]> = [
  ["fetch(", "data fetching"],
  ["new EventSource", "an event stream"],
  ["consumeSSE", "the SSE wire format"],
  ["window.addEventListener", "a window listener"],
  ["localStorage", "browser storage"],
  ["/api/", "a server route"],
  ["sessionId", "session identity"],
  ["permissionMode", "session permission policy"],
  ["runId", "turn identity"],
  ["accountEnv", "account resolution"],
];

/**
 * The denylist hits in one source. ONE PREDICATE, so INV-8a and its
 * discriminator INV-8d cannot drift apart — INV-8d's header promises fixtures go
 * "through the same scan function the real check uses", and a second copy of the
 * predicate makes that sentence false for half the check. Reads `.code`
 * (comments blanked, string bodies KEPT), so a URL in a string is caught and a
 * URL in a header comment is not.
 */
function denylistScan(text: string): ReadonlyArray<[string, string]> {
  const code = stripComments(text);
  return SHELL_DENYLIST.filter(([needle]) => code.includes(needle));
}

// "Config over inheritance" (AD-12), as one predicate for the same reason.
// RESIDUAL, stated rather than implied: `\bextends\b` cannot tell inheritance
// from a generic constraint (`<T extends U>`) or an interface extension. No file
// under the shell has either today, so the guard is exact where it runs; the day
// a legitimate constraint arrives, narrow the predicate deliberately rather than
// deleting the check — a guard that fires on correct code gets deleted, which is
// the failure this note exists to pre-empt.
const INHERITANCE_WORDS = ["class", "extends"] as const;

function inheritanceScan(rel: string, text: string): string[] {
  const code = stripComments(text);
  const out: string[] = [];
  for (const word of INHERITANCE_WORDS) {
    // `className` is not a false positive: \b requires a non-word character
    // after `class`.
    if (new RegExp(`\\b${word}\\b`).test(code)) {
      out.push(
        `${rel} uses \`${word}\`. RULE (AD-12): the shell exposes four slots configured by ` +
          `PROPS, never by inheritance — no subclassing, no extends, no cloneElement of a ` +
          `caller's tree. CONSEQUENCE: a surface that must SUBCLASS the shell to change it is ` +
          `a surface that has forked it, which is exactly the six-copies outcome epic 3 ` +
          `exists to end. NEXT STEP: add a prop, or take the value through the item payload.`,
      );
    }
  }
  return out;
}

// ── the ambient-context scan (shared by INV-8b and its discriminator) ───────
// CODE-ONLY text: comments AND string bodies are blanked, because the question
// is "does this file CALL a context hook", not "does it mention one". Every
// header in components/conversation/ discusses the rule at length, and a scan
// that read prose would fire on the documentation of itself.
// The QUALIFIED form counts. components/ui/sidebar.tsx and
// components/ui/carousel.tsx both write `React.useContext(…)`, so a pattern
// anchored on the bare call would miss two of the eight contexts in the tree —
// and, worse, would leave a renderer a one-token way to evade the rule. An
// optional `<ident>.` prefix closes it; a name that merely CONTAINS the word
// (`useContextHelper(`, `myuseContext(`) still does not match.
const USE_CONTEXT_CALL = /(?<![A-Za-z0-9_$])(?:[A-Za-z0-9_$]+\s*\.\s*)?useContext\s*\(/;

// REACT 19'S `use(Context)` IS THE SAME READ BY A SHORTER NAME. This repo pins
// react@19.2.4, where `const v = use(SomeContext)` is a first-class context read
// — and `use(somePromise)` is a first-class data read, which the shell is
// equally forbidden from doing (AD-12). A scan that knew only `useContext(`
// would let AC4's ONLY enforcement be walked around by deleting four characters.
// Same anchoring as above, so `misuse(`, `abuse(`, `obj.reuse(` and `useState(`
// are all left alone. What is NOT left alone, stated because the anchoring
// cannot express it: the optional `<ident>.` prefix that catches `React.use(`
// cannot tell a namespace from an object, so `app.use(mw)` and `router.use(x)`
// MATCH. Over-broad by design and harmless here — no such call exists under the
// shell, and a false positive fails loudly with a named file rather than
// letting a real context read through silently.
const REACT_USE_CALL = /(?<![A-Za-z0-9_$])(?:[A-Za-z0-9_$]+\s*\.\s*)?use\s*\(/;

// A NAMED HOOK CALL, qualified or bare. The `<ident>.` prefix is the same one
// USE_CONTEXT_CALL accepts, and it is here for the same reason: the barrel
// re-exports the whole PromptInput* family, so `import * as ns from
// "@/components/conversation"` followed by `ns.usePromptInputController()` is
// one namespace import away — and until this arm accepted the qualified form,
// the two halves of one guard disagreed about what a call looks like.
const hookCall = (hook: string): RegExp =>
  new RegExp(`(?<![A-Za-z0-9_$])(?:[A-Za-z0-9_$]+\\s*\\.\\s*)?${escapeRe(hook)}\\s*\\(`);

// RESIDUALS, STATED RATHER THAN IMPLIED — this is a static scan by NAME:
//   · a hook reached through a local helper this list does not name is invisible
//     (the same residual INV-7 records about itself);
//   · the import arm reads THIS file's own import statements, so a context hook
//     that arrives through a RE-EXPORTING barrel (`export * from …`) is not seen
//     as an import edge — only its call site is. The call arm is what catches it,
//     which is why the call arm must stay the broader of the two.
function ambientContextScan(
  rel: string,
  text: string,
  hooks: readonly string[],
): string[] {
  const code = tokenize(text, true, true);
  const out: string[] = [];
  if (REACT_USE_CALL.test(code)) {
    out.push(
      `${rel} calls use( directly — React 19's context/resource read. RULE (AD-12, and the fix ` +
        `architecture review's finding A3 made to it): a registered item kind is a PURE FUNCTION ` +
        `of (payload, view) and reads nothing from ambient context — and fetches nothing. ` +
        `CONSEQUENCE: \`use(SomeContext)\` is \`useContext(SomeContext)\` by a shorter name, and ` +
        `\`use(promise)\` is data fetching inside the shell; either one ends with a transcript ` +
        `that can only render inside one provider. NEXT STEP: move the value into the item ` +
        `PAYLOAD, which the owner adapter builds.`,
    );
  }
  if (USE_CONTEXT_CALL.test(code)) {
    out.push(
      `${rel} calls useContext( directly. RULE (AD-12, and the fix architecture review's ` +
        `finding A3 made to it): a registered item kind is a PURE FUNCTION of (payload, view) ` +
        `and reads nothing from ambient context. CONSEQUENCE: the shell can no longer render a ` +
        `transcript containing this kind outside whichever provider supplies that context — and ` +
        `TranscriptView, which has no providers at all, can render NONE of its items. NEXT STEP: ` +
        `move the value into the item PAYLOAD, which the owner adapter builds; a read-only ` +
        `surface then omits the callback and the renderer degrades to non-interactive.`,
    );
  }
  for (const hook of hooks) {
    if (hookCall(hook).test(code)) {
      out.push(
        `${rel} calls ${hook}(), which consumes a React context. RULE: same as above — a kind ` +
          `renderer reads nothing ambient. CONSEQUENCE: this file becomes renderable only inside ` +
          `${hook}'s provider, and any transcript mixing it with another module's kind becomes ` +
          `renderable nowhere. NEXT STEP: take the value through the payload instead.`,
      );
      continue;
    }
    for (const stmt of importStatements(code)) {
      if (new RegExp(`(?<![A-Za-z0-9_$])${escapeRe(hook)}(?![A-Za-z0-9_$])`).test(stmt)) {
        out.push(
          `${rel} imports ${hook}, a context-consuming hook. RULE: same as above. CONSEQUENCE: ` +
            `importing it is the step before calling it, and nothing else here would flag the ` +
            `call. NEXT STEP: delete the import; owner data reaches a renderer through the ` +
            `item payload.`,
        );
        break;
      }
    }
  }
  return out;
}

// ── the context inventory, RE-DERIVED every run (INV-8c feeds INV-8b) ──────
// A restated literal is a COPY of a measurement, and a copy goes stale in
// silence — which is precisely how story 2.1's `allow: []` survived authoring,
// review and a commit. So the denylist INV-8b uses is DERIVED from the tree on
// every run, and INV-8c fails the moment the derivation stops matching what has
// been classified.
type ContextInventory = { contexts: Array<[string, string]>; hooks: Array<[string, string]> };

function deriveContextInventory(): ContextInventory {
  const contexts: Array<[string, string]> = [];
  const hooks: Array<[string, string]> = [];
  const CREATE = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=\n]*)?=\s*(?:[A-Za-z0-9_$]+\.)?createContext\s*[<(]/g;
  // A hook is a declaration whose NAME starts with `use` + a capital — React's
  // own rule, and the thing that makes walking back from a `useContext(` call to
  // its enclosing hook reliable: `const ctx = useContext(X)` and
  // `const local = useContext(Y)` are bindings, not hooks, and are skipped.
  const DECL = /(?:^|\n)\s*(?:export\s+)?(?:const|function)\s+(use[A-Z][A-Za-z0-9_$]*)/g;
  for (const f of INDEX) {
    if (!f.rel.startsWith("apps/web/") || isTestFile(f.rel)) continue;
    const code = tokenize(f.text, true, true);
    for (const m of code.matchAll(CREATE)) contexts.push([f.rel, m[1]!]);
    if (!USE_CONTEXT_CALL.test(code)) continue;
    const decls = [...code.matchAll(DECL)].map((m) => ({ at: m.index ?? 0, name: m[1]! }));
    const consuming = new RegExp(USE_CONTEXT_CALL.source, "g");
    for (const use of code.matchAll(consuming)) {
      const at = use.index ?? 0;
      let owner: string | null = null;
      for (const d of decls) {
        if (d.at < at) owner = d.name;
        else break;
      }
      if (owner && !hooks.some(([r, n]) => r === f.rel && n === owner)) hooks.push([f.rel, owner]);
    }
  }
  return { contexts, hooks };
}

const CONTEXT_INVENTORY = deriveContextInventory();
const CONTEXT_HOOKS = [...new Set(CONTEXT_INVENTORY.hooks.map(([, n]) => n))].sort();

// The classification, measured at 75d3f12 and re-checked by INV-8c on every run.
// A context or hook that appears here and NOT in the tree is a stale pin; one
// that appears in the tree and NOT here fails INV-8c by name. Either way the
// denylist cannot go quietly out of date.
const CLASSIFIED_CONTEXTS: Readonly<Record<string, readonly string[]>> = {
  "apps/web/components/ui/sidebar.tsx": ["SidebarContext"],
  "apps/web/components/ui/carousel.tsx": ["CarouselContext"],
  "apps/web/components/ai-elements/message.tsx": ["MessageBranchContext"],
  "apps/web/components/dock/dock-provider.tsx": ["Ctx"],
  "apps/web/components/ai-elements/prompt-input.tsx": [
    "PromptInputController",
    "ProviderAttachmentsContext",
    "LocalAttachmentsContext",
    "LocalReferencedSourcesContext",
  ],
};

const CLASSIFIED_HOOKS: readonly string[] = [
  "useSidebar",
  "useCarousel",
  "useMessageBranch",
  "useDock",
  "useDockOptional",
  "usePromptInputController",
  "useOptionalPromptInputController",
  "useProviderAttachments",
  "useOptionalProviderAttachments",
  "usePromptInputAttachments",
  "usePromptInputReferencedSources",
];

line(
  `shell: ${SHELL_FILES.length} files under components/conversation · ` +
    `${CONTEXT_INVENTORY.contexts.length} React contexts · ${CONTEXT_HOOKS.length} consuming hooks`,
);

// ── the barrel's pinned primitive group ─────────────────────────────────────
const BARREL_REL = `${SHELL_ROOT}index.ts`;
const PRIMITIVE_SENTINEL_OPEN = "// ── the primitives (INV-8f pins this group as an exact set)";
const PRIMITIVE_SENTINEL_CLOSE = "// ── the shell and its contract (deliberately NOT pinned";

function barrelPrimitiveExports(text: string): string[] {
  const open = text.indexOf(PRIMITIVE_SENTINEL_OPEN);
  const close = text.indexOf(PRIMITIVE_SENTINEL_CLOSE);
  if (open === -1 || close === -1 || close < open) return [];
  const slice = text.slice(open, close);
  const names: string[] = [];
  for (const m of slice.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of m[1]!.split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if (name) names.push(name);
    }
  }
  return names.sort();
}

const EXPECTED_PRIMITIVES = [
  "ApprovalCard",
  "MarkdownPre",
  "Marker",
  "Message",
  "MessageContent",
  "MessageResponse",
  "Shimmer",
  "ToolStepGroup",
  "ToolStepRow",
  "WorkingIndicator",
].sort();

const EXPECTED_BUILTIN_KIND_IDS = [
  "conversation:turn",
  "conversation:text",
  "conversation:thinking",
  "conversation:tools",
  "conversation:permission",
  "conversation:marker",
].sort();

// ── the shell's prop list, as an exact set ──────────────────────────────────
// §5.5-D6 pins FOUR SLOTS plus a CLOSED list of non-slot props, and says in as
// many words that the list is closed "so INV-8 can assert against it" — which
// nothing did. The only mechanical check that existed was `registry.test.ts`'s
// `@ts-expect-error` on an UNKNOWN prop name, and that cannot fail when a KNOWN
// prop is ADDED: it is the wrong direction for the claim D6 makes. This is the
// other direction. A fifth non-slot prop (`trailing`, disclosed in Completion
// Note 5(a)) is in the set deliberately; a SIXTH cannot appear without editing
// this pin, which is what makes adding one a decision rather than a drift.
const EXPECTED_CONVERSATION_PROPS = [
  // the four slots — the transcript is ONE slot with two halves
  "items",
  "kinds",
  "composer",
  "rail",
  "header",
  // view configuration, not slots
  "live",
  "empty",
  "trailing",
  "className",
].sort();

function conversationPropNames(code: string): string[] {
  const at = code.indexOf("type ConversationProps");
  if (at === -1) return [];
  const open = code.indexOf("{", at);
  if (open === -1) return [];
  let depth = 0;
  let end = -1;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) return [];
  // Members at depth 0 only, so a nested object type contributes its own name
  // and not its fields.
  const names: string[] = [];
  let d = 0;
  let buf = "";
  const flush = () => {
    const m = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\??\s*:/.exec(buf);
    if (m) names.push(m[1]!);
    buf = "";
  };
  for (const ch of code.slice(open + 1, end)) {
    if (ch === "{" || ch === "(" || ch === "[") d++;
    else if (ch === "}" || ch === ")" || ch === "]") d--;
    if (d === 0 && (ch === ";" || ch === "\n")) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return [...new Set(names)].sort();
}

function builtinKindIds(itemsSrc: string): string[] {
  const at = itemsSrc.indexOf("CONVERSATION_KINDS");
  if (at === -1) return [];
  const open = itemsSrc.indexOf("{", at);
  const close = itemsSrc.indexOf("} as const", open);
  if (open === -1 || close === -1) return [];
  return [...itemsSrc.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
}

// ── session-view.tsx: what stayed and what left ─────────────────────────────
// Both directions in one place, because a carve-out fails in two ways and only
// checking one of them is how you end up with a shell that quietly learned about
// sessions, or an adapter that quietly kept its render loop.
// The third element is HOW MANY, and it is not decoration: AC6's own wording is
// "**both** `new EventSource(` sites", and a bare `includes()` is satisfied by
// one — so deleting a live subscriber passed the invariant that names it. A
// count is the only form of that claim that says what it means.
const STAYED_IN_ADAPTER: ReadonlyArray<[string, string, number?]> = [
  ["applyServerEvent", "the SSE switch"],
  ["consumeSSE", "the wire reader"],
  ['fetch("/api/chat"', "the turn POST"],
  ["new EventSource(", "the live subscribers — BOTH of them", 2],
  ["setSessionCost", "the ledger readout (story 1.1's set-not-accumulate)"],
];

const countOccurrences = (haystack: string, needle: string): number =>
  needle.length === 0 ? 0 : haystack.split(needle).length - 1;

// ONE ROW HERE CONTRADICTS §5.5-D7's table, deliberately and with the record
// corrected rather than the invariant bent: D7 lists `AgentStepRow` in the
// STAYED column, and it MOVED — it is a leaf rendering with no session
// awareness (it takes `onSelect` as a prop, exactly as `ToolStepGroup` takes
// `agentSteps`/`onSelectAgent`), and leaving it behind would have split one
// tool-group rendering across two files. The move is what shipped, this is what
// asserts it, and story 3.1's Completion Notes now say so — an invariant that
// asserts the opposite of the design record is a coin-flip for the next reader.
const MOVED_OUT_OF_ADAPTER: ReadonlyArray<[string, string]> = [
  ["function groupParts", "the transcript projection"],
  ["type RenderItem", "the projection's union"],
  ["function PermissionCard", "the approval rendering"],
  ["function ThinkingRow", "the thinking rendering"],
  ["function ToolStepGroup", "the tool-group rendering"],
  ["function AgentStepRow", "the agent-chip rendering"],
  ["function renderAgentBucket", "the SECOND copy of the kind dispatch"],
  ["ConversationContent", "the scroll viewport's content wrapper"],
  ["ConversationScrollButton", "the scroll button"],
  ["item.kind", "an inline kind switch"],
  ["setGroupOverrides", "the tool-group disclosure map"],
  ["setRowOverrides", "the tool-row disclosure map"],
  ["setThinkingOpen", "the thinking disclosure map"],
];

describe("INV-8 the Conversation shell owns no session semantics — AD-12, AD-13", () => {
  test("INV-8a the shell does no data fetching and holds no session semantics", () => {
    // ANTI-VACUITY FIRST. Deleting components/conversation/ must not be a way to
    // make this pass, and neither must a typo in the root prefix.
    const broken: string[] = [];
    if (SHELL_FILES.length < 6) {
      broken.push(
        `only ${SHELL_FILES.length} non-test files under ${SHELL_ROOT} (floor 6, measured 8) — ` +
          `the WALK is broken or the directory moved, not the tree. Every assertion below would ` +
          `hold over the empty set. NEXT STEP: fix SHELL_ROOT; do not relax the floor.`,
      );
    }
    expect(broken).toEqual([]);

    const violations: string[] = [];
    for (const f of SHELL_FILES) {
      for (const [needle, what] of denylistScan(f.text)) {
        violations.push(
          `${f.rel} contains "${needle}" — ${what}. RULE (AD-12): the shell owns scrolling, ` +
            `auto-follow and streaming affordances, and owns NO data fetching and NO session ` +
            `semantics. CONSEQUENCE: every surface that renders a transcript now inherits this, ` +
            `and the six hand-rebuilt chat lanes epic 3 exists to end start growing back one ` +
            `prop at a time. NEXT STEP: the OWNER ADAPTER holds session state and hands the ` +
            `shell a projection — put it there, not here. If you believe the term is genuinely ` +
            `needed, say so in your story's completion notes rather than editing SHELL_DENYLIST ` +
            `quietly.`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  test("INV-8b no file in the shell reads ambient React context", () => {
    // THE INVARIANT AC4 has no other possible proof for. The hook list is
    // DERIVED (INV-8c), never restated.
    const violations = SHELL_FILES.flatMap((f) =>
      ambientContextScan(f.rel, f.text, CONTEXT_HOOKS),
    );
    expect(violations).toEqual([]);
  });

  test("INV-8b2 a kind renderer registered OUTSIDE the shell is held to the same rule", () => {
    // ANTI-VACUITY FIRST, because this scan reads a SLICE rather than a file:
    // an extractor that finds nothing would assert nothing, and the adapter is
    // precisely the file where a hook call would compile.
    if (DONOR_KIND_SLICES.length < 1) {
      throw new Error(
        `INV-8b2: no \`: ItemKind<…> = {\` declaration found in ${SESSION_VIEW_REL}, so the ` +
          `renderer scan below is running over nothing. RULE (§5.5-D12): INV-8 scans ` +
          `components/conversation/** AND session-view.tsx — the adapter is the one file where a ` +
          `renderer has useDockOptional() and usePromptInputController() in lexical scope. ` +
          `CONSEQUENCE: AC4's only enforcement stops covering the only place its failure is ` +
          `reachable. NEXT STEP: if the donor stopped registering a kind of its own, say so here ` +
          `deliberately; if the declaration shape changed, fix kindRendererSlices — do not delete ` +
          `this test.`,
      );
    }
    // The positive control: the extractor really found the story's own kind, and
    // really captured its BODY rather than an empty match.
    expect(DONOR_KIND_SLICES.map((s) => s.name)).toContain("agentBucketKind");
    expect(DONOR_KIND_SLICES.every((s) => s.src.length > 40)).toBe(true);

    const violations = DONOR_KIND_SLICES.flatMap((s) =>
      ambientContextScan(`${SESSION_VIEW_REL} :: ${s.name}`, s.src, CONTEXT_HOOKS),
    );
    expect(violations).toEqual([]);
  });

  test("INV-8c the context inventory is RE-DERIVED, so INV-8b's denylist cannot go stale", () => {
    const broken: string[] = [];
    if (CONTEXT_INVENTORY.contexts.length < 8) {
      broken.push(
        `only ${CONTEXT_INVENTORY.contexts.length} React contexts found across apps/web ` +
          `(floor 8, measured 8) — the derivation is broken, so INV-8b would be scanning for an ` +
          `empty hook list and passing over nothing.`,
      );
    }
    if (CONTEXT_HOOKS.length < 11) {
      broken.push(
        `only ${CONTEXT_HOOKS.length} context-consuming hooks derived (floor 11, measured 11) — ` +
          `same failure, one level down. INV-8b's denylist IS this list.`,
      );
    }
    expect(broken).toEqual([]);

    // A NEW context or hook that nobody classified is the exact drift this test
    // exists to catch: INV-8b would keep passing while a ninth provider quietly
    // became reachable from a renderer.
    const unclassifiedContexts = CONTEXT_INVENTORY.contexts
      .filter(([rel, name]) => !(CLASSIFIED_CONTEXTS[rel] ?? []).includes(name))
      .map(
        ([rel, name]) =>
          `${rel} creates React context "${name}", which is not in CLASSIFIED_CONTEXTS. RULE ` +
            `(story 3.1's maxim 3): a guard must read the same value as the thing it guards, so ` +
            `INV-8b's denylist is derived from this inventory rather than restated. ` +
            `CONSEQUENCE: an unclassified context means a hook nobody has decided about, and ` +
            `INV-8b keeps passing while a kind renderer reaches for it. NEXT STEP: add it to ` +
            `CLASSIFIED_CONTEXTS and its consuming hook(s) to CLASSIFIED_HOOKS — and check that ` +
            `no file under ${SHELL_ROOT} wants it.`,
      );
    expect(unclassifiedContexts).toEqual([]);

    const unclassifiedHooks = CONTEXT_HOOKS.filter((h) => !CLASSIFIED_HOOKS.includes(h)).map(
      (h) =>
        `apps/web declares context-consuming hook "${h}", which is not in CLASSIFIED_HOOKS. ` +
          `RULE and CONSEQUENCE: as above. NEXT STEP: classify it, then re-run INV-8b — it is ` +
          `already scanning for it, since the denylist is derived.`,
    );
    expect(unclassifiedHooks).toEqual([]);

    // …and the pin is not one-directional: a CLASSIFIED hook that no longer
    // exists means the classification has rotted the other way.
    const vanished = CLASSIFIED_HOOKS.filter((h) => !CONTEXT_HOOKS.includes(h)).map(
      (h) =>
        `CLASSIFIED_HOOKS names "${h}", which no longer exists in apps/web. CONSEQUENCE: the ` +
          `list has drifted from the tree, and a list that is wrong in one direction is not ` +
          `trustworthy in the other. NEXT STEP: remove it, or find where the hook moved.`,
    );
    expect(vanished).toEqual([]);
  });

  test("INV-8d the scans DISCRIMINATE — both directions, through the same functions", () => {
    // MANDATORY. Without this, INV-8a and INV-8b can pass vacuously, which is
    // this house's named failure: "a green test can assert nothing." Fixtures are
    // assembled at RUNTIME so this file's own text cannot be picked up by the
    // scanners it is testing.
    const ctxCall = "use" + "Context";
    const dockHook = "use" + "Dock";
    const scan = (src: string) => ambientContextScan("fixture.tsx", src, CONTEXT_HOOKS);

    // A bare useContext call IS reported…
    expect(scan(`const v = ${ctxCall}(SomeCtx);`).length).toBe(1);
    expect(scan(`const v = ${ctxCall}(SomeCtx);`)[0]).toContain("finding A3");
    // …and so is a named context hook, called or merely imported.
    expect(scan(`const d = ${dockHook}();`).length).toBe(1);
    expect(
      scan(`import { ${dockHook} } from "@/components/dock/dock-provider";\n`).length,
    ).toBe(1);

    // A MENTION IS NOT A CALL. Every header under components/conversation/
    // discusses this rule at length; a scan that read prose would fire on the
    // documentation of itself.
    expect(scan(`// never call ${ctxCall}( inside a renderer\n`)).toEqual([]);
    expect(scan(`/* ${dockHook}() is forbidden here */\n`)).toEqual([]);
    expect(scan(`const help = "do not call ${ctxCall}() here";`)).toEqual([]);
    // The QUALIFIED form is a call too — two of the eight contexts in this tree
    // are consumed exactly that way, so a scan blind to it would be blind to a
    // one-token evasion as well. BOTH halves of the guard accept it: the
    // useContext arm and the named-hook arm, which disagreed until the qualified
    // form was factored into `hookCall`.
    expect(scan(`const v = React.${ctxCall}(SomeCtx);`).length).toBe(1);
    expect(scan(`const d = ns.${dockHook}();`).length).toBe(1);
    expect(scan(`const d = ns . ${dockHook} ();`).length).toBe(1);
    // …but a name that merely CONTAINS the word is not.
    expect(scan(`const v = my${ctxCall}(SomeCtx);`)).toEqual([]);
    expect(scan(`const v = ${ctxCall}Helper(SomeCtx);`)).toEqual([]);
    expect(scan(`const d = ${dockHook}Optional2();`)).toEqual([]);
    // REACT 19's `use(Context)` is the same read by a shorter name, and it is
    // reported — bare and qualified — because AC4's only enforcement cannot be
    // four characters away from being walked around.
    const useCall = "us" + "e";
    expect(scan(`const v = ${useCall}(SomeCtx);`).length).toBe(1);
    expect(scan(`const v = ${useCall}(SomeCtx);`)[0]).toContain("React 19");
    expect(scan(`const v = React.${useCall}(SomeCtx);`).length).toBe(1);
    // …and the words that merely contain it are not: useState/useRef/useMemo,
    // an identifier ending in `use`, and a mention in prose.
    expect(scan(`const [a, b] = ${useCall}State(0);\nconst r = ${useCall}Ref(null);`)).toEqual([]);
    expect(scan(`const v = ab${useCall}(x);`)).toEqual([]);
    expect(scan(`// never call ${useCall}( on a context here\n`)).toEqual([]);
    // …and an ordinary, permitted hook must NOT be reported, or the invariant
    // would be "no hooks at all" and would get deleted rather than fixed.
    expect(scan(`const [a, b] = useState(0);\nconst r = useRef(null);`)).toEqual([]);

    // The KIND-SLICE extractor is a scanner too, so it gets both directions as
    // well: a renderer registered outside the shell is found and scanned, and a
    // kind merely MENTIONED in prose is not.
    const decl = (body: string) => `const probeKind: ItemKind<P> = ${body};`;
    expect(kindRendererSlices(decl(`{ id: "loom:x", render: () => null }`)).length).toBe(1);
    expect(kindRendererSlices(decl(`{ id: "loom:x", render: () => null }`))[0]!.name).toBe(
      "probeKind",
    );
    expect(kindRendererSlices(`// const probeKind: ItemKind<P> = { … }\n`)).toEqual([]);
    // …the slice really carries the renderer's body, so the scan over it is not
    // running over an empty string…
    expect(
      ambientContextScan(
        "fixture.tsx",
        kindRendererSlices(decl(`{ id: "loom:x", render: () => ${dockHook}() }`))[0]!.src,
        CONTEXT_HOOKS,
      ).length,
    ).toBe(1);
    // …and nested braces (every JSX renderer has them) do not truncate it.
    const nested = kindRendererSlices(
      decl(`{ id: "loom:x", render: (p) => (<div>{p.items.map((i) => ({ i }))}</div>) }`),
    );
    expect(nested.length).toBe(1);
    expect(nested[0]!.src.endsWith("}")).toBe(true);
    expect(nested[0]!.src).toContain("items.map");

    // The DENYLIST scanner, same treatment — and through the SAME function the
    // real check calls, not a second copy of the predicate beside it.
    const denyScan = (src: string) => denylistScan(src).map(([n]) => n);
    expect(denyScan(`const r = await fetch("/api/chat");`).sort()).toEqual(["/api/", "fetch("]);
    expect(denyScan(`const es = new EventSource(u);`)).toEqual(["new EventSource"]);
    expect(denyScan(`function f(sessionId: string) {}`)).toEqual(["sessionId"]);
    expect(denyScan(`// the adapter owns the fetch( to /api/ and the sessionId\n`)).toEqual([]);
    expect(denyScan(`const view = { live: true };`)).toEqual([]);
  });

  test("INV-8e the shell is configured by PROPS, never by inheritance", () => {
    // FLOOR, POSITIVE CONTROL AND DISCRIMINATOR — §5.4-E makes all three
    // mandatory ("a scan without all three is a decoration"), and this was the
    // one INV-8 sub-check that shipped with none of them.
    if (SHELL_FILES.length < 6) {
      throw new Error(
        `INV-8e: only ${SHELL_FILES.length} non-test files under ${SHELL_ROOT} (floor 6) — the ` +
          `walk is broken or the directory moved, and every assertion below would hold over the ` +
          `empty set. NEXT STEP: fix SHELL_ROOT; do not relax the floor.`,
      );
    }
    // POSITIVE CONTROL: the shell's own component file is scanned, and it passes
    // for the reason claimed — it is full of `className`, which the word
    // boundary is what excuses.
    const shell = byRel.get(`${SHELL_ROOT}conversation.tsx`);
    expect(shell).toBeDefined();
    expect(shell!.code).toContain("className");
    expect(inheritanceScan("control", shell!.text)).toEqual([]);

    // DISCRIMINATOR, both directions, through the SAME function — fixtures
    // assembled at runtime so this file's own text cannot trip the scan it is
    // testing.
    const kw = "ex" + "tends";
    const cls = "cl" + "ass";
    expect(inheritanceScan("fixture.tsx", `${cls} Shell ${kw} React.Component {}`).length).toBe(2);
    expect(inheritanceScan("fixture.tsx", `${cls} Shell {}`).length).toBe(1);
    expect(inheritanceScan("fixture.tsx", `<div ${cls}Name="x" />`)).toEqual([]);
    // …and a MENTION is not a declaration: comments are blanked before the scan,
    // which matters because every header in this directory argues the rule.
    expect(inheritanceScan("fixture.tsx", `// never ${kw} the shell — configure it\n`)).toEqual([]);

    const violations = SHELL_FILES.flatMap((f) => inheritanceScan(f.rel, f.text));
    expect(violations).toEqual([]);
  });

  test("INV-8f the barrel's PRIMITIVES and the SIX built-in kind ids are exact-set pinned", () => {
    const barrel = byRel.get(BARREL_REL);
    if (!barrel) {
      throw new Error(
        `INV-8f: ${BARREL_REL} is not in the index. It is the "one roof" AC1 requires — the ` +
          `single import path every conversational surface uses. CONSEQUENCE: the pin below can ` +
          `no longer be checked and a later refactor could drop a primitive silently. NEXT STEP: ` +
          `find where the barrel moved and update BARREL_REL.`,
      );
    }
    // The PRIMITIVE group only. The shell/contract group is deliberately NOT
    // pinned: it grows as the contract grows, and pinning it would make every
    // legitimate addition look like a violation.
    expect(barrelPrimitiveExports(barrel.text)).toEqual(EXPECTED_PRIMITIVES);
    // The composer kit rides a star export — ~50 vendored symbols that move
    // together — so its presence is asserted rather than its membership.
    expect(barrel.code).toContain('export * from "@/components/ai-elements/prompt-input"');

    const items = byRel.get(`${SHELL_ROOT}items.ts`);
    if (!items) {
      throw new Error(
        `INV-8f: ${SHELL_ROOT}items.ts is not in the index — the built-in kind ids live there ` +
          `and cannot be checked. NEXT STEP: update the path.`,
      );
    }
    // An exact-set equality, so a SEVENTH built-in kind cannot appear without a
    // deliberate edit to this pin. AD-13: every id is namespaced, including the
    // built-ins — a bare "text" would be exactly the collision the rule prevents.
    expect(builtinKindIds(items.code)).toEqual(EXPECTED_BUILTIN_KIND_IDS);
    const kinds = byRel.get(`${SHELL_ROOT}kinds.tsx`);
    expect(kinds).toBeDefined();
    for (const id of EXPECTED_BUILTIN_KIND_IDS) {
      const key = id.split(":")[1]!;
      expect(kinds!.code).toContain(`CONVERSATION_KINDS.${key}`);
    }
  });

  test("INV-8g session-view.tsx kept the STAYED set and lost the MOVED set", () => {
    const donor = byRel.get(SESSION_VIEW_REL);
    if (!donor) {
      throw new Error(
        `INV-8g: ${SESSION_VIEW_REL} is not in the index. It is the file the shell was carved ` +
          `out of and the first owner adapter. CONSEQUENCE: the behaviour-unchanged claim (AC6) ` +
          `has no mechanical half at all. NEXT STEP: if the file was renamed — the ` +
          `SessionView → ProjectSessionView rename is a recorded, deliberate deferral — update ` +
          `SESSION_VIEW_REL rather than deleting this test.`,
      );
    }

    const missing = STAYED_IN_ADAPTER.filter(
      ([needle, , min]) => countOccurrences(donor.code, needle) < (min ?? 1),
    ).map(
      ([needle, what, min]) =>
        `${SESSION_VIEW_REL} contains "${needle}" ${countOccurrences(donor.code, needle)} ` +
        `time(s), expected at least ${min ?? 1} — ${what}. RULE (AC6): the carve-out ` +
          `moved the RENDER SEAM and nothing else; route, state and API stayed in the adapter. ` +
          `CONSEQUENCE: session semantics have followed the transcript into the shell, which ` +
          `INV-8a forbids from the other side — between them the two assertions mean the ` +
          `session lifecycle has nowhere left to live. NEXT STEP: put it back in the adapter.`,
    );
    expect(missing).toEqual([]);

    const leftBehind = MOVED_OUT_OF_ADAPTER.filter(([needle]) => donor.code.includes(needle)).map(
      ([needle, what]) =>
        `${SESSION_VIEW_REL} STILL contains "${needle}" — ${what}. RULE (AC6 / AD-12): the ` +
          `transcript's projection and its per-kind rendering live in ` +
          `components/conversation/**, and the registry's first job was collapsing the TWO ` +
          `copies of the dispatch this file used to hold. CONSEQUENCE: if a dispatch site is ` +
          `still here, the registry has only been ADDED, not proven — and the seventh copy is ` +
          `already inside the donor. NEXT STEP: render it through the registry.`,
    );
    expect(leftBehind).toEqual([]);

    // The positive half of the same claim: the adapter really does render the
    // shell, through the one import path. The element test is anchored on the
    // character AFTER the name, because a bare `toContain("<Conversation")` is
    // satisfied by `<ConversationEmptyState`, which this adapter also renders —
    // so the control would have passed with the shell deleted.
    expect(donor.code).toContain('from "@/components/conversation"');
    expect(/<Conversation[\s/>]/.test(donor.code)).toBe(true);
    // …and it renders it as a TRANSCRIPT: both halves of the one slot that is a
    // pair. Either alone would not compile, which is exactly why asserting them
    // proves the render site is the real one rather than a stray element.
    expect(donor.code).toContain("items={");
    expect(donor.code).toContain("kinds={");
  });

  test("INV-8i ConversationProps is the CLOSED prop list §5.5-D6 declares", () => {
    const conv = byRel.get(`${SHELL_ROOT}conversation.tsx`);
    if (!conv) {
      throw new Error(
        `INV-8i: ${SHELL_ROOT}conversation.tsx is not in the index — the shell's prop contract ` +
          `lives there and cannot be checked. NEXT STEP: find where the shell moved and update ` +
          `the path; do not delete this test.`,
      );
    }
    const found = conversationPropNames(conv.code);
    // ANTI-VACUITY: a parser that finds nothing would make the equality below a
    // statement about the empty set, and this claim's whole point is that a
    // SIXTH non-slot prop cannot land quietly.
    if (found.length < 9) {
      throw new Error(
        `INV-8i: parsed only ${found.length} members out of ConversationProps (floor 9, ` +
          `measured 9): ${JSON.stringify(found)}. The PARSER is broken, not the contract — ` +
          `every assertion below would hold over a short list. NEXT STEP: fix ` +
          `conversationPropNames.`,
      );
    }
    // DISCRIMINATOR, both directions, through the same parser — assembled at
    // runtime so this file's own text is not what is being read.
    const fixture = (extra: string) =>
      `export type ConversationProps = {\n  items: readonly T[];\n  kinds: R;\n${extra}};\n`;
    expect(conversationPropNames(fixture(""))).toEqual(["items", "kinds"]);
    expect(conversationPropNames(fixture("  sessionId?: string;\n"))).toEqual([
      "items",
      "kinds",
      "sessionId",
    ]);
    // …a nested object type contributes its own name and not its fields, so the
    // pin cannot be satisfied or broken by something one level down.
    expect(conversationPropNames(fixture("  view: { live: boolean; busy: boolean };\n"))).toEqual([
      "items",
      "kinds",
      "view",
    ]);

    expect(found).toEqual(EXPECTED_CONVERSATION_PROPS);
    // The four slots by name, so the failure says WHICH half of D6 moved: a
    // renamed slot and an added non-slot prop are different mistakes.
    for (const slot of ["items", "kinds", "composer", "rail", "header"]) {
      expect(found).toContain(slot);
    }
  });

  test("INV-8j the scan index skips every dist dir next.config.ts advertises", () => {
    // SF-6's guard, and it is maxim 3 applied to the WALK: the invariant suite
    // reads a tree whose build-output directory name is configurable, and the
    // config's own comments are where a developer learns the names. If the two
    // disagree, INV-8c fails on minified chunks (`creates React context "r"`)
    // and a green gate turns red for a reason unrelated to the code.
    const cfgRel = "apps/web/next.config.ts";
    const cfg = byRel.get(cfgRel);
    if (!cfg) {
      throw new Error(
        `INV-8j: ${cfgRel} is not in the index, so the dist-dir names it advertises cannot be ` +
          `re-derived. NEXT STEP: update the path; do not delete this test.`,
      );
    }
    // Re-DERIVED from the config's own text (comments included — that is where
    // the examples live), never restated here.
    const advertised = [...cfg.text.matchAll(/NEXT_DIST_DIR=([.\w-]+)/g)].map((m) => m[1]!);
    expect(advertised.length).toBeGreaterThanOrEqual(2);
    const missed = advertised.filter((name) => !isExcludedDir(name));
    expect(missed).toEqual([]);
    // The default, and the shape of every sibling.
    expect(isExcludedDir(".next")).toBe(true);
    expect(isExcludedDir(".next-build")).toBe(true);
    expect(isExcludedDir(".next-anything-a-developer-picks")).toBe(true);
    // …and the pattern is not a blanket: real source directories still walk.
    expect(isExcludedDir("components")).toBe(false);
    expect(isExcludedDir("next")).toBe(false);
    expect(isExcludedDir(".nextish")).toBe(false);
  });

  test("INV-8h the quarantine did not grow — INV-8 added no KNOWN_VIOLATIONS entry", () => {
    // KNOWN_VIOLATIONS has held at exactly ONE entry across seven stories.
    // INV-8 did not reach for it: components/conversation/** was written to the
    // contract rather than excused from it. A future INV-8 entry appearing here
    // should be an argument someone has, not a line that lands quietly.
    expect(KNOWN_VIOLATIONS.filter((k) => k.invariant === "INV-8")).toEqual([]);
  });
});
