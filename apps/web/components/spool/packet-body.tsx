"use client";

/**
 * ONE PACKET, RENDERED ONCE — the sections both the page and the panel draw.
 *
 * ── THE DUPLICATE THIS ENDS ──────────────────────────────────────────────────
 * There were two renderers for the same object and each was missing what the
 * other had. `packet-view.tsx` drew the raw capture, the brief, the sub-tasks,
 * the ripening timeline and the expert button — and had ZERO references to
 * `item.draft`, so the approach the night paid for was invisible on the packet's
 * own page. The panel drew the draft and none of the rest.
 *
 * That is the same duplicate the cockpit's right panel records having made once
 * with Changes/Git: "both drew a list of changed files … one click apart in the
 * same strip". The fix there and here is the same — one body, two arrangements.
 *
 * ── SECTIONS, NOT A LAYOUT ───────────────────────────────────────────────────
 * This file exports the CONTENT and neither caller's arrangement, because the
 * arrangement difference is real and intended: the page has a 5xl grid with an
 * aside, and the panel is one column at 384px and up. Exporting a `layout` prop
 * would put both arrangements in one component and make every future change to
 * either read as a change to both.
 */
import { useCallback, useState, type ReactNode } from "react";
import {
  FileTextIcon,
  Loader2Icon,
  MoonIcon,
  MoveRightIcon,
  SparklesIcon,
  StickyNoteIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import type { SpoolActor, SpoolItem, SpoolWork } from "@telar/engine-client";
import { Button } from "@/components/ui/button";
import { describeWork, type SpoolWorkView } from "@/lib/spool-work";
import { cn } from "@/lib/utils";

export const ACTOR_META: Record<SpoolActor, { Icon: typeof UserIcon; label: string }> = {
  you: { Icon: UserIcon, label: "you" },
  expert: { Icon: SparklesIcon, label: "expert" },
  bed: { Icon: MoonIcon, label: "bed mode" },
  session: { Icon: FileTextIcon, label: "session" },
};

/** The app's section label: small, medium (NOT semibold — that is the group
 *  header's register, one level up), uppercase, wide tracking. One tone up
 *  from meta so a section can be found at a glance, still below the bands. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="mb-2 text-2xs font-medium tracking-[0.12em] text-muted-foreground/80 uppercase">{children}</h2>;
}

/**
 * THE RAW FRAGMENT, VERBATIM, ABOVE THE BRIEF THAT REPLACED IT.
 *
 * Keeping the two side by side is load-bearing: it is what lets the user check
 * the expert did not drift from what they meant. No write path in the store can
 * overwrite `raw`, and this is the surface that makes that guarantee worth
 * having.
 */
export function BornAs({ item, dense = false }: { item: SpoolItem; dense?: boolean }) {
  if (!item.raw && !item.fixed) return null;
  return (
    <section>
      <SectionLabel>Born as</SectionLabel>
      {item.raw && (
        <div className="rounded-xl bg-muted/40 p-3 ring-1 ring-foreground/10">
          {item.rawSource && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <StickyNoteIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{item.rawSource}</span>
            </div>
          )}
          <p className={cn("mt-2 font-mono text-foreground", dense ? "text-xs leading-relaxed" : "text-sm")}>{item.raw}</p>
        </div>
      )}
      {item.fixed && (
        <>
          {item.raw && (
            <div className="my-2 flex items-center gap-2 pl-3 text-2xs text-muted-foreground/60">
              <MoveRightIcon className="size-3.5 rotate-90" />
              fixed
            </div>
          )}
          <div className="rounded-xl bg-card p-3 shadow-1 ring-1 ring-foreground/10">
            {/* `max-w-prose` in the DENSE arrangement only. The page's grid
                already holds the measure; the panel can be dragged to 900px and
                a brief set in one unbroken line across it is the "big context"
                complaint that started this. */}
            <p className={cn("leading-relaxed", dense ? "max-w-prose text-xs" : "text-sm")}>{item.fixed}</p>
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
  );
}

/**
 * THE NIGHT'S OUTPUT, WHICH THE PACKET PAGE COULD NOT SHOW AT ALL.
 *
 * `packet-view.tsx` had no reference to `item.draft`, so a night that ran, cost
 * a dollar and wrote an approach left a timeline entry saying it had happened
 * above a page that did not contain it.
 *
 * THE QUESTIONS ARE ABOVE THE APPROACH, and that is a claim about who the two
 * are addressed to. The approach is the agent thinking out loud; a question is
 * addressed to YOU and is the only part of a draft that is blocked on a person.
 * `docs/spool-definition.md` §8 names it among the things the morning must show.
 */
export function ProposedApproach({ item }: { item: SpoolItem }) {
  if (!item.draft && !item.openQuestions?.length) return null;
  return (
    <section>
      <SectionLabel>Proposed approach</SectionLabel>
      <div className="rounded-xl bg-card shadow-1 ring-1 ring-foreground/10">
        {item.openQuestions && item.openQuestions.length > 0 && (
          <div className="border-b border-border/70 p-3">
            <p className="mb-2 text-2xs text-muted-foreground">
              It could not answer {item.openQuestions.length === 1 ? "this" : "these"} alone.
            </p>
            <ul className="space-y-1.5">
              {item.openQuestions.map((question) => (
                <li key={question} className="flex items-start gap-2 text-xs leading-relaxed text-foreground">
                  <span className="mt-1.5 size-1 shrink-0 rounded-full bg-spool" />
                  {question}
                </li>
              ))}
            </ul>
          </div>
        )}
        {item.draft && (
          /* `whitespace-pre-wrap` because the night composes the risks under
             their own heading with real newlines, and `max-w-prose` because a
             wide panel would otherwise set this in one unreadable line. */
          <p className="max-w-prose p-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {item.draft}
          </p>
        )}
      </div>
      <p className="mt-1.5 text-3xs leading-relaxed text-muted-foreground/60">
        An agent wrote this and nobody has looked. It changes nothing on its own.
      </p>
    </section>
  );
}

/** One ripening event. Extracted so the timeline and any future single-event
 *  rendering cannot drift in how they mark a proposal. */
function TimelineNode({
  at,
  actor,
  text,
  proposal,
  last,
}: {
  at: string;
  actor: SpoolActor;
  text: string;
  proposal?: boolean;
  last: boolean;
}) {
  const { Icon, label } = ACTOR_META[actor] ?? { Icon: UserIcon, label: actor };
  return (
    <div className="relative flex gap-3 pb-4">
      {/* The rail BETWEEN nodes is an internal divider, one step behind the node
          rings it connects. */}
      {!last && <span className="absolute top-5 bottom-0 left-[9px] w-px bg-border/70" />}
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-card">
        <Icon className="size-2.5 text-muted-foreground" />
      </span>
      <div className="min-w-0 text-xs">
        <p className="font-mono text-3xs text-muted-foreground/60 tabular-nums">
          {at} · {label}
          {/* THE HONESTY MARKER: one word saying an agent wrote this and nobody
              has looked. It is not the faintest thing on the node, which is
              where it started and was exactly backwards. */}
          {proposal && <span className="text-muted-foreground/70"> · proposal</span>}
        </p>
        <p className="mt-0.5 leading-snug text-foreground">{text}</p>
      </div>
    </div>
  );
}

export function RipeningTimeline({ item }: { item: SpoolItem }) {
  const timeline = item.timeline ?? [];
  if (timeline.length === 0) {
    return (
      <p className="font-mono text-3xs text-muted-foreground/60">
        {item.captured} · {item.provenance}
      </p>
    );
  }
  return (
    <div className="space-y-0">
      {timeline.map((ev, i) => (
        <TimelineNode
          key={`${ev.at}-${i}`}
          at={ev.at}
          actor={ev.actor}
          text={ev.text}
          {...(ev.proposal ? { proposal: true } : {})}
          last={i === timeline.length - 1}
        />
      ))}
    </div>
  );
}

/**
 * THE ONE CONTROL ON A PACKET THAT SPENDS MONEY.
 *
 * ── IT NOW HAS A BODY, AND THAT IS THE WHOLE CHANGE ──────────────────────────
 * This used to be a local `consulting` boolean beside a `Loader2Icon`. A pass
 * runs fifteen to twenty-two turns; navigate away and the boolean was gone,
 * reload and a second click started a second pass, and nothing ever said what
 * the expert was doing for those minutes.
 *
 * It now reads the engine's own record: which step it is on, and a way to stop
 * it. A refusal still renders HERE, under the button that asked — every one of
 * them names the next move, and the surface that asked the question is where the
 * answer belongs.
 *
 * A QUIET OUTLINE RATHER THAN A FILLED BUTTON, because of what it costs, and it
 * sits at the END of the ripening history because that is what it extends.
 */
export function ExpertControl({
  item,
  work,
  onDone,
  disabled = false,
}: {
  item: SpoolItem;
  work: SpoolWorkView;
  /** Called when a pass settles, so the caller can re-read the packet it just
   *  rewrote. */
  onDone: () => void;
  disabled?: boolean;
}) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const running = work.runningFor(item.id);
  const settled = work.settledFor(item.id);
  /** The id whose settling this control is still waiting to react to. Without
   *  it, `onDone` would fire on every poll for as long as the settled entry sits
   *  in the registry's tail. */
  const [awaiting, setAwaiting] = useState<string | null>(null);

  if (awaiting && settled?.id === awaiting) {
    // Render-phase, not an effect: this is derived state catching up to a prop,
    // which is the case React documents as an adjustment rather than a sync.
    setAwaiting(null);
    onDone();
  }

  const consult = useCallback(() => {
    setRefusal(null);
    void (async () => {
      try {
        const res = await fetch(`/api/spool/items/${encodeURIComponent(item.id)}/expert`, { method: "POST" });
        const started = await res.json();
        // A REFUSAL IS AN ANSWER — "this item is floating, so it has no expert"
        // names the one thing only the user can do.
        if (started?.refused) setRefusal(started.refused);
        else if (started?.work?.id) setAwaiting(started.work.id);
        work.began();
      } catch (err) {
        setRefusal(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [item.id, work]);

  return (
    <div className="space-y-2 border-t border-border/70 pt-3">
      {running ? (
        <div className="rounded-xl bg-card p-2.5 shadow-1 ring-1 ring-foreground/10">
          <div className="flex items-center gap-2">
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-spool" />
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">
              {running.project ? `The ${running.project} expert is reading this` : "An expert is reading this"}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="Stop this pass"
              title="Stop this pass — nothing will be written"
              onClick={() => work.cancel(running.id)}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
          {/* THE STEP, and it is the reason any of this exists: a minutes-long
              call that says "Read reconciliation.ts" is one you can tell is on
              the right track. `n` counts rather than estimating — there is no
              total to be a percentage of. */}
          <p className="mt-1 truncate pl-5.5 font-mono text-3xs text-muted-foreground">
            {running.step ? `${running.step.n} · ${describeWork(running)}` : describeWork(running)}
          </p>
        </div>
      ) : (
        <Button variant="outline" size="sm" className="w-full" disabled={disabled} onClick={consult}>
          <SparklesIcon />
          Ask the expert
        </Button>
      )}
      <p className="text-3xs leading-relaxed text-muted-foreground/60">
        {item.project
          ? `The ${item.project} expert rewrites the brief and remembers what it learned. It changes nothing else.`
          : "An expert belongs to a project. File this item into one first."}
      </p>
      {/* THE OUTCOME OF THE LAST PASS, from the engine's record rather than from
          a variable this component happened to be holding — so it survives a
          navigation and a reload, which is the whole point. */}
      {(refusal ?? (settled && settled.state !== "done" ? settled.note : null)) && (
        <p className="rounded-lg bg-muted/60 px-2 py-1.5 text-2xs leading-relaxed text-muted-foreground">
          {refusal ?? settled?.note}
        </p>
      )}
    </div>
  );
}

/** What a settled pass wrote, when there is something worth saying. Separate
 *  from the refusal line above because "it worked, and here is what changed" is
 *  a different sentence from "it would not, and here is why". */
export function lastPassNote(settled: SpoolWork | undefined): string | null {
  return settled?.state === "done" ? (settled.note ?? null) : null;
}
