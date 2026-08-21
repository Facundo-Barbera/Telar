import type { Classification, Loom, LoomOverview, LoomState, TriageEntry } from "@telar/engine-client";

/**
 * THE DECK'S ORDERING, AS A PURE FUNCTION.
 *
 * The page is ordered by WHAT THE HUMAN MUST DO, not by what the engine finds
 * interesting: blocked on a person, then the deliverable, then what is in
 * flight, then the durable classification of everything seen and not taken.
 * Putting that ordering in a function rather than in JSX is what lets the test
 * below it assert the property that actually matters — every `LoomState` lands
 * in exactly one section, so no state can be added upstream and quietly vanish
 * from the surface.
 *
 * NOTHING HERE KNOWS WHAT A TRACKER IS. An `item` is a string the project's own
 * `list` command produced. It is not an issue, it has no number, and it has no
 * labels; treating it as one is the mistake this whole design exists to avoid.
 */

/** Alive and being advanced by machinery. Fast poll while any of these exist. */
export const IN_FLIGHT_STATES: readonly LoomState[] = ["queued", "working", "gating", "publishing", "stuck"];
/** Done, one way or another. Nothing will move these without a human. */
export const TERMINAL_STATES: readonly LoomState[] = ["published", "parked", "cancelled"];

export type NeedsYouRow =
  | { kind: "loom"; key: string; loom: Loom; projectId: string; question: string }
  | { kind: "assumed"; key: string; projectId: string; projectName: string; assumption: string };

export type ProjectGroup = { projectId: string; name: string; looms: Loom[] };

export type SeenGroup = {
  classification: Classification;
  /** What this pile IS, in the human's words. */
  label: string;
  entries: TriageEntry[];
};

export type DeckSections = {
  needsYou: NeedsYouRow[];
  review: Loom[];
  working: ProjectGroup[];
  seen: SeenGroup[];
  /** Looms that stopped with a written reason. Not silent, not in flight. */
  closed: Loom[];
  /** True while anything is being advanced — the fast-cadence flag. */
  active: boolean;
};

/**
 * The order the piles are read in, and the words that name each one.
 *
 * THE MIDDLE THREE ARE THE FINDING. In the repo this design was tested against,
 * 4 of 37 items were dispatchable and nothing in the tracker distinguished the
 * other 33 — so the classification is the product, and this pane is where it is
 * delivered. Each pile gets a LABEL and nothing else: the paragraph that used
 * to explain why a pile is an asset rather than an error list was the designer
 * justifying himself inside the UI. The reasoning lives in
 * `docs/plans/loom-build.md`.
 */
const CLASSIFICATIONS: { id: Classification; label: string }[] = [
  { id: "needs-decision", label: "Needs a decision" },
  { id: "needs-credentials", label: "Needs credentials or access" },
  { id: "needs-split", label: "Too large for one unit" },
  { id: "never", label: "Never" },
  { id: "dispatchable", label: "Ready, waiting for a slot" },
  { id: "done", label: "Already done" },
];

/** The projects on the overview, as a name lookup. Falls back to the id. */
function projectNames(overview: Pick<LoomOverview, "projects">): Map<string, string> {
  return new Map(overview.projects.map((project) => [project.projectId, project.name || project.projectId]));
}

/**
 * ONE PROJECT'S SLICE OF THE SNAPSHOT — a FILTER, never a second read.
 *
 * `/looms/[projectId]`'s Deck segment shows the same four piles as `/looms`,
 * narrowed to one project. It is spelled here rather than in the component
 * because the triage arm has a rule in it, and a rule in JSX is a rule nothing
 * tests.
 *
 * THAT RULE: a triage entry names its owner (`OverviewTriageEntry.projectId`),
 * because the per-project caches on disk are MERGED into one array on the way
 * out and an unattributed merge is underivable. An entry with NO owner — an
 * engine older than that field — belongs to the only project when there is
 * exactly one, which is a fact rather than a guess; with two it is genuinely
 * unattributable and appears on the whole-deck view alone. It is never guessed
 * onto a project that may not own it.
 */
export function scopeOverview(overview: LoomOverview, projectId: string): LoomOverview {
  const only = overview.projects.length === 1 && overview.projects[0]?.projectId === projectId;
  return {
    ...overview,
    projects: overview.projects.filter((project) => project.projectId === projectId),
    looms: overview.looms.filter((loom) => loom.projectId === projectId),
    triage: overview.triage.filter((entry) => (entry.projectId ? entry.projectId === projectId : only)),
    runs: overview.runs.filter((run) => run.projectId === projectId),
  };
}

