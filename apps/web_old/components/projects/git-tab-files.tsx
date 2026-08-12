"use client";

// FILES sub-view: a git-aware breadcrumb directory browser. The endpoint returns
// ONE directory level (dirs first, then files) with per-path git status, last
// commit, and churn heat; drilling re-queries with ?path=. Per the frozen
// contract there is NO "last touched by" — the store persists filesTouched as a
// COUNT, not paths, so that attribution does not exist server-side. We render an
// honest inline caveat instead of a fabricated column.
import { useCallback, useEffect, useState } from "react";
import {
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  InfoIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtAgo } from "@/lib/format";
import {
  HeatDot,
  SectionBand,
  StatusBadge,
  SubError,
  SubSkeleton,
  type FileEntry,
  type FilesResponse,
} from "./git-tab-shared";

function FileBrowserRow({
  entry,
  onOpen,
}: {
  entry: FileEntry;
  onOpen?: () => void;
}) {
  const isDir = entry.kind === "dir";
  const Icon = isDir ? FolderIcon : FileIcon;
  return (
    <div
      role={isDir ? "button" : undefined}
      onClick={onOpen}
      className={cn(
        "flex items-center gap-2 px-4 py-2 transition-colors",
        isDir ? "cursor-pointer hover:bg-muted/30" : "hover:bg-muted/20",
      )}
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          isDir ? "text-sky-400/80" : "text-muted-foreground",
        )}
      />
      <div className="flex min-w-0 shrink items-center gap-1.5 sm:basis-2/5">
        <span
          className={cn(
            "truncate text-sm",
            isDir ? "font-medium" : "text-foreground/90",
          )}
          title={entry.name}
        >
          {entry.name}
        </span>
        <StatusBadge status={entry.status} />
        <HeatDot heat={entry.heat} />
      </div>

      <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground md:inline">
        {entry.commit.subject}
      </span>

      <span className="w-14 shrink-0 text-right text-xs text-muted-foreground/70">
        {fmtAgo(entry.commit.updatedAt)}
      </span>
      {isDir ? (
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
    </div>
  );
}

function Breadcrumb({
  projectName,
  breadcrumb,
  onNavigate,
}: {
  projectName: string;
  breadcrumb: string[];
  onNavigate: (path: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-y border-border bg-background/40 px-4 py-1.5 text-xs">
      <button
        type="button"
        onClick={() => onNavigate("")}
        className={cn(
          "flex items-center gap-1 rounded px-1 py-0.5 font-medium transition-colors",
          breadcrumb.length === 0
            ? "text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <FolderOpenIcon className="size-3.5" />
        {projectName}
      </button>
      {breadcrumb.map((seg, i) => {
        const last = i === breadcrumb.length - 1;
        return (
          <span key={i} className="flex items-center gap-1">
            <ChevronRightIcon className="size-3 text-muted-foreground/50" />
            <button
              type="button"
              onClick={() => onNavigate(breadcrumb.slice(0, i + 1).join("/"))}
              className={cn(
                "rounded px-1 py-0.5 font-mono transition-colors",
                last
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {seg}
            </button>
          </span>
        );
      })}
    </div>
  );
}

export function FilesSection({ name }: { name: string }) {
  const [path, setPath] = useState("");
  const [data, setData] = useState<FilesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (p: string) => {
      setError(null);
      setData(null);
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(name)}/git/files?path=${encodeURIComponent(p)}`,
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `Files read failed (${res.status}).`);
        }
        setData((await res.json()) as FilesResponse);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [name],
  );

  useEffect(() => {
    void load(path);
  }, [load, path]);

  const dirty = data?.entries.filter((e) => e.status).length ?? 0;

  return (
    <div>
      <SectionBand
        icon={FolderIcon}
        label="Files"
        count={data?.entries.length}
        right={
          dirty > 0 ? (
            <span className="text-xs text-amber-300">{dirty} dirty here</span>
          ) : undefined
        }
      />

      <Breadcrumb
        projectName={name}
        breadcrumb={data?.breadcrumb ?? (path ? path.split("/") : [])}
        onNavigate={setPath}
      />

      {/* honesty caveat — attribution (who touched a path) is not in the contract */}
      <div className="flex items-start gap-2 border-b border-border bg-amber-500/5 px-4 py-2">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
        <p className="text-[11px] text-muted-foreground">
          The tree, status, and per-path commit are real (fs walk + git). Telar
          can't yet show <span className="italic">who</span> last touched a
          path: the store records how many files a session changed, not which.
        </p>
      </div>

      {error ? (
        <SubError message={error} onRetry={() => void load(path)} />
      ) : data === null ? (
        <SubSkeleton rows={5} />
      ) : data.entries.length === 0 ? (
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">
          This directory is empty.
        </p>
      ) : (
        <>
          <div className="divide-y divide-border">
            {data.entries.map((entry) => (
              <FileBrowserRow
                key={entry.name}
                entry={entry}
                onOpen={
                  entry.kind === "dir"
                    ? () =>
                        setPath(path ? `${path}/${entry.name}` : entry.name)
                    : undefined
                }
              />
            ))}
          </div>
          {data.truncated && (
            <p className="border-t border-border px-4 py-2 text-center text-[11px] text-muted-foreground">
              This listing was capped for speed — some entries are hidden. Drill
              into a subdirectory to narrow it.
            </p>
          )}
        </>
      )}
    </div>
  );
}
