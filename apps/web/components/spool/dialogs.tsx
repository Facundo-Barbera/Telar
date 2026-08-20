"use client";

/**
 * THE SPOOL'S OWN DIALOGS, replacing sixteen browser-native `prompt`, `confirm`
 * and `alert` calls.
 *
 * WHY THIS IS A REAL GAP AND NOT A STYLE PREFERENCE. The queue and the packet
 * were the only surfaces in this app still speaking browser-native: sixteen
 * calls here against two in `components/session` and zero everywhere else, while
 * thirteen other surfaces already use the design system's dialogs, menus and
 * tooltips. The queue's own header called this out as a deferral — "a richer
 * affordance is a later pass over a surface that already works" — and this is
 * that pass.
 *
 * What a native dialog costs, concretely, and each of these is visible on the
 * Spool today:
 *   · IT CANNOT BE STYLED OR THEMED, so a dark-mode app opens a light OS box.
 *   · IT BLOCKS THE MAIN THREAD, freezing the streaming transcript behind it.
 *   · IT HAS NO ROOM TO EXPLAIN. A lane needs a label AND a window, so creating
 *     one meant two sequential prompts with no way back from the second.
 *   · IT LOSES WHAT YOU TYPED on the way to a second question.
 *   · `alert()` IS WHERE A SENTENCE GOES TO DIE — the store's refusals name the
 *     next move, and a box the user dismisses takes the instruction with it.
 *
 * ── NOTHING HERE DECIDES ANYTHING ────────────────────────────────────────────
 * These are shells. Every rule about what a lane may be called, whether it can
 * be retired, and what happens to its rows stays in the store, which already
 * answers with a sentence. A dialog that pre-judged a refusal would be a second
 * copy of that rule, and the two would drift.
 */
import { useState, type ReactNode } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldGroup, FieldRow, RowInput } from "@/components/spool/field-group";

export type LaneFormValues = { label: string; window: string };

/**
 * Create, rename or split a lane — one form, three uses.
 *
 * BOTH FIELDS AT ONCE, which is the whole reason this replaces `prompt()`. A
 * lane is a label AND a coarse window, and asking sequentially meant the second
 * question arrived after the first was already unrecoverable: cancel it and the
 * label was gone with no lane to show for it.
 *
 * THE WINDOW IS OPTIONAL ON A RENAME, because renaming is not re-describing.
 */
export function LaneFormDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  initial,
  withWindow = true,
  busy,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  initial?: Partial<LaneFormValues>;
  withWindow?: boolean;
  busy?: boolean;
  /** The STORE's sentence, rendered in place. Never invented here. */
  error?: string | null;
  onSubmit: (values: LaneFormValues) => void;
}) {
  /**
   * THE FORM MOUNTS FRESH EACH TIME IT OPENS, which is why there is no effect
   * resetting it. The first version restored the initial values inside a
   * `useEffect`, which is a cascading render and a lint error besides — and the
   * honest fix was not to silence it but to notice that "state that resets when
   * the dialog opens" IS a component whose lifetime is the dialog's.
   *
   * The `key` is what guarantees it: reopening produces a new instance rather
   * than a stale one carrying whatever the last edit left behind.
   */
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader className="gap-1">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription className="text-xs">{description}</DialogDescription>}
        </DialogHeader>
        {open && (
          <LaneForm
            key={`${initial?.label ?? ""}:${initial?.window ?? ""}`}
            initial={initial}
            withWindow={withWindow}
            confirmLabel={confirmLabel}
            {...(busy === undefined ? {} : { busy })}
            {...(error === undefined ? {} : { error })}
            onSubmit={onSubmit}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function LaneForm({
  initial,
  withWindow,
  confirmLabel,
  busy,
  error,
  onSubmit,
}: {
  initial?: Partial<LaneFormValues>;
  withWindow: boolean;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (values: LaneFormValues) => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [window, setWindow] = useState(initial?.window ?? "");

  const ready = label.trim().length > 0 && (!withWindow || window.trim().length > 0);

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) onSubmit({ label: label.trim(), window: window.trim() });
      }}
    >
      <FieldGroup>
        <FieldRow label="Label" htmlFor="lane-label">
          <RowInput id="lane-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Weekend" autoFocus />
        </FieldRow>
        {withWindow && (
          // COARSE AND SHIFTING, never a schedule — the module has no clock,
          // and the hint has to teach that rather than invite a time.
          <FieldRow
            label="When it happens"
            htmlFor="lane-window"
            hint="Coarse and in your own words — “evenings”, “work hours”, “whenever”. Never a schedule."
          >
            <RowInput id="lane-window" value={window} onChange={(event) => setWindow(event.target.value)} placeholder="evenings" />
          </FieldRow>
        )}
      </FieldGroup>

      {error && <p className="px-1 text-xs break-words text-muted-foreground">{error}</p>}

      <DialogFooter className="-mx-4 -mb-4 border-t-0 bg-transparent p-0 pt-1">
        <DialogClose render={<Button type="button" variant="ghost" size="sm" />}>Cancel</DialogClose>
        <Button type="submit" size="sm" disabled={!ready || busy}>
          {busy && <Loader2Icon className="animate-spin" />}
          {confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Ask before doing something the user cannot undo by pressing the same button
 * again.
 *
 * IT SAYS WHAT WILL HAPPEN, WHICH `confirm()` HAD NO ROOM FOR. "Promote this
 * sub-task?" is not a question anyone can answer well; "it becomes an item of
 * its own and leaves this one" is. The module has no delete path, so none of
 * these is destructive — and the copy is what stops them reading as though they
 * were.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  busy,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Compact card, not ceremony — shrinks to content, title small and
          quiet. The body copy is unchanged (it is §-law: what the action
          DOES, which `confirm()` never had room to say) but sits quietly
          under the title rather than as a full paragraph. */}
      <DialogContent className="sm:max-w-xs">
        <DialogHeader className="gap-1">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-xs">{body}</DialogDescription>
        </DialogHeader>
        {error && <p className="px-1 text-xs break-words text-muted-foreground">{error}</p>}
        <DialogFooter className="-mx-4 -mb-4 border-t-0 bg-transparent p-0 pt-1">
          <DialogClose render={<Button type="button" variant="ghost" size="sm" />}>Cancel</DialogClose>
          <Button type="button" size="sm" disabled={busy} onClick={onConfirm}>
            {busy && <Loader2Icon className="animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
