"use client";

/**
 * ══ WHICH CHECKOUTS CAN GO — issue #671 ══
 *
 * THE SCREEN THAT DID NOT EXIST. Until this, the only place a worktree was
 * mentioned was a count in the composer's environment popover — careful about
 * not saying "0" when git had not answered, and otherwise a number. Nothing
 * named one, sized one, said which session held it, or said whether it was safe
 * to remove. The only way to give a checkout back was to archive its session,
 * which nothing told you either.
 *
 * THE CLASSIFICATION IS THE FEATURE; A LIST IS NOT. This pane draws a VERDICT
 * per row, because Telar can prove merged, clean and unclaimed and a person
 * should not have to. A list that showed the same facts as four columns and
 * left the reasoning to the reader would make them check three things by hand
 * before daring to delete — which nobody does, which is how 7.3 GB accumulates
 * behind sessions that finished weeks ago. The chips are here so somebody CAN
 * check Telar's reasoning; the verdict is here so they need not.
 *
 * ── THE THREE AFFORDANCES, AND WHY THEY DIFFER ────────────────────────────
 *
 * RECLAIMABLE rows carry a checkbox and start CHECKED. Telar proved them safe;
 * making a person tick each one would be charging them for a proof already
 * done.
 *
 * NEEDS-FORCE rows carry a typed confirmation — the basename, typed. Not
 * ceremony: these are exactly the rows where Telar could NOT prove the work is
 * safe, so the person is being asked to say they looked. A checkbox cannot
 * express that and a second "are you sure" does not either.
 *
 * LOCKED rows carry NO AFFORDANCE AT ALL and say why. Force can never reach
 * them, which is the old surface's rule kept for its reason: a force that can
 * reach everything teaches people to type it without reading.
 *
 * ── THE CONFIRM NAMES SESSIONS, NOT GIGABYTES ─────────────────────────────
 *
 * Giving back a settled session's checkout ARCHIVES THAT SESSION — the only
 * supported way, because settling deliberately does not release a checkout and
 * nothing re-cuts a missing worktree. So the press ends conversations, and the
 * confirm says "archive" in those words. A confirm that named the space and
 * hid the session is the kind people click and regret.
 *
 * ── AND A DRIVE THAT IS OUT IS A STATE, NOT AN EMPTY LIST ─────────────────
 *
 * The checkouts live on an external volume. When it is not mounted this pane
 * says so and draws nothing — it does not draw "no checkouts", which would be
 * the reassuring lie the composer's count already knows not to tell.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorktreeInventory, WorktreeReclaimResult, WorktreeRow } from "@telar/engine-client";
import { FolderGitIcon, LockIcon, TriangleAlertIcon } from "lucide-react";
import { createEngineApi } from "@/lib/engine/client";
// The cockpit's one byte formatter (#630) and its one relative clock — two of
// either on one screen disagree about a gigabyte the first time somebody
// rounds differently.
import { fmtAgo, formatBytes } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { SettingsGroup } from "./settings-shell";

const api = createEngineApi();

/**
 * WHY A ROW CANNOT BE TOUCHED, in a person's words.
 *
 * THE COPY LIVES HERE AND THE REASON LIVES ON THE WIRE, which is the split the
 * whole settings pane uses: the engine knows `activity !== "idle"`, and only
 * this file knows that what a reader needs to be told is that something is
 * being worked in RIGHT NOW and that waiting is the answer.
 */
export const LOCK_TEXT: Record<string, string> = {
  unreadable: "On a drive that is not connected. Nothing was read, so nothing is claimed about it.",
  "in-use": "A session is working in it right now. Removing it would take the directory an agent is writing in.",
  protected: "The repository's own checkout, or the one Telar is running from. Never removable.",
  active: "Held by a session that is still on the rail. Settle it first, and this checkout becomes reclaimable.",
};

/** WHY A ROW NEEDS THE NAME TYPED. One sentence per reason rather than one for
 *  "not safe": push your branch, commit your work, and go and look are three
 *  different errands. */
export const FORCE_TEXT: Record<string, string> = {
  dirty: "has uncommitted changes",
  unmerged: "is not merged",
  unknown: "could not be checked — Telar did not get an answer from git",
  "no-branch": "has no branch to check",
};

