/**
 * A MUTATION ON ONE ROW: APPLIED AT ONCE, RECONCILED BY ITS OWN ANSWER — #495.
 *
 * WHAT THIS REPLACED. Every verb on a rail row — settle, pin, snooze, rename,
 * delete — used to be `await patchSession(...)` followed by `onRefresh()`, and
 * `onRefresh` was an unconditional `loadAll()`: the pairing book, then one live
 * read PER PAIRED MAC. So the cost of pressing Settle was a round trip that
 * changed nothing on screen, then a second fan-out of reads to learn the one
 * field the first call already knew, and only THEN did the row move. That is
 * the whole of "pin/settle take a while for the app to react".
 *
 * THE ROW IS THE UNIT, NOT THE LIST. A mutation touches exactly one session, so
 * it hands back exactly one row and the rail patches that row in place. What
 * else may have changed on the machine in those 80ms is the POLL's business —
 * it is already running, it is already conditional (#457/#459), and a tick that
 * finds nothing new costs a 304 with no body. Reloading the whole rail to catch
 * a hypothetical second change is paying for the poll twice.
 *
 * AND THE ANSWER STILL ARRIVES. Optimistic does not mean unverified: the engine
 * answers with the session record it actually stored, and that record — not the
 * guess — is what the row settles on. A refusal puts the row back where it was
 * and says why. The three states are visible in `mutateRow` below, in order.
 */
import type { LiveSessionRow } from "@telar/engine-client";
import { hostFetcher, LOCAL_HOST_ID } from "./hosts/client";
import { sessionKey, toSidebarSession, type SidebarSession } from "./session-list";

/**
 * WHAT ONE MUTATION HANDS BACK TO THE RAIL.
 *
 * Two shapes because there are two outcomes a row can have: it is still there
 * and looks like this, or it is gone. A single `row?: SidebarSession` would
 * make "gone" and "nothing happened" the same value, which is exactly the
 * confusion a delete must not have.
 */
export type SessionRowChange =
  /** This row, as it now is — optimistic, reconciled, or reverted. */
  | { row: SidebarSession }
  /** This row is gone. Carries `sessionKey`, because two Macs can mint the
   *  same session id and only the key is unambiguous across the rail. */
  | { removed: string };

/** The rail's own hand, handed down to every row. Named for what it promises:
 *  ONE row changed, and here it is — never "go and read everything again". */
export type SessionRowChanged = (change: SessionRowChange) => void;

/**
 * THE ENGINE'S ANSWER, FOLDED BACK ONTO THE ROW THAT ASKED FOR IT.
 *
 * `toSidebarSession` is the same projection `loadHost` makes, so a patched row
 * and a polled one cannot differ in shape. What it cannot know is everything
 * the RAIL resolved once for the whole list — the project's name, icon, glyph
 * and remote, which Mac this is and what that Mac is called, the coordinator's
 * title behind a `settledBy`. Those are properties of the read, not of the
 * session, so they come off the row we already have rather than being looked
 * up again per mutation.
 *
 * `stale` IS DELIBERATELY DROPPED. It is a fact about a read that did not
 * happen; this row is an answer that just did.
 */
export function patchedRow(row: SidebarSession, answered: LiveSessionRow): SidebarSession {
  return toSidebarSession(
    answered,
    row.projectName,
    row.projectBranch,
    row.projectIcon,
    row.hostId === undefined ? undefined : { id: row.hostId, name: row.hostName ?? row.hostId },
    row.assignments,
    row.projectRemote,
    row.projectIconName,
    row.settledForTitle,
  );
}

/**
 * ONE CHANGE, APPLIED TO A LIST OF ROWS — the rail's whole reconciliation.
 *
 * KEYED, NOT INDEXED, and the key is `sessionKey`: two Macs can mint the same
 * session id, and patching by bare id would let a settle on the mini rewrite a
 * local conversation that happens to share it.
 *
 * A ROW THAT IS NOT THERE IS NOT INSERTED. Every change here names a row the
 * rail was already drawing — that is what a row-scoped verb means — and a
 * mutation that arrives against a list which has since dropped the row (the
 * project was deregistered, the filter narrowed) should not put it back. The
 * next poll owns what the list CONTAINS; this owns what a row LOOKS like.
 */
