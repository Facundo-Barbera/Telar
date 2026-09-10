"use client";

/**
 * The play button, and the sentence it makes a human read before a takeover.
 *
 * ONE CONTROL, FOUR MEANINGS. A project has one deployment, so the same button
 * is "Start", "Replace", "Switch" or "Release" depending on what is already
 * running and which tree it came from (`runAction`). The label is not decoration
 * — pressing "Start" and getting a takeover of another session's server is the
 * failure this feature is shaped around, so the takeover cases say so and ask.
 *
 * IT NEVER SIGNALS A RUN TELAR LOST. `release` frees the slot and kills nothing;
 * the copy says that, because the human is the one who has to go and check.
 */

import { useState } from "react";
import { CircleStopIcon, PlayIcon, RotateCwIcon, UnlockIcon } from "lucide-react";
import type { RunAction } from "@/lib/run/presentation";
import { runAction, worktreeLabel } from "@/lib/run/presentation";
import type { RunStatusAnswer } from "@/lib/run/types";

/** The verb on the button, for each thing the button can mean. */
export function actionLabel(action: RunAction): string {
  switch (action.kind) {
    case "start":
      return "Start";
    case "replace":
      return "Replace";
    case "switch":
      return "Switch to this tree";
    case "release":
      return "Release";
    case "wait":
      return "Starting…";
  }
}

/**
 * What the human must agree to, or `undefined` when nothing is being taken
 * over. Returning a string here is what makes the confirmation testable — and
 * what keeps "Start" from ever quietly stopping something.
 */
export function confirmation(action: RunAction, next: string): string | undefined {
  switch (action.kind) {
    case "replace":
      return `Stop “${action.active.configName}” and start “${next}” in its place?`;
    case "switch":
      return `“${action.active.configName}” is deployed from ${worktreeLabel(action.from, action.active.worktreeBranch)}, not this session's tree. Stop it and start “${next}” from here?`;
    case "release":
      return `Telar lost contact with “${action.active.configName}” and will not signal it. Release the slot only if you have checked that nothing it started is still running.`;
    default:
      return undefined;
  }
}

type Props = {
  answer: RunStatusAnswer;
  /** The configuration the human has selected to launch. */
  configName?: string;
  busy?: boolean;
  onStart: (replace: boolean) => void;
  onStop: () => void;
  onRestart: () => void;
  onRelease: () => void;
};

export function RunControl({ answer, configName, busy, onStart, onStop, onRestart, onRelease }: Props) {
  const [pending, setPending] = useState<RunAction>();
  const action = runAction(answer);
  const label = actionLabel(action);
  const ask = confirmation(action, configName ?? "this configuration");
  const disabled = busy || action.kind === "wait" || (action.kind === "start" && !configName);

  const commit = (chosen: RunAction) => {
    setPending(undefined);
    if (chosen.kind === "release") return onRelease();
    onStart(chosen.kind !== "start");
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-muted disabled:opacity-50 focus-visible:outline focus-visible:outline-ring"
          onClick={() => (ask ? setPending(action) : commit(action))}
        >
          {action.kind === "release" ? <UnlockIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
          {label}
        </button>
        {action.kind === "replace" || action.kind === "switch" ? (
          <>
            <button
              type="button"
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-muted disabled:opacity-50 focus-visible:outline focus-visible:outline-ring"
              onClick={onStop}
            >
              <CircleStopIcon className="size-3.5" /> Stop
            </button>
            <button
              type="button"
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-muted disabled:opacity-50 focus-visible:outline focus-visible:outline-ring"
              onClick={onRestart}
            >
              <RotateCwIcon className="size-3.5" /> Restart
            </button>
          </>
        ) : null}
      </div>
      {pending ? (
        <div role="alertdialog" aria-label="Confirm" className="space-y-2 rounded-md border border-border bg-muted/40 p-3">
          <p className="text-sm">{confirmation(pending, configName ?? "this configuration")}</p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-muted focus-visible:outline focus-visible:outline-ring"
              onClick={() => commit(pending)}
            >
              {actionLabel(pending)}
            </button>
            <button
              type="button"
              className="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-ring"
              onClick={() => setPending(undefined)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
