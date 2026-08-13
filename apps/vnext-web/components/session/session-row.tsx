"use client";

// One session in the sidebar inbox. Ported from the frozen app's
// components/session/session-row.tsx.
//
// LAYOUT DOCTRINE (unchanged): the title is the only thing you scan for, so it
// leads. Project is meta, shown only when the sidebar says it earns the space
// (`showProject`). SPEND IS DELIBERATELY ABSENT from the row — it is a number
// you audit, not one you scan, and a right-aligned mono figure on every line
// drew the eye away from the title. It lives in the hover card with the rest,
// and it is measured in TOKENS: see lib/format.ts for why money left.
//
// WHAT THE DONOR HAD THAT THIS CANNOT. The legacy row carried five live states:
// running, unread, snoozed, needs-approval, and background runs. Every one of
// them came from a per-request join the legacy `GET /api/chats` performed over
// registries the vNext engine does not have — and `GET /v2/sessions` answers
// with `Session` records alone (see lib/session-list.ts). Rather than paint a
// dot nothing can turn on, the row shows what the engine actually knows:
// identity, provider, recency, and whether the session has been archived.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArchiveIcon, CircleCheckIcon, UndoIcon } from "lucide-react";
import { fmtAgo, fmtTokens } from "@/lib/format";
import { bandOf, sessionHref, type SidebarSession } from "@/lib/session-list";
import { ProviderIcon, PROVIDER_LABEL } from "@/components/session/provider-icon";
import { SessionInboxMenu, patchSession } from "@/components/session/session-inbox-menu";
import { canSettle } from "@/lib/session-settling";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-[11px] tabular-nums">{value}</span>
    </div>
  );
}

/** One cell of the stat band. An ABSENT figure renders as an em dash, never a
 *  confident zero — absent is not zero. */
function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 bg-popover py-2">
      <span className="text-xs font-semibold tabular-nums">{value}</span>
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
    </div>
  );
}

/** The detail that used to fight the title for space on the row itself.
 *
 *  LAYOUT: status strip → identity (provider mark + title + state line) →
 *  the figures you scan as a stat band → the long-tail facts as label rows. */
