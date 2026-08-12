"use client";
// LANE: workspace (UX 5) — one ripening work packet. A todo that outgrew a
// one-liner: the raw fragment it was born as, the fixed version an expert
// wrote, attachments gathered over days (bed-mode drafts marked as
// proposals), and the handoff. Per the loom-birth doctrine (UX 0): the
// packet IS the premise + context a loom is born from — clicking hands it
// over and the loom DETACHES; the packet stays as the origin receipt.
// Agents prepared everything; nothing runs until the human clicks.
//
// ── RE-SKIN PASS (2026-08-08): MIRRORING THE PRODUCTION TWIN ───────────────
// components/workspace/packet-view.tsx was hand-ported from this file, and the
// port is what taught the app the idiom this drawing predates. Re-dressed to
// match it exactly where the two draw the same thing:
//
//   · header       → PageHeader (the app's one chrome), breadcrumb in its
//                    `description`, then the chip row underneath.
//   · headings     → the shared SectionLabel — `font-medium`, not the
//                    `font-semibold` these prototypes used; semibold is
//                    GroupHeader's register, one level up.
//   · buttons      → components/ui/button, so the handoff's three affordances
//                    carry the app's one focus ring instead of three
//                    hand-rolled hover states. Primary / OUTLINE / ghost, with
//                    the outline at full width beside the primary — the equal
//                    weight ui-contract.md §4 means by "instead".
//   · timeline     → the rail is `bg-border/70` and the `· proposal` suffix is
//                    `text-muted-foreground/70`: at /40 the honesty mark was
//                    the least legible thing on the surface, which is the
//                    opposite of what invariant 6 asks of it.
//   · receipt      → <DetachReceipt>, composed by weaveDetachReceipt.
//   · type scale   → `text-[9px]` and `text-foreground/80/85` are gone. The
//                    app's small step is 10px and its body colour is
//                    `text-foreground`; the fractional opacities were a way of
//                    dimming prose that the muted token already names.
//
// THE RECEIPT IS COMPOSED, NOT SPELLED, for the reason cross-surface invariant
// 2 gives: "one line, one grammar, identical from birth session, batch weave,
// or packet handoff". This file used to hold one of the three phrasings
// lib/detach-receipt.ts was written to replace — and the module's own header
// cites it by line number. It renders the module now.
//
// CONTENT AND IA ARE UNTOUCHED: breadcrumb · title · chips, Born as (raw →
// transition line → fixed brief + acceptance), Gathered along the way with
// dashed proposal cards, Ripening, Its turn came and its caption.
import { useState } from "react";
import {
  FileTextIcon,
  LayoutTemplateIcon,
  MessageSquareIcon,
  MoonIcon,
  MoveRightIcon,
  SparklesIcon,
  StickyNoteIcon,
  UserIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DetachReceipt } from "@/components/common/detach-receipt";
import { PageHeader } from "@/components/common/page-header";
import { weaveDetachReceipt } from "@/lib/detach-receipt";
import { cn } from "@/lib/utils";
import { PACKET, type PacketActor } from "./fixtures";
import { DeadlineChip, ProjectChip, SectionLabel, VerdictChip } from "./shared";

const ACTOR: Record<PacketActor, { Icon: LucideIcon; label: string }> = {
  you: { Icon: UserIcon, label: "you" },
  expert: { Icon: SparklesIcon, label: "aurora expert" },
  bed: { Icon: MoonIcon, label: "bed mode" },
};

// Three attachments, hence the receipt's `context = 3 attachments` below — one
// number, read from the same place the cards are, so the handoff cannot claim
// a context the page does not show.
const ATTACHMENTS: { Icon: LucideIcon; title: string; meta: string; proposal?: boolean }[] = [
  {
    Icon: LayoutTemplateIcon,
    title: "onboarding-v2.html",
    meta: "draft mockup — merged steps 2/3, invite path kept",
    proposal: true,
  },
  {
    Icon: FileTextIcon,
    title: "Wednesday sync — transcript excerpt",
    meta: "you pasted the transcript; the expert cut Diego on the step-2→3 drop-off",
  },
  {
    Icon: FileTextIcon,
    title: "Expert read",
    meta: "3 screens + auth touchpoints — recommend a loom over a session",
    proposal: true,
  },
];

