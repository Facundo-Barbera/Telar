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
import type { JournalReclaim, PackageCacheStatus, StorageCategory, StorageEntry, StorageReport } from "@telar/engine-client";
import {
  ActivityIcon,
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
    hint: "One git checkout per session. Re-cut from the recorded base commit; only uncommitted work is lost.",
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
    hint: "Every turn, item and receipt, in one SQLite database and its log.",
    icon: DatabaseIcon,
  },
  sessions: {
    label: "Conversation history",
    hint: "What each session was asked and answered. The only copy.",
    icon: MessagesSquareIcon,
  },
  python: {
    label: "Python environments",
    hint: "Interpreters and packages the data-science plugin installed. Rebuildable.",
    icon: PackageIcon,
  },
  "browser-profiles": {
    label: "Browser profiles",
    hint: "Cookies and logins for Telar's browser. Removing one signs those accounts out.",
    icon: MonitorIcon,
  },
  usage: {
    label: "Spend history",
    hint: "The parsed-transcript cache behind Usage, and the price list it costs turns against.",
    icon: ActivityIcon,
  },
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
    hint: "Everything else under the store root, so the rows add up.",
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
/**
 * WHY A CHECKOUT'S `node_modules` COSTS WHAT IT COSTS — issue #633.
 *
 * It reads directly under the checkouts figure because that is the row
 * somebody looks at and the question they then ask. Hardlinks and APFS clones
 * are same-filesystem only, so a checkout on one disk and a package cache on
 * another means every install pays a real full copy — and the figure above
 * cannot show that, because `stat.blocks` counts a clone at full size either
 * way.
 *
 * `unreachable` IS SAID DIFFERENTLY, and the distinction is the whole point of
 * having two words: a cache that does not exist yet is the ordinary state of a
 * fresh machine, not evidence of anything, and calling it "a different disk"
 * would be a wrong answer dressed as a precise one.
 *
 * NOTHING AT ALL ON ONE DISK. The engine sends no row for a cache on the same
 * device, so this is never reached by the people it would only confuse.
 */
export function cacheLabel(caches: readonly PackageCacheStatus[]): string | undefined {
  if (caches.length === 0) return undefined;
  const elsewhere = caches.filter((cache) => cache.dedup === "different-device").map((cache) => cache.name);
  const gone = caches.filter((cache) => cache.dedup === "unreachable").map((cache) => cache.name);
  const said: string[] = [];
  if (elsewhere.length > 0) {
    said.push(
      `${elsewhere.join(", ")} keeps its download cache on a different disk from your checkouts, so installing into one copies every package instead of sharing it. Putting the cache on the same disk would make them free.`,
    );
  }
  if (gone.length > 0) said.push(`${gone.join(", ")} has no cache Telar can reach right now — it may simply never have run here.`);
  return said.join(" ");
}

export function reclaimLabel(reclaimed: JournalReclaim): string {
  // The usage fold's rows count as superseded on the same terms as the other
  // two (#697); an engine from before it sends no field, which is zero rows.
  const rows = reclaimed.deltas + reclaimed.starts + (reclaimed.usage ?? 0);
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

  const cacheNote = cacheLabel(report?.caches ?? []);

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
        /**
         * APPARENT SIZE, SAID OUT LOUD — issue #633.
         *
         * The walk behind these figures is `stat.blocks`, which is what the
         * filesystem ALLOCATED to each file and not what the file costs. On
         * APFS a copy-on-write clone shares its blocks and reports the full
         * count anyway, so a deduplicated `node_modules` and a fully
         * duplicated one weigh the same here — measured: a real write, a
         * `cp -c` clone and a plain `cp` of the same 256 MB file read
         * identically to `du` and to `stat`, and only free space told them
         * apart.
         *
         * IT IS ONE SENTENCE RATHER THAN A FOOTNOTE because of who reads it:
         * the number in this pane is the number somebody would check to see
         * whether deduplication is working, and it reads "fine" when that is
         * broken and "broken" when it is fine. Saying what the figure is
         * costs a line; letting it be believed costs a wrong conclusion.
         */
        "Apparent sizes: files that share storage are counted in full.",
        // A floor, not a total, and said rather than quietly under-reported.
        report?.partial ? "Some of the store could not be read, so these figures are a floor." : undefined,
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
        hint={report?.root ?? "Where everything below lives."}
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
                    ? `${hint} Reclaim compacts superseded streaming rows; no turn or answer is removed.${reclaimed ? ` ${reclaimed}` : ""}`
                    : entry.category === "worktrees" && cacheNote
                      // UNDER THE FIGURE THAT MADE SOMEBODY ASK (#633), rather
                      // than in a row of its own: "Session checkouts — 7.3 GB"
                      // is the sentence, and this is the answer to why.
                      ? `${hint} ${cacheNote}`
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
