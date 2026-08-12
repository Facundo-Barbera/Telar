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
import { CornerDownLeftIcon, ImageIcon, MonitorIcon, PencilIcon, PlusIcon, SquareIcon, XIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ProviderDriverKind, RuntimeMode, Session, UsageSnapshot } from "@telar/engine-client";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
export { RUNTIME_MODE_HELP, RUNTIME_MODE_LABELS } from "./composer-controls";
import { Spinner } from "@/components/ui/spinner";
import { AccessControl, AgentControl, BackgroundPresence, ComposerOverflowMenu, ContextPill, ReasoningControl } from "./composer-controls";
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

/** One waiting message. Ported from the donor's QueueChip — the numbered badge
 *  appears only when there is more than one, because "1." above a single line is
 *  a list marker for a list nobody is reading. */
/**
 * The donor's add-context menu, with its two items present but inert.
 *
 * THE TRIGGER IS NOT `disabled`, deliberately. `InputGroup` carries
 * `has-disabled:opacity-50`, so a permanently-disabled child inside the box
 * greys the whole composer for the life of the session — which is exactly what
 * it did. The menu's items carry the disabled state instead: they render in a
 * portal, outside the group, so they can say "not yet" without dimming
 * everything around them.
 */
function AddContextMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Add context"
            title="Add photos, files, or a screenshot"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          />
        }
      >
        <PlusIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem disabled>
          <ImageIcon />
          Add photos or files
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <MonitorIcon />
          Take screenshot
        </DropdownMenuItem>
        <p className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
          Attachments need a contract on the turn submission before this can send anything — the engine does not model them yet.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function QueueChip({
  item,
  index,
  onWithdraw,
  onRecall,
}: {
  item: QueuedMessage;
  index?: number;
  onWithdraw: (runId: string) => void;
  onRecall?: (item: QueuedMessage) => void;
}) {
  return (
    <div className="group rounded-lg bg-background/80 px-2 py-1.5 ring-1 ring-border">
      <div className="flex items-center gap-2">
        {index !== undefined && (
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-medium text-primary">
            {index}
          </span>
        )}
        {/* THE TEXT ITSELF IS THE EDIT TARGET, as in the donor. A queued line is
            a sentence you wrote thirty seconds ago and can still improve;
            clicking it pulls it back into the box rather than making you
            withdraw and retype. */}
        {onRecall ? (
          <button
            type="button"
            onClick={() => onRecall(item)}
            title="Click to edit"
            className="min-w-0 flex-1 truncate text-left text-sm text-foreground"
          >
            {item.text}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-left text-sm text-foreground" title={item.text}>
            {item.text}
          </span>
        )}
        {onRecall && (
          <button
            type="button"
            aria-label="Edit this queued message"
            onClick={() => onRecall(item)}
            className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
          >
            <PencilIcon className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          aria-label="Remove this queued message"
          onClick={() => onWithdraw(item.runId)}
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

export function Composer({
  draft,
  ready,
  fresh = false,
  driver,
  onDriverChange,
  pendingModel,
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
  onRecall,
  onRuntimeMode,
  onModelChange,
  onOpenChanges,
}: {
  draft: string;
  ready: boolean;
  /** No session exists yet: the composer is the whole screen, and the pills
   *  choose what the first message will CREATE rather than patching a record. */
  fresh?: boolean;
  driver?: ProviderDriverKind;
  onDriverChange?: (driver: ProviderDriverKind) => void;
  /** The model the first message will create the session with, while fresh. */
  pendingModel?: { model?: string; effort?: string };
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
  /** Pull a queued message back into the box to re-edit it. Withdrawing it
   *  is the caller's job — the composer only asks for the text. */
  onRecall?: (item: QueuedMessage) => void;
  onRuntimeMode: (mode: RuntimeMode) => void;
  /** Change which model runs the NEXT turn. Absent makes the picker read-only. */
  onModelChange?: (next: { model?: string; effort?: string }) => void;
  /** Opens the right panel on the file-changes surface. */
  onOpenChanges?: () => void;
}) {
  const [armedRaw, setEscArmed] = useState(false);
  /** Which queued line the composer is currently editing, if any. */
  const [recalled, setRecalled] = useState<number>();
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
      /**
       * ARROW-UP ON AN EMPTY BOX WALKS BACK THROUGH WHAT IS STILL WAITING.
       *
       * Queueing makes it easy to fire off a line and immediately think of a
       * better way to say it. Without this the only recovery is to withdraw the
       * chip and retype it from memory. Gated on an EMPTY composer so it can
       * never eat a cursor movement inside text you are editing.
       */
      if (event.key === "ArrowUp" && !draft && queued.length > 0 && onRecall) {
        event.preventDefault();
        const index = recalled === undefined ? queued.length - 1 : Math.max(0, recalled - 1);
        const item = queued[index];
        if (item) {
          setRecalled(index);
          onRecall(item);
        }
        return;
      }
      // Escape abandons a recall without sending it, putting the line back.
      if (event.key === "Escape" && recalled !== undefined) {
        event.preventDefault();
        setRecalled(undefined);
        onDraftChange("");
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
    [draft, ready, busy, escArmed, queued, recalled, onRecall, onDraftChange, onSubmit, onStop],
  );

  const submitLabel = escArmed ? "Press Escape again to stop" : busy ? "Stop" : "Send";
  // The session's own record wins once it exists; before that, the pending
  // choice the first message will be created with.
  const model = session?.model?.model ?? pendingModel?.model;
  const effort = session?.model?.effort ?? pendingModel?.effort;

  return (
    /**
     * `fresh` LIFTS THE COMPOSER TO THE MIDDLE OF THE SCREEN, by transform
     * rather than by rendering somewhere else. It is the same mounted element
     * either way, so sending the first message animates it down into its normal
     * place instead of unmounting a "new conversation" screen and mounting a
     * transcript — which would blur focus, drop the caret, and lose an
     * in-flight keystroke. Ported from the donor's `freshWorkspace` translate.
     */
    <div
      className={cn(
        // NAMED, because the control row asks about THIS element's width and a
        // bare `@container` would answer for whichever ancestor is nearest.
        "@container/composer relative mx-auto flex w-full max-w-[50rem] shrink-0 flex-col gap-1.5 px-4 pt-2 pb-5",
        "transition-transform duration-500 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none",
        fresh && "-translate-y-[calc(45dvh-7.5rem)]",
      )}
    >
      {queued.length > 0 && (
        <div className="mb-2 space-y-1.5 rounded-xl border border-primary/25 bg-primary/[0.04] p-2" aria-label="Queued messages">
          {queued.length > 1 && (
            <div className="flex items-center justify-between px-1.5 pt-0.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{queued.length} waiting</span>
            </div>
          )}
          {queued.map((item, index) => (
            <QueueChip
              key={item.runId}
              item={item}
              {...(queued.length > 1 ? { index: index + 1 } : {})}
              onWithdraw={onWithdraw}
              {...(onRecall ? { onRecall } : {})}
            />
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
              <AddContextMenu />
              {/**
               * THE PILLS ARE THE DEFAULT; `···` IS WHAT HAPPENS WHEN THEY DO
               * NOT FIT.
               *
               * Both are mounted and CSS picks, on `@2xl` (42rem) of the
               * COMPOSER'S OWN container rather than the viewport — the whole
               * problem is that the window can be wide while this column is
               * narrow, because the right panel took the difference. A viewport
               * query cannot see that; a container query is measuring the thing
               * that actually ran out of room.
               *
               * 42rem is where the row stops fitting: ~570px of controls plus
               * the box's padding. Above it you read the model, the effort and
               * the access mode without opening anything, which is the point —
               * a menu that is always closed is state you cannot see.
               */}
              {(session || (fresh && driver)) && (
                <>
                  <AgentControl
                    driver={session?.driver ?? driver!}
                    {...(model ? { model } : {})}
                    {...(effort ? { effort } : {})}
                    {...(onModelChange ? { onModelChange } : {})}
                    {...(onDriverChange ? { onDriverChange } : {})}
                  />
                  <div className="hidden items-center gap-1.5 @2xl/composer:flex">
                    <ReasoningControl
                      driver={session?.driver ?? driver!}
                      {...(model ? { model } : {})}
                      {...(effort ? { effort } : {})}
                      {...(onModelChange ? { onModelChange } : {})}
                    />
                    {runtimeMode && <AccessControl runtimeMode={runtimeMode} onRuntimeMode={onRuntimeMode} />}
                  </div>
                  <div className="@2xl/composer:hidden">
                    <ComposerOverflowMenu
                      driver={session?.driver ?? driver!}
                      {...(model ? { model } : {})}
                      {...(effort ? { effort } : {})}
                      {...(runtimeMode ? { runtimeMode } : {})}
                      {...(onModelChange ? { onModelChange } : {})}
                      {...(runtimeMode ? { onRuntimeMode } : {})}
                    />
                  </div>
                </>
              )}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5 self-end">
            <ContextPill {...(usage ? { usage } : {})} {...(session ? { driver: session.driver } : {})} />
            {/* NOT DISABLED ON AN EMPTY DRAFT, and that is a fix rather than an
                oversight: `InputGroup` carries `has-disabled:opacity-50`, so a
                disabled descendant greys the ENTIRE composer — box, pills,
                placeholder and all. With the send button disabled whenever the
                box was empty, the composer spent most of its life looking
                broken. The donor never disables it either; submitting an empty
                draft is simply a no-op. */}
            <InputGroupButton
              type={busy ? "button" : "submit"}
              variant="default"
              size="icon-sm"
              aria-label={submitLabel}
              onClick={busy ? onStop : undefined}
              className={cn(
                escArmed && "bg-destructive text-background hover:bg-destructive",
                !busy && !draft.trim() && "opacity-60",
              )}
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
      <WorkspaceEnvironment
        projectId={projectId}
        {...(projectName ? { projectName } : {})}
        {...(session ? { session } : {})}
        {...(onOpenChanges ? { onOpenChanges } : {})}
      />
    </div>
  );
}
