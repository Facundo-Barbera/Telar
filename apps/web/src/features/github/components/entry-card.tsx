"use client";

import { useState } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PanelDivider } from "@/components/ui/panel";
import { fmtAgo } from "@/lib/format";
import { reviewLabel, type ForgeEntry } from "../github-forge";
import { cn } from "@/lib/utils";
import { exactTime } from "../model";
import { GitHubAvatar } from "./github-avatar";
import { Markdown, READING_MEASURE } from "./markdown";
import { ReactionRow, type ReactHandler } from "./reactions";

const REVIEW_TONE: Record<string, string> = {
  APPROVED: "text-success",
  CHANGES_REQUESTED: "text-destructive",
  DISMISSED: "text-muted-foreground",
};

function AuthorBar({ entry }: { entry: ForgeEntry }) {
  const verdict = entry.state ? (REVIEW_TONE[entry.state.toUpperCase()] ?? "text-muted-foreground") : undefined;
  return (
    <div className="flex min-w-0 items-center gap-1.5 border-b border-border bg-muted/40 px-2 py-1 text-3xs text-muted-foreground">
      <GitHubAvatar {...(entry.author ? { login: entry.author } : {})} {...(entry.avatar ? { src: entry.avatar } : {})} className="size-4" />
      <span className="min-w-0 truncate font-medium text-foreground">{entry.author ?? "someone"}</span>
      {entry.association && (
        <Badge variant="outline" className="shrink-0 px-1 py-0 text-4xs font-normal">
          {entry.association.toLowerCase()}
        </Badge>
      )}
      {entry.kind === "review" && <span className={cn("shrink-0", verdict)}>{reviewLabel(entry.state ?? "")}</span>}
      <span className="shrink-0 tabular-nums" title={exactTime(entry.at)}>
        {fmtAgo(entry.at)}
      </span>
      {/* A link rather than a badge: the session marker is a claim in the body, not a signature. */}
      {entry.sessionId && (
        <a
          href={`/sessions/${encodeURIComponent(entry.sessionId)}`}
          title={`Open the session this comment says it came from — ${entry.sessionId}`}
          className="min-w-0 shrink truncate font-mono text-4xs underline-offset-2 hover:text-foreground hover:underline"
        >
          {entry.sessionId}
        </a>
      )}
      {entry.url && (
        <a
          href={entry.url}
          target="_blank"
          rel="noreferrer"
          aria-label="Open this comment on GitHub"
          className="ml-auto shrink-0 rounded p-0.5 transition-colors hover:text-foreground"
        >
          <ExternalLinkIcon className="size-2.5" />
        </a>
      )}
    </div>
  );
}

/** One entry of the conversation. The opening post has no author bar: the facts line above names its author. */
export function EntryCard({ entry, onReact }: { entry: ForgeEntry; onReact?: ReactHandler }) {
  const [revealed, setRevealed] = useState(false);
  const hidden = entry.minimized === true && !revealed;

  return (
    <div className={cn("w-full min-w-0 self-center overflow-hidden rounded-md border border-border bg-card", READING_MEASURE)}>
      {entry.kind !== "body" && <AuthorBar entry={entry} />}
      <div className="min-w-0 px-2 py-1.5">
        {hidden ? (
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className="w-full rounded border border-dashed border-border px-2 py-1 text-left text-3xs leading-snug text-muted-foreground transition-colors hover:text-foreground"
          >
            Hidden by the repository{entry.minimizedReason ? ` as ${entry.minimizedReason.toLowerCase().replaceAll("_", " ")}` : ""} — show anyway
          </button>
        ) : entry.body.trim() ? (
          <Markdown>{entry.body}</Markdown>
        ) : (
          <p className="text-2xs text-muted-foreground">{entry.kind === "review" ? "No comment left with this review." : "No description was written."}</p>
        )}
        {!hidden && entry.reactions && (
          <ReactionRow reactions={entry.reactions} {...(onReact && entry.subjectId ? { onReact: onReact.bind(null, entry.subjectId) } : {})} />
        )}
      </div>
    </div>
  );
}

/** The replies after the opening post, in the order they happened, and never silent about a cut. */
export function Timeline({ entries, older, onReact }: { entries: readonly ForgeEntry[]; older: number; onReact?: ReactHandler }) {
  const replies = entries.filter((entry) => entry.kind !== "body");
  const said = replies.length + older;
  return (
    <>
      <PanelDivider label={replies.length === 0 ? "no replies" : `${said} ${said === 1 ? "reply" : "replies"}`} />
      {older > 0 && (
        <p className="px-3 pb-2 text-3xs leading-snug text-muted-foreground">
          The {older} oldest {older === 1 ? "comment is" : "comments are"} not shown — open it on GitHub for the whole thread.
        </p>
      )}
      <div className="flex flex-col gap-2 px-3 pb-3">
        {replies.map((entry) => (
          <EntryCard key={entry.id} entry={entry} {...(onReact ? { onReact } : {})} />
        ))}
      </div>
    </>
  );
}
