/**
 * AREAS — the user's own groups, given exactly one property: a permit CEILING.
 *
 * ── WHY A RECORD AT ALL ──────────────────────────────────────────────────────
 * An area is a free-text string on subjects (`SpoolSubject.area`), and for
 * identity that is the whole story. But "Personal never gets worked without
 * asking" is a statement about the GROUP, and a per-subject permit cannot hold
 * it: file a new subject into Personal tomorrow and the statement silently
 * stops being true. So an area gains a small record, created lazily the first
 * time someone states a ceiling for it, holding that one statement.
 *
 * ── A CEILING CLAMPS DOWN AND NEVER RAISES ───────────────────────────────────
 * `effectivePermits` below is the ONE function every enforcement path reads:
 * effective = min(subject.permits, every ceiling stated on a prefix of the
 * subject's area PATH) in `SpoolSubjectPermits`' ordering (the `RANK` table
 * in `subjects.ts`, the one place the enum is ordered). An area name is a
 * path (docs/spool-loops.md §13.7): "Work / Focaltec" is clamped by a
 * ceiling on "Work" AND by one on "Work / Focaltec", most-restrictive wins.
 * No ceiling on any prefix means no clamp, and a ceiling above a subject's
 * own permit changes nothing — a group statement may only ever restrict.
 *
 * ── CEILINGS ARE STATED, NEVER ASSUMED ───────────────────────────────────────
 * No area — "Personal" included — is ever given a ceiling this code invented.
 * The record appears when the user states one, through their own hand or a
 * tool relaying their words, and clearing it withdraws the statement rather
 * than deleting the record: an area with no ceiling and no subjects just sits
 * unreferenced, harmlessly, like a retired lane.
 */
import fs from "node:fs";
import path from "node:path";
import { SpoolArea, SpoolSubjectPermits, type SpoolSubject } from "@telar/engine-client";
import { atomicWrite } from "../atomic";
import { capturedLabel, type SpoolPaths } from "./store";
import { PERMIT_RANK, SUBJECT_AREA_MAX } from "./subjects";

const AREAS_FILE = "areas.json";

export function areasPath(paths: SpoolPaths): string {
  return path.join(paths.root, AREAS_FILE);
}

/** Tolerant per row, like every other list here: one hand-edited record that
 *  will not parse must not cost the user every other area's ceiling. */
export function readAreas(paths: SpoolPaths): SpoolArea[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(areasPath(paths), "utf8"));
  } catch {
    // Never written is the ordinary state: areas exist as names on subjects
    // long before any of them has a record.
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const areas: SpoolArea[] = [];
  for (const row of raw) {
    const parsed = SpoolArea.safeParse(row);
    if (!parsed.success) continue;
    if (!parsed.data.name.trim()) continue;
    if (areas.some((a) => a.name === parsed.data.name)) continue;
    areas.push(parsed.data);
  }
  return areas;
}

export function writeAreas(paths: SpoolPaths, areas: SpoolArea[]): SpoolArea[] {
  const parsed = areas.map((a) => SpoolArea.parse(a));
  atomicWrite(areasPath(paths), parsed);
  return parsed;
}

/**
 * State a ceiling, or withdraw one with `null`.
 *
 * LAZY CREATION IS THE ONLY CREATION. There is no "create area" verb anywhere:
 * the record is minted here the first time a ceiling is stated for the name,
 * and never before — so an area can go its whole life as nothing but a string
 * on subjects. THROWS a sentence on a name or level the store must not hold —
 * a write is loud, like every write-side guard in this store.
 */
export function setAreaCeiling(paths: SpoolPaths, name: string, ceiling: SpoolSubjectPermits | null): SpoolArea {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('An area is a name — a word or two in the user\'s own vocabulary, like "Personal".');
  }
  if (trimmed.length > SUBJECT_AREA_MAX) {
    throw new Error(
      `That area name is ${trimmed.length} characters. An area is a short group name — "Trabajo", "Personal" — so the store caps it at ${SUBJECT_AREA_MAX}.`,
    );
  }
  if (ceiling !== null && !SpoolSubjectPermits.safeParse(ceiling).success) {
    throw new Error(
      `"${String(ceiling)}" is not a permit level. An area's ceiling is one of ${SpoolSubjectPermits.options
        .map((p) => `"${p}"`)
        .join(", ")}, or null to withdraw it.`,
    );
  }

  const areas = readAreas(paths);
  const found = areas.find((a) => a.name === trimmed);
  const next: SpoolArea = found
    ? { ...found }
    : { name: trimmed, created: capturedLabel(new Date()), schemaVersion: 1 };
  if (ceiling === null) delete next.ceiling;
  else next.ceiling = ceiling;

  writeAreas(paths, found ? areas.map((a) => (a.name === trimmed ? next : a)) : [...areas, next]);
  return next;
}

