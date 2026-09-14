"use client";

/**
 * The composer.
 *
 * Built on the shared InputGroup primitive rather than on a hand-styled form, so
 * the box you type into is the same object — same border token, same focus ring,
 * same radius — as every other field in Telar. The block-end addon is what puts
 * the toolbar INSIDE the box instead of under it.
 *
 * ENTER ALWAYS WORKS. While a turn is running the message goes INTO that turn
 * — the engine steers it, the way typing at a running Claude Code or Codex
 * does, and the way T3 Code's composer does — and the box clears exactly as if
 * it had sent. There is no queue strip: a message sent mid-turn appears in the
 * transcript inside the run it joined. The UI never says "wait".
 *
 * SEND BECOMES STOP. One control in the corner, `↵` → spinner → `■`, never
 * moving and never duplicating: the thing you press to go is the thing you press
 * to stop. Escape twice does the same from the keyboard, and the FIRST press
 * repaints that button with the literal word ESC — an arming state nobody can
 * see is indistinguishable from a keystroke that did nothing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleCheckIcon,
  CornerDownLeftIcon,
  EraserIcon,
  FoldVerticalIcon,
  ImageIcon,
  LayersIcon,
  MonitorIcon,
  PaperclipIcon,
  PlusIcon,
  SquareIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { EngineRequest, ProviderDriverKind, ProviderSkills, RuntimeMode, Session, UsageSnapshot } from "@telar/engine-client";
import {
  advance as advanceQuestion,
  buildAnswers,
  canAdvance,
  emptyQuestionDraft,
  isLastQuestion,
  questionFields,
  setCustomAnswer,
  type QuestionDraft,
} from "@/lib/question-drawer";
import { ComposerQuestionDrawer } from "./composer-question-drawer";
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
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { ComposerStashMenu } from "./composer-stash-menu";
import {
  availableCommands,
  buildPathIndex,
  compactBlockedReason,
  providerCommandCompletions,
  rankCommands,
  rankPaths,
  rankSkills,
  type Completion,
  type PathEntry,
} from "@/lib/composer-completions";
import { rankNotes, useProjectNotes } from "@/lib/project-notes";
import { detectComposerTrigger, type ComposerTrigger } from "@/lib/composer-tokens";
import { appendPrompt, mergeAttachments, splitImages, type StashEntry, type StashedImage } from "@/lib/prompt-stash";
import { encodeImagesForStash, filesFromStash } from "@/lib/stash-images";
import { usePromptStash } from "@/lib/use-prompt-stash";
import { useCommandHandlers } from "@/lib/use-command-keys";
import { readReferenceDrag, REFERENCE_MIME } from "@/lib/drag-reference";
import { fmtTokens } from "@/lib/format";
import { createEngineApi } from "@/lib/engine/client";
import { FreshGreeting } from "./session/fresh-greeting";
import { WorkspaceEnvironment } from "./workspace-environment";
import { cn } from "@/lib/utils";

/** How long a first Escape stays armed. */
const ESC_ARM_WINDOW_MS = 3_000;

const api = createEngineApi();

/** The contract's own ceiling (`TurnSubmission.attachments`). Enforced here so
 *  the seventeenth file is refused at the point of picking rather than at the
 *  end of a submit that also uploaded the first sixteen.
 *
 *  EXPORTED because attachments no longer arrive only through this box: the
 *  browser's camera (#474) hands one straight to the cockpit's list, and a
 *  second ceiling that disagreed with this one would be a limit enforced in
 *  two places and true in neither. */
export const MAX_ATTACHMENTS = 16;


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
  if (!ready) return "Waiting for the session…";
  // A message mid-turn reaches the running agent; say so.
  if (busy) return "Enter sends into the running turn…";
  // A CALLER MAY NAME ITS OWN. The default offers to "explore the project",
  // which the Spool's front door does not have one of.
  return placeholder ?? "Ask for changes, or explore the project…";
}

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
              title="Add context"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            />
          }
        >
          <PlusIcon className="size-4" />
        </DropdownMenuTrigger>
        {/* TWO ROWS, NO PARAGRAPH. The grey sentence under them explained where
            an attachment lands — an internal, told to somebody who has not yet
            attached anything, every time they open a two-item menu. The menu is
            verbs with icons, like every other menu in this cockpit. */}
        <DropdownMenuContent align="start" className="w-56">
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
/**
 * THE COMPOSER'S CHROME ANSWERS A RIGHT-CLICK; THE BOX YOU TYPE IN DOES NOT.
 *
 * A text box already has a menu, and it is the browser's: cut, copy, paste,
 * undo, spell-check, the dictionary, "Look Up", "Share". Replacing it with four
 * rows of ours would be taking away six useful things to add two, and taking
 * away the one menu on this screen a person did not have to learn.
 *
 * THE TRIGGER IS THE WHOLE CARD, AND IT IS A REAL BOX. It wrapped only the left
 * control cluster, so a right-press on the box, on the empty chrome beside the
 * `+`, or over on the send side reached nothing at all (#320) — the menu
 * answered on about a fifth of the object it belongs to. A `contents` wrapper
 * would have been the same bug in a different shape: it paints nothing and is
 * never an event target, which is the lesson the sidebar's own menu already
 * wrote down (#286).
 *
 * WHAT THE BOX KEEPS is the one gesture that is genuinely the editor's: a
 * right-press on TEXT YOU HAVE SELECTED, which is where cut/copy/look-up live.
 * With nothing selected there is no editing verb to preserve and the card's own
 * menu answers, so the box is no longer a dead zone — see the boundary around
 * `ComposerEditor`.
 *
 * The rows carry only what the composer can already do to itself: drop an
 * attachment, empty the box, put what is in it on the stash. Every item is the
 * callback its visible control (or its keyboard chord) already fires, and wears
 * that control's own glyph — the sidebar's menus read as one system, and a menu
 * with no icons beside them read as somebody else's.
 *
 * BOTH ARE DISABLED RATHER THAN HIDDEN when they would do nothing. An empty
 * box has nothing to clear and nothing to stash, and a menu whose rows appear
 * and disappear as you type is a menu you cannot learn the shape of.
 */
