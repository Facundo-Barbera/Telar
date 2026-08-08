"use client";

// The packet-detail surface (CAP-6: a work packet's ripening history). One
// GET /api/workspace/items/[id] (lib/workspace-api's getPacketView) joins the
// item with its RECONCILED lane/rank and its attachment tally.
//
// SCOPE, NARROWER THAN THE DEMO SOURCE
// (lib/demo-gallery/workspace/packet.tsx, never imported — hand-ported by eye
// per that directory's rule 7). The demo's "Its turn came" section IS here now
// (story 5.5 / CAP-11: "a single ripened packet handed to a session, and a
// selected batch woven as one loom") — see ItsTurnCame below, which is where
// `Item.tracking` finally gets its writer. Attachments here show real counts
// only (files/mockups) — the demo's
// per-attachment titles and descriptions are fixture data this store has no
// field for; a dropped file carries a name and an extension, nothing more.
//
// TOKEN/CHROME SWEEP (this pass, no data behaviour touched): the hand-ported
// chrome was replaced with the shared primitives it was imitating — the back
// anchor is `Button variant=ghost size=icon-sm` rendering a Link, the
// sub-task composer is `components/ui/input`, and a refresh that fails with a
// packet already on screen now raises the shared destructive `Alert` instead
// of setting state nothing reads. Off-scale values were pulled onto the token
// scale: `font-semibold` section labels → `font-medium` (ultra-rail's
// register), `text-foreground/80` and `/85` → `text-foreground`,
// `bg-muted-foreground/50` → `/60`, `text-muted-foreground/40` → `/70`, row
// cards `rounded-lg` → `rounded-md`, internal rules → `border-border/70`.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  FileTextIcon,
  LayoutTemplateIcon,
  MessageSquareIcon,
  MoonIcon,
  MoveRightIcon,
  PlusIcon,
  RotateCwIcon,
  SparklesIcon,
  StickyNoteIcon,
  TriangleAlertIcon,
  UserIcon,
  WorkflowIcon,
} from "lucide-react";
import type { PacketActor } from "@telar/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { DetachReceipt } from "@/components/common/detach-receipt";
import { cn } from "@/lib/utils";
import { dispatchTelarRefresh } from "@/lib/telar-refresh";
import { trackedDetachReceipt, type DetachReceipt as DetachReceiptData } from "@/lib/detach-receipt";
import { sessionBriefing } from "@/lib/session-briefing";
import { seedNewSessionDraft } from "@/components/session/composer-draft";
import { newSessionHref } from "@/lib/session-list";
import { DeadlineChip, ProjectChip, VerdictChip } from "@/components/workspace/chips";
import type { PacketView as PacketViewData } from "@/lib/workspace-api";

const ACTOR_META: Record<PacketActor, { Icon: typeof UserIcon; label: string }> = {
  you: { Icon: UserIcon, label: "you" },
  expert: { Icon: SparklesIcon, label: "expert" },
  bed: { Icon: MoonIcon, label: "bed mode" },
  session: { Icon: FileTextIcon, label: "session" },
};

async function postJson(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// The back affordance is the shared Button (ghost / icon-sm) rendering a Link,
// not a hand-rolled anchor that re-spells ghost's hover and icon-sm's box. Same
// focus ring, same active nudge, same disabled semantics as every other icon
// button in the app — and one fewer copy of `hover:bg-muted` to drift.
function BackLink() {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground"
      render={<Link href="/workspace" aria-label="Back to the queue" />}
    >
      <ArrowLeftIcon className="size-4" />
    </Button>
  );
}

// The app's section label: 10px, medium (NOT semibold — semibold is the
// GroupHeader's register, one level up), uppercase, wide tracking, muted/70.
// Identical to ultra-rail.tsx's "Workflows" and its "Done ·" group heading,
// which is what makes a packet's columns read as the same system as a rail's.
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
      {children}
    </h2>
  );
}