export function applyRowChange(rows: readonly SidebarSession[], change: SessionRowChange): SidebarSession[] {
  if ("removed" in change) return rows.filter((row) => sessionKey(row) !== change.removed);
  const key = sessionKey(change.row);
  let found = false;
  const next = rows.map((row) => {
    if (sessionKey(row) !== key) return row;
    found = true;
    return change.row;
  });
  return found ? next : rows.slice();
}

/**
 * THE ROW AS IT LOOKS THE INSTANT SOMEBODY PRESSES THE BUTTON.
 *
 * One builder per verb rather than a `Partial<SidebarSession>` at each call
 * site, so the optimistic shape of "settled" is written down exactly once and
 * cannot drift between the row's own button and the menu row beside it.
 *
 * EVERY ONE OF THEM STAMPS `updatedAt`, because a real change on the engine
 * does. The un-settle path DEPENDS on it: returning a drift-settled session to
 * the list works by restarting the inactivity clock, so a guess that left the
 * old stamp in place would draw the row back onto the shelf it just left.
 *
 * `at` DEFAULTS TO THE WALL CLOCK, and that is safe here in a way it is not one
 * layer up: a row must not read `Date.now()` while RENDERING (the server and
 * the first client render have to agree, which is what `renderedAt` is
 * threaded down for), and every one of these is called from a click. Passing
 * the rail's stamp instead would guess with a clock up to ten seconds old.
 */
export function withSettling(row: SidebarSession, override: "settled" | "active" | null, at: number = Date.now()): SidebarSession {
  return {
    // THE ENGINE'S REASON GOES WITH THE STATE. `settledBy` is only ever set
    // beside an engine settle (#378), so a person settling or un-settling by
    // hand must not leave "settled after its work for X was delivered" hanging
    // off the row they just decided about.
    ...without(row, ["settledOverride", "settledAt", "settledBy", "settledForTitle"]),
    updatedAt: at,
    ...(override === null ? {} : { settledOverride: override }),
    ...(override === "settled" ? { settledAt: at } : {}),
  };
}

/** Snoozing, and waking — `null` is the wake. */
export function withSnooze(row: SidebarSession, until: number | null, at: number = Date.now()): SidebarSession {
  return {
    ...without(row, ["snoozedUntil", "snoozedAt"]),
    updatedAt: at,
    ...(until === null ? {} : { snoozedUntil: until, snoozedAt: at }),
  };
}

/**
 * A ROW WITH THE NAMED FIELDS GONE, not set to `undefined`.
 *
 * `{ ...row, snoozedUntil: undefined }` keeps the key, and this projection is
 * built everywhere else by spreading conditionals precisely so an absent field
 * IS absent — `toSidebarSession` writes `...(x === undefined ? {} : { x })` for
 * every one of them. A guess that disagreed about that would be the one row in
 * the rail whose shape is not the shape the poll produces.
 */
type ClearableField = "settledOverride" | "settledAt" | "settledBy" | "settledForTitle" | "snoozedUntil" | "snoozedAt";

function without(row: SidebarSession, fields: readonly ClearableField[]): SidebarSession {
  const next = { ...row };
  for (const field of fields) delete next[field];
  return next;
}

/** Renaming. The engine clamps the length; this only has to agree about it. */
export function withTitle(row: SidebarSession, title: string, at: number = Date.now()): SidebarSession {
  return { ...row, title, updatedAt: at };
}

/**
 * A ROW'S REQUESTS GO TO THE ROW'S MAC. The rail draws a paired Mac's sessions
 * beside the local ones, and every verb on one of them must land on the engine
 * that owns it. A bare `fetch("/api/sessions/…")` reaches THIS Mac's engine
 * whatever the row says — which is a 404 at best, and at worst settles a local
 * session that happens to share the id.
 */
export function sessionFetch(session: Pick<SidebarSession, "hostId">, path: string, init?: RequestInit): Promise<Response> {
  return hostFetcher(session.hostId ?? LOCAL_HOST_ID)(path, init);
}

