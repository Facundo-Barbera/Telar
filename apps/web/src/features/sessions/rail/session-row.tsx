"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleCheckIcon } from "lucide-react";
import type { LiveSessionRow } from "@telar/engine-client";
import { fmtAgo, fmtTokens } from "@/ui/format";
import { canvasHref, sessionHref, sessionKey, settledHint, settlingActivity, type SessionBand, type SidebarSession } from "../session-list";
import { ProviderIcon, PROVIDER_LABEL } from "@/features/providers";
import { SessionRowContextMenu, type SessionRowMenuProps } from "./session-inbox-menu";
import { mutateRow, patchSession, withSettling, withTitle, type SessionRowChanged } from "../session-mutations";
import { terminalsClosedHint } from "../session-settling";
import type { RailJumpSlot } from "../session-groups";
import { KeyHintOverlay } from "@/features/commands";
import { useSidebar } from "@/ui/sidebar";
import { cn } from "@/ui/utils";
import { useRowWarmth } from "./use-row-warmth";
import { HostMark, RowMarks, RowStatus } from "./session-row-marks";
import { CardBody, RowLink, SlimBody } from "./session-row-body";
import { RowActions } from "./session-row-actions";

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

type RowDrag = {
  dragging: boolean;
  insert: "above" | "below" | null;
  onDragStart: (event: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: React.DragEvent) => void;
};

function RenameInput({ title, onCommit, onCancel }: { title: string; onCommit: (draft: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.select();
  }, []);
  return (
    <div className="rounded-md bg-sidebar-accent px-2 py-1.5">
      <input
        ref={input}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => onCommit(draft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onCommit(draft);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        aria-label="Rename session"
        className="w-full bg-transparent text-xs font-medium text-sidebar-foreground outline-none"
      />
    </div>
  );
}

function DragFrame({ drag, children }: { drag: RowDrag; children: React.ReactNode }) {
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
      {children}
    </div>
  );
}

function rowTitle(session: SidebarSession, renderedAt: number, unsettles: boolean): string | undefined {
  return (
    [
      session.stale === undefined ? undefined : `Last read ${fmtAgo(session.stale, renderedAt)}`,
      settledHint(session),
      unsettles ? terminalsClosedHint(session) : undefined,
    ]
      .filter(Boolean)
      .join(" · ") || undefined
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
  drag?: RowDrag;
}) {
  const { isMobile } = useSidebar();
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const { rowRef, warm, beginIntent, restIntent } = useRowWarmth({
    rowKey: sessionKey(session),
    active,
    warmable: Boolean(session.projectId),
    hostId: session.hostId,
    sessionId: session.id,
  });

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

  const commitRename = (draft: string) => {
    const next = draft.trim();
    setRenaming(false);
    if (!next || next === session.title) return;
    const title = next.slice(0, 120);
    mutate(withTitle(session, title), () => patchSession(session, { title }));
  };

  if (renaming) return <RenameInput title={session.title} onCommit={commitRename} onCancel={() => setRenaming(false)} />;

  const statusSlot = <RowStatus session={session} band={band} renderedAt={renderedAt} />;
  const trailingSlot = jumpSlot ? <KeyHintOverlay command={`jump-${jumpSlot}`}>{statusSlot}</KeyHintOverlay> : statusSlot;
  const heldTerminals = unsettles && !session.archived ? (session.terminals ?? 0) : 0;
  const marks = <RowMarks session={session} band={band} renderedAt={renderedAt} heldTerminals={heldTerminals} />;
  const rowBody =
    variant === "card" ? (
      <CardBody session={session} showProject={showProject} marks={marks} hostMark={<HostMark hostName={session.hostName} />} trailing={trailingSlot} />
    ) : (
      <SlimBody session={session} recedes={band === "settled" || band === "snoozed"} marks={marks} trailing={trailingSlot} />
    );

  const menuProps: SessionRowMenuProps = {
    session,
    active,
    activity: sessionActivity,
    now: renderedAt,
    settled: unsettles,
    onRename: () => setRenaming(true),
    onRowChanged,
    onLeave: () => {
      if (active && session.projectId) router.push(canvasHref(session.projectId, session.hostId));
    },
  };

  const row = (
    <div
      ref={rowRef}
      onPointerEnter={beginIntent}
      onPointerLeave={restIntent}
      onFocus={beginIntent}
      title={rowTitle(session, renderedAt, unsettles)}
      className={`group/session relative flex items-center rounded-md ${
        active || searchSelected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/70"
      } ${session.archived || session.stale !== undefined ? "opacity-60" : ""}`}
    >
      <RowLink
        id={`sidebar-session-${session.id}`}
        href={sessionHref(session)}
        warm={warm}
        searchable={searchable}
        searchSelected={searchSelected}
        active={active}
        slim={variant !== "card"}
        plain={isMobile || !hasFigures(session)}
        details={<SessionDetails session={session} renderedAt={renderedAt} />}
        anchor={rowRef}
        onRename={() => setRenaming(true)}
      >
        {rowBody}
      </RowLink>
      {!searchable && (
        <RowActions
          menuProps={menuProps}
          session={session}
          activity={sessionActivity}
          renderedAt={renderedAt}
          onRowChanged={onRowChanged}
          band={band}
          slim={variant !== "card"}
          unsettles={unsettles}
          heldTerminals={heldTerminals}
          mutate={mutate}
          unsettle={unsettle}
        />
      )}
    </div>
  );

  const menu = <SessionRowContextMenu {...menuProps}>{row}</SessionRowContextMenu>;
  return drag ? <DragFrame drag={drag}>{menu}</DragFrame> : menu;
}