/**
 * WHAT A ROW IS, AS A CHIP. Ownership first because it answers "will anything
 * ever want this again", which is the question a person is actually asking.
 *
 * AN ARCHIVED OWNER READS AS "LEFT BEHIND", NOT AS "ARCHIVED". The session is
 * already put down; what the reader needs to know is that its checkout outlived
 * it, which is a leak rather than a lifecycle state worth naming.
 */
export function ownerLabel(row: WorktreeRow): { label: string; tone: "outline" | "secondary" | "destructive" } {
  if (row.owner.kind === "none") return { label: "no session", tone: "destructive" };
  if (row.owner.lifecycle === "archived") return { label: "left behind", tone: "destructive" };
  if (row.owner.lifecycle === "settled") return { label: "settled", tone: "secondary" };
  return { label: "on the rail", tone: "outline" };
}

/**
 * THE SENTENCE ON THE CONFIRM — and it counts the two acts separately, because
 * they are different decisions that happen to free the same kind of byte.
 *
 * "Archive 3 sessions" is a thing a person may want to reconsider; "remove 2
 * checkouts nothing is holding" is not. Merging them into "give back 5" would
 * hide the half worth thinking about behind the half that is obvious.
 */
export function confirmSentence(rows: readonly WorktreeRow[]): string {
  const archives = rows.filter((row) => row.owner.kind === "session" && row.owner.lifecycle === "settled");
  const removals = rows.filter((row) => !(row.owner.kind === "session" && row.owner.lifecycle === "settled"));
  const bytes = rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0);
  const parts: string[] = [];
  if (archives.length > 0) {
    parts.push(
      `Archive ${archives.length} session${archives.length === 1 ? "" : "s"} and give back ${archives.length === 1 ? "its" : "their"} checkout${archives.length === 1 ? "" : "s"}.`,
    );
  }
  if (removals.length > 0) {
    parts.push(`Remove ${removals.length} checkout${removals.length === 1 ? "" : "s"} that no session is holding.`);
  }
  if (bytes > 0) parts.push(`${formatBytes(bytes)} back.`);
  // The branches are the session's output and they are NOT deleted — the
  // engine's own rule ("destroying the commits is a separate, human decision"),
  // said here because a person about to press this is entitled to know what
  // survives.
  parts.push("Branches are kept.");
  return parts.join(" ");
}

/**
 * WHICH ROWS THE PRESS WOULD ACT ON — exported because it is the surface's one
 * safety-bearing decision and deserves to be pinned by itself.
 *
 * A LOCKED ROW CAN NEVER BE IN HERE, whatever the other two arguments say.
 * There is no lock error downstream to catch a mistake — Telar's teardown
 * unlocks before removing — so a locked row that slipped into this list would
 * be removed, not refused.
 *
 * `cleared` IS THE EXCEPTIONS, NOT THE SELECTION. Reclaimable rows start
 * checked because Telar already did the proof, and keeping the state as "what
 * somebody took back" is what makes a refresh safe: a selection set re-seeded
 * on every load would silently re-check a row they had just unchecked, and the
 * next press would archive a session they had decided to keep.
 *
 * A `needs-force` ROW IS ARMED ONLY BY ITS EXACT BASENAME. Trimmed, because a
 * trailing space from a paste is not a different intention; never fuzzy,
 * because these are the rows Telar could not prove safe.
 */
export function armedRows(
  rows: readonly WorktreeRow[],
  cleared: ReadonlySet<string>,
  typed: Readonly<Record<string, string>>,
): WorktreeRow[] {
  return rows.filter((row) => {
    if (cleared.has(row.path)) return false;
    if (row.verdict.kind === "reclaimable") return true;
    if (row.verdict.kind === "needs-force") return (typed[row.path] ?? "").trim() === row.basename;
    return false;
  });
}

/**
 * WHAT ONE ARMED ROW SENDS. The typed confirmation rides only where it means
 * something: the engine requires it for every `needs-force` row and ignores it
 * elsewhere, and attaching it to a reclaimable row would make a proven-safe
 * checkout look like one somebody forced.
 */
export function reclaimPayload(rows: readonly WorktreeRow[], typed: Readonly<Record<string, string>>): { path: string; confirm?: string }[] {
  return rows.map((row) => ({
    path: row.path,
    ...(row.verdict.kind === "needs-force" ? { confirm: typed[row.path] ?? "" } : {}),
  }));
}

