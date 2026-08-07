"use client";

// One session in the sidebar inbox.
//
// LAYOUT DOCTRINE: the title is the only thing you scan for, so it leads. The
// previous row put the project name and a folder glyph on the FIRST line and
// the title underneath — which reads well with many projects and is pure noise
// with one, since every row then opens with the same word. Project is now
// meta, shown only when the sidebar says it earns the space (`showProject`).
//
// COST IS DELIBERATELY ABSENT from the row. It is a number you audit, not one
// you scan, and right-aligned mono currency on every line drew the eye away
// from the title. It moved to the hover card with the rest of the detail.
//
// The row carries exactly three states visually: running (the agent mark
// pulses and the meta line says so), unread (left accent + semibold title),
// and snoozed (the meta line becomes the wake time). Everything else is a
// hover affordance.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClockIcon, CircleCheckIcon } from "lucide-react";
import { fmtAgo, fmtCost, fmtTokens } from "@/lib/format";
import { providerForModel } from "@/lib/models";
import { patchChat } from "@/lib/chat-actions";
import { bandOf, isUnread, newSessionHref, type SidebarSession } from "@/lib/session-list";
import { ProviderIcon, PROVIDER_LABEL } from "@/components/session/provider-icon";
import { SessionInboxMenu } from "@/components/session/session-inbox-menu";
import { SnoozeMenu } from "@/components/session/snooze-menu";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";

