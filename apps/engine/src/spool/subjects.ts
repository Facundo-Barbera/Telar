/**
 * SUBJECTS — the thing an item is ABOUT, and the thing an expert belongs to.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * `SpoolItem.project` was a free-form string, which left the module with ONE
 * noun doing three jobs: the fragment you dumped, the work you would sit down
 * and do, and — with nowhere else to put them — facts about a project's shape.
 *
 * The third job is not hypothetical. `hito 1 cierra en dos semanas` is on the
 * desk AS AN ITEM: a milestone's closing date, which is not a piece of work. A
 * drafting pass over it spent all five of its questions asking for the record
 * type that did not exist — does the milestone exist as a record, how do I reach
 * the tracker, what counts as a dependency edge, who is the stakeholder, is the
 * count live.
 *
 * ── WHAT IT DELIBERATELY IS NOT ──────────────────────────────────────────────
 * NOT an extension of Telar's `Project`. That record is wired through sessions,
 * worktrees and git; making it repo-optional would put a branch through all of
 * it — the argument `master-chat.tsx` already records for refusing to make the
 * cockpit project-optional. A subject REFERENCES a project when it has a
 * checkout, and the polarity is the point: a checkout is something a subject
 * HAS, never what a subject IS. School and a client engagement are subjects with
 * none, and that is the ordinary case rather than a degraded one.
 *
 * NOT a plan. §9's second open question is settled — a plan is a record OF a
 * subject, populated by a tracker where one exists and required by none. This
 * file holds no milestone, no edge and no date, and must not grow one.
 *
 * ── AND THE ITEM SHAPE DOES NOT CHANGE ───────────────────────────────────────
 * `item.project` already holds the slug; it stops being a bare label and becomes
 * a reference to `SpoolSubject.key`. So there is no packet migration and no
 * `SPOOL_ITEM_SCHEMA_VERSION` bump — the migration is `deriveSubjects` below,
 * a one-way read of what is already on disk.
 */
import fs from "node:fs";
import path from "node:path";
import { SpoolSubject, SpoolSubjectColor, SpoolTerrain, type SpoolSubjectPermits } from "@telar/engine-client";
import { atomicWrite } from "../atomic";
import { capturedLabel, listItems, type SpoolPaths } from "./store";

const SUBJECTS_FILE = "subjects.json";

export function subjectsPath(paths: SpoolPaths): string {
  return path.join(paths.root, SUBJECTS_FILE);
}

/**
 * THE SAME GUARD `expertDigestDir` APPLIES, asked of the same rule rather than
 * re-spelled beside it. A subject's key is a directory name under `experts/`,
 * so a key this store cannot address is a subject whose memory has nowhere to
 * live — and the two must agree by construction, not by care.
 */
export function isAddressableKey(key: unknown): key is string {
  return typeof key === "string" && /^[A-Za-z0-9_.-]+$/.test(key) && !key.startsWith(".");
}

/**
 * TOLERANT PER ROW, exactly like `readLanes` and for the same stated reason: a
 * human who hand-edits this file and breaks ONE row must not lose every subject.
 * A row that cannot be made sense of is skipped; the rest survive.
 */
export function readSubjects(paths: SpoolPaths): SpoolSubject[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(subjectsPath(paths), "utf8"));
  } catch {
    // Never written is the ordinary first-run state, not an error.
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const subjects: SpoolSubject[] = [];
  for (const row of raw) {
    const parsed = SpoolSubject.safeParse(row);
    if (!parsed.success) continue;
    // A row whose key cannot be addressed would hand every downstream caller a
    // path that throws. Dropping it here keeps that impossible.
    if (!isAddressableKey(parsed.data.key)) continue;
    if (subjects.some((s) => s.key === parsed.data.key)) continue;
    subjects.push(parsed.data);
  }
  return subjects;
}

export function writeSubjects(paths: SpoolPaths, subjects: SpoolSubject[]): SpoolSubject[] {
  const parsed = subjects.map((s) => SpoolSubject.parse(s));
  atomicWrite(subjectsPath(paths), parsed);
  return parsed;
}

