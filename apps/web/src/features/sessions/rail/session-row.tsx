"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlarmClockIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleStopIcon,
  HardDriveIcon,
  ClockIcon,
  GitBranchIcon,
  MonitorIcon,
  PinIcon,
  SquareTerminalIcon,
  UndoIcon,
} from "lucide-react";
import type { LiveSessionRow } from "@telar/engine-client";
import { ProjectAvatar } from "@/features/projects";
import { fmtAgo, fmtTokens } from "@/lib/format";
import { ACTIVITY_TONE, fmtDuration, rowStatusText, rowSubtitle } from "@/lib/session-activity";
import { canvasHref, sessionHref, sessionKey, settledHint, settlingActivity, type SessionBand, type SidebarSession } from "@/lib/session-list";
import { claimPrefetch, PREFETCH_INTENT_MS, PREFETCH_MARGIN, releasePrefetch, warmConversation } from "@/lib/rail-prefetch";
import { ProviderIcon, PROVIDER_LABEL } from "@/components/session/provider-icon";
import { SessionInboxMenu, SessionRowContextMenu, type SessionRowMenuProps } from "@/components/session/session-inbox-menu";
import { closeRowTerminals, mutateRow, patchSession, withSettling, withSnooze, withTitle, type SessionRowChanged } from "@/lib/session-mutations";
import { canSettle, canSnooze, settleClosesText, settledTerminalsHint, snoozePresets, terminalsClosedHint, wakeLabel } from "@/lib/session-settling";
import type { RailJumpSlot } from "@/lib/session-groups";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { KeyHintOverlay } from "@/features/commands";
import { useSidebar } from "@/components/ui/sidebar";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";

function TickingDuration({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 5_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <span className="tabular-nums">{fmtDuration(startedAt, now)}</span>;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-2xs text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-2xs tabular-nums">{value}</span>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 bg-popover py-2">
      <span className="text-xs font-semibold tabular-nums">{value}</span>
      <span className="text-4xs uppercase tracking-wider text-muted-foreground">{label}</span>
    </div>
  );
}

export function hasFigures(session: SidebarSession): boolean {
  return session.contextTokens !== undefined || session.tokens !== undefined;
}

