import type { ComponentProps } from "react";
import type { Session } from "@telar/engine-client";
import type { Composer } from "@/features/composer";
import type { PanelTab } from "@/features/panel";
import { wakeLabel } from "../../session-settling";
import type { useComposerDraft } from "../hooks/use-composer-draft";
import type { useDraftConfig } from "../hooks/use-draft-config";
import type { useSessionActions } from "../hooks/use-session-actions";
import type { useSettling } from "../hooks/use-settling";
import type { useSubmit } from "../hooks/use-submit";
import type { useTranscriptModel } from "../hooks/use-transcript-model";

export function composerProps({ fresh, solo, session, projectId, projectName, compact, contextNoticePercent, composer, draft, actions, settling, model, submit, showPanelTab }: {
  fresh: boolean;
  solo: boolean;
  session: Session | undefined;
  projectId: string | undefined;
  projectName: string | undefined;
  compact: boolean;
  contextNoticePercent: ComponentProps<typeof Composer>["contextNoticePercent"];
  composer: ReturnType<typeof useComposerDraft>;
  draft: ReturnType<typeof useDraftConfig>;
  actions: ReturnType<typeof useSessionActions>;
  settling: ReturnType<typeof useSettling>;
  model: ReturnType<typeof useTranscriptModel>;
  submit: ReturnType<typeof useSubmit>;
  showPanelTab: (tab: PanelTab) => void;
}): ComponentProps<typeof Composer> {
  const { composerQuestion, newestUsage } = model;
  const runtimeMode = session?.runtimeMode ?? (fresh ? draft.runtimeMode : undefined);
  return {
    draft: composer.draft,
    // A fresh canvas is ready: the message typed is what creates the session.
    ready: fresh || Boolean(session),
    compact,
    attachments: composer.attachments,
    onAttach: composer.setAttachments,
    fresh,
    ...(fresh
      ? {
          driver: draft.driver,
          onDriverChange: draft.chooseDriver,
          pendingModel: draft.model,
          envMode: draft.envMode,
          onEnvMode: draft.chooseEnvMode,
          pendingBase: draft.base,
          onBase: draft.chooseBase,
          ...(draft.driver === "claude" ? { onAdopt: submit.adoptConversation } : {}),
        }
      : {}),
    busy: Boolean(model.active),
    sending: actions.sending,
    ...(runtimeMode ? { runtimeMode: session?.runtimeMode ?? draft.runtimeMode } : {}),
    projectId: session?.projectId ?? projectId,
    ...(projectName ? { projectName } : {}),
    ...(session ? { session } : {}),
    ...(newestUsage ? { usage: newestUsage } : {}),
    backgroundTasks: model.backgroundTasks,
    settled: settling.settled,
    ...(settling.endedText === undefined ? {} : { settledEnded: settling.endedText }),
    onUnsettle: () => void settling.unsettle(),
    ...(settling.snoozedUntil === undefined ? {} : { snoozeWakeIn: wakeLabel(settling.snoozedUntil, settling.now) }),
    onWake: () => void settling.snooze(null),
    ...(session?.driver === "claude" ? { onCompact: () => void actions.compact() } : {}),
    compacting: model.compacting,
    contextNoticePercent,
    ...(composerQuestion
      ? {
          question: composerQuestion,
          onAnswerQuestion: (requestId: string, answers: Record<string, string | string[]>) => void actions.decideRequest(requestId, "accept", { answers }),
          onCancelQuestion: (requestId: string) => void actions.decideRequest(requestId, "cancel"),
        }
      : {}),
    onDraftChange: composer.changeDraft,
    onSubmit: () => void submit.submit(),
    onStop: () => void actions.stop(),
    onStopBackground: () => void actions.stopBackground(),
    ...(solo ? {} : { onViewBackground: model.showProcesses }),
    // Before a session exists both choices are held locally and applied by the patch that follows creation.
    onRuntimeMode: fresh ? draft.chooseRuntimeMode : (mode) => void actions.setRuntimeMode(mode),
    ...(fresh ? {} : { onResumeAfterRateLimit: (next: boolean) => void actions.setResumeAfterRateLimit(next) }),
    ...(draft.sessionDefaults.resumeAfterRateLimit === undefined ? {} : { resumeAfterRateLimitDefault: draft.sessionDefaults.resumeAfterRateLimit }),
    onModelChange: fresh ? draft.chooseModel : (next) => void actions.setModel(next),
    // A right-panel tab, so on the solo route the change count stays a count.
    ...(solo ? {} : { onOpenChanges: () => showPanelTab("diff") }),
  };
}