// ── "Its turn came" (story 5.5 / CAP-11, the single-packet handoff) ─────────
//
// THE TWO PATHS ARE EQUAL WEIGHT, and the demo's own layout says so: a filled
// primary for the loom, an OUTLINED button of the same width for the session,
// and a quiet third that is neither. The spec's word is "instead", not
// "otherwise" — a session is where most packets should go, and a surface that
// renders it as a fallback would push every small thing through a loom.
//
// NOTHING RUNS UNTIL A HUMAN CLICKS. The weave POSTs to /api/workspace/weave,
// which plans a DRAFT loom (never startLoomFromBundle) — so even this click
// spends nothing; the loom's own start is a second human decision, taken on the
// loom side ("Continue planning" on the loom page, which opens the Loom Session
// bound to this draft, where the contract is written and start_loom is
// approved). The caption under the buttons is the demo's, kept verbatim because
// it is the honest description of everything above it.
function ItsTurnCame({ view, onWoven }: { view: PacketViewData; onWoven: () => void }) {
  const router = useRouter();
  const { item } = view;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The receipt the POST returned, when it was this mount that wove.
  const [receipt, setReceipt] = useState<DetachReceiptData | null>(null);

  // ON A LATER VISIT THE TALLY IS GONE, AND IS NOT GUESSED. Only this mount's
  // own response knows what the loom was handed; the packet's fields are what
  // they are TODAY, so re-deriving "premise = the fixed brief · context = 2
  // attachments" from them would let an edit made after the weave rewrite what
  // the receipt says the loom received. trackedDetachReceipt drops those two
  // segments and keeps the two that are still true (detach-receipt.ts).
  const tracked = item.tracking
    ? (receipt ?? trackedDetachReceipt(item.tracking.loomId, 1))
    : receipt;

  const weave = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await postJson("/api/workspace/weave", "POST", { itemIds: [item.id] });
      setReceipt(res.receipt as DetachReceiptData);
      // The row does NOT leave the queue — it now carries a tracking mark, and
      // the queue re-reads to show it (CAP-11: it leaves when the loom lands
      // and the human accepts, neither of which happens here).
      dispatchTelarRefresh({ domains: ["workspace"] });
      onWoven();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [item.id, onWoven]);

  // The session path hands the briefing to the composer through THAT module's
  // own seeding verb (components/session/composer-draft.tsx owns the key, the
  // replace prompt and the already-mounted case) and then navigates — no new
  // endpoint, no server round-trip, and the text is visible and editable in the
  // composer before a single token is spent.
  const startSession = useCallback(() => {
    if (!item.project) return;
    seedNewSessionDraft(item.project, sessionBriefing({ ...item, attachments: view.attachments }));
    router.push(newSessionHref(item.project));
  }, [item, router, view.attachments]);

  return (
    <section className="space-y-2">
      <SectionLabel>Its turn came</SectionLabel>
      {tracked ? (
        <>
          <DetachReceipt receipt={tracked} />
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            render={<Link href={`/looms/${item.tracking?.loomId ?? tracked.loomId}`} />}
          >
            <ExternalLinkIcon />
            Open the loom
          </Button>
        </>
      ) : (
        <>
          {error && (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>Nothing was woven</AlertTitle>
              <AlertDescription className="text-xs break-words">{error}</AlertDescription>
            </Alert>
          )}
          <Button className="w-full" disabled={busy} onClick={() => void weave()}>
            <WorkflowIcon />
            Plan loom from this packet
          </Button>
          <Button
            variant="outline"
            className="w-full"
            disabled={busy || !item.project}
            title={
              item.project
                ? undefined
                : "This packet is floating — file it to a project first, and a session can open there."
            }
            onClick={startSession}
          >
            <MessageSquareIcon />
            Start a session instead
          </Button>
          <Button variant="ghost" size="sm" className="w-full" render={<Link href="/workspace" />}>
            Not now — back to the stack
          </Button>
          <p className="pt-1 text-center text-[10px] leading-relaxed text-muted-foreground/60">
            everything above was prepared by agents —
            <br />
            nothing runs until you click
          </p>
        </>
      )}
    </section>
  );
}

