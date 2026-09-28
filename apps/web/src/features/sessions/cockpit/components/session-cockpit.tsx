"use client";

import { useCallback, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { WorkspaceInspector } from "@/features/sessions/components/workspace-inspector";
import type { ConversationFollowHandle } from "@/ui/conversation";
import { Composer } from "@/features/composer";
import { canvasPanelKey, RailToggle, RightPanel } from "@/features/panel";
import { usePluginPanels } from "@/features/plugins";
import { useProviderInstance } from "@/features/providers";
import { SessionSchedules } from "@/features/schedules";
import { normaliseContextNoticePercent } from "@/features/composer/context-notice";
import { hostFromPathname } from "@/platform/engine/host-client";
import { canvasHref } from "../../session-list";
import { pinToggleOverride } from "../model";
import { useCockpitCommands } from "../hooks/use-cockpit-commands";
import { useCockpitPanel } from "../hooks/use-cockpit-panel";
import { useCockpitProject } from "../hooks/use-cockpit-project";
import { useComposerDraft } from "../hooks/use-composer-draft";
import { useDraftConfig } from "../hooks/use-draft-config";
import { useJournalReactions } from "../hooks/use-journal-reactions";
import { useLinkRouting } from "../hooks/use-link-routing";
import { useNavigationMarks } from "../hooks/use-navigation-marks";
import { useReadReceiptMarker } from "../hooks/use-read-receipt-marker";
import { useSessionActions } from "../hooks/use-session-actions";
import { useSessionBrowser } from "../hooks/use-session-browser";
import { useSessionSync } from "../hooks/use-session-sync";
import { useSettling } from "../hooks/use-settling";
import { useSubmit } from "../hooks/use-submit";
import { useTitleMenu } from "../hooks/use-title-menu";
import { useTranscriptModel } from "../hooks/use-transcript-model";
import { composerProps } from "./composer-props";
import { rightPanelProps } from "./right-panel-props";
import { SessionMasthead, SoloTools, usePanelPresence } from "./masthead";
import { TranscriptList } from "./transcript-list";

export function SessionCockpit({
  projectId,
  sessionId: routeSessionId,
  projectName: serverProjectName,
  solo = false,
}: {
  projectId?: string;
  sessionId?: string;
  /** Resolved by the page, so the breadcrumb and the greeting never paint the raw id first. */
  projectName?: string;
  solo?: boolean;
}) {
  const [createdSessionId, setCreatedSessionId] = useState<string>();
  const pathname = usePathname();
  const hostId = hostFromPathname(pathname);
  // A session with no project has no canvas URL, so it is never on the canvas.
  const onCanvas = projectId !== undefined && pathname === canvasHref(projectId, hostId);
  const sessionId = routeSessionId ?? (onCanvas ? undefined : createdSessionId);
  /** No session yet: the composer is the whole screen and nothing is polled. */
  const fresh = !sessionId;
  const sync = useSessionSync({ hostId, sessionId, initiallyLoading: Boolean(routeSessionId) });
  const { session, setSession, setError, turns, events, transcriptLanded } = sync;
  const { projectName, projectResolved, defaults: projectDefaults, enabledPlugins } = useCockpitProject({
    hostId, projectId, serverProjectName, transcriptLanded,
  });
  const draftConfig = useDraftConfig({ projectId, fresh, projectDefaults });
  const composer = useComposerDraft({ sessionId, projectId });
  const follow = useRef<ConversationFollowHandle>(null);
  /** Reading back through the transcript steps the composer down to its compact shape. */
  const [readingBack, setReadingBack] = useState(false);
  const onAtBottomChange = useCallback((atBottom: boolean) => setReadingBack(!atBottom), []);
  const pluginPanels = usePluginPanels(hostId, enabledPlugins);
  const panelKey = sessionId ?? (projectId === undefined ? "main" : canvasPanelKey(projectId));
  const panelState = useCockpitPanel({ panelKey, enabledPlugins, hostId, sessionId });
  const { panel, editors, updatePanel, showPanelTab, showSessionBrowser } = panelState;
  const panelPresence = usePanelPresence(!solo && panel.open);
  const browser = useSessionBrowser({
    hostId, sessionId, projectId, transcriptLanded, events, draft: draftConfig.choices, composer,
    panel, editors, setSession, setCreatedSessionId, showSessionBrowser, showPanelTab,
  });
  useCockpitCommands({
    solo, enabledPlugins, panel: panelState,
    pinSession: () => {
      if (!sessionId) return;
      void settling.patchFromMenu({ settledOverride: pinToggleOverride(session?.settledOverride) }, "Could not change the session's pin.");
    },
  });
  const onConversationClick = useLinkRouting({ hostId, projectId, sessionId, solo, showPanelTab, showSessionBrowser, updatePanel });
  const revealNewTerminals = useJournalReactions({ events, browser: browser.browser, enabledPlugins, showPanelTab, updatePanel });
  const model = useTranscriptModel({ sessionId, turns, items: sync.items, events, tasks: sync.tasks, requests: sync.requests, showPanelTab });
  const { active } = model;
  const settling = useSettling({ hostId, sessionId, session, setSession, setError });
  const actions = useSessionActions({ sessionId, session, hydrate: sync.hydrate, setSession, setError });
  const { submit, adoptConversation } = useSubmit({
    hostId, sessionId, projectId, session, composer, draft: { ...draftConfig.choices, runtimeModeTouched: draftConfig.runtimeModeTouched },
    busy: Boolean(active) || model.compacting, browserDraftFlight: browser.browserDraftFlight, browserDraftSendPending: browser.browserDraftSendPending,
    follow, canvas: { panel, editors }, compact: actions.compact, hydrate: sync.hydrate, setSending: actions.setSending, setSession, setError,
    clearTranscript: sync.clearTranscript, setCreatedSessionId,
  });
  const headerMenu = useTitleMenu({ hostId, projectId, projectName, sessionId, session, settling, setError });
  useNavigationMarks(pathname, transcriptLanded, sync.loading);
  const receipt = useReadReceiptMarker({ hostId, sessionId, session, turns, loading: sync.loading, setSession });
  const providerInstance = useProviderInstance(session?.providerInstanceId, session?.driver);
  const panelGestures = solo
    ? {}
    : { onOpenAgent: model.showAgent, onOpenTab: showPanelTab, onOpenFile: (path: string) => showPanelTab(`file:${path}`), onOpenFileInNewTab: panelState.openFileInNewPanelTab };

  return (
    <main data-surfaces className="group/surfaces flex min-h-0 flex-1 overflow-hidden md:overflow-visible md:gap-2">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:rounded-xl md:bg-sidebar md:shadow-1 md:ring-1 md:ring-sidebar-border md:group-has-[[data-panel-fullscreen]]/surfaces:shadow-none md:group-has-[[data-panel-fullscreen]]/surfaces:ring-0">
        {solo ? (
          <SoloTools projectId={projectId} hostId={hostId} session={session} />
        ) : (
          <SessionMasthead
            projectId={projectId}
            hostId={hostId}
            projectName={projectName}
            projectResolved={projectResolved}
            session={session}
            {...(headerMenu ? { menu: headerMenu } : {})}
            onRename={(next) => void actions.rename(next)}
            onWatchRun={() => showPanelTab("terminal")}
            onRunTerminals={revealNewTerminals}
            panel={
              <>
                {/* Keyed by host and session: a different machine is a different mount. The last turn's state is the refresh cue. */}
                {session && (
                  <SessionSchedules key={`${hostId}:${session.id}`} sessionId={session.id} hostId={hostId} refreshKey={`${turns.at(-1)?.runId}:${turns.at(-1)?.state}`} />
                )}
                {(session?.projectId ?? projectId) !== undefined && <WorkspaceInspector projectId={(session?.projectId ?? projectId)!} />}
                <RailToggle open={panel.open} onToggle={panelState.openPanel} />
              </>
            }
          />
        )}
        <TranscriptList
          conversation={sync.syncKey}
          landed={transcriptLanded}
          follow={follow}
          onAtBottomChange={onAtBottomChange}
          onConversationClick={onConversationClick}
          projectId={projectId}
          session={session}
          stale={sync.stale}
          error={sync.error}
          fresh={fresh}
          loading={sync.loading}
          page={sync.page}
          loadingOlder={sync.loadingOlder}
          loadOlder={sync.loadOlder}
          transcript={model.transcript}
          active={active}
          requests={sync.requests}
          openRequests={model.openRequests}
          composerQuestion={model.composerQuestion}
          newestResultRunId={receipt.newestResult?.runId}
          markerRefFor={receipt.markerRefFor}
          turn={{
            roster: model.roster,
            sending: actions.sending,
            onInsert: composer.insertIntoComposer,
            ...panelGestures,
            onDecide: (requestId, decision, extra) => void actions.decideRequest(requestId, decision, extra),
            onRetry: (item) => void actions.retryAmbiguous(item),
          }}
          onResumeNow={(runId) => void actions.resumeNow(runId)}
        />
        <Composer
          {...composerProps({
            fresh, solo, session, projectId, projectName, composer, draft: draftConfig, actions, settling, model, submit, adoptConversation, showPanelTab,
            // Not while a conversation is opening: a composer changing height would move the viewport again.
            compact: readingBack && transcriptLanded,
            contextNoticePercent: normaliseContextNoticePercent(providerInstance?.contextNoticePercent),
          })}
        />
      </div>
      {panelPresence.mounted && (
        <RightPanel
          {...rightPanelProps({
            open: panelPresence.shown, hostId, sessionId, projectId, session, sync, model, panel: panelState, browser, composer, enabledPlugins, pluginPanels,
          })}
        />
      )}
    </main>
  );
}
