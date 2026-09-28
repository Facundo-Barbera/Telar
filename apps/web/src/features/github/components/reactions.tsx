"use client";

import { useState } from "react";
import { SmilePlusIcon } from "lucide-react";
import type { GitHubReaction, GitHubReactionContent, GitHubReactionResult } from "@telar/engine-client";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { applyReaction, reactionPills, REACTIONS } from "@/lib/github-forge";
import { cn } from "@/lib/utils";

export type ReactHandler = (subjectId: string, content: GitHubReactionContent, react: boolean) => Promise<GitHubReactionResult>;

function ReactionPicker({
  reactions,
  disabled,
  onPick,
}: {
  reactions: readonly GitHubReaction[];
  disabled: boolean;
  onPick: (content: GitHubReactionContent, react: boolean) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label="Add a reaction"
        title="Add a reaction"
        className="inline-flex h-5 items-center rounded-full border border-dashed border-border px-1.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
      >
        <SmilePlusIcon className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="flex w-auto flex-row gap-0.5 p-1">
        {REACTIONS.map(({ content, glyph, label }) => {
          const mine = reactions.some((reaction) => reaction.content === content && reaction.viewerHasReacted);
          return (
            <DropdownMenuItem
              key={content}
              aria-label={mine ? `Take back ${label}` : `React with ${label}`}
              title={label}
              onClick={() => onPick(content, !mine)}
              className={cn("justify-center px-1.5 text-sm", mine && "bg-primary/10")}
            >
              {glyph}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Counted pills; each is its own toggle when `onReact` is given, and the row draws nothing when nobody reacted. */
export function ReactionRow({
  reactions,
  onReact,
}: {
  reactions: readonly GitHubReaction[];
  onReact?: (content: GitHubReactionContent, react: boolean) => Promise<GitHubReactionResult>;
}) {
  // Local state so a click redraws at once; a fresh prop (a re-read) wins.
  const [shown, setShown] = useState(reactions);
  const [source, setSource] = useState(reactions);
  const [refused, setRefused] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (source !== reactions) {
    setSource(reactions);
    setShown(reactions);
  }

  const pills = reactionPills(shown);
  if (pills.length === 0 && !onReact) return null;

  const toggle = (content: GitHubReactionContent, react: boolean) => {
    if (!onReact || busy) return;
    setBusy(true);
    setRefused(undefined);
    void applyReaction({ current: shown, content, react, send: () => onReact(content, react), draw: setShown })
      .then(setRefused)
      .finally(() => setBusy(false));
  };

  return (
    <div data-reactions className="mt-1.5 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        {pills.map((pill) => {
          const words = `${pill.count} ${pill.label}${pill.viewerHasReacted ? ", including you" : ""}`;
          const hover = !pill.viewerHasReacted
            ? `${pill.count} reacted with ${pill.label}`
            : pill.count === 1
              ? `You reacted with ${pill.label}`
              : `You and ${pill.count - 1} more reacted with ${pill.label}`;
          const look = cn(
            "inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-3xs tabular-nums",
            pill.viewerHasReacted ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground",
          );
          const face = (
            <>
              <span aria-hidden className="text-2xs leading-none">
                {pill.glyph}
              </span>
              {pill.count}
            </>
          );
          return onReact ? (
            <button
              key={pill.content}
              type="button"
              data-mine={pill.viewerHasReacted || undefined}
              aria-pressed={pill.viewerHasReacted}
              aria-label={words}
              title={hover}
              disabled={busy}
              onClick={() => toggle(pill.content as GitHubReactionContent, !pill.viewerHasReacted)}
              className={cn(look, "transition-colors hover:border-primary/60 disabled:opacity-60")}
            >
              {face}
            </button>
          ) : (
            <span key={pill.content} data-mine={pill.viewerHasReacted || undefined} aria-label={words} title={hover} className={look}>
              {face}
            </span>
          );
        })}
        {onReact && <ReactionPicker reactions={shown} disabled={busy} onPick={toggle} />}
      </div>
      {refused && (
        <p role="status" className="text-3xs leading-snug text-destructive">
          {refused}
        </p>
      )}
    </div>
  );
}
