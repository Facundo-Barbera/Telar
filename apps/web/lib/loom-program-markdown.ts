/**
 * EDITING THE PROGRAM WITHOUT OWNING THE PROGRAM.
 *
 * `.telar/loom.md` is the artifact and the engine is its only parser and its
 * only renderer (`parseProgram` / `renderProgram`). `PUT /api/looms/program`
 * takes MARKDOWN, so a block editor in the browser has exactly two honest
 * options: re-render the whole file from a parsed object — which would mean a
 * second renderer in a second language, drifting from the first — or rewrite
 * the few characters the human actually changed and let the engine parse the
 * result.
 *
 * This module is the second option, and it is why §2 says "editing via UI
 * rewrites only the block that changed". Everything here is a surgical text
 * edit on the file's own bytes:
 *
 *   · prose the human wrote around a block survives, because it is never read
 *   · a heading the parser does not know survives, because it is never touched
 *   · a comment beside a command survives, because only the fence body moves
 *   · the diff in `git log` is the size of the change, not the size of the file
 *
 * EVERY FUNCTION IS TOTAL. Editing a block that is not in the file APPENDS it
 * under the right heading rather than failing — a Program that never had a
 * `publish` command is the normal case for a project that has not finished
 * setup, and "you cannot fill this in because it is empty" would be absurd.
 *
 * The formats below mirror `apps/engine/src/loom/program.ts` exactly, and
 * `loom-program-markdown.test.ts` asserts each one round-trips.
 */

export type CommandSlot = "probe" | "list" | "detail" | "publish";
export type BulletSection = "ask-when" | "assumed" | "never-touch";

const FENCE = /^```(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RUNG = /^(\d+)[.)]?\s+(.*)$/;
const ABSORBED = /\s*\(absorbed\s+(\d+)\)\s*$/i;
const TOGGLE = /\s*\[(on|off)\]\s*$/i;
const ON_UNKNOWN = /^on\s+unknown\s*:\s*(.*)$/i;

/** The engine's own heading normalizer, so "Assumed — confirm" matches. */
function normalizeHeading(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const SECTION_TITLES: Record<string, string> = {
  "work-source": "## Work source",
  gates: "## Gates",
  work: "## Work",
  "never-touch": "## Never touch",
  "when-stuck": "## When stuck",
  "ask-when": "## Ask me only when",
  "when-to-look": "## When to look",
  assumed: "## Assumed — confirm",
  notes: "## Notes",
};

/** Heading text → the key this module addresses it by. Unknown headings get no key. */
function keyFor(title: string): string | undefined {
  const n = normalizeHeading(title);
  if (n.startsWith("loom program")) return "title";
  const map: Record<string, string> = {
    "work source": "work-source",
    gates: "gates",
    work: "work",
    "never touch": "never-touch",
    "when stuck": "when-stuck",
    "ask me only when": "ask-when",
    "when to look": "when-to-look",
    "assumed confirm": "assumed",
    assumed: "assumed",
    notes: "notes",
  };
  return map[n];
}

type Span = { start: number; end: number };
type Fence = Span & { info: string };
type Section = Span & { key: string | undefined; title: string };

function split(markdown: string): string[] {
  return markdown.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * Every fenced block, as half-open line spans `[start, end)` where `start` is
 * the opening ``` line. An UNCLOSED fence runs to end of file, matching the
 * engine's tokenizer — the two must agree about where a block ends or an edit
 * lands in the wrong place.
 */
function fences(rows: readonly string[]): Fence[] {
  const found: Fence[] = [];
  for (let i = 0; i < rows.length; i++) {
    const open = FENCE.exec(rows[i] ?? "");
    if (!open) continue;
    const info = (open[1] ?? "").trim();
    let end = rows.length;
    for (let j = i + 1; j < rows.length; j++) {
      if ((rows[j] ?? "").trim().startsWith("```")) {
        end = j + 1;
        break;
      }
    }
    found.push({ info, start: i, end });
    i = end - 1;
  }
  return found;
}

