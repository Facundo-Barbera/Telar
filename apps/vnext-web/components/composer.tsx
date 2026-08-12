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
import { CornerDownLeftIcon, ShieldIcon, SquareIcon, XIcon } from "lucide-react";
import type { RuntimeMode } from "@telar/engine-client";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** How long a first Escape stays armed. */
const ESC_ARM_WINDOW_MS = 3_000;

export type QueuedMessage = { runId: string; text: string };

export const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Ask first",
  "auto-accept-edits": "Auto edits",
  auto: "Auto",
  "full-access": "Full access",
};

/** What each mode actually permits, in the terms a human decides in. */
export const RUNTIME_MODE_HELP: Record<RuntimeMode, string> = {
  "approval-required": "Asks before running commands or changing files. Reads are allowed.",
  "auto-accept-edits": "Edits and reads files freely. Asks before running commands.",
  auto: "Runs tools without asking. Questions still reach you.",
  "full-access": "Never asks. Use when nobody is watching and the blast radius is bounded.",
};

const RUNTIME_MODES: RuntimeMode[] = ["approval-required", "auto-accept-edits", "auto", "full-access"];

function placeholderFor(ready: boolean, busy: boolean): string {
  if (!ready) return "Waiting for the engine-owned session…";
  // The ONLY place the cockpit mentions that queueing exists.
  if (busy) return "Enter queues a message…";
  return "Ask for changes, explore the project, or continue this conversation…";
}

/** The mode control. A brake a human can reach MID-TURN, so it stays live while
 *  the session is busy rather than locking with everything else. */
function RuntimeModeControl({ mode, onChange, disabled }: { mode: RuntimeMode; onChange: (mode: RuntimeMode) => void; disabled: boolean }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <Select value={mode} onValueChange={(next) => onChange(next as RuntimeMode)} disabled={disabled}>
              <SelectTrigger
                size="sm"
                aria-label="What this session may do without asking"
                className="h-6 gap-1 border-0 bg-transparent px-1.5 text-xs text-muted-foreground shadow-none hover:bg-muted hover:text-foreground"
              >
                <ShieldIcon className="size-3.5" />
                {/* Without a formatter this prints the raw mode (`auto-accept-edits`),
                    which is a wire value, not a label a human chose from. */}
                <SelectValue>{(value: RuntimeMode) => RUNTIME_MODE_LABELS[value]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {RUNTIME_MODES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {RUNTIME_MODE_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <TooltipContent side="top">
          <p className="max-w-56">{RUNTIME_MODE_HELP[mode]}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
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
    <div className="mx-auto flex w-full max-w-[50rem] shrink-0 flex-col gap-1.5 px-4 pt-2 pb-4">
      {queued.length > 0 && (
        <div className="flex flex-col gap-1" aria-label="Queued messages">
          {queued.length > 1 && <p className="px-1 text-[10px] text-muted-foreground">{queued.length} waiting</p>}
          {queued.map((item) => (
            <QueueChip key={item.runId} item={item} onWithdraw={onWithdraw} />
          ))}
        </div>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim() && ready) onSubmit();
        }}
      >
        <InputGroup>
          <label className="sr-only" htmlFor="vnext-turn-prompt">
            Message
          </label>
          <InputGroupTextarea
            id="vnext-turn-prompt"
            className="field-sizing-content max-h-48 min-h-16"
            placeholder={placeholderFor(ready, busy)}
            value={draft}
            // NOT disabled while busy. That is the whole point.
            disabled={!ready}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <InputGroupAddon align="block-end" className="justify-between gap-1">
            <div className="flex min-w-0 items-center gap-1">
              {runtimeMode && <RuntimeModeControl mode={runtimeMode} onChange={onRuntimeMode} disabled={!ready} />}
            </div>
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
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  );
}
