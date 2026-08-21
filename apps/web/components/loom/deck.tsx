"use client";

/**
 * THE DECK — `/looms`, loom-build.md §11.
 *
 * ORDERED BY WHAT THE HUMAN MUST DO, not by what the engine finds interesting:
 *
 *   1. Needs you            blocked on a person; everything else can wait
 *   2. Ready to review      the deliverable, with the tri-state gate
 *   3. Working              in flight, nested under its project
 *   4. Seen and not taken   the triage cache — §3.10 made visible
 *
 * (4) IS THE MOST VALUABLE PANE ON THE PAGE and it is drawn as an asset rather
 * than as an error list. The design's core finding is that TRIAGE, NOT
 * DISPATCH, IS THE BOTTLENECK: in the repo this was tested against, 4 of 37
 * items were dispatchable and nothing in the tracker distinguished the other
 * 33. Maintaining that classification is the durable output; a tick that
 * dispatches nothing and classifies six items correctly was a good tick.
 *
 * ONE READ FOR THE WHOLE DECK. `GET /api/looms` returns the entire snapshot —
 * see `lib/loom-overview.ts` for why, and for the two cadences.
 *
 * NOTHING HERE KNOWS WHAT A TRACKER IS. An item is a string the project's own
 * `list` command produced.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRightIcon,
  EyeOffIcon,
  GitPullRequestIcon,
  HandIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  RadioIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { LoomProjectSummary, TriageEntry } from "@telar/engine-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { deckSections, type NeedsYouRow } from "@/lib/loom-deck";
import { ladderSummary, ladderTrace } from "@/lib/loom-ladder";
import { useLoomOverview } from "@/lib/loom-overview";
import { useLoomPrograms } from "@/lib/loom-program";
import { answerLoom, saveLoomProgram, setLoomWatch } from "@/lib/loom-actions";
import { removeAssumption } from "@/lib/loom-program-markdown";
import { fmtAgo } from "@/lib/format";
import { LoomRow, Section } from "./rows";
import { GateChip } from "./gate-chip";

export function LoomDeck() {
  // ONE CLOCK, AND IT MOVES ONLY WHEN THE DATA DOES — `receivedAt` is stamped
  // when the snapshot lands. See `lib/loom-overview.ts`.
  const { overview, receivedAt: now, loading, error, refresh, began } = useLoomOverview();
  const sections = useMemo(() => deckSections(overview), [overview]);

  // Rung labels live in the artifact, so the projects with something waiting on
  // a person are the only ones whose Program has to be read.
  const needProgram = useMemo(
    () => [...new Set(sections.needsYou.map((row) => row.projectId))],
    [sections.needsYou],
  );
  const { docs: programs, reload: reloadPrograms } = useLoomPrograms(needProgram);

  if (!loading && overview.projects.length === 0) return <NoProgramYet error={error} />;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <header className="shrink-0 border-b border-border/70 bg-card/50">
        {overview.projects.map((project) => (
          <WatchStrip key={project.projectId} project={project} now={now} onChanged={began} />
        ))}
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
        {error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
            {error} Showing the last snapshot that arrived.
          </p>
        )}

        {/* 1. BLOCKED ON A PERSON. Leads, because it is the reason the night
              stopped short and nothing below it is waiting on anybody. */}
        <Section
          icon={HandIcon}
          title="Needs you"
          count={sections.needsYou.length}
          hint={sections.needsYou.length === 0 ? "nothing is waiting on you" : "the ladder is spent"}
        >
          {sections.needsYou.length === 0 ? (
            <Quiet>Nothing escalated. Everything that stalled was absorbed before it reached you.</Quiet>
          ) : (
            <div className="space-y-2">
              {sections.needsYou.map((row) =>
                row.kind === "loom" ? (
                  <AskingRow
                    key={row.key}
                    row={row}
                    now={now}
                    ladder={programs.get(row.projectId)?.program?.ladder ?? []}
                    onAnswered={() => {
                      began();
                      refresh();
                    }}
                  />
                ) : (
                  <AssumedRow
                    key={row.key}
                    projectId={row.projectId}
                    projectName={row.projectName}
                    assumption={row.assumption}
                    markdown={programs.get(row.projectId)?.markdown}
                    onConfirmed={() => {
                      reloadPrograms();
                      refresh();
                    }}
                  />
                ),
              )}
            </div>
          )}
        </Section>

        {/* 2. THE DELIVERABLE. A loom ends at an open PR and review happens
              wherever the project publishes to, so these rows link OUT rather
              than trying to be a diff tool. */}
        <Section
          icon={GitPullRequestIcon}
          title="Ready to review"
          count={sections.review.length}
          hint="published · you decide what lands"
        >
          {sections.review.length === 0 ? (
            <Quiet>Nothing published yet.</Quiet>
          ) : (
            <div className="space-y-2">
              {sections.review.map((loom) => (
                <LoomRow key={loom.id} loom={loom} now={now} trailing={<GateChip gate={loom.gate} />}>
                  {loom.publishedUrl && (
                    <div className="mt-2 ml-[1.4rem]">
                      <a
                        href={loom.publishedUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 truncate font-mono text-[11px] text-primary hover:underline"
                      >
                        {loom.publishedUrl}
                        <ArrowUpRightIcon className="size-3 shrink-0" />
                      </a>
                    </div>
                  )}
                </LoomRow>
              ))}
            </div>
          )}
        </Section>

        {/* 3. IN FLIGHT, nested under its project, with the live session row
              INSIDE the loom rather than beside it. One level, bounded. */}
        <Section
          icon={Loader2Icon}
          title="Working"
          count={sections.working.reduce((total, group) => total + group.looms.length, 0)}
          hint={sections.working.length > 1 ? `${sections.working.length} projects` : undefined}
        >
          {sections.working.length === 0 ? (
            <Quiet>Nothing in flight.</Quiet>
          ) : (
            <div className="space-y-3">
              {sections.working.map((group) => (
                <div key={group.projectId} className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <Link
                      href={`/looms/${encodeURIComponent(group.projectId)}`}
                      className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                    >
                      {group.name}
                    </Link>
                    <span className="font-mono text-[10px] text-muted-foreground/50">{group.looms.length}</span>
                  </div>
                  {group.looms.map((loom) => (
                    <LoomRow key={loom.id} loom={loom} now={now} />
                  ))}
                </div>
              ))}
            </div>
          )}
        </Section>

        <Separator />

        {/* 4. THE CLASSIFICATION. Half the product: "nothing silently dropped"
              is a promise, and this is where it is kept. */}
        <Section
          icon={EyeOffIcon}
          title="Seen and not taken"
          count={sections.seen.reduce((total, group) => total + group.entries.length, 0)}
          hint="the classification is the work"
        >
          <p className="max-w-3xl text-[12px] leading-relaxed text-muted-foreground">
            Most of a good backlog is not dispatchable, and nothing in it says why. Each item below was read once
            and will not be read again until it changes — that is what makes reading the whole thread affordable,
            and it is the durable output of a tick that dispatched nothing.
          </p>
          {sections.seen.length === 0 ? (
            <Quiet>Nothing classified yet. A tick fills this in.</Quiet>
          ) : (
            <div className="space-y-3">
              {sections.seen.map((group) => (
                <TriageGroup key={group.classification} label={group.label} blurb={group.blurb} entries={group.entries} />
              ))}
            </div>
          )}
        </Section>

        {sections.closed.length > 0 && (
          <Section icon={PauseIcon} title="Stopped, with a reason" count={sections.closed.length}>
            <div className="space-y-2">
              {sections.closed.map((loom) => (
                <LoomRow key={loom.id} loom={loom} now={now} />
              ))}
            </div>
          </Section>
        )}

        {overview.unreadable.length > 0 && (
          <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
            <p className="text-[12px] text-warning">
              {overview.unreadable.length} record{overview.unreadable.length === 1 ? "" : "s"} could not be read and
              {overview.unreadable.length === 1 ? " is" : " are"} missing from this page.
            </p>
            <ul className="mt-1 space-y-0.5">
              {overview.unreadable.map((entry) => (
                <li key={entry.file} className="font-mono text-[11px] text-muted-foreground">
                  {entry.file} — {entry.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="pb-4" />
      </div>
    </div>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] text-muted-foreground/70">{children}</p>;
}

/**
 * THE WATCH, AS A STATUS LINE RATHER THAN A DASHBOARD.
 *
 * What it watches, when it last looked, when it looks next, and one control.
 * Idle is free — the probe is one command and no model — so "running" here is
 * not a claim about spending, and the strip does not pretend to be a budget.
 */
function WatchStrip({
  project,
  now,
  onChanged,
}: {
  project: LoomProjectSummary;
  now: number;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const watch = project.watch;
  return (
    <div className="flex items-center gap-3 px-5 py-2.5">
      <RadioIcon className={`size-4 shrink-0 ${watch.running ? "text-success" : "text-muted-foreground/40"}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <Link href={`/looms/${encodeURIComponent(project.projectId)}`} className="text-[14px] font-semibold tracking-tight hover:underline">
            {project.name || project.projectId}
          </Link>
          <Badge variant="secondary" className="h-4 px-1.5 font-mono text-[10px]">
            {watch.running ? "watching" : "paused"}
          </Badge>
          {project.assumed.length > 0 && (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
              {project.assumed.length} assumed
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
          {watch.lastError
            ? watch.lastError
            : `every ${watch.intervalSec}s${watch.quietChecks > 0 ? ` · ${watch.quietChecks} quiet checks` : ""}`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-4 text-[11px]">
        <div className="text-right">
          <div className="text-muted-foreground/60">last look</div>
          <div className="font-mono">{watch.lastProbeAt && now ? fmtAgo(watch.lastProbeAt, now) : "—"}</div>
        </div>
        <div className="text-right">
          <div className="text-muted-foreground/60">last change</div>
          <div className="font-mono">{watch.lastChangeAt && now ? fmtAgo(watch.lastChangeAt, now) : "—"}</div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[12px]"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void setLoomWatch(project.projectId, !watch.running).finally(() => {
              setBusy(false);
              onChanged();
            });
          }}
        >
          {watch.running ? <PauseIcon className="size-3" /> : <PlayIcon className="size-3" />}
          {watch.running ? "Pause" : "Watch"}
        </Button>
      </div>
    </div>
  );
}

/**
 * A LOOM THAT ESCALATED. The row's job is to make the human an ANSWERER rather
 * than a triager: the question, then what was already tried and whether those
 * rungs have ever absorbed anything, then a box.
 */
function AskingRow({
  row,
  now,
  ladder,
  onAnswered,
}: {
  row: Extract<NeedsYouRow, { kind: "loom" }>;
  now: number;
  ladder: Parameters<typeof ladderTrace>[0];
  onAnswered: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const steps = ladderTrace(ladder, row.loom);
  const tried = steps.filter((step) => step.tried);

  return (
    <LoomRow loom={row.loom} now={now}>
      <div className="mt-2.5 ml-[1.4rem] rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
        <p className="text-[12px] leading-relaxed">{row.question}</p>

        {/* WHAT WAS ALREADY TRIED. Without this the first thing the reader does
            is guess whether the obvious cheap move was attempted — which is
            exactly the work the ladder exists to have already done. */}
        <div className="mt-2 border-t border-warning/20 pt-2">
          <p className="text-[11px] text-muted-foreground">{ladderSummary(steps)}</p>
          {tried.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {tried.map((step) => (
                <li key={step.n} className="flex items-center gap-2 text-[11px]">
                  <span className="w-3 shrink-0 font-mono text-muted-foreground/50">{step.n}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{step.label}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                    {step.absorbed === 0 ? "absorbed nothing yet" : `absorbed ${step.absorbed} before`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {steps.some((step) => !step.enabled) && (
            <p className="mt-1 text-[10px] text-muted-foreground/60">
              {steps.filter((step) => !step.enabled).length} rung
              {steps.filter((step) => !step.enabled).length === 1 ? " is" : "s are"} switched off and never ran.
            </p>
          )}
        </div>

        <div className="mt-2 space-y-1.5">
          <Textarea
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="Answer it. This goes back to the orchestrator, not to a form."
            className="min-h-14 text-[12px]"
          />
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={busy || answer.trim() === ""}
              onClick={() => {
                setBusy(true);
                void answerLoom(row.loom.id, answer.trim()).then((result) => {
                  setBusy(false);
                  if (result.ok) {
                    setAnswer("");
                    setFailed(undefined);
                    onAnswered();
                  } else setFailed(result.error);
                });
              }}
            >
              {busy ? "Sending…" : "Answer"}
            </Button>
            <Link
              href={`/looms/${encodeURIComponent(row.projectId)}`}
              className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
            >
              Open the orchestrator
            </Link>
          </div>
          {failed && <p className="text-[11px] text-destructive">{failed}</p>}
        </div>
      </div>
    </LoomRow>
  );
}

/**
 * AN ASSUMPTION AWAITING CONFIRMATION — §4.4.
 *
 * "A wrong assumption you can see is survivable; an invisible one is not." So
 * it sits in **Needs you** with everything else that is blocked on a person,
 * and confirming it DELETES it from the artifact: once read, it is no longer an
 * assumption, and the text it was assumed into is already in the Program.
 */
function AssumedRow({
  projectId,
  projectName,
  assumption,
  markdown,
  onConfirmed,
}: {
  projectId: string;
  projectName: string;
  assumption: string;
  markdown?: string;
  onConfirmed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  return (
    <div className="rounded-lg border border-border/70 bg-card px-3 py-2">
      <div className="flex items-start gap-2.5">
        <SparklesIcon className="mt-0.5 size-3 shrink-0 text-info" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-relaxed">{assumption}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {projectName} · assumed during setup, never confirmed
          </p>
          <div className="mt-2 flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={busy || markdown === undefined}
              onClick={() => {
                if (markdown === undefined) return;
                setBusy(true);
                void saveLoomProgram(projectId, removeAssumption(markdown, assumption)).then((result) => {
                  setBusy(false);
                  if (result.ok) onConfirmed();
                  else setFailed(result.error);
                });
              }}
            >
              That is right
            </Button>
            <Link
              href={`/looms/${encodeURIComponent(projectId)}`}
              className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
            >
              No — change the Program
            </Link>
          </div>
          {failed && <p className="mt-1 text-[11px] text-destructive">{failed}</p>}
        </div>
      </div>
    </div>
  );
}

/** One classification pile. Rows are one line: the item, and why. */
function TriageGroup({ label, blurb, entries }: { label: string; blurb: string; entries: TriageEntry[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-baseline gap-2 py-1 text-left"
      >
        <span className="text-[12px] font-medium">{label}</span>
        <span className="font-mono text-[11px] text-muted-foreground/60">{entries.length}</span>
        <span className="ml-auto truncate text-[11px] text-muted-foreground/70">{blurb}</span>
      </button>
      {open && (
        <div className="space-y-px overflow-hidden rounded-lg border border-border/70">
          {entries.map((entry) => (
            <div key={entry.item} className="bg-card px-3 py-1.5">
              <div className="flex items-baseline gap-2.5">
                <span className="max-w-[10rem] shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                  {entry.item}
                </span>
                <span className="min-w-0 flex-1 text-[12px] text-muted-foreground">{entry.reason}</span>
              </div>
              {/* THE DISTILLED CURRENT INTENT, which is the expensive half of a
                  classification and the reason the cache exists: the newest
                  thing said routinely retracts the original text. */}
              {entry.ask.trim() !== "" && (
                <p className="mt-0.5 pl-[10.6rem] text-[11px] text-foreground/70">{entry.ask}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * THE EMPTY COCKPIT — an invitation, not a broken page.
 *
 * Nothing is set up, so nothing is wrong. The one thing to do is name a project
 * and have a conversation with it, which is what §12 means by "setup is a
 * conversation": no wizard, no schema-filling form.
 */
function NoProgramYet({ error }: { error?: string }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background px-8 text-center">
      <SparklesIcon className="size-6 text-muted-foreground/40" />
      <h1 className="text-[15px] font-semibold tracking-tight">No orchestrator yet</h1>
      <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
        An orchestrator watches one project, decides what is worth doing, and dispatches work into its own worktree.
        It reads a single file in the project — <span className="font-mono">.telar/loom.md</span> — that you and it
        write together.
      </p>
      <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground/70">
        Setup is a conversation, not a form: it looks at the project first and asks only about what it genuinely
        cannot determine.
      </p>
      <Button render={<Link href="/projects" />} size="sm" className="mt-1">
        Choose a project
      </Button>
      {error && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-destructive">
          <TriangleAlertIcon className="size-3" />
          {error}
        </p>
      )}
    </div>
  );
}
