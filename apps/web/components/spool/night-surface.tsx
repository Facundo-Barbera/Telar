"use client";

/**
 * THE MORNING, DRAWN — what ran while you were not here.
 *
 * ── THE THING THIS FIXES IS CONCEPTUAL, NOT COSMETIC ─────────────────────────
 * A night ran, cost $1.12, wrote a brief and an approach — and there was no
 * screen in the app that said so. The only way to find out was to type "where
 * did I stop" into the chat and have a model call `spool_list_items` and
 * summarise: slow, priced, and different every time you asked.
 *
 * `docs/spool-definition.md` §8 promises "in one screen: what ran, the question
 * it could not answer alone, where each subject stands". Every one of those
 * facts is already on disk in `night.json` and the packets. This file DRAWS
 * them. No model call, instant, free, and the same every time.
 *
 * ── WHAT IT LEADS WITH, AND WHY THAT ORDER ───────────────────────────────────
 *   1. WORK IN FLIGHT. Anything running right now, with its step. If you are
 *      looking at this while something is happening, that is the news.
 *   2. QUESTIONS. The one part of a night that is BLOCKED ON A PERSON. An
 *      approach you have not read costs nothing to leave; a question the agent
 *      could not answer is the reason it stopped short.
 *   3. WHAT IT DID, per job, refusals told apart from failures — "this is
 *      floating so it has no expert" is the system working and naming the one
 *      thing only you can do.
 *   4. HOW IT ENDED, and what it cost.
 *
 * ── NO CLOCK REACHES YOU ─────────────────────────────────────────────────────
 * §3.2 permits a clock to drive an agent and forbids one from deciding what a
 * surface draws. `opened` is a display label the store minted, nothing here
 * sorts or subtracts a time, and `stop.resumeAfter` — the one real timestamp in
 * the record — is agent-facing and never rendered.
 */
import { useCallback, useEffect, useState } from "react";
import {
  CheckIcon,
  HandIcon,
  Loader2Icon,
  MoonIcon,
  SparklesIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import type { SpoolNight, SpoolNightJob } from "@telar/engine-client";
import { Button } from "@/components/ui/button";
import { describeWork, type SpoolWorkView } from "@/lib/spool-work";
import { cn } from "@/lib/utils";

/**
 * A JOB'S OUTCOME AS A MARK, and `refused` is deliberately not a warning.
 *
 * Collapsing refusals into failures would either hide work only the user can
 * unblock, or cry wolf about a night that went exactly as designed. A refusal
 * gets a hand, not a triangle.
 */
const JOB_MARK: Record<SpoolNightJob["state"], { Icon: typeof CheckIcon; tone: string; label: string }> = {
  done: { Icon: CheckIcon, tone: "text-success", label: "done" },
  refused: { Icon: HandIcon, tone: "text-muted-foreground", label: "refused" },
  failed: { Icon: TriangleAlertIcon, tone: "text-destructive", label: "failed" },
  pending: { Icon: MoonIcon, tone: "text-muted-foreground/50", label: "still queued" },
};

/** WHY IT ENDED, in the user's terms. Every one of these is a resting state
 *  rather than an error, and the sentence says which. */
const STOP_TONE: Record<string, string> = {
  "nothing-to-do": "text-muted-foreground",
  "rate-limited": "text-warning",
  budget: "text-muted-foreground",
  "human-active": "text-muted-foreground",
  failing: "text-destructive",
  cancelled: "text-muted-foreground",
};

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pt-3 pb-1.5 text-[0.625rem] font-medium tracking-wider text-muted-foreground/70 uppercase">
      {children}
    </p>
  );
}