export function SessionDetails({ session, renderedAt }: { session: SidebarSession; renderedAt: number }) {
  const tiles = [
    ...(session.contextTokens === undefined ? [] : [{ label: "Context", value: fmtTokens(session.contextTokens) }]),
    ...(session.tokens === undefined ? [] : [{ label: "Tokens", value: fmtTokens(session.tokens) }]),
    { label: "Workspace", value: session.worktreeBranch ? "Worktree" : "Local" },
  ];
  return (
    <div>
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
          <span className="mt-0.5 flex items-center gap-1 text-3xs">
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
      <div
        className={`mt-2.5 grid gap-px border-y border-border/60 bg-border/60 ${tiles.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}
      >
        {tiles.map((tile) => (
          <StatTile key={tile.label} label={tile.label} value={tile.value} />
        ))}
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
        {session.settledBy ? (
          <DetailRow label="Settled" value={session.settledForTitle ? `for ${session.settledForTitle}` : "work delivered"} />
        ) : null}
      </div>
    </div>
  );
}

export function SessionRow({
  session,
  active,
  showProject,
  variant = "card",
  band = "active",
  searchable = false,
  searchSelected = false,
  renderedAt,
  onRowChanged,
  drag,
  jumpSlot,
}: {
  session: SidebarSession;
  active: boolean;
  showProject: boolean;
  jumpSlot?: RailJumpSlot;
  variant?: "card" | "slim";
  band?: SessionBand;
  searchable?: boolean;
  searchSelected?: boolean;
  renderedAt: number;
  onRowChanged: SessionRowChanged;
  drag?: {
    dragging: boolean;
    insert: "above" | "below" | null;
    onDragStart: (event: React.DragEvent) => void;
    onDragEnd: () => void;
    onDragOver: (event: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (event: React.DragEvent) => void;
  };
}) {
  const { isMobile } = useSidebar();
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const input = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);

  const href = sessionHref(session);
  const warmable = Boolean(session.projectId);
  const rowKey = sessionKey(session);
  const [warm, setWarm] = useState(false);
  const intent = useRef<number | undefined>(undefined);
  const restIntent = () => {
    if (intent.current === undefined) return;
    window.clearTimeout(intent.current);
    intent.current = undefined;
  };
  const beginIntent = () => {
    if (!warmable || warm || intent.current !== undefined) return;
    intent.current = window.setTimeout(() => {
      intent.current = undefined;
      if (claimPrefetch(rowKey, { active, intent: true })) setWarm(true);
    }, PREFETCH_INTENT_MS);
  };
  useEffect(() => restIntent, []);

  useEffect(() => {
    const node = rowRef.current;
    if (!warmable || !node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setWarm((current) => current || claimPrefetch(rowKey, { active }));
          else {
            releasePrefetch(rowKey);
            setWarm(false);
          }
        }
      },
      { rootMargin: PREFETCH_MARGIN },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      releasePrefetch(rowKey);
    };
  }, [rowKey, active, warmable]);

  useEffect(() => {
    if (!warm || active) return;
    warmConversation(session.hostId, session.id);
  }, [warm, active, session.hostId, session.id]);
  const snoozing = band === "snoozed";
  const sessionActivity = settlingActivity(session);
  const settledByDecision = session.settledOverride === "settled";
  const unsettles = settledByDecision || band === "settled";
  const mutate = (after: SidebarSession, send: () => Promise<LiveSessionRow>) =>
    void mutateRow({ before: session, after: { row: after }, send, onRowChanged });
  const unsettle = () =>
    mutate(withSettling(session, null), async () => {
      if (!settledByDecision) await patchSession(session, { settledOverride: "active" });
      return patchSession(session, { settledOverride: null });
    });

  const leaveIfActive = () => {
    if (active && session.projectId) router.push(canvasHref(session.projectId, session.hostId));
  };

  const beginRename = () => {
    setDraft(session.title);
    setRenaming(true);
  };

  const commitRename = () => {
    const next = draft.trim();
    setRenaming(false);
    if (!next || next === session.title) return;
    const title = next.slice(0, 120);
    mutate(withTitle(session, title), () => patchSession(session, { title }));
  };

  if (renaming) {
    return (
      <div className="rounded-md bg-sidebar-accent px-2 py-1.5">
        <input
          ref={input}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitRename();
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

  const { badge, time } = rowStatusText(session, renderedAt);
  const subtitle = rowSubtitle(session, { projectShown: showProject });

  const yieldOnHover = "transition-opacity group-hover/session:opacity-0 group-focus-within/session:opacity-0";
  const driveSlot =
    session.projectAvailability === "unmounted" || session.projectAvailability === "missing" ? (
      <span
        className={`inline-flex min-w-0 shrink items-center gap-1 text-2xs font-medium text-muted-foreground ${yieldOnHover}`}
        title={
          session.projectAvailability === "unmounted"
            ? `The drive holding ${session.projectName ?? "this project"} is not connected. Its work is still on it.`
            : `${session.workspacePath ?? "This session's folder"} is not on this machine any more.`
        }
      >
        <HardDriveIcon className="size-3 shrink-0" />
        <span role="status" className="truncate">
          {session.projectAvailability === "unmounted" ? "Drive away" : "Folder gone"}
        </span>
      </span>
    ) : undefined;

  const statusSlot = driveSlot ?? (session.preparation ? (
    <span
      className={`inline-flex min-w-0 shrink items-center gap-1 text-2xs font-medium ${
        session.preparation.state === "failed" ? "text-warning" : "text-muted-foreground"
      } ${yieldOnHover}`}
      title={session.preparation.error}
    >
      {session.preparation.state === "preparing" ? (
        <>
          <CircleDashedIcon className="size-3 animate-spin [animation-duration:3s]" />
          <span role="status">Preparing</span>
        </>
      ) : (
        <>
          <CircleDotIcon className="size-3 shrink-0" />
          <span role="status" className="truncate">
            {session.preparation.error?.split("\n")[0]?.trim() || "Worktree setup failed"}
          </span>
        </>
      )}
    </span>
  ) : session.draft ? (
    <span className={`shrink-0 text-2xs text-sidebar-foreground/45 ${yieldOnHover}`}>Draft</span>
  ) : snoozing && session.snoozedUntil !== undefined ? (
    <span className={`inline-flex shrink-0 items-center gap-1 text-2xs tabular-nums text-sidebar-foreground/45 ${yieldOnHover}`}>
      <AlarmClockIcon className="size-3" />
      {wakeLabel(session.snoozedUntil, renderedAt)}
    </span>
  ) : badge ? (
    <span className={`inline-flex shrink-0 items-center gap-1 text-2xs font-medium ${ACTIVITY_TONE[badge.tone]} ${yieldOnHover}`}>
      {badge.ticking ? (
        <CircleDashedIcon className="size-3 animate-spin [animation-duration:3s]" />
      ) : badge.tone === "attention" ? (
        <CircleDotIcon className="size-3" />
      ) : null}
      <span role="status" title={badge.hint}>{badge.label}</span>
      {badge.ticking && session.activityAt !== undefined ? <TickingDuration startedAt={session.activityAt} /> : null}
    </span>
  ) : (
    <span className={`shrink-0 text-2xs tabular-nums text-sidebar-foreground/45 ${yieldOnHover}`}>{time}</span>
  ));

  const trailingSlot = jumpSlot ? <KeyHintOverlay command={`jump-${jumpSlot}`}>{statusSlot}</KeyHintOverlay> : statusSlot;

  const pinMark =
    band === "pinned" ? (
      <span role="img" aria-label="Pinned" title="Pinned" className="shrink-0 text-sidebar-foreground/45">
        <PinIcon className="size-3" />
      </span>
    ) : null;

  const wakeMark =
    session.wokeAt !== undefined && Number.isFinite(session.wokeAt) ? (
      <span
        role="img"
        aria-label="Woke up"
        title={`Woke ${fmtAgo(session.wokeAt, renderedAt)}`}
        className="size-1.5 shrink-0 rounded-full bg-primary"
      />
    ) : null;

  const heldTerminals = unsettles && !session.archived ? (session.terminals ?? 0) : 0;
  const terminalMark =
    heldTerminals > 0 ? (
      <span
        role="img"
        aria-label={settledTerminalsHint(heldTerminals)}
        title={settledTerminalsHint(heldTerminals)}
        className="inline-flex shrink-0 items-center gap-0.5 text-2xs tabular-nums text-sidebar-foreground/60"
      >
        <SquareTerminalIcon className="size-3" />
        {heldTerminals}
      </span>
    ) : null;
  const settleCloses = settleClosesText(session.terminals);

  const hostMark = session.hostName ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-sidebar-accent px-1 text-3xs leading-4 text-sidebar-foreground/60" title={`On ${session.hostName}`}>
      <MonitorIcon className="size-2.5" />
      <span className="max-w-24 truncate">{session.hostName}</span>
    </span>
  ) : null;

  const cardBody = (
    <span className="min-w-0 flex-1 space-y-1">
      <span className="flex min-w-0 items-center gap-1.5">
        {wakeMark}
        {pinMark}
        {terminalMark}
        {showProject && session.projectName ? (
          <>
            <ProjectAvatar
              name={session.projectName}
              {...(session.projectId ? { projectId: session.projectId } : {})}
              {...(session.projectIcon ? { icon: session.projectIcon } : {})}
              {...(session.projectIconName ? { iconName: session.projectIconName } : {})}
              size={12}
            />
            <span className="min-w-0 flex-1 truncate text-2xs text-sidebar-foreground/50">{session.projectName}</span>
          </>
        ) : (
          <span className="flex-1" />
        )}
        {hostMark}
        {trailingSlot}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-snug text-sidebar-foreground">
          {session.title || "Untitled session"}
        </span>
        {!subtitle && (
          <span className="shrink-0 opacity-50">
            <ProviderIcon provider={session.driver} size={11} />
          </span>
        )}
      </span>
      {subtitle && (
        <span className="flex min-w-0 items-center gap-1.5 text-2xs text-sidebar-foreground/45">
          {subtitle.kind === "branch" ? <GitBranchIcon className="size-3 shrink-0" /> : null}
          <span className="min-w-0 flex-1 truncate">{subtitle.text}</span>
          <span className="shrink-0 opacity-60">
            <ProviderIcon provider={session.driver} size={11} />
          </span>
        </span>
      )}
    </span>
  );

  const recedes = band === "settled" || band === "snoozed";
  const slimBody = (
    <>
      {wakeMark}
      {pinMark}
      {terminalMark}
      <span className={cn("shrink-0", recedes && "opacity-50 grayscale transition group-hover/session:opacity-100 group-hover/session:grayscale-0")}>
        {session.projectName ? (
          <ProjectAvatar
            name={session.projectName}
            {...(session.projectId ? { projectId: session.projectId } : {})}
            {...(session.projectIcon ? { icon: session.projectIcon } : {})}
            {...(session.projectIconName ? { iconName: session.projectIconName } : {})}
            size={14}
          />
        ) : (
          <ProviderIcon provider={session.driver} size={13} />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-left text-xs-plus text-sidebar-foreground",
          recedes && "text-sidebar-foreground/70 group-hover/session:text-sidebar-foreground",
        )}
      >
        {session.title || "Untitled session"}
      </span>
      {trailingSlot}
    </>
  );

  const rowBody = variant === "card" ? cardBody : slimBody;

  const plain = isMobile || !hasFigures(session);

  const linkClass = `flex min-w-0 flex-1 items-center gap-2 px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${
    variant === "card" ? "py-2.5" : "py-1.5"
  }`;

  const menuProps: SessionRowMenuProps = {
    session,
    active,
    activity: sessionActivity,
    now: renderedAt,
    settled: unsettles,
    onRename: beginRename,
    onRowChanged,
    onLeave: leaveIfActive,
  };

  const row = (
    <div
      ref={rowRef}
      onPointerEnter={beginIntent}
      onPointerLeave={restIntent}
      onFocus={beginIntent}
      title={
        [
          session.stale === undefined ? undefined : `Last read ${fmtAgo(session.stale, renderedAt)}`,
          settledHint(session),
          unsettles ? terminalsClosedHint(session) : undefined,
        ]
          .filter(Boolean)
          .join(" · ") || undefined
      }
      className={`group/session relative flex items-center rounded-md ${
        active || searchSelected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/70"
      } ${session.archived || session.stale !== undefined ? "opacity-60" : ""}`}
    >
      {plain ? (
        <Link
          id={`sidebar-session-${session.id}`}
          href={href}
          prefetch={warm ? null : false}
          draggable={false}
          role={searchable ? "option" : undefined}
          aria-selected={searchable ? searchSelected : undefined}
          aria-current={active ? "page" : undefined}
          onDoubleClick={(event: React.MouseEvent) => {
            event.preventDefault();
            beginRename();
          }}
          className={linkClass}
        >
          {rowBody}
        </Link>
      ) : (
        <HoverCard>
          <HoverCardTrigger
            id={`sidebar-session-${session.id}`}
            render={
              <Link
                href={href}
                prefetch={warm ? null : false}
                draggable={false}
                role={searchable ? "option" : undefined}
                aria-selected={searchable ? searchSelected : undefined}
                aria-current={active ? "page" : undefined}
                onDoubleClick={(event: React.MouseEvent) => {
                  event.preventDefault();
                  beginRename();
                }}
                className={linkClass}
              />
            }
          >
            {rowBody}
          </HoverCardTrigger>
          <HoverCardContent
            anchor={rowRef}
            side="right"
            align="start"
            sideOffset={8}
            positionMethod="fixed"
            collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
            className="w-64 overflow-hidden p-0 duration-150"
          >
            <SessionDetails session={session} renderedAt={renderedAt} />
          </HoverCardContent>
        </HoverCard>
      )}

      {!searchable && (
        <span
          className={`absolute right-1 z-10 flex items-center gap-0.5 rounded-md bg-sidebar-accent opacity-0 shadow-1 transition-opacity group-hover/session:opacity-100 group-focus-within/session:opacity-100 has-data-popup-open:opacity-100 ${
            variant === "card" ? "top-1.5" : "top-1/2 -translate-y-1/2"
          }`}
        >
          {!session.archived && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={unsettles ? "Return to the list" : "Settle session"}
              title={unsettles ? "Return to the list" : settleCloses ? `Settle — ${settleCloses}` : "Settle"}
              disabled={!unsettles && !canSettle(sessionActivity)}
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                if (unsettles) unsettle();
                else mutate(withSettling(session, "settled"), () => patchSession(session, { settledOverride: "settled" }));
              }}
            >
              {unsettles ? <UndoIcon /> : <CircleCheckIcon />}
            </Button>
          )}
          {heldTerminals > 0 && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={heldTerminals === 1 ? "Close its terminal" : `Close its ${heldTerminals} terminals`}
              title={heldTerminals === 1 ? "Close its terminal" : `Close its ${heldTerminals} terminals`}
              className="text-muted-foreground hover:text-foreground"
              onClick={() => void closeRowTerminals({ row: session, onRowChanged })}
            >
              <CircleStopIcon />
            </Button>
          )}
          {snoozing ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Wake session now"
              title="Wake now"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => mutate(withSnooze(session, null), () => patchSession(session, { snoozedUntil: null }))}
            >
              <AlarmClockIcon />
            </Button>
          ) : (
            band !== "settled" && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Snooze session"
                      title="Snooze"
                      disabled={!canSnooze(sessionActivity)}
                      className="text-muted-foreground hover:text-foreground"
                    />
                  }
                >
                  <ClockIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  {snoozePresets(new Date(renderedAt)).map((preset) => (
                    <DropdownMenuItem
                      key={preset.id}
                      onClick={() =>
                        mutate(withSnooze(session, preset.until), () => patchSession(session, { snoozedUntil: preset.until }))
                      }
                    >
                      <span className="flex-1">{preset.label}</span>
                      <span className="font-mono text-3xs tabular-nums text-muted-foreground/60">{preset.when}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )
          )}
          <SessionInboxMenu {...menuProps} />
        </span>
      )}
    </div>
  );

  const menu = <SessionRowContextMenu {...menuProps}>{row}</SessionRowContextMenu>;
  if (!drag) return menu;

  return (
    <div
      draggable
      onDragStart={drag.onDragStart}
      onDragEnd={drag.onDragEnd}
      onDragOver={drag.onDragOver}
      onDragLeave={drag.onDragLeave}
      onDrop={drag.onDrop}
      title="Drag to move this conversation"
      className={cn(
        "cursor-grab rounded-md transition-opacity active:cursor-grabbing",
        drag.dragging && "opacity-40",
        drag.insert === "above" && "shadow-[inset_0_2px_0_0_var(--color-sidebar-primary)]",
        drag.insert === "below" && "shadow-[inset_0_-2px_0_0_var(--color-sidebar-primary)]",
      )}
    >
      {menu}
    </div>
  );
}
