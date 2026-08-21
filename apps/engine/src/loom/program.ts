/**
 * THE PROGRAM ARTIFACT — markdown in, `LoomProgram` out, and back again.
 *
 * The Program lives in the PROJECT's repo at `.telar/loom.md`: portable,
 * diffable, reviewable, and it travels with the project rather than with this
 * machine. It is human-first — someone reads it at 2am — so the machine-
 * readable parts are fenced blocks and a handful of key/value lines under known
 * headings, and everything else in the file is prose.
 *
 * ── THE PARSER NEVER FAILS ───────────────────────────────────────────────────
 * `parseProgram` has no error path. An unknown heading is not a syntax error,
 * it is prose: the heading and its body are appended verbatim to `notes`, a
 * warning is emitted, and the rest of the file parses exactly as before. A
 * Program with a typo DEGRADES; it does not stop the orchestrator. The same
 * rule covers a malformed exit line, a rung with no `[on]`, an unreadable
 * interval — every one of them is a warning plus a documented fallback, never a
 * throw. The alternative is a system that stops working overnight because a
 * heading was misspelt, which is the failure this whole design exists to avoid.
 *
 * ── THE ROUND-TRIP IS A PROPERTY, NOT A HOPE ─────────────────────────────────
 * `parseProgram(renderProgram(p)).program` deep-equals `p` for everything the
 * parser understands. That is what lets the UI's Program tab rewrite ONE block
 * without touching the rest of the file, and it is why `notes` is rendered
 * under a `## Notes` heading that the parser then reads back verbatim: notes
 * containing their own `##` headings survive the trip because an unknown
 * heading lands in notes INCLUDING its heading line, which is precisely the
 * text render emitted.
 *
 * ── GITHUB IS A BLOCK OF TEXT ────────────────────────────────────────────────
 * `GITHUB_PRESET` is parsed from `GITHUB_PRESET_MARKDOWN` at import. It is a
 * preset, not an integration: nothing in this file, or anywhere downstream,
 * knows what GitHub is or branches on it. Adding "support" for another tracker
 * means writing another markdown string.
 */
import {
  LoomProgram,
  type GateUnknownPolicy,
  type LoomCommands,
  type LoomGate,
  type Rung,
} from "@telar/engine-client";

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type Token =
  | { kind: "text"; raw: string }
  | { kind: "heading"; raw: string; level: number; title: string }
  | { kind: "fence"; raw: string; info: string; content: string };

