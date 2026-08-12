"use client";

/**
 * The composer.
 *
 * Built on the shared InputGroup primitive rather than on a hand-styled form, so
 * the box you type into is the same object — same border token, same focus ring,
 * same radius — as every other field in Telar. The block-end addon is what puts
 * the toolbar INSIDE the box instead of under it.
 *
 * ENTER ALWAYS WORKS. While a turn is running the message is QUEUED rather than
 * refused, the box clears exactly as if it had sent, and the queue renders above
 * as ordinary lines. The UI never says "wait": the only mention of the mechanism
 * anywhere is the placeholder, and that is deliberate.
 *
 * The pending strip carries NO LIFECYCLE VOCABULARY by construction — no
 * "queued" badge, no spinner, no "sending…". A line that is executing has no
 * chip at all; it is in the transcript instead. Status words there would be
 * describing the machine when the human only wants their sentence back.
 *
 * SEND BECOMES STOP. One control in the corner, `↵` → spinner → `■`, never
 * moving and never duplicating: the thing you press to go is the thing you press
 * to stop. Escape twice does the same from the keyboard, and the FIRST press
 * repaints that button with the literal word ESC — an arming state nobody can
 * see is indistinguishable from a keystroke that did nothing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CornerDownLeftIcon, PaperclipIcon, SquareIcon, XIcon } from "lucide-react";
import type { RuntimeMode, Session, UsageSnapshot } from "@telar/engine-client";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
export { RUNTIME_MODE_HELP, RUNTIME_MODE_LABELS } from "./composer-controls";
import { Spinner } from "@/components/ui/spinner";
import { AgentControl, BackgroundPresence, ContextPill, RuntimeModeControl } from "./composer-controls";
import { WorkspaceEnvironment } from "./workspace-environment";
import { cn } from "@/lib/utils";

/** How long a first Escape stays armed. */
const ESC_ARM_WINDOW_MS = 3_000;

export type QueuedMessage = { runId: string; text: string };

function placeholderFor(ready: boolean, busy: boolean): string {
  if (!ready) return "Waiting for the engine-owned session…";
  // The ONLY place the cockpit mentions that queueing exists.
  if (busy) return "Enter queues a message…";
  return "Ask for changes, explore the project, or continue this conversation…";
}

