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
import type { ModelChoice } from "@/lib/models";
import { InputGroup, InputGroupAddon, InputGroupButton } from "@/components/ui/input-group";
export { RUNTIME_MODE_HELP, RUNTIME_MODE_LABELS } from "./composer-controls";
import { Spinner } from "@/components/ui/spinner";
import {
  AccessControl,
  AgentControl,
  BackgroundPresence,
  ComposerOverflowMenu,
  ContextPill,
  ControlDivider,
  ReasoningControl,
  useComposerCommandChoices,
} from "./composer-controls";
import { ComposerEditor, type ComposerEditorHandle } from "./composer-editor";
import { ComposerMenu } from "./composer-menu";
import { availableCommands, buildPathIndex, rankCommands, rankPaths, type Completion, type PathEntry } from "@/lib/composer-completions";
import { detectComposerTrigger, type ComposerTrigger } from "@/lib/composer-tokens";
import { readReferenceDrag, REFERENCE_MIME } from "@/lib/drag-reference";
import { createEngineApi } from "@/lib/engine/client";
import { FreshGreeting } from "./session/fresh-greeting";
import { WorkspaceEnvironment } from "./workspace-environment";
import { cn } from "@/lib/utils";

/** How long a first Escape stays armed. */
const ESC_ARM_WINDOW_MS = 3_000;

const api = createEngineApi();

/** The contract's own ceiling (`TurnSubmission.attachments`). Enforced here so
 *  the seventeenth file is refused at the point of picking rather than at the
 *  end of a submit that also uploaded the first sixteen. */
const MAX_ATTACHMENTS = 16;

export type QueuedMessage = { runId: string; text: string };

/**
 * ONE VALUE FOR EVERY PROVIDER KNOB, and one place that derives it.
 *
 * The session's own record wins once it exists; before that, the pending choice
 * the first message will be created with. Module scope because the slash menu
 * needs the same answer as the pills do, and two derivations of "which model is
 * about to run" is exactly how the two came to disagree last time.
 */
function modelChoiceOf(session: Session | undefined, pending: ModelChoice | undefined): ModelChoice {
  const stored = session?.model ?? pending;
  return {
    ...(stored?.model ? { model: stored.model } : {}),
    ...(stored?.effort ? { effort: stored.effort } : {}),
    ...(stored?.fastMode === undefined ? {} : { fastMode: stored.fastMode }),
  };
}

function activeDriverOf(session: Session | undefined, driver: ProviderDriverKind | undefined): ProviderDriverKind {
  return session?.driver ?? driver ?? "claude";
}

