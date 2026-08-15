"use client";

/**
 * The packet detail — a work packet's ripening history, and the handoff at the
 * end of it. Ported from `apps/web_old/components/workspace/packet-view.tsx`.
 *
 * ONE READ joins the item with its RECONCILED lane and rank and its attachment
 * tally, so the lane this page names is the one the stacks actually put it in
 * rather than the packet's own recovery hint.
 *
 * TWO DEPARTURES FROM THE CONTRACT, both named in `docs/spool-port.md`:
 *
 *   1. THE HANDOFF HAS ONE PATH, NOT TWO. CAP-11 gives a packet a loom and a
 *      session as EQUAL-WEIGHT choices, and there are no looms in this app. The
 *      loom button is removed rather than disabled — a filled primary that never
 *      responds is a worse lie than an absence — and so is the verdict that
 *      existed to advise between them.
 *   2. "START A SESSION" RESOLVES A PROJECT FIRST. A packet's `project` is a
 *      free-form label; a session needs a registered project id. The button
 *      enables only when one matches, and says which of the two reasons it is
 *      unavailable when none does.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeftIcon,
  FileTextIcon,
  LayoutTemplateIcon,
  Loader2Icon,
  MessageSquareIcon,
  MoonIcon,
  MoveRightIcon,
  PlusIcon,
  RotateCwIcon,
  SparklesIcon,
  StickyNoteIcon,
  TriangleAlertIcon,
  UserIcon,
} from "lucide-react";
import type { Project, SpoolActor, SpoolItemDetail } from "@telar/engine-client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { DeadlineChip, ProjectChip } from "@/components/spool/chips";
import { writeDraft } from "@/lib/composer-draft";
import { spoolBriefing } from "@/lib/spool-briefing";
import { cn } from "@/lib/utils";

const ACTOR_META: Record<SpoolActor, { Icon: typeof UserIcon; label: string }> = {
  you: { Icon: UserIcon, label: "you" },
  expert: { Icon: SparklesIcon, label: "expert" },
  bed: { Icon: MoonIcon, label: "bed mode" },
  session: { Icon: FileTextIcon, label: "session" },
};

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
  return data;
}

function BackLink() {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground"
      render={<Link href="/spool" aria-label="Back to the queue" />}
    >
      <ArrowLeftIcon className="size-4" />
    </Button>
  );
}

/** The app's section label: small, medium (NOT semibold — that is the group
 *  header's register, one level up), uppercase, wide tracking. */
function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="mb-2 text-[10px] font-medium tracking-wider text-muted-foreground/70 uppercase">{children}</h2>;
}

/**
 * "Its turn came" — the single-packet handoff.
 *
 * THE TWO PATHS WERE EQUAL WEIGHT, and the layout said so: a filled primary for
 * the loom, an OUTLINED button of the same width for the session, and a quiet
 * third that was neither. The spec's word is "instead", not "otherwise" — a
 * session is where most packets should go, and rendering it as a fallback would
 * push every small thing through a loom.
 *
 * TODAY THERE IS ONE PATH, so the session takes the primary — and the word
 * "instead" came off the label with the loom, because there is no longer
 * anything for it to be instead OF. Both come back together: when the loom
 * returns it takes the primary, the session returns to the outline, and the word
 * returns with it. The hierarchy is the contract's, not this file's to keep.
 *
 * NOTHING RUNS UNTIL A HUMAN CLICKS, and the caption under the buttons says so.
 */
function ItsTurnCame({ detail, projects }: { detail: SpoolItemDetail; projects: Project[] }) {
  const router = useRouter();
  const { item } = detail;

  // A packet's `project` is a free-form label; a session needs a registered id.
  // Matched on the NAME first — that is what a human would have typed into the
  // packet — then on the id, for a caller that already knew it.
  const project = useMemo(
    () => projects.find((p) => p.name === item.project) ?? projects.find((p) => p.id === item.project),
    [projects, item.project],
  );

  const startSession = useCallback(() => {
    if (!project) return;
    // Seeded into the composer's own draft key and then navigated to: no new
    // endpoint, no server round trip, and the text is visible and editable
    // before a single token is spent.
    writeDraft(undefined, project.id, spoolBriefing({ ...item, attachments: detail.tally }));
    router.push(`/projects/${encodeURIComponent(project.id)}/sessions/new`);
  }, [detail.tally, item, project, router]);

  const sessionBlocked = !item.project
    ? "This packet is floating — file it to a project first, and a session can open there."
    : !project
      ? `No registered project matches “${item.project}”. Register it, or rename the packet's project to match one.`
      : undefined;

  return (
    <section className="space-y-2">
      <SectionLabel>Its turn came</SectionLabel>
      {/* ONE PATH, NOT TWO. The contract gives a packet two equal-weight
          handoffs — a loom and a session — and the loom half is gone with looms.
          It is REMOVED rather than disabled: a filled primary that never
          responds is a worse lie than an absence. Issue #93 names this as the
          place it comes back. */}
      <Button className="w-full" disabled={!!sessionBlocked} title={sessionBlocked} onClick={startSession}>
        <MessageSquareIcon />
        Start a session
      </Button>
      <Button variant="ghost" size="sm" className="w-full" render={<Link href="/spool" />}>
        Not now — back to the stack
      </Button>
      <p className="pt-1 text-center text-[10px] leading-relaxed text-muted-foreground/60">
        everything above was prepared by agents —
        <br />
        nothing runs until you click
      </p>
    </section>
  );
}