function SessionDetails({ session, renderedAt }: { session: SidebarSession; renderedAt: number }) {
  return (
    <div>
      {/* The strip carries the one ambient fact this row can state: whether the
          session is still in play. Tint, not text — the state line says it in
          words right below. */}
      <div
        aria-hidden
        className={`h-0.5 ${
          session.archived
            ? "bg-gradient-to-r from-border to-transparent"
            : "bg-gradient-to-r from-primary/70 via-primary/25 to-transparent"
        }`}
      />
      <div className="flex items-start gap-2 px-3 pt-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
          <ProviderIcon provider={session.driver} size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-xs font-semibold leading-snug">{session.title || "Untitled session"}</span>
          <span className="mt-0.5 flex items-center gap-1 text-[10px]">
            {session.archived ? (
              <span className="flex items-center gap-0.5 text-muted-foreground">
                <CircleCheckIcon className="size-2.5" />
                Archived
              </span>
            ) : (
              <span className="text-muted-foreground">Active {fmtAgo(session.updatedAt, renderedAt)}</span>
            )}
          </span>
        </span>
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-px border-y border-border/60 bg-border/60">
        <StatTile label="Context" value={session.contextTokens ? fmtTokens(session.contextTokens) : "—"} />
        {/* Was "Cost". Tokens are the unit this cockpit reports — see
            lib/format.ts for why money left. */}
        <StatTile label="Tokens" value={session.tokens === undefined ? "—" : fmtTokens(session.tokens)} />
        <StatTile label="Workspace" value={session.worktreeBranch ? "Worktree" : "Local"} />
      </div>
      <div className="space-y-0.5 px-3 py-2">
        <DetailRow
          label="Agent"
          value={session.model ? `${PROVIDER_LABEL[session.driver]} · ${session.model}` : PROVIDER_LABEL[session.driver]}
        />
        {session.effort ? <DetailRow label="Effort" value={session.effort} /> : null}
        {session.projectName ? <DetailRow label="Project" value={session.projectName} /> : null}
        {session.worktreeBranch ? <DetailRow label="Branch" value={session.worktreeBranch} /> : null}
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

  const href = sessionHref(session);
  const settled = bandOf(session, renderedAt) === "settled";
  /**
   * SHELVED BY A DECISION, not by neglect — which is the only case the row's
   * own button can UNDO. A session that drifted onto the shelf because nobody
   * touched it for three days has nothing to un-press; offering it an undo
   * would promise a state change that does not exist, and pressing it would
   * appear to do nothing.
   */
  const settledByDecision = session.settledOverride === "settled";

  // Archiving the session you are currently VIEWING must not maroon you on it:
  // the survivor rule in deriveSessionList keeps this row visible for as long as
  // the URL names it, which is right for every other case and exactly wrong
  // here. Hand the reader back to the project's session list instead.
  const leaveIfActive = () => {
    // `/projects`, not `/`: `/` is a composer now, and archiving the session you
    // were reading should hand you the list you came from rather than a blank
    // message box you did not ask for.
    if (active) router.push("/projects");
  };

  const beginRename = () => {
    setDraft(session.title);
    setRenaming(true);
  };

  const commitRename = async () => {
    const next = draft.trim();
    setRenaming(false);
    // An unchanged or empty name is a cancel, not a write — the engine would
    // reject the empty one anyway, and a no-op PATCH writes no event but still
    // costs a round trip and a refresh of every surface.
    if (!next || next === session.title) return;
    await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: next.slice(0, 120) }),
    });
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
        <ProviderIcon provider={session.driver} size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-sidebar-foreground">
          {session.title || "Untitled session"}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-sidebar-foreground/45">
          <span className="shrink-0">{fmtAgo(session.updatedAt, renderedAt)}</span>
          {showProject && session.projectName ? (
            <>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate">{session.projectName}</span>
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
      } ${session.archived ? "opacity-60" : ""}`}
    >
      {/* NO HOVER CARD IN THE MOBILE SHEET, AND THAT IS THE WHOLE BUG.
          Under 768px <Sidebar> stops being a docked panel and renders the mobile
          <Sheet> — a MODAL dialog. HoverCardContent portals to <body>, i.e.
          outside that dialog, so the modal treats the card as an outside element
          and dismisses it the instant it appears. A hover affordance in a modal
          sheet at phone width has nothing to offer anyway. */}
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
              PROP; an id on the render element overrides the DOM id while the
              store still holds the generated one, so the open cannot be
              attributed to this trigger and is rescinded the frame it fires. */}
          <HoverCardTrigger
            id={`sidebar-session-${session.id}`}
            render={
              <Link
                href={href}
                // Session routes are force-dynamic and carry the transcript.
                // They are deliberately fetched only when selected.
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
              `anchor={rowRef}` — the TRIGGER is only the <Link>, which stops
              where the action buttons begin, so anchoring to it opened the card
              on top of this row's own controls. `positionMethod="fixed"` — with
              "absolute", a card that overflows the viewport GROWS THE DOCUMENT,
              which moves the anchor, re-evaluates hover, and loops.
              `side: "shift"` keeps the card on the right rather than flipping it
              over the row. */}
          <HoverCardContent
            anchor={rowRef}
            side="right"
            align="start"
            sideOffset={8}
            positionMethod="fixed"
            collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
            // p-0 so the status strip and stat band run edge to edge; sections
            // carry their own padding.
            className="w-64 overflow-hidden p-0 duration-150"
          >
            <SessionDetails session={session} renderedAt={renderedAt} />
          </HoverCardContent>
        </HoverCard>
      )}

      {/* The transition worth one click sits on the row itself; the long tail
          stays in the menu. Hidden until hover so a resting list is just titles,
          but forced visible while any of their popups is open. */}
      {!searchable && (
        <span className="flex shrink-0 items-center gap-0.5 pr-1 opacity-0 transition-opacity group-hover/session:opacity-100 group-focus-within/session:opacity-100 has-data-popup-open:opacity-100">
          {/**
           * SETTLE IS ONE TAP AND ASKS NOTHING, which is the whole difference
           * between it and the archive beside it. Archiving ends the session and
           * removes its worktree, so it earns a confirmation; settling moves a
           * row to the shelf and is undone by pressing the same spot — or by
           * typing at the session, which the engine treats as "not done after
           * all". A reversible action that asks first teaches people to dismiss
           * the question, which is how they end up dismissing the other one.
           */}
          {!session.archived && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={settledByDecision ? "Return to the list" : "Settle session"}
              title={settledByDecision ? "Return to the list" : "Settle"}
              disabled={!settledByDecision && !canSettle({})}
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                void patchSession(session.id, { settledOverride: settledByDecision ? null : "settled" }).then(onRefresh);
              }}
            >
              {settledByDecision ? <UndoIcon /> : <CircleCheckIcon />}
            </Button>
          )}
          {!settled && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Archive session"
              title="Archive"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                // Confirmed, unlike the donor's one-tap Settle: settling was a
                // reversible band change, and archiving here ends the session
                // and removes its worktree. Same gesture, heavier consequence,
                // so it earns the question.
                if (!window.confirm(`Archive "${session.title || "Untitled session"}"? Its worktree is removed; the branch survives.`)) {
                  return;
                }
                void fetch(`/api/sessions/${encodeURIComponent(session.id)}/archive`, { method: "POST" }).then(() => {
                  onRefresh();
                  leaveIfActive();
                });
              }}
            >
              <ArchiveIcon />
            </Button>
          )}
          <SessionInboxMenu
            session={session}
            settled={settled}
            active={active}
            now={renderedAt}
            onRename={beginRename}
            onDone={onRefresh}
            onLeave={leaveIfActive}
          />
        </span>
      )}
    </div>
  );
}
