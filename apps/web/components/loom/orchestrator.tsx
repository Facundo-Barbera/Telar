"use client";

/**
 * THE ORCHESTRATOR — `/looms/[projectId]`, loom-build.md §11.
 *
 * Three panes, and only ONE of them is new code:
 *
 *   left    the project's looms as session rows. A loom IS a session; the rail
 *           is narrow on purpose and click SELECTS rather than navigates, so
 *           the conversation beside it is never thrown away by a click.
 *   centre  the STOCK Telar session cockpit. Not forked, not wrapped, not
 *           reimplemented. There is no chat here, no message list, no composer
 *           and no transcript written for looms — the orchestrator is an
 *           ordinary Telar session and it uses the ordinary cockpit.
 *   right   a tab strip in `right-panel.tsx`'s idiom carrying the Program.
 *
 * ── TWO AGENT SURFACES, AND ONLY ONE HAS A TRANSCRIPT ────────────────────────
 * The session in the middle is a CONVERSATION against the project: it is where
 * you say what to watch, read the dry run, correct it, and watch the Program
 * change. §4.3 — correction is the loop, and it only works because the
 * understanding lives in a file rather than in a context window, which is why
 * the Program tab and this conversation are two views of one thing.
 *
 * A TICK is the other surface and it is headless. Fresh every time, remembers
 * nothing, no session, nothing to open — which is the whole reason cost does
 * not ramp with uptime. What a tick leaves is the ledger and the run record, so
 * those are on the right where a person would otherwise go looking for a chat.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon, HandIcon, RadioIcon } from "lucide-react";
import type { Loom } from "@telar/engine-client";
import { SessionCockpit } from "@/components/session-cockpit";
import { useNarrowWindow } from "@/hooks/use-narrow-window";
import { IN_FLIGHT_STATES } from "@/lib/loom-deck";
import { LOOM_NARROW_WINDOW } from "@/lib/right-panel-layout";
import { useLoomOverview } from "@/lib/loom-overview";
import { LoomRailRow, loomTitle } from "./rows";
import { ProgramPanel, SetupInvitation } from "./program-panel";

export function LoomOrchestrator({ projectId }: { projectId: string }) {
  const { overview, receivedAt, loading } = useLoomOverview();
  const project = overview.projects.find((candidate) => candidate.projectId === projectId);
  const looms = useMemo(
    () => overview.looms.filter((loom) => loom.projectId === projectId),
    [overview.looms, projectId],
  );

  /**
   * THE ORCHESTRATOR'S SESSION IS NEVER CREATED BY ARRIVING HERE.
   *
   * `POST /api/looms/session` mints a session seeded with a setup prompt, which
   * immediately goes and reads the project — so calling it from an effect
   * would mean NAVIGATION SPENDS MONEY. That is wrong anywhere, and it is
   * specifically wrong for this product: §10's whole posture is that nothing
   * compounds silently — it opens PRs it never merges, it holds rather than
   * pushing when a gate could not be verified, and it writes down what it
   * assumed instead of guessing quietly. An agent that starts because someone
   * clicked a link in the sidebar is the same class of mistake, an effect the
   * human did not ask for and could not see coming. The person most likely to
   * open this at 2am to find out what happened overnight is exactly the person
   * who must not be billed for looking.
   *
   * So the id is READ from the summary, and the only thing that creates one is
   * a press on `SetupInvitation`.
   */
  const known = project?.orchestratorSessionId;
  const [created, setCreated] = useState<{ projectId: string; sessionId: string }>();
  /** DERIVED, NOT MIRRORED. The summary's id is the truth the moment it
   *  appears; copying it into state through an effect would be a cascading
   *  render, and this app lints that. The created id is scoped to the project
   *  it was created for, so navigating between two projects cannot show one
   *  project's conversation under the other's name. */
  const sessionId = known ?? (created?.projectId === projectId ? created.sessionId : undefined);

  /** Which loom the rail has selected. `undefined` is the orchestrator itself. */
  const [selected, setSelected] = useState<string>();

  /**
   * IS THE PROGRAM PANEL OPEN? DERIVED, NOT MIRRORED — the same rule the
   * session id above follows, and for the same reason: copying the window's
   * width into state through an effect is a cascading render, and this app
   * lints that. `undefined` means nobody has said, and the window answers.
   *
   * Three columns want the app shell's own rail (16rem), this page's rail, a
   * conversation and a panel. Under `LOOM_NARROW_WINDOW` they do not all fit,
   * and the one that has to give way is the panel: the centre is where the
   * conversation lives and it is the reason the page exists.
   */
  const narrow = useNarrowWindow(LOOM_NARROW_WINDOW);
  const [programChoice, setProgramChoice] = useState<boolean>();
  const programOpen = programChoice ?? !narrow;
  const selectedLoom = looms.find((loom) => loom.id === selected);
  const waiting = looms.filter((loom) => loom.state === "asking").length;

  if (!loading && !project) return <UnknownProject projectId={projectId} />;

  return (
    <div className="flex h-dvh min-w-0 overflow-hidden bg-background">
      <aside className="flex w-[210px] shrink-0 flex-col border-r border-border/70 bg-muted/20">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border/70 px-2.5 py-2">
          <Link href="/looms" className="text-muted-foreground hover:text-foreground" aria-label="All looms">
            <ArrowLeftIcon className="size-3" />
          </Link>
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{project?.name ?? projectId}</span>
          <RadioIcon
            className={`size-3 shrink-0 ${project?.watch.running ? "text-success" : "text-muted-foreground/40"}`}
          />
        </div>

        <button
          type="button"
          onClick={() => setSelected(undefined)}
          aria-current={selected === undefined ? "true" : undefined}
          className={`mx-1.5 mt-1.5 rounded-md px-1.5 py-1 text-left text-[12px] transition-colors hover:bg-accent/50 ${
            selected === undefined ? "bg-accent" : ""
          }`}
        >
          The orchestrator
          <span className="mt-0.5 block text-[10px] text-muted-foreground/70">its conversation with you</span>
        </button>

        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
          {looms.length === 0 ? (
            <p className="px-1.5 py-2 text-[10px] leading-relaxed text-muted-foreground/70">
              No looms yet. Each one owns a worktree and a session of its own.
            </p>
          ) : (
            <>
              <RailGroup
                label="In flight"
                looms={looms.filter((loom) => IN_FLIGHT_STATES.includes(loom.state))}
                selected={selected}
                onSelect={setSelected}
              />
              <RailGroup
                label="Waiting on you"
                looms={looms.filter((loom) => loom.state === "asking")}
                selected={selected}
                onSelect={setSelected}
              />
              <RailGroup
                label="Finished"
                looms={looms.filter(
                  (loom) => loom.state === "published" || loom.state === "parked" || loom.state === "cancelled",
                )}
                selected={selected}
                onSelect={setSelected}
              />
            </>
          )}
        </div>

        {waiting > 0 && (
          <div className="shrink-0 border-t border-border/70 px-2.5 py-1.5">
            <Link href="/looms" className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground">
              <HandIcon className="size-2.5 shrink-0 text-warning" />
              <span>
                {waiting} waiting on you
              </span>
            </Link>
          </div>
        )}
      </aside>

      {/**
        * THE ROOM — the conversation and the Program, nested one level inside
        * the rail rather than sitting beside it.
        *
        * The nesting is load-bearing, not tidying. The panel's
        * `max-w-[calc(100%-24rem)]` guard is a PERCENTAGE, and a percentage
        * resolves against its containing block: as a direct child of the outer
        * row it would measure itself against a width the 210px rail has already
        * spent, and leave the conversation 24rem minus a rail. Here `100%` is
        * the room the two of them actually share, so "leave the conversation
        * 24rem" means what it says.
        *
        * `min-w-0`, because a flex child without it will not shrink below its
        * own content — the other half of how the centre lost the width fight.
        */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/**
          * CENTRE — the stock cockpit, keyed so selecting another session
          * remounts it rather than handing a live cockpit a different id.
          *
          * HIDDEN, NOT UNMOUNTED, when the Program takes the whole room on a
          * narrow window: unmounting a cockpit throws away a live session's
          * hydration and its scroll position and pays to fetch them again on
          * the way back, for a toggle someone may flick twice a minute.
          */}
        <div className={`flex min-h-0 min-w-0 flex-1 overflow-hidden ${narrow && programOpen ? "hidden" : ""}`}>
          {selectedLoom ? (
            selectedLoom.sessionId ? (
              <SessionCockpit key={selectedLoom.sessionId} projectId={projectId} sessionId={selectedLoom.sessionId} />
            ) : (
              <NoSessionYet loom={selectedLoom} />
            )
          ) : sessionId ? (
            <SessionCockpit
              key={sessionId}
              projectId={projectId}
              sessionId={sessionId}
              {...(project?.name ? { projectName: project.name } : {})}
            />
          ) : project ? (
            <SetupInvitation
              project={project}
              onStarted={(startedSessionId) => setCreated({ projectId, sessionId: startedSessionId })}
            />
          ) : (
            <div className="flex min-w-0 flex-1 items-center justify-center">
              <p className="text-[12px] text-muted-foreground">Loading…</p>
            </div>
          )}
        </div>

        <ProgramPanel
          {...(project ? { project } : {})}
          now={receivedAt}
          open={programOpen}
          alone={narrow}
          onOpenChange={setProgramChoice}
        />
      </div>
    </div>
  );
}