export function PacketView({ id }: { id: string }) {
  const [view, setView] = useState<PacketViewData | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newSubtask, setNewSubtask] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspace/items/${id}`);
      if (res.status === 404) {
        setView(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setView(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onRefresh = (e: Event) => {
      const detail = (e as CustomEvent<{ domains?: readonly string[] } | undefined>).detail;
      if (!detail?.domains || detail.domains.includes("workspace")) void load();
    };
    window.addEventListener("telar:refresh", onRefresh);
    return () => window.removeEventListener("telar:refresh", onRefresh);
  }, [load]);

  const addSubtask = useCallback(async () => {
    const title = newSubtask.trim();
    if (!title) return;
    setBusy(true);
    try {
      await postJson(`/api/workspace/items/${id}/subtasks`, "POST", { title });
      setNewSubtask("");
      dispatchTelarRefresh({ domains: ["workspace"] });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [id, newSubtask]);

  const toggleSubtask = useCallback(
    async (subtaskId: string, done: boolean) => {
      setBusy(true);
      try {
        await postJson(`/api/workspace/items/${id}/subtasks/${subtaskId}`, "PATCH", { done });
        dispatchTelarRefresh({ domains: ["workspace"] });
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [id],
  );

  // NFR-OW-15's one door: a human's own click, in this view alone.
  const promoteSubtask = useCallback(
    async (subtaskId: string) => {
      if (!confirm("Promote this sub-task to its own item on the desk?")) return;
      setBusy(true);
      try {
        await postJson(`/api/workspace/items/${id}/subtasks/${subtaskId}/promote`, "POST");
        dispatchTelarRefresh({ domains: ["workspace"] });
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [id],
  );

  if (view === undefined && !error) {
    return (
      <div className="flex h-dvh flex-col">
        <PageHeader leading={<BackLink />} title="Packet" description="Loading…" />
        {/* Skeleton laid out on the REAL grid (chips row, then the two columns
            at their settled widths) so nothing jumps sideways when the packet
            arrives — the same reason the queue's skeleton wears a lane card. */}
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          <div className="mb-6 flex flex-wrap items-center gap-1.5">
            <Skeleton className="h-5 w-20 rounded-md" />
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
          <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
            <div className="min-w-0 space-y-6">
              <Skeleton className="h-24 w-full rounded-lg" />
              <Skeleton className="h-32 w-full rounded-lg" />
            </div>
            <Skeleton className="h-40 w-full rounded-lg" />
          </div>
        </div>
      </div>
    );
  }

  if (view === null) {
    return (
      <div className="flex h-dvh flex-col">
        <PageHeader leading={<BackLink />} title="Packet" />
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            icon={TriangleAlertIcon}
            title="This item isn't in the workspace"
            description="It may have been retired, or the id in the address is wrong."
            action={
              <Button variant="outline" size="sm" render={<Link href="/workspace" />}>
                Back to the queue
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="flex h-dvh flex-col">
        <PageHeader leading={<BackLink />} title="Packet" />
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            icon={TriangleAlertIcon}
            iconClassName="text-destructive/60"
            title="Couldn't load this packet"
            description={<span className="font-mono text-xs break-words">{error}</span>}
            action={
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RotateCwIcon />
                Retry
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const { item } = view;
  const subtasks = item.subtasks ?? [];
  const timeline = item.timeline ?? [];
  const hasBorn = !!(item.raw || item.fixed);

  return (
    <div className="flex h-dvh flex-col">
      <PageHeader
        leading={<BackLink />}
        title={item.title}
        description={
          view.lane
            ? `filed in ${view.lane} · rank ${view.rank}`
            : "not filed in any lane — on the desk"
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          {/* A refresh that fails AFTER the packet is on screen used to set
              `error` and render nothing — the stale packet just stopped
              updating, silently. It surfaces as the shared destructive Alert
              now, the same treatment queue-view gives the same failure, while
              the last good read stays readable underneath. */}
          {error && (
            <Alert variant="destructive" className="mb-4">
              <TriangleAlertIcon />
              <AlertTitle>Refresh failed</AlertTitle>
              <AlertDescription className="font-mono text-xs break-words">
                {error}
              </AlertDescription>
            </Alert>
          )}

          <div className="mb-6 flex flex-wrap items-center gap-1.5">
            <ProjectChip name={item.project} mirrored={item.mirrored} />
            {item.deadline && <DeadlineChip deadline={item.deadline} />}
            {item.verdict && <VerdictChip verdict={item.verdict} />}
          </div>

          <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
            <div className="min-w-0 space-y-6">
              {hasBorn && (
                <section>
                  <SectionLabel>Born as</SectionLabel>
                  {item.raw && (
                    <div className="rounded-lg border border-border bg-muted/40 p-3">
                      {item.rawSource && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <StickyNoteIcon className="size-3.5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{item.rawSource}</span>
                        </div>
                      )}
                      <p className="mt-2 font-mono text-sm text-foreground">{item.raw}</p>
                    </div>
                  )}
                  {item.fixed && (
                    <>
                      {item.raw && (
                        <div className="my-2 flex items-center gap-2 pl-3 text-[11px] text-muted-foreground/60">
                          <MoveRightIcon className="size-3.5 rotate-90" />
                          fixed
                        </div>
                      )}
                      <div className="rounded-lg border border-border bg-card p-3">
                        <p className="text-sm leading-relaxed">{item.fixed}</p>
                        {item.acceptance && item.acceptance.length > 0 && (
                          <ul className="mt-3 space-y-1 border-t border-border/70 pt-2">
                            {item.acceptance.map((a) => (
                              <li key={a} className="flex items-start gap-2 text-xs text-muted-foreground">
                                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/60" />
                                {a}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </>
                  )}
                </section>
              )}

              {(view.attachments.files > 0 || view.attachments.mockups > 0) && (
                <section>
                  <SectionLabel>Gathered along the way</SectionLabel>
                  <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <FileTextIcon className="size-4 shrink-0" />
                      <span className="font-mono tabular-nums">{view.attachments.files}</span> file
                      {view.attachments.files === 1 ? "" : "s"}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <LayoutTemplateIcon className="size-4 shrink-0" />
                      <span className="font-mono tabular-nums">{view.attachments.mockups}</span>{" "}
                      mockup
                      {view.attachments.mockups === 1 ? "" : "s"}
                    </span>
                  </div>
                </section>
              )}

              <section>
                <SectionLabel>Sub-tasks</SectionLabel>
                <p className="mb-2 text-[11px] text-muted-foreground/60">
                  Breakdown lives inside this item — it never grows the queue count (NFR-OW-3).
                </p>
                <div className="space-y-1.5">
                  {subtasks.map((s) => (
                    <div
                      key={s.id}
                      // rounded-md, not rounded-lg: this is a ROW, and the
                      // idiom reserves lg+ for containers. Hover matches the
                      // queue's row treatment so the same sub-task feels the
                      // same in both places.
                      className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm transition-colors hover:bg-muted/40"
                    >
                      <input
                        type="checkbox"
                        checked={!!s.done}
                        disabled={busy}
                        onChange={(e) => void toggleSubtask(s.id, e.target.checked)}
                        className="size-3.5 shrink-0 rounded-sm border-border accent-primary"
                      />
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate",
                          s.done ? "text-muted-foreground/60 line-through" : "text-foreground",
                        )}
                      >
                        {s.title}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void promoteSubtask(s.id)}
                        className="shrink-0 text-[10px] text-muted-foreground/70 underline decoration-dotted transition-colors hover:text-foreground"
                      >
                        promote
                      </button>
                    </div>
                  ))}
                  {subtasks.length === 0 && (
                    <p className="text-xs text-muted-foreground/60">No sub-tasks yet.</p>
                  )}
                  <div className="flex items-center gap-2 pt-1">
                    {/* The shared Input primitive, not a re-spelling of it: the
                        hand-rolled field had its own ring geometry
                        (`focus:ring-2 ring-ring/30` vs the system's
                        `focus-visible:ring-3 ring-ring/50`) and its own border
                        token, so this one field focused differently from every
                        other field in the app. */}
                    <Input
                      value={newSubtask}
                      onChange={(e) => setNewSubtask(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void addSubtask();
                      }}
                      placeholder="Break off a sub-task…"
                      aria-label="Break off a sub-task"
                      className="text-xs md:text-xs"
                    />
                    <Button variant="outline" size="sm" disabled={busy || !newSubtask.trim()} onClick={() => void addSubtask()}>
                      <PlusIcon />
                      Add
                    </Button>
                  </div>
                </div>
              </section>
            </div>

            <aside className="space-y-6">
              <section>
                <SectionLabel>Ripening</SectionLabel>
                {timeline.length === 0 ? (
                  <p className="font-mono text-[10px] text-muted-foreground/60">
                    {item.captured} · {item.provenance}
                  </p>
                ) : (
                  <div className="space-y-0">
                    {timeline.map((ev, i) => {
                      const meta = ACTOR_META[ev.actor] ?? { Icon: UserIcon, label: ev.actor };
                      const { Icon, label } = meta;
                      const last = i === timeline.length - 1;
                      return (
                        <div key={`${ev.at}-${i}`} className="relative flex gap-3 pb-4">
                          {/* border-border/70: the rail BETWEEN nodes is an
                              internal divider, one step behind the node rings
                              it connects — same relationship the lane card's
                              hairlines have to its own edge. */}
                          {!last && (
                            <span className="absolute top-5 bottom-0 left-[9px] w-px bg-border/70" />
                          )}
                          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-card">
                            <Icon className="size-2.5 text-muted-foreground" />
                          </span>
                          <div className="min-w-0 text-xs">
                            <p className="font-mono text-[10px] text-muted-foreground/60 tabular-nums">
                              {ev.at} · {label}
                              {/* /70, up from an off-scale /40. The suffix is
                                  the honesty marker ui-contract.md's invariant
                                  6 demands ("proposals are visibly dashed") —
                                  it was the faintest thing on the node, which
                                  is exactly backwards for the one word saying
                                  an agent wrote this and nobody has looked. */}
                              {ev.proposal && (
                                <span className="text-muted-foreground/70"> · proposal</span>
                              )}
                            </p>
                            <p className="mt-0.5 leading-snug text-foreground">{ev.text}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
              {/* The handoff sits UNDER the ripening timeline on purpose: the
                  demo's own order, and the honest one — "its turn came" is the
                  end of that history, not a control panel above it. */}
              <ItsTurnCame view={view} onWoven={() => void load()} />
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
