"use client";

/**
 * THE ORCHESTRATOR — `/looms/[projectId]`, loom-build.md §11.
 *
 * ── TWO COLUMNS, ALWAYS ──────────────────────────────────────────────────────
 * The app sidebar, and this. Never a third.
 *
 * This page used to be four columns — app sidebar, a loom rail, the
 * conversation, and a Program panel — and five whenever a real session loaded,
 * because the stock cockpit brings its own right panel. Sizing could not fix
 * that; an earlier pass tried and only treated the symptom. So the loom rail is
 * gone (a loom is a session and the deck's rows already link to it) and the
 * Program panel is gone as a PANEL: it is now one SEGMENT of the single content
 * column, chosen by the strip at the top.
 *
 * The Conversation segment is the STOCK `SessionCockpit` — not forked, not
 * wrapped, not reimplemented. It brings its own right panel and that is fine
 * and expected now, because it is the only content on screen and that panel is
 * the second column rather than the fifth.
 *
 * ── THE SEGMENT IS IN THE URL ────────────────────────────────────────────────
 * `?view=ledger` — a person has to be able to send someone the Ledger. It is
 * read on the server and handed down as a prop, so there is no `useSearchParams`
 * and no suspense boundary to forget.
 *
 * ── TWO AGENT SURFACES, AND ONLY ONE HAS A TRANSCRIPT ────────────────────────
 * The conversation is a session against the project. A TICK is the other
 * surface and it is headless — fresh every time, remembers nothing, which is
 * why cost does not ramp with uptime. What a tick leaves is the Ledger, which
 * is why that is a segment and not a chat nobody can open.
 */

import { useState } from "react";
import Link from "next/link";
import { RadioIcon } from "lucide-react";
import { SessionCockpit } from "@/components/session-cockpit";
import { useLoomOverview } from "@/lib/loom-overview";
import { LOOM_VIEWS, loomViewHref, type LoomView } from "@/lib/loom-views";
import { cn } from "@/lib/utils";
import { LoomDeck } from "./deck";
import { LoomLedger } from "./ledger";
import { ProgramView, SetupInvitation } from "./program";

export function LoomOrchestrator({ projectId, view }: { projectId: string; view: LoomView }) {
  const { overview, receivedAt, loading } = useLoomOverview();
  const project = overview.projects.find((candidate) => candidate.projectId === projectId);

  /**
   * THE ORCHESTRATOR'S SESSION IS NEVER CREATED BY ARRIVING HERE.
   *
   * `POST /api/looms/session` mints a session seeded with a setup prompt, which
   * immediately goes and reads the project — so calling it from an effect would
   * mean NAVIGATION SPENDS MONEY. The person most likely to open this at 2am to
   * find out what happened overnight is exactly the person who must not be
   * billed for looking. So the id is READ from the summary, and the only thing
   * that creates one is a press on `SetupInvitation`.
   *
   * DERIVED, NOT MIRRORED. The summary's id is the truth the moment it appears;
   * copying it into state through an effect would be a cascading render, and
   * this app lints that. The created id is scoped to the project it was created
   * for, so navigating between two projects cannot show one project's
   * conversation under the other's name.
   */
  const known = project?.orchestratorSessionId;
  const [created, setCreated] = useState<{ projectId: string; sessionId: string }>();
  const sessionId = known ?? (created?.projectId === projectId ? created.sessionId : undefined);

  /**
   * ONCE OPENED, THE CONVERSATION STAYS MOUNTED AND HIDES.
   *
   * DO NOT "CLEAN THIS UP" INTO A PLAIN UNMOUNT. §4.3 — correction is the loop:
   * the core motion is Program ↔ Conversation, flipped repeatedly, and an
   * unmount re-hydrates the session and loses its scroll position on every
   * flip. `display:none` has no width, so this is not a second column; it is
   * the only segment treated this way, and `idiom.test.ts` pins both facts.
   *
   * EARNED, NOT EAGER: `everConversed` starts false, so arriving on the Deck
   * does not quietly hydrate a session nobody asked to see. Set during render
   * rather than in an effect — an effect here is the cascading render this app
   * lints.
   */
  const conversing = view === "conversation";
  const [everConversed, setEverConversed] = useState(false);
  if (conversing && !everConversed) setEverConversed(true);

  if (!loading && !project) return <UnknownProject projectId={projectId} />;

  return (
    /** A STACK, NOT A ROW. The children of this element are a bar and one
     *  content region; there is no second column here to grow a third from. */
    <div className="flex h-dvh min-w-0 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-1.5">
        <RadioIcon
          className={`size-3 shrink-0 ${project?.watch.running ? "text-success" : "text-muted-foreground/40"}`}
          aria-label={project?.watch.running ? "watching" : "paused"}
        />
        <span className="min-w-0 shrink truncate text-[12px] font-medium">{project?.name ?? projectId}</span>
        <nav aria-label="View" className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
          {LOOM_VIEWS.map((segment) => (
            <Link
              key={segment.id}
              href={loomViewHref(projectId, segment.id)}
              scroll={false}
              aria-current={view === segment.id ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-colors",
                view === segment.id
                  ? "bg-background font-medium text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <segment.icon className="size-3 shrink-0" aria-hidden />
              {segment.label}
            </Link>
          ))}
        </nav>
      </header>

      {/** ONE CONTENT REGION, ONE SEGMENT IN IT. A flex row with a single child
        *  so the cockpit's own `flex-1` root has something to fill. */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {view === "deck" && <LoomDeck projectId={projectId} />}
        {view === "program" && <ProgramView {...(project ? { project } : {})} now={receivedAt} />}
        {view === "ledger" && <LoomLedger projectId={projectId} />}
        {everConversed && (
          <div className={cn("flex min-h-0 min-w-0 flex-1 overflow-hidden", !conversing && "hidden")}>
            {sessionId ? (
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
        )}
      </div>
    </div>
  );
}

function UnknownProject({ projectId }: { projectId: string }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-2 bg-background px-8 text-center">
      <h1 className="text-[14px] font-semibold tracking-tight">Nothing is orchestrating this project</h1>
      <p className="max-w-md text-[12px] text-muted-foreground">
        <span className="font-mono">{projectId}</span> is not on the deck.
      </p>
      <Link href="/looms" className="text-[12px] text-primary hover:underline">
        Back to the deck
      </Link>
    </div>
  );
}