export function findSubject(paths: SpoolPaths, key: string): SpoolSubject | undefined {
  return readSubjects(paths).find((s) => s.key === key);
}

/**
 * Get the subject, or register it.
 *
 * AUTO-REGISTERING IS NOT AN AGENT INVENTING WORK. The human typed the name onto
 * an item; this records that a subject by that name exists. "Compress, never
 * multiply" is a law about the QUEUE's count, and no item is created here.
 *
 * `draft` IS THE DEFAULT BECAUSE IT IS TODAY'S BEHAVIOUR. Every subject is
 * currently ripened and drafted for, so defaulting lower would change what the
 * night does the moment this lands, silently, which is the one thing a
 * migration must not do.
 */
export function ensureSubject(
  paths: SpoolPaths,
  key: string,
  seed: { name?: string; projectId?: string; permits?: SpoolSubjectPermits } = {},
): SpoolSubject {
  if (!isAddressableKey(key)) {
    throw new Error(
      `"${key}" is not a subject name this store can address on disk. A subject's memory lives at ` +
        `spool/experts/<key>/digest.json, so the name has to be a plain slug — letters, digits, "_", "." or "-".`,
    );
  }
  const subjects = readSubjects(paths);
  const found = subjects.find((s) => s.key === key);
  if (found) return found;

  const created: SpoolSubject = {
    key,
    name: seed.name ?? key,
    ...(seed.projectId ? { projectId: seed.projectId } : {}),
    permits: seed.permits ?? "draft",
    created: capturedLabel(new Date()),
    schemaVersion: 1,
  };
  writeSubjects(paths, [...subjects, created]);
  return created;
}

/**
 * WHAT THIS ASSISTANT MAY DO HERE, UNATTENDED. The one field a human sets, and
 * the one that gates the night — see `planNight`.
 */
export function setSubjectPermits(paths: SpoolPaths, key: string, permits: SpoolSubjectPermits): SpoolSubject | null {
  const subjects = readSubjects(paths);
  const found = subjects.find((s) => s.key === key);
  if (!found) return null;
  const next = { ...found, permits };
  writeSubjects(
    paths,
    subjects.map((s) => (s.key === key ? next : s)),
  );
  return next;
}

/**
 * THE ONE PLACE A REPO NAME IS EVER VALIDATED, because it is the one string in
 * this record that later reaches a `gh` argv. `execFile` already makes shell
 * injection impossible; what this guards against is a name that `gh` would
 * read as a FLAG (a leading `-`) or that is not an address at all. Loud, like
 * every write-side guard in the store.
 */
export function isRepoAddress(repo: unknown): repo is string {
  return typeof repo === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repo);
}

/**
 * SAY WHERE A SUBJECT LIVES — or that it lives nowhere the Spool can reach.
 *
 * `null` CLEARS. Terrain is configuration the human states, like `permits`
 * beside it — correcting or withdrawing a statement about where a subject
 * lives is not a deletion path, any more than lowering `permits` is. What the
 * looks produced from a former terrain stays: `look.json` is never touched
 * here.
 *
 * Returns `null` (writes nothing) when no subject goes by the key; THROWS a
 * sentence on a terrain the store must not hold — a write is loud.
 */
export function setSubjectTerrain(paths: SpoolPaths, key: string, terrain: SpoolTerrain | null): SpoolSubject | null {
  if (terrain !== null) {
    const parsed = SpoolTerrain.safeParse(terrain);
    if (!parsed.success) {
      throw new Error(
        'A terrain is `{ kind: "github-repo", repo: "owner/name" }` with an optional `notes`. ' +
          "Nothing else is a place the Spool knows how to look yet.",
      );
    }
    if (!isRepoAddress(parsed.data.repo)) {
      throw new Error(
        `"${String(parsed.data.repo)}" is not a repository address. A terrain's repo is \`owner/name\` — ` +
          "plain slugs on both sides of one slash — because it goes into a `gh -R` argument verbatim.",
      );
    }
    terrain = parsed.data;
  }
  const subjects = readSubjects(paths);
  const found = subjects.find((s) => s.key === key);
  if (!found) return null;
  const next: SpoolSubject = { ...found };
  if (terrain === null) delete next.terrain;
  else next.terrain = terrain;
  writeSubjects(
    paths,
    subjects.map((s) => (s.key === key ? next : s)),
  );
  return next;
}

