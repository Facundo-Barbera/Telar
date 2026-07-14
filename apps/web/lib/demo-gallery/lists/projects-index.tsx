"use client";

// LANE: lists — Projects index at scale (concern 2 + 5).
// CURRENT: a uniform 3-col grid of tall ProjectCards — no search, no sort, no
// sense of which repo is busy; at 16 projects you hunt visually. REDESIGN:
// search-first sticky toolbar, account filters, sort, and a dense status-rich
// row list grouped Pinned / Active / Idle. Each row surfaces live signal
// (running looms, sessions today, open work, last active) so the busy repos
// float up and the rest fold into a collapsed group.
import { useMemo, useState } from "react";
import {
  ActivityIcon,
  FolderGit2Icon,
  MessagesSquareIcon,
  MoonIcon,
  PinIcon,
  PlusIcon,
  SearchXIcon,
  ShieldIcon,
  TriangleAlertIcon,
  WorkflowIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { fmtAgo } from "../now";
import { DEMO_PROJECTS, type Account, type DemoProject } from "./fixtures";
import {
  AccountBadge,
  Chip,
  GroupHeader,
  SearchField,
  SortSelect,
} from "./shared";

type Sort = "activity" | "name" | "work";
type AccountFilter = "all" | Account;

function LiveDot() {
  return (
    <span className="relative flex size-2">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400 opacity-60" />
      <span className="relative inline-flex size-2 rounded-full bg-sky-400" />
    </span>
  );
}

function Metric({
  icon: Icon,
  value,
  label,
  tint,
}: {
  icon: typeof ShieldIcon;
  value: number;
  label: string;
  tint?: string;
}) {
  return (
    <span
      className={cn(
        "flex w-12 shrink-0 items-center justify-end gap-1 font-mono text-xs tabular-nums",
        value === 0 ? "text-muted-foreground/40" : "text-muted-foreground",
      )}
      title={`${value} ${label}`}
    >
      <Icon className={cn("size-3.5", value > 0 ? tint : "text-muted-foreground/40")} />
      {value}
    </span>
  );
}

function ProjectRow({
  project,
  pinned,
  onTogglePin,
}: {
  project: DemoProject;
  pinned: boolean;
  onTogglePin: () => void;
}) {
  const broken = project.health === "manifest-error";
  return (
    <div className="group flex items-center gap-3 py-2.5 pr-3 pl-2 transition-colors hover:bg-muted/40">
      <button
        type="button"
        onClick={onTogglePin}
        className={cn(
          "shrink-0 rounded-md p-1 transition-colors",
          pinned
            ? "text-amber-400"
            : "text-muted-foreground/30 hover:text-muted-foreground group-hover:text-muted-foreground/60",
        )}
        title={pinned ? "Unpin" : "Pin"}
      >
        <PinIcon className={cn("size-3.5", pinned && "fill-current")} />
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        {project.running > 0 && <LiveDot />}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {broken ? (
              <TriangleAlertIcon className="size-3.5 shrink-0 text-destructive" />
            ) : (
              <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate text-sm font-medium">{project.name}</span>
            {broken && (
              <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0 font-mono text-[10px] text-destructive">
                manifest error
              </span>
            )}
          </div>
          <p className="mt-0.5 hidden truncate text-xs text-muted-foreground sm:block">
            {project.blurb}
          </p>
        </div>
      </div>

      <AccountBadge account={project.account} />
      <span className="hidden w-20 shrink-0 truncate text-right font-mono text-[11px] text-muted-foreground md:block">
        {project.stack}
      </span>

      <div className="flex shrink-0 items-center gap-1">
        <Metric icon={ActivityIcon} value={project.running} label="running looms" tint="text-sky-400" />
        <Metric icon={MessagesSquareIcon} value={project.sessionsToday} label="sessions today" tint="text-foreground" />
        <Metric icon={WorkflowIcon} value={project.openLooms} label="open looms" tint="text-indigo-300" />
        <Metric icon={ShieldIcon} value={project.gates} label="gates" tint="text-muted-foreground" />
      </div>

      <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">
        {fmtAgo(project.lastActive)}
      </span>
    </div>
  );
}

function Group({
  icon,
  label,
  tint,
  projects,
  pinnedSet,
  onTogglePin,
  defaultOpen,
}: {
  icon: typeof ActivityIcon;
  label: string;
  tint?: string;
  projects: DemoProject[];
  pinnedSet: Set<string>;
  onTogglePin: (name: string) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (projects.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <GroupHeader
        icon={icon}
        label={label}
        count={projects.length}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        tint={tint}
      />
      {open && (
        <div className="divide-y divide-border">
          {projects.map((p) => (
            <ProjectRow
              key={p.name}
              project={p}
              pinned={pinnedSet.has(p.name)}
              onTogglePin={() => onTogglePin(p.name)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function ProjectsIndexDemo() {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("activity");
  const [account, setAccount] = useState<AccountFilter>("all");
  const [pinned, setPinned] = useState<Set<string>>(
    () => new Set(DEMO_PROJECTS.filter((p) => p.pinned).map((p) => p.name)),
  );

  const togglePin = (name: string) =>
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = DEMO_PROJECTS.filter(
      (p) =>
        !needle ||
        p.name.toLowerCase().includes(needle) ||
        p.stack.toLowerCase().includes(needle) ||
        p.blurb.toLowerCase().includes(needle),
    );
    if (account !== "all") out = out.filter((p) => p.account === account);
    const cmp: Record<Sort, (a: DemoProject, b: DemoProject) => number> = {
      activity: (a, b) => b.lastActive - a.lastActive,
      name: (a, b) => a.name.localeCompare(b.name),
      work: (a, b) => b.running + b.openLooms - (a.running + a.openLooms),
    };
    return [...out].sort(cmp[sort]);
  }, [q, account, sort]);

  const pinnedList = filtered.filter((p) => pinned.has(p.name));
  const rest = filtered.filter((p) => !pinned.has(p.name));
  const active = rest.filter((p) => p.running > 0 || p.sessionsToday > 0 || p.openLooms > 0);
  const idle = rest.filter((p) => !(p.running > 0 || p.sessionsToday > 0 || p.openLooms > 0));

  const accountChips: { value: AccountFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "work", label: "Work" },
    { value: "personal", label: "Personal" },
    { value: "oss", label: "OSS" },
  ];

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="shrink-0 border-b border-border">
        <div className="flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <h1 className="font-heading text-base font-semibold tracking-tight">
              Projects
            </h1>
            <p className="text-xs text-muted-foreground">
              {DEMO_PROJECTS.length} repos on the loom ·{" "}
              {DEMO_PROJECTS.filter((p) => p.running > 0).length} active now
            </p>
          </div>
          <Button size="sm">
            <PlusIcon />
            Register project
          </Button>
        </div>
        <div className="flex items-center gap-2 px-4 pb-2.5">
          <SearchField
            value={q}
            onChange={setQ}
            placeholder="Search projects by name, stack, or description…"
          />
          {accountChips.map((c) => (
            <Chip
              key={c.value}
              active={account === c.value}
              onClick={() => setAccount(c.value)}
            >
              {c.label}
            </Chip>
          ))}
          <SortSelect
            value={sort}
            onChange={setSort}
            options={[
              { value: "activity", label: "Sort: last active" },
              { value: "work", label: "Sort: open work" },
              { value: "name", label: "Sort: name" },
            ]}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl space-y-3 px-4 py-4">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
              <SearchXIcon className="size-6 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                No projects match “{q}”.
              </p>
              <Button variant="outline" size="sm" onClick={() => setQ("")}>
                Clear search
              </Button>
            </div>
          ) : (
            <>
              <Group
                icon={PinIcon}
                label="Pinned"
                tint="text-amber-400"
                projects={pinnedList}
                pinnedSet={pinned}
                onTogglePin={togglePin}
                defaultOpen
              />
              <Group
                icon={ActivityIcon}
                label="Active"
                tint="text-sky-400"
                projects={active}
                pinnedSet={pinned}
                onTogglePin={togglePin}
                defaultOpen
              />
              <Group
                icon={MoonIcon}
                label="Idle"
                projects={idle}
                pinnedSet={pinned}
                onTogglePin={togglePin}
                defaultOpen={false}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
