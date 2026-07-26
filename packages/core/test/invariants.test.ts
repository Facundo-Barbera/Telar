// THE FIVE LOAD-BEARING INVARIANTS, MADE EXECUTABLE (AD-19 / CAP-6 / NFR-X-14).
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
// module scope; all five invariants read that index. No tsc invocation, no
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
  "release",
  "dist",
  "build",
  ".git",
  "out",
  "coverage",
  "_bmad-output",
]);

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
      if (EXCLUDED_DIRS.has(entry.name)) continue;
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
