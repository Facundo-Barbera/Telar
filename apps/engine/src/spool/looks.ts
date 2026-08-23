/**
 * LOOKS — reconcile-on-look, the mechanism behind `docs/spool-loops.md` §4.
 *
 * Whenever the Spool has a reason to look at a subject's terrain — the user
 * arrives, a subject gets focused — it reads the world through `gh`, diffs
 * against its last recorded look, and files what changed as OBSERVATIONS in
 * plain sentences: "PR #420 merged since your last look."
 *
 * ── DETERMINISTIC AND MODEL-FREE, and that is the contract ──────────────────
 * Every sentence this file produces is composed by `observe`, a pure function
 * over two world states and the subject's items. No model reads or writes a
 * look. That is what makes an observation checkable: the two states that
 * produced it are both on disk.
 *
 * ── PULL ONLY ───────────────────────────────────────────────────────────────
 * No timer, no webhook, no background poll. `reconcileLook` runs when a route
 * a human's arrival called asks it to, and never otherwise. The world never
 * interrupts; the Spool glances when it sits down, the way a person would.
 *
 * ── FAILURE IS AN ANSWER, NEVER A THROW ─────────────────────────────────────
 * `gh` failing — offline, signed out, rate-limited — returns the STALE look
 * with an honest `error` naming why it is stale. A room that comes down
 * because the network did is worse than a room that says "looked yesterday,
 * could not look now".
 *
 * ── THE CLOCK LAW, applied ──────────────────────────────────────────────────
 * `lastLookedAt` and `seenAt` are real stamps and are required — freshness is
 * the whole point. They are agent-facing. What a surface quotes is the LABEL
 * beside each ("looked Sat 07:40"), with attribution, which §3.2 permits. No
 * ordering, urgency or colour is ever derived from either.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  SpoolLook,
  type SpoolItem,
  type SpoolLane,
  type SpoolLookDigestLine,
  type SpoolLookOutcome,
  type SpoolLookRef,
  type SpoolObservation,
  type SpoolObservationRef,
  type SpoolSubject,
} from "@telar/engine-client";
import { atomicWrite } from "../atomic";
import { classifyGhFailure, type GhResult } from "../github";
import { capturedLabel, type SpoolPaths } from "./store";
import { isAddressableKey } from "./subjects";

const LOOK_FILE = "look.json";

/**
 * BESIDE THE DIGEST AND THE THREADS, under the subject's own directory, and it
 * asks `isAddressableKey` rather than re-spelling the rule — a subject that
 * cannot have a digest cannot have a look either, by construction.
 */
export function lookPath(paths: SpoolPaths, subject: string): string {
  if (!isAddressableKey(subject)) {
    throw new Error(
      `"${subject}" is not a subject name this store can address on disk. A subject's look lives at ` +
        `spool/experts/<key>/look.json, so the name has to be a plain slug — letters, digits, "_", "." or "-".`,
    );
  }
  return path.join(paths.root, "experts", subject, LOOK_FILE);
}

/** `null` on absent or unreadable — never a throw. A subject nothing has looked
 *  at is the ordinary first state, and an unreadable look is re-derivable on
 *  the next look (its observations are the diff's output, not human input). */
export function readLook(paths: SpoolPaths, subject: string): SpoolLook | null {
  try {
    return SpoolLook.parse(JSON.parse(fs.readFileSync(lookPath(paths, subject), "utf8")));
  } catch {
    return null;
  }
}

export function writeLook(paths: SpoolPaths, look: SpoolLook): SpoolLook {
  const parsed = SpoolLook.parse({ ...look, schemaVersion: 1 });
  const file = lookPath(paths, parsed.subject);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, parsed);
  return parsed;
}

/**
 * THE INJECTABLE SEAM, exactly `GhRunner`'s shape minus the cwd — a look
 * addresses its repository with `-R owner/name`, so it runs from nowhere in
 * particular. Tests inject one and never shell out.
 */
export type LookRunner = (args: string[]) => Promise<GhResult>;

const newObservationId = () => `o-${crypto.randomBytes(6).toString("hex")}`;

