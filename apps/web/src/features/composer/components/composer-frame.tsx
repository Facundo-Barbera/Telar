"use client";

import type { ReactNode } from "react";
import type { ProjectAvailability } from "@telar/engine-client";
import { FreshGreeting } from "./fresh-greeting";
import { ResumePicker } from "./resume-picker";
import { WorkspaceEnvironment } from "@/features/worktrees";
import { cn } from "@/ui/utils";
import { ComposerNote } from "./composer-chrome";
import { BackgroundPresence } from "./context-pill";
import type { ComposerProps } from "./composer-props";

/** Above the card: the fresh canvas's greeting and `/resume` picker, background work, and a stash note. */
export function ComposerHead({
  props,
  resuming,
  onResuming,
  note,
  onDismissNote,
}: {
  props: ComposerProps;
  resuming: boolean;
  onResuming: (open: boolean) => void;
  note: string | undefined;
  onDismissNote: () => void;
}) {
  const { fresh, projectId, projectName, onAdopt, session } = props;
  return (
    <>
      {fresh && projectId && <FreshGreeting projectId={projectId} {...(projectName ? { projectName } : {})} />}
      {fresh && onAdopt && (
        <ResumePicker
          open={resuming}
          onOpenChange={onResuming}
          onPick={onAdopt}
          {...(session?.providerInstanceId ? { instanceId: session.providerInstanceId } : {})}
        />
      )}
      <BackgroundPresence count={props.backgroundTasks} onStop={props.onStopBackground} {...(props.onViewBackground ? { onView: props.onViewBackground } : {})} />
      {note && <ComposerNote note={note} onDismiss={onDismissNote} />}
    </>
  );
}

/** Below the card: the pills' tray while compact, and where the message lands. A project-less chat has no foot. */
export function ComposerFoot({
  props,
  compact,
  pills,
  onAvailability,
}: {
  props: ComposerProps;
  compact: boolean;
  pills: ReactNode;
  onAvailability: (availability: Exclude<ProjectAvailability, "available"> | undefined) => void;
}) {
  const { projectId, projectName, session, envMode, onEnvMode, pendingBase, onBase, onOpenChanges } = props;
  return (
    <>
      {compact && pills && (
        <div className="mx-3 -mt-px">
          <div className="flex items-center gap-1 rounded-b-2xl border border-t-0 border-border/80 bg-card/95 px-2 py-0.5 shadow-1 backdrop-blur-xl">{pills}</div>
        </div>
      )}
      {/* Hidden, not unmounted, while compact: its poll is what reports an unreachable drive. */}
      {projectId && (
        <div className={cn(compact && "hidden")}>
          <WorkspaceEnvironment
            projectId={projectId}
            onAvailability={onAvailability}
            {...(projectName ? { projectName } : {})}
            {...(session ? { session } : {})}
            {...(envMode ? { envMode } : {})}
            {...(onEnvMode ? { onEnvMode } : {})}
            {...(pendingBase ? { pendingBase } : {})}
            {...(onBase ? { onBase } : {})}
            {...(onOpenChanges ? { onOpenChanges } : {})}
          />
        </div>
      )}
    </>
  );
}
