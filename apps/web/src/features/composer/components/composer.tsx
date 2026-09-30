"use client";

// Enter always sends; mid-turn it steers the running turn. Send becomes Stop only while the box is empty.

import { useCallback, useId, useRef, useState } from "react";
import { turnHasContent, type ProjectAvailability } from "@telar/engine-client";
import { choiceOf } from "@/features/providers";
import { useCommandHandlers } from "@/features/commands";
import { DictationButton, DictationGlow, useComposerDictation } from "@/features/dictation";
import { cn } from "@/ui/utils";
import { compactBlockedReason, isResumeDraft, type Completion } from "../completions";
import { markComposerActive, type ComposerSubmit } from "../registry";
import { hasUltrathink, toggleUltrathink } from "../model-options";
import { useComposerCommandChoices } from "../hooks/use-composer-command-choices";
import { useComposerCompletions } from "../hooks/use-composer-completions";
import { composerKeyHandler, useEscArm } from "../hooks/use-composer-keys";
import { useComposerRegistration } from "../hooks/use-composer-registration";
import { MAX_ATTACHMENTS, useComposerStash } from "../hooks/use-composer-stash";
import { useDropTarget } from "../hooks/use-drop-target";
import { useQuestionMode } from "../hooks/use-question-mode";
import { ComposerBanners } from "./composer-banners";
import { ComposerCard } from "./composer-card";
import type { ComposerEditorHandle } from "./composer-editor";
import { ComposerFoot, ComposerHead } from "./composer-frame";
import type { ComposerProps } from "./composer-props";
import { ComposerQuestionDrawer } from "./composer-question-drawer";
import { ContextPill } from "./context-pill";
import { ComposerPills, SendButton } from "./composer-toolbar";

// External clients already reach for this id.
const EDITOR_ID = "turn-prompt";

function placeholderFor(ready: boolean, busy: boolean): string {
  if (!ready) return "Waiting for the session…";
  if (busy) return "Enter sends into the running turn…";
  return "Ask for changes, or explore the project…";
}

/** The one gate every send passes through: Enter, ⌘↵, the send button and the page API. */
function useSubmitGate(props: ComposerProps, question: { active: boolean; advance: { current: () => boolean } }, hasContent: boolean, driveAway: boolean, startResume: () => void) {
  const { draft, ready, fresh, onAdopt, onDraftChange, onSubmit } = props;
  const advance = question.advance;
  return useCallback((): ComposerSubmit => {
    if (question.active) return advance.current() ? { ok: true } : { ok: false, reason: "The open question has no answer to send yet." };
    // `/resume` typed in full is the same press as picking it from the menu.
    if (isResumeDraft(draft) && fresh && onAdopt) {
      onDraftChange("");
      startResume();
      return { ok: true };
    }
    if (!ready) return { ok: false, reason: "This conversation is not ready yet." };
    if (driveAway) return { ok: false, reason: "The project's files are not reachable right now." };
    if (!hasContent) return { ok: false, reason: "There is nothing to send." };
    onSubmit();
    return { ok: true };
  }, [question.active, advance, ready, driveAway, draft, hasContent, onSubmit, fresh, onAdopt, onDraftChange, startResume]);
}

function runAction(action: Completion["action"], props: ComposerProps, startResume: () => void) {
  const choice = choiceOf(props.session?.model ?? props.pendingModel);
  if (action.type === "runtime-mode") props.onRuntimeMode(action.mode);
  if (action.type === "env-mode") props.onEnvMode?.(action.mode);
  if (action.type === "driver") props.onDriverChange?.(action.driver);
  if (action.type === "model") props.onModelChange?.({ ...choice, model: action.model });
  if (action.type === "effort") props.onModelChange?.({ ...choice, effort: action.effort });
  if (action.type === "compact") props.onCompact?.();
  if (action.type === "resume") startResume();
  if (action.type === "stop") props.onStop();
}

/** Opened from the compact card; back to compact once the reader returns to the bottom. */
function useExpanded(compact: boolean) {
  const [expanded, setExpanded] = useState(false);
  if (!compact && expanded) setExpanded(false);
  return [expanded, () => setExpanded(true)] as const;
}

