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
 * effective = min(subject.permits, area.ceiling) in `SpoolSubjectPermits`'
 * ordering (the `RANK` table in `subjects.ts`, the one place the enum is
 * ordered). No ceiling means no clamp, and a ceiling above a subject's own
 * permit changes nothing — a group statement may only ever restrict.
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
 * WHAT A SUBJECT ACTUALLY PERMITS, UNATTENDED — its own statement, clamped by
 * its area's ceiling. THE ONE IMPLEMENTATION of the clamp: every path that
 * enforces or reports a permit level goes through here, so "the ceiling held
 * on the map but not in the night" is a sentence that cannot come true.
 *
 * DOWN ONLY. A ceiling above the subject's own permit returns the subject's
 * own permit — a group statement may restrict its members, never promote them.
 * An unregistered subject keeps its floor (`read`), same as `subjectPermits`.
 */
export function effectivePermits(subject: SpoolSubject | undefined, areas: readonly SpoolArea[]): SpoolSubjectPermits {
  const stated = subject?.permits ?? "read";
  const ceiling = subject?.area ? areas.find((a) => a.name === subject.area)?.ceiling : undefined;
  if (!ceiling) return stated;
  return PERMIT_RANK[ceiling] < PERMIT_RANK[stated] ? ceiling : stated;
}
