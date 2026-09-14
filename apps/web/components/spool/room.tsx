"use client";

/**
 * A SUBJECT'S ROOM — `docs/spool-loops.md` §13.2/§13.3. Opens on THE BRIEF:
 * `GET /v2/spool/subjects/:key/brief` (`/api/spool/subjects/[key]/brief`),
 * composed once, deterministic, no model call — the same discipline
 * `SpoolBriefing` already holds for one item, widened to a whole subject.
 * Behind the brief, TABS hold the full grammar: Tasks (the existing focused
 * band rendering — needs/in-its-hands/waiting-on-others/settled/done — is
 * unified there already, so this room does not split threads into a
 * separate tab; see the file-level note in the report this pass shipped
 * with), Board, Calendar, Notes.
 *
 * FILTERS ARE TRANSIENT HERE. `stuck on me` / `unfiled` / lane / tag render
 * as chips ABOVE the Tasks tab's content, local `useState`, no store write —
 * "glances aren't work" travels from the retired toolbar into this room
 * unchanged, only the home moved.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { XIcon } from "lucide-react";
import type {
  SpoolBrief,
  SpoolBriefing,
  SpoolLane,
  SpoolSubject,
  SpoolSubjectGroup,
  SpoolSubjectRow,
  SpoolUnreadable,
} from "@telar/engine-client";
import type { SpoolWorkView } from "@/lib/spool-work";
import { writeDraft } from "@/lib/composer-draft";
import { todayDay } from "@/lib/spool-today";
import { closeItemsByHand } from "@/lib/spool-close";
import { useBriefDismiss } from "@/lib/spool-brief-dismiss";
import { Stance, SelectionBar, type StanceModel, type SettleTarget, type NeedEntry } from "@/components/spool/stance";
import { SpoolBoard } from "@/components/spool/board";
import { SpoolCalendar } from "@/components/spool/calendar";
import { SubjectFace } from "@/components/spool/tray";
import { SubjectIdentityFields } from "@/components/spool/subject-identity";
import { ConfirmDialog } from "@/components/spool/dialogs";
import { AddTaskDialog } from "@/components/spool/add-task";
import { GhostTaskRow } from "@/components/spool/task-row";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Tab = "tasks" | "board" | "calendar" | "notes" | "about";

function BriefSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-2xs font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">{title}</p>
      {children}
    </div>
  );
}

export function SubjectRoom({
  subjectKey,
  model,
  work,
  totals,
  looking,
  inventory,
  lanes,
  subjectRecords,
  onOpenItem,
  onNight,
  onPermits,
  onSuggest,
  onAck,
  onAckAll,
  onSettle,
  onSettleAll,
  onCloseItem,
  onReopenItem,
  onPinItem,
  closeNote,
  onOpenNote,
  onNewNote,
  onChanged,
  onLeaveRoom,
  onEditItem,
}: {
  subjectKey: string;
  model: StanceModel;
  work: SpoolWorkView;
  totals: { totalItems: number; agentsAdded: number; unreadable: SpoolUnreadable[] } | null;
  looking: string[];
  inventory: SpoolSubjectGroup[];
  lanes: SpoolLane[];
  subjectRecords: SpoolSubject[];
  onOpenItem: (id: string) => void;
  onNight: () => void;
  onPermits: () => void;
  onSuggest: (text: string) => void;
  onAck: (subject: string, observationId: string) => void;
  onAckAll: (subject: string, observationIds: string[]) => void;
  onSettle: (entry: SettleTarget) => void;
  onSettleAll: (entries: NeedEntry[]) => void;
  onCloseItem: (id: string) => void;
  onReopenItem: (id: string) => void;
  onPinItem: (id: string, day: string) => void;
  closeNote: string | null;
  onOpenNote: (id: string) => void;
  onNewNote: (subjectKey?: string) => void;
  onChanged: () => void | Promise<void>;
  /** "Show everything" inside the embedded Stance's focused strip — the
   *  room's own way out, back to the Lobby. */
  onLeaveRoom: () => void;
  /** §13.8 (2026-08-19)'s shared row grammar's write sink — the SAME generic
   *  item PATCH `stance.tsx`'s root already owns as `editByHand`, passed down
   *  rather than re-implemented here so there is exactly one fetch call for
   *  this route in the whole module. */
  onEditItem: (id: string, patch: Record<string, unknown>) => Promise<void>;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("tasks");
  const [brief, setBrief] = useState<SpoolBrief | null>(null);
  const [resuming, setResuming] = useState(false);
  const [resumeBlocked, setResumeBlocked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  /**
   * §13.8 (2026-08-19), "the map is content, not chrome" — the room's brief
   * shrinks to a dismissible strip so the task list, not the briefing, is the
   * room's default body. `dismissed` remembers per subject via the sanctioned
   * `useBriefDismiss` hook (`lib/spool-brief-dismiss.ts` — this room reads no
   * `localStorage` of its own, the same law `spool-area-collapse.ts` already
   * keeps for the rail's fold state); `expanded` never persists — it is
   * exactly the toggle's own visible state, reset with every subject change
   * like every other per-visit thing this room owns.
   */
  const { dismissed: briefDismissed, dismiss: dismissBrief } = useBriefDismiss(subjectKey);
  const [briefExpanded, setBriefExpanded] = useState(false);

  /**
   * THE SELECTION MODEL — §10, "the hand's verbs finally compound," now
   * owned by the room rather than the whole app: this pass folded the
   * segmented Stance/Board/Calendar posture into per-room TABS, so the
   * selection order a shift-click ranges over is naturally a fact of THIS
   * room's current tab, not a global. Selection stays view state — ids in
   * memory, nothing written, cleared by a click — and the action bar's
   * verbs are the only writes, exactly as before.
   */
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [lastPicked, setLastPicked] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNote, setBulkNote] = useState<string | null>(null);

  const loadBrief = useCallback(async () => {
    try {
      const res = await fetch(`/api/spool/subjects/${encodeURIComponent(subjectKey)}/brief?today=${encodeURIComponent(todayDay())}`);
      if (res.ok) setBrief((await res.json()).brief as SpoolBrief);
    } catch {
      // Pull-based — a dropped read leaves the last good brief up.
    }
  }, [subjectKey]);

  // NO RESET HERE. `stance.tsx` renders this component with `key={room.key}`,
  // so a walk to another subject remounts it and every field starts fresh —
  // brief, tab, expansion, and the selection state the old hand-written reset
  // did not cover. What is left is the first load, which is what an effect is
  // actually for.
  useEffect(() => {
    const first = window.setTimeout(() => void loadBrief(), 0);
    return () => window.clearTimeout(first);
  }, [loadBrief]);

  /**
   * THE PICKUP LINE'S OWN WORDS — never a bare time label wearing task
   * clothing. `SpoolFocusEntry.label` is a store-minted TIME ("Tue 12:36"),
   * not a fact about what you were doing — rendering it as "you were on
   * Tue 12:36" answers a question nobody asked. So each entry's word is,
   * in order: its own `note` ("where you left it, in your own words" —
   * the single most valuable string the focus log carries); else the
   * question or handle of the open thread it narrowed to, if the brief's
   * own open lists can resolve `threadId`; else the entry contributes
   * nothing. An entry with nothing to say drops out rather than falling
   * back to its label — an empty fact beats a timestamp dressed as one.
   */
  // NOT WRAPPED IN useMemo. The compiler could not preserve the manual
  // memoization here — `.filter((w): w is string => !!w)`'s type predicate
  // leaves it unable to prove the memo block's output is what the deps say —
  // so it skipped compiling the whole component, costing every OTHER
  // memoization in the file to keep this one. It auto-memoizes this on its
  // own, and does so for the rest of the component too.
  const pickupWords = ((): string[] => {
    if (!brief) return [];
    const openThreads = [...brief.open.stuckOnYou, ...brief.open.waitingOnOthers];
    return brief.pickup.current
      .map((e) => {
        if (e.note) return e.note;
        const thread = e.threadId ? openThreads.find((t) => t.threadId === e.threadId) : undefined;
        return thread?.handle ?? thread?.question;
      })
      .filter((w): w is string => !!w);
  })();

  /**
   * RESUME SESSION — the same briefed-arrival handoff `tray.tsx`'s
   * "Start a session" already speaks (see `ItsTurnCame`), pointed at the
   * first candidate the brief names: the item you were on, or the top of
   * "Next". Nothing runs until the human clicks send in the new session.
   */
  const candidateItemId = brief?.next[0]?.itemId;
  const resumeSession = useCallback(() => {
    if (!candidateItemId) return;
    setResuming(true);
    setResumeBlocked(null);
    void (async () => {
      try {
        const res = await fetch(`/api/spool/items/${encodeURIComponent(candidateItemId)}/briefing`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { briefing } = (await res.json()) as { briefing: SpoolBriefing };
        if (!briefing.project) {
          setResumeBlocked(`No registered project matches “${briefing.subject ?? subjectKey}”.`);
          return;
        }
        writeDraft(undefined, briefing.project.id, briefing.briefing);
        router.push(`/projects/${encodeURIComponent(briefing.project.id)}/sessions/new`);
      } catch (err) {
        setResumeBlocked(err instanceof Error ? err.message : String(err));
      } finally {
        setResuming(false);
      }
    })();
  }, [candidateItemId, router, subjectKey]);

  /** Settling a stuck-on-you open question, from the brief — the same PATCH
   *  `stance.tsx`'s own settle dialog speaks, kept local here rather than
   *  threaded through as a callback: the brief's open list is its own read,
   *  not a slice of `model`. */
  const [settling, setSettling] = useState<{ threadId: string; title: string } | null>(null);
  const [settleAnswer, setSettleAnswer] = useState("");
  const [settleBusy, setSettleBusy] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);
  const confirmSettle = () => {
    if (!settling || settleBusy) return;
    setSettleBusy(true);
    setSettleError(null);
    void fetch(`/api/spool/threads/${encodeURIComponent(subjectKey)}/${encodeURIComponent(settling.threadId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settle: { answer: settleAnswer } }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
        setSettling(null);
        await loadBrief();
        await onChanged();
      })
      .catch((err) => setSettleError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSettleBusy(false));
  };

  /** Dead items — §13.3.5's "say the word", the compost close-many. */
  const [closingDead, setClosingDead] = useState(false);
  const [deadBusy, setDeadBusy] = useState(false);
  const [deadNote, setDeadNote] = useState<string | null>(null);
  const confirmCloseDead = () => {
    if (!brief || deadBusy) return;
    setDeadBusy(true);
    void closeItemsByHand(brief.deadItems.map((d) => d.itemId))
      .then(async (sentence) => {
        setDeadNote(sentence);
        setClosingDead(false);
        await loadBrief();
        await onChanged();
      })
      .catch((err) => setDeadNote(err instanceof Error ? err.message : String(err)))
      .finally(() => setDeadBusy(false));
  };

  /** Every readable inventory row by id — the Tasks tab's transient filters
   *  resolve items against it, the same join `stance.tsx`'s room used to own. */
  const rowsById = useMemo(() => {
    const map = new Map<string, SpoolSubjectRow>();
    for (const group of inventory) for (const row of group.rows) map.set(row.item.id, row);
    return map;
  }, [inventory]);

  /**
   * TRANSIENT FILTERS — local to this room's Tasks tab, view state only,
   * never a store write and never persisted. §13's "filters become
   * transient chips above tab content with visible ✕ and one clear."
   */
  const [filter, setFilter] = useState<{ lane?: string; stuckOnMe?: boolean; unfiled?: boolean; tag?: string }>({});
  const filterOn = !!(filter.lane || filter.stuckOnMe || filter.unfiled || filter.tag);
  const stuckItemIds = useMemo(
    () => new Set(model.needs.filter((e) => e.tier === 1 && e.itemId).map((e) => e.itemId as string)),
    [model.needs],
  );
  const itemPasses = useCallback(
    (id: string): boolean => {
      if (!filterOn) return true;
      const row = rowsById.get(id);
      if (filter.lane && row?.lane !== filter.lane) return false;
      if (filter.unfiled && !(!row || !row.item.project || !row.lane)) return false;
      if (filter.tag && !(row?.item.tags ?? []).includes(filter.tag)) return false;
      if (filter.stuckOnMe && !stuckItemIds.has(id)) return false;
      return true;
    },
    [filterOn, rowsById, filter, stuckItemIds],
  );
  const entryPasses = useCallback(
    (e: StanceModel["needs"][number]): boolean => {
      if (!filterOn) return true;
      if (e.itemId) return itemPasses(e.itemId);
      if (filter.lane || filter.tag || filter.unfiled) return false;
      return !filter.stuckOnMe || e.tier === 1;
    },
    [filterOn, itemPasses, filter],
  );
  const viewModel: StanceModel = !filterOn
    ? model
    : {
        ...model,
        needs: model.needs.filter(entryPasses),
        housekeeping: model.housekeeping.filter((h) => itemPasses(h.id)),
        prepared: model.prepared
          .map((g) => ({ ...g, rows: g.rows.filter((r) => itemPasses(r.id)) }))
          .filter((g) => g.rows.length > 0),
        scheduled: {
          slipped: model.scheduled.slipped.filter((r) => itemPasses(r.id)),
          days: model.scheduled.days
            .map((d) => ({ ...d, rows: d.rows.filter((r) => itemPasses(r.id)) }))
            .filter((d) => d.rows.length > 0),
        },
      };
  const tagsInData = useMemo(
    () => [...new Set([...rowsById.values()].filter((r) => !r.item.closed).flatMap((r) => r.item.tags ?? []))].sort((a, b) => a.localeCompare(b)),
    [rowsById],
  );

  /** The current tab's own render order — what a shift-click ranges over.
   *  Only Tasks and Board carry a selection; the other two have nothing to
   *  gather. */
  const selectionOrder =
    tab === "board"
      ? lanes.flatMap((lane) => lane.items).filter((id) => {
          const row = rowsById.get(id);
          return !!row && !row.item.closed && itemPasses(id) && row.item.project === subjectKey;
        })
      : [
          ...viewModel.needs.map((e) => e.itemId).filter((id): id is string => !!id),
          ...viewModel.housekeeping.map((h) => h.id),
          ...viewModel.scheduled.slipped.map((r) => r.id),
          ...viewModel.scheduled.days.flatMap((d) => d.rows.map((r) => r.id)),
          ...viewModel.prepared.flatMap((g) => g.rows.map((r) => r.id)),
          ...viewModel.done.map((d) => d.id),
        ].filter((id, i, all) => all.indexOf(id) === i);
  const toggleSelect = (id: string, shiftKey: boolean) => {
    setSelected((prev) => {
      if (shiftKey && lastPicked && lastPicked !== id) {
        const a = selectionOrder.indexOf(lastPicked);
        const b = selectionOrder.indexOf(id);
        if (a !== -1 && b !== -1) {
          return [...new Set([...prev, ...selectionOrder.slice(Math.min(a, b), Math.max(a, b) + 1)])];
        }
      }
      return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    });
    setLastPicked(id);
  };
  const selection = selecting ? { selected: (id: string) => selected.includes(id), toggle: toggleSelect } : null;
  const clearSelection = () => {
    setSelected([]);
    setLastPicked(null);
  };
  const closeSelected = () => {
    if (bulkBusy || selected.length === 0) return;
    setBulkBusy(true);
    void closeItemsByHand(selected)
      .then(async (sentence) => {
        setBulkNote(sentence);
        clearSelection();
        await onChanged();
      })
      .catch((err) => setBulkNote(err instanceof Error ? err.message : String(err)))
      .finally(() => setBulkBusy(false));
  };
  const patchSelected = (label: string, patchOf: (id: string) => Record<string, unknown>) => {
    if (bulkBusy || selected.length === 0) return;
    setBulkBusy(true);
    void (async () => {
      const refusals: string[] = [];
      let landed = 0;
      for (const id of selected) {
        try {
          const res = await fetch(`/api/spool/items/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patchOf(id)),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
          landed += 1;
        } catch (err) {
          refusals.push(`“${err instanceof Error ? err.message : String(err)}”`);
        }
      }
      setBulkNote([`${label} ${landed} ${landed === 1 ? "item" : "items"}`, ...refusals].join("; "));
      clearSelection();
      await onChanged();
    })().finally(() => setBulkBusy(false));
  };
  const laneSelected = (lane: string) => patchSelected("moved", () => ({ lane }));
  const pinSelected = (day: string) => patchSelected("pinned", () => ({ pinned: { day } }));
  const tagSelected = (tag: string) =>
    patchSelected("tagged", (id) => {
      const existing = rowsById.get(id)?.item.tags ?? [];
      return { tags: existing.includes(tag) ? existing : [...existing, tag] };
    });

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-6">
      {/* ── THE BRIEF STRIP — §13.8 (2026-08-19), "the map is content, not
             chrome": the room's default body is its list, not its briefing.
             Collapsed, this is one or two lines (the pickup, and what moved
             since the last look); the expand toggle opens the full brief
             below it; the X dismisses the whole strip for this subject
             (remembered per subject in localStorage — the spec's own call).
             Dismissed, nothing here renders at all: "the room is just the
             list." Resume session stays reachable in both states. */}
      {!briefDismissed && (
        <div className="mb-6 space-y-1 rounded-xl bg-card px-4 py-3 shadow-1 ring-1 ring-foreground/10">
          {!brief && <p className="px-1 text-xs text-muted-foreground/60">Reading…</p>}
          {brief && (
            <>
              <div className="flex items-start justify-between gap-2 px-1">
                <button
                  type="button"
                  onClick={() => setBriefExpanded((e) => !e)}
                  aria-expanded={briefExpanded}
                  className="min-w-0 flex-1 space-y-0.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {/* FIXED 2026-08-19, §13.8: pickup entries can point at a
                      threadId the brief's own open lists don't resolve (or
                      carry no note), which left `pickupWords` empty while
                      `current.length` was still > 0 — the `null` branch this
                      used to fall to rendered an empty strip: Resume and X
                      with nothing between them. Falls back to the
                      since-your-look sentence, then to a plain admission,
                      rather than a blank shell. */}
                  {brief.pickup.current.length === 0 ? (
                    <p className="truncate text-sm text-muted-foreground">Nothing open here yet.</p>
                  ) : pickupWords.length > 0 ? (
                    <p className="truncate text-sm text-foreground">
                      You were on {pickupWords.map((w) => `“${w}”`).join(", ")}
                    </p>
                  ) : brief.sinceYourLook.digest?.[0] ? (
                    <p className="truncate text-sm text-foreground">{brief.sinceYourLook.digest[0].text}</p>
                  ) : (
                    <p className="truncate text-sm text-muted-foreground">Picked up here — nothing more to say about it yet.</p>
                  )}
                  {!briefExpanded &&
                    brief.sinceYourLook.digest?.[0] &&
                    (brief.pickup.current.length === 0 || pickupWords.length > 0) && (
                      <p className="truncate text-xs text-muted-foreground/80">{brief.sinceYourLook.digest[0].text}</p>
                    )}
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={!candidateItemId || resuming}
                    onClick={resumeSession}
                    title={!candidateItemId ? "Nothing queued to resume yet" : undefined}
                    className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors outline-none hover:border-spool/40 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
                  >
                    Resume session
                  </button>
                  <button
                    type="button"
                    onClick={dismissBrief}
                    aria-label="Dismiss the brief"
                    title="Dismiss the brief for this subject"
                    className="rounded-md p-1.5 text-muted-foreground/50 transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </div>
              </div>
              {resumeBlocked && <p className="px-1 text-xs leading-relaxed text-muted-foreground">{resumeBlocked}</p>}

              {briefExpanded && (
                <div className="space-y-4 pt-3">
                  <BriefSection title="Since your look">
                    <p className="px-1 text-xs leading-relaxed text-muted-foreground">
                      {brief.sinceYourLook.note
                        ? brief.sinceYourLook.note
                        : brief.sinceYourLook.look?.lastLooked
                          ? `${brief.sinceYourLook.look.lastLooked}${brief.sinceYourLook.fresh ? "" : " — stale"}${
                              brief.sinceYourLook.error ? ` — “${brief.sinceYourLook.error}”` : ""
                            }`
                          : "never looked yet"}
                    </p>
                    {(brief.sinceYourLook.digest ?? []).map((line, i) => (
                      <p key={i} className="px-1 text-xs leading-relaxed text-muted-foreground/80">
                        {line.text}
                      </p>
                    ))}
                  </BriefSection>

                  {(brief.open.stuckOnYou.length > 0 || brief.open.waitingOnOthers.length > 0) && (
                    <BriefSection title="Open questions">
                      <ul className="space-y-0.5">
                        {brief.open.stuckOnYou.map((t) => (
                          <li key={t.threadId} className="flex items-center gap-2 px-1 py-0.5">
                            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{t.handle?.trim() || t.question}</span>
                            <button
                              type="button"
                              onClick={() => {
                                setSettleAnswer("");
                                setSettleError(null);
                                setSettling({ threadId: t.threadId, title: t.handle?.trim() || t.question });
                              }}
                              className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors outline-none hover:border-spool/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              Settle
                            </button>
                          </li>
                        ))}
                        {brief.open.waitingOnOthers.map((t) => (
                          <li key={t.threadId} className="px-1 py-0.5 text-xs text-muted-foreground">
                            {t.handle?.trim() || t.question} — waiting on {t.who ?? "someone"}
                          </li>
                        ))}
                      </ul>
                    </BriefSection>
                  )}

                  {brief.next.length > 0 && (
                    <BriefSection title="Next">
                      <ul className="space-y-0.5">
                        {brief.next.map((n) => (
                          <li key={n.itemId}>
                            <button
                              type="button"
                              onClick={() => onOpenItem(n.itemId)}
                              className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{n.title}</span>
                              <span className="shrink-0 text-3xs text-muted-foreground/60">{n.source}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </BriefSection>
                  )}

                  {brief.notes.count > 0 && (
                    <p className="px-1 text-xs text-muted-foreground/70">
                      {brief.notes.count} {brief.notes.count === 1 ? "note" : "notes"} on the shelf
                      {brief.notes.latestTitle ? ` — latest “${brief.notes.latestTitle}”` : ""}
                    </p>
                  )}

                  {brief.deadItems.length > 0 && (
                    <p className="px-1 text-xs leading-relaxed text-muted-foreground">
                      these {brief.deadItems.length} look dead —{" "}
                      <button
                        type="button"
                        onClick={() => setClosingDead(true)}
                        className="rounded-sm underline decoration-dotted transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        say the word
                      </button>
                    </p>
                  )}
                  {deadNote && <p className="px-1 text-xs leading-relaxed text-muted-foreground">{deadNote}</p>}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── TABS ───────────────────────────────────────────────────────── */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center rounded-lg border border-border bg-muted/40 p-0.5">
          {(["tasks", "board", "calendar", "notes", "about"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={tab === option}
              onClick={() => setTab(option)}
              className={cn(
                "rounded-[7px] px-2.5 py-1 text-xs font-medium capitalize transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tab === option
                  ? "bg-background text-foreground shadow-1 ring-1 ring-foreground/10"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {(tab === "tasks" || tab === "board") && (
          <button
            type="button"
            aria-pressed={selecting}
            onClick={() => {
              setSelecting((s) => !s);
              clearSelection();
            }}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selecting
                ? "border-border bg-background text-foreground shadow-1"
                : "border-border text-muted-foreground hover:border-spool/40 hover:text-foreground",
            )}
          >
            Select
          </button>
        )}
        {tab === "notes" && (
          <button
            type="button"
            onClick={() => onNewNote(subjectKey)}
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors outline-none hover:border-spool/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            New note
          </button>
        )}
        {/* §13.8 (2026-08-19) — Tasks no longer needs this: the ghost row at
            the foot of its list is the room's own "Add a task" now. Board
            and Calendar have no row list to type into, so they keep the
            dialog. */}
        {(tab === "board" || tab === "calendar") && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors outline-none hover:border-spool/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Add a task
          </button>
        )}
      </div>

      {/* TRANSIENT FILTER CHIPS — Tasks tab only, view state, one clear. */}
      {tab === "tasks" && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-pressed={!!filter.stuckOnMe}
            onClick={() => setFilter((f) => ({ ...f, stuckOnMe: f.stuckOnMe ? undefined : true }))}
            className={cn(
              "rounded-full border px-2 py-0.5 text-2xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              filter.stuckOnMe ? "border-border bg-muted text-foreground" : "border-transparent text-muted-foreground hover:border-border",
            )}
          >
            stuck on me
          </button>
          <button
            type="button"
            aria-pressed={!!filter.unfiled}
            onClick={() => setFilter((f) => ({ ...f, unfiled: f.unfiled ? undefined : true }))}
            className={cn(
              "rounded-full border px-2 py-0.5 text-2xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              filter.unfiled ? "border-border bg-muted text-foreground" : "border-transparent text-muted-foreground hover:border-border",
            )}
          >
            unfiled
          </button>
          {lanes.map((lane) => (
            <button
              key={lane.key}
              type="button"
              aria-pressed={filter.lane === lane.key}
              onClick={() => setFilter((f) => ({ ...f, lane: f.lane === lane.key ? undefined : lane.key }))}
              className={cn(
                "rounded-full border px-2 py-0.5 text-2xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                filter.lane === lane.key ? "border-border bg-muted text-foreground" : "border-transparent text-muted-foreground hover:border-border",
              )}
            >
              {lane.label}
            </button>
          ))}
          {tagsInData.map((tag) => (
            <button
              key={tag}
              type="button"
              aria-pressed={filter.tag === tag}
              onClick={() => setFilter((f) => ({ ...f, tag: f.tag === tag ? undefined : tag }))}
              className={cn(
                "rounded-full border px-2 py-0.5 font-mono text-3xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                filter.tag === tag ? "border-border bg-muted text-foreground" : "border-transparent text-muted-foreground hover:border-border",
              )}
            >
              #{tag}
            </button>
          ))}
          {filterOn && (
            <button
              type="button"
              onClick={() => setFilter({})}
              className="ml-1 rounded-sm text-2xs text-muted-foreground/70 underline decoration-dotted transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              clear ✕
            </button>
          )}
        </div>
      )}

      {tab === "tasks" && (
        <>
          <Stance
            model={viewModel}
            work={work}
            totals={totals}
            looking={looking}
            smart={null}
            onSmart={() => undefined}
            onOpenItem={onOpenItem}
            onNight={onNight}
            onPermits={onPermits}
            onSubject={() => undefined}
            onScope={() => undefined}
            onWiden={onLeaveRoom}
            onSuggest={onSuggest}
            onAck={onAck}
            onAckAll={onAckAll}
            onSettle={onSettle}
            onSettleAll={onSettleAll}
            onCloseItem={onCloseItem}
            onReopenItem={onReopenItem}
            onPinItem={onPinItem}
            closeNote={closeNote}
            bulkNote={bulkNote}
            selection={selection}
            lanes={lanes}
            onEditItem={onEditItem}
            embedded
          />
          {/* §13.8 (2026-08-19) — the ghost row REPLACES this tab's own "Add
              a task" button (still kept for Board/Calendar below): typing
              into it and pressing Enter creates through the same route
              `AddTaskDialog` speaks, preset to this room's subject. */}
          <ul className="mt-1 overflow-hidden rounded-xl bg-card shadow-1 ring-1 ring-foreground/10">
            <GhostTaskRow
              subject={subjectKey}
              onCreated={() => {
                void onChanged();
                void loadBrief();
              }}
            />
          </ul>
        </>
      )}
      {tab === "board" && (
        <SpoolBoard
          lanes={lanes}
          groups={inventory}
          subjects={subjectRecords}
          scope={subjectKey}
          onOpenItem={onOpenItem}
          onChanged={onChanged}
          pass={itemPasses}
          selection={selection}
        />
      )}
      {tab === "calendar" && (
        <SpoolCalendar
          groups={inventory}
          subjects={subjectRecords}
          lanes={lanes}
          scope={subjectKey}
          onOpenItem={onOpenItem}
          onChanged={onChanged}
          pass={itemPasses}
        />
      )}
      {tab === "notes" && (
        <SubjectFace
          subjectKey={subjectKey}
          record={subjectRecords.find((s) => s.key === subjectKey)}
          areas={[...new Set(subjectRecords.map((s) => s.area).filter((a): a is string => !!a))]}
          onOpenItem={onOpenItem}
          onOpenNote={onOpenNote}
          onNewNote={onNewNote}
          onChanged={onChanged}
        />
      )}
      {tab === "about" && (
        // THE SUBJECT'S OWN IDENTITY FACE — the same `SubjectIdentityFields`
        // the Warehouse's Subjects tab mounts per row (`subject-identity.tsx`,
        // one definition site), so this room and the hand-management surface
        // can never disagree about what a subject's identity looks like.
        <div className="mx-auto max-w-md">
          <SubjectIdentityFields
            subjectKey={subjectKey}
            record={subjectRecords.find((s) => s.key === subjectKey)}
            areas={[...new Set(subjectRecords.map((s) => s.area).filter((a): a is string => !!a))]}
            onChanged={onChanged}
          />
        </div>
      )}

      <SelectionBar
        count={selected.length}
        lanes={lanes}
        busy={bulkBusy}
        onCloseMany={closeSelected}
        onLane={laneSelected}
        onPin={pinSelected}
        onTag={tagSelected}
        onClear={clearSelection}
      />

      <AddTaskDialog
        open={adding}
        onOpenChange={setAdding}
        subjects={[subjectKey]}
        lanes={lanes}
        defaultSubject={subjectKey}
        onCreated={() => {
          void onChanged();
          void loadBrief();
        }}
      />

      <ConfirmDialog
        open={!!settling}
        onOpenChange={(next) => !next && setSettling(null)}
        title="Settle this thread?"
        body={
          <>
            “{settling?.title ?? ""}” stays on the record, settled, with this answer — settling records what was
            found out, not that it is over:
            <Input
              value={settleAnswer}
              onChange={(event) => setSettleAnswer(event.target.value)}
              aria-label="The answer that will be recorded"
              className="mt-2 text-xs md:text-xs"
            />
          </>
        }
        confirmLabel="Settle"
        busy={settleBusy}
        error={settleError}
        onConfirm={confirmSettle}
      />

      <ConfirmDialog
        open={closingDead}
        onOpenChange={setClosingDead}
        title={`Close ${brief?.deadItems.length ?? 0} that look dead?`}
        body={
          <>
            These look dead — nothing moved, nothing pinned. Closing them is the ordinary tick, through the bulk
            route; only the hand decides they are over.
            <span className="mt-2 block space-y-1">
              {(brief?.deadItems ?? []).map((d) => (
                <span key={d.itemId} className="block truncate text-xs text-foreground">
                  “{d.title}”
                </span>
              ))}
            </span>
          </>
        }
        confirmLabel="Close them"
        busy={deadBusy}
        onConfirm={confirmCloseDead}
      />
    </div>
  );
}