/** What one `gh … list --json` call asks for. Issues and pulls share the base
 *  set; pulls add the review decision, which is the diffable review fact. */
const ISSUE_FIELDS = "number,title,state,updatedAt,url,milestone,assignees,author";
const PULL_FIELDS = `${ISSUE_FIELDS},reviewDecision`;

/**
 * `--state all` BECAUSE THE DIFF NEEDS THE CLOSED ONES. "PR #420 merged since
 * your last look" is only derivable if a merged PR still appears in the fresh
 * world state; a list of open things can only ever say what appeared.
 * `--limit` keeps one look from paging a tracker with years of history — the
 * diff is about what MOVED, and anything past a couple hundred rows moved so
 * long ago the baseline already holds it.
 */
export function lookArgs(repo: string): { issues: string[]; pulls: string[] } {
  return {
    issues: ["issue", "list", "-R", repo, "--state", "all", "--limit", "200", "--json", ISSUE_FIELDS],
    pulls: ["pr", "list", "-R", repo, "--state", "all", "--limit", "100", "--json", PULL_FIELDS],
  };
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** `gh` nests author and assignees; only the login is stable enough to keep. */
const login = (value: unknown): string | undefined => {
  const name = text((value as { login?: unknown } | null)?.login);
  return name || undefined;
};

/** One `gh … list --json` payload, folded to the shape the diff reads. Rows
 *  with no number are dropped — a ref that cannot be addressed cannot be
 *  observed about. */
export function parseWorldRows(kind: "issue" | "pull", stdout: string): SpoolLookRef[] {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const refs: SpoolLookRef[] = [];
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    if (typeof record.number !== "number") continue;
    refs.push({
      kind,
      number: record.number,
      title: text(record.title),
      state: text(record.state),
      updatedAt: text(record.updatedAt),
      ...(text(record.url) ? { url: text(record.url) } : {}),
      ...(text((record.milestone as { title?: unknown } | null)?.title)
        ? { milestone: text((record.milestone as { title?: unknown }).title) }
        : {}),
      assignees: Array.isArray(record.assignees)
        ? record.assignees.map(login).filter((l): l is string => l !== undefined)
        : [],
      ...(login(record.author) ? { author: login(record.author) } : {}),
      ...(kind === "pull" && text(record.reviewDecision) ? { reviewDecision: text(record.reviewDecision) } : {}),
    });
  }
  return refs;
}

export type WorldState = { issues: SpoolLookRef[]; pulls: SpoolLookRef[] };

/** An observation before the store stamps it — text plus what it points at. */
export type ObservedDelta = { text: string; refs: SpoolObservationRef[] };

const refOf = (row: SpoolLookRef): SpoolObservationRef => ({
  kind: row.kind,
  number: row.number,
  ...(row.url ? { url: row.url } : {}),
  ...(row.title ? { title: row.title } : {}),
});

/**
 * THE DIFF — pure, and the whole grammar of what the Spool may say lives here.
 *
 * It notices DELTAS, NOT ACTORS: a change made by the user, by a session, or
 * by a teammate reads identically, which is loop 4 falling out of loop 1 for
 * free. And it reads the subject's own items too: an issue the user files as
 * a mirrored item gets its tie-back said out loud, because "the thing you are
 * tracking closed" is the sentence the whole mechanism exists for.
 */