/**
 * AN AREA NAME IS A PATH — docs/spool-loops.md §13.7. "Work / Focaltec" is two
 * LABELS, never a structure the store maintains: one string on the subject,
 * split here on the canonical separator (" / "), each segment trimmed, empty
 * segments dropped (so "Work /  / Focaltec" and stray leading/trailing
 * separators degrade to the segments that actually say something rather than
 * throwing). Every other reader of a path — the ceiling clamp below, and any
 * future renderer of the same string — goes through this one function, so the
 * separator is stated in exactly one place.
 */
export function areaPathSegments(name: string): string[] {
  return name
    .split(" / ")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** Every prefix of a path, shallowest first — "Work / Focaltec / Q3" yields
 *  `["Work", "Work / Focaltec", "Work / Focaltec / Q3"]`. Built from the
 *  SEGMENTS, never a string `startsWith`, so "Workshop" can never match as a
 *  prefix of "Work / X": the boundary is the separator, not the character. */
function areaPathPrefixes(name: string): string[] {
  const segments = areaPathSegments(name);
  const prefixes: string[] = [];
  for (let i = 1; i <= segments.length; i++) {
    prefixes.push(segments.slice(0, i).join(" / "));
  }
  return prefixes;
}

export interface EffectivePermitsResult {
  /** What the subject may actually do, unattended — its own statement, or a
   *  ceiling below it. */
  level: SpoolSubjectPermits;
  /** The area path prefix whose ceiling produced `level`, present only when
   *  a ceiling actually lowered the subject's own statement. Absent means
   *  `level` is exactly the subject's own `permits` — nothing clamped it. */
  clampedBy?: string;
}

/**
 * WHAT A SUBJECT ACTUALLY PERMITS, UNATTENDED, AND WHY — its own statement,
 * clamped down its whole area PATH rather than by the exact area string.
 * "Work / Focaltec" is checked against every ceiling stated on "Work" AND on
 * "Work / Focaltec"; where more than one prefix carries a ceiling, the MOST
 * restrictive (lowest `PERMIT_RANK`) wins, same down-only law as ever. THE
 * ONE IMPLEMENTATION of the clamp: every path that enforces or reports a
 * permit level goes through here (via `effectivePermits` below), so "the
 * ceiling held on the map but not in the night" is a sentence that cannot
 * come true.
 *
 * DOWN ONLY. A ceiling above the subject's own permit never wins — a group
 * statement may restrict its members, never promote them. An unregistered
 * subject keeps its floor (`read`), same as `subjectPermits`.
 */
export function effectivePermitsDetail(
  subject: SpoolSubject | undefined,
  areas: readonly SpoolArea[],
): EffectivePermitsResult {
  const stated = subject?.permits ?? "read";
  if (!subject?.area) return { level: stated };

  let winner: { name: string; ceiling: SpoolSubjectPermits } | undefined;
  for (const prefix of areaPathPrefixes(subject.area)) {
    const ceiling = areas.find((a) => a.name === prefix)?.ceiling;
    if (!ceiling) continue;
    if (!winner || PERMIT_RANK[ceiling] < PERMIT_RANK[winner.ceiling]) winner = { name: prefix, ceiling };
  }
  if (!winner || PERMIT_RANK[winner.ceiling] >= PERMIT_RANK[stated]) return { level: stated };
  return { level: winner.ceiling, clampedBy: winner.name };
}

/** The level alone, for the many callers that only gate on it — the night's
 *  plan, the level check in `subjectPermits`. Callers that report the clamp
 *  to a human (the map, the permits face) want `effectivePermitsDetail`
 *  instead, so the sentence can name the prefix that actually won. */
export function effectivePermits(subject: SpoolSubject | undefined, areas: readonly SpoolArea[]): SpoolSubjectPermits {
  return effectivePermitsDetail(subject, areas).level;
}
