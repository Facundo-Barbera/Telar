"use client";

// LANE: project (NEW) — project-github-tab. The project hub REFRAMED around the
// thing the owner actually lives in: GitHub. The old hub was full-width and read
// "like a view tree, not something you can navigate and check out things from."
// This entry:
//
//  • CONSTRAINS the whole hub to the app-standard content column (max-w-6xl,
//    matching the dashboard app/page.tsx) — the owner flagged the hub was the one
//    full-width surface. Header, tab strip and every tab render centered.
//  • RENAMES the tab strip to Sessions | Looms | GitHub | Settings (Git → GitHub,
//    Files cut — "we're building an AI dev app, focus on that").
//  • The GitHub tab is avatar-first and has four sub-views:
//     FOR YOU (default) — review requested / assigned / mentions / your failing
//        checks. One glance = what needs me.
//     ISSUES + PRS — master-detail: list stays left (search + Open/Mine/Review-
//        requested chips, j/k), detail fills the right, with GitHub-grade
//        fidelity: real avatars, colored label pills, state glyphs, checks
//        clusters, review chips, head→base mono, rendered markdown + threads.
//     REPO (compact corner) — worktrees w/ reclaimable + the NEW conflict-radar
//        chip per branch (dry `git merge-tree`), compact branches, cleanup.
//  • BRIDGE ACTIONS make it Telar, not a mirror: issue → "Work on this"
//    (pre-seeded new-session sheet) and "Weave loom from issue" (charter seed);
//    PR → "Check out" (local worktree) and "Land" (guarded gates→ff-merge→push→
//    delete/reclaim pipeline, per-step results).
//
// REPLAY: re-running #146's checks flips its red check green → it leaves For
// You's "failing checks". Both themes via the shared StageFrame token wrapper;
// no `dark:` utilities. Fixture-driven and replayable.
//
// DATA HONESTY (carried from git-fixtures): issues/PRs = `gh` CLI, auth-gated,
// read-first; worktrees/branches = git plumbing, real today; conflict radar =
// dry merge-tree (flagged at its source); sizes are `du` estimates (~).
import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  ArrowRightIcon,
  AtSignIcon,
  CheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CheckCircle2Icon,
  ClockIcon,
  EyeIcon,
  FolderGit2Icon,
  FolderSymlinkIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  InboxIcon,
  Loader2Icon,
  MessageSquareIcon,
  MessagesSquareIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserCheckIcon,
  WorkflowIcon,
  XCircleIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtAgo } from "@/lib/format";
import { DEMO_PROJECT } from "./fixtures";
import {
  AvatarStack,
  GhAvatar,
  GitChip,
  fmtSize,
} from "./git-shared";
import { StageFrame, type Theme } from "./shared";
import {
  DEMO_BRANCHES,
  DEMO_ISSUES,
  DEMO_PRS,
  DEMO_WORKTREES,
  ME,
  assignedIssues,
  checksVerdict,
  ghUser,
  isReclaimable,
  labelColor,
  mentionFeed,
  myFailingPRs,
  reviewRequestedPRs,
  type ChecksCluster,
  type DemoBranch,
  type DemoIssue,
  type DemoPR,
  type DemoWorktree,
  type RemoteState,
} from "./git-fixtures";

// The project's own gate facts (telar.yaml green-gate) — seeds the charter and
// the Land pipeline so the mocks quote real commands.
const PROJECT_GATES = [
  "bun test packages/core",
  "tsc -p apps/web --noEmit",
  "tsc -p packages/core --noEmit",
];

// lucide dropped brand marks — inline the GitHub octocat so the tab reads as
// GitHub, not a generic branch glyph.
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="currentColor" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 012-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/* ============================================================ markdown */

// A deliberately small markdown renderer — enough for issue/PR bodies + comments
// (headers, bullet lists, fenced code, **bold**, `code`, @mentions). Not a full
// parser; the fixtures stay within this grammar.
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|@[\w-]+|#\d+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**"))
      out.push(
        <strong key={i++} className="font-semibold text-foreground">
          {tok.slice(2, -2)}
        </strong>,
      );
    else if (tok.startsWith("`"))
      out.push(
        <code
          key={i++}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    else
      out.push(
        <span key={i++} className="font-medium text-sky-400">
          {tok}
        </span>,
      );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <pre
          key={key++}
          className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs text-foreground"
        >
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push(
        <h4 key={key++} className="text-sm font-semibold text-foreground">
          {renderInline(line.slice(3))}
        </h4>,
      );
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push(
        <h3 key={key++} className="text-base font-semibold text-foreground">
          {renderInline(line.slice(2))}
        </h3>,
      );
      i++;
      continue;
    }
    if (line.trimStart().startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("- ")) {
        items.push(lines[i].trimStart().slice(2));
        i++;
      }
      blocks.push(
        <ul key={key++} className="space-y-1">
          {items.map((it, j) => (
            <li key={j} className="flex gap-2 text-sm text-muted-foreground">
              <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
              <span className="min-w-0">{renderInline(it)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }
    blocks.push(
      <p key={key++} className="text-sm leading-relaxed text-muted-foreground">
        {renderInline(line)}
      </p>,
    );
    i++;
  }
  return <div className="space-y-2">{blocks}</div>;
}

/* ============================================================ glyphs + chips */

function IssueStateGlyph({ state }: { state: RemoteState }) {
  if (state === "open")
    return <CircleDotIcon className="size-4 shrink-0 text-emerald-400" />;
  return <CheckCircle2Icon className="size-4 shrink-0 text-violet-400" />;
}

function PrStateGlyph({ state }: { state: RemoteState }) {
  switch (state) {
    case "open":
      return <GitPullRequestIcon className="size-4 shrink-0 text-emerald-400" />;
    case "draft":
      return (
        <GitPullRequestDraftIcon className="size-4 shrink-0 text-muted-foreground" />
      );
    case "merged":
      return <GitMergeIcon className="size-4 shrink-0 text-violet-400" />;
    default:
      return (
        <GitPullRequestClosedIcon className="size-4 shrink-0 text-rose-400" />
      );
  }
}

function StatePill({ state, kind }: { state: RemoteState; kind: "issue" | "pr" }) {
  const map: Record<RemoteState, { label: string; cls: string }> = {
    open: {
      label: kind === "pr" ? "Open" : "Open",
      cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    },
    draft: {
      label: "Draft",
      cls: "border-border bg-muted/50 text-muted-foreground",
    },
    merged: {
      label: "Merged",
      cls: "border-violet-500/30 bg-violet-500/10 text-violet-300",
    },
    closed: {
      label: "Closed",
      cls: "border-violet-500/30 bg-violet-500/10 text-violet-300",
    },
  };
  const s = map[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        s.cls,
      )}
    >
      {kind === "issue" ? (
        <IssueStateGlyph state={state} />
      ) : (
        <PrStateGlyph state={state} />
      )}
      {s.label}
    </span>
  );
}

function LabelPill({ name }: { name: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0 text-[10px] font-medium",
        labelColor(name),
      )}
    >
      {name}
    </span>
  );
}