export function observe(prev: WorldState, next: WorldState, items: readonly SpoolItem[] = []): ObservedDelta[] {
  const deltas: ObservedDelta[] = [];

  /** The item the user files a foreign number under, when one exists. The
   *  match is on the mirrored ref's own spelling ("#412"), bounded so #41
   *  never claims #412's movement. */
  const filedAs = (number: number): SpoolItem | undefined =>
    items.find((item) => item.mirrored && new RegExp(`#${number}(?!\\d)`).test(item.mirrored));

  const tie = (number: number): string => {
    const item = filedAs(number);
    return item ? ` You file it as "${item.title}".` : "";
  };

  const prevIssues = new Map(prev.issues.map((row) => [row.number, row]));
  for (const row of next.issues) {
    const before = prevIssues.get(row.number);
    if (!before) {
      if (row.state !== "OPEN") continue; // ancient history arriving in the window is not news
      const opener = row.author ?? "Someone";
      const milestone = row.milestone ? ` and added it to ${row.milestone}` : "";
      const unassigned = row.assignees.length === 0 ? " It's unassigned." : "";
      deltas.push({ text: `${opener} opened #${row.number} ("${row.title}")${milestone}.${unassigned}`, refs: [refOf(row)] });
      continue;
    }
    if (before.state === "OPEN" && row.state === "CLOSED") {
      deltas.push({ text: `#${row.number} closed since your last look.${tie(row.number)}`, refs: [refOf(row)] });
    } else if (before.state === "CLOSED" && row.state === "OPEN") {
      deltas.push({ text: `#${row.number} was reopened since your last look.${tie(row.number)}`, refs: [refOf(row)] });
    }
  }

  const prevPulls = new Map(prev.pulls.map((row) => [row.number, row]));
  for (const row of next.pulls) {
    const before = prevPulls.get(row.number);
    if (!before) {
      if (row.state === "MERGED") {
        deltas.push({
          text: `PR #${row.number} ("${row.title}") was opened and merged since your last look.${tie(row.number)}`,
          refs: [refOf(row)],
        });
      } else if (row.state === "OPEN") {
        deltas.push({ text: `${row.author ?? "Someone"} opened PR #${row.number} ("${row.title}").`, refs: [refOf(row)] });
      }
      continue;
    }
    if (before.state === "OPEN" && row.state === "MERGED") {
      deltas.push({ text: `PR #${row.number} merged since your last look.${tie(row.number)}`, refs: [refOf(row)] });
    } else if (before.state === "OPEN" && row.state === "CLOSED") {
      deltas.push({ text: `PR #${row.number} was closed without merging.`, refs: [refOf(row)] });
    } else if (before.state === "OPEN" && row.state === "OPEN" && before.reviewDecision !== row.reviewDecision) {
      // The review facts `gh` can actually attest. Anything subtler — WHO
      // reviewed, what they said — belongs to a session that goes and reads,
      // not to a diff of two list calls.
      if (row.reviewDecision === "CHANGES_REQUESTED") {
        deltas.push({ text: `PR #${row.number} got review comments.${tie(row.number)}`, refs: [refOf(row)] });
      } else if (row.reviewDecision === "APPROVED") {
        deltas.push({ text: `PR #${row.number} was approved.${tie(row.number)}`, refs: [refOf(row)] });
      }
    }
  }

  return deltas;
}

/** The no-terrain sentence, minted in one place so every route says it the
 *  same way. It is a NOTE, not an error — the no-code test. */
const NO_TERRAIN = (subject: string) =>
  `"${subject}" has no terrain — there is nowhere to look. That is an ordinary state, not a fault; tell the Spool where the subject lives if there is somewhere.`;

/** A stored look as an outcome — the GET shape, no `gh` run, honest about it
 *  via `fresh: false`. */
export function storedLookOutcome(paths: SpoolPaths, subject: SpoolSubject): SpoolLookOutcome {
  const look = isAddressableKey(subject.key) ? readLook(paths, subject.key) : null;
  return {
    subject: subject.key,
    ...(subject.terrain ? { terrain: subject.terrain } : {}),
    ...(look ? { look } : {}),
    fresh: false,
    ...(subject.terrain ? {} : { note: NO_TERRAIN(subject.key) }),
  };
}

/**
 * RECONCILE NOW — read the terrain, diff, record, answer.
 *
 * ── THE FIRST LOOK IS A BASELINE, NOT A FLOOD ───────────────────────────────
 * With no prior look there is nothing to diff against, and pretending the
 * whole tracker is "new" would open 29 spurious observations on a project the
 * user has been living in for months. So the first look records the world and
 * says exactly one thing: baseline recorded, and how big the world was.
 *
 * ── OBSERVATIONS APPEND; THE WORLD REPLACES ─────────────────────────────────
 * The world state is a cache of the tracker's answer and the next look
 * rewrites it wholesale — that is what a baseline is. Observations are the
 * record of what the Spool told the human and only ever grow or drain.
 */
