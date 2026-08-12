"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeMode } from "@telar/engine-client";
import { Icon } from "./vnext-icons";

/**
 * The composer.
 *
 * THE BEHAVIOURAL SIGNATURE, ported from the frozen cockpit: ENTER ALWAYS
 * WORKS. While a turn is running the message is QUEUED rather than refused, the
 * box clears exactly as if it had sent, and the queue renders above as ordinary
 * editable lines. The engine gained this in `submitTurn`; the point of the
 * frozen app's design is that the UI never says "wait" — the old cockpit's only
 * mention of the mechanism is the placeholder, and that is deliberate.
 *
 * The pending strip carries NO LIFECYCLE VOCABULARY by construction: no
 * "queued" badge, no spinner, no "sending…". A line that is executing has no
 * chip at all — it is in the transcript instead. Status words there would be
 * describing the machine when the human only wants their sentence back.
 *
 * SEND BECOMES STOP. One button in the corner, `↵` → spinner → `■`, never
 * moving and never duplicating: the thing you press to go is the thing you
 * press to stop. Escape twice does the same from the keyboard, and the FIRST
 * press repaints that button with the literal word ESC — an arming state nobody
 * can see is indistinguishable from a keystroke that did nothing.
 */

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

/** The mode control. A brake a human can reach mid-turn, so it stays live
 *  while the session is busy rather than locking with everything else. */
function RuntimeModeControl({ mode, onChange, disabled }: {
  mode: RuntimeMode;
  onChange: (mode: RuntimeMode) => void;
  disabled: boolean;
}) {
  return <label className="vnext-composer__mode" title={RUNTIME_MODE_HELP[mode]}>
    <Icon name="shield" />
    <select
      aria-label="What this session may do without asking"
      value={mode}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as RuntimeMode)}
    >
      {RUNTIME_MODES.map((option) => <option key={option} value={option}>{RUNTIME_MODE_LABELS[option]}</option>)}
    </select>
  </label>;
}

function QueueChip({ item, onWithdraw }: { item: QueuedMessage; onWithdraw: (runId: string) => void }) {
  return <div className="vnext-queue-chip">
    <span className="vnext-queue-chip__text" title={item.text}>{item.text}</span>
    <button type="button" className="vnext-queue-chip__drop" aria-label="Remove this queued message" onClick={() => onWithdraw(item.runId)}>
      <Icon name="close" />
    </button>
  </div>;
}

export function Composer({
  draft, ready, busy, sending, queued, runtimeMode,
  onDraftChange, onSubmit, onStop, onWithdraw, onRuntimeMode,
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
  const field = useRef<HTMLTextAreaElement>(null);
  /**
   * DERIVED, not reset in an effect. An armed stop only means anything while a
   * turn is running, so the running flag is part of the ANSWER rather than a
   * trigger to go clear a flag — and an effect that clears it would let the
   * armed paint survive one render past the turn it belonged to.
   */
  const escArmed = armedRaw && busy;

  useEffect(() => {
    if (!escArmed) return;
    const timer = window.setTimeout(() => setEscArmed(false), ESC_ARM_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [escArmed]);


  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
  }, [draft, ready, busy, escArmed, onSubmit, onStop]);

  const submitLabel = escArmed ? "Press Escape again to stop" : busy ? "Stop" : "Send";
  return <div className="vnext-composer-wrap">
    {queued.length > 0 && <div className="vnext-queue" aria-label="Queued messages">
      {queued.length > 1 && <p className="vnext-queue__head">{queued.length} waiting</p>}
      {queued.map((item) => <QueueChip key={item.runId} item={item} onWithdraw={onWithdraw} />)}
    </div>}

    <form
      className="vnext-composer"
      onSubmit={(event) => { event.preventDefault(); if (draft.trim() && ready) onSubmit(); }}
    >
      <label className="sr-only" htmlFor="vnext-turn-prompt">Message</label>
      <textarea
        id="vnext-turn-prompt"
        ref={field}
        className="vnext-composer__field"
        placeholder={placeholderFor(ready, busy)}
        value={draft}
        // NOT disabled while busy. That is the whole point.
        disabled={!ready}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="vnext-composer__footer">
        <div className="vnext-composer__tools">
          {runtimeMode && <RuntimeModeControl mode={runtimeMode} onChange={onRuntimeMode} disabled={!ready} />}
        </div>
        <button
          type={busy ? "button" : "submit"}
          className="vnext-composer__send"
          data-state={escArmed ? "armed" : busy ? "stop" : sending ? "sending" : "ready"}
          aria-label={submitLabel}
          title={submitLabel}
          onClick={busy ? onStop : undefined}
          disabled={!ready || (!busy && !draft.trim())}
        >
          {escArmed ? <span className="vnext-composer__esc">ESC</span>
            : busy ? <Icon name="square" />
            : sending ? <Icon name="spinner" />
            : <Icon name="enter" />}
        </button>
      </div>
    </form>
  </div>;
}