/** Long enough for any name a human would say out loud ("Clientes de la
 *  agencia"), short enough that a pasted paragraph is refused as the mistake
 *  it is. */
export const SUBJECT_AREA_MAX = 60;

/**
 * SAY WHOSE A SUBJECT IS — its `area` (the user's own group name, Reminders'
 * list-groups), its `color` (an identity token, Calendar's per-calendar hue),
 * and its `rank` (the user's own manual position among the other subjects in
 * that SAME area — the drag order a rail lets a person set by hand).
 *
 * IDENTITY, NEVER STATE. Nothing here reads or implies urgency, and the color
 * set is closed so nothing ever can — see `SpoolSubjectColor`. All three
 * fields are configuration the human states, exactly like `terrain` above:
 * `null` clears (a withdrawn statement, not a deletion), absent leaves
 * untouched, and a subject with none of them is fully ordinary.
 *
 * SETTING `area` NEVER TOUCHES `rank`. Moving a subject into a new area does
 * not erase where a hand had already put it — a rank is filed as its own
 * statement (its own key in `patch`), the same way stating `color` here never
 * clears `area`.
 *
 * Returns `null` (writes nothing) when no subject goes by the key; THROWS a
 * sentence on a value the store must not hold — a write is loud.
 */
export function setSubjectIdentity(
  paths: SpoolPaths,
  key: string,
  patch: { area?: string | null; color?: SpoolSubjectColor | null; rank?: number | null },
): SpoolSubject | null {
  if (!("area" in patch) && !("color" in patch) && !("rank" in patch)) {
    throw new Error("Name what to change — an `area`, a `color`, a `rank`, or any combination. `null` clears any of them.");
  }
  let area: string | null | undefined = patch.area;
  if (typeof area === "string") {
    area = area.trim();
    if (!area) {
      throw new Error("An area is a name — a word or two in the user's own vocabulary, like \"Trabajo\". Pass `null` to clear it instead of an empty string.");
    }
    if (area.length > SUBJECT_AREA_MAX) {
      throw new Error(
        `That area name is ${area.length} characters. An area is a short group name — "Trabajo", "Personal" — so the store caps it at ${SUBJECT_AREA_MAX}.`,
      );
    }
  } else if (area !== null && area !== undefined) {
    throw new Error('An area is a short name in the user\'s own words ("Trabajo"), or `null` to clear it.');
  }
  if (patch.color !== null && patch.color !== undefined && !SpoolSubjectColor.safeParse(patch.color).success) {
    throw new Error(
      `"${String(patch.color)}" is not a color the Spool knows. A subject's color is one of ${SpoolSubjectColor.options
        .map((c) => `"${c}"`)
        .join(", ")} — a named identity token, never a hex value, and never a signal of urgency.`,
    );
  }
  if (patch.rank !== null && patch.rank !== undefined && (typeof patch.rank !== "number" || !Number.isFinite(patch.rank) || patch.rank < 0)) {
    throw new Error(
      `"${String(patch.rank)}" is not a rank the Spool can hold. A subject's rank is a finite number ≥ 0 — its ` +
        "manual position among the other subjects in its area — or `null` to withdraw it.",
    );
  }
  const subjects = readSubjects(paths);
  const found = subjects.find((s) => s.key === key);
  if (!found) return null;
  const next: SpoolSubject = { ...found };
  if ("area" in patch) {
    if (area === null) delete next.area;
    else if (area !== undefined) next.area = area;
  }
  if ("color" in patch) {
    if (patch.color === null) delete next.color;
    else if (patch.color !== undefined) next.color = patch.color;
  }
  if ("rank" in patch) {
    if (patch.rank === null) delete next.rank;
    else if (patch.rank !== undefined) next.rank = patch.rank;
  }
  writeSubjects(
    paths,
    subjects.map((s) => (s.key === key ? next : s)),
  );
  return next;
}