const FENCE = /^```(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;

function tokenize(markdown: string): Token[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const tokens: Token[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = FENCE.exec(line);
    if (fence) {
      const info = (fence[1] ?? "").trim();
      const body: string[] = [];
      let closed = false;
      i++;
      for (; i < lines.length; i++) {
        const inner = lines[i] ?? "";
        if (FENCE.test(inner) && (inner.trim() === "```" || inner.trim().startsWith("```"))) {
          closed = true;
          break;
        }
        body.push(inner);
      }
      // An UNCLOSED fence is still a block. Refusing to parse the rest of the
      // file over a missing three backticks would be exactly the brittleness
      // this parser is built not to have.
      tokens.push({
        kind: "fence",
        raw: ["```" + info, ...body, ...(closed ? ["```"] : [])].join("\n"),
        info,
        content: body.join("\n"),
      });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      tokens.push({
        kind: "heading",
        raw: line,
        level: (heading[1] ?? "#").length,
        title: (heading[2] ?? "").trim(),
      });
      continue;
    }
    tokens.push({ kind: "text", raw: line });
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

type SectionKey =
  | "title"
  | "work-source"
  | "gates"
  | "work"
  | "never-touch"
  | "when-stuck"
  | "ask-when"
  | "when-to-look"
  | "assumed"
  | "notes"
  | "unknown";

/** Lowercase, punctuation to spaces, collapsed. "Assumed — confirm" →
 *  "assumed confirm", so an em dash, a hyphen or nothing all read the same. */
function normalizeHeading(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sectionKeyFor(title: string, level: number): SectionKey {
  const n = normalizeHeading(title);
  if (level === 1 && n.startsWith("loom program")) return "title";
  switch (n) {
    case "work source":
      return "work-source";
    case "gates":
      return "gates";
    case "work":
      return "work";
    case "never touch":
      return "never-touch";
    case "when stuck":
      return "when-stuck";
    case "ask me only when":
      return "ask-when";
    case "when to look":
      return "when-to-look";
    case "assumed confirm":
    case "assumed":
      return "assumed";
    case "notes":
      return "notes";
    default:
      return "unknown";
  }
}

type Section = { key: SectionKey; heading: Token & { kind: "heading" }; tokens: Token[] };

// ---------------------------------------------------------------------------
// Small parsers
// ---------------------------------------------------------------------------

const DURATION = /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/i;

/** `300` / `300s` / `5m` / `1h` → seconds. Null when it is not a duration. */
export function parseDuration(token: string): number | null {
  const m = DURATION.exec(token.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "s").toLowerCase();
  if (unit.startsWith("h")) return n * 3600;
  if (unit.startsWith("m")) return n * 60;
  return n;
}

/** Text lines of a section, with the surrounding blank lines removed. */
function textLines(tokens: Token[]): string[] {
  return tokens.filter((t): t is Token & { kind: "text" } => t.kind === "text").map((t) => t.raw);
}

function trimBlank(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") start++;
  while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
  return lines.slice(start, end);
}

/** `- item`, `* item`, `item` — all one item. Blank lines are separators. */
function bulletItems(tokens: Token[]): string[] {
  return textLines(tokens)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => l.replace(/^[-*+]\s+/, "").trim())
    .filter((l) => l !== "");
}

// ---------------------------------------------------------------------------
// parseProgram
// ---------------------------------------------------------------------------

export type ParsedProgram = { program: LoomProgram; warnings: string[] };

const RUNG = /^(\d+)[.)]?\s+(.*)$/;
const ABSORBED = /\s*\(absorbed\s+(\d+)\)\s*$/i;
const TOGGLE = /\s*\[(on|off)\]\s*$/i;
const ON_UNKNOWN = /^on\s+unknown\s*:\s*(.*)$/i;
const KEY_VALUE = /^([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i;

/**
 * Markdown → `LoomProgram` + warnings. NEVER THROWS. See the file header.
 *
 * Fenced blocks whose info string is `probe` / `list` / `detail` / `publish` /
 * `gate` are claimed as machine-readable wherever in the file they appear —
 * heading position is a convenience for the reader, not a requirement for the
 * parser. Every other block, and every unknown heading, is prose.
 */
export function parseProgram(markdown: string): ParsedProgram {
  const warnings: string[] = [];
  const tokens = tokenize(markdown);

  // Split into sections. Anything before the first heading is a preamble and
  // is treated as prose — the file is allowed to open with a paragraph.
  const preamble: Token[] = [];
  const sections: Section[] = [];
  for (const token of tokens) {
    if (token.kind === "heading") {
      sections.push({ key: sectionKeyFor(token.title, token.level), heading: token, tokens: [] });
      continue;
    }
    const current = sections[sections.length - 1];
    if (current) current.tokens.push(token);
    else preamble.push(token);
  }

  const commands: LoomCommands = {};
  const gates: LoomGate[] = [];
  const ladder: Rung[] = [];
  const neverTouch: string[] = [];
  const askWhen: string[] = [];
  const assumed: string[] = [];
  const noteChunks: string[] = [];
  let project = "";
  let base: string | undefined;
  let branchPrefix: string | undefined;
  let concurrency: number | undefined;
  let setup: string | undefined;
  let intervalSec: number | undefined;
  let backoffMaxSec: number | undefined;

  // A fence claimed as a command or a gate must NOT also land in notes, or a
  // round trip would duplicate it.
  const claimed = new WeakSet<Token>();

  const claimFence = (token: Token & { kind: "fence" }, where: string): void => {
    const info = token.info.split(/\s+/)[0]?.toLowerCase() ?? "";
    const body = token.content.trim();
    if (info === "probe" || info === "list" || info === "detail" || info === "publish") {
      claimed.add(token);
      if (body === "") {
        warnings.push(`empty \`${info}\` block${where} — the slot stays unset`);
        return;
      }
      if (commands[info] !== undefined) {
        warnings.push(`duplicate \`${info}\` block${where} — the last one wins`);
      }
      commands[info] = body;
      return;
    }
    if (info === "gate") {
      claimed.add(token);
      const lines = body.split("\n").map((l) => l.trim()).filter((l) => l !== "");
      const command = lines.shift();
      if (!command) {
        warnings.push(`empty \`gate\` block${where} — skipped`);
        return;
      }
      const exits: Record<number, "pass" | "fail" | "unknown"> = {};
      for (const line of lines) {
        const m = /^(\d+)\s+(pass|fail|unknown)$/i.exec(line);
        if (!m) {
          warnings.push(
            `gate "${command}": could not read "${line}" as \`<exit code> <pass|fail|unknown>\` — ignored`,
          );
          continue;
        }
        exits[Number(m[1])] = m[2]!.toLowerCase() as "pass" | "fail" | "unknown";
      }
      gates.push({ command, exits, onUnknown: "hold" });
    }
  };

  // Fences are claimed globally, in document order.
  for (const token of tokens) if (token.kind === "fence") claimFence(token, "");

  const noteChunkFrom = (lines: string[]): void => {
    const trimmed = trimBlank(lines);
    if (trimmed.length > 0) noteChunks.push(trimmed.join("\n"));
  };

  noteChunkFrom(preamble.filter((t) => !claimed.has(t)).map((t) => t.raw));

  for (const section of sections) {
    switch (section.key) {
      case "title": {
        // `# Loom program — ozom-gv` → "ozom-gv". A bare `# Loom program` is a
        // program with no name, which is legal.
        const rest = section.heading.title.replace(/^loom\s+program/i, "").trim();
        project = rest.replace(/^[—–\-:]\s*/, "").trim();
        noteChunkFrom(section.tokens.filter((t) => !claimed.has(t)).map((t) => t.raw));
        break;
      }

      case "work-source":
        // The blocks were claimed above; anything else here is prose the author
        // wrote around them, and it belongs in notes rather than the bin.
        noteChunkFrom(section.tokens.filter((t) => !claimed.has(t)).map((t) => t.raw));
        break;

      case "gates": {
        // `On unknown:` applies to the gate block ABOVE it, which is how the
        // artifact reads and what makes per-gate policy round-trip. A line that
        // appears before any gate sets the default for the ones that follow.
        let sectionDefault: GateUnknownPolicy | undefined;
        let seen = 0;
        const leftovers: string[] = [];
        for (const token of section.tokens) {
          if (token.kind === "fence") {
            if (claimed.has(token)) seen++;
            else leftovers.push(token.raw);
            continue;
          }
          if (token.kind !== "text") continue;
          const m = ON_UNKNOWN.exec(token.raw.trim());
          if (!m) {
            leftovers.push(token.raw);
            continue;
          }
          const value = (m[1] ?? "").trim().toLowerCase().replace(/\s*#.*$/, "");
          if (value !== "hold" && value !== "publish") {
            warnings.push(`"On unknown: ${m[1]}" is neither \`hold\` nor \`publish\` — holding`);
            continue;
          }
          const target = gates[seen - 1];
          if (target) target.onUnknown = value;
          else sectionDefault = value;
        }
        if (sectionDefault) for (const gate of gates) gate.onUnknown = sectionDefault;
        noteChunkFrom(leftovers);
        break;
      }

      case "work": {
        const leftovers: string[] = [];
        for (const line of textLines(section.tokens)) {
          const trimmed = line.trim();
          if (trimmed === "") continue;
          const kv = KEY_VALUE.exec(trimmed);
          if (!kv) {
            leftovers.push(line);
            continue;
          }
          const key = (kv[1] ?? "").toLowerCase();
          const value = stripComment(kv[2] ?? "");
          switch (key) {
            case "base":
              if (value === "") warnings.push("`base:` is empty — keeping the default");
              else base = value;
              break;
            case "branch":
            case "branchprefix":
              // Written as `branch: t3code/<slug>`; the placeholder is what
              // makes the line readable, and the prefix is what we keep.
              if (value === "") warnings.push("`branch:` is empty — keeping the default");
              else branchPrefix = value.replace(/<slug>\s*$/, "");
              break;
            case "concurrency": {
              const n = Number(value);
              if (!Number.isInteger(n) || n < 0) {
                warnings.push(`concurrency "${value}" is not a whole number — keeping the default`);
              } else concurrency = n;
              break;
            }
            case "setup":
              if (value !== "") setup = value;
              break;
            default:
              warnings.push(`unknown key "${key}" under "## Work" — kept as notes`);
              leftovers.push(line);
          }
        }
        noteChunkFrom(leftovers);
        break;
      }

      case "never-touch":
        for (const glob of bulletItems(section.tokens)) neverTouch.push(stripComment(glob));
        break;

      case "when-stuck": {
        for (const line of textLines(section.tokens)) {
          const trimmed = line.trim();
          if (trimmed === "") continue;
          const m = RUNG.exec(trimmed);
          if (!m) {
            warnings.push(`could not read "${trimmed}" as a ladder rung — ignored`);
            continue;
          }
          const n = Number(m[1]);
          let rest = m[2] ?? "";
          let absorbed = 0;
          const absorbedMatch = ABSORBED.exec(rest);
          if (absorbedMatch) {
            absorbed = Number(absorbedMatch[1]);
            rest = rest.slice(0, absorbedMatch.index);
          }
          let enabled = true;
          const toggle = TOGGLE.exec(rest);
          if (toggle) {
            enabled = (toggle[1] ?? "").toLowerCase() === "on";
            rest = rest.slice(0, toggle.index);
          } else {
            warnings.push(`rung ${n} has no [on]/[off] marker — treating it as on`);
          }
          if (n <= 0) {
            // Rung 0 would be unreachable: `ladderRung: 0` is the loom's "no
            // rung tried yet", so a rung numbered 0 could never be selected.
            // Saying so is better than shipping a rung that silently never runs.
            warnings.push("ladder rungs are numbered from 1 — rung 0 was dropped");
            continue;
          }
          ladder.push({ n, label: rest.trim(), enabled, absorbed });
        }
        break;
      }

      case "ask-when":
        for (const item of bulletItems(section.tokens)) askWhen.push(item);
        break;

      case "when-to-look": {
        const text = trimBlank(textLines(section.tokens)).join(" ");
        const every = /every\s+([0-9]+\s*[a-z]*)/i.exec(text);
        const backoff = /back(?:ing)?\s*off(?:\s+to)?\s+([0-9]+\s*[a-z]*)/i.exec(text);
        const parsedEvery = every ? parseDuration(every[1] ?? "") : null;
        const parsedBackoff = backoff ? parseDuration(backoff[1] ?? "") : null;
        if (parsedEvery !== null) intervalSec = parsedEvery;
        if (parsedBackoff !== null) backoffMaxSec = parsedBackoff;
        if (text.trim() !== "" && parsedEvery === null && parsedBackoff === null) {
          warnings.push(
            `could not read a schedule from "${text.trim()}" — keeping the default 300s → 3600s`,
          );
        }
        break;
      }

      case "assumed":
        for (const item of bulletItems(section.tokens)) assumed.push(item);
        break;

      case "notes":
        noteChunkFrom(section.tokens.filter((t) => !claimed.has(t)).map((t) => t.raw));
        break;

      case "unknown":
        // THE HARD REQUIREMENT. The heading line travels with its body, so the
        // text that lands in notes is byte-for-byte what render will emit back.
        warnings.push(`unknown heading "${section.heading.title}" — kept as notes`);
        noteChunkFrom([
          section.heading.raw,
          ...section.tokens.filter((t) => !claimed.has(t)).map((t) => t.raw),
        ]);
        break;
    }
  }

  if (commands.probe === undefined) {
    warnings.push("no `probe` command — the sentinel is disabled and the loop falls back to its heartbeat");
  }

  const built = {
    version: 1 as const,
    project,
    commands,
    gates,
    work: {
      base: base ?? "main",
      branchPrefix: branchPrefix ?? "t3code/",
      concurrency: concurrency ?? 4,
      ...(setup === undefined ? {} : { setup }),
    },
    neverTouch,
    ladder,
    askWhen,
    watch: { intervalSec: intervalSec ?? 300, backoffMaxSec: backoffMaxSec ?? 3600 },
    assumed,
    notes: noteChunks.join("\n\n"),
  };

  const parsed = LoomProgram.safeParse(built);
  if (parsed.success) return { program: parsed.data, warnings };
  // Unreachable by construction — every field above is built pre-validated.
  // Kept anyway, because "the parser never throws" is a promise the supervisor
  // relies on at 3am and a promise with an exception path is not one.
  warnings.push(`the assembled program did not validate (${parsed.error.issues.length} issues) — the whole file is being kept as notes`);
  return { program: LoomProgram.parse({ notes: markdown }), warnings };
}