function Attachment({
  Icon,
  title,
  meta,
  proposal,
}: {
  Icon: LucideIcon;
  title: string;
  meta: string;
  proposal?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border bg-card p-3",
        // Invariant 6: proposals are VISIBLY dashed. Dashed is the whole
        // signal — no state hue anywhere on the card, because a proposal is not
        // a status, it is a thing waiting to be looked at.
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
          className="flex shrink-0 items-center gap-1 rounded-full border border-dashed border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          title="Bed-mode output — awaiting your look, nothing committed"
        >
          <MoonIcon className="size-2.5" /> proposal
        </span>
      )}
    </div>
  );
}

// One packet, one loom: `items: 1`, the fixed brief the expert wrote, its three
// acceptance criteria, and the three attachments above. Every number is read
// off this page rather than typed into a sentence.
const RECEIPT = weaveDetachReceipt("loom/onboarding-rework", {
  items: 1,
  fixed: 1,
  acceptance: PACKET.acceptance.length,
  attachments: ATTACHMENTS.length,
});

export function WorkspacePacketDemo() {
  const [woven, setWoven] = useState(false);
  return (
    <div className="flex h-full flex-col bg-background">
      <PageHeader title={PACKET.title} description={`Workspace · ${PACKET.lane} · rank 2`} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          <div className="mb-6 flex flex-wrap items-center gap-1.5">
            <ProjectChip name={PACKET.project} mirrored={PACKET.mirrored} />
            <DeadlineChip deadline={{ label: "Fri", kind: "self" }} />
            <VerdictChip verdict={PACKET.verdict} />
          </div>

          <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
            <div className="min-w-0 space-y-6">
              <section>
                <SectionLabel>Born as</SectionLabel>
                <div className="rounded-lg border border-border bg-muted/40 p-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <StickyNoteIcon className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{PACKET.rawSource}</span>
                  </div>
                  {/* The fragment is verbatim and MONO, and it is full-strength
                      foreground: it is the most load-bearing text on the page —
                      the thing the whole packet claims to have grown from. */}
                  <p className="mt-2 font-mono text-sm text-foreground">{PACKET.raw}</p>
                </div>
                <div className="my-2 flex items-center gap-2 pl-3 text-[11px] text-muted-foreground/60">
                  <MoveRightIcon className="size-3.5 rotate-90" />
                  fixed and filed by the aurora expert · bed mode, Tue 03:02
                </div>
                <div className="rounded-lg border border-border bg-card p-3">
                  <p className="text-sm leading-relaxed">{PACKET.fixed}</p>
                  <ul className="mt-3 space-y-1 border-t border-border/70 pt-2">
                    {PACKET.acceptance.map((a) => (
                      <li key={a} className="flex items-start gap-2 text-xs text-muted-foreground">
                        <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/60" />
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>
              </section>

              <section>
                <SectionLabel>Gathered along the way</SectionLabel>
                <div className="space-y-2">
                  {ATTACHMENTS.map((a) => (
                    <Attachment key={a.title} {...a} />
                  ))}
                </div>
              </section>
            </div>

            <aside className="space-y-6">
              <section>
                <SectionLabel>Ripening</SectionLabel>
                <div className="space-y-0">
                  {PACKET.timeline.map((ev, i) => {
                    const { Icon, label } = ACTOR[ev.actor];
                    const last = i === PACKET.timeline.length - 1;
                    return (
                      <div key={`${ev.at}-${i}`} className="relative flex gap-3 pb-4">
                        {!last && (
                          <span className="absolute top-5 bottom-0 left-[9px] w-px bg-border/70" />
                        )}
                        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-card">
                          <Icon className="size-2.5 text-muted-foreground" />
                        </span>
                        <div className="min-w-0 text-xs">
                          <p className="font-mono text-[10px] text-muted-foreground/60">
                            {ev.at} · {label}
                            {/* Legible on purpose (invariant 6): a proposal
                                mark the eye slides off is not honesty. */}
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
              </section>

              <section className="space-y-2">
                <SectionLabel>Its turn came</SectionLabel>
                {woven ? (
                  <DetachReceipt receipt={RECEIPT} />
                ) : (
                  <>
                    <Button className="w-full" onClick={() => setWoven(true)}>
                      <WorkflowIcon />
                      Plan loom from this packet
                    </Button>
                    <Button variant="outline" className="w-full">
                      <MessageSquareIcon />
                      Start a session instead
                    </Button>
                    <Button variant="ghost" size="sm" className="w-full text-muted-foreground">
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
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