function RailGroup({
  label,
  looms,
  selected,
  onSelect,
}: {
  label: string;
  looms: Loom[];
  selected?: string;
  onSelect: (id: string) => void;
}) {
  if (looms.length === 0) return null;
  return (
    <div className="pt-1">
      <div className="flex items-baseline gap-1.5 px-1.5 pb-0.5">
        <span className="text-[9px] font-medium tracking-wide text-muted-foreground/60 uppercase">{label}</span>
        <span className="font-mono text-[9px] text-muted-foreground/40">{looms.length}</span>
      </div>
      {looms.map((loom) => (
        <LoomRailRow key={loom.id} loom={loom} selected={loom.id === selected} onSelect={() => onSelect(loom.id)} />
      ))}
    </div>
  );
}

/** A loom with no session: queued, or one that never got that far. */
function NoSessionYet({ loom }: { loom: Loom }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-1.5 overflow-y-auto px-5 py-8 text-center sm:px-8">
      <p className="text-[13px] font-medium text-balance">{loomTitle(loom)}</p>
      <p className="max-w-md text-[12px] leading-relaxed text-pretty text-muted-foreground">
        This one has no session yet, so there is nothing to read. It gets a worktree and a session when it is
        dispatched.
      </p>
      {loom.parkedReason && (
        <p className="max-w-md text-[11px] leading-relaxed text-pretty text-muted-foreground/70">{loom.parkedReason}</p>
      )}
    </div>
  );
}

function UnknownProject({ projectId }: { projectId: string }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-2 bg-background px-8 text-center">
      <h1 className="text-[14px] font-semibold tracking-tight">Nothing is orchestrating this project</h1>
      <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
        <span className="font-mono">{projectId}</span> is not on the deck. It may not exist on this machine, or the
        engine may not be reachable.
      </p>
      <Link href="/looms" className="text-[12px] text-primary hover:underline">
        Back to the deck
      </Link>
    </div>
  );
}