export function PacketView({ id }: { id: string }) {
  const [detail, setDetail] = useState<SpoolItemDetail | null | undefined>(undefined);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newSubtask, setNewSubtask] = useState("");
  /** A consultation's own state, separate from `busy`. It is the one action here
   *  that takes minutes rather than milliseconds, so it needs its own label and
   *  its own refusal line — a refusal is an ANSWER and belongs on the page, not
   *  in an alert that disappears. */
  const [consulting, setConsulting] = useState(false);
  const [consultNote, setConsultNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/spool/items/${encodeURIComponent(id)}`);
      if (res.status === 404) return setDetail(null);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDetail(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    // Deferred to a task rather than called in the effect body — a synchronous
    // fetch-and-setState on mount is a cascading render.
    const first = window.setTimeout(() => {
      void load();
      void fetch("/api/projects")
        .then((r) => (r.ok ? r.json() : { projects: [] }))
        .then((d) => setProjects(d.projects ?? []))
        .catch(() => setProjects([]));
    }, 0);
    return () => window.clearTimeout(first);
  }, [load]);

  const mutate = useCallback(
    async (work: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await work();
        await load();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  /**
   * ASK THE PROJECT'S EXPERT TO READ THIS ITEM.
   *
   * NOT ROUTED THROUGH `mutate`. That helper reports failure with `alert()`,
   * which is right for a sub-task write that either worked or did not, and wrong
   * here: every refusal this returns is a sentence naming the next move
   * ("file it into a project first"), and a modal the user dismisses is where a
   * sentence goes to die. It lands under the button instead and stays there.
   */
  const consult = useCallback(() => {
    setConsulting(true);
    setConsultNote(null);
    void (async () => {
      try {
        const outcome = await send(`/api/spool/items/${encodeURIComponent(id)}/expert`, "POST");
        if (outcome?.ok === false) {
          setConsultNote(outcome.reason);
          return;
        }
        // COLD IS REPORTED, not inferred: a first pass had no memory of this
        // project, and saying so is the difference between an honest surface and
        // one implying context the expert never had.
        setConsultNote(
          outcome?.cold
            ? "First pass — the expert had no memory of this project and has now written one."
            : null,
        );
        await load();
      } catch (err) {
        setConsultNote(err instanceof Error ? err.message : String(err));
      } finally {
        setConsulting(false);
      }
    })();
  }, [id, load]);

  const addSubtask = useCallback(() => {
    const title = newSubtask.trim();
    if (!title) return;
    void mutate(async () => {
      await send(`/api/spool/items/${id}/subtasks`, "POST", { title });
      setNewSubtask("");
    });
  }, [id, mutate, newSubtask]);

  if (detail === undefined && !error) {
    return (
      <div className="flex h-dvh flex-col">
        <PageHeader leading={<BackLink />} title="Packet" description="Loading…" />
        {/* Laid out on the REAL grid so nothing jumps sideways when the packet
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

  if (detail === null) {
    return (
      <div className="flex h-dvh flex-col">
        <PageHeader leading={<BackLink />} title="Packet" />
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            icon={TriangleAlertIcon}
            title="This item isn't in the spool"
            description="The id in the address may be wrong. Nothing here deletes an item, so it has not been removed."
            action={
              <Button variant="outline" size="sm" render={<Link href="/spool" />}>
                Back to the queue
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  if (!detail) {
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

  const { item } = detail;
  const subtasks = item.subtasks ?? [];
  const timeline = item.timeline ?? [];
  const hasBorn = !!(item.raw || item.fixed);

  return (
    <div className="flex h-dvh flex-col">
      <PageHeader
        leading={<BackLink />}
        title={item.title}
        description={detail.lane ? `filed in ${detail.lane} · rank ${detail.rank}` : "not filed in any lane — on the desk"}
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          {/* A refresh that fails AFTER the packet is on screen surfaces here,
              while the last good read stays readable underneath — a stale packet
              that silently stopped updating is the worse failure. */}
          {error && (
            <Alert variant="destructive" className="mb-4">
              <TriangleAlertIcon />
              <AlertTitle>Refresh failed</AlertTitle>
              <AlertDescription className="font-mono text-xs break-words">{error}</AlertDescription>
            </Alert>
          )}

          <div className="mb-6 flex flex-wrap items-center gap-1.5">
            <ProjectChip name={item.project} mirrored={item.mirrored} />
            {item.deadline && <DeadlineChip deadline={item.deadline} />}
          </div>

          <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
            <div className="min-w-0 space-y-6">
              {hasBorn && (
                <section>
                  <SectionLabel>Born as</SectionLabel>
                  {/* THE RAW FRAGMENT, VERBATIM, ABOVE THE BRIEF THAT REPLACED
                      IT. Keeping the two side by side is load-bearing: it is what
                      lets the user check the expert did not drift from what they
                      meant. No write path in the store can overwrite it. */}
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

              {(detail.tally.files > 0 || detail.tally.mockups > 0) && (
                <section>
                  <SectionLabel>Gathered along the way</SectionLabel>
                  <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <FileTextIcon className="size-4 shrink-0" />
                      <span className="font-mono tabular-nums">{detail.tally.files}</span> file
                      {detail.tally.files === 1 ? "" : "s"}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <LayoutTemplateIcon className="size-4 shrink-0" />
                      <span className="font-mono tabular-nums">{detail.tally.mockups}</span> mockup
                      {detail.tally.mockups === 1 ? "" : "s"}
                    </span>
                  </div>
                </section>
              )}

              <section>
                <SectionLabel>Sub-tasks</SectionLabel>
                <p className="mb-2 text-[11px] text-muted-foreground/60">
                  Breakdown lives inside this item — it never grows the queue count.
                </p>
                <div className="space-y-1.5">
                  {subtasks.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm transition-colors hover:bg-muted/40"
                    >
                      <input
                        type="checkbox"
                        checked={!!s.done}
                        disabled={busy}
                        onChange={(e) =>
                          void mutate(() =>
                            send(`/api/spool/items/${id}/subtasks/${s.id}`, "PATCH", { done: e.target.checked }),
                          )
                        }
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
                        onClick={() => {
                          if (!confirm("Promote this sub-task to an item of its own?")) return;
                          void mutate(() => send(`/api/spool/items/${id}/subtasks/${s.id}/promote`, "POST"));
                        }}
                        className="shrink-0 text-[10px] text-muted-foreground/70 underline decoration-dotted transition-colors hover:text-foreground"
                      >
                        promote
                      </button>
                    </div>
                  ))}
                  {subtasks.length === 0 && <p className="text-xs text-muted-foreground/60">No sub-tasks yet.</p>}
                  <div className="flex items-center gap-2 pt-1">
                    <Input
                      value={newSubtask}
                      onChange={(e) => setNewSubtask(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addSubtask();
                      }}
                      placeholder="Break off a sub-task…"
                      aria-label="Break off a sub-task"
                      className="text-xs md:text-xs"
                    />
                    <Button variant="outline" size="sm" disabled={busy || !newSubtask.trim()} onClick={addSubtask}>
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
                      const { Icon, label } = ACTOR_META[ev.actor] ?? { Icon: UserIcon, label: ev.actor };
                      const last = i === timeline.length - 1;
                      return (
                        <div key={`${ev.at}-${i}`} className="relative flex gap-3 pb-4">
                          {/* The rail BETWEEN nodes is an internal divider, one
                              step behind the node rings it connects. */}
                          {!last && <span className="absolute top-5 bottom-0 left-[9px] w-px bg-border/70" />}
                          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-card">
                            <Icon className="size-2.5 text-muted-foreground" />
                          </span>
                          <div className="min-w-0 text-xs">
                            <p className="font-mono text-[10px] text-muted-foreground/60 tabular-nums">
                              {ev.at} · {label}
                              {/* THE HONESTY MARKER: one word saying an agent
                                  wrote this and nobody has looked. It is not the
                                  faintest thing on the node, which is where it
                                  started and was exactly backwards. */}
                              {ev.proposal && <span className="text-muted-foreground/70"> · proposal</span>}
                            </p>
                            <p className="mt-0.5 leading-snug text-foreground">{ev.text}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* THE ONE THING ON THIS PAGE THAT SPENDS MONEY, so it is a
                    quiet outline rather than a filled button, and it sits at the
                    END of the ripening history because that is what it extends —
                    it is not a control panel above the timeline.

                    Its refusal renders HERE, under the button, and stays: every
                    one of them names the next move, and the surface that asked
                    the question is where the answer belongs. */}
                <div className="mt-2 space-y-2 border-t border-border/70 pt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled={consulting || busy}
                    onClick={consult}
                  >
                    {consulting ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
                    {consulting ? "Reading…" : "Ask the expert"}
                  </Button>
                  <p className="text-[10px] leading-relaxed text-muted-foreground/60">
                    {item.project
                      ? `The ${item.project} expert rewrites the brief and remembers what it learned. It changes nothing else.`
                      : "An expert belongs to a project. File this item into one first."}
                  </p>
                  {consultNote && (
                    <p className="rounded-md bg-muted/60 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
                      {consultNote}
                    </p>
                  )}
                </div>
              </section>
              {/* The handoff sits UNDER the ripening timeline on purpose: "its
                  turn came" is the end of that history, not a control panel above
                  it. The VERDICT used to sit between them — the last thing the
                  ripening produced and the thing the handoff choice read — and it
                  went out with looms. */}
              <ItsTurnCame detail={detail} projects={projects} />
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