function ChecksChip({ checks }: { checks: ChecksCluster }) {
  const v = checksVerdict(checks);
  if (v === "none") return null;
  const total = checks.passed + checks.failed + checks.pending;
  const lead =
    v === "fail"
      ? { Icon: XCircleIcon, cls: "text-rose-400" }
      : v === "pending"
        ? { Icon: ClockIcon, cls: "text-amber-400" }
        : { Icon: CheckCircle2Icon, cls: "text-emerald-400" };
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1"
      title={`${checks.passed}/${total} checks passed${checks.failed ? `, ${checks.failed} failed` : ""}${checks.pending ? `, ${checks.pending} pending` : ""}`}
    >
      <lead.Icon className={cn("size-3.5", lead.cls)} />
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
        {checks.passed}/{total}
      </span>
    </span>
  );
}

function HeadBase({ head, base }: { head: string; base: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-muted-foreground">
      <span className="truncate">{head}</span>
      <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground/50" />
      <span className="shrink-0 text-muted-foreground/80">{base}</span>
    </span>
  );
}

function LinkedLoomChip({ id }: { id: string }) {
  return (
    <GitChip
      tone="active"
      className="border-indigo-500/30 bg-indigo-500/10 text-indigo-300"
    >
      <WorkflowIcon className="size-2.5" />
      {id}
    </GitChip>
  );
}

function AuthorLine({
  login,
  action,
  at,
}: {
  login: string;
  action: string;
  at: number;
}) {
  const u = ghUser(login);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <GhAvatar login={login} size={16} />
      <span className="truncate">
        <span className="font-medium text-foreground">{u.login}</span> {action}{" "}
        {fmtAgo(at)}
      </span>
    </span>
  );
}

/* ============================================================ row content */

// Presentational rows — a plain div, so the click wrapper is supplied by the
// caller (a <button> in For You + master lists) without nesting buttons.
function IssueRowContent({
  issue,
  selected,
}: {
  issue: DemoIssue;
  selected: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex items-start gap-2.5 py-2.5 pr-3 pl-4 transition-colors",
        selected ? "bg-primary/10" : "hover:bg-muted/40",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full",
          selected ? "bg-primary opacity-100" : "opacity-0",
        )}
      />
      <GhAvatar login={issue.author} size={22} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <IssueStateGlyph state={issue.state} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {issue.title}
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            #{issue.number}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {issue.labels.map((l) => (
            <LabelPill key={l} name={l} />
          ))}
          <span className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground/70">
            {issue.thread.length > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <MessageSquareIcon className="size-3" />
                {issue.thread.length}
              </span>
            )}
            <span>{fmtAgo(issue.updatedAt)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function PrRowContent({ pr, selected }: { pr: DemoPR; selected: boolean }) {
  const reviewers = pr.reviewers.map((r) => r.login);
  return (
    <div
      className={cn(
        "relative flex items-start gap-2.5 py-2.5 pr-3 pl-4 transition-colors",
        selected ? "bg-primary/10" : "hover:bg-muted/40",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full",
          selected ? "bg-primary opacity-100" : "opacity-0",
        )}
      />
      <GhAvatar login={pr.author} size={22} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <PrStateGlyph state={pr.state} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {pr.title}
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            #{pr.number}
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2">
          <HeadBase head={pr.branch} base={pr.base} />
          {pr.linkedLoomId && <LinkedLoomChip id={pr.linkedLoomId} />}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <ChecksChip checks={pr.checks} />
          {reviewers.length > 0 && <AvatarStack logins={reviewers} size={16} />}
          <span className="ml-auto text-[11px] text-muted-foreground/70">
            {fmtAgo(pr.updatedAt)}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ For You */

function ClickableRow({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} className="block w-full text-left">
      {children}
    </button>
  );
}

function ForYouSection({
  icon: Icon,
  tint,
  label,
  count,
  emptyLabel,
  children,
}: {
  icon: LucideIcon;
  tint: string;
  label: string;
  count: number;
  emptyLabel: string;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon className={cn("size-4", tint)} />
        <span className="text-xs font-semibold tracking-wide text-foreground uppercase">
          {label}
        </span>
        <Badge
          variant="outline"
          className="px-1.5 py-0 font-mono text-[10px] text-muted-foreground"
        >
          {count}
        </Badge>
      </header>
      {count === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="divide-y divide-border">{children}</div>
      )}
    </section>
  );
}

function ForYouView({
  prs,
  onOpenIssue,
  onOpenPr,
}: {
  prs: DemoPR[];
  onOpenIssue: (n: number) => void;
  onOpenPr: (n: number) => void;
}) {
  const reviewPRs = reviewRequestedPRs(prs);
  const assigned = assignedIssues(DEMO_ISSUES);
  const mentions = mentionFeed(DEMO_ISSUES, prs);
  const failing = myFailingPRs(prs);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-3 p-4">
        <p className="text-xs text-muted-foreground">
          What needs you on{" "}
          <span className="font-medium text-foreground">
            {DEMO_PROJECT.name}
          </span>{" "}
          — as{" "}
          <span className="inline-flex items-center gap-1 align-middle">
            <GhAvatar login={ME} size={14} />
            <span className="font-medium text-foreground">@{ME}</span>
          </span>
          .
        </p>

        <ForYouSection
          icon={EyeIcon}
          tint="text-sky-400"
          label="Review requested"
          count={reviewPRs.length}
          emptyLabel="No reviews waiting on you."
        >
          {reviewPRs.map((pr) => (
            <ClickableRow key={pr.number} onClick={() => onOpenPr(pr.number)}>
              <PrRowContent pr={pr} selected={false} />
            </ClickableRow>
          ))}
        </ForYouSection>

        <ForYouSection
          icon={UserCheckIcon}
          tint="text-violet-400"
          label="Assigned to you"
          count={assigned.length}
          emptyLabel="Nothing assigned to you."
        >
          {assigned.map((issue) => (
            <ClickableRow
              key={issue.number}
              onClick={() => onOpenIssue(issue.number)}
            >
              <IssueRowContent issue={issue} selected={false} />
            </ClickableRow>
          ))}
        </ForYouSection>

        <ForYouSection
          icon={AtSignIcon}
          tint="text-amber-400"
          label="Mentions"
          count={mentions.length}
          emptyLabel="No new mentions."
        >
          {mentions.map((ref) =>
            ref.kind === "issue" ? (
              <ClickableRow
                key={`i-${ref.item.number}`}
                onClick={() => onOpenIssue(ref.item.number)}
              >
                <IssueRowContent issue={ref.item} selected={false} />
              </ClickableRow>
            ) : (
              <ClickableRow
                key={`p-${ref.item.number}`}
                onClick={() => onOpenPr(ref.item.number)}
              >
                <PrRowContent pr={ref.item} selected={false} />
              </ClickableRow>
            ),
          )}
        </ForYouSection>

        <ForYouSection
          icon={failing.length > 0 ? TriangleAlertIcon : ShieldCheckIcon}
          tint={failing.length > 0 ? "text-rose-400" : "text-emerald-400"}
          label="Your PRs with failing checks"
          count={failing.length}
          emptyLabel="None of your PRs have failing checks."
        >
          {failing.map((pr) => (
            <ClickableRow key={pr.number} onClick={() => onOpenPr(pr.number)}>
              <PrRowContent pr={pr} selected={false} />
            </ClickableRow>
          ))}
        </ForYouSection>
      </div>
    </div>
  );
}