function StateChips({ row }: { row: WorktreeRow }) {
  const owner = ownerLabel(row);
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge variant={owner.tone}>{owner.label}</Badge>
      {/* A pruned registration is a different promise from a worktree: removing
          it is an `rm`, not a `git worktree remove`, and a reader who later
          wonders why git never mentioned it deserves the word. */}
      {!row.registered && row.onDisk ? <Badge variant="outline">unregistered</Badge> : null}
      {row.merged === true ? <Badge variant="secondary">merged</Badge> : null}
      {row.merged === false ? <Badge variant="outline">not merged</Badge> : null}
      {row.clean === false ? <Badge variant="destructive">uncommitted</Badge> : null}
      {/* UNPROVEN IS ITS OWN CHIP. A read that was killed is not a finding, and
          rendering it as "not merged" or as "clean" would be a confident claim
          about something nobody managed to look at. */}
      {row.incomplete ? <Badge variant="outline">unchecked</Badge> : null}
    </span>
  );
}

export function WorktreeListSection() {
  const [inventory, setInventory] = useState<WorktreeInventory>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [results, setResults] = useState<WorktreeReclaimResult[]>();
  const [summary, setSummary] = useState<string>();

  const load = useCallback(async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      setInventory((await api.worktrees()).inventory);
    } catch {
      setFailure("Telar could not list its checkouts — the engine did not answer.");
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * ONCE, ON OPEN, through a zero timeout — the storage pane's contract and its
   * reason. This read walks every checkout to size it, so nothing may put it on
   * a timer (#629), and the pane paints before the walk is asked for.
   */
  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  // Memoised on the inventory rather than recomputed: `?? []` mints a new array
  // every render, which would make the selection below recompute on each one.
  const rows = useMemo(() => inventory?.rows ?? [], [inventory]);

  const selected = useMemo(() => armedRows(rows, cleared, typed), [rows, cleared, typed]);

  const toggle = (row: WorktreeRow) =>
    setCleared((current) => {
      const next = new Set(current);
      if (next.has(row.path)) next.delete(row.path);
      else next.add(row.path);
      return next;
    });

  const reclaim = async () => {
    setBusy(true);
    setFailure(undefined);
    setResults(undefined);
    setSummary(undefined);
    try {
      const outcome = (await api.reclaimWorktrees(reclaimPayload(selected, typed))).reclaim;
      setResults(outcome.results);
      setSummary(outcome.summary);
      setConfirming(false);
      setTyped({});
      setCleared(new Set());
      // The figures on screen are now wrong in the one way that matters, so the
      // list is re-read rather than edited in place.
      await load();
    } catch {
      setFailure("Telar could not give those checkouts back — the engine did not answer.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * THE DRIVE IS OUT. One sentence and NO ROWS — never an empty list, which a
   * reader takes for "there are none" and which would invite a reclaim of
   * everything the moment it came back.
   */
  if (inventory?.blocker) {
    return (
      <SettingsGroup title="Checkouts" description={inventory.blocker}>
        <div className="py-3 text-xs text-muted-foreground">
          Plug the drive back in and this fills itself.
        </div>
      </SettingsGroup>
    );
  }

  const reclaimable = rows.filter((row) => row.verdict.kind === "reclaimable");
  const total = reclaimable.reduce((sum, row) => sum + (row.bytes ?? 0), 0);

  return (
    <SettingsGroup
      title="Checkouts"
      description={[
        rows.length === 0 && !busy
          ? "No checkouts yet."
          : `${rows.length} checkout${rows.length === 1 ? "" : "s"}, each checked for merged, clean, and still in use.`,
        reclaimable.length > 0 ? `${reclaimable.length} can go, ${formatBytes(total)}.` : undefined,
        // A floor, not a total, and said rather than quietly under-reported —
        // `StorageSection`'s rule, for the same reason.
        inventory?.partial ? "Something under the checkouts could not be read, so these sizes are a floor." : undefined,
      ]
        .filter(Boolean)
        .join(" ")}
      action={
        <span className="flex items-center gap-2">
          {busy ? <Spinner className="size-3.5" /> : null}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
            Refresh
          </Button>
          {selected.length > 0 ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(true)}>
              Give back {selected.length}
            </Button>
          ) : null}
        </span>
      }
    >
      {failure ? <div className="py-3 text-xs text-destructive">{failure}</div> : null}
      {summary ? <div className="py-3 text-xs text-muted-foreground">{summary}</div> : null}
      {/*
        THE SERVER'S REFUSALS, RENDERED HONESTLY — the old surface's phrase and
        its one genuinely good idea. A press that refused four of six says which
        four and why; swallowing them into the summary would teach people that
        the button sometimes does nothing.
      */}
      {results?.filter((result) => !result.ok).length ? (
        <div className="space-y-1 py-3 text-xs text-muted-foreground">
          {results
            .filter((result) => !result.ok)
            .map((result) => (
              <div key={result.path} className="flex items-start gap-2">
                <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
                <span>
                  <span className="font-mono">{result.path.split("/").pop()}</span> — {LOCK_TEXT[result.refusal ?? ""] ?? result.detail ?? "was not given back."}
                </span>
              </div>
            ))}
        </div>
      ) : null}

      {/*
        THE CONFIRM, AND IT NAMES THE SESSIONS. It lists the exact rows rather
        than a count, because "give back 6" is not something a person can check
        and six basenames are.
      */}
      {confirming ? (
        <div className="space-y-3 py-3">
          <p className="text-xs text-foreground">{confirmSentence(selected)}</p>
          <ul className="max-h-40 space-y-0.5 overflow-auto text-xs text-muted-foreground">
            {selected.map((row) => (
              <li key={row.path} className="font-mono">
                {row.basename}
                {row.owner.kind === "session" && row.owner.lifecycle === "settled" ? " — archives its session" : ""}
              </li>
            ))}
          </ul>
          <span className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void reclaim()}>
              {busy ? "Working…" : "Give them back"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </span>
        </div>
      ) : null}

      {rows.map((row) => {
        const locked = row.verdict.kind === "locked";
        const forced = row.verdict.kind === "needs-force";
        const checked = !locked && selected.some((entry) => entry.path === row.path);
        return (
          <div key={row.path} className="flex items-start gap-3 py-2.5">
            <div className="pt-0.5">
              {locked ? (
                <LockIcon className="size-4 text-muted-foreground/60" />
              ) : forced ? (
                <TriangleAlertIcon className="size-4 text-muted-foreground" />
              ) : (
                <input
                  type="checkbox"
                  checked={checked}
                  aria-label={checked ? `Keep ${row.basename}` : `Give back ${row.basename}`}
                  onChange={() => toggle(row)}
                  className="size-4 accent-primary"
                />
              )}
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <FolderGitIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-xs-plus text-foreground">{row.basename}</span>
                {row.branch ? <span className="truncate text-xs text-muted-foreground">{row.branch}</span> : null}
                {row.projectName ? <span className="truncate text-xs text-muted-foreground">· {row.projectName}</span> : null}
              </div>
              <StateChips row={row} />
              {locked && row.verdict.kind === "locked" ? <p className="text-xs text-muted-foreground">{LOCK_TEXT[row.verdict.reason]}</p> : null}
              {forced && row.verdict.kind === "needs-force" ? (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    This {row.verdict.reasons.map((reason) => FORCE_TEXT[reason] ?? reason).join(", and ")}. Type{" "}
                    <span className="font-mono text-foreground">{row.basename}</span> to give it back anyway.
                  </p>
                  <Input
                    value={typed[row.path] ?? ""}
                    aria-label={`Type ${row.basename} to confirm`}
                    placeholder={row.basename}
                    className="h-7 max-w-xs font-mono text-xs"
                    onChange={(event) => setTyped((current) => ({ ...current, [row.path]: event.target.value }))}
                  />
                </div>
              ) : null}
            </div>
            <div className="shrink-0 text-right">
              <div className="font-mono text-xs tabular-nums text-foreground">{row.bytes === undefined ? "—" : formatBytes(row.bytes)}</div>
              {row.updatedAt ? <div className="text-xs text-muted-foreground">{fmtAgo(row.updatedAt)}</div> : null}
            </div>
          </div>
        );
      })}
    </SettingsGroup>
  );
}