function placeholderFor(ready: boolean, busy: boolean, placeholder?: string): string {
  if (!ready) return "Waiting for the engine-owned session…";
  // The ONLY place the cockpit mentions that queueing exists.
  if (busy) return "Enter queues a message…";
  // A CALLER MAY NAME ITS OWN. The default offers to "explore the project",
  // which the Spool's front door does not have one of.
  return placeholder ?? "Ask for changes, explore the project, or continue this conversation…";
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
  greeting,
  usage,
  backgroundTasks,
  onDraftChange,
  onSubmit,
  onStop,
  onWithdraw,
  onRecall,
  onRuntimeMode,
  placeholder,
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
  /** The provider knobs the first message will create the session with, while
   *  fresh. Same shape as `session.model` minus the instance, which the engine
   *  stamps. */
  pendingModel?: ModelChoice;
  /** A turn is running or claimed. NOT a reason to disable anything. */
  busy: boolean;
  sending: boolean;
  queued: QueuedMessage[];
  runtimeMode?: RuntimeMode;
  session?: Session;
  /**
   * ABSENT MEANS THIS CONVERSATION HAS NO PROJECT, and that is a positive
   * statement rather than a missing value — see `Session.projectId`'s own note.
   * The Spool's master chat is the one that has none: it answers ACROSS
   * projects, so a project here would scope it to the single thing it must not
   * be.
   *
   * THREE OF THIS COMPONENT'S FOUR USES OF IT ARE THINGS A PROJECT-LESS CHAT
   * DOES NOT WANT — the git environment strip, the project greeting, and
   * `@`-completion reading a repository's files. So "make it optional" is not a
   * widening of behaviour; it is three renders that stop happening, each guarded
   * where it stands.
   */
  projectId?: string;
  projectName?: string;
  /** Which greeting the canvas opens on, chosen by the page. */
  greeting?: number;
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
  /** Change what the NEXT turn runs with. Absent makes every picker read-only.
   *  Takes the WHOLE choice, never a fragment. */
  /** What the input invites. The default offers to "explore the project",
   *  which is wrong on the Spool's front door — it has no project. */
  placeholder?: string;
  onModelChange?: (next: ModelChoice) => void;
  /** Opens the right panel on the file-changes surface. */
  onOpenChanges?: () => void;
}) {
  const [armedRaw, setEscArmed] = useState(false);
  /** Which queued line the composer is currently editing, if any. */
  const [recalled, setRecalled] = useState<number>();
  const armedAt = useRef<number>(0);
  const editor = useRef<ComposerEditorHandle>(null);
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

  /* ---------------------------------------------------------------- *
   * COMPLETIONS — `@` for a path, `/` for one of this box's controls.
   * ---------------------------------------------------------------- */

  /** What the caret is in the middle of, recomputed on every edit and every
   *  caret move. Null means no menu, which is the usual state. */
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [active, setActive] = useState(0);
  /**
   * Escape closes the menu WITHOUT clearing the trigger, because the `@word` is
   * still being typed and the user just does not want the list. Re-armed by the
   * next edit, so dismissing is a gesture rather than a mode.
   */
  const [dismissed, setDismissed] = useState(false);
  /**
   * KEYED BY THE CHECKOUT IT WAS READ FROM, rather than cleared by an effect
   * when the session changes. A cache that carries its own provenance cannot
   * serve one session's paths to another even for the one render between the
   * change and the effect that would have cleared it.
   */
  const [pathCache, setPathCache] = useState<{ checkout: string; entries: PathEntry[] }>();
  const [reading, setReading] = useState(false);

  const sessionId = session?.id;
  /**
   * The cache key for `@`-completions. `none` is the project-less case: there is
   * no checkout to list, so the index stays empty and the key is still stable —
   * a cache keyed on `undefined` would collide with a real one.
   */
  const checkout = sessionId ?? (projectId ? `project:${projectId}` : "none");
  const paths = pathCache?.checkout === checkout ? pathCache.entries : undefined;
  const commandChoices = useComposerCommandChoices(activeDriverOf(session, driver), modelChoiceOf(session, pendingModel));

  /**
   * READ ONCE, ON THE FIRST `@`, AND NEVER ON MOUNT.
   *
   * The listing is a git call in the engine, and most messages contain no
   * mention at all — fetching it when the composer appears would spend that on
   * every session opened. The session's own checkout wins over the project's:
   * a worktree session is where the paths the agent can read actually are.
   */
  useEffect(() => {
    if (trigger?.kind !== "path" || paths || reading) return;
    // Deferred to a task, like every other read in this app the server could
    // not have performed — and it is what keeps the state writes below out of
    // the effect body, where they would cascade a render.
    const task = window.setTimeout(() => {
      setReading(true);
      void (async () => {
        try {
          // A PROJECT-LESS CHAT HAS NO CHECKOUT TO LIST, so `@` completes
          // nothing rather than reaching for a repository it does not have.
          // Cached as empty like any other unlistable checkout, so it is asked
          // once and not on every keystroke.
          const listed =
            sessionId ? await api.sessionFiles(sessionId) : projectId ? await api.projectFiles(projectId) : undefined;
          setPathCache({ checkout, entries: listed ? buildPathIndex(listed.listing.files) : [] });
        } catch {
          // An empty index reads as "no matching files", which is the honest
          // answer when the checkout could not be listed. A different session
          // has a different key, so it tries again rather than inheriting this.
          setPathCache({ checkout, entries: [] });
        } finally {
          setReading(false);
        }
      })();
    }, 0);
    return () => window.clearTimeout(task);
  }, [trigger?.kind, paths, reading, checkout, sessionId, projectId]);

  const completions = useMemo<Completion[]>(() => {
    if (!trigger || dismissed) return [];
    if (trigger.kind === "path") return rankPaths(paths ?? [], trigger.query);
    return rankCommands(
      availableCommands({
        busy,
        fresh,
        ...(runtimeMode ? { runtimeMode } : {}),
        ...(driver ? { driver } : {}),
        ...(envMode ? { envMode } : {}),
        models: commandChoices.models,
        efforts: commandChoices.efforts,
      }),
      trigger.query,
    );
  }, [trigger, dismissed, paths, busy, fresh, runtimeMode, driver, envMode, commandChoices]);

  const menuOpen = trigger !== null && !dismissed && (completions.length > 0 || (trigger.kind === "path" && reading));

  /** Recompute the trigger from the live caret. Called after every edit and
   *  every caret move, because moving out of a `@word` must close the menu. */
  const retrigger = useCallback((text: string) => {
    const caret = editor.current?.caret() ?? text.length;
    setTrigger(detectComposerTrigger(text, caret));
  }, []);

  const apply = useCallback(
    (completion: Completion) => {
      const range = trigger;
      setTrigger(null);
      setDismissed(false);
      setActive(0);
      const action = completion.action;
      if (action.type === "insert") {
        if (range) editor.current?.replaceRange(range.rangeStart, range.rangeEnd, `${action.text} `);
        return;
      }
      /**
       * A COMMAND EATS ITS OWN TRIGGER AND NOTHING ELSE. `/full-access` is not
       * part of the message — it is a control being pressed with the keyboard —
       * so the slash and what follows it are removed and the rest of the draft
       * is left exactly as it was.
       */
      if (range) editor.current?.replaceRange(range.rangeStart, range.rangeEnd, "");
      if (action.type === "runtime-mode") onRuntimeMode(action.mode);
      if (action.type === "env-mode") onEnvMode?.(action.mode);
      if (action.type === "driver") onDriverChange?.(action.driver);
      if (action.type === "model") onModelChange?.({ ...modelChoiceOf(session, pendingModel), model: action.model });
      if (action.type === "effort") onModelChange?.({ ...modelChoiceOf(session, pendingModel), effort: action.effort });
      if (action.type === "stop") onStop();
    },
    [trigger, onRuntimeMode, onEnvMode, onDriverChange, onModelChange, onStop, session, pendingModel],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // IME composition: Enter is committing a candidate, not sending.
      if (event.nativeEvent.isComposing) return;
      /**
       * THE MENU GETS THE KEYS FIRST, and only while it is open. Enter picks the
       * highlighted row instead of sending, which is the behaviour every editor
       * with a completion list has and the reason none of them need a modifier
       * for it.
       */
      if (menuOpen && completions.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActive((index) => (index + 1) % completions.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActive((index) => (index - 1 + completions.length) % completions.length);
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const picked = completions[Math.min(active, completions.length - 1)];
          if (picked) apply(picked);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setDismissed(true);
          return;
        }
      }
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
    [draft, ready, busy, escArmed, queued, recalled, onRecall, onDraftChange, onSubmit, onStop, menuOpen, completions, active, apply],
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
   * moment the cursor moves from the editor onto the toolbar inside it.
   *
   * A DROPPED REFERENCE ARRIVES AS A CHIP, because the editor draws every
   * reference in the draft as one — the drop inserts the same text it always
   * did, and the repaint that follows is what turns it into an object. Which is
   * the whole reason the two gestures share `drag-reference.ts`: dragging
   * `apps/engine/src/driver.ts` out of the Files panel and typing `@driver`
   * produce the same six characters on the wire and the same chip on screen.
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
    // The editor owns the caret and the spacing; a drop only says what to add.
    editor.current?.insertAtCaret(plain);
  };

  const dragging = (event: React.DragEvent) =>
    event.dataTransfer.types.includes(REFERENCE_MIME) ||
    event.dataTransfer.types.includes("Files") ||
    event.dataTransfer.types.includes("text/uri-list");

  const submitLabel = escArmed ? "Press Escape again to stop" : busy ? "Stop" : "Send";
  /**
   * ONE VALUE FOR EVERY PROVIDER KNOB, passed whole to every control.
   *
   * Each control used to receive the fields it cared about and send back only
   * those, so picking an effort cleared the model and picking a model cleared
   * the effort. Handing the whole choice down and taking the whole choice back
   * makes that loss unrepresentable — see `ModelChoice`.
   */
  const activeDriver = activeDriverOf(session, driver);
  const choice = modelChoiceOf(session, pendingModel);

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
      {/* THE GREETING RIDES THE COMPOSER'S OWN TRANSFORM, which is why it lives
          inside this wrapper rather than in the conversation above: when the
          first message sends, the whole object slides down together instead of
          the sentence jumping out from under a composer that is still moving.
          It is mounted only while fresh, so an ordinary session never pays for
          the height. */}
      {/* The greeting offers to start work IN A PROJECT, so a project-less chat
          has nothing for it to offer. Omitted rather than blanked. */}
      {fresh && projectId && (
        <FreshGreeting projectId={projectId} {...(projectName ? { projectName } : {})} {...(greeting === undefined ? {} : { index: greeting })} />
      )}

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

      {/* ONE BLOCK, form plus foot. The outer wrapper is a flex column with a
          gap, and the foot's whole fuse (workspace-environment.tsx's `-mt-px`,
          `border-t-0`) is defeated by any gap between it and the form — the
          tray read as a second card floating below. Grouping them makes the
          gap apply around the pair, never inside it. */}
      <div>
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
        {/* RELATIVE, so the completion menu can hang off the box's top edge
            rather than off the whole composer column — the queued strip and the
            greeting live in that column and would push the menu around. */}
        <div className="relative">
        {menuOpen && trigger && (
          <ComposerMenu
            completions={completions}
            active={Math.min(active, Math.max(0, completions.length - 1))}
            heading={trigger.kind === "path" ? "Files and folders" : "Commands"}
            {...(trigger.kind === "path" && reading ? { loading: true } : {})}
            emptyText={trigger.kind === "path" ? "No matching files or folders." : "No matching command."}
            onActive={setActive}
            onPick={apply}
          />
        )}
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
          <label className="sr-only" htmlFor="turn-prompt">
            Message
          </label>
          <ComposerEditor
            ref={editor}
            id="turn-prompt"
            value={draft}
            placeholder={placeholderFor(ready, busy, placeholder)}
            // NOT disabled while busy. That is the whole point.
            disabled={!ready}
            onChange={(text) => {
              onDraftChange(text);
              // Synchronous, and BEFORE the state round-trip: `retrigger` reads
              // the caret out of the live DOM, so it has to run while the DOM
              // and the text it is being asked about are the same edit.
              retrigger(text);
              setActive(0);
              setDismissed(false);
            }}
            onSelectionChange={() => retrigger(draft)}
            onKeyDown={onKeyDown}
            onPasteFiles={addFiles}
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
          <InputGroupAddon align="block-end" className="min-h-10 flex-wrap justify-between gap-1 border-t border-border/40 px-2 pt-1 pb-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
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
                    driver={activeDriver}
                    choice={choice}
                    {...(onModelChange ? { onChange: onModelChange } : {})}
                    {...(onDriverChange ? { onDriverChange } : {})}
                  />
                  {/* Hairlines rather than borders: three bordered chips read
                      as chrome bolted to the composer, where the reference draws
                      the same three as labels with a rule between them. */}
                  <div className="hidden items-center gap-1 @2xl/composer:flex">
                    <ControlDivider />
                    <ReasoningControl driver={activeDriver} choice={choice} {...(onModelChange ? { onChange: onModelChange } : {})} />
                    {runtimeMode && (
                      <>
                        <ControlDivider />
                        <AccessControl runtimeMode={runtimeMode} onRuntimeMode={onRuntimeMode} />
                      </>
                    )}
                  </div>
                  {/* The overflow carries EVERYTHING the pills carry, plus the
                      two create-time choices that live on other surfaces when
                      there is room. A narrow window must not be the reason a
                      setting is unreachable. */}
                  <div className="@2xl/composer:hidden">
                    <ComposerOverflowMenu
                      driver={activeDriver}
                      choice={choice}
                      fresh={fresh}
                      {...(runtimeMode ? { runtimeMode } : {})}
                      {...(envMode ? { envMode } : {})}
                      {...(onModelChange ? { onChange: onModelChange } : {})}
                      {...(runtimeMode ? { onRuntimeMode } : {})}
                      {...(onDriverChange ? { onDriverChange } : {})}
                      {...(onEnvMode ? { onEnvMode } : {})}
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
        </div>
      </form>

      {/* The composer's foot: where this message lands. Outside the form and
          fused to its bottom edge — see workspace-environment.tsx.

          A PROJECT-LESS CHAT HAS NO FOOT. This strip names a branch, a checkout
          and a worktree choice, and every one of those is a property of a
          repository. Rendering it empty would be a row of blanks claiming the
          conversation lands somewhere; rendering it at all would be the widening
          this component was careful not to do. */}
      {projectId && (
      <WorkspaceEnvironment
        projectId={projectId}
        {...(projectName ? { projectName } : {})}
        {...(session ? { session } : {})}
        {...(envMode ? { envMode } : {})}
        {...(onEnvMode ? { onEnvMode } : {})}
        {...(onOpenChanges ? { onOpenChanges } : {})}
      />
      )}
      </div>
    </div>
  );
}