export function NightSurface({
  work,
  onOpen,
  onChanged,
}: {
  /** NO `cards`. This took the DESK's projection and filtered it to find open
   *  questions, which made the night a second renderer of another surface's
   *  record — and showed questions from passes it never ran. `SpoolNightJob`
   *  carries its own now, so this folds `night.json` like everything else here. */
  work: SpoolWorkView;
  onOpen: (itemId: string) => void;
  onChanged: () => void;
}) {
  const [night, setNight] = useState<SpoolNight | null | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/spool/night");
      setNight(res.ok ? ((await res.json()).night ?? null) : null);
    } catch {
      setNight(null);
    }
  }, []);

  useEffect(() => {
    // Deferred to a task, like every other read in this app the server could
    // not have performed — and it is what keeps the state write out of the
    // effect body, where it would cascade a render.
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load]);

  /**
   * RE-READ WHILE ANYTHING IS RUNNING. The night's record is rewritten to disk
   * after every job, so this is always current — and the work poll next door is
   * already ticking, so this rides its result rather than keeping a second timer.
   */
  const runningCount = work.running.length;
  useEffect(() => {
    if (runningCount === 0) return;
    const task = window.setTimeout(() => void load(), 1200);
    return () => window.clearTimeout(task);
  }, [runningCount, load, work.all]);

  const start = useCallback(() => {
    setStarting(true);
    setRefusal(null);
    void (async () => {
      try {
        const res = await fetch("/api/spool/night", { method: "POST" });
        const started = await res.json();
        // IT REFUSES WHILE A PERSON IS WORKING rather than standing down one job
        // in — the daemon's own rule, and its sentence is the answer.
        if (started?.refused) setRefusal(started.refused);
        work.began();
        await load();
        onChanged();
      } catch (err) {
        setRefusal(err instanceof Error ? err.message : String(err));
      } finally {
        setStarting(false);
      }
    })();
  }, [load, onChanged, work]);

  /**
   * THE NIGHT'S OWN QUESTIONS, FROM THE NIGHT'S OWN RECORD.
   *
   * This was `cards.filter((card) => card.openQuestions?.length)` — the night
   * rendering the DESK's projection, which made two surfaces draw one fact and
   * made this one report questions from passes it never ran. `SpoolNightJob` now
   * carries what each job could not answer, so the morning folds `night.json`
   * like everything else on this surface.
   *
   * THE DESK KEEPS ITS OWN LINE, and that is not the duplication coming back:
   * "this item has open questions, whoever asked them" and "last night's jobs
   * produced these" are different sets, and the desk's says only THAT there are
   * some while this one shows them.
   */
  const questions = (night?.jobs ?? []).filter((job) => job.openQuestions?.length);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* ── 1 · WHAT IS HAPPENING RIGHT NOW ─────────────────────────────── */}
        {work.running.length > 0 && (
          <>
            <Label>Working now</Label>
            <ul className="space-y-1 px-2 pb-1">
              {work.running.map((entry) => (
                <li key={entry.id} className="rounded-xl bg-card p-2.5 shadow-sm ring-1 ring-foreground/10">
                  <div className="flex items-center gap-2">
                    <Loader2Icon className="size-3.5 shrink-0 animate-spin text-spool" />
                    {/* A SUBJECT-SCOPED PASS HAS NO PACKET TO OPEN — the same
                        shape a `verify` job has below, and the same reason it
                        renders as a span: a button that opened nothing would be
                        live and silently inert, which is the defect this file
                        already names once. */}
                    {entry.itemId ? (
                      <button
                        type="button"
                        onClick={() => onOpen(entry.itemId!)}
                        className="min-w-0 flex-1 truncate text-left text-xs text-foreground hover:underline"
                      >
                        {entry.itemTitle}
                      </button>
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-xs text-foreground">{entry.itemTitle}</span>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label={`Stop ${entry.itemTitle}`}
                      title="Stop this pass — nothing will be written"
                      onClick={() => work.cancel(entry.id)}
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  </div>
                  <p className="mt-1 truncate pl-5.5 font-mono text-[0.625rem] text-muted-foreground">
                    {entry.step ? `${entry.step.n} · ${describeWork(entry)}` : describeWork(entry)}
                    {entry.origin === "night" && <span className="text-muted-foreground/60"> · overnight</span>}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* ── 2 · WHAT IT COULD NOT ANSWER ALONE ──────────────────────────── */}
        {questions.length > 0 && (
          <>
            <Label>It could not answer these alone</Label>
            <ul className="space-y-1 px-2 pb-1">
              {questions.map((job) => (
                <li key={job.id} className="rounded-xl bg-card p-2.5 shadow-sm ring-1 ring-foreground/10">
                  {/* A JOB MAY HAVE NO PACKET TO OPEN — the `verify` shape this
                      file already guards for below. */}
                  {job.itemId ? (
                    <button
                      type="button"
                      onClick={() => onOpen(job.itemId!)}
                      className="w-full min-w-0 truncate text-left text-xs font-medium text-foreground hover:underline"
                    >
                      {job.title}
                    </button>
                  ) : (
                    <span className="block w-full min-w-0 truncate text-xs font-medium text-foreground">{job.title}</span>
                  )}
                  <ul className="mt-1.5 space-y-1">
                    {job.openQuestions?.map((question) => (
                      <li key={question} className="flex items-start gap-2 text-[0.6875rem] leading-relaxed text-muted-foreground">
                        <span className="mt-1.5 size-1 shrink-0 rounded-full bg-spool" />
                        {question}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* ── 3 · WHAT THE LAST NIGHT DID ─────────────────────────────────── */}
        <Label>{night ? `Last night · ${night.opened}` : "Overnight"}</Label>
        {night === undefined && <p className="px-3 pb-2 text-xs text-muted-foreground/60">Reading…</p>}
        {night === null && (
          <p className="px-3 pb-2 text-xs leading-relaxed text-muted-foreground/60">
            It has never run. When it does, it turns what you dumped into briefs and proposes approaches for what it
            already understands. It starts nothing and ships nothing.
          </p>
        )}
        {night && (
          <>
            <ul className="space-y-0.5 px-2">
              {night.jobs.map((job) => {
                const mark = JOB_MARK[job.state];
                const body = (
                  <>
                    <mark.Icon className={cn("mt-0.5 size-3.5 shrink-0", mark.tone)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-foreground">{job.title}</span>
                      {job.note && (
                        <span className="mt-0.5 block text-[0.6875rem] leading-relaxed text-muted-foreground">{job.note}</span>
                      )}
                    </span>
                  </>
                );
                /**
                 * A `verify` JOB HAS NO ITEM TO OPEN. It is about a SUBJECT —
                 * the only kind that is — so it renders as a row rather than a
                 * link. A button that opened nothing would be the same defect
                 * as the panel toggle that opened a panel `display: none` could
                 * never show: live, and silently inert.
                 */
                return (
                  <li key={job.id}>
                    {job.itemId ? (
                      <button
                        type="button"
                        onClick={() => onOpen(job.itemId!)}
                        className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {body}
                      </button>
                    ) : (
                      <div className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left">{body}</div>
                    )}
                  </li>
                );
              })}
              {night.jobs.length === 0 && (
                <li className="px-2 pb-1 text-xs text-muted-foreground/60">It found nothing that needed doing.</li>
              )}
            </ul>

            {/* ── 4 · HOW IT ENDED, AND WHAT IT COST ───────────────────────
                A stop reason is never omitted. "It stopped" with no reason is
                the thing that makes an unattended system untrustworthy. */}
            {night.stop && (
              <p className={cn("px-3 pt-2 text-[0.6875rem] leading-relaxed", STOP_TONE[night.stop.reason] ?? "text-muted-foreground")}>
                {night.stop.note}
              </p>
            )}
            {night.usage?.costUsd !== undefined && (
              /* WHAT IT SPENT, stated plainly. An assistant that spends money
                 unattended has to be able to say how much — and this is the
                 only number on the surface, so it cannot read as a score. */
              <p className="px-3 pt-1 font-mono text-[0.625rem] text-muted-foreground/60 tabular-nums">
                ${night.usage.costUsd.toFixed(2)}
              </p>
            )}
          </>
        )}
      </div>

      {/* THE TRIGGER, AT THE FOOT, because it is the one control here and
          everything above it is a report. It spends money, so it is a quiet
          outline rather than a filled button — the same rule the packet's
          "Ask the expert" follows. */}
      <div className="shrink-0 space-y-2 border-t border-border p-2">
        <Button variant="outline" size="sm" className="w-full" disabled={starting} onClick={start}>
          {starting ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
          Work on this now
        </Button>
        {refusal ? (
          <p className="rounded-lg bg-muted/60 px-2 py-1.5 text-[0.6875rem] leading-relaxed text-muted-foreground">{refusal}</p>
        ) : (
          <p className="text-[0.625rem] leading-relaxed text-muted-foreground/60">
            It reads what you dumped and writes briefs and approaches. It starts nothing, ships nothing, and stands down
            the moment you send a message.
          </p>
        )}
      </div>
    </div>
  );
}