export function Composer(props: ComposerProps) {
  const { draft, ready, compact = false, kind = "session", attachments, onAttach, fresh = false, driver, busy, sending, session, projectId, onDraftChange, onStop } = props;
  const editor = useRef<ComposerEditorHandle>(null);
  // Reported up by the environment strip, which already polls the project's git state.
  const [driveAway, setDriveAway] = useState<Exclude<ProjectAvailability, "available">>();
  const [expanded, expand] = useExpanded(compact);
  const [resuming, setResuming] = useState(false);
  const startResume = useCallback(() => setResuming(true), []);
  const token = useId();
  const activeDriver = session?.driver ?? driver ?? "claude";
  const choice = choiceOf(session?.model ?? props.pendingModel);

  const question = useQuestionMode(props.question, props.onAnswerQuestion, draft);
  const hasContent = turnHasContent(draft, attachments.map((file) => file.type));
  const trySubmit = useSubmitGate(props, question, hasContent, Boolean(driveAway), startResume);
  useComposerRegistration(token, EDITOR_ID, kind, editor, { text: question.boxText, ready, submit: trySubmit });
  const dictation = useComposerDictation(token);
  const esc = useEscArm(busy, onStop);
  const stash = useComposerStash({ draft, attachments, projectId, sessionId: session?.id, onDraftChange, onAttach, editor });
  const commandChoices = useComposerCommandChoices(activeDriver, choice, session?.providerInstanceId);
  const menu = useComposerCompletions({
    editor,
    sessionId: session?.id,
    projectId,
    menuDriver: fresh ? driver : session?.driver,
    blocked: question.active,
    commands: { busy, fresh, runtimeMode: props.runtimeMode, envMode: props.envMode, compacting: props.compacting, canResume: Boolean(props.onAdopt), choices: commandChoices },
  });
  const pick = (completion: Completion) => {
    const action = menu.take(completion);
    if (action && action.type !== "insert") runAction(action, props, startResume);
  };
  const onKeyDown = composerKeyHandler({ draft, attachments, busy, questionActive: question.active, stash, menu, pick, submit: () => void trySubmit(), esc });
  useCommandHandlers({ "focus-composer": () => editor.current?.focus(), send: () => void trySubmit(), "stop-turn": () => busy && onStop() });

  const addFiles = (files: File[]) => onAttach([...attachments, ...files].slice(0, MAX_ATTACHMENTS));
  const drop = useDropTarget(editor, addFiles);
  // Focus and typing keep it compact; only what the compact card cannot show opens the full one.
  const compactNow = compact && !expanded && !fresh && !question.active && !drop.dropping && !stash.open && !esc.armed && !driveAway && attachments.length === 0;
  const pills = (session || (fresh && driver)) && (
    <ComposerPills
      {...props}
      driver={activeDriver}
      choice={choice}
      instanceId={session?.providerInstanceId}
      resumeAfterRateLimit={session?.resumeAfterRateLimit ?? props.resumeAfterRateLimitDefault}
      ultrathink={{ active: hasUltrathink(draft), toggle: () => onDraftChange(toggleUltrathink(draft)) }}
    />
  );
  const send = (
    <SendButton
      busy={busy}
      sending={sending}
      hasContent={hasContent}
      escArmed={esc.armed}
      onStop={onStop}
      {...(question.active ? { question: { label: question.submitLabel, ready: question.canAdvance } } : {})}
    />
  );

  const onEdit = (text: string) => {
    if (question.typeAnswer(text)) return;
    onDraftChange(text);
    // Before the state round-trip: the caret is read from the live DOM of this same edit.
    menu.edited(text);
    stash.setOpen(false);
    stash.setNote(undefined);
  };

  return (
    <div
      className={cn(
        "@container/composer relative mx-auto flex w-full max-w-[50rem] shrink-0 flex-col gap-1.5 px-4 pt-2 pb-5",
        "transition-transform duration-500 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none",
        fresh && "-translate-y-[calc(45dvh-7.5rem)]",
      )}
    >
      <ComposerHead props={props} resuming={resuming} onResuming={setResuming} note={stash.note} onDismissNote={() => stash.setNote(undefined)} />
      <div>
        <ComposerBanners {...props} />
        {question.active && props.question && (
          <ComposerQuestionDrawer
            fields={question.fields}
            draft={question.answer}
            onDraft={question.setAnswer}
            sending={sending}
            onCancelTurn={() => props.question && props.onCancelQuestion?.(props.question.id)}
          />
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            trySubmit();
          }}
        >
          <DictationGlow phase={dictation.phase} stream={dictation.stream}>
            <ComposerCard
              editor={editor}
              editorId={EDITOR_ID}
              kind={kind}
              text={question.boxText}
              placeholder={question.active ? "Type your own answer, or leave blank…" : placeholderFor(ready, busy)}
              ready={ready}
              compact={compactNow}
              draft={draft}
              attachments={attachments}
              onAttach={onAttach}
              addFiles={addFiles}
              onDraftChange={onDraftChange}
              onEdit={onEdit}
              onSelectionChange={() => !question.active && menu.retrigger(draft)}
              onKeyDown={onKeyDown}
              onFocus={() => markComposerActive(token)}
              onExpand={() => {
                expand();
                editor.current?.focus();
              }}
              stash={stash}
              menu={menu}
              pick={pick}
              drop={drop}
              pills={pills}
              trailing={
                compactNow ? (
                  <>
                    <DictationButton dictation={dictation} />
                    {send}
                  </>
                ) : (
                  <>
                    <ContextPill
                      {...(props.usage ? { usage: props.usage } : {})}
                      {...(session ? { driver: session.driver } : {})}
                      {...(props.onCompact ? { onCompact: props.onCompact } : {})}
                      compactDisabled={busy || sending || Boolean(props.compacting)}
                      compactReason={compactBlockedReason({ busy, ...(props.compacting ? { compacting: props.compacting } : {}) }) ?? "Sending…"}
                    />
                    <DictationButton dictation={dictation} />
                    {send}
                  </>
                )
              }
            />
          </DictationGlow>
        </form>
        <ComposerFoot props={props} compact={compactNow} pills={pills} hidden={dictation.phase !== "idle"} onAvailability={setDriveAway} />
      </div>
    </div>
  );
}