export async function reconcileLook(
  paths: SpoolPaths,
  subject: SpoolSubject,
  deps: { run: LookRunner; items?: readonly SpoolItem[]; now?: Date },
): Promise<SpoolLookOutcome> {
  const terrain = subject.terrain;
  if (!terrain) return storedLookOutcome(paths, subject);

  const stored = readLook(paths, subject.key) ?? undefined;
  const stale = (error: string): SpoolLookOutcome => ({
    subject: subject.key,
    terrain,
    ...(stored ? { look: stored } : {}),
    fresh: false,
    error,
  });

  const args = lookArgs(terrain.repo);
  const [issues, pulls] = await Promise.all([deps.run(args.issues), deps.run(args.pulls)]);
  const failed = [issues, pulls].find((result) => result.status !== 0);
  if (failed) {
    const { unavailable, message } = classifyGhFailure(failed);
    const why =
      unavailable === "not_installed"
        ? "the `gh` CLI is not installed on this machine"
        : unavailable === "not_authenticated"
          ? "`gh` is not signed in — run `gh auth login`"
          : (message ?? "gh failed without saying why");
    return stale(`Could not look at ${terrain.repo}: ${why}. Showing the last recorded look instead.`);
  }

  const world: WorldState = {
    issues: parseWorldRows("issue", issues.stdout),
    pulls: parseWorldRows("pull", pulls.stdout),
  };
  const at = deps.now ?? new Date();
  const label = capturedLabel(at);
  const stamp = (delta: ObservedDelta): SpoolObservation => ({
    id: newObservationId(),
    text: delta.text,
    refs: delta.refs,
    seen: label,
    seenAt: at.getTime(),
  });

  const openCount = (rows: SpoolLookRef[]) => rows.filter((row) => row.state === "OPEN").length;
  const look = writeLook(
    paths,
    stored
      ? {
          ...stored,
          lastLooked: label,
          lastLookedAt: at.getTime(),
          world,
          observations: [...stored.observations, ...observe(stored.world, world, deps.items ?? []).map(stamp)],
        }
      : {
          subject: subject.key,
          schemaVersion: 1,
          lastLooked: label,
          lastLookedAt: at.getTime(),
          world,
          observations: [
            stamp({
              text: `First look at ${terrain.repo} — baseline recorded: ${openCount(world.issues)} open issue${
                openCount(world.issues) === 1 ? "" : "s"
              }, ${openCount(world.pulls)} open pull request${openCount(world.pulls) === 1 ? "" : "s"}.`,
              refs: [],
            }),
          ],
        },
  );

  return { subject: subject.key, terrain, look, fresh: true };
}

/**
 * "NOTED" — the drain verb. Marks the observation acknowledged and keeps it;
 * nothing here deletes, and re-noting an already-noted line is the same state
 * stated twice, not an error. `null` when the subject has no look or no
 * observation goes by the id, so a caller can say so.
 */
/**
 * THE MOVEMENT DIGEST — compress-never-multiply applied to observations.
 *
 * PURE AND DETERMINISTIC, like `observe` above and for the same contract: no
 * model reads or writes a digest line, so every line is checkable against the
 * observations it stands for — which travel with it as `observationIds`, the
 * handle "noted" drains the whole group by.
 *
 * ── THE GROUPING RULE ───────────────────────────────────────────────────────
 * An observation joins a LANE's group when its refs resolve — through the same
 * mirrored-ref match `observe`'s tie-back uses — to items that all sit in ONE
 * lane's stack. Everything else (no refs, unresolved refs, refs across lanes)
 * folds into one residual line for the subject. ONE LINE PER GROUP, always:
 * "Hito 1 · Agosto — 8 PRs merged, 7 issues closed", never eight rows and
 * seven rows. Compressing is the point; a digest that multiplied would be the
 * disease wearing the cure's name.
 *
 * Acknowledged observations are already drained and appear in no line.
 */
