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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeftIcon, ImageIcon, MonitorIcon, PaperclipIcon, PencilIcon, PlusIcon, SquareIcon, XIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ProviderDriverKind, RuntimeMode, Session, UsageSnapshot } from "@telar/engine-client";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
export { RUNTIME_MODE_HELP, RUNTIME_MODE_LABELS } from "./composer-controls";
import { Spinner } from "@/components/ui/spinner";
import { AccessControl, AgentControl, BackgroundPresence, ComposerOverflowMenu, ContextPill, ReasoningControl } from "./composer-controls";
import { insertReference, readReferenceDrag, REFERENCE_MIME } from "@/lib/drag-reference";
import { WorkspaceEnvironment } from "./workspace-environment";
import { cn } from "@/lib/utils";

/** How long a first Escape stays armed. */
const ESC_ARM_WINDOW_MS = 3_000;

/** The contract's own ceiling (`TurnSubmission.attachments`). Enforced here so
 *  the seventeenth file is refused at the point of picking rather than at the
 *  end of a submit that also uploaded the first sixteen. */
const MAX_ATTACHMENTS = 16;

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
 * The donor's add-context menu, now attached to a real file picker.
 *
 * THE TRIGGER IS NOT `disabled`, deliberately. `InputGroup` carries
 * `has-disabled:opacity-50`, so a permanently-disabled child inside the box
 * greys the whole composer for the life of the session. Any item that cannot
 * act carries the disabled state itself: items render in a portal, outside the
 * group, so they can say "not yet" without dimming everything around them.
 */
