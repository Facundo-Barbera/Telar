"use client";

/**
 * THE ONE QUESTION BEFORE A RESTART TO UPDATE.
 *
 * What it would stop — working sessions, then busy terminals — in one dialog, so
 * the shell never asks its own quit question on this path. With nothing running
 * it still asks, in a neutral line.
 *
 * CANCEL IS THE DEFAULT, and the only way through is the primary button:
 * Escape, a click outside and Cancel all back out. Focus is not moved on open —
 * `DialogContent` forbids it (WebKit 26 kills its renderer on programmatic
 * focus) — so Cancel leads the footer rather than being focused.
 *
 * The checkbox is the General setting itself, so ticking it here is the same
 * write as the switch there.
 */
import type { RestartConfirmation } from "@/lib/desktop-updates";
import { restartDialogCopy } from "@/lib/desktop-updates";
import { useSessionDefaults } from "@/lib/session-defaults";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const RESUME_AFTER_RESTART_LABEL = "Continue sessions after restarting";

export function RestartUpdateDialog({ restart }: { restart: RestartConfirmation }) {
  const { defaults, loading, save } = useSessionDefaults();
  const copy = restartDialogCopy(restart.impact);
  return (
    <Dialog open={restart.open} onOpenChange={(open) => !open && restart.cancel()}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Restart to update?</DialogTitle>
          <DialogDescription>{restart.impact ? copy.description : "Checking what is running…"}</DialogDescription>
        </DialogHeader>
        {copy.terminals && (
          <div className="text-sm text-muted-foreground">
            <p>{copy.terminals}</p>
            <ul className="mt-1 space-y-0.5">
              {copy.commands.map((command, index) => (
                <li key={`${index}:${command}`} className="truncate font-mono text-xs">
                  {command}
                </li>
              ))}
            </ul>
          </div>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-primary"
            checked={defaults.resumeAfterRestart === true}
            disabled={loading}
            onChange={(event) => void save({ resumeAfterRestart: event.target.checked })}
          />
          <span>
            {RESUME_AFTER_RESTART_LABEL}
            <span className="block text-xs text-muted-foreground">Sessions stopped by this restart pick up where they left off.</span>
          </span>
        </label>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={restart.confirm}>Restart and update</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