/* ============================================================ master-detail */

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 w-full rounded-md border border-border bg-background/60 pr-2.5 pl-8 text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:bg-background focus:ring-2 focus:ring-ring/30"
      />
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[9px] text-muted-foreground">
      {children}
    </kbd>
  );
}

type ChipDef<T> = { key: string; label: string; test: (x: T) => boolean };

function MasterDetail<T>({
  items,
  getId,
  search,
  searchPlaceholder,
  chips,
  selectedId,
  onSelect,
  renderRow,
  renderDetail,
  emptyLabel,
}: {
  items: T[];
  getId: (x: T) => string;
  search: (x: T, q: string) => boolean;
  searchPlaceholder: string;
  chips: ChipDef<T>[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  renderRow: (x: T, selected: boolean) => ReactNode;
  renderDetail: (x: T) => ReactNode;
  emptyLabel: string;
}) {
  const [chipKey, setChipKey] = useState(chips[0].key);
  const [q, setQ] = useState("");
  const chip = chips.find((c) => c.key === chipKey) ?? chips[0];
  const query = q.trim().toLowerCase();
  const filtered = useMemo(
    () => items.filter((x) => chip.test(x) && (query ? search(x, query) : true)),
    [items, chip, query, search],
  );

  const selected = filtered.find((x) => getId(x) === selectedId) ?? null;

  // keep a valid selection as filters/search narrow the list
  useEffect(() => {
    if (filtered.length === 0) return;
    if (!filtered.some((x) => getId(x) === selectedId)) {
      onSelect(getId(filtered[0]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, selectedId]);

  const move = (dir: 1 | -1) => {
    if (filtered.length === 0) return;
    const idx = Math.max(
      0,
      filtered.findIndex((x) => getId(x) === selectedId),
    );
    const next = (idx + dir + filtered.length) % filtered.length;
    onSelect(getId(filtered[next]));
  };

  return (
    <div className="flex h-full min-h-0">
      <div
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "j") {
            e.preventDefault();
            move(1);
          } else if (e.key === "k") {
            e.preventDefault();
            move(-1);
          }
        }}
        className="flex h-full w-72 shrink-0 flex-col border-r border-border outline-none focus-visible:ring-1 focus-visible:ring-ring/40 focus-visible:ring-inset"
      >
        <div className="shrink-0 space-y-2 border-b border-border p-2.5">
          <SearchBox
            value={q}
            onChange={setQ}
            placeholder={searchPlaceholder}
          />
          <div className="flex flex-wrap items-center gap-1">
            {chips.map((c) => (
              <FilterChip
                key={c.key}
                active={c.key === chipKey}
                onClick={() => setChipKey(c.key)}
              >
                {c.label}
                <span className="font-mono tabular-nums opacity-70">
                  {items.filter(c.test).length}
                </span>
              </FilterChip>
            ))}
            <span
              className="ml-auto flex items-center gap-0.5"
              title="Move selection with j / k"
            >
              <Kbd>j</Kbd>
              <Kbd>k</Kbd>
            </span>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-muted-foreground">
              {emptyLabel}
            </p>
          ) : (
            <div className="divide-y divide-border">
              {filtered.map((x) => (
                <button
                  key={getId(x)}
                  type="button"
                  onClick={() => onSelect(getId(x))}
                  className="block w-full text-left"
                >
                  {renderRow(x, getId(x) === selectedId)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {selected ? (
          renderDetail(selected)
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
            Select an item to see it here.
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================ detail: shared */

function DetailHeader({
  kind,
  state,
  number,
  title,
}: {
  kind: "issue" | "pr";
  state: RemoteState;
  number: number;
  title: string;
}) {
  return (
    <div className="border-b border-border px-4 py-3">
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-base font-semibold leading-snug text-foreground">
          {title}{" "}
          <span className="font-mono text-sm font-normal text-muted-foreground">
            #{number}
          </span>
        </h2>
        <StatePill state={state} kind={kind} />
      </div>
    </div>
  );
}

function BodyCard({
  login,
  at,
  body,
  authored = false,
}: {
  login: string;
  at: number;
  body: string;
  authored?: boolean;
}) {
  return (
    <div className="flex gap-2.5">
      <GhAvatar login={login} size={28} className="mt-0.5" />
      <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-border">
        <div
          className={cn(
            "flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs",
            authored ? "bg-primary/5" : "bg-muted/30",
          )}
        >
          <span className="font-medium text-foreground">{ghUser(login).login}</span>
          <span className="text-muted-foreground">commented {fmtAgo(at)}</span>
          {authored && (
            <Badge
              variant="outline"
              className="ml-auto px-1.5 py-0 text-[10px] text-muted-foreground"
            >
              author
            </Badge>
          )}
        </div>
        <div className="px-3 py-2.5">
          <Markdown text={body} />
        </div>
      </div>
    </div>
  );
}

function Composer({ placeholder }: { placeholder: string }) {
  const [text, setText] = useState("");
  return (
    <div className="flex gap-2.5">
      <GhAvatar login={ME} size={28} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          rows={2}
          className="w-full resize-none rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:bg-background focus:ring-2 focus:ring-ring/30"
        />
        <div className="mt-1.5 flex justify-end">
          <Button size="sm" variant="outline" disabled={!text.trim()}>
            <MessageSquareIcon />
            Comment
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ issue detail */

function IssueDetail({
  issue,
  onWorkOn,
  onWeave,
}: {
  issue: DemoIssue;
  onWorkOn: () => void;
  onWeave: () => void;
}) {
  return (
    <div>
      <DetailHeader
        kind="issue"
        state={issue.state}
        number={issue.number}
        title={issue.title}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2">
        <AuthorLine login={issue.author} action="opened" at={issue.updatedAt} />
        {issue.labels.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {issue.labels.map((l) => (
              <LabelPill key={l} name={l} />
            ))}
          </div>
        )}
        {issue.assignees.length > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Assignees</span>
            <AvatarStack logins={issue.assignees} size={18} />
          </span>
        )}
      </div>

      {/* BRIDGE ACTIONS — what makes this Telar, not a GitHub mirror */}
      {issue.state === "open" && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background/40 px-4 py-2.5">
          <Button size="sm" onClick={onWorkOn}>
            <SparklesIcon />
            Work on this
          </Button>
          <Button size="sm" variant="outline" onClick={onWeave}>
            <WorkflowIcon />
            Weave loom from issue
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost">
              <MessageSquareIcon />
              Comment
            </Button>
            <Button size="sm" variant="ghost">
              <CircleDotIcon />
              Close
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-4 p-4">
        <BodyCard
          login={issue.author}
          at={issue.updatedAt}
          body={issue.body}
          authored
        />
        {issue.thread.map((c, i) => (
          <BodyCard key={i} login={c.author} at={c.createdAt} body={c.body} />
        ))}
        {issue.state === "open" && (
          <Composer placeholder={`Comment on #${issue.number}…`} />
        )}
      </div>
    </div>
  );
}

/* ============================================================ PR detail */

const REVIEWER_STATE: Record<
  string,
  { label: string; cls: string; Icon: LucideIcon }
> = {
  approved: {
    label: "approved",
    cls: "text-emerald-400",
    Icon: CheckCircle2Icon,
  },
  changes_requested: {
    label: "requested changes",
    cls: "text-amber-400",
    Icon: XCircleIcon,
  },
  commented: {
    label: "commented",
    cls: "text-muted-foreground",
    Icon: MessageSquareIcon,
  },
  pending: {
    label: "review requested",
    cls: "text-sky-400",
    Icon: CircleDashedIcon,
  },
};

function CheckRunsBlock({ pr }: { pr: DemoPR }) {
  const verdict = checksVerdict(pr.checks);
  const head =
    verdict === "fail"
      ? { Icon: XCircleIcon, cls: "text-rose-400", label: "Some checks failed" }
      : verdict === "pending"
        ? {
            Icon: ClockIcon,
            cls: "text-amber-400",
            label: "Some checks are pending",
          }
        : {
            Icon: CheckCircle2Icon,
            cls: "text-emerald-400",
            label: "All checks passed",
          };
  const runIcon = (s: string) =>
    s === "passed"
      ? { Icon: CheckCircle2Icon, cls: "text-emerald-400" }
      : s === "failed"
        ? { Icon: XCircleIcon, cls: "text-rose-400" }
        : { Icon: ClockIcon, cls: "text-amber-400" };
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
        <head.Icon className={cn("size-4", head.cls)} />
        <span className="text-xs font-medium text-foreground">{head.label}</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {pr.checks.passed}/
          {pr.checks.passed + pr.checks.failed + pr.checks.pending}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {pr.checkRuns.map((r) => {
          const ic = runIcon(r.status);
          return (
            <li
              key={r.name}
              className="flex items-center gap-2 px-3 py-1.5 text-xs"
            >
              <ic.Icon className={cn("size-3.5 shrink-0", ic.cls)} />
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                {r.name}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground/70">
                {r.status}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PrDetail({
  pr,
  onCheckOut,
  onLand,
}: {
  pr: DemoPR;
  onCheckOut: () => void;
  onLand: () => void;
}) {
  const openish = pr.state === "open" || pr.state === "draft";
  return (
    <div>
      <DetailHeader
        kind="pr"
        state={pr.state}
        number={pr.number}
        title={pr.title}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2">
        <AuthorLine login={pr.author} action="opened" at={pr.updatedAt} />
        <HeadBase head={pr.branch} base={pr.base} />
        {pr.linkedLoomId && <LinkedLoomChip id={pr.linkedLoomId} />}
        <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-0.5">
            <GitCommitHorizontalIcon className="size-3.5" />
            {pr.commits}
          </span>
          <span>{pr.filesChanged} files</span>
          <span className="text-emerald-400">+{pr.additions}</span>
          <span className="text-rose-400">−{pr.deletions}</span>
        </span>
      </div>

      {/* BRIDGE ACTIONS */}
      {openish && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background/40 px-4 py-2.5">
          <Button size="sm" onClick={onCheckOut}>
            <FolderSymlinkIcon />
            Check out
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
            onClick={onLand}
          >
            <GitMergeIcon />
            Land
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost">
              <MessageSquareIcon />
              Comment
            </Button>
            <Button size="sm" variant="ghost">
              <GitPullRequestClosedIcon />
              Close
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-4 p-4">
        <CheckRunsBlock pr={pr} />

        {pr.reviewers.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="border-b border-border bg-muted/30 px-3 py-2 text-xs font-medium text-foreground">
              Reviewers
            </div>
            <ul className="divide-y divide-border">
              {pr.reviewers.map((r) => {
                const s = REVIEWER_STATE[r.state];
                return (
                  <li
                    key={r.login}
                    className="flex items-center gap-2 px-3 py-1.5"
                  >
                    <GhAvatar login={r.login} size={20} />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                      {ghUser(r.login).login}
                    </span>
                    <span
                      className={cn(
                        "inline-flex shrink-0 items-center gap-1 text-[11px]",
                        s.cls,
                      )}
                    >
                      <s.Icon className="size-3.5" />
                      {s.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <BodyCard login={pr.author} at={pr.updatedAt} body={pr.body} authored />
        {pr.thread.map((c, i) => (
          <BodyCard key={i} login={c.author} at={c.createdAt} body={c.body} />
        ))}
        {openish && <Composer placeholder={`Comment on #${pr.number}…`} />}
      </div>
    </div>
  );
}

/* ============================================================ issues + prs */

function IssuesView({
  selectedId,
  onSelect,
  onWorkOn,
  onWeave,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onWorkOn: (issue: DemoIssue) => void;
  onWeave: (issue: DemoIssue) => void;
}) {
  const chips: ChipDef<DemoIssue>[] = [
    { key: "open", label: "Open", test: (i) => i.state === "open" },
    {
      key: "mine",
      label: "Mine",
      test: (i) => i.author === ME || i.assignees.includes(ME),
    },
    {
      key: "assigned",
      label: "Assigned",
      test: (i) => i.assignees.includes(ME),
    },
  ];
  return (
    <MasterDetail
      items={DEMO_ISSUES}
      getId={(i) => String(i.number)}
      selectedId={selectedId}
      onSelect={onSelect}
      searchPlaceholder="Search issues…"
      emptyLabel="No issues match."
      search={(i, q) =>
        i.title.toLowerCase().includes(q) ||
        `#${i.number}`.includes(q) ||
        i.author.toLowerCase().includes(q) ||
        i.labels.some((l) => l.toLowerCase().includes(q))
      }
      chips={chips}
      renderRow={(i, sel) => <IssueRowContent issue={i} selected={sel} />}
      renderDetail={(i) => (
        <IssueDetail
          issue={i}
          onWorkOn={() => onWorkOn(i)}
          onWeave={() => onWeave(i)}
        />
      )}
    />
  );
}

function PrsView({
  prs,
  selectedId,
  onSelect,
  onCheckOut,
  onLand,
}: {
  prs: DemoPR[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCheckOut: (pr: DemoPR) => void;
  onLand: (pr: DemoPR) => void;
}) {
  const chips: ChipDef<DemoPR>[] = [
    {
      key: "open",
      label: "Open",
      test: (p) => p.state === "open" || p.state === "draft",
    },
    { key: "mine", label: "Mine", test: (p) => p.author === ME },
    {
      key: "review",
      label: "Review requested",
      test: (p) => p.reviewers.some((r) => r.login === ME && r.state === "pending"),
    },
  ];
  return (
    <MasterDetail
      items={prs}
      getId={(p) => String(p.number)}
      selectedId={selectedId}
      onSelect={onSelect}
      searchPlaceholder="Search pull requests…"
      emptyLabel="No pull requests match."
      search={(p, q) =>
        p.title.toLowerCase().includes(q) ||
        `#${p.number}`.includes(q) ||
        p.author.toLowerCase().includes(q) ||
        p.branch.toLowerCase().includes(q) ||
        p.base.toLowerCase().includes(q)
      }
      chips={chips}
      renderRow={(p, sel) => <PrRowContent pr={p} selected={sel} />}
      renderDetail={(p) => (
        <PrDetail
          pr={p}
          onCheckOut={() => onCheckOut(p)}
          onLand={() => onLand(p)}
        />
      )}
    />
  );
}

/* ============================================================ Repo */

function ConflictChip({ conflict }: { conflict: DemoBranch["conflict"] }) {
  if (!conflict) return null;
  if (conflict.clean) {
    return (
      <GitChip tone="reclaimable">
        <CheckIcon className="size-2.5" />
        merges clean
      </GitChip>
    );
  }
  return (
    <GitChip tone="dirty">
      <TriangleAlertIcon className="size-2.5" />
      conflicts · {conflict.files} files
    </GitChip>
  );
}

function CleanupDialog({
  worktrees,
  onCancel,
  onConfirm,
}: {
  worktrees: DemoWorktree[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const totalMb = worktrees.reduce((n, w) => n + w.sizeMb, 0);
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onCancel}
        className="absolute inset-0 bg-background/70 backdrop-blur-sm"
      />
      <div className="relative flex max-h-full w-full max-w-sm flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Trash2Icon className="size-4 text-destructive" />
          <h2 className="text-sm font-semibold">
            Clean up {worktrees.length} worktree
            {worktrees.length === 1 ? "" : "s"}
          </h2>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Removes these merged, clean trees Telar proved safe. This cannot be
            undone.
          </p>
          <ul className="mt-3 space-y-1.5">
            {worktrees.map((w) => (
              <li
                key={w.id}
                className="flex items-center gap-2 rounded-md border border-border bg-background/50 px-2.5 py-1.5"
              >
                <GitChip tone="reclaimable">safe</GitChip>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-xs"
                  title={w.path}
                >
                  {w.basename}
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  {fmtSize(w.sizeMb)}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            frees {fmtSize(totalMb)}
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" variant="destructive" onClick={onConfirm}>
              <Trash2Icon />
              Remove
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RepoView() {
  const [worktrees, setWorktrees] = useState<DemoWorktree[]>(DEMO_WORKTREES);
  const [dialog, setDialog] = useState(false);
  const [deletedBranches, setDeletedBranches] = useState<Set<string>>(new Set());

  const reclaimable = worktrees.filter(isReclaimable);
  const reclaimMb = reclaimable.reduce((n, w) => n + w.sizeMb, 0);
  const branches = DEMO_BRANCHES.filter((b) => !deletedBranches.has(b.name));
  const mergedBranches = branches.filter((b) => b.merged && !b.isDefault);

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-4 p-4">
        {/* WORKTREES */}
        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <GitBranchIcon className="size-4 text-muted-foreground" />
            <span className="text-xs font-semibold tracking-wide text-foreground uppercase">
              Worktrees
            </span>
            <Badge
              variant="outline"
              className="px-1.5 py-0 font-mono text-[10px] text-muted-foreground"
            >
              {worktrees.length}
            </Badge>
            {reclaimable.length > 0 && (
              <span className="flex items-center gap-1.5 rounded-md border border-emerald-500/25 bg-emerald-500/5 px-2 py-0.5 text-[11px]">
                <Trash2Icon className="size-3 text-emerald-400" />
                <span className="font-mono font-medium tabular-nums text-emerald-300">
                  {fmtSize(reclaimMb)}
                </span>
                <span className="text-muted-foreground">reclaimable</span>
              </span>
            )}
            <Button
              size="sm"
              variant="destructive"
              className="ml-auto"
              disabled={reclaimable.length === 0}
              onClick={() => setDialog(true)}
            >
              <Trash2Icon />
              Clean up
              {reclaimable.length > 0 && (
                <span className="font-mono tabular-nums">
                  {reclaimable.length}
                </span>
              )}
            </Button>
          </header>
          <p className="px-3 pt-2 text-[11px] text-muted-foreground">
            Reclaimable = merged, clean, and not backing an active loom — Telar
            proves it, so you never reverse-engineer safety.
          </p>
          <div className="divide-y divide-border">
            {worktrees.map((w) => {
              const rec = isReclaimable(w);
              return (
                <div
                  key={w.id}
                  className="flex items-start gap-2.5 px-3 py-2"
                >
                  <FolderGit2Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className="truncate font-mono text-xs font-medium"
                        title={w.path}
                      >
                        {w.basename}
                      </span>
                      {w.owner.kind === "loom" ? (
                        <LinkedLoomChip id={w.owner.loomId} />
                      ) : (
                        <GitChip tone="muted">manual</GitChip>
                      )}
                      {rec ? (
                        <GitChip tone="reclaimable">
                          <Trash2Icon className="size-2.5" />
                          reclaimable
                        </GitChip>
                      ) : (
                        <>
                          {w.dirty && <GitChip tone="dirty">dirty</GitChip>}
                          {!w.merged && (
                            <GitChip tone="stale">un-merged</GitChip>
                          )}
                        </>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <GitBranchIcon className="size-3 shrink-0" />
                      <span className="truncate font-mono">{w.branch}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end">
                    <span className="font-mono text-[11px] tabular-nums text-foreground">
                      {fmtSize(w.sizeMb)}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {fmtAgo(w.updatedAt)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* BRANCHES + CONFLICT RADAR */}
        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <GitBranchIcon className="size-4 text-muted-foreground" />
            <span className="text-xs font-semibold tracking-wide text-foreground uppercase">
              Branches
            </span>
            <Badge
              variant="outline"
              className="px-1.5 py-0 font-mono text-[10px] text-muted-foreground"
            >
              {branches.length}
            </Badge>
            {mergedBranches.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() =>
                  setDeletedBranches((s) => {
                    const next = new Set(s);
                    mergedBranches.forEach((b) => next.add(b.name));
                    return next;
                  })
                }
              >
                <Trash2Icon />
                Delete {mergedBranches.length} merged
              </Button>
            )}
          </header>
          <p className="px-3 pt-2 text-[11px] text-muted-foreground">
            Conflict radar is a dry{" "}
            <span className="font-mono text-foreground">git merge-tree</span> vs{" "}
            <span className="font-mono text-foreground">main</span> — no
            working-tree touch.
          </p>
          <div className="divide-y divide-border">
            {branches.map((b) => (
              <div key={b.name} className="flex items-center gap-2.5 px-3 py-2">
                <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className="truncate font-mono text-xs font-medium"
                      title={b.name}
                    >
                      {b.name}
                    </span>
                    {b.isDefault && (
                      <Badge
                        variant="outline"
                        className="shrink-0 border-primary/40 bg-primary/10 px-1.5 py-0 text-[10px] text-primary"
                      >
                        default
                      </Badge>
                    )}
                    {b.merged && !b.isDefault && (
                      <GitChip tone="merged">merged</GitChip>
                    )}
                    <ConflictChip conflict={b.conflict} />
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    <span className="font-mono text-muted-foreground/80">
                      {b.sha}
                    </span>{" "}
                    {b.subject}
                  </div>
                </div>
                <span className="shrink-0 text-[11px] text-muted-foreground/70">
                  {fmtAgo(b.updatedAt)}
                </span>
                <div className="flex w-5 shrink-0 justify-end">
                  {b.merged && !b.isDefault && (
                    <button
                      type="button"
                      aria-label={`Delete ${b.name}`}
                      title="Delete merged branch"
                      onClick={() =>
                        setDeletedBranches((s) => new Set(s).add(b.name))
                      }
                      className="text-muted-foreground/60 transition-colors hover:text-destructive"
                    >
                      <Trash2Icon className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {dialog && (
        <CleanupDialog
          worktrees={reclaimable}
          onCancel={() => setDialog(false)}
          onConfirm={() => {
            const ids = new Set(reclaimable.map((w) => w.id));
            setWorktrees((ws) => ws.filter((w) => !ids.has(w.id)));
            setDialog(false);
          }}
        />
      )}
    </div>
  );
}

/* ============================================================ bridge sheets */

function Sheet({
  icon: Icon,
  title,
  onClose,
  footer,
  children,
}: {
  icon: LucideIcon;
  title: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="absolute inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className="absolute inset-0 bg-background/70 backdrop-blur-sm"
      />
      <div className="relative flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-2xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
          <Icon className="size-4 text-muted-foreground" />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {children}
        </div>
        {footer && (
          <footer className="shrink-0 border-t border-border px-4 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

function Toggle({
  on,
  onToggle,
  label,
}: {
  on: boolean;
  onToggle: () => void;
  label: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={onToggle}
        aria-label="Toggle"
        className={cn(
          "flex h-4 w-7 items-center rounded-full border px-0.5 transition-colors",
          on ? "border-primary bg-primary/30" : "border-border",
        )}
      >
        <span
          className={cn(
            "size-3 rounded-full bg-foreground transition-transform",
            on && "translate-x-3",
          )}
        />
      </button>
      {label}
    </label>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </div>
  );
}

// issue → "Work on this": a pre-seeded new-session sheet.
function WorkOnThisSheet({
  issue,
  onClose,
}: {
  issue: DemoIssue;
  onClose: () => void;
}) {
  const [freshBranch, setFreshBranch] = useState(true);
  const [prompt, setPrompt] = useState(
    `Resolve issue #${issue.number}: ${issue.title}\n\n${issue.body}`,
  );
  const [created, setCreated] = useState(false);
  const branch = `issue-${issue.number}`;

  return (
    <Sheet
      icon={SparklesIcon}
      title={`New session · #${issue.number}`}
      onClose={onClose}
      footer={
        created ? (
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300">
              <CheckCircle2Icon className="size-4" />
              Session s-24 created, seeded from #{issue.number}
            </span>
            <Button size="sm" variant="outline" onClick={onClose}>
              Open session
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => setCreated(true)}>
              <PlusIcon />
              Create session
            </Button>
          </div>
        )
      }
    >
      <p className="text-xs text-muted-foreground">
        Start a chat session already loaded with the issue — no copy-paste, no
        leaving Telar.
      </p>
      <div>
        <FieldLabel>Seeded prompt</FieldLabel>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={7}
          disabled={created}
          className="w-full resize-none rounded-lg border border-border bg-background/60 px-3 py-2 text-xs outline-none transition-colors focus:border-ring focus:bg-background focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
        />
      </div>
      <div className="rounded-lg border border-border p-3">
        <Toggle
          on={freshBranch}
          onToggle={() => setFreshBranch((b) => !b)}
          label={
            <span>
              Create a fresh branch{" "}
              <span className="font-mono text-foreground">{branch}</span> off{" "}
              <span className="font-mono text-foreground">
                {DEMO_PROJECT.branch}
              </span>
            </span>
          }
        />
        {!freshBranch && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Session will run on the current branch{" "}
            <span className="font-mono text-foreground">
              {DEMO_PROJECT.branch}
            </span>
            .
          </p>
        )}
      </div>
    </Sheet>
  );
}

// issue → "Weave loom from issue": a charter seed preview.
function WeaveLoomSheet({
  issue,
  onClose,
}: {
  issue: DemoIssue;
  onClose: () => void;
}) {
  const [woven, setWoven] = useState(false);
  return (
    <Sheet
      icon={WorkflowIcon}
      title={`Weave loom · #${issue.number}`}
      onClose={onClose}
      footer={
        woven ? (
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300">
              <CheckCircle2Icon className="size-4" />
              Loom l-14 queued · charter-review
            </span>
            <Button size="sm" variant="outline" onClick={onClose}>
              Open loom
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => setWoven(true)}>
              <WorkflowIcon />
              Weave loom
            </Button>
          </div>
        )
      }
    >
      <p className="text-xs text-muted-foreground">
        Seed a charter from the issue. You approve policy once at charter-review;
        the loom builds and verifies the rest autonomously.
      </p>
      <div className="space-y-3 rounded-lg border border-border p-3">
        <div>
          <FieldLabel>Goal</FieldLabel>
          <p className="text-sm text-foreground">{issue.title}</p>
        </div>
        <div>
          <FieldLabel>Context (from #{issue.number})</FieldLabel>
          <div className="rounded-md bg-muted/30 px-2.5 py-2">
            <Markdown text={issue.body} />
          </div>
        </div>
        <div>
          <FieldLabel>Acceptance</FieldLabel>
          <p className="text-sm text-muted-foreground">
            Issue #{issue.number} resolved; the gate below re-proves green on the
            composed whole.
          </p>
        </div>
        <div>
          <FieldLabel>Gates (project facts)</FieldLabel>
          <ul className="space-y-1">
            {PROJECT_GATES.map((g) => (
              <li
                key={g}
                className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
              >
                <ShieldCheckIcon className="size-3 text-emerald-400" />
                {g}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <FieldLabel>Branch</FieldLabel>
          <p className="font-mono text-xs text-foreground">
            loom/issue-{issue.number}
          </p>
        </div>
      </div>
    </Sheet>
  );
}

// PR → "Check out": create / open a local worktree.
function CheckOutSheet({ pr, onClose }: { pr: DemoPR; onClose: () => void }) {
  const [done, setDone] = useState(false);
  const wtPath = `/var/folders/6k/telar-worktrees/telar-co-${pr.number}`;
  return (
    <Sheet
      icon={FolderSymlinkIcon}
      title={`Check out · #${pr.number}`}
      onClose={onClose}
      footer={
        done ? (
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300">
              <CheckCircle2Icon className="size-4" />
              Worktree ready
            </span>
            <Button size="sm" variant="outline" onClick={onClose}>
              Open worktree
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => setDone(true)}>
              <FolderSymlinkIcon />
              Check out locally
            </Button>
          </div>
        )
      }
    >
      <p className="text-xs text-muted-foreground">
        Fetch the PR branch into an isolated worktree so you can run it live —
        without disturbing your current tree.
      </p>
      <div className="space-y-2 rounded-lg border border-border p-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-muted-foreground">Branch</span>
          <span className="min-w-0 truncate font-mono text-foreground">
            {pr.branch}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-muted-foreground">Base</span>
          <span className="font-mono text-foreground">{pr.base}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-muted-foreground">Path</span>
          <span className="min-w-0 truncate font-mono text-foreground">
            {wtPath}
          </span>
        </div>
      </div>
      {done && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-300">
            <FolderGit2Icon className="size-4" />
            Checked out
          </div>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {pr.branch} → {wtPath}
          </p>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Dev server can point at this tree to preview the PR live.
          </p>
        </div>
      )}
    </Sheet>
  );
}

// PR → "Land": guarded gates → ff-merge → push → optional delete + reclaim.
type LandStep = { label: string; detail: string };

function LandSheet({ pr, onClose }: { pr: DemoPR; onClose: () => void }) {
  const approved = pr.reviewers.some((r) => r.state === "approved");
  const reviewBlock = pr.reviewers
    .filter((r) => r.state === "pending" || r.state === "changes_requested")
    .map((r) => r.login);
  const checksFail = checksVerdict(pr.checks) === "fail";
  const guarded = checksFail || !approved;

  const [deleteBranch, setDeleteBranch] = useState(true);
  const [reclaim, setReclaim] = useState(true);
  const [phase, setPhase] = useState<"confirm" | "running" | "done">("confirm");
  const [step, setStep] = useState(0);

  const steps: LandStep[] = [
    { label: "Re-run gates on the composed whole", detail: PROJECT_GATES[0] },
    { label: `Fast-forward ${pr.branch} → ${pr.base}`, detail: "git merge --ff-only" },
    { label: `Push ${pr.base}`, detail: "git push origin" },
    ...(deleteBranch
      ? [{ label: `Delete ${pr.branch}`, detail: "git branch -d" } as LandStep]
      : []),
    ...(reclaim
      ? [
          {
            label: "Reclaim the PR worktree",
            detail: "git worktree remove",
          } as LandStep,
        ]
      : []),
  ];

  useEffect(() => {
    if (phase !== "running") return;
    if (step >= steps.length) {
      setPhase("done");
      return;
    }
    const id = setTimeout(() => setStep((s) => s + 1), 650);
    return () => clearTimeout(id);
  }, [phase, step, steps.length]);

  return (
    <Sheet
      icon={GitMergeIcon}
      title={`Land · #${pr.number}`}
      onClose={onClose}
      footer={
        phase === "done" ? (
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300">
              <CheckCircle2Icon className="size-4" />
              Landed into {pr.base}
            </span>
            <Button size="sm" variant="outline" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
              disabled={guarded || phase === "running"}
              onClick={() => {
                setStep(0);
                setPhase("running");
              }}
            >
              {phase === "running" ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <GitMergeIcon />
              )}
              Land it
            </Button>
          </div>
        )
      }
    >
      {guarded ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <div className="text-xs">
            <p className="font-medium text-amber-200">Blocked — not ready to land.</p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {checksFail && <li>· Checks are failing on the head.</li>}
              {!approved && reviewBlock.length > 0 && (
                <li>· Waiting on review from @{reviewBlock.join(", @")}.</li>
              )}
              {!approved && reviewBlock.length === 0 && (
                <li>· No approving review yet.</li>
              )}
            </ul>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
          <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-400" />
          <p className="text-xs text-muted-foreground">
            Checks green and an approving review on record — safe to land.
          </p>
        </div>
      )}

      <div className="space-y-2 rounded-lg border border-border p-3">
        <Toggle
          on={deleteBranch}
          onToggle={() => setDeleteBranch((b) => !b)}
          label={
            <span>
              Delete{" "}
              <span className="font-mono text-foreground">{pr.branch}</span> after
              merge
            </span>
          }
        />
        <Toggle
          on={reclaim}
          onToggle={() => setReclaim((b) => !b)}
          label="Reclaim the PR worktree"
        />
      </div>

      <div>
        <FieldLabel>Pipeline</FieldLabel>
        <ol className="space-y-1.5">
          {steps.map((s, i) => {
            const state =
              phase === "confirm"
                ? "idle"
                : i < step
                  ? "done"
                  : i === step
                    ? "running"
                    : "idle";
            return (
              <li
                key={s.label}
                className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5"
              >
                {state === "done" ? (
                  <CheckCircle2Icon className="size-4 shrink-0 text-emerald-400" />
                ) : state === "running" ? (
                  <Loader2Icon className="size-4 shrink-0 animate-spin text-sky-400" />
                ) : (
                  <CircleDashedIcon className="size-4 shrink-0 text-muted-foreground/50" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-foreground">
                    {s.label}
                  </div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                    {s.detail}
                  </div>
                </div>
                {state === "done" && (
                  <span className="shrink-0 text-[10px] text-emerald-400">
                    ok
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </Sheet>
  );
}

/* ============================================================ GitHub tab */

type SubView = "for-you" | "issues" | "prs" | "repo";

const SUB_ITEMS: {
  key: SubView;
  label: string;
  icon: LucideIcon;
}[] = [
  { key: "for-you", label: "For you", icon: InboxIcon },
  { key: "issues", label: "Issues", icon: CircleDotIcon },
  { key: "prs", label: "Pull requests", icon: GitPullRequestIcon },
  { key: "repo", label: "Repo", icon: GitBranchIcon },
];

type SheetState =
  | { kind: "work"; issue: DemoIssue }
  | { kind: "weave"; issue: DemoIssue }
  | { kind: "checkout"; pr: DemoPR }
  | { kind: "land"; pr: DemoPR }
  | null;

function GithubTab({ prs }: { prs: DemoPR[] }) {
  const [sub, setSub] = useState<SubView>("for-you");
  const [issueSel, setIssueSel] = useState<string | null>(
    String(DEMO_ISSUES[0].number),
  );
  const [prSel, setPrSel] = useState<string | null>(String(prs[0].number));
  const [sheet, setSheet] = useState<SheetState>(null);

  const counts: Record<SubView, number | null> = {
    "for-you":
      reviewRequestedPRs(prs).length +
      assignedIssues(DEMO_ISSUES).length +
      mentionFeed(DEMO_ISSUES, prs).length +
      myFailingPRs(prs).length,
    issues: DEMO_ISSUES.filter((i) => i.state === "open").length,
    prs: prs.filter((p) => p.state === "open" || p.state === "draft").length,
    repo: null,
  };

  const openIssue = (n: number) => {
    setIssueSel(String(n));
    setSub("issues");
  };
  const openPr = (n: number) => {
    setPrSel(String(n));
    setSub("prs");
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col border-x border-border">
      {/* SUB-VIEW SWITCHER */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-background/40 px-3 py-1.5">
        {SUB_ITEMS.map((it) => {
          const on = sub === it.key;
          return (
            <button
              key={it.key}
              type="button"
              onClick={() => setSub(it.key)}
              aria-current={on ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                on
                  ? "bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
              )}
            >
              <it.icon className="size-3.5" />
              {it.label}
              {counts[it.key] != null && (
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
                  {counts[it.key]}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* BODY */}
      <div className="flex min-h-0 flex-1 flex-col">
        {sub === "for-you" && (
          <ForYouView prs={prs} onOpenIssue={openIssue} onOpenPr={openPr} />
        )}
        {sub === "issues" && (
          <IssuesView
            selectedId={issueSel}
            onSelect={setIssueSel}
            onWorkOn={(issue) => setSheet({ kind: "work", issue })}
            onWeave={(issue) => setSheet({ kind: "weave", issue })}
          />
        )}
        {sub === "prs" && (
          <PrsView
            prs={prs}
            selectedId={prSel}
            onSelect={setPrSel}
            onCheckOut={(pr) => setSheet({ kind: "checkout", pr })}
            onLand={(pr) => setSheet({ kind: "land", pr })}
          />
        )}
        {sub === "repo" && <RepoView />}
      </div>

      {sheet?.kind === "work" && (
        <WorkOnThisSheet issue={sheet.issue} onClose={() => setSheet(null)} />
      )}
      {sheet?.kind === "weave" && (
        <WeaveLoomSheet issue={sheet.issue} onClose={() => setSheet(null)} />
      )}
      {sheet?.kind === "checkout" && (
        <CheckOutSheet pr={sheet.pr} onClose={() => setSheet(null)} />
      )}
      {sheet?.kind === "land" && (
        <LandSheet pr={sheet.pr} onClose={() => setSheet(null)} />
      )}
    </div>
  );
}

/* ============================================================ hub + stubs */

type HubTab = "sessions" | "looms" | "github" | "settings";

const HUB_TABS: {
  key: HubTab;
  label: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  { key: "sessions", label: "Sessions", icon: MessagesSquareIcon },
  { key: "looms", label: "Looms", icon: WorkflowIcon },
  { key: "github", label: "GitHub", icon: GithubMark },
  { key: "settings", label: "Settings", icon: SlidersHorizontalIcon },
];

function TabStub({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 border-x border-border px-4 text-center">
      <p className="text-sm text-muted-foreground">
        The <span className="font-medium text-foreground">{label}</span> tab is
        specified in{" "}
        <span className="font-mono text-xs text-foreground">project-hub-c</span>.
      </p>
      <p className="max-w-sm text-xs text-muted-foreground/70">
        This demo focuses the GitHub tab. Switch back to see it.
      </p>
    </div>
  );
}

function ReplayBar({
  fixed,
  onFix,
  onReset,
}: {
  fixed: boolean;
  onFix: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {!fixed ? (
        <Button size="sm" variant="outline" onClick={onFix}>
          <RotateCcwIcon />
          Re-run checks on #146
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={onReset}>
          <RotateCcwIcon />
          Reset timeline
        </Button>
      )}
    </div>
  );
}

// Apply the replay: #146's failing typecheck flips green → its checks pass, so
// it leaves For You's "failing checks".
function applyReplay(fixed: boolean): DemoPR[] {
  if (!fixed) return DEMO_PRS;
  return DEMO_PRS.map((p) =>
    p.number === 146
      ? {
          ...p,
          checks: {
            passed: p.checks.passed + p.checks.failed,
            failed: 0,
            pending: p.checks.pending,
          },
          checkRuns: p.checkRuns.map((r) =>
            r.status === "failed" ? { ...r, status: "passed" as const } : r,
          ),
        }
      : p,
  );
}

function HubHeader({
  tab,
  onTab,
  prs,
}: {
  tab: HubTab;
  onTab: (t: HubTab) => void;
  prs: DemoPR[];
}) {
  const reviewCount = reviewRequestedPRs(prs).length;
  const assignedCount = assignedIssues(DEMO_ISSUES).length;
  const tabCounts: Partial<Record<HubTab, number>> = {
    sessions: 22,
    looms: 9,
    github:
      reviewCount + assignedCount + mentionFeed(DEMO_ISSUES, prs).length +
      myFailingPRs(prs).length,
  };
  return (
    <div className="shrink-0 border-b border-border bg-background/60">
      <div className="mx-auto w-full max-w-6xl px-4 pt-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
            <FolderGit2Icon className="size-4.5 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate font-heading text-sm font-semibold tracking-tight">
                {DEMO_PROJECT.name}
              </h1>
              <Badge
                variant="outline"
                className="shrink-0 border-sky-500/25 bg-sky-500/5 px-1.5 py-0 text-[10px] text-sky-300"
              >
                {DEMO_PROJECT.account}
              </Badge>
              <Badge
                variant="outline"
                className="shrink-0 px-1.5 py-0 font-mono text-[10px] text-muted-foreground"
              >
                {DEMO_PROJECT.branch}
              </Badge>
            </div>
            <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
              {reviewCount > 0 && (
                <span className="text-sky-300">
                  {reviewCount} review request{reviewCount === 1 ? "" : "s"}
                </span>
              )}
              {reviewCount > 0 && assignedCount > 0 && (
                <span className="text-border">·</span>
              )}
              {assignedCount > 0 && (
                <span className="text-violet-300">{assignedCount} assigned</span>
              )}
              {reviewCount === 0 && assignedCount === 0 && (
                <span>Nothing waiting on you</span>
              )}
            </p>
          </div>
          <Button size="sm">
            <PlusIcon />
            New session
          </Button>
        </div>

        <div className="mt-3 flex items-center gap-1">
          {HUB_TABS.map((t) => {
            const on = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => onTab(t.key)}
                className={cn(
                  "flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium transition-colors",
                  on
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <t.icon className="size-3.5" />
                {t.label}
                {tabCounts[t.key] != null && (
                  <span
                    className={cn(
                      "font-mono text-[10px] tabular-nums",
                      on ? "text-muted-foreground" : "text-muted-foreground/60",
                    )}
                  >
                    {tabCounts[t.key]}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ============================================================ entry */

export function ProjectGithubTab() {
  const [tab, setTab] = useState<HubTab>("github");
  const [fixed, setFixed] = useState(false);

  // The replay updates prs in place — For You recomputes and #146 leaves the
  // failing-checks section without yanking the user's current sub-view.
  const prs = useMemo(() => applyReplay(fixed), [fixed]);

  const controls = (_theme: Theme) => (
    <ReplayBar
      fixed={fixed}
      onFix={() => setFixed(true)}
      onReset={() => setFixed(false)}
    />
  );

  return (
    <StageFrame controls={controls}>
      {() => (
        <div className="flex h-full flex-col">
          <HubHeader tab={tab} onTab={setTab} prs={prs} />
          <div className="min-h-0 flex-1">
            <div className="mx-auto flex h-full w-full max-w-6xl">
              {tab === "github" ? (
                <GithubTab prs={prs} />
              ) : (
                <TabStub label={HUB_TABS.find((t) => t.key === tab)!.label} />
              )}
            </div>
          </div>
        </div>
      )}
    </StageFrame>
  );
}
