/**
 * THE HAND'S CLOSE — `docs/spool-loops.md` §9, the checkbox amendment.
 *
 * ONE MODULE FOR EVERY CHECKBOX. The stance, the board, the calendar and the
 * packet face all tick through these two functions, so the law they must keep
 * — the DEDICATED close route, never the generic PATCH — is kept in one place
 * by construction. `closed` is refused by the item PATCH on purpose (no
 * tool-reachable path may spell it); a surface that composed its own
 * `PATCH {closed}` would be re-opening the hole the engine welded shut.
 *
 * NO CONFIRMATION, ANYWHERE.
 * §9.2: "bureaucracy after a checkbox is how trackers die."
 * A checkbox that asks "are you sure" is not a checkbox, so
 * these are called straight from the click and reopen is equally instant —
 * closing is idempotent and reversible, which is what makes that safe.
 *
 * THE CASCADE IS QUOTED, NEVER INVENTED. Closing settles the item's open
 * threads engine-side ("the user closed the task"); what comes back is the
 * count and any refusals, and the sentence composed here interpolates exactly
 * those — the refusal reasons verbatim, in quotes. Nothing was settled means
 * no sentence: a quiet close stays quiet.
 */

export type SpoolCloseOutcome = {
  settledThreads?: unknown[];
  refused?: Array<{ threadId: string; reason: string }>;
  note?: string;
};

async function post(url: string): Promise<SpoolCloseOutcome> {
  const res = await fetch(url, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
  return data as SpoolCloseOutcome;
}

/** The one inline sentence a close may earn — from the engine's own answer,
 *  or nothing. Exported for the idiom suite to pin the wording. */
export function closeCascadeSentence(outcome: SpoolCloseOutcome): string | null {
  const settled = outcome.settledThreads?.length ?? 0;
  const refused = outcome.refused ?? [];
  const parts: string[] = [];
  if (settled > 0) {
    parts.push(
      settled === 1
        ? "closed — 1 question it was carrying settled with it"
        : `closed — ${settled} questions it was carrying settled with it`,
    );
  }
  if (refused.length > 0) {
    // The engine's own reasons, quoted — a refusal that survived the close is
    // the one part of the cascade the user still has to know about.
    parts.push(...refused.map((r) => `“${r.reason}”`));
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/** Tick — POST the dedicated close route. Resolves to the cascade sentence,
 *  or `null` when there is nothing worth a line. */
export async function closeItemByHand(id: string): Promise<string | null> {
  return closeCascadeSentence(await post(`/api/spool/items/${encodeURIComponent(id)}/close`));
}

/** Untick — equally the hand's, equally instant. Cascade-settled threads stay
 *  settled (the engine's rule, not softened here), so there is no sentence to
 *  compose: reopening is quiet. */
export async function reopenItemByHand(id: string): Promise<void> {
  await post(`/api/spool/items/${encodeURIComponent(id)}/reopen`);
}

/**
 * Tick MANY — the selection model's close, through the BULK route and never a
 * loop over the single one: one request, and the engine answers per id, so a
 * capture nothing goes by refuses its own row instead of failing the batch.
 * Same laws as the single tick: human API only, no dialog, and the one
 * sentence is composed from the engine's own counts and reasons — the
 * refusals and errors verbatim, in quotes. All quiet means null.
 */
export async function closeItemsByHand(ids: string[]): Promise<string | null> {
  const res = await fetch("/api/spool/items/close-many", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
  const results = (data.results ?? []) as Array<SpoolCloseOutcome & { id: string; error?: string }>;
  const landed = results.filter((r) => !r.error);
  const errors = results.filter((r) => r.error);
  const settled = landed.reduce((n, r) => n + (r.settledThreads?.length ?? 0), 0);
  const refused = landed.flatMap((r) => r.refused ?? []);
  const parts: string[] = [];
  parts.push(landed.length === 1 ? "closed 1 item" : `closed ${landed.length} items`);
  if (settled > 0) {
    parts.push(
      settled === 1
        ? "1 question they were carrying settled with them"
        : `${settled} questions they were carrying settled with them`,
    );
  }
  if (refused.length > 0) parts.push(...refused.map((r) => `“${r.reason}”`));
  if (errors.length > 0) parts.push(...errors.map((r) => `“${r.error}”`));
  return parts.join("; ");
}
