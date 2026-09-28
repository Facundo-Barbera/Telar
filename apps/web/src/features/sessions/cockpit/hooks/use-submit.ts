"use client";

import type { RefObject } from "react";
import { seedSessionTitle, turnHasContent, type ClaudeConversation, type TurnModelSelection } from "@telar/engine-client";
import { asEngineError, createEngineApi, EngineApiError, newRunId } from "@/platform/engine";
import { isCompactDraft, writeDraft } from "@/features/composer";
import { splitImages } from "@/features/prompts";
import { choiceNamesAnything, choiceOf, sessionModelSelection } from "@/features/providers";
import type { ConversationFollowHandle } from "@/ui/conversation";
import { hostFetcher } from "@/platform/engine/host-client";
import { sessionHref } from "../../session-list";
import { handOffCanvas } from "../canvas-handoff";
import { createFromCanvas } from "../create-from-canvas";
import type { useCockpitPanel } from "./use-cockpit-panel";
import type { useComposerDraft } from "./use-composer-draft";
import type { useDraftConfig } from "./use-draft-config";
import type { useSessionActions } from "./use-session-actions";
import type { useSessionBrowser } from "./use-session-browser";
import type { useSessionSync } from "./use-session-sync";

const api = createEngineApi();

type Args = {
  hostId: string;
  sessionId: string | undefined;
  projectId: string | undefined;
  busy: boolean;
  sync: ReturnType<typeof useSessionSync>;
  composer: ReturnType<typeof useComposerDraft>;
  draft: ReturnType<typeof useDraftConfig>;
  browser: ReturnType<typeof useSessionBrowser>;
  panel: ReturnType<typeof useCockpitPanel>;
  actions: ReturnType<typeof useSessionActions>;
  follow: RefObject<ConversationFollowHandle | null>;
  setCreatedSessionId: (id: string) => void;
};

/** Sending the composer's message, which on a fresh canvas first creates the session; and adopting a Claude Code conversation. */
export function useSubmit(args: Args) {
  const { hostId, sessionId, projectId, composer, draft, sync, browser, actions } = args;
  const { session, setSession, setError } = sync;

  const landOn = (target: string, projectId: string) => {
    handOffCanvas(target, projectId, args.panel, { clearCanvas: false });
    sync.clearTranscript();
    composer.claim({ sessionId: target, projectId });
    args.setCreatedSessionId(target);
  };

  const submit = async () => {
    const { draft: text0, attachments } = composer;
    if (!turnHasContent(text0, attachments.map((file) => file.type)) || browser.browserDraftSendPending.current) return;
    if (isCompactDraft(text0) && sessionId && session?.driver === "claude" && !args.busy) {
      composer.setDraft("");
      writeDraft(sessionId, projectId, "");
      await actions.compact();
      return;
    }
    // A send racing the first browser open joins its stable session identity.
    let browserTarget: string | undefined;
    if (browser.browserDraftFlight.current) {
      browser.browserDraftSendPending.current = true;
      const origin = window.location.pathname;
      try {
        browserTarget = await browser.browserDraftFlight.current;
      } catch (cause) {
        setError(asEngineError(cause, "Could not save the browser draft. Your message is still here."));
        return;
      } finally {
        browser.browserDraftSendPending.current = false;
      }
      const destination = sessionHref({ id: browserTarget, projectId, hostId });
      if (window.location.pathname !== origin && window.location.pathname !== destination) return;
    }
    const runId = composer.draftRunId ?? newRunId();
    composer.setDraftRunId(runId);
    actions.setSending(true);
    args.follow.current?.toBottom();
    // Cleared before the round trip: the box emptying is the acknowledgement.
    const text = text0.trim();
    const files = attachments;
    composer.setDraft("");
    writeDraft(sessionId ?? browserTarget, projectId, "");
    composer.setDraftRunId(undefined);
    composer.setAttachments([]);
    try {
      let target = sessionId ?? browserTarget;
      if (!target) {
        if (projectId === undefined) {
          setError(new EngineApiError("invalid_request", "This conversation has no project to create a session in."));
          return;
        }
        const title = seedSessionTitle(text, splitImages(files).images.map((file) => file.name));
        const { session: created } = await createFromCanvas(api, { projectId, hostId, title, driver: draft.driver, envMode: draft.envMode, base: draft.base });
        target = created.id;
        const model = sessionModelSelection(created.providerInstanceId, draft.pick);
        const creationPatch = { ...(draft.runtimeModeTouched ? { runtimeMode: draft.runtimeMode } : {}), ...(model ? { model } : {}) };
        const patched = Object.keys(creationPatch).length > 0 ? (await api.updateSession(target, creationPatch)).session : undefined;
        if (patched) setSession(patched);
        landOn(target, projectId);
        if (!patched) setSession(created);
      }
      const attachmentIds: string[] = [];
      for (const file of files) attachmentIds.push((await api.uploadAttachment(target, file)).attachment.id);
      const pending = session?.model ?? draft.pick;
      await api.submitTurn(target, {
        runId,
        input: text,
        ...(choiceNamesAnything(pending) ? { model: choiceOf(pending) as TurnModelSelection } : {}),
        ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
      });
      // A just-created session is hydrated by the effect keyed on `sessionId`; this closure holds the old id.
      if (sessionId) await sync.hydrate();
      setError(undefined);
    } catch (cause) {
      // Give the words and the files back.
      composer.setDraft(text);
      composer.setDraftRunId(runId);
      composer.setAttachments(files);
      setError(asEngineError(cause, "Could not submit the turn."));
    } finally {
      actions.setSending(false);
    }
  };

  const adoptConversation = async (conversation: ClaudeConversation): Promise<void> => {
    if (projectId === undefined) throw new EngineApiError("invalid_request", "This conversation has no project to create a session in.");
    // The engine refuses this too; saying it here tells the person before a session is created.
    if (sessionId) throw new EngineApiError("conflict", "This conversation has already started. Open a new one to bring in another.");
    const title = (conversation.customTitle || conversation.firstPrompt || conversation.title || "Claude Code conversation")
      .replace(/\s+/g, " ")
      .slice(0, 80);
    const adoptApi = createEngineApi(hostFetcher(hostId));
    const { session: created, canvas } = await createFromCanvas(adoptApi, { projectId, hostId, title, driver: "claude", envMode: draft.envMode, base: draft.base });
    try {
      const adopted = await adoptApi.adoptClaudeConversation(created.id, conversation.sessionId);
      setSession(adopted.session);
    } catch (cause: unknown) {
      window.history.replaceState(null, "", canvas);
      throw cause;
    }
    landOn(created.id, projectId);
  };

  return { submit, adoptConversation };
}