/**
 * One PATCH, one shape. Both verbs are the same call with different fields,
 * which is what keeps "settle" and "snooze" from drifting into two protocols.
 *
 * IT ANSWERS WITH THE RECORD NOW, and that is what makes #495 possible: the
 * row is patched from what the engine STORED rather than from what the button
 * promised, so a clamp, a derived title or a refused field shows up in the rail
 * within the same round trip and without a list read.
 *
 * A FAILED PATCH IS A FAILURE. This used to `await` the response and throw the
 * result away, so an engine that refused — or was not there — produced a menu
 * that closed, a row that did not change, and no way to tell "it did nothing"
 * from "it worked and the list has not caught up".
 */
export async function patchSession(
  session: Pick<SidebarSession, "id" | "hostId">,
  patch: { settledOverride?: "settled" | "active" | null; snoozedUntil?: number | null; title?: string },
): Promise<LiveSessionRow> {
  const response = await sessionFetch(session, `/api/sessions/${encodeURIComponent(session.id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(await patchFailureMessage(response));
  const payload = (await response.json()) as { session?: LiveSessionRow } | null;
  if (!payload?.session) throw new Error("The engine answered that change without a session.");
  return payload.session;
}

/**
 * Remove a session and everything it owns. No undo; the engine refuses while a
 * turn is in flight, which is why this reports rather than assuming.
 *
 * ANSWERS `undefined` RATHER THAN `void`, so it can be a `mutateRow` send: a
 * deleted session has no record to come back to, and "no record" is exactly
 * what tells `mutateRow` the change is a removal.
 */
export async function deleteSession(session: Pick<SidebarSession, "id" | "hostId">): Promise<undefined> {
  const response = await sessionFetch(session, `/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await patchFailureMessage(response));
  return undefined;
}

export async function patchFailureMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: string } } | null;
    if (payload?.error?.message) return payload.error.message;
  } catch {
    // A non-JSON body is a proxy or a dead socket; the status is all there is.
  }
  return response.status === 0 ? "The engine is not answering." : `The engine refused (${response.status}).`;
}

/**
 * THE REFUSAL SURFACE, AND WHY IT IS STILL AN ALERT.
 *
 * The revert is what a person actually sees: the row springs back to where it
 * was, which is the same feedback a toast would be carrying and arrives in the
 * place they are already looking. The sentence says WHICH refusal it was, and
 * an alert is how this rail has always said that — it has no error surface of
 * its own, and introducing a toast system for the one case that survives a
 * revert would be a larger change than the bug. Injectable so a test can read
 * what was said without a window.
 */
export type MutationReporter = (message: string) => void;

const alertReporter: MutationReporter = (message) => {
  if (typeof window !== "undefined") window.alert(message);
};

/**
 * RUN ONE MUTATION AGAINST ONE ROW, in three states and in this order:
 *
 *   1. the guess    — `after`, handed to the rail before anything is sent
 *   2. the answer   — the record the engine stored, folded back onto the row
 *   3. or the revert — `before`, plus a sentence saying what refused
 *
 * NO LIST READ ON ANY OF THE THREE. That is the acceptance for #495, and it is
 * structural rather than a matter of care: nothing in this function can reach
 * the rail's loader, because the only thing it is given is a per-row hand.
 *
 * `send` MAY ANSWER NOTHING, for the one verb that has no row to come back to:
 * a delete leaves a `removed` change instead. Everything else answers a record.
 */
export async function mutateRow({
  before,
  after,
  send,
  onRowChanged,
  report = alertReporter,
}: {
  before: SidebarSession;
  /**
   * WHAT THE RAIL SHOWS THE INSTANT THE BUTTON WAS PRESSED — a row for the four
   * verbs that change one (see the `with*` builders), and a `removed` for the
   * one whose optimistic state is an absence. A `SidebarSession` here instead
   * would leave delete with nothing honest to say.
   */
  after: SessionRowChange;
  send: () => Promise<LiveSessionRow | undefined>;
  onRowChanged: SessionRowChanged;
  report?: MutationReporter;
}): Promise<void> {
  onRowChanged(after);
  try {
    const answered = await send();
    onRowChanged(answered ? { row: patchedRow(before, answered) } : { removed: sessionKey(before) });
  } catch (cause) {
    // THE ROW AS IT WAS, not as the guess left it. Reverting to `before` rather
    // than re-reading is the same argument as patching forward: this function
    // knows exactly one row changed and exactly what it was.
    onRowChanged({ row: before });
    report(cause instanceof Error ? cause.message : "The engine refused that change.");
  }
}