/**
 * A SUBJECT'S ORDER WITHIN ITS OWN AREA — `rank` ascending, unranked subjects
 * AFTER every ranked one, in whatever order they already carried. STABLE, and
 * silent when nothing has stated a rank: the comparator returns `0` for any
 * pair that is not two ranked-or-unranked subjects of the SAME named area, so
 * a caller that never sets `rank` sees exactly the order it handed in — this
 * function never invents one.
 *
 * WORKS ACROSS BOTH SHAPES `rank` RIDES ON — `SpoolSubject` (the registry) and
 * `SpoolLobbySubject` (the lobby's per-card projection) — because the fact it
 * orders by is the same fact on both, `area` and `rank` verbatim, and the two
 * callers (`EngineStore.spoolSubjects`, `composeLobby`) would otherwise hand-rebuild
 * the identical four-way branch.
 */
export function sortSubjectsByRank<T extends { area?: string; rank?: number }>(subjects: readonly T[]): T[] {
  return [...subjects].sort((a, b) => {
    if (!a.area || !b.area || a.area !== b.area) return 0;
    const ar = typeof a.rank === "number" ? a.rank : undefined;
    const br = typeof b.rank === "number" ? b.rank : undefined;
    if (ar === undefined && br === undefined) return 0;
    if (ar === undefined) return 1;
    if (br === undefined) return -1;
    return ar - br;
  });
}

/**
 * THE ONE ORDERING OF THE PERMIT ENUM, floor-to-ceiling. Every comparison in
 * the module — the level gate below and the area clamp in `areas.ts` — reads
 * this table rather than spelling out a chain of string equality that drifts
 * when a level lands. Exported for exactly those two readers.
 */
export const PERMIT_RANK: Record<SpoolSubjectPermits, number> = { read: 0, draft: 1, propose: 2 };

/**
 * May this subject be worked at the named level?
 *
 * AN UNREGISTERED SUBJECT IS TREATED AS ITS FLOOR RATHER THAN AS FORBIDDEN. A
 * name nothing has registered yet is the state every item was in before this
 * record existed, and refusing outright would make the migration's own gap look
 * like a policy decision the user never made.
 *
 * COMPARES THE EFFECTIVE LEVEL, NOT THE STATED ONE. Callers pass the answer of
 * `effectivePermits` (subjects clamped by their area's ceiling); a bare
 * `subject?.permits` here would be the one enforcement path the ceiling never
 * reached.
 */
export function subjectPermits(held: SpoolSubjectPermits, level: SpoolSubjectPermits): boolean {
  return PERMIT_RANK[held] >= PERMIT_RANK[level];
}

/**
 * THE MIGRATION — one way, idempotent, and it touches no packet.
 *
 * Reads the distinct `project` values off the items already on disk and
 * registers any that have no subject yet. An item with NO project is floating,
 * which is a resting state and not a subject: "floating" is a rendering of
 * absence (`item.project ?? "floating"` in three surfaces), never a stored
 * value, and a subject by that name would be this migration inventing one.
 *
 * A name the store cannot address is SKIPPED rather than thrown on. Such an item
 * already cannot have an expert — `runExpertPass` refuses it by the same rule —
 * so failing the whole migration over one would make an existing, reported
 * condition into a startup crash.
 */
export function deriveSubjects(
  paths: SpoolPaths,
  registered: Array<{ id: string; name: string }> = [],
): { created: SpoolSubject[]; skipped: string[] } {
  const existing = new Set(readSubjects(paths).map((s) => s.key));
  const skipped: string[] = [];
  const created: SpoolSubject[] = [];

  const keys: string[] = [];
  for (const item of listItems(paths).items) {
    const key = item.project;
    if (!key || keys.includes(key) || existing.has(key)) continue;
    if (!isAddressableKey(key)) {
      if (!skipped.includes(key)) skipped.push(key);
      continue;
    }
    keys.push(key);
  }

  for (const key of keys) {
    // A subject whose name matches a registered project gets the link, so
    // `aurora` (no checkout) and `ozom-gv` (one) differ from the first write
    // rather than after someone notices.
    const project = registered.find((p) => p.name === key);
    created.push(ensureSubject(paths, key, project ? { projectId: project.id } : {}));
  }
  return { created, skipped };
}