function QueueChip({ item, onWithdraw }: { item: QueuedMessage; onWithdraw: (runId: string) => void }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1.5 text-xs text-foreground">
      <span className="min-w-0 flex-1 truncate" title={item.text}>
        {item.text}
      </span>
      <button
        type="button"
        aria-label="Remove this queued message"
        onClick={() => onWithdraw(item.runId)}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

export function Composer({
  draft,
  ready,
  busy,
  sending,
  queued,
  runtimeMode,
  session,
  projectId,
  projectName,
  usage,
  backgroundTasks,
  onDraftChange,
  onSubmit,
  onStop,
  onWithdraw,
  onRuntimeMode,
}: {
  draft: string;
  ready: boolean;
  /** A turn is running or claimed. NOT a reason to disable anything. */
  busy: boolean;
  sending: boolean;
  queued: QueuedMessage[];
  runtimeMode?: RuntimeMode;
  session?: Session;
  projectId: string;
  projectName?: string;
  /** The newest turn's usage — the context readout's only honest source. */
  usage?: UsageSnapshot;
  /** Work that outlives the turn that started it. */
  backgroundTasks: number;
  onDraftChange: (draft: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onWithdraw: (runId: string) => void;
  onRuntimeMode: (mode: RuntimeMode) => void;
}) {
  const [armedRaw, setEscArmed] = useState(false);
  const armedAt = useRef<number>(0);
  /**
   * DERIVED, not reset in an effect. An armed stop only means anything while a
   * turn is running, so the running flag is part of the ANSWER rather than a
   * trigger to go clear a flag — and an effect that cleared it would let the
   * armed paint survive one render past the turn it belonged to.
   */
  const escArmed = armedRaw && busy;

  useEffect(() => {
    if (!escArmed) return;
    const timer = window.setTimeout(() => setEscArmed(false), ESC_ARM_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [escArmed]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // IME composition: Enter is committing a candidate, not sending.
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (draft.trim() && ready) onSubmit();
        return;
      }
      if (event.key === "Escape" && busy) {
        event.preventDefault();
        if (escArmed && Date.now() - armedAt.current <= ESC_ARM_WINDOW_MS) {
          setEscArmed(false);
          onStop();
        } else {
          armedAt.current = Date.now();
          setEscArmed(true);
        }
        return;
      }
      // Any other key disarms — the human moved on.
      if (escArmed) setEscArmed(false);
    },
    [draft, ready, busy, escArmed, onSubmit, onStop],
  );

  const submitLabel = escArmed ? "Press Escape again to stop" : busy ? "Stop" : "Send";

  return (
    <div className="relative mx-auto flex w-full max-w-[50rem] shrink-0 flex-col gap-1.5 px-4 pt-2 pb-5">
      {queued.length > 0 && (
        <div className="flex flex-col gap-1" aria-label="Queued messages">
          {queued.length > 1 && <p className="px-1 text-[10px] text-muted-foreground">{queued.length} waiting</p>}
          {queued.map((item) => (
            <QueueChip key={item.runId} item={item} onWithdraw={onWithdraw} />
          ))}
        </div>
      )}

      <BackgroundPresence count={backgroundTasks} onStop={onStop} />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim() && ready) onSubmit();
        }}
      >
        {/* A TRANSLUCENT, BLURRED SURFACE — not a flat panel. The transcript
            scrolls UNDER the composer, so an opaque box would cut the column in
            half with a hard edge; `bg-card/95` plus `backdrop-blur-xl` lets the
            text approach and dissolve instead. The long soft shadow does the
            rest: it lifts the composer off the conversation without a border
            heavy enough to read as a division. */}
        <InputGroup className="rounded-2xl border-border/80 bg-card/95 shadow-[0_18px_60px_-30px_rgba(0,0,0,.9)] backdrop-blur-xl">
          <label className="sr-only" htmlFor="vnext-turn-prompt">
            Message
          </label>
          <InputGroupTextarea
            id="vnext-turn-prompt"
            // 76px and 15px/24 — a composer is not a form field. It is the
            // largest single target on the screen and the type has to hold its
            // own against the transcript it sits under.
            className="field-sizing-content max-h-48 min-h-[76px] px-3 pt-3 pb-2 text-[15px] leading-6"
            placeholder={placeholderFor(ready, busy)}
            value={draft}
            // NOT disabled while busy. That is the whole point.
            disabled={!ready}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <InputGroupAddon align="block-end" className="min-h-11 flex-wrap justify-between gap-1 border-t border-border/40 px-2.5 pt-1.5 pb-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {/* Present but inert: attachments are a contract the engine does
                  not have yet. Disabled with the reason rather than absent, so
                  the row's shape is the one it will keep. */}
              <button
                type="button"
                disabled
                title="Attachments are not built yet"
                aria-label="Add context"
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-40"
              >
                <PaperclipIcon className="size-4" />
              </button>
              {session && <AgentControl driver={session.driver} {...(session.model?.model ? { model: session.model.model } : {})} {...(session.model?.effort ? { effort: session.model.effort } : {})} />}
              {runtimeMode && <RuntimeModeControl mode={runtimeMode} onChange={onRuntimeMode} disabled={!ready} />}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5 self-end">
            <ContextPill usage={usage} />
            <InputGroupButton
              type={busy ? "button" : "submit"}
              variant="default"
              size="icon-sm"
              aria-label={submitLabel}
              onClick={busy ? onStop : undefined}
              disabled={!ready || (!busy && !draft.trim())}
              className={cn(escArmed && "bg-destructive text-background hover:bg-destructive")}
            >
              {escArmed ? (
                // The WORD, not a glyph. "ESC" names the key the user just
                // pressed and the key that will finish the job, which no icon
                // can say.
                <span className="text-[10px] leading-none font-semibold tracking-tight">ESC</span>
              ) : busy ? (
                <SquareIcon className="size-4" />
              ) : sending ? (
                <Spinner />
              ) : (
                <CornerDownLeftIcon className="size-4" />
              )}
            </InputGroupButton>
            </div>
          </InputGroupAddon>
        </InputGroup>
      </form>

      {/* The composer's foot: where this message lands. Outside the form and
          fused to its bottom edge — see workspace-environment.tsx. */}
      <WorkspaceEnvironment projectId={projectId} {...(projectName ? { projectName } : {})} {...(session ? { session } : {})} />
    </div>
  );
}
