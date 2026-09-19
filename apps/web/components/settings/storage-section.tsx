"use client";

/**
 * WHAT TELAR IS KEEPING, HOW BIG, AND WHERE — issue #642.
 *
 * THE PANE IS THE POINT, not scaffolding for the relocation that comes after
 * it. Measuring this Mac's store to write the issue turned up
 * `execution.sqlite` at 993 MB — the second largest thing Telar owns, with a
 * 24 MB WAL beside it — which had never once come up in a conversation about
 * disk, including a whole day of work on moving the store. Nobody would have
 * found it by discussing; it took a number on a screen. So this section reports
 * every category, including the ones nobody asked about.
 *
 * READ AND REACH, NOTHING ELSE IN THIS PASS. No delete, no "clean up", no
 * suggestion of what to remove. Reveal in Finder is the only action, and the
 * engine route behind the numbers has no write in it at all.
 *
 * THE NUMBER CARRIES THE MOMENT IT WAS TAKEN. Sizing a 13 GB tree is seconds of
 * walking, so the figure is a measurement with a timestamp and a Refresh beside
 * it rather than a live reading — and the pane paints before any of it arrives,
 * because a Settings window that hangs on a large store is worse than a stale
 * figure. NOTHING HERE IS ON A TIMER: #629 is open because four timers in the
 * rail cost ~97,000 requests a day, and a folder's size does not change by the
 * second. One fetch on open, one more per press of Refresh.
 *
 * TELAR'S OWN FOOTPRINT AND NOTHING ELSE. There is no row here for Docker, for
 * Xcode, or for the projects a person works on, however much disk they take. A
 * pane that grew opinions about the whole machine would be a disk cleaner,
 * which is a different product.
 */

