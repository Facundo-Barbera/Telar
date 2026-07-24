"use client";
// LANE: workspace (UX 5) — one ripening work packet. A todo that outgrew a
// one-liner: the raw fragment it was born as, the fixed version an expert
// wrote, attachments gathered over days (bed-mode drafts marked as
// proposals), and the handoff. Per the loom-birth doctrine (UX 0): the
// packet IS the premise + context a loom is born from — clicking hands it
// over and the loom DETACHES; the packet stays as the origin receipt.
// Agents prepared everything; nothing runs until the human clicks.
import { useState } from "react";
import {
  CircleCheckIcon,
  FileTextIcon,
  LayoutTemplateIcon,
  MoonIcon,
  MoveRightIcon,
  SparklesIcon,
  StickyNoteIcon,
  UserIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PACKET, type PacketActor } from "./fixtures";
import { DeadlineChip, ProjectChip, VerdictChip } from "./shared";

const ACTOR: Record<PacketActor, { Icon: typeof UserIcon; label: string }> = {
  you: { Icon: UserIcon, label: "you" },
  expert: { Icon: SparklesIcon, label: "aurora expert" },
  bed: { Icon: MoonIcon, label: "bed mode" },
};

function Attachment({
  Icon,
  title,
  meta,
  proposal,
}: {
  Icon: typeof FileTextIcon;
  title: string;
  meta: string;
  proposal?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border bg-card p-3",
        proposal ? "border-dashed border-border" : "border-border",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{meta}</p>
      </div>
      {proposal && (
        <span
          className="flex shrink-0 items-center gap-1 rounded-full border border-dashed border-border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground"
          title="Bed-mode output — awaiting your look, nothing committed"
        >
          <MoonIcon className="size-2.5" /> proposal
        </span>
      )}
    </div>
  );
}

export function WorkspacePacketDemo() {
  const [woven, setWoven] = useState(false);
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <header className="mb-6">
        <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
          Workspace · Aurora · rank 2
        </p>
        <h1 className="text-xl font-semibold tracking-tight">{PACKET.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <ProjectChip name={PACKET.project} mirrored={PACKET.mirrored} />
          <DeadlineChip deadline={{ label: "Fri", kind: "self" }} />
          <VerdictChip verdict={PACKET.verdict} />
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="min-w-0 space-y-6">
          <section>
            <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Born as
            </h2>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <StickyNoteIcon className="size-3.5" /> {PACKET.rawSource}
              </div>
              <p className="mt-2 font-mono text-sm text-foreground/80">{PACKET.raw}</p>
            </div>
            <div className="my-2 flex items-center gap-2 pl-3 text-[11px] text-muted-foreground/60">
              <MoveRightIcon className="size-3.5 rotate-90" />
              fixed and filed by the aurora expert · bed mode, Tue 03:02
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <p className="text-sm leading-relaxed">{PACKET.fixed}</p>
              <ul className="mt-3 space-y-1 border-t border-border pt-2">
                {PACKET.acceptance.map((a) => (
                  <li key={a} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                    {a}
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Gathered along the way
            </h2>
            <div className="space-y-2">
              <Attachment
                Icon={LayoutTemplateIcon}
                title="onboarding-v2.html"
                meta="draft mockup — merged steps 2/3, invite path kept"
                proposal
              />
              <Attachment
                Icon={FileTextIcon}
                title="Wednesday sync — transcript excerpt"
                meta="you pasted the transcript; the expert cut Diego on the step-2→3 drop-off"
              />
              <Attachment
                Icon={FileTextIcon}
                title="Expert read"
                meta="3 screens + auth touchpoints — recommend a loom over a session"
                proposal
              />
            </div>
          </section>
        </div>

        <aside className="space-y-6">
          <section>
            <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Ripening
            </h2>
            <div className="space-y-0">
              {PACKET.timeline.map((ev, i) => {
                const { Icon, label } = ACTOR[ev.actor];
                const last = i === PACKET.timeline.length - 1;
                return (
                  <div key={`${ev.at}-${i}`} className="relative flex gap-3 pb-4">
                    {!last && (
                      <span className="absolute left-[9px] top-5 bottom-0 w-px bg-border" />
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
          </section>

          <section className="space-y-2">
            <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Its turn came
            </h2>
            {woven ? (
              <div className="space-y-2 rounded-lg border border-border bg-card p-3">
                <div className="flex items-start gap-2">
                  <CircleCheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
                    loom created — loom/onboarding-rework · premise = the fixed brief +
                    acceptance criteria · context = 3 attachments · detached from the
                    workspace
                  </p>
                </div>
                <p className="font-mono text-[9px] leading-relaxed text-muted-foreground/50">
                  the packet stays here as the loom’s origin receipt · preparation runs on
                  the loom’s own graph
                </p>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setWoven(true)}
                  className="flex w-full items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
                >
                  Plan loom from this packet
                </button>
                <button
                  type="button"
                  className="flex w-full items-center justify-center rounded-md border border-border px-3 py-2 text-sm text-foreground hover:bg-muted"
                >
                  Start a session instead
                </button>
                <button
                  type="button"
                  className="flex w-full items-center justify-center rounded-md px-3 py-2 text-xs text-muted-foreground hover:bg-muted"
                >
                  Not now — back to the stack
                </button>
                <p className="pt-1 text-center text-[10px] leading-relaxed text-muted-foreground/60">
                  everything above was prepared by agents —
                  <br />
                  nothing runs until you click
                </p>
              </>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
