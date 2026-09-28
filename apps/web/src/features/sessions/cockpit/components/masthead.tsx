"use client";

import { OpenWorkspaceButton } from "@/features/files";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, FolderGit2Icon, TriangleAlertIcon } from "lucide-react";
import { type Session, workspacePath } from "@telar/engine-client";
import { refusedBy, type EngineApiError } from "@/platform/engine";
import { projectLabel } from "@/features/hosts";
import { RunHeaderControl, type RunView } from "@/features/terminal";
import { hostName } from "@/lib/hosts/client";
import { cn } from "@/lib/utils";
import { WorkspaceInspector } from "@/components/session/workspace-inspector";
import { MainSidebarTrigger, useMainIsLeftmost } from "@/components/ui/main-sidebar-trigger";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { dropdownSessionMenuParts, SessionActionContextMenu, SessionActionMenuItems } from "../../components/session-action-menu";
import { buildSessionActionMenuItems, type SessionActionHandlers, type SessionActionMenuState } from "../../session-action-menu";
import { canvasHref } from "../../session-list";

const TITLE_MENU_CLICK_DELAY_MS = 250;

export function SessionProblem({ error }: { error: EngineApiError }) {
  const unavailable = error.code === "engine_unavailable" || error.code === "engine_locked";
  const host = refusedBy(error);
  return (
    <Alert variant="destructive" className="mx-auto max-w-[50rem]">
      <TriangleAlertIcon />
      <AlertTitle>
        {unavailable ? (host ? `${host} is unavailable` : "Engine unavailable") : host ? `${host} refused the request` : "Request failed"}
      </AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}

export function usePanelPresence(open: boolean, durationMs = 200): { mounted: boolean; shown: boolean } {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    // All state updates are deferred into a frame/timeout, never synchronous in
    // the effect body (which would cascade renders — the lint rule this obeys).
    if (open) {
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        setMounted(true);
        // A second frame so the width starts at 0 and transitions to full.
        inner = requestAnimationFrame(() => setShown(true));
      });
      // both frames are cancelled: the inner one, left running, would flip
      // `shown` true again and reopen a panel that is closing.
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    const frame = requestAnimationFrame(() => setShown(false));
    const timer = window.setTimeout(() => setMounted(false), durationMs);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [open, durationMs]);
  return { mounted, shown };
}

export function SessionMasthead({
  projectId,
  hostId,
  projectName,
  projectResolved,
  session,
  onRename,
  panel,
  onWatchRun,
  onRunTerminals,
  menu,
}: {
  projectId?: string;
  /** Which Mac the project is on — the breadcrumb's link must stay there. */
  hostId: string;
  projectName?: string;
  /** Whether this host's registry has answered at all. */
  projectResolved?: boolean;
  session?: Session;
  onRename: (title: string) => void;
  /** The session panel's triggers. Passed in rather than constructed here so the
   *  masthead stays identity-only and does not acquire the session record's
   *  items, tasks, turns and events just to hand them straight through. */
  panel: React.ReactNode;
  /** Opens the right panel's Run tab. Monitoring lives there; the masthead's
   *  Run control only configures, starts and stops. */
  onWatchRun?: () => void;
  /** The Run control's feed, handed on so a terminal that opens gets its tab
   *  and chip in the panel — see `revealNewTerminals` in the cockpit. */
  onRunTerminals?: (terminals: readonly RunView[]) => void;
  menu?: Omit<SessionActionMenuState, "actions"> & {
    actions: Omit<SessionActionHandlers, "rename">;
    onOpen?: () => void;
  };
}) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const title = session?.title ?? "New conversation";
  // Whether this header is the window's left edge — see main-sidebar-trigger.
  const mainIsLeftmost = useMainIsLeftmost();

  const commit = () => {
    setEditing(false);
    const next = draftTitle.trim();
    // Empty or unchanged is a silent cancel, not an error and not a write.
    if (next && next !== title) onRename(next.slice(0, 120));
  };

  const beginRename = () => {
    setDraftTitle(title);
    setEditing(true);
  };

  const [menuOpen, setMenuOpen] = useState(false);
  const menuItems = menu ? buildSessionActionMenuItems({ ...menu, actions: { ...menu.actions, rename: beginRename } }) : undefined;
  const openMenu = (open: boolean) => {
    setMenuOpen(open);
    if (open) menu?.onOpen?.();
  };

  return (
    <header
      className={cn(
        "app-ground app-drag flex min-h-[var(--titlebar-height)] shrink-0 items-center gap-2 bg-background/65 py-1.5 pr-4 backdrop-blur md:h-[var(--titlebar-band-height)] md:min-h-[var(--titlebar-band-height)] md:py-0",
        // The content island sits --app-island-inset in from the window edge
        // (app-shell.tsx), so the traffic-light inset is measured from the
        // island.
        mainIsLeftmost ? "pl-[max(16px,calc(var(--titlebar-inset)+var(--app-island-inset)))]" : "pl-4",
      )}
    >
      <SessionActionContextMenu items={menuItems} {...(menu?.onOpen ? { onOpen: menu.onOpen } : {})}>
        <div className="mr-1 flex min-w-0 flex-1 items-center gap-2 text-sm">
          {/* Only mounts while the rail is hidden, leaving the workspace at true
              full width when it is not. The folder glyph stands in for it so the
              breadcrumb does not shift sideways when the rail opens. */}
          <MainSidebarTrigger className="-mx-[7px]" fallback={<FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />} />
          {projectId === undefined ? (
            <span className="shrink-0 truncate text-muted-foreground">Main</span>
          ) : (
            <Link
              href={canvasHref(projectId, hostId)}
              className="app-no-drag shrink-0 truncate text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {projectLabel({ name: projectName, hostName: hostName(hostId), resolved: projectResolved === true })}
            </Link>
          )}
          <span className="text-border">/</span>
          {editing ? (
            <TitleEditor value={draftTitle} onChange={setDraftTitle} onCommit={commit} onCancel={() => setEditing(false)} />
          ) : (
            <TitleMenu title={title} items={menuItems} open={menuOpen} onOpenChange={openMenu} onRename={beginRename} />
          )}
        </div>
      </SessionActionContextMenu>
      <MastheadTools hostId={hostId} panel={panel} {...(session ? { session } : {})} {...(onWatchRun ? { onWatchRun } : {})} {...(onRunTerminals ? { onRunTerminals } : {})} />
    </header>
  );
}

