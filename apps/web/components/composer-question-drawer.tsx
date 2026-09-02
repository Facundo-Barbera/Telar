"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, MessageCircleQuestionIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  advance,
  answerFor,
  back,
  canAdvance,
  isLastQuestion,
  selectOption,
  type QuestionDraft,
  type QuestionField,
} from "@/lib/question-drawer";

/**
 * THE QUESTION DRAWER — glued to the composer's top edge.
 *
 * A question used to render as a card pinned at the top of the turn, which is
 * the one place a person is NOT looking while an agent works: the eye is at
 * the live tail, and the hands are at the composer. So the question meets
 * both: a drawer fused onto the composer (same width, rounded top corners,
 * its bottom edge tucked under the box), one question at a time, with the
 * composer's own editor doubling as the free-text answer — see composer.tsx
 * for that half.
 *
 * The submit gesture is the COMPOSER'S send button and Enter, not a button
 * here: the drawer shows and selects, the composer submits. That is what
 * makes answering feel like typing a message rather than filling in a form.
 */
export function ComposerQuestionDrawer({
  fields,
  draft,
  onDraft,
  onCancelTurn,
  sending,
}: {
  fields: QuestionField[];
  draft: QuestionDraft;
  onDraft: (next: QuestionDraft) => void;
  /** Withdraw the whole turn — the drawer's only escape hatch, because a
   *  question no runtime mode may auto-answer cannot simply be dismissed. */
  onCancelTurn: () => void;
  sending: boolean;
}) {
  const field = fields[draft.index];
  /**
   * Collapse remembers WHICH question was collapsed, not a boolean — so
   * advancing to the next question reopens the drawer by construction, with
   * no effect resetting state behind the render.
   */
  const [collapsedIndex, setCollapsedIndex] = useState<number>();
  const collapsed = collapsedIndex === draft.index;
  /** Auto-advance holds this so unmount cannot fire a stale hop. */
  const hop = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(hop.current), []);

  const pick = (label: string) => {
    if (!field) return;
    const next = selectOption(draft, field.key, label);
    onDraft(next);
    // Single-select auto-advances after a beat — long enough to see the check
    // land, short enough to feel like one gesture. Never past the last
    // question: submitting is the composer's send, a deliberate press.
    if (!isLastQuestion(fields, next) && answerFor(next, field.key) !== undefined) {
      window.clearTimeout(hop.current);
      hop.current = window.setTimeout(() => onDraft(advance(next)), 200);
    }
  };
  /** True when the digit landed on an option. Read through a ref by the one
   *  document listener below, so registration happens once and the closure is
   *  never stale. */
  const pickDigit = (digit: number): boolean => {
    if (!field || collapsed || sending) return false;
    const choice = field.choices[digit - 1];
    if (choice === undefined || digit > 9) return false;
    pick(choice);
    return true;
  };
  const pickDigitRef = useRef(pickDigit);
  useEffect(() => {
    pickDigitRef.current = pickDigit;
  });

  /**
   * KEYS 1–9 PICK AN OPTION, guarded to bail whenever focus is in an input,
   * textarea or contenteditable — the composer's editor is exactly that, and
   * a digit typed into a custom answer must stay a digit.
   */
  useEffect(() => {
    const listen = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const digit = Number(event.key);
      if (!Number.isInteger(digit) || digit < 1) return;
      if (pickDigitRef.current(digit)) event.preventDefault();
    };
    document.addEventListener("keydown", listen);
    return () => document.removeEventListener("keydown", listen);
  }, []);

  if (!field) return null;

  return (
    <div className="mx-3 -mb-1">
      <div className="rounded-t-xl border border-b-0 border-warning/40 bg-warning/[0.06] pb-2">
        {/* Header row: what is being asked, where you are, and the collapse. */}
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsedIndex(collapsed ? undefined : draft.index)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
        >
          <MessageCircleQuestionIcon className="size-3.5 shrink-0 text-warning" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {collapsed ? field.label : "The agent needs your input"}
          </span>
          {fields.length > 1 && (
            <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground tabular-nums">
              {draft.index + 1}/{fields.length}
            </span>
          )}
          <ChevronDownIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", collapsed && "-rotate-90")} />
        </button>

        {!collapsed && (
          <div className="px-3">
            <p className="text-sm leading-snug">{field.label}</p>
            <div className="mt-2 flex flex-col gap-1">
              {field.choices.map((choice, at) => {
                const selected = draft.selected[field.key] === choice;
                return (
                  <button
                    key={choice}
                    type="button"
                    disabled={sending}
                    onClick={() => pick(choice)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors",
                      selected ? "border-warning/60 bg-warning/10" : "border-border/60 hover:bg-muted/60",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{choice}</span>
                    {selected ? (
                      <CheckIcon className="size-3.5 shrink-0 text-warning" />
                    ) : (
                      at < 9 && (
                        <kbd className="shrink-0 rounded border border-border/60 px-1 font-mono text-[0.625rem] text-muted-foreground">{at + 1}</kbd>
                      )
                    )}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex items-center gap-2">
              {draft.index > 0 && (
                <button
                  type="button"
                  onClick={() => onDraft(back(draft))}
                  className="rounded-md px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  Previous
                </button>
              )}
              <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-muted-foreground">
                {canAdvance(fields, draft)
                  ? isLastQuestion(fields, draft)
                    ? "Enter submits"
                    : "Enter continues"
                  : "Pick one, or type your own"}
              </span>
              <button
                type="button"
                disabled={sending}
                onClick={onCancelTurn}
                className="shrink-0 rounded-md px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                Cancel the turn
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
