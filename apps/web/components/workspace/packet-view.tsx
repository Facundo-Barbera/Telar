"use client";

// The packet-detail surface (CAP-6: a work packet's ripening history). One
// GET /api/workspace/items/[id] (lib/workspace-api's getPacketView) joins the
// item with its RECONCILED lane/rank and its attachment tally.
//
// SCOPE, NARROWER THAN THE DEMO SOURCE
// (lib/demo-gallery/workspace/packet.tsx, never imported — hand-ported by eye
// per that directory's rule 7). The demo's "Its turn came" section ("Plan
// loom from this packet" / "Start a session instead") is the WEAVE — the
// item's `tracking` field is explicitly "set at weave (story 5.5)" per
// schema.ts's own comment, so that handoff is a later story's capability, not
// CAP-6. Attachments here show real counts only (files/mockups) — the demo's
// per-attachment titles and descriptions are fixture data this store has no
// field for; a dropped file carries a name and an extension, nothing more.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  FileTextIcon,
  LayoutTemplateIcon,
  MoonIcon,
  MoveRightIcon,
  PlusIcon,
  SparklesIcon,
  StickyNoteIcon,
  TriangleAlertIcon,
  UserIcon,
} from "lucide-react";
import type { PacketActor } from "@telar/core";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { cn } from "@/lib/utils";
import { dispatchTelarRefresh } from "@/lib/telar-refresh";
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

function BackLink() {
  return (
    <Link
      href="/workspace"
      aria-label="Back to the queue"
      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" />
    </Link>
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
        <div className="mx-auto w-full max-w-5xl space-y-3 px-6 py-8">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
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
          <div className="mb-6 flex flex-wrap items-center gap-1.5">
            <ProjectChip name={item.project} mirrored={item.mirrored} />
            {item.deadline && <DeadlineChip deadline={item.deadline} />}
            {item.verdict && <VerdictChip verdict={item.verdict} />}
          </div>

          <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
            <div className="min-w-0 space-y-6">
              {hasBorn && (
                <section>
                  <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    Born as
                  </h2>
                  {item.raw && (
                    <div className="rounded-lg border border-border bg-muted/30 p-3">
                      {item.rawSource && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <StickyNoteIcon className="size-3.5" /> {item.rawSource}
                        </div>
                      )}
                      <p className="mt-2 font-mono text-sm text-foreground/80">{item.raw}</p>
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
                          <ul className="mt-3 space-y-1 border-t border-border pt-2">
                            {item.acceptance.map((a) => (
                              <li key={a} className="flex items-start gap-2 text-xs text-muted-foreground">
                                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
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
                  <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    Gathered along the way
                  </h2>
                  <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <FileTextIcon className="size-4" /> {view.attachments.files} file
                      {view.attachments.files === 1 ? "" : "s"}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <LayoutTemplateIcon className="size-4" /> {view.attachments.mockups} mockup
                      {view.attachments.mockups === 1 ? "" : "s"}
                    </span>
                  </div>
                </section>
              )}

              <section>
                <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  Sub-tasks
                </h2>
                <p className="mb-2 text-[11px] text-muted-foreground/60">
                  Breakdown lives inside this item — it never grows the queue count (NFR-OW-3).
                </p>
                <div className="space-y-1.5">
                  {subtasks.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={!!s.done}
                        disabled={busy}
                        onChange={(e) => void toggleSubtask(s.id, e.target.checked)}
                        className="size-3.5 shrink-0 rounded border-border"
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
                        className="shrink-0 text-[10px] text-muted-foreground/70 underline decoration-dotted hover:text-foreground"
                      >
                        promote
                      </button>
                    </div>
                  ))}
                  {subtasks.length === 0 && (
                    <p className="text-xs text-muted-foreground/60">No sub-tasks yet.</p>
                  )}
                  <div className="flex items-center gap-2 pt-1">
                    <input
                      value={newSubtask}
                      onChange={(e) => setNewSubtask(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void addSubtask();
                      }}
                      placeholder="Break off a sub-task…"
                      className="h-8 w-full rounded-lg border border-border bg-background/60 px-2.5 text-xs text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                    />
                    <Button variant="outline" size="sm" disabled={busy || !newSubtask.trim()} onClick={() => void addSubtask()}>
                      <PlusIcon />
                      Add
                    </Button>
                  </div>
                </div>
              </section>
            </div>

            <aside>
              <section>
                <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  Ripening
                </h2>
                {timeline.length === 0 ? (
                  <p className="text-xs text-muted-foreground/60">
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
                          {!last && (
                            <span className="absolute top-5 bottom-0 left-[9px] w-px bg-border" />
                          )}
                          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-card">
                            <Icon className="size-2.5 text-muted-foreground" />
                          </span>
                          <div className="min-w-0 text-xs">
                            <p className="font-mono text-[10px] text-muted-foreground/60">
                              {ev.at} · {label}
                              {ev.proposal && <span className="text-muted-foreground/40"> · proposal</span>}
                            </p>
                            <p className="mt-0.5 leading-snug text-foreground/85">{ev.text}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
