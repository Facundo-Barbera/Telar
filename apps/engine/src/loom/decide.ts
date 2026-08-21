/**
 * THE AGENT DECIDES, THE MACHINERY ENFORCES.
 *
 * This file is the second half of that sentence. A tick's output is a
 * PROPOSAL — what the orchestrator thinks should happen — and everything in it
 * is re-checked here against facts the agent cannot be trusted to hold across a
 * fresh context: which items already have a loom, how many are in flight, which
 * loom ids exist. Prompting is not a mechanism. An agent under pressure at the
 * end of a long tick will propose a second loom for an item it already
 * dispatched, and no amount of "remember not to" in the system prompt makes
 * that stop happening.
 *
 * ── A SILENT DROP IS FORBIDDEN ───────────────────────────────────────────────
 * Every rejection lands in `rejected` with a sentence saying which proposal and
 * why. This is not politeness; it is the difference between "the orchestrator
 * decided not to dispatch #457" and "the orchestrator asked to dispatch #457
 * and the machinery refused". Those look identical in an empty result set and
 * they mean completely different things — the first is triage working, the
 * second is a bug or a saturated queue. The ledger records both, and the run's
 * `dispatched` list next to `decision.dispatch` is where a human sees the gap.
 *
 * ── DEGRADE, DO NOT THROW ────────────────────────────────────────────────────
 * A malformed element is rejected on its own; the rest of the decision still
 * lands. One bad park entry must not throw away six correct classifications,
 * because triage is the durable output and it is the expensive half. Even a
 * completely unparseable payload returns an empty decision plus a reason, never
 * an exception into the tick loop.
 */
import {
  TickAsk,
  TickDecision,
  TickDispatch,
  TickPark,
  TickTriage,
  type Loom,
} from "@telar/engine-client";
import { isActive, isTerminal } from "./machine";

/** What the machinery knows and the agent cannot be trusted to remember. */
export type TickContext = {
  /** Every loom for this project, terminal ones included — a terminal loom is
   *  what makes a SECOND dispatch of the same item legal. */
  looms: Loom[];
  /** `program.work.concurrency`. Counted against non-terminal looms. */
  concurrency: number;
};

export type ValidatedDecision = { decision: TickDecision; rejected: string[] };

const describe = (value: unknown): string => {
  const json = (() => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  })();
  return json === undefined ? String(value) : json.length > 120 ? json.slice(0, 117) + "..." : json;
};

/**
 * Validate one tick's output against the invariants machinery owns.
 *
 * The four rules, in the order they are applied:
 *
 *   1. A dispatch for an item that already has a NON-TERMINAL loom is refused.
 *      Two looms on one item means two worktrees, two sessions and two PRs for
 *      the same issue, and the second one's diff will conflict with the first.
 *      A terminal loom does not block: an item that came back after its PR was
 *      published or its loom was parked is legitimately new work.
 *   2. A duplicate dispatch WITHIN one decision is refused for the same reason
 *      — the first one in the list wins, because list order is the agent's own
 *      priority and honouring it is more useful than picking arbitrarily.
 *   3. Dispatches beyond `concurrency`, counting looms already in flight, are
 *      refused. The ceiling is a machine-resource statement (worktrees, agent
 *      processes, API spend) and no tick output may raise it.
 *   4. A park or ask naming a loom id that does not exist is refused, as is a
 *      park of an already-terminal loom — re-parking a published loom would
 *      overwrite a real outcome with a reason.
 *
 * An `ask` with no `loomId` is legal and is NOT rejected: the most valuable
 * question the system asks is usually about an item nobody has taken yet
 * ("#464 needs a real Ads account — do you want a throwaway campaign?"), and a
 * question about the Program itself has neither a loom nor an item.
 */