function TitleEditor({ value, onChange, onCommit, onCancel }: { value: string; onChange: (value: string) => void; onCommit: () => void; onCancel: () => void }) {
  return (
    <Input
      className="app-no-drag h-6 max-w-xs text-base font-semibold"
      aria-label="Session title"
      autoFocus
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onCommit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

// Click opens the menu after the double-click window so a double-click can rename instead;
// keyboard activation (`detail === 0`) and the chevron open at once.
function TitleMenu({
  title,
  items,
  open,
  onOpenChange,
  onRename,
}: {
  title: string;
  items: ReturnType<typeof buildSessionActionMenuItems> | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: () => void;
}) {
  const pendingOpen = useRef(0);
  const cancelPendingOpen = () => window.clearTimeout(pendingOpen.current);
  useEffect(() => cancelPendingOpen, []);
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <span className="group/title inline-flex min-w-0 items-center gap-1 font-semibold">
        {items ? (
          <button
            type="button"
            className="app-no-drag min-w-0 truncate rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={title}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={(event) => {
              cancelPendingOpen();
              if (open) return;
              if (event.detail === 0) {
                onOpenChange(true);
                return;
              }
              pendingOpen.current = window.setTimeout(() => onOpenChange(true), TITLE_MENU_CLICK_DELAY_MS);
            }}
            onDoubleClick={() => {
              cancelPendingOpen();
              onRename();
            }}
          >
            {title}
          </button>
        ) : (
          // A fresh canvas: "New conversation" is a statement about what
          // you are looking at, and there is nothing yet to act on.
          <span className="truncate" title={title}>
            {title}
          </span>
        )}
        {items && (
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Session actions"
                className="app-no-drag shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/title:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
                onClick={cancelPendingOpen}
              />
            }
          >
            <ChevronDownIcon />
          </DropdownMenuTrigger>
        )}
      </span>
      {items && (
        <DropdownMenuContent align="start" className="min-w-56">
          <SessionActionMenuItems items={items} parts={dropdownSessionMenuParts} />
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}

function MastheadTools({
  hostId,
  session,
  panel,
  onWatchRun,
  onRunTerminals,
}: {
  hostId: string;
  session?: Session;
  panel: React.ReactNode;
  onWatchRun?: () => void;
  onRunTerminals?: (terminals: readonly RunView[]) => void;
}) {
  return (
    <div className="app-no-drag ml-auto flex shrink-0 items-center gap-2">
      {session && workspacePath(session.workspace) !== undefined && (
        <RunHeaderControl
          key={`${hostId}:${session.id}`}
          sessionId={session.id}
          hostId={hostId}
          {...(onWatchRun ? { onWatchOutput: onWatchRun } : {})}
          {...(onRunTerminals ? { onTerminals: onRunTerminals } : {})}
        />
      )}
      {session && workspacePath(session.workspace) !== undefined && (
        <OpenWorkspaceButton path={workspacePath(session.workspace)} hostId={hostId} />
      )}
      {panel}
    </div>
  );
}

export function SoloTools({
  projectId,
  hostId,
  session,
}: {
  /** The route's project. `session.projectId` wins once the record lands — same
   *  precedence the masthead's own inspector used. */
  projectId?: string;
  hostId: string;
  session?: Session;
}) {
  const notesProjectId = session?.projectId ?? projectId;
  /** A run is a process in a directory, so a conversation with neither offers
   *  none — the same rule the masthead stated, kept rather than restated. */
  const runnable = session !== undefined && workspacePath(session.workspace) !== undefined;
  // Nothing to carry: no empty box, no stray inset over the first turn.
  if (notesProjectId === undefined && !runnable) return null;
  return (
    <div className="relative z-20 h-0 shrink-0">
      {/* `app-no-drag` for the same reason the masthead's cluster had it: these
          are controls, and on the desktop shell the region they sit in is the
          window's own titlebar band. */}
      <div className="app-no-drag absolute right-3 top-3 flex items-center gap-2">
        {runnable && <RunHeaderControl key={`${hostId}:${session.id}`} sessionId={session.id} hostId={hostId} />}
        {notesProjectId !== undefined && <WorkspaceInspector projectId={notesProjectId} />}
      </div>
    </div>
  );
}