function ComposerChromeMenu({
  draft,
  attachments,
  stashing,
  onClear,
  onStash,
  onRemoveAttachment,
  className,
  children,
}: {
  draft: string;
  attachments: readonly File[];
  stashing: boolean;
  onClear: () => void;
  onStash: () => void;
  /** Present only on a chip: the one item that is about THIS attachment. */
  onRemoveAttachment?: () => void;
  /** The trigger's own box. Omitted on the card, where the plain `<div>` Base
   *  UI renders already has exactly the card's area; a chip passes nothing
   *  either. Never `contents` — a trigger with no box is a trigger with no hit
   *  area. */
  className?: string;
  children: React.ReactNode;
}) {
  // The same condition ⌘S uses to decide between stashing and opening the
  // list — one rule, so the key and the menu agree about what is stashable.
  const stashable = Boolean(draft.trim() || attachments.some((file) => file.type.startsWith("image/")));
  return (
    <ContextMenu>
      <ContextMenuTrigger {...(className ? { className } : {})}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-auto">
        {onRemoveAttachment && (
          <>
            {/* The chip's own × as a row — it takes the file off the message,
                it does not delete anything, and a bin would say it did. */}
            <ContextMenuItem onClick={onRemoveAttachment}>
              <XIcon />
              Remove attachment
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem disabled={!draft} onClick={onClear}>
          <EraserIcon />
          Clear draft
        </ContextMenuItem>
        {/* The stash badge's own glyph, so the row and the control it fires are
            visibly the same verb. */}
        <ContextMenuItem disabled={stashing || !stashable} onClick={onStash}>
          <LayersIcon />
          Stash draft
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

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
        <span className="max-w-40 truncate text-2xs font-medium leading-tight">{file.name}</span>
        <span className="text-3xs leading-tight text-muted-foreground">{fileSize(file.size)}</span>
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


/**
 * ONE CARD IN THE STACK OVER THE COMPOSER'S TOP EDGE — the question drawer's
 * grammar (`mx-3 -mb-1`, rounded top, no bottom border, bottom edge tucked
 * under whatever comes next), generalised so more than one can stack: each
 * card's bottom corners disappear under the card below it, and the last one's
 * under the composer itself. That is t3's banner stack — the settled notice
 * and the context notice read as sheets of paper behind the input, not as
 * rows of chrome above it.
 */
function ComposerBanner({
  icon,
  title,
  detail,
  action,
  actionLabel,
  onDismiss,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  action?: () => void;
  actionLabel?: string;
  onDismiss?: () => void;
}) {
  return (
    <div className="mx-3 -mb-1">
      <div className="flex items-center gap-2.5 rounded-t-xl border border-b-0 border-border/60 bg-muted/40 px-3 pb-3.5 pt-2 backdrop-blur-sm">
        {icon}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{title}</p>
          <p className="truncate text-2xs text-muted-foreground">{detail}</p>
        </div>
        {action && actionLabel && (
          <button
            type="button"
            onClick={action}
            className="shrink-0 rounded-md border border-border bg-background/80 px-2.5 py-1 text-2xs font-medium transition-colors hover:bg-accent"
          >
            {actionLabel}
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            aria-label="Dismiss"
            onClick={onDismiss}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
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
  pendingBase,
  onBase,
  pendingModel,
  busy,
  sending,
  runtimeMode,
  session,
  projectId,
  projectName,
  usage,
  backgroundTasks,
  settled,
  onUnsettle,
  onDraftChange,
  onSubmit,
  onStop,
  onStopBackground,
  onRuntimeMode,
  onResumeAfterRateLimit,
  placeholder,
  onModelChange,
  onOpenChanges,
  onCompact,
  compacting,
  question,
  onAnswerQuestion,
  onCancelQuestion,
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
  /** The base-ref picker's create-time choice — worktree only. */
  pendingBase?: { baseRef?: string; branchName?: string };
  onBase?: (next: { baseRef?: string; branchName?: string }) => void;
  /** The provider knobs the first message will create the session with, while
   *  fresh. Same shape as `session.model` minus the instance, which the engine
   *  stamps. */
  pendingModel?: ModelChoice;
  /** A turn is running or claimed. NOT a reason to disable anything. */
  busy: boolean;
  sending: boolean;
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
  /** The newest turn's usage — the context readout's only honest source. */
  usage?: UsageSnapshot;
  /** Work that outlives the turn that started it. */
  backgroundTasks: number;
  /** This conversation is on the sidebar's settled shelf. The banner it turns
   *  on is what tells the reader they are inside history — the shelf itself no
   *  longer springs open to say so. */
  settled?: boolean;
  /** Return it to the list. Absent hides the button, never the banner. */
  onUnsettle?: () => void;
  /** Submit a `/compact` turn. The cockpit passes it on Claude sessions only —
   *  the slash command is that provider's. */
  onCompact?: () => void;
  /**
   * The question the drawer answers — an open all-choice `user_input` request.
   * While present, THE COMPOSER CHANGES MODE: the editor's text is the active
   * question's custom answer (the real draft is untouched underneath and
   * returns when the question resolves), Enter advances or submits, and the
   * send button relabels. See composer-question-drawer.tsx.
   */
  question?: EngineRequest;
  /** A `multiple` choice field answers with the list of labels it was given;
   *  every other field answers with one string. */
  onAnswerQuestion?: (requestId: string, answers: Record<string, string | string[]>) => void;
  onCancelQuestion?: (requestId: string) => void;
  /** The provider is squeezing its context RIGHT NOW — an open
   *  context_compaction row on the live turn. Gates the compact button. */
  compacting?: boolean;
  onDraftChange: (draft: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  /** Stop the lingering background tasks — the "N tasks still working" chip.
   *  Separate from `onStop` (which ends the turn and spares them). */
  onStopBackground: () => void;
  onRuntimeMode: (mode: RuntimeMode) => void;
  /** Sit out a usage limit and carry on, or stay stopped. Absent on a session
   *  that does not exist yet — there is nothing to patch. */
  onResumeAfterRateLimit?: (next: boolean) => void;
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
  const armedAt = useRef<number>(0);
  const editor = useRef<ComposerEditorHandle>(null);
  /**
   * DERIVED, not reset in an effect. An armed stop only means anything while a
   * turn is running, so the running flag is part of the ANSWER rather than a
   * trigger to go clear a flag — and an effect that cleared it would let the
   * armed paint survive one render past the turn it belonged to.
   */
  const escArmed = armedRaw && busy;

  /** WHICH HARNESS IS LISTENING, in one expression the slash menu can use. A
   *  canvas is pointed at `driver`; a session was created on one and keeps it
   *  for life. */
  const menuDriver = fresh ? driver : session?.driver;

  /* ---------------------------------------------------------------- *
   * THE BANNER STACK — the notices tucked behind the composer's top edge.
   * ---------------------------------------------------------------- */

  /** Dismissal is per SESSION, not a boolean: keyed on the id, it survives
   *  nothing and resets by construction when the composer shows another
   *  conversation — no effect clearing state behind the render. */
  const [contextNoticeDismissedFor, setContextNoticeDismissedFor] = useState<string>();
  const contextShare = usage?.contextUsed && usage.contextMax ? usage.contextUsed / usage.contextMax : 0;
  /** Three quarters full is when compaction stops being trivia and starts
   *  being the next thing worth doing — late enough to never nag a short
   *  conversation, early enough that the squeeze still has room to run. */
  const contextNotice = Boolean(
    !fresh && session && onCompact && !compacting && contextShare >= 0.75 && contextNoticeDismissedFor !== session.id,
  );
  const settledNotice = Boolean(!fresh && session && settled);

  /* ---------------------------------------------------------------- *
   * QUESTION MODE — the drawer above, the editor as the custom answer.
   * ---------------------------------------------------------------- */

  const qFields = useMemo(() => (question ? questionFields(question) : []), [question]);
  const questionActive = qFields.length > 0 && Boolean(onAnswerQuestion);
  /**
   * KEYED BY REQUEST ID rather than reset in an effect: a new question simply
   * fails the id check and reads as a fresh empty draft, so one request's
   * half-typed answer can never leak into the next request's form.
   */
  const [qState, setQState] = useState<{ requestId: string; draft: QuestionDraft }>();
  const qd = questionActive && question && qState?.requestId === question.id ? qState.draft : emptyQuestionDraft();
  const setQd = (next: QuestionDraft) => question && setQState({ requestId: question.id, draft: next });
  const qActiveKey = qFields[qd.index]?.key;

  const advanceOrSubmitQuestion = () => {
    if (!question || !onAnswerQuestion || !canAdvance(qFields, qd)) return;
    if (!isLastQuestion(qFields, qd)) {
      setQd(advanceQuestion(qd));
      return;
    }
    const answers = buildAnswers(qFields, qd);
    if (answers) onAnswerQuestion(question.id, answers);
  };

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
  /** The provider's own skills and slash commands, keyed by the session that
   *  answered for exactly the reason the path cache is. */
  const [skillCache, setSkillCache] = useState<{ checkout: string; value: ProviderSkills }>();
  const [readingSkills, setReadingSkills] = useState(false);

  /* ---------------------------------------------------------------- *
   * THE STASH — ⌘S sets this box aside; any composer can pull it back.
   * ---------------------------------------------------------------- */

  const stash = usePromptStash();
  const [stashOpen, setStashOpen] = useState(false);
  const [stashActive, setStashActive] = useState(0);
  const [stashing, setStashing] = useState(false);
  /** The one thing that went wrong, said in place. There is no toast in this
   *  app and that is deliberate — see file-view-surface.tsx. */
  const [note, setNote] = useState<string>();
  /**
   * WHAT THE BOX HOLDS RIGHT NOW, readable from inside an await.
   *
   * Encoding pictures takes a beat, and a person carries on typing through it.
   * `draft` inside `doStash` is the value from the render that started it; this
   * ref is the value from the render that is on screen when it finishes, and
   * the difference between them is exactly the characters typed in between —
   * which must survive the clear.
   */
  const latest = useRef(draft);
  useEffect(() => {
    latest.current = draft;
  }, [draft]);

  /** What the host is showing as attached RIGHT NOW, after the latest commit. */
  const held = useRef(attachments);
  useEffect(() => {
    held.current = attachments;
  });

  /**
   * CAPTURE, ENCODE, WRITE, AND ONLY THEN CLEAR.
   *
   * The donor writes a text-only entry first, clears the box immediately, and
   * attaches the compressed pictures afterwards — which buys instant clearing
   * across a server upload it has and this app does not: attachments here are
   * `File`s in memory until `submit` uploads them, so there is nothing to race.
   * What the phased shape would cost is the whole point of the feature: the box
   * emptied before the images were known to fit, and a half-written entry that a
   * closed tab strands forever with no process that could reconcile it.
   */
  const doStash = useCallback(async () => {
    const text = draft.trim();
    const { images, rest } = splitImages(attachments);
    if (!text && images.length === 0) return;
    setNote(undefined);

    // THE COMMON CASE NEVER AWAITS. A prompt with no pictures has to feel like
    // a keystroke, not like a save.
    let encoded: { images: StashedImage[]; kept: File[] } = { images: [], kept: [] };
    if (images.length > 0) {
      setStashing(true);
      try {
        encoded = await encodeImagesForStash(images);
      } finally {
        setStashing(false);
      }
    }

    const ok = stash.stash({ id: crypto.randomUUID(), at: Date.now(), prompt: text, images: encoded.images });
    if (!ok) {
      setNote("There was no room to stash this. Nothing was taken from the box.");
      return;
    }

    // WHAT YOU TYPED WHILE IT WAS ENCODING IS STILL YOURS. Only the run that
    // was captured is removed; anything added after it stays in the box.
    onDraftChange(latest.current.startsWith(draft) ? latest.current.slice(draft.length) : "");
    // What the stash could not carry goes straight back — the leftover chip is
    // its own explanation, which is why there is no message for it.
    onAttach([...rest, ...encoded.kept]);
    setStashOpen(false);
  }, [draft, attachments, stash, onDraftChange, onAttach]);

  const doRestore = useCallback(
    (entry: StashEntry) => {
      const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
      const taken = stash.take(entry.id, room);
      // Gone — the other window took it between the paint and the click. Also
      // the guard that stops a click and an Enter landing on the same row.
      if (!taken) return;
      setNote(undefined);
      onDraftChange(appendPrompt(draft, taken.prompt));
      if (taken.images.length > 0) {
        const before = attachments.length;
        onAttach(mergeAttachments(attachments, filesFromStash(taken.images), MAX_ATTACHMENTS));
        /**
         * A HOST THAT TAKES NO ATTACHMENTS.
         *
         * The Spool's master chat passes a stub `onAttach` and an always-empty
         * list, and nothing in the props tells it apart from a real one. The
         * only honest test is to hand the files over and then look: if the box
         * is not holding more than it was, they never arrived, and they go back
         * in the stash rather than nowhere. Restoring a prompt must never be
         * how you lose the picture.
         *
         * A TASK RATHER THAN AN EFFECT ON `attachments`, deliberately. That
         * effect would only run if the prop's identity changed, which is a
         * property of how each host happens to spell its JSX — true today by
         * luck, and silent data loss on the day one of them memoises the array.
         * A task runs after the commit either way.
         */
        const images = taken.images;
        window.setTimeout(() => {
          if (held.current.length > before) return;
          stash.put(images, crypto.randomUUID(), Date.now());
          setNote("This chat cannot hold images — they are back in the stash.");
        }, 0);
      }
      if (taken.left > 0) {
        setNote(`${taken.left === 1 ? "1 image is" : `${taken.left} images are`} still in the stash — this box is full.`);
      }
      setStashOpen(false);
      // Insurance. Focus is normally never lost, because every row prevents its
      // own mousedown — but an image-only entry changes no text, so the editor's
      // repaint (which is what usually restores the caret) never runs.
      editor.current?.focus();
    },
    [attachments, stash, draft, onDraftChange, onAttach],
  );

  const sessionId = session?.id;
  /**
   * The cache key for `@`-completions. `none` is the project-less case: there is
   * no checkout to list, so the index stays empty and the key is still stable —
   * a cache keyed on `undefined` would collide with a real one.
   */
  const checkout = sessionId ?? (projectId ? `project:${projectId}` : "none");
  const paths = pathCache?.checkout === checkout ? pathCache.entries : undefined;
  const skills = skillCache?.checkout === checkout ? skillCache.value : undefined;
  /**
   * THE NOTEBOOK, for the `@` menu. Read on mount rather than on the first `@`,
   * unlike the path listing: that one is a git call over a whole checkout and
   * most messages contain no mention, while this is one small document the foot
   * two centimetres below is already showing. Both surfaces share the window
   * event, so they cannot disagree about what the notebook holds.
   */
  const { notes } = useProjectNotes(projectId);
  const commandChoices = useComposerCommandChoices(activeDriverOf(session, driver), modelChoiceOf(session, pendingModel), session?.providerInstanceId);

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

  /**
   * READ ON THE FIRST `$` OR `/`, AND ONLY ON A SESSION THAT EXISTS.
   *
   * Same rule as the path listing above and the same reason: the engine may
   * have to ask the harness itself, which is a subprocess, and most messages
   * contain neither sigil. A CANVAS ASKS NOTHING — there is no session to ask
   * about yet, and the skills of a session that does not exist is not a
   * question with an answer.
   */
  useEffect(() => {
    if (trigger?.kind !== "skill" && trigger?.kind !== "command") return;
    if (skills || readingSkills || !sessionId) return;
    const task = window.setTimeout(() => {
      setReadingSkills(true);
      void (async () => {
        try {
          setSkillCache({ checkout, value: (await api.sessionSkills(sessionId)) });
        } catch {
          // Two empty lists read as "this provider offers none", which is the
          // honest answer when the engine could not be asked — and is what a
          // Codex session legitimately returns. Cached so it is asked once.
          setSkillCache({ checkout, value: { skills: [], commands: [] } });
        } finally {
          setReadingSkills(false);
        }
      })();
    }, 0);
    return () => window.clearTimeout(task);
  }, [trigger?.kind, skills, readingSkills, checkout, sessionId]);

  const completions = useMemo<Completion[]>(() => {
    if (!trigger || dismissed) return [];
    // `$` IS SKILLS AND NOTHING ELSE. Unlike `@`, which reaches two stores
    // under one sigil because "did I mean the note or the file" is a question
    // nobody wants to be asked, a skill has no second store to be confused with.
    if (trigger.kind === "skill") return rankSkills(skills?.skills ?? [], trigger.query);
    /**
     * `@` OFFERS THE NOTEBOOK BESIDE THE CHECKOUT, under ONE sigil.
     *
     * A `@note:` prefix would thread a second trigger kind through the editor
     * for a gesture whose whole appeal is that `@arch` reaches "Architecture
     * decisions" and `architecture.md` without the typist having decided which
     * of the two they wanted. Notes take at most the first four rows — they are
     * a handful and the checkout is thousands, so a cap is what stops a short
     * query from burying every path — and the picked row inserts the note's
     * BODY, exactly as dragging its chip does.
     */
    if (trigger.kind === "path") {
      const noteRows = rankNotes(notes, trigger.query);
      return [...noteRows, ...rankPaths(paths ?? [], trigger.query, Math.max(4, 12 - noteRows.length))];
    }
    /**
     * TELAR'S VERBS, THEN THE PROVIDER'S — two ranked lists concatenated rather
     * than one ranking over both. A single pass would let a plugin command
     * outscore `/stop` on a two-letter query, and the verbs are the ones this
     * box performs itself.
     */
    return [
      ...rankCommands(
      availableCommands({
        busy,
        fresh,
        ...(runtimeMode ? { runtimeMode } : {}),
        // THE SESSION'S OWN AGENT ONCE IT HAS ONE. `driver` is the CANVAS's
        // pending choice and the cockpit only passes it while fresh, so a row
        // that depends on which harness is listening — `/compact` — saw
        // `undefined` on every session that actually has one.
        ...(menuDriver ? { driver: menuDriver } : {}),
        ...(compacting ? { compacting } : {}),
        ...(envMode ? { envMode } : {}),
        models: commandChoices.models,
        efforts: commandChoices.efforts,
      }),
      trigger.query,
      ),
      ...rankCommands(providerCommandCompletions(skills?.commands ?? []), trigger.query),
    ];
  }, [trigger, dismissed, paths, notes, skills, busy, fresh, runtimeMode, menuDriver, compacting, envMode, commandChoices]);

  // No completions while a question is active: the editor's text is an ANSWER,
  // and an `@` in "I'd prefer @latest" is punctuation, not a mention.
  /** A menu that is still fetching its rows stays OPEN and says "Reading…" —
   *  closing and reopening a beat later is the flicker that makes a person
   *  stop trusting the sigil. `/` is exempt: it always has Telar's own verbs to
   *  show immediately, so it never has an empty moment to cover. */
  const menuLoading = (trigger?.kind === "path" && reading) || (trigger?.kind === "skill" && readingSkills);
  const menuOpen = !questionActive && trigger !== null && !dismissed && (completions.length > 0 || menuLoading);

  /** Recompute the trigger from the live caret. Called after every edit and
   *  every caret move, because moving out of a `@word` must close the menu. */
  const retrigger = useCallback((text: string) => {
    const caret = editor.current?.caret() ?? text.length;
    setTrigger(detectComposerTrigger(text, caret));
  }, []);

  const apply = useCallback(
    (completion: Completion) => {
      // A DISABLED ROW IS A LABEL, NOT A CONTROL. It keeps the menu open and
      // the trigger intact, so the reason it carries stays on screen — closing
      // the menu on a press that did nothing is how you get pressed twice.
      if (completion.disabled) return;
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
      // The same press as the usage wheel's button, and the same submission:
      // the cockpit sends one `kind: "compact"` turn either way.
      if (action.type === "compact") onCompact?.();
      if (action.type === "stop") onStop();
    },
    [trigger, onRuntimeMode, onEnvMode, onDriverChange, onModelChange, onCompact, onStop, session, pendingModel],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // IME composition: Enter is committing a candidate, not sending.
      if (event.nativeEvent.isComposing) return;
      /**
       * ⌘S RESOLVES BEFORE EVERY CONTENT KEY, and it always prevents.
       *
       * The requirement is that the browser's Save dialog never opens — not
       * usually, never — so `preventDefault` is the first statement in the
       * branch rather than something reached after a condition. The file editor
       * in the right panel prevents it even while read-only for the same reason.
       * Shift is deliberately not checked: ⌘⇧S is "Save As" and belongs here too.
       *
       * It sits this high because a modifier chord can never mean "type an s",
       * so nothing below has a claim on it — the same rule the app's command-key
       * table already encodes for every other chord.
       */
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (stashing) return;
        // WITH SOMETHING IN THE BOX IT STASHES; EMPTY, IT OPENS THE LIST. One
        // key, because the two are the same thought at different moments and a
        // second binding for the second half is a second thing to remember.
        if (draft.trim() || attachments.some((file) => file.type.startsWith("image/"))) void doStash();
        else {
          setStashOpen((open) => !open);
          setStashActive(0);
        }
        return;
      }
      /**
       * A VISIBLE LIST OWNS THE ARROWS. Above the completion block (which is
       * dead here — that one needs an `@` or `/`, and this menu only opens over
       * an empty box) and above the ArrowUp recall, which claims exactly the
       * state the stash menu opens in. Walking the queue while a list is on
       * screen would be moving something the user cannot see.
       */
      if (stashOpen) {
        /**
         * ESCAPE CLOSES IT EVEN WHEN IT IS EMPTY, and that is not symmetry —
         * it is the only way out. The badge is not rendered at zero, so a menu
         * that ignored Escape on an empty stash would leave the panel sitting
         * over the conversation with nothing on screen that could dismiss it.
         * Which is why this is the one key handled above the count check.
         */
        if (event.key === "Escape") {
          event.preventDefault();
          setStashOpen(false);
          // Returned so Escape never also abandons a recall or arms the stop.
          return;
        }
        if (stash.entries.length > 0) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setStashActive((index) => (index + 1) % stash.entries.length);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setStashActive((index) => (index - 1 + stash.entries.length) % stash.entries.length);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            const picked = stash.entries[Math.min(stashActive, stash.entries.length - 1)];
            if (picked) doRestore(picked);
            return;
          }
          // ⌘⌫, the gesture Mail and Finder use for "delete the highlighted
          // thing". NOT a bare Backspace: over a list of prompts you
          // deliberately saved, that is one twitch away from unrecoverable.
          if (event.key === "Backspace" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            const picked = stash.entries[Math.min(stashActive, stash.entries.length - 1)];
            if (picked) stash.drop(picked.id);
            setStashActive((index) => Math.max(0, Math.min(index, stash.entries.length - 2)));
            return;
          }
        }
      }
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
      /**
       * QUESTION MODE HIJACKS ENTER: it advances or submits the form, the way
       * the send button does. Everything below — recall, escape-to-stop — is
       * about the DRAFT, which is parked while a question is on screen.
       */
      if (questionActive) {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          advanceOrSubmitQuestion();
        }
        return;
      }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- advanceOrSubmitQuestion is rebuilt per render by design; questionActive covers its liveness
    [
      draft,
      ready,
      busy,
      escArmed,
      onDraftChange,
      onSubmit,
      onStop,
      menuOpen,
      completions,
      active,
      apply,
      questionActive,
      qd,
      question,
      attachments,
      stash,
      stashOpen,
      stashActive,
      stashing,
      doStash,
      doRestore,
    ],
  );

  /**
   * THE THREE COMMANDS THAT ARE THIS BOX'S (#367). Nothing else in the app can
   * answer them — the caret, the draft and the running turn all live here — so
   * the composer binds itself while it is mounted and the registry's dispatcher
   * looks them up. On a route with no composer they resolve to nothing, which is
   * the right answer rather than a beep.
   *
   * THEY ARE THE SAME GUARDS THE KEYS INSIDE THE BOX USE: Send refuses an empty
   * or not-ready draft exactly as Enter does, and Stop only fires on a live turn
   * — a chord that submitted whitespace would be a chord you have to check the
   * screen before pressing.
   */
  useCommandHandlers({
    "focus-composer": () => editor.current?.focus(),
    send: () => {
      if (questionActive) {
        advanceOrSubmitQuestion();
        return;
      }
      if (draft.trim() && ready) onSubmit();
    },
    // No arming here, unlike Escape: ⌘. is not a key anybody presses by accident
    // mid-sentence, which is the whole reason Escape needs two presses.
    "stop-turn": () => {
      if (busy) onStop();
    },
  });

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
  /** What is being dragged over the box — a panel reference gets its own words,
   *  because "drop to reference" is the label that teaches the gesture. */
  const [dropping, setDropping] = useState<false | "reference" | "content">(false);

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

  // "Stop", because that is what it does: the run ends and what was queued
  // behind it is settled, leaving the session idle. It briefly said "Pause" —
  // it paused, and a person who pressed it had to press Resume before they
  // could say anything. See the cockpit's `stop`.
  const submitLabel = escArmed ? "Press Escape again to stop" : busy ? "Stop" : "Send";
  const questionSubmitLabel = isLastQuestion(qFields, qd)
    ? qFields.length === 1
      ? "Submit answer"
      : "Submit answers"
    : "Next question";
  /**
   * ONE VALUE FOR EVERY PROVIDER KNOB, passed whole to every control.
   *
   * Each control used to receive the fields it cared about and send back only
   * those, so picking an effort cleared the model and picking a model cleared
   * the effort. Handing the whole choice down and taking the whole choice back
   * makes that loss unrepresentable — see `ModelChoice`.
   */
  const activeDriver = activeDriverOf(session, driver);
  /** WHOSE LOGIN'S curated model list the menus should show. The session's own
   *  once it exists; before that, the driver's built-in slot — which is the only
   *  login a not-yet-created session could mean, and what the engine falls back
   *  to when nobody names one. */
  const activeInstanceId = session?.providerInstanceId;
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
        <FreshGreeting projectId={projectId} {...(projectName ? { projectName } : {})} />
      )}

      <BackgroundPresence count={backgroundTasks} onStop={onStopBackground} />

      {/* WHY IT DID NOT HAPPEN, above the box rather than in a toast — the
          same choice, for the same reason, as the file editor's save notice.
          A stash that quietly refused is a paragraph the person thinks they
          still have. */}
      {note && (
        <div className="flex items-start gap-1.5 rounded-lg bg-destructive/10 px-2 py-1.5 text-2xs leading-snug text-destructive">
          <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{note}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNote(undefined)} className="shrink-0 rounded p-0.5">
            <XIcon className="size-3.5" />
          </button>
        </div>
      )}

      {/* ONE BLOCK, form plus foot. The outer wrapper is a flex column with a
          gap, and the foot's whole fuse (workspace-environment.tsx's `-mt-px`,
          `border-t-0`) is defeated by any gap between it and the form — the
          tray read as a second card floating below. Grouping them makes the
          gap apply around the pair, never inside it. */}
      <div>
      {/* THE BANNER STACK, back to front: settled first (furthest from the
          input — it is about the whole conversation), then the context notice,
          then the question drawer, then the box. Later siblings paint over
          earlier ones in normal flow, which is the entire stacking mechanism —
          no z-index anywhere. */}
      {settledNotice && (
        <ComposerBanner
          icon={<CircleCheckIcon className="size-4 shrink-0 text-muted-foreground" />}
          title="This conversation is settled"
          detail="Sending a message returns it to the list in the sidebar."
          {...(onUnsettle ? { action: onUnsettle, actionLabel: "Un-settle" } : {})}
        />
      )}
      {contextNotice && session && onCompact && (
        <ComposerBanner
          icon={<FoldVerticalIcon className="size-4 shrink-0 text-muted-foreground" />}
          title="The context is getting heavy"
          detail={`${fmtTokens(usage?.contextUsed ?? 0)} of ${fmtTokens(usage?.contextMax ?? 0)} tokens in the provider's window.`}
          action={onCompact}
          actionLabel="Compact"
          onDismiss={() => setContextNoticeDismissedFor(session.id)}
        />
      )}
      {/* The question drawer fuses onto the composer's TOP edge — same width
          inset as the foot below, rounded top corners, its bottom tucked under
          the box so the two read as one object. */}
      {questionActive && question && (
        <ComposerQuestionDrawer
          fields={qFields}
          draft={qd}
          onDraft={setQd}
          sending={sending}
          onCancelTurn={() => onCancelQuestion?.(question.id)}
        />
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (questionActive) {
            advanceOrSubmitQuestion();
            return;
          }
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
            rather than off the whole composer column — the greeting lives in
            that column and would push the menu around. */}
        <div className="relative">
        {/* ONE SLOT, WRITTEN AS ONE EXPRESSION. Both panels are
            `bottom-full`, so rendering them as two independent conditions
            would stack them the day the invariant above ever slipped. */}
        {stashOpen ? (
          <ComposerStashMenu
            entries={stash.entries}
            active={Math.min(stashActive, Math.max(0, stash.entries.length - 1))}
            onActive={setStashActive}
            onPick={doRestore}
            onDrop={(entry) => stash.drop(entry.id)}
          />
        ) : menuOpen && trigger ? (
          <ComposerMenu
            completions={completions}
            active={Math.min(active, Math.max(0, completions.length - 1))}
            // The heading NAMES WHAT IS IN THE LIST, which is why it is not a
            // constant: `@` reaches the checkout and the notebook, and a list
            // headed "Files and folders" with a note at the top of it is a
            // label contradicting the rows underneath it.
            heading={
              trigger.kind === "skill"
                ? "Skills"
                : trigger.kind === "command"
                  ? "Commands"
                  : notes.length > 0
                    ? "Notes, files and folders"
                    : "Files and folders"
            }
            {...(menuLoading ? { loading: true } : {})}
            emptyText="No matches."
            onActive={setActive}
            onPick={apply}
          />
        ) : null}
        {/* THE WHOLE CARD IS THE RIGHT-CLICK SURFACE (#320). The chips inside
            keep their own menus: Base UI's trigger stops the `contextmenu` it
            handles, so the innermost one wins and a press on a chip never
            reaches this one. */}
        <ComposerChromeMenu
          draft={draft}
          attachments={attachments}
          stashing={stashing}
          onClear={() => onDraftChange("")}
          onStash={() => void doStash()}
        >
        <InputGroup
          onDragEnter={(event) => {
            if (!dragging(event)) return;
            dragDepth.current += 1;
            setDropping(event.dataTransfer.types.includes(REFERENCE_MIME) ? "reference" : "content");
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
            // `shadow-2` — the ladder's "floats over the page but belongs to
            // it" rung (globals.css). This used to be a hand-written
            // `shadow-[0_18px_60px_-30px_var(--shadow-tint)]`: right about the
            // INK (pure black is the one colour no theme has, and under a warm
            // palette it smudges grey instead of deepening the surface) and
            // wrong about being one surface's private number. The rung keeps
            // the ink and adds what the arbitrary value could not have: it
            // moves with the Depth setting, and the panel and the menus above
            // this bar are now demonstrably a step apart rather than
            // coincidentally similar.
            "rounded-2xl border-border/80 bg-card/95 shadow-2 backdrop-blur-xl",
            dropping && "relative border-ring ring-2 ring-ring/40",
          )}
        >
          {/* THE GESTURE, NAMED WHILE IT HAPPENS. The ring says "this accepts
              drops"; the pill says what a drop DOES — a reference for a panel
              row, an attachment for a file — which is how the drag from the
              browser strip teaches itself. Pointer-transparent so it can never
              swallow the drop it is describing. */}
          {dropping && (
            <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-3.5 z-10 flex justify-center">
              <span className="rounded-full border border-ring/50 bg-card px-2.5 py-0.5 text-2xs font-medium text-foreground shadow-1">
                {dropping === "reference" ? "Drop to reference it in your message" : "Drop to add it to your message"}
              </span>
            </div>
          )}
          <label className="sr-only" htmlFor="turn-prompt">
            Message
          </label>
          {/* IN QUESTION MODE THE EDITOR IS THE CUSTOM-ANSWER FIELD: its value
              is the active question's free text, and edits land in the drawer
              state instead of the draft — which sits untouched underneath and
              returns the moment the question resolves. Losing a half-typed
              message to an incoming question would be the sin the recall path
              already refuses. */}
          {/* THE ONE PLACE THE CARD'S MENU STANDS DOWN: a right-press on text
              the person has SELECTED in the box, where cut, copy, "Look Up" and
              the dictionary live. With nothing selected there is no editing
              verb to protect, so the press falls through to the card and the
              box stops being the dead zone #320 reported.

              `display: contents` — a click boundary, never a layout box, the
              same shape the cockpit uses for its conversation clicks. Both
              stops are needed and neither is redundant: the React one keeps
              the trigger above from opening, and the native IMMEDIATE one is
              what stops Base UI's document-level listener, which otherwise
              `preventDefault`s every `contextmenu` inside a trigger and would
              take the browser's own menu with it. */}
          <div
            className="contents"
            onContextMenu={(event) => {
              const selection = window.getSelection();
              const anchor = selection?.anchorNode;
              if (!selection || selection.isCollapsed || !anchor || !event.currentTarget.contains(anchor)) return;
              event.stopPropagation();
              event.nativeEvent.stopImmediatePropagation();
            }}
          >
          <ComposerEditor
            ref={editor}
            id="turn-prompt"
            value={questionActive && qActiveKey !== undefined ? (qd.custom[qActiveKey] ?? "") : draft}
            placeholder={
              questionActive
                ? "Type your own answer, or leave blank…"
                : placeholderFor(ready, busy, placeholder)
            }
            // NOT disabled while busy. That is the whole point.
            disabled={!ready}
            onChange={(text) => {
              if (questionActive && qActiveKey !== undefined) {
                setQd(setCustomAnswer(qd, qActiveKey, text));
                return;
              }
              onDraftChange(text);
              // Synchronous, and BEFORE the state round-trip: `retrigger` reads
              // the caret out of the live DOM, so it has to run while the DOM
              // and the text it is being asked about are the same edit.
              retrigger(text);
              setActive(0);
              setDismissed(false);
              // THE TWO MENUS SHARE ONE SLOT, and this line is the whole of
              // what keeps them apart. A completion needs an `@` or `/`, which
              // needs text; the stash menu only opens over an empty box; and
              // typing is the only route between those two states.
              setStashOpen(false);
              setNote(undefined);
            }}
            onSelectionChange={() => !questionActive && retrigger(draft)}
            onKeyDown={onKeyDown}
            onPasteFiles={addFiles}
          />
          </div>
          {attachments.length > 0 && (
            <InputGroupAddon align="block-start" className="flex-wrap gap-1.5 px-2.5 pt-2.5">
              {attachments.map((file, index) => (
                <ComposerChromeMenu
                  key={`${file.name}-${file.size}-${index}`}
                  draft={draft}
                  attachments={attachments}
                  stashing={stashing}
                  onClear={() => onDraftChange("")}
                  onStash={() => void doStash()}
                  onRemoveAttachment={() => onAttach(attachments.filter((_, at) => at !== index))}
                >
                  <AttachmentChip file={file} onRemove={() => onAttach(attachments.filter((_, at) => at !== index))} />
                </ComposerChromeMenu>
              ))}
            </InputGroupAddon>
          )}
          <InputGroupAddon align="block-end" className="min-h-10 flex-wrap justify-between gap-1 border-t border-border/40 px-2 pt-1 pb-1.5">
            {/* Not a trigger any more — the card above is. It keeps its own
                `min-w-0`, which is the reason it was a box rather than the
                addon's own flex line. */}
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {/* Present but inert: attachments are a contract the engine does
                  not have yet. Disabled with the reason rather than absent, so
                  the row's shape is the one it will keep. */}
              <AddContextMenu onPick={addFiles} />
              {/**
               * THE STASH COUNT, and it is not rendered at all while the stash
               * is empty. A "0" is chrome advertising a feature you have not
               * used, and — the harder constraint — `InputGroup` carries
               * `has-disabled:opacity-50`, so the obvious alternative of a
               * disabled chip would grey the entire composer for the life of
               * the session. Nothing in here is ever `disabled`.
               *
               * IT SITS IN THE LEFT CLUSTER because that cluster is already
               * "things that go into this message"; the right one is send and
               * turn status, where a count competes with the send affordance.
               */}
              {(stash.entries.length > 0 || stashing) && (
                <button
                  type="button"
                  aria-label="Stashed prompts"
                  aria-haspopup="listbox"
                  aria-expanded={stashOpen}
                  title="Stashed prompts (⌘S)"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setStashOpen((open) => !open);
                    setStashActive(0);
                  }}
                  className={cn(
                    "flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    stashOpen && "bg-accent text-foreground",
                  )}
                >
                  <LayersIcon className="size-4" />
                  {stashing ? <Spinner /> : <span className="text-xs tabular-nums">{stash.entries.length}</span>}
                </button>
              )}
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
                    {...(activeInstanceId ? { instanceId: activeInstanceId } : {})}
                    {...(onModelChange ? { onChange: onModelChange } : {})}
                    {...(onDriverChange ? { onDriverChange } : {})}
                  />
                  {/* Hairlines rather than borders: three bordered chips read
                      as chrome bolted to the composer, where the reference draws
                      the same three as labels with a rule between them. */}
                  <div className="hidden items-center gap-1 @2xl/composer:flex">
                    <ControlDivider />
                    <ReasoningControl
                      driver={activeDriver}
                      choice={choice}
                      {...(activeInstanceId ? { instanceId: activeInstanceId } : {})}
                      {...(onModelChange ? { onChange: onModelChange } : {})}
                    />
                    {runtimeMode && (
                      <>
                        <ControlDivider />
                        <AccessControl
                          runtimeMode={runtimeMode}
                          onRuntimeMode={onRuntimeMode}
                          driver={activeDriver}
                          {...(session?.resumeAfterRateLimit === undefined ? {} : { resumeAfterRateLimit: session.resumeAfterRateLimit })}
                          {...(onResumeAfterRateLimit ? { onResumeAfterRateLimit } : {})}
                        />
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
                      {...(activeInstanceId ? { instanceId: activeInstanceId } : {})}
                      fresh={fresh}
                      {...(runtimeMode ? { runtimeMode } : {})}
                      {...(envMode ? { envMode } : {})}
                      {...(onModelChange ? { onChange: onModelChange } : {})}
                      {...(runtimeMode ? { onRuntimeMode } : {})}
                      {...(onDriverChange ? { onDriverChange } : {})}
                      {...(onEnvMode ? { onEnvMode } : {})}
                      {...(session?.resumeAfterRateLimit === undefined ? {} : { resumeAfterRateLimit: session.resumeAfterRateLimit })}
                      {...(onResumeAfterRateLimit ? { onResumeAfterRateLimit } : {})}
                    />
                  </div>
                </>
              )}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5 self-end">
            <ContextPill
              {...(usage ? { usage } : {})}
              {...(session ? { driver: session.driver } : {})}
              {...(onCompact ? { onCompact } : {})}
              compactDisabled={busy || sending || Boolean(compacting)}
              // ONE SENTENCE FOR ONE CAPABILITY: the `/compact` row in the
              // slash menu reads the same helper, so the button and the row can
              // never give a person two different reasons.
              compactReason={compactBlockedReason({ busy, compacting }) ?? "Sending…"}
            />
            {/* NOT DISABLED ON AN EMPTY DRAFT, and that is a fix rather than an
                oversight: `InputGroup` carries `has-disabled:opacity-50`, so a
                disabled descendant greys the ENTIRE composer — box, pills,
                placeholder and all. With the send button disabled whenever the
                box was empty, the composer spent most of its life looking
                broken. The donor never disables it either; submitting an empty
                draft is simply a no-op. */}
            <InputGroupButton
              // In question mode the button SUBMITS THE FORM — the turn is
              // running (busy), but the gesture on offer is answering, not
              // stopping; the drawer keeps its own "Cancel the turn".
              type={busy && !questionActive ? "button" : "submit"}
              variant="default"
              size="icon-sm"
              aria-label={questionActive ? questionSubmitLabel : submitLabel}
              title={questionActive ? questionSubmitLabel : undefined}
              onClick={busy && !questionActive ? onStop : undefined}
              className={cn(
                escArmed && !questionActive && "bg-destructive text-background hover:bg-destructive",
                !busy && !draft.trim() && "opacity-60",
                questionActive && !canAdvance(qFields, qd) && "opacity-60",
              )}
            >
              {questionActive ? (
                sending ? (
                  <Spinner />
                ) : (
                  <CornerDownLeftIcon className="size-4" />
                )
              ) : escArmed ? (
                // The WORD, not a glyph. "ESC" names the key the user just
                // pressed and the key that will finish the job, which no icon
                // can say.
                <span className="text-3xs leading-none font-semibold tracking-tight">ESC</span>
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
        </ComposerChromeMenu>
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
        {...(pendingBase ? { pendingBase } : {})}
        {...(onBase ? { onBase } : {})}
        {...(onOpenChanges ? { onOpenChanges } : {})}
      />
      )}
      </div>
    </div>
  );
}