/** `bun install        # once per worktree` → `bun install`. Trailing `#`
 *  comments are a documented convenience of the key/value lines only; a
 *  command inside a fenced block keeps every character it was given. */
function stripComment(value: string): string {
  return value.replace(/\s+#.*$/, "").trim();
}

// ---------------------------------------------------------------------------
// renderProgram
// ---------------------------------------------------------------------------

/**
 * `LoomProgram` → the canonical markdown. The inverse of `parseProgram` for
 * everything the parser understands.
 *
 * EMPTY SECTIONS ARE OMITTED rather than emitted as bare headings: the artifact
 * is read by a person, and a page of empty headings reads as a broken file. An
 * omitted section parses back as the empty value it was, so the round trip is
 * unaffected.
 */
export function renderProgram(p: LoomProgram): string {
  const out: string[] = [];
  out.push(p.project.trim() === "" ? "# Loom program" : `# Loom program — ${p.project.trim()}`);

  const slots: Array<keyof LoomCommands> = ["probe", "list", "detail", "publish"];
  const present = slots.filter((slot) => (p.commands[slot] ?? "") !== "");
  if (present.length > 0) {
    out.push("", "## Work source");
    for (const slot of present) out.push("", "```" + slot, p.commands[slot] as string, "```");
  }

  if (p.gates.length > 0) {
    out.push("", "## Gates");
    for (const gate of p.gates) {
      out.push("", "```gate", gate.command);
      for (const code of Object.keys(gate.exits)
        .map(Number)
        .sort((a, b) => a - b)) {
        out.push(`${code} ${gate.exits[code]}`);
      }
      out.push("```", `On unknown: ${gate.onUnknown}`);
    }
  }

  out.push("", "## Work", "", `base: ${p.work.base}`, `branch: ${p.work.branchPrefix}<slug>`, `concurrency: ${p.work.concurrency}`);
  if (p.work.setup !== undefined && p.work.setup !== "") out.push(`setup: ${p.work.setup}`);

  if (p.neverTouch.length > 0) out.push("", "## Never touch", "", ...p.neverTouch);

  if (p.ladder.length > 0) {
    out.push("", "## When stuck", "");
    // Pad so the [on]/[off] column lines up — this file gets read half asleep
    // and the column is the fastest way to see what is switched off.
    const width = Math.max(...p.ladder.map((r) => r.label.length));
    for (const rung of p.ladder) {
      const toggle = rung.enabled ? "[on]" : "[off]";
      const absorbed = rung.absorbed > 0 ? ` (absorbed ${rung.absorbed})` : "";
      out.push(`${rung.n} ${rung.label.padEnd(width)}  ${toggle}${absorbed}`);
    }
  }

  if (p.askWhen.length > 0) out.push("", "## Ask me only when", "", ...p.askWhen.map((a) => `- ${a}`));

  out.push("", "## When to look", "", `every ${p.watch.intervalSec}s, backing off to ${p.watch.backoffMaxSec}s`);

  if (p.assumed.length > 0) out.push("", "## Assumed — confirm", "", ...p.assumed.map((a) => `- ${a}`));

  if (p.notes.trim() !== "") out.push("", "## Notes", "", p.notes.trim());

  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Data: the default program and the GitHub preset
// ---------------------------------------------------------------------------

/**
 * The ladder and the ask-when list a project starts with, and NOTHING ELSE.
 *
 * No commands, no gates: a Program that invented a work source would dispatch
 * against a tracker nobody named. The two lists below are defaults because they
 * are cheap, generic and safe — re-reading the item is never the wrong first
 * move, and the last three rungs ship OFF because they spend real time.
 */
export const DEFAULT_PROGRAM: LoomProgram = LoomProgram.parse({
  version: 1,
  project: "",
  commands: {},
  gates: [],
  work: { base: "main", branchPrefix: "t3code/", concurrency: 4 },
  neverTouch: [".env*"],
  ladder: [
    { n: 1, label: "re-read the item and everything said since it was dispatched", enabled: true, absorbed: 0 },
    { n: 2, label: "run the gate again — it may be flaky", enabled: true, absorbed: 0 },
    { n: 3, label: "narrow the scope and retry once", enabled: true, absorbed: 0 },
    { n: 4, label: "try a different approach from scratch", enabled: false, absorbed: 0 },
    { n: 5, label: "split it and run the piece that is clear", enabled: false, absorbed: 0 },
  ],
  askWhen: [
    "the item needs a product decision",
    "credentials or access I do not have",
    "the gate has failed at every rung above",
  ],
  watch: { intervalSec: 300, backoffMaxSec: 3600 },
  assumed: [],
  notes: "",
});

/**
 * GITHUB, AS DATA. Every "GitHub integration" this system has is the text
 * below. There is no adapter, no registry, and no `if (source === "github")`
 * anywhere downstream — a project that tracks work in `inbox.md` writes a
 * different string here and nothing else in the codebase changes.
 *
 * The `probe` command is the one with a hard contract: cheap, LLM-free, one
 * line of stdout. `gh issue list --json number,updatedAt` piped through a
 * digest is that line, and it changes exactly when an issue is opened, closed,
 * edited or commented on.
 */
export const GITHUB_PRESET_MARKDOWN = `# Loom program — github

## Work source

\`\`\`probe
gh issue list -s open -L 200 --json number,updatedAt -q 'map(.number|tostring + .updatedAt) | sort | join(",")' | shasum
\`\`\`

\`\`\`list
gh issue list --state open --limit 200 --json number,title,labels,milestone,updatedAt
\`\`\`

\`\`\`detail
gh issue view $ITEM --comments
\`\`\`

\`\`\`publish
gh pr create --draft --base $BASE --head $BRANCH --title "$TITLE" --body "$BODY"
\`\`\`

## Work

base: main
branch: t3code/<slug>
concurrency: 4

## Never touch

.env*

## When stuck

1 re-read the item and everything said since it was dispatched  [on]
2 run the gate again — it may be flaky                          [on]
3 narrow the scope and retry once                               [on]
4 try a different approach from scratch                         [off]
5 split it and run the piece that is clear                      [off]

## Ask me only when

- the item needs a product decision
- credentials or access I do not have
- the gate has failed at every rung above

## When to look

every 300s, backing off to 3600s

## Assumed — confirm

- this repo's gate command, because no gate is declared yet and an ungated loom publishes nothing
- that every open issue is a candidate; narrow the \`list\` command with a label or milestone if not
`;

/** The preset, parsed. Data all the way down — see `GITHUB_PRESET_MARKDOWN`. */
export const GITHUB_PRESET: LoomProgram = parseProgram(GITHUB_PRESET_MARKDOWN).program;
