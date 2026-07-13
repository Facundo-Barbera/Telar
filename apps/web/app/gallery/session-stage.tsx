"use client";

import { useEffect } from "react";
import { WorkflowIcon } from "lucide-react";
import type { GalleryAppEntry } from "@/lib/gallery-fixtures";
import { setActiveScene } from "@/lib/gallery-fixtures";
import { Badge } from "@/components/ui/badge";
import { SessionView } from "@/components/session/session-view";
import { SessionsRail } from "@/components/session/sessions-rail";

// Mirrored-wiring stage for the three session-family routes. Those routes are
// SERVER components whose UI is 100% real client components (SessionsRail +
// SessionView); only their @telar/core / lib/store reads need replacing. This
// stage mirrors that wiring EXACTLY, feeding the entry's GallerySessionSeed into
// the real components — no fork.
//
// Mirrors:
//   session-plain / session-empty
//     app/projects/[name]/sessions/[id]/page.tsx:124-151
//     (the initialChat mapping at :76-92 is pre-baked into seed.initialChat by
//      lane F's fixture; the shell — SessionsRail left, SessionView right — is
//      reproduced verbatim here, including the key=`${project}:${id}`).
//   session-planner
//     app/looms/plan/[project]/page.tsx:83-110
//     (the "Loom Session" banner at :89-99 + the planner/initialRole props).
//
// /api/chat* stays benign-stubbed by the interceptor — the chat runtime is out
// of fixture scope (documented limitation, not a fork).
export function SessionStage({ entry }: { entry: GalleryAppEntry }) {
  // Publish the scene at render (never cleared on unmount) so the real
  // SessionView's fetches (/api/chat is benign-stubbed; /api/usage etc. resolve
  // from the scene) see it before mounting. See AppViewStage for the rationale.
  setActiveScene(entry.scene);
  useEffect(() => {
    setActiveScene(entry.scene);
  }, [entry.scene]);

  const seed = entry.session;
  if (!seed) return null;

  // The planner surface (looms/plan/[project]) — banner + full-width SessionView,
  // no rail. Mirrors plan/[project]/page.tsx:83-110.
  if (entry.view === "session-planner") {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 border-b bg-primary/5 px-4 py-1.5 text-xs">
          <WorkflowIcon className="size-3.5 text-primary" />
          <span className="font-medium text-primary">Loom Session</span>
          <span className="text-muted-foreground">— preparing a loom for</span>
          <Badge
            variant="outline"
            className="border-primary/30 bg-primary/5 font-mono text-[10px] text-primary"
          >
            {seed.project}
          </Badge>
        </div>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <SessionView
            key={seed.project}
            project={seed.project}
            account={seed.account}
            accounts={seed.accounts}
            initialTitle={seed.initialTitle}
            initialRole="planner"
            planner
          />
        </div>
      </div>
    );
  }

  // The plain / empty project session — rail left, chat pane right. Mirrors
  // sessions/[id]/page.tsx:124-151. session-empty simply carries no initialChat.
  return (
    <div className="flex h-full overflow-hidden">
      <SessionsRail
        project={seed.project}
        sessions={seed.sessions}
        activeId={seed.activeId}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <SessionView
          key={`${seed.project}:${seed.activeId}`}
          project={seed.project}
          account={seed.account}
          accounts={seed.accounts}
          initialChat={seed.initialChat}
          initialTitle={seed.initialTitle}
          routeSessionId={seed.activeId === "new" ? undefined : seed.activeId}
        />
      </div>
    </div>
  );
}