function AddContextMenu({ onPick }: { onPick: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      {/* Outside the menu, because the menu unmounts its content on select and
          an input that unmounts mid-dialog never fires its change event. */}
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          onPick([...(event.target.files ?? [])]);
          // Cleared so picking the SAME file twice in a row still fires.
          event.target.value = "";
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Add context"
              title="Attach photos or files"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            />
          }
        >
          <PlusIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuItem onClick={() => input.current?.click()}>
            <ImageIcon />
            Add photos or files
          </DropdownMenuItem>
          {/* Still inert, and now the only one: the cockpit runs in a browser
              tab and cannot photograph a screen it is not allowed to read.
              Capturing the AGENT's browser is the right panel's job. */}
          <DropdownMenuItem disabled>
            <MonitorIcon />
            Take screenshot
          </DropdownMenuItem>
          <p className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
            Images are shown to the model directly. Anything else is written beside the session and named by path, so the agent can open it.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/** Bytes, at the coarseness a human reads a file size at. */
function fileSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * One picked file, before it is sent.
 *
 * IMAGES SHOW THEMSELVES. A filename is a poor answer to "which screenshot did
 * I attach", and the file is already in memory — `createObjectURL` costs a
 * handle rather than a round trip. The URL is revoked on unmount because a leak
 * here holds the whole file.
 */
function AttachmentChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  /**
   * MADE DURING RENDER, RELEASED ON UNMOUNT.
   *
   * The obvious shape — create it in an effect and `setState` — paints one
   * frame with no thumbnail and trips `react-hooks/set-state-in-effect`. A
   * `useMemo` has the URL ready on the first paint; the effect beside it exists
   * only to revoke, because an object URL holds the entire file until it is.
   */
  const preview = useMemo(() => (file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined), [file]);
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  return (
    <span className="group/chip relative flex items-center gap-2 rounded-lg border border-border bg-background/80 py-1 pl-1 pr-2">
      <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element -- a blob URL for a file the user just picked; next/image cannot optimise it
          <img src={preview} alt="" className="size-full object-cover" />
        ) : (
          <PaperclipIcon className="size-3.5 text-muted-foreground" />
        )}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="max-w-40 truncate text-[11px] font-medium leading-tight">{file.name}</span>
        <span className="text-[10px] leading-tight text-muted-foreground">{fileSize(file.size)}</span>
      </span>
      <button
        type="button"
        aria-label={`Remove ${file.name}`}
        onClick={onRemove}
        className="ml-0.5 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/chip:opacity-100 focus-visible:opacity-100"
      >
        <XIcon className="size-3.5" />
      </button>
    </span>
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
  attachments,
  onAttach,
  fresh = false,
  driver,
  onDriverChange,
  envMode,
  onEnvMode,
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
  /** Files picked but not yet sent. Owned by the cockpit because sending them
   *  is: they are uploaded as part of the same submit that creates the session. */
  attachments: File[];
  onAttach: (files: File[]) => void;
  /** No session exists yet: the composer is the whole screen, and the pills
   *  choose what the first message will CREATE rather than patching a record. */
  fresh?: boolean;
  driver?: ProviderDriverKind;
  onDriverChange?: (driver: ProviderDriverKind) => void;
  /** Where the FIRST message will land. Only meaningful while fresh — a
   *  worktree is cut when the session is created. */
  envMode?: "local" | "worktree";
  onEnvMode?: (mode: "local" | "worktree") => void;
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
  /** Read on drop, to splice a reference in at the caret rather than at the end. */
  const textarea = useRef<HTMLTextAreaElement>(null);
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

  /**
   * `onAttach` takes THE WHOLE NEW LIST, so removal is a filter and adding is a
   * concat. One prop with one meaning beats an add/remove pair that can
   * disagree about ordering.
   */
  const addFiles = (files: File[]) => onAttach([...attachments, ...files].slice(0, MAX_ATTACHMENTS));

  /**
   * DROPPING A THING FROM THE PANEL INTO THE MESSAGE.
   *
   * Three payloads land here and each means something different:
   *   - OUR OWN reference type — an issue, a file, a page, a sub-agent — which
   *     splices its text in at the caret.
   *   - FILES from the operating system, which become attachments. The same
   *     gesture people already expect from every other message box.
   *   - ANYTHING ELSE with plain text — a link dragged from a browser, a
   *     selection from an editor — which is inserted verbatim. Cheap, and it
   *     makes the box behave the way a box that accepts drops should.
   *
   * The DEPTH COUNTER is not fussiness: `dragenter`/`dragleave` fire for every
   * child element the pointer crosses, so a single boolean flickers off the
   * moment the cursor moves from the textarea onto the toolbar inside it.
   */
  const dragDepth = useRef(0);
  const [dropping, setDropping] = useState(false);

  const onDrop = (event: React.DragEvent) => {
    dragDepth.current = 0;
    setDropping(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
      return;
    }
    const reference = readReferenceDrag(event.dataTransfer);
    const text = reference?.text ?? event.dataTransfer.getData("text/uri-list") ?? "";
    const plain = text || event.dataTransfer.getData("text/plain");
    if (!plain) return;
    event.preventDefault();
    // The caret is read from the textarea rather than tracked in state: a
    // controlled `selectionStart` would have to be updated on every keystroke to
    // stay right, and this is the only place it is ever needed.
    const box = textarea.current;
    const caret = box && document.activeElement === box ? box.selectionStart : draft.length;
    const next = insertReference(draft, plain, caret);
    onDraftChange(next.draft);
    // After the paint that applies the new value, or the caret lands wherever
    // React's re-render leaves it — which is the end of the box.
    window.requestAnimationFrame(() => {
      box?.focus();
      box?.setSelectionRange(next.caret, next.caret);
    });
  };

  const dragging = (event: React.DragEvent) =>
    event.dataTransfer.types.includes(REFERENCE_MIME) ||
    event.dataTransfer.types.includes("Files") ||
    event.dataTransfer.types.includes("text/uri-list");

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
        <InputGroup
          onDragEnter={(event) => {
            if (!dragging(event)) return;
            dragDepth.current += 1;
            setDropping(true);
          }}
          onDragOver={(event) => {
            if (!dragging(event)) return;
            // Without BOTH the preventDefault and the explicit effect, the
            // browser refuses the drop and animates the item back to where it
            // came from — the failure that makes drag-and-drop feel broken
            // rather than absent.
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDropping(false);
          }}
          onDrop={onDrop}
          className={cn(
            "rounded-2xl border-border/80 bg-card/95 shadow-[0_18px_60px_-30px_rgba(0,0,0,.9)] backdrop-blur-xl",
            dropping && "border-ring ring-2 ring-ring/40",
          )}
        >
          <label className="sr-only" htmlFor="vnext-turn-prompt">
            Message
          </label>
          <InputGroupTextarea
            ref={textarea}
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
            /**
             * PASTE A SCREENSHOT AND IT ATTACHES. ⌘⇧4 then ⌘V is how anyone
             * actually shows an agent what they are looking at, and routing
             * that through a file dialog would be the slowest possible path
             * for the commonest case. Only intercepted when the clipboard
             * actually holds a file — pasting text stays paste.
             */
            onPaste={(event) => {
              const files = [...event.clipboardData.files];
              if (files.length === 0) return;
              event.preventDefault();
              addFiles(files);
            }}
          />
          {attachments.length > 0 && (
            <InputGroupAddon align="block-start" className="flex-wrap gap-1.5 px-2.5 pt-2.5">
              {attachments.map((file, index) => (
                <AttachmentChip
                  key={`${file.name}-${file.size}-${index}`}
                  file={file}
                  onRemove={() => onAttach(attachments.filter((_, at) => at !== index))}
                />
              ))}
            </InputGroupAddon>
          )}
          <InputGroupAddon align="block-end" className="min-h-11 flex-wrap justify-between gap-1 border-t border-border/40 px-2.5 pt-1.5 pb-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {/* Present but inert: attachments are a contract the engine does
                  not have yet. Disabled with the reason rather than absent, so
                  the row's shape is the one it will keep. */}
              <AddContextMenu onPick={addFiles} />
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
        {...(envMode ? { envMode } : {})}
        {...(onEnvMode ? { onEnvMode } : {})}
        {...(onOpenChanges ? { onOpenChanges } : {})}
      />
    </div>
  );
}