import { useCallback, useEffect, useState } from "react";
import type { JournalReclaim, StorageCategory, StorageEntry, StorageReport } from "@telar/engine-client";
import {
  ActivityIcon,
  BotIcon,
  DatabaseIcon,
  FolderGitIcon,
  HardDriveIcon,
  type LucideIcon,
  MessagesSquareIcon,
  MicIcon,
  MonitorIcon,
  NotebookPenIcon,
  PackageIcon,
  PlayIcon,
  ShapesIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { createEngineApi } from "@/lib/engine/client";
// The cockpit's one byte formatter (#630), not a second one: two of them on one
// screen would disagree about 1 GB the first time somebody rounded differently.
import { formatBytes } from "@/lib/format";
import { workspaceOpener, workspaceOpenBlocker } from "@/lib/workspace-open";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

/**
 * WHAT EACH CATEGORY IS, IN A PERSON'S WORDS — which is why the copy lives here
 * and not in the engine. The engine knows there is a directory called
 * `worktrees`; only this file knows that what a reader wants to be told is
 * "Session checkouts", and that the useful sentence about them is that they
 * come back.
 *
 * REPRODUCIBLE OR NOT IS IN THE SENTENCE, for the two categories where it
 * decides something. A checkout is re-cut from a recorded base sha, so losing
 * one costs a re-clone; a transcript is the only copy there has ever been. That
 * asymmetry is the argument for relocating worktrees and not history (#642
 * part 2), and it belongs where a person reads it rather than only in a commit
 * message.
 */
const CATEGORIES: Record<StorageCategory, { label: string; hint: string; icon: LucideIcon }> = {
  worktrees: {
    label: "Session checkouts",
    hint: "A git checkout per session. Reproducible: the engine re-cuts one from the base commit it recorded, so what is lost with them is uncommitted work, not history.",
    icon: FolderGitIcon,
  },
  /**
   * THE ROW THE PANE WAS WRITTEN FOR — and the one that now has an action,
   * which #642 deliberately left it without.
   *
   * The reason that has changed is that #646 measured it. The gigabyte is 98%
   * live rows, not freed pages waiting on a VACUUM — that returns 2.2% — and
   * 57% of the journal is rows a settled turn has already superseded: the
   * streaming deltas and the `item.started` whose own `item.completed` carries
   * everything they said. Reclaim drops those and vacuums.
   *
   * SO THE STANDING RULE HOLDS RATHER THAN BENDS. #642's objection was to
   * inviting somebody to delete history they have just met, and this offers to
   * delete no history at all: no turn, no item, no answer, nothing a session
   * can still be read back from. The hint says that in those words, because a
   * button on this row will be read as "clean up my conversations" unless it
   * says otherwise.
   */
  journal: {
    label: "Turn journal",
    hint: "Every turn, item and receipt this engine has recorded, in one SQLite database and its write-ahead log.",
    icon: DatabaseIcon,
  },
  sessions: {
    label: "Conversation history",
    hint: "What each session was asked and what it answered. Nothing reproduces this — it is the only copy.",
    icon: MessagesSquareIcon,
  },
  python: {
    label: "Python environments",
    hint: "Interpreters and packages the data-science plugin installed. Rebuilt by re-running the install.",
    icon: PackageIcon,
  },
  "browser-profiles": {
    label: "Browser profiles",
    hint: "Cookies and signed-in sessions for Telar's own browser. Removing one signs those accounts out.",
    icon: MonitorIcon,
  },
  usage: {
    label: "Spend history",
    hint: "The parsed-transcript cache behind Usage, and the price list it costs turns against.",
    icon: ActivityIcon,
  },
  agent: { label: "Agent memory", hint: "The cockpit Agent's own conversation, its memory and its checkpoints.", icon: BotIcon },
  notes: { label: "Project notebooks", hint: "The notes kept beside each project's code.", icon: NotebookPenIcon },
  dictation: { label: "Dictation", hint: "What dictation keeps on this machine.", icon: MicIcon },
  run: { label: "Run mounts", hint: "Scratch space a running turn mounts for itself.", icon: PlayIcon },
  diagnostics: { label: "Worker diagnostics", hint: "What a worker wrote down when something went wrong.", icon: ShapesIcon },
  settings: {
    label: "Settings",
    hint: "Projects, providers, appearance and the rest of this install's own configuration.",
    icon: SlidersHorizontalIcon,
  },
  other: {
    label: "Everything else",
    hint: "Everything under the store root that is none of the above, counted so the rows still add up to the total.",
    icon: HardDriveIcon,
  },
};

/** A category a newer engine reports and this build has no words for. Named by
 *  its id rather than dropped: an id is a worse label than a sentence and a
 *  better one than nothing, and a dropped row would make the figures stop
 *  adding up — which is the one thing this pane may not do. */
function describe(category: StorageCategory): { label: string; hint: string; icon: LucideIcon } {
  return (CATEGORIES as Partial<Record<string, { label: string; hint: string; icon: LucideIcon }>>)[category] ?? { label: category, hint: "", icon: HardDriveIcon };
}

/** "Everything else" reads last whatever it weighs — it is the remainder, and a
 *  remainder in the middle of a list of named things reads like one of them. */
export function orderEntries(entries: readonly StorageEntry[]): StorageEntry[] {
  const named = entries.filter((entry) => entry.category !== "other");
  const rest = entries.filter((entry) => entry.category === "other");
  return [...[...named].sort((left, right) => right.bytes - left.bytes), ...rest];
}

/** The moment the walk finished, in the register a settings row uses for a
 *  fact it is reporting rather than one it is live on. */
export function measuredLabel(measuredAt: number, now = Date.now()): string {
  const taken = new Date(measuredAt);
  const sameDay = new Date(now).toDateString() === taken.toDateString();
  return sameDay
    ? `as of ${taken.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
    : `as of ${taken.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/**
 * WHAT ONE PRESS RETURNED, IN A SENTENCE — issue #646.
 *
 * BOTH NUMBERS, ALWAYS, because the case worth designing for is the press that
 * moves nothing: a person who reclaimed yesterday presses again today and is
 * owed "already compact", not a silent no-op or a cheerful "freed 0 B". That is
 * also how they learn the button is not something to keep pressing.
 *
 * AND IT NAMES WHAT WENT. "Rows" alone on a row labelled "Turn journal" reads
 * like conversations being deleted; "superseded" is the word that is both true
 * and reassuring, and it is true because of the guard in `compactJournal`.
 */
export function reclaimLabel(reclaimed: JournalReclaim): string {
  const rows = reclaimed.deltas + reclaimed.starts;
  const freed = reclaimed.before - reclaimed.after;
  if (freed <= 0 && rows === 0) return "Already compact — nothing left to reclaim.";
  const went = rows > 0 ? `${rows.toLocaleString()} superseded rows, ` : "";
  return `Freed ${formatBytes(freed)} — ${went}${formatBytes(reclaimed.before)} → ${formatBytes(reclaimed.after)}.`;
}

export function StorageSection() {
  const [report, setReport] = useState<StorageReport>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [reclaiming, setReclaiming] = useState(false);
  const [reclaimed, setReclaimed] = useState<string | undefined>(undefined);

  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    setFailure(undefined);
    try {
      setReport((await api.storage(refresh ? { refresh: true } : {})).storage);
    } catch {
      setFailure("Telar could not measure its own store — the engine did not answer.");
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * ONCE, ON OPEN. No interval, no focus listener, no revalidation — the read
   * behind this walks the whole store, and a pane that repeated it on a timer
   * would be #629 with a bigger price per tick. Refresh is the other half of
   * the contract and it is a button a person presses.
   *
   * THROUGH A ZERO TIMEOUT, the way every other section's first read goes: the
   * pane paints before the walk is asked for, which is the difference between a
   * Settings window that opens and one that waits on a 13 GB tree.
   */
  useEffect(() => {
    const task = window.setTimeout(() => void load(false), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  /**
   * Finder is the shell's, so a browser tab has no Reveal and says why once
   * rather than per row. The sentence is `workspaceOpenBlocker`'s — the same
   * one the file tree and the folder picker give — and it is asked only for the
   * no-bridge case, because its other branches are about a SESSION's workspace
   * and would be the wrong words on a pane about the store.
   */
  const bridge = typeof window === "undefined" ? undefined : workspaceOpener();
  const cannotReveal = bridge?.reveal ? undefined : workspaceOpenBlocker({ path: undefined, hostId: undefined, hasBridge: false });
  const reveal = (entry: { path: string; kind: "directory" | "file" }) => {
    // A file is SELECTED in its folder and a folder is opened; the shell
    // refuses a mismatch by design, so the kind travels with the row rather
    // than being guessed from the path's shape.
    if (entry.kind === "file" && bridge?.revealFile) void bridge.revealFile(entry.path);
    else void bridge?.reveal(entry.kind === "file" ? entry.path.replace(/\/[^/]+$/, "") : entry.path);
  };

  /**
   * THE ONE WRITE ON THIS PANE, and it re-measures rather than doing arithmetic
   * on the figures already on screen: the press changed the file, and a row
   * that kept showing the old number would say the press did nothing.
   *
   * `load(true)` and not `load(false)` — the engine dropped its cached
   * measurement when it vacuumed, but asking for a fresh one is what makes this
   * correct regardless of which side remembers.
   */
  const reclaim = async () => {
    setReclaiming(true);
    setFailure(undefined);
    setReclaimed(undefined);
    try {
      setReclaimed(reclaimLabel((await api.reclaimJournal()).reclaimed));
      await load(true);
    } catch {
      setFailure("Telar could not compact the journal — the engine did not answer.");
    } finally {
      setReclaiming(false);
    }
  };

  const revealControl = (entry: { path: string; kind: "directory" | "file" }) =>
    cannotReveal ? null : (
      <Button size="sm" variant="ghost" onClick={() => reveal(entry)}>
        Reveal
      </Button>
    );

  return (
    <SettingsGroup
      title="What Telar is keeping"
      description={[
        "Measured when this pane opens, and again when you refresh — never on its own.",
        // A floor, not a total, and said rather than quietly under-reported.
        report?.partial ? "Something under the store could not be read, so these figures are a floor." : undefined,
        cannotReveal,
      ]
        .filter(Boolean)
        .join(" ")}
      action={
        <span className="flex items-center gap-2">
          {busy ? <Spinner className="size-3.5" /> : report ? <span className="text-xs text-muted-foreground">{measuredLabel(report.measuredAt)}</span> : null}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void load(true)}>
            Refresh
          </Button>
        </span>
      }
    >
      <Row
        icon={HardDriveIcon}
        label="Total"
        hint={report?.root ?? "Where this engine keeps everything below."}
        {...(failure ? { error: failure } : {})}
        control={
          <span className="flex items-center gap-2">
            <span className="font-mono text-xs tabular-nums">{report ? formatBytes(report.total) : busy ? "…" : "—"}</span>
            {report ? revealControl({ path: report.root, kind: "directory" }) : null}
          </span>
        }
      />
      {report
        ? orderEntries(report.entries).map((entry) => {
            const { label, hint, icon } = describe(entry.category);
            const isJournal = entry.category === "journal";
            return (
              <Row
                key={entry.category}
                icon={icon}
                label={label}
                hint={
                  isJournal
                    ? `${hint} Reclaim drops the streaming rows a finished turn has already superseded and compacts the file — no turn, item or answer is removed.${reclaimed ? ` ${reclaimed}` : ""}`
                    : hint
                }
                control={
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs tabular-nums">{formatBytes(entry.bytes)}</span>
                    {isJournal ? (
                      // Disabled while the pane is measuring too: the vacuum
                      // takes an exclusive lock and a walk that started before
                      // it would report the file from either side of the work.
                      <Button size="sm" variant="outline" disabled={busy || reclaiming} onClick={() => void reclaim()}>
                        {reclaiming ? "Reclaiming…" : "Reclaim"}
                      </Button>
                    ) : null}
                    {revealControl(entry)}
                  </span>
                }
              />
            );
          })
        : null}
    </SettingsGroup>
  );
}
