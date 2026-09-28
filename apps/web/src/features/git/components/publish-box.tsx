"use client";

import { ArrowUpFromLineIcon, GitPullRequestArrowIcon, TriangleAlertIcon } from "lucide-react";
import { PULL_CREATE_REFUSAL, PUSH_REFUSAL } from "@/features/github";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import { usePublish, type PublishVerbs } from "../hooks/use-publish";

type Publish = ReturnType<typeof usePublish>;

/**
 * Push and open-a-pull-request, each armed by one press and sent by a second.
 * `ahead` absent means the branch has no upstream yet; `github` undefined means nobody has asked, and hides the pull arm.
 */
export function PublishBox({
  sendPush,
  sendPullRequest,
  github,
  branch,
  ahead,
  commitsSinceBase,
  busy,
  onPublished,
  suggestion,
}: PublishVerbs & {
  github?: boolean;
  branch: string;
  ahead?: number;
  commitsSinceBase: number;
  busy: boolean;
  onPublished: () => void;
  suggestion: string;
}) {
  const publish = usePublish({ sendPush, sendPullRequest, onPublished, suggestion });
  const { armed, pushProblem, pullProblem, opened } = publish;
  const published = ahead !== undefined;
  const count = published ? ahead : commitsSinceBase;

  return (
    <div className="border-t border-border px-3 py-2">
      <p className="mb-1.5 truncate font-mono text-4xs tracking-[0.08em] text-muted-foreground uppercase">publish {branch}</p>

      {opened && (
        <p className="mb-2 flex items-start gap-1.5 rounded-md tint-success px-2.5 py-1.5 text-2xs leading-snug text-success">
          <GitPullRequestArrowIcon className="mt-0.5 size-3.5 shrink-0" />
          <a href={opened.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 break-all underline underline-offset-2">
            {opened.number ? `Opened #${opened.number}` : "Pull request opened"}
          </a>
        </p>
      )}

      {pushProblem && (
        <PublishProblem onDismiss={publish.dismissPush}>
          {PUSH_REFUSAL[pushProblem.refusal]}
          {pushProblem.message && <span className="block text-muted-foreground">{pushProblem.message}</span>}
        </PublishProblem>
      )}
      {pullProblem && (
        <PublishProblem onDismiss={publish.dismissPull}>
          {PULL_CREATE_REFUSAL[pullProblem.refusal]}
          {pullProblem.url && (
            <a href={pullProblem.url} target="_blank" rel="noreferrer" className="block break-all underline underline-offset-2">
              {pullProblem.url}
            </a>
          )}
          {pullProblem.message && !pullProblem.url && <span className="block text-muted-foreground">{pullProblem.message}</span>}
        </PublishProblem>
      )}

      {armed === "push" ? (
        <PushConfirm publish={publish} branch={branch} count={count} published={published} />
      ) : armed === "pull" ? (
        <PullRequestForm publish={publish} />
      ) : (
        <PublishArms publish={publish} github={github} ahead={ahead} commitsSinceBase={commitsSinceBase} busy={busy} />
      )}
    </div>
  );
}

function PushConfirm({ publish, branch, count, published }: { publish: Publish; branch: string; count: number; published: boolean }) {
  const { working } = publish;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-2xs leading-snug">
        Push <span className="font-mono">{branch}</span> to <span className="font-mono">origin</span>
        {count > 0 ? ` — ${count} ${count === 1 ? "commit" : "commits"}` : ""}?{" "}
        <span className="text-muted-foreground">
          {published ? "This appends to a branch the remote already has." : "This publishes the branch for the first time. Telar never force-pushes."}
        </span>
      </p>
      <div className="flex items-center gap-1.5">
        <Button type="button" size="xs" variant="ghost" onClick={publish.disarm} disabled={working}>
          Cancel
        </Button>
        <Button type="button" size="xs" onClick={() => void publish.push()} disabled={working}>
          {working ? <Spinner className="size-3" /> : <ArrowUpFromLineIcon className="size-3" />}
          {working ? "Pushing…" : "Push"}
        </Button>
      </div>
    </div>
  );
}

function PullRequestForm({ publish }: { publish: Publish }) {
  const { working, title, body } = publish;
  return (
    <div className="flex flex-col gap-2">
      <input
        type="text"
        value={title}
        onChange={(event) => publish.setTitle(event.target.value)}
        aria-label="Pull request title"
        autoFocus
        className="w-full rounded-md border border-input bg-background p-2 text-xs outline-none focus-visible:border-ring"
      />
      <textarea
        value={body}
        onChange={(event) => publish.setBody(event.target.value)}
        rows={3}
        aria-label="Pull request description"
        placeholder="Description (optional)"
        className="w-full resize-none rounded-md border border-input bg-background p-2 text-xs outline-none focus-visible:border-ring"
      />
      <p className="text-2xs leading-snug text-muted-foreground">
        This happens on GitHub and cannot be undone from Telar. The description carries this session&rsquo;s id, so the conversation
        behind it is findable.
      </p>
      <div className="flex items-center gap-1.5">
        <Button type="button" size="xs" variant="ghost" onClick={publish.disarm} disabled={working}>
          Cancel
        </Button>
        <Button type="button" size="xs" onClick={() => void publish.openPull()} disabled={working || !title.trim()}>
          {working ? <Spinner className="size-3" /> : <GitPullRequestArrowIcon className="size-3" />}
          {working ? "Opening…" : "Open pull request"}
        </Button>
      </div>
    </div>
  );
}

function PublishArms({
  publish,
  github,
  ahead,
  commitsSinceBase,
  busy,
}: {
  publish: Publish;
  github: boolean | undefined;
  ahead: number | undefined;
  commitsSinceBase: number;
  busy: boolean;
}) {
  const published = ahead !== undefined;
  const pushable = !published || ahead > 0;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-2xs leading-snug text-muted-foreground">
        {!published
          ? `origin has never seen this branch${commitsSinceBase > 0 ? ` — ${commitsSinceBase} ${commitsSinceBase === 1 ? "commit" : "commits"} to publish` : ""}.`
          : ahead > 0
            ? `${ahead} ${ahead === 1 ? "commit" : "commits"} not on origin yet.`
            : "origin has every commit on this branch."}
      </p>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={busy || !pushable}
          title={busy ? "A turn is running — the agent may be mid-write" : undefined}
          onClick={publish.armPush}
        >
          <ArrowUpFromLineIcon className="size-3" />
          Push
        </Button>
        {github === true && !publish.opened && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy || !published}
            title={!published ? "Push the branch first — a pull request needs a branch the remote has" : undefined}
            onClick={publish.armPull}
          >
            <GitPullRequestArrowIcon className="size-3" />
            Pull request
          </Button>
        )}
      </div>
    </div>
  );
}

function PublishProblem({ children, onDismiss }: { children: React.ReactNode; onDismiss: () => void }) {
  return (
    <div className="mb-2 flex items-start gap-2 text-2xs leading-snug">
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1">
        {children}
        <Button type="button" size="xs" variant="ghost" className="mt-1.5" onClick={onDismiss}>
          Dismiss
        </Button>
      </span>
    </div>
  );
}