/** Every heading and the lines under it, up to the next heading. */
function sections(rows: readonly string[]): Section[] {
  const found: Section[] = [];
  const inFence = new Set<number>();
  for (const fence of fences(rows)) for (let i = fence.start; i < fence.end; i++) inFence.add(i);
  for (let i = 0; i < rows.length; i++) {
    if (inFence.has(i)) continue;
    const heading = HEADING.exec(rows[i] ?? "");
    if (!heading) continue;
    const title = (heading[2] ?? "").trim();
    const previous = found[found.length - 1];
    if (previous) previous.end = i;
    found.push({ key: keyFor(title), title, start: i, end: rows.length });
  }
  return found;
}

function joinBack(rows: readonly string[]): string {
  const text = rows.join("\n");
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Put a section's body in place, creating the heading at the end of the file if
 * it is not there. Appending rather than guessing a position keeps the edit
 * local: a file whose author ordered their headings unusually is not reordered
 * behind their back.
 */
function writeSection(markdown: string, key: string, body: string[]): string {
  const rows = split(markdown);
  const section = sections(rows).find((candidate) => candidate.key === key);
  if (!section) {
    const heading = SECTION_TITLES[key] ?? `## ${key}`;
    const trimmed = [...rows];
    while (trimmed.length > 0 && (trimmed[trimmed.length - 1] ?? "").trim() === "") trimmed.pop();
    return joinBack([...trimmed, "", heading, "", ...body]);
  }
  return joinBack([...rows.slice(0, section.start + 1), "", ...body, "", ...rows.slice(section.end)]);
}

/** A section's body lines, or `[]` when the heading is absent. */
export function sectionBody(markdown: string, key: string): string[] {
  const rows = split(markdown);
  const section = sections(rows).find((candidate) => candidate.key === key);
  return section ? rows.slice(section.start + 1, section.end) : [];
}

// ---------------------------------------------------------------------------
// The four command slots
// ---------------------------------------------------------------------------

/**
 * Rewrite one command slot in place.
 *
 * ONLY THE BODY MOVES. The fence's info string and its position are left alone,
 * so a `# $ITEM` comment the author put on the fence line, and any prose above
 * or below it, are exactly where they were.
 */
export function setCommand(markdown: string, slot: CommandSlot, command: string): string {
  const rows = split(markdown);
  const value = command.trim();
  const target = fences(rows).find((fence) => fence.info.split(/\s+/)[0]?.toLowerCase() === slot);
  if (!target) {
    if (value === "") return joinBack(rows);
    const existing = sectionBody(markdown, "work-source").filter((line) => line.trim() !== "");
    return writeSection(markdown, "work-source", [...existing, "```" + slot, value, "```"]);
  }
  const closed = (rows[target.end - 1] ?? "").trim().startsWith("```") && target.end - 1 > target.start;
  const tail = closed ? rows.slice(target.end - 1) : rows.slice(target.end);
  const body = value === "" ? [] : value.split("\n");
  return joinBack([
    ...rows.slice(0, target.start),
    rows[target.start] ?? "```" + slot,
    ...body,
    ...(closed ? [] : ["```"]),
    ...tail,
  ]);
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * `On unknown:` for the Nth gate.
 *
 * The line applies to the gate block ABOVE it — that is how the artifact reads
 * and how the parser attaches it — so the write goes immediately after that
 * gate's closing fence, replacing the existing line if there is one.
 *
 * NEVER A BOOLEAN. This is the policy for a gate that COULD NOT RUN, which is a
 * third answer, and the only two legal values are `hold` and `publish`.
 */
export function setGateUnknownPolicy(markdown: string, gateIndex: number, policy: "hold" | "publish"): string {
  const rows = split(markdown);
  const gates = fences(rows).filter((fence) => fence.info.split(/\s+/)[0]?.toLowerCase() === "gate");
  const gate = gates[gateIndex];
  if (!gate) return joinBack(rows);
  const next = gates[gateIndex + 1];
  const limit = next ? next.start : rows.length;
  for (let i = gate.end; i < limit; i++) {
    if (ON_UNKNOWN.test((rows[i] ?? "").trim())) {
      return joinBack([...rows.slice(0, i), `On unknown: ${policy}`, ...rows.slice(i + 1)]);
    }
  }
  return joinBack([...rows.slice(0, gate.end), `On unknown: ${policy}`, ...rows.slice(gate.end)]);
}

/** The command line of the Nth gate — the first line inside its fence. */
export function setGateCommand(markdown: string, gateIndex: number, command: string): string {
  const rows = split(markdown);
  const gates = fences(rows).filter((fence) => fence.info.split(/\s+/)[0]?.toLowerCase() === "gate");
  const gate = gates[gateIndex];
  const value = command.trim();
  if (!gate || value === "") return joinBack(rows);
  return joinBack([...rows.slice(0, gate.start + 1), value, ...rows.slice(gate.start + 2)]);
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

/**
 * Flip one rung on or off.
 *
 * THE LABEL AND THE ABSORBED COUNT ARE PRESERVED BYTE FOR BYTE, including the
 * padding the renderer used to line the toggle column up. A human turns a rung
 * off at 2am; the file should show one word changed, not a reflowed list.
 */
export function setRungEnabled(markdown: string, n: number, enabled: boolean): string {
  const rows = split(markdown);
  const section = sections(rows).find((candidate) => candidate.key === "when-stuck");
  if (!section) return joinBack(rows);
  for (let i = section.start + 1; i < section.end; i++) {
    const raw = rows[i] ?? "";
    const rung = RUNG.exec(raw.trim());
    if (!rung || Number(rung[1]) !== n) continue;
    let rest = rung[2] ?? "";
    const absorbed = ABSORBED.exec(rest);
    const absorbedText = absorbed ? absorbed[0] : "";
    if (absorbed) rest = rest.slice(0, absorbed.index);
    const toggle = TOGGLE.exec(rest);
    // Keep the author's own spacing before the toggle, so a padded column stays
    // a padded column.
    const label = toggle ? rest.slice(0, toggle.index) : rest.replace(/\s+$/, "");
    const gap = toggle ? (toggle[0] ?? "").replace(/\[(on|off)\]\s*$/i, "") : "  ";
    rows[i] = `${n} ${label}${gap}${enabled ? "[on]" : "[off]"}${absorbedText}`;
    return joinBack(rows);
  }
  return joinBack(rows);
}

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

/** `every 300s, backing off to 3600s` — the one sentence the parser reads. */
export function setWatchSchedule(markdown: string, intervalSec: number, backoffMaxSec: number): string {
  return writeSection(markdown, "when-to-look", [`every ${intervalSec}s, backing off to ${backoffMaxSec}s`]);
}

// ---------------------------------------------------------------------------
// Bullet lists
// ---------------------------------------------------------------------------

/** Replace a bullet section wholesale. An empty list leaves the heading standing. */
export function setBullets(markdown: string, section: BulletSection, items: readonly string[]): string {
  const clean = items.map((item) => item.trim()).filter((item) => item !== "");
  const prefix = section === "never-touch" ? "" : "- ";
  return writeSection(
    markdown,
    section,
    clean.map((item) => `${prefix}${item}`),
  );
}

/**
 * CONFIRMING AN ASSUMPTION IS DELETING IT.
 *
 * "Assumed — confirm" is the list of things setup guessed. Confirming one means
 * it is no longer an assumption, so it leaves the list; the Program's own text
 * is what it was assumed INTO, and that text is already there. §4.4: a wrong
 * assumption you can see is survivable, an invisible one is not — which is an
 * argument for showing them, not for keeping them forever after they are read.
 */
export function removeAssumption(markdown: string, assumption: string): string {
  const remaining = readBullets(markdown, "assumed").filter((item) => item !== assumption.trim());
  return setBullets(markdown, "assumed", remaining);
}

/** The items of a bullet section, stripped of their markers. */
export function readBullets(markdown: string, section: BulletSection): string[] {
  return sectionBody(markdown, section)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("```"))
    .map((line) => line.replace(/^[-*+]\s+/, ""));
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * "How to read one" — the prose. It is the Program's `notes`, and the renderer
 * emits it under `## Notes`, so that is where an edit goes.
 */
export function setNotes(markdown: string, notes: string): string {
  const body = notes.trim();
  return writeSection(markdown, "notes", body === "" ? [] : body.split("\n"));
}