export function validateDecision(raw: unknown, ctx: TickContext): ValidatedDecision {
  const rejected: string[] = [];

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    rejected.push(`the tick produced ${describe(raw)}, which is not a decision object — nothing was applied`);
    return { decision: TickDecision.parse({}), rejected };
  }

  const source = raw as Record<string, unknown>;
  const arrayAt = (key: string): unknown[] => {
    const value = source[key];
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value;
    rejected.push(`\`${key}\` was ${describe(value)}, not a list — ignored`);
    return [];
  };

  // --- triage: no invariant to enforce, only shape. It is the durable output
  // and the cheapest thing to get right, so a bad row never costs a good one.
  const triage: TickTriage[] = [];
  for (const row of arrayAt("triage")) {
    const parsed = TickTriage.safeParse(row);
    if (parsed.success) triage.push(parsed.data);
    else rejected.push(`triage ${describe(row)} is not a valid classification — dropped`);
  }

  // --- dispatch
  const byItem = new Map<string, Loom>();
  for (const loom of ctx.looms) if (isActive(loom)) byItem.set(loom.item, loom);
  const inFlight = ctx.looms.filter(isActive).length;
  const capacity = Math.max(0, ctx.concurrency - inFlight);

  const dispatch: TickDispatch[] = [];
  const claimed = new Set<string>();
  for (const row of arrayAt("dispatch")) {
    const parsed = TickDispatch.safeParse(row);
    if (!parsed.success) {
      rejected.push(`dispatch ${describe(row)} is not a valid dispatch — dropped`);
      continue;
    }
    const proposal = parsed.data;
    const existing = byItem.get(proposal.item);
    if (existing) {
      rejected.push(
        `dispatch ${proposal.item}: already has a live loom (${existing.id}, ${existing.state}) — dropped`,
      );
      continue;
    }
    if (claimed.has(proposal.item)) {
      rejected.push(`dispatch ${proposal.item}: proposed twice in one tick — the second was dropped`);
      continue;
    }
    if (dispatch.length >= capacity) {
      rejected.push(
        `dispatch ${proposal.item}: concurrency ${ctx.concurrency} is full (${inFlight} in flight, ${capacity} free) — dropped`,
      );
      continue;
    }
    claimed.add(proposal.item);
    // The slug is NORMALIZED, not trusted. A model-authored branch name reaches
    // a shell and a filesystem; `slugify` is what makes that boring.
    dispatch.push({ ...proposal, branchSlug: slugify(proposal.branchSlug || proposal.title, proposal.item) });
  }

  // --- park / ask
  const known = new Map<string, Loom>(ctx.looms.map((l) => [l.id, l]));

  const park: TickPark[] = [];
  for (const row of arrayAt("park")) {
    const parsed = TickPark.safeParse(row);
    if (!parsed.success) {
      rejected.push(`park ${describe(row)} is not a valid park — dropped`);
      continue;
    }
    const loom = known.get(parsed.data.loomId);
    if (!loom) {
      rejected.push(`park ${parsed.data.loomId}: no such loom — dropped`);
      continue;
    }
    if (isTerminal(loom)) {
      rejected.push(`park ${parsed.data.loomId}: already ${loom.state}, which is terminal — dropped`);
      continue;
    }
    park.push(parsed.data);
  }

  const ask: TickAsk[] = [];
  for (const row of arrayAt("ask")) {
    const parsed = TickAsk.safeParse(row);
    if (!parsed.success) {
      rejected.push(`ask ${describe(row)} is not a valid question — dropped`);
      continue;
    }
    if (parsed.data.loomId !== undefined && !known.has(parsed.data.loomId)) {
      rejected.push(`ask ${parsed.data.loomId}: no such loom — dropped`);
      continue;
    }
    ask.push(parsed.data);
  }

  const note = typeof source.note === "string" ? source.note : "";
  if (source.note !== undefined && typeof source.note !== "string") {
    rejected.push(`\`note\` was ${describe(source.note)}, not a line of text — ignored`);
  }

  return { decision: { triage, dispatch, park, ask, note }, rejected };
}

const MAX_SLUG = 48;

/**
 * A title into a branch-safe slug.
 *
 * THIS STRING REACHES A SHELL AND A FILESYSTEM — it becomes
 * `<branchPrefix><slug>` in `git worktree add` and in the `publish` command's
 * `$BRANCH`. So it is reduced to `[a-z0-9-]` and nothing else, which also
 * disposes of every git ref rule at once (no `..`, no leading or trailing `-`,
 * no `.lock` suffix, no control characters, no spaces).
 *
 * ACCENTS ARE FOLDED, NOT DELETED. NFD decomposition puts "búsqueda" into a
 * base letter plus a combining mark, and stripping the marks leaves "busqueda"
 * — a Spanish backlog produces readable branches instead of "b-squeda". CJK and
 * emoji have no ASCII fold and drop out entirely, which is why the fallback
 * exists: a title that is entirely emoji, or entirely punctuation, reduces to
 * an empty string, and an empty branch name is a `git` error at 3am.
 *
 * NEVER EMPTY. The fallback is the item ref, itself slugified — `#457` becomes
 * `457` — and if even that empties out, the literal `item`. A branch called
 * `t3code/item` is ugly; a crashed dispatch is worse.
 */
export function slugify(title: string, fallback = "item"): string {
  const reduce = (value: string): string =>
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SLUG)
      // The slice can land on a hyphen; trailing ones are illegal in a ref.
      .replace(/-+$/g, "");

  const slug = reduce(title ?? "");
  if (slug !== "") return slug;
  const fromFallback = reduce(fallback ?? "");
  return fromFallback !== "" ? fromFallback : "item";
}