export function digestObservations(
  look: SpoolLook,
  lanes: readonly SpoolLane[],
  items: readonly SpoolItem[],
): SpoolLookDigestLine[] {
  const pending = look.observations.filter((observation) => !observation.acknowledged);
  if (pending.length === 0) return [];

  const laneOfItem = (itemId: string): SpoolLane | undefined => lanes.find((lane) => lane.items.includes(itemId));
  const laneOfObservation = (observation: SpoolObservation): SpoolLane | undefined => {
    if (observation.refs.length === 0) return undefined;
    const keys = new Set<string>();
    for (const ref of observation.refs) {
      const filed = items.find((item) => item.mirrored && new RegExp(`#${ref.number}(?!\\d)`).test(item.mirrored));
      const lane = filed ? laneOfItem(filed.id) : undefined;
      if (!lane) return undefined; // an unresolved ref keeps the whole observation residual
      keys.add(lane.key);
    }
    return keys.size === 1 ? lanes.find((lane) => lane.key === [...keys][0]) : undefined;
  };

  /** What one observation IS, read off the deterministic sentences `observe`
   *  composes — never off free prose, because nothing else writes these. */
  const categoryOf = (observation: SpoolObservation): { singular: string; plural: string } => {
    const text = observation.text;
    const pull = /\bPR #\d/.test(text);
    if (pull && /merged/.test(text) && !/without merging/.test(text)) return { singular: "PR merged", plural: "PRs merged" };
    if (pull && /closed without merging/.test(text)) return { singular: "PR closed without merging", plural: "PRs closed without merging" };
    if (pull && /approved/.test(text)) return { singular: "PR approved", plural: "PRs approved" };
    if (pull && /review comments/.test(text)) return { singular: "PR with review comments", plural: "PRs with review comments" };
    if (pull && /opened/.test(text)) return { singular: "PR opened", plural: "PRs opened" };
    if (/reopened/.test(text)) return { singular: "issue reopened", plural: "issues reopened" };
    if (/closed/.test(text)) return { singular: "issue closed", plural: "issues closed" };
    if (/opened/.test(text)) return { singular: "issue opened", plural: "issues opened" };
    return { singular: "note", plural: "notes" };
  };

  type Group = { label: string; observations: SpoolObservation[] };
  const byLane = new Map<string, Group>();
  const residual: Group = { label: look.subject, observations: [] };
  for (const observation of pending) {
    const lane = laneOfObservation(observation);
    if (!lane) {
      residual.observations.push(observation);
      continue;
    }
    const group = byLane.get(lane.key) ?? { label: lane.label, observations: [] };
    group.observations.push(observation);
    byLane.set(lane.key, group);
  }

  const line = (group: Group): SpoolLookDigestLine => {
    const counts = new Map<string, { n: number; singular: string; plural: string }>();
    for (const observation of group.observations) {
      const category = categoryOf(observation);
      const entry = counts.get(category.plural) ?? { n: 0, ...category };
      entry.n += 1;
      counts.set(category.plural, entry);
    }
    const parts = [...counts.values()].map((entry) => `${entry.n} ${entry.n === 1 ? entry.singular : entry.plural}`);
    return {
      text: `${group.label} — ${parts.join(", ")}`,
      observationIds: group.observations.map((observation) => observation.id),
    };
  };

  // Lane groups in the lanes' own order — the user's structure, never a rank —
  // and the residual line last.
  const lines: SpoolLookDigestLine[] = [];
  for (const lane of lanes) {
    const group = byLane.get(lane.key);
    if (group) lines.push(line(group));
  }
  if (residual.observations.length > 0) lines.push(line(residual));
  return lines;
}

export function acknowledgeObservation(paths: SpoolPaths, subject: string, observationId: string): SpoolLook | null {
  const stored = readLook(paths, subject);
  if (!stored) return null;
  const found = stored.observations.find((observation) => observation.id === observationId);
  if (!found) return null;
  return writeLook(paths, {
    ...stored,
    observations: stored.observations.map((observation) =>
      observation.id === observationId ? { ...observation, acknowledged: true } : observation,
    ),
  });
}