// When a snoozed row is shown, its return time is the useful fact — not how
// long ago it was last touched. Days out reads as a date; anything sooner as a
// weekday and clock time.
function fmtWake(at: number, now: number): string {
  const wake = new Date(at);
  const days = Math.round((at - now) / (24 * 60 * 60 * 1000));
  const time = wake.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days >= 7) return wake.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (days >= 1) return `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return time;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-[11px] tabular-nums">{value}</span>
    </div>
  );
}

/** One cell of the stat band. An ABSENT figure renders as an em dash, never a
 *  confident zero — the same absent-is-not-zero rule the ultra surfaces follow. */
function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 bg-popover py-2">
      <span className="text-xs font-semibold tabular-nums">{value}</span>
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

/** The detail that used to fight the title for space on the row itself.
 *
 *  LAYOUT: status strip → identity (provider mark + title + state line) →
 *  preview as a quoted block → the three figures you scan (turns / context /
 *  cost) as a stat band → the long-tail facts as label rows. The state line
 *  answers "is it doing something right now" before any number does, which is
 *  the question a hover actually asks. The pulse dot is `motion-safe:` gated,
 *  same doctrine as the shimmer sweep in globals.css. */
function SessionDetails({
  session,
  renderedAt,
}: {
  session: SidebarSession;
  renderedAt: number;
}) {
  const provider = providerForModel(session.model);
  const snoozedUntil =
    session.snoozedUntil !== undefined && session.snoozedUntil > renderedAt
      ? session.snoozedUntil
      : undefined;
  // Issue #17: the main turn (`live`) is not the only thing that can be
  // happening for this session. An Ultra run launched from it keeps going as
  // its own detached process long after the turn that launched it returns —
  // see session-list.ts's SidebarSession comment on the field — so a row
  // must be able to read as active on that alone.
  const backgroundRuns = session.liveBackgroundRuns ?? 0;
  const working = session.live || backgroundRuns > 0;
  return (
    <div>
      {/* The strip carries the one ambient fact: primary while the agent is
          working, neutral otherwise. Tint, not text — the state line says it
          in words right below. */}
      <div
        aria-hidden
        className={`h-0.5 ${
          working
            ? "bg-gradient-to-r from-primary/70 via-primary/25 to-transparent"
            : "bg-gradient-to-r from-border to-transparent"
        }`}
      />
      <div className="flex items-start gap-2 px-3 pt-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
          <ProviderIcon provider={provider} size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-xs font-semibold leading-snug">
            {session.title || "Untitled session"}
          </span>
          <span className="mt-0.5 flex items-center gap-1 text-[10px]">
            {session.needsApproval ? (
              <span className="flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400">
                <span
                  aria-hidden
                  className="size-1.5 rounded-full bg-amber-500 motion-safe:animate-pulse"
                />
                Needs your approval
              </span>
            ) : session.live ? (
              <span className="flex items-center gap-1 font-medium text-primary">
                <span
                  aria-hidden
                  className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse"
                />
                Working…
              </span>
            ) : backgroundRuns > 0 ? (
              <span className="flex items-center gap-1 font-medium text-primary">
                <span
                  aria-hidden
                  className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse"
                />
                {backgroundRuns === 1 ? "1 run active in background" : `${backgroundRuns} runs active in background`}
              </span>
            ) : snoozedUntil ? (
              <span className="flex items-center gap-0.5 text-muted-foreground">
                <ClockIcon className="size-2.5" />
                Wakes {fmtWake(snoozedUntil, renderedAt)}
              </span>
            ) : (
              <span className="text-muted-foreground">
                Active {fmtAgo(session.updatedAt, renderedAt)}
              </span>
            )}
          </span>
        </span>
      </div>
      {session.preview ? (
        <p className="mx-3 mt-2 line-clamp-3 border-l-2 border-border pl-2 text-[11px] leading-snug text-muted-foreground">
          {session.preview}
        </p>
      ) : null}
      <div className="mt-2.5 grid grid-cols-3 gap-px border-y border-border/60 bg-border/60">
        <StatTile
          label="Turns"
          value={session.turns !== undefined ? String(session.turns) : "—"}
        />
        <StatTile
          label="Context"
          value={session.contextTokens ? fmtTokens(session.contextTokens) : "—"}
        />
        <StatTile label="Cost" value={fmtCost(session.costUsd)} />
      </div>
      <div className="space-y-0.5 px-3 py-2">
        <DetailRow
          label="Agent"
          value={
            session.model
              ? `${PROVIDER_LABEL[provider]} · ${session.model}`
              : PROVIDER_LABEL[provider]
          }
        />
        {session.effort ? <DetailRow label="Effort" value={session.effort} /> : null}
        {session.project ? <DetailRow label="Project" value={session.project} /> : null}
        <DetailRow label="Started" value={fmtAgo(session.createdAt, renderedAt)} />
      </div>
    </div>
  );
}

export function SessionRow({
  session,
  active,
  showProject,
  searchable = false,
  searchSelected = false,
  renderedAt,
  onRefresh,
}: {
  session: SidebarSession;
  active: boolean;
  showProject: boolean;
  searchable?: boolean;
  searchSelected?: boolean;
  renderedAt: number;
  onRefresh: () => void;
}) {
  // Distinguishes the docked desktop sidebar from the mobile <Sheet>, which is
  // a modal and therefore cannot host a body-portaled hover card.
  const { isMobile } = useSidebar();
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const input = useRef<HTMLInputElement>(null);
  // The hover card anchors to the whole row, not to the link inside it.
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);

  if (!session.project) return null;
  // Captured as a local so its non-optional narrowing survives into the
  // closures below (leaveIfActive) — TypeScript does not carry a guard on
  // `session.project` through a function defined afterward, only through a
  // local const.
  const project = session.project;
  const href = `/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(session.id)}`;
  const snoozedUntil =
    session.snoozedUntil !== undefined && session.snoozedUntil > renderedAt
      ? session.snoozedUntil
      : undefined;
  const settled = bandOf(session, renderedAt) === "settled";
  const unread = isUnread(session);
  const provider = providerForModel(session.model);
  const backgroundRuns = session.liveBackgroundRuns ?? 0;

  // Issue #12: settling or archiving the session you are currently VIEWING
  // must not maroon you on it. `deriveSessionList`'s survivor rule (see
  // session-list.ts) keeps this exact row visible in "Recent" for as long as
  // the URL still names it, precisely so an open session stays reachable
  // while you read it — but that rule fires just as reliably right after you
  // settle/archive the one row you were looking at, which is the bug: the
  // row survives its own settle because nothing ever stops naming it. The
  // fix is not in the survivor rule (which is correct for every OTHER case)
  // but here, at the point of the click — hand the user off to a fresh
  // session in the same project so the URL stops naming this one, and the
  // next refetch (already triggered by patchChat's own broadcast) shelves
  // the row like any other settled/archived session.
  const leaveIfActive = () => {
    if (active) router.push(newSessionHref(project));
  };

  const beginRename = () => {
    setDraft(session.title);
    setRenaming(true);
  };

  const commitRename = async () => {
    const next = draft.trim();
    setRenaming(false);
    // An unchanged or empty name is a cancel, not a write — the API would
    // reject the empty one anyway, and a no-op PATCH would still broadcast a
    // refresh that redraws every surface for nothing.
    if (!next || next === session.title) return;
    await patchChat(session.id, { title: next.slice(0, 120) });
    onRefresh();
  };

  if (renaming) {
    return (
      <div className="rounded-md bg-sidebar-accent px-2 py-1.5">
        <input
          ref={input}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitRename();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setRenaming(false);
            }
          }}
          aria-label="Rename session"
          className="w-full bg-transparent text-xs font-medium text-sidebar-foreground outline-none"
        />
      </div>
    );
  }

  // Shared by both branches below so the row looks identical whether or not it
  // is wrapped in a hover card.
  const rowBody = (
    <>
      <span className="relative flex size-3.5 shrink-0 items-center justify-center">
        <ProviderIcon provider={provider} size={14} />
        {session.needsApproval ? (
          // Amber, steady, outranking both live states: an unanswered card
          // means the work is paused on the user — the one sidebar state
          // whose job is to interrupt, in the same color the Marker
          // primitive reserves for attention.
          <span
            aria-hidden
            className="absolute -inset-1 rounded-full bg-amber-500/40 motion-safe:animate-pulse"
          />
        ) : session.live ? (
          <span
            aria-hidden
            className="absolute -inset-1 animate-ping rounded-full bg-primary/30"
          />
        ) : backgroundRuns > 0 ? (
          // A slower, non-expanding pulse rather than the main turn's ping —
          // background work is real activity but not the urgent "the agent
          // is streaming to you right now" fact the ping communicates.
          <span
            aria-hidden
            className="absolute -inset-1 rounded-full bg-primary/20 motion-safe:animate-pulse"
          />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-xs text-sidebar-foreground ${
            unread ? "font-semibold" : "font-medium"
          }`}
        >
          {session.title || "Untitled session"}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-sidebar-foreground/45">
          {session.needsApproval ? (
            <span className="shrink-0 font-medium text-amber-600 dark:text-amber-400">
              Needs your approval
            </span>
          ) : session.live ? (
            <span className="shrink-0 font-medium text-primary">Working…</span>
          ) : backgroundRuns > 0 ? (
            <span className="shrink-0 font-medium text-primary">
              {backgroundRuns === 1 ? "1 running" : `${backgroundRuns} running`}
            </span>
          ) : snoozedUntil ? (
            <span className="flex shrink-0 items-center gap-0.5">
              <ClockIcon className="size-2.5" />
              {fmtWake(snoozedUntil, renderedAt)}
            </span>
          ) : (
            <span className="shrink-0">{fmtAgo(session.updatedAt, renderedAt)}</span>
          )}
          {showProject ? (
            <>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate">{session.project}</span>
            </>
          ) : null}
        </span>
      </span>
    </>
  );

  return (
    <div
      ref={rowRef}
      className={`group/session relative flex items-center rounded-md ${
        active || searchSelected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/70"
      }`}
    >
      {/* Unread as a left accent rather than an inline dot: a dot sat between
          the agent mark and the title and competed with both, and with most
          rows unread it read as decoration instead of signal. */}
      {unread ? (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary"
        />
      ) : null}

      {/* NO HOVER CARD IN THE MOBILE SHEET, AND THAT IS THE WHOLE BUG.
          Under 768px (hooks/use-mobile.ts) <Sidebar> stops being a docked panel
          and renders the mobile <Sheet> — a MODAL dialog. HoverCardContent
          portals to <body>, i.e. outside that dialog, so the modal treats the
          card as an outside element and dismisses it the instant it appears.
          The symptom is a card that opens and vanishes within a few frames, and
          it reproduces in Telar's own integrated browser panel, which is
          narrower than the breakpoint.
          A hover affordance in a modal sheet at phone width has nothing to
          offer anyway — the row simply renders as a plain link there.

          delay/closeDelay live on the Trigger in @base-ui 1.6, not the Root,
          and already default to 600/300ms — long enough that scanning the list
          never fires a card you did not ask for. */}
      {isMobile ? (
        <Link
          id={`sidebar-session-${session.id}`}
          href={href}
          prefetch={false}
          role={searchable ? "option" : undefined}
          aria-selected={searchable ? searchSelected : undefined}
          aria-current={active ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 pr-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {rowBody}
        </Link>
      ) : (
      <HoverCard>
        {/* `id` MUST live on the Trigger, never on the render element. The
            trigger registers itself in the preview-card store under its `id`
            PROP (useBaseUiId(idProp)); an id on the render element overrides
            the DOM id while the store still holds the generated one, so the
            open can't be attributed to this trigger and is rescinded the
            frame it fires — the card mounts already-closing, ~600ms after
            hover, every time. Measured headlessly on both dev and the packaged
            app before this move; stable after. */}
        <HoverCardTrigger
          id={`sidebar-session-${session.id}`}
          render={
            <Link
              href={href}
              // Session routes are force-dynamic and carry the transcript. They
              // are deliberately fetched only when selected; speculative RSC
              // work here multiplies across every open Telar window.
              prefetch={false}
              role={searchable ? "option" : undefined}
              aria-selected={searchable ? searchSelected : undefined}
              aria-current={active ? "page" : undefined}
              onDoubleClick={(event: React.MouseEvent) => {
                event.preventDefault();
                beginRename();
              }}
              className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 pr-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          {rowBody}
        </HoverCardTrigger>
        {/* THREE POSITIONING CHOICES, EACH FIXING A DISTINCT FLICKER SOURCE.
            The card closes on pointer-out via `handleClose: safePolygon()`
            (@base-ui/react 1.6 preview-card/trigger), which tracks the pointer
            through the gap between anchor and popup. Anything that moves the
            anchor, or puts the popup where the pointer already is, turns that
            into an open/close loop.

            `anchor={rowRef}` — the TRIGGER is only the <Link>, which stops
            where the action buttons begin. Anchoring to the trigger therefore
            opened the card on top of this row's own Settle/Snooze/⋯ controls.
            The row element spans the full sidebar width, so anchoring to it
            puts the card cleanly beyond the sidebar edge instead.

            `positionMethod="fixed"` — with the default "absolute", a card that
            overflows the viewport GROWS THE DOCUMENT: a horizontal scrollbar
            appears, layout shifts, the anchor moves, hover is re-evaluated, the
            card closes, the scrollbar goes away, and it reopens. Fixed
            positioning cannot resize the document, so that loop cannot start.

            `side: "shift"` — keeps the card on the right but slides it back
            inside the viewport rather than flipping it over the row. (The
            earlier `side: "none"` deliberately allowed overflow, which is
            exactly what fed the scrollbar loop above.) */}
        <HoverCardContent
          anchor={rowRef}
          side="right"
          align="start"
          sideOffset={8}
          positionMethod="fixed"
          collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
          // p-0 so the status strip and stat band run edge to edge; sections
          // carry their own padding. duration-150 gives the slide-in room to
          // read as motion rather than a pop.
          className="w-64 overflow-hidden p-0 duration-150"
        >
          <SessionDetails session={session} renderedAt={renderedAt} />
        </HoverCardContent>
      </HoverCard>
      )}

      {/* The two transitions worth one click each sit on the row itself; the
          long tail stays in the menu. Hidden until hover so a resting list is
          just titles, but forced visible while any of their popups is open. */}
      {!searchable && (
        <span className="flex shrink-0 items-center gap-0.5 pr-1 opacity-0 transition-opacity group-hover/session:opacity-100 group-focus-within/session:opacity-100 has-data-popup-open:opacity-100">
          {!settled && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Settle session"
              title="Settle"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                void patchChat(session.id, { settled: true }).then(() => {
                  onRefresh();
                  leaveIfActive();
                });
              }}
            >
              <CircleCheckIcon />
            </Button>
          )}
          <SnoozeMenu
            session={session}
            snoozed={snoozedUntil !== undefined}
            onDone={onRefresh}
          />
          <SessionInboxMenu
            session={session}
            settled={settled}
            snoozed={snoozedUntil !== undefined}
            active={active}
            onRename={beginRename}
            onDone={onRefresh}
          />
        </span>
      )}
    </div>
  );
}