export function deckSections(overview: LoomOverview): DeckSections {
  const names = projectNames(overview);
  const looms = overview.looms;

  const needsYou: NeedsYouRow[] = [
    ...looms
      .filter((loom) => loom.state === "asking")
      .map((loom) => ({
        kind: "loom" as const,
        key: loom.id,
        loom,
        projectId: loom.projectId,
        // A loom in `asking` with no question is a bug upstream; say so rather
        // than render an empty box that looks like a loading state.
        question: loom.question ?? "It escalated past the ladder without writing down what it wanted to ask.",
      })),
    ...overview.projects.flatMap((project) =>
      project.assumed.map((assumption) => ({
        kind: "assumed" as const,
        key: `${project.projectId}::${assumption}`,
        projectId: project.projectId,
        projectName: project.name || project.projectId,
        assumption,
      })),
    ),
  ];

  const review = looms.filter((loom) => loom.state === "published");

  /**
   * IN FLIGHT, NESTED UNDER ITS PROJECT. Grouped rather than flat because two
   * projects' looms interleaved by timestamp is a list nobody can scan — the
   * question in front of a person here is "what is <project> doing", and the
   * project is the answer's subject.
   */
  const inFlight = looms.filter((loom) => IN_FLIGHT_STATES.includes(loom.state));
  const working: ProjectGroup[] = [];
  for (const loom of inFlight) {
    const group = working.find((candidate) => candidate.projectId === loom.projectId);
    if (group) group.looms.push(loom);
    else working.push({ projectId: loom.projectId, name: names.get(loom.projectId) ?? loom.projectId, looms: [loom] });
  }

  const closed = looms.filter((loom) => loom.state === "parked" || loom.state === "cancelled");

  /**
   * SEEN AND NOT TAKEN — AND THE PROJECTION IS WHAT RECONCILES.
   *
   * The triage cache records what the LAST CLASSIFICATION PASS thought, and is
   * deliberately not invalidated against loom state: an entry is re-read only
   * when the item's own `updatedAt` moves, which is what makes reading a whole
   * thread affordable. So it will go on saying `dispatchable` about an item
   * that has since been dispatched, gated and published — correctly, because
   * nothing about the ITEM changed.
   *
   * THE RULE: an item that has a loom AT ALL has been taken, `parked` and
   * `cancelled` included. Those two are the tempting exception and they do not
   * come back, because the loom is already drawn in **Stopped, with a reason**
   * — the pile's copy would be a stale classification beside a written record
   * of what actually happened. Nothing is dropped; every loom state lands in
   * some section, and `loom-deck.test.ts` pins both halves together.
   */
  const taken = new Set(looms.map((loom) => loom.item));
  const seen = CLASSIFICATIONS.map((group) => ({
    classification: group.id,
    label: group.label,
    entries: overview.triage.filter((entry) => entry.classification === group.id && !taken.has(entry.item)),
  })).filter((group) => group.entries.length > 0);

  const active = inFlight.length > 0 || overview.runs.some((run) => run.state === "running");

  return { needsYou, review, working, seen, closed, active };
}

/** Every classification the deck knows how to name, in the order it draws them. */
export function classificationOrder(): Classification[] {
  return CLASSIFICATIONS.map((group) => group.id);
}

/**
 * One line naming what a loom is doing, in the reader's language rather than
 * the state machine's. `stuck` is deliberately NOT called a failure: it is the
 * ladder's entry point and the loom is still alive.
 */
export function loomStep(loom: Loom): string {
  switch (loom.state) {
    case "queued":
      return "queued — no worktree yet";
    case "working":
      return "a session is working in its worktree";
    case "gating":
      return "running this project's gates";
    case "publishing":
      return "publishing";
    case "published":
      return "published, waiting for you to read it";
    case "stuck":
      return loom.ladderRung > 0 ? `on the ladder, rung ${loom.ladderRung}` : "stuck — the ladder has not started";
    case "parked":
      return loom.parkedReason ?? "parked without a written reason, which is a bug";
    case "asking":
      return "waiting on you";
    case "cancelled":
      return "cancelled by you";
  }
}

/**
 * Whether the deck should poll fast. Read off the SNAPSHOT rather than tracked
 * separately, so the cadence can never disagree with what is on screen.
 */
export function overviewActive(overview: LoomOverview): boolean {
  return (
    overview.looms.some((loom) => IN_FLIGHT_STATES.includes(loom.state)) ||
    overview.runs.some((run) => run.state === "running") ||
    overview.projects.some((project) => project.watch.running)
  );
}
