"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ActivityIcon,
  ArrowLeftIcon,
  BanIcon,
  ChevronRightIcon,
  FileCogIcon,
  HistoryIcon,
  FolderXIcon,
  GlobeIcon,
  LinkIcon,
  MessagesSquareIcon,
  PlayIcon,
  RotateCwIcon,
  ServerIcon,
  SettingsIcon,
  ShieldIcon,
  SparklesIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ProjectManifest, RegistryEntry, Loom } from "@telar/core";
import type { ChatSummary } from "@/lib/store";
import { fmtAgo, fmtCost } from "@/lib/format";
import { modelById } from "@/lib/models";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  HealthDot,
  normalizeStatus,
  type HttpStatus,
} from "@/components/settings/mcp-health";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { StateBadge } from "@/components/common/state-badge";
import {
  GroupHeader,
  WeaveChip,
  isLoomNeedsYou,
  isLoomRecent,
  isLoomRunning,
} from "@/components/common/list-controls";
import { ArchiveButton } from "@/components/session/archive-button";
import { isTerminal, stateRailClass, sumCost } from "@/components/looms/utils";

type ProjectEntry = {
  entry: RegistryEntry;
  manifest: ProjectManifest | null;
  error: string | null;
};

type ChatMeta = ChatSummary;

type Status = "loading" | "ready" | "missing" | "error";

function BackLink() {
  return (
    <Link
      href="/projects"
      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      aria-label="Back to projects"
    >
      <ArrowLeftIcon className="size-4" />
    </Link>
  );
}

// Two-click confirm: opening the popover is the first click, "Unregister" the
// second. Mirrors the card's control so the destructive path reads the same
// everywhere — only the destination (back to the list) differs.
function UnregisterButton({ name }: { name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await fetch(`/api/projects/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
    } catch {
      /* best-effort — navigating away, the list will show the true state */
    } finally {
      window.dispatchEvent(new Event("telar:refresh"));
      router.push("/projects");
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            aria-label={`Unregister ${name}`}
          />
        }
      >
        <Trash2Icon />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <PopoverHeader>
          <PopoverTitle>Unregister {name}?</PopoverTitle>
          <PopoverDescription>
            Removes it from the registry. The repo and its telar.yaml stay
            untouched.
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void remove()}
            disabled={busy}
          >
            {busy ? <Spinner /> : <Trash2Icon />}
            Unregister
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SectionLabel({
  children,
  count,
}: {
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <div className="flex items-center gap-2 px-1">
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {children}
      </h2>
      {count !== undefined && count > 0 && (
        <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
          {count}
        </Badge>
      )}
    </div>
  );
}

function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-3">
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-4 w-14" />
        </div>
      ))}
    </div>
  );
}

function SectionError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <EmptyState
      icon={TriangleAlertIcon}
      iconClassName="text-destructive/60"
      title="Couldn't load this section"
      description={<span className="font-mono text-xs break-words">{message}</span>}
      action={
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCwIcon />
          Retry
        </Button>
      }
    />
  );
}

// A muted uppercase section heading inside the Manifest rail, with an optional
// leading icon — the shared look for Gates / Guardrails / URLs / MCP servers.
function RailHeading({
  icon: Icon,
  children,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">
      {Icon && <Icon className="size-3" />}
      {children}
    </div>
  );
}

// Read-only summary of a project's telar.yaml: gates, guardrails, configured
// URLs, and MCP servers with their live connection health. Editing lives on the
// settings page (the header gear); this rail is a glance, not a control panel —
// the one exception being a Connect shortcut for a server that needs sign-in.
function ManifestCard({
  name,
  manifest,
}: {
  name: string;
  manifest: ProjectManifest;
}) {
  const { gates, guardrails, urls, mcpServers } = manifest;
  const noGuards =
    guardrails.protectedPaths.length === 0 &&
    guardrails.disallowedTools.length === 0;

  const urlEntries = (["dev", "preview", "prod"] as const)
    .map((k) => [k, urls?.[k]] as const)
    .filter((e): e is [(typeof e)[0], string] => !!e[1]);
  const serverEntries = Object.entries(mcpServers);
  const hasHttp = serverEntries.some(([, c]) => c.transport === "http");

  // Live per-server health, from the same status route the settings page uses.
  // Only fetched when there's an http server to probe; stdio shows as "Local".
  const [status, setStatus] = useState<Record<string, HttpStatus>>({});
  const [connecting, setConnecting] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    if (!hasHttp) return;
    try {
      const res = await fetch(
        `/api/mcp/oauth/status?project=${encodeURIComponent(name)}`,
      );
      if (!res.ok) return;
      setStatus(normalizeStatus(await res.json()));
    } catch {
      // status unknown — dots stay on "checking"
    }
  }, [name, hasHttp]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Inline Connect shortcut for a needs-sign-in server: the same OAuth popup the
  // settings page opens. That popup lands on the settings page, which posts to
  // its opener and closes itself — we just poll for the close, then re-pull
  // status so the dot flips green. Full connect/reconnect/disconnect stays in
  // settings; this is the one action worth taking the instant you spot amber.
  const connect = async (server: string) => {
    setConnecting(server);
    try {
      const res = await fetch("/api/mcp/oauth/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: name, server }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !data.url) {
        throw new Error(data.error ?? `Couldn't start OAuth (${res.status}).`);
      }
      const popup = window.open(
        data.url,
        "telar-mcp-oauth",
        "popup,width=520,height=720",
      );
      if (!popup) {
        window.location.href = data.url;
        return;
      }
      const poll = window.setInterval(() => {
        if (popup.closed) {
          window.clearInterval(poll);
          setConnecting((c) => (c === server ? null : c));
          void loadStatus();
        }
      }, 800);
    } catch {
      // Popup blocked or the connect route errored — clear busy; the settings
      // page (header gear) carries the full flow with proper error surfacing.
      setConnecting((c) => (c === server ? null : c));
    }
  };

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <FileCogIcon className="size-4 text-muted-foreground" />
          Manifest
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <RailHeading>Gates</RailHeading>
          {gates.length === 0 ? (
            <p className="text-xs text-muted-foreground/60">
              No gates — looms pass on the agent&apos;s verdict alone.
            </p>
          ) : (
            <div className="space-y-1">
              {gates.map((gate, i) => (
                <div
                  key={`${gate.name}-${i}`}
                  className="flex items-baseline justify-between gap-3 rounded-md bg-muted/40 px-2 py-1"
                >
                  <span className="shrink-0 text-xs font-medium">
                    {gate.name}
                  </span>
                  <code
                    className="truncate font-mono text-[11px] text-muted-foreground"
                    title={gate.run}
                  >
                    {gate.run}
                  </code>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <RailHeading icon={ShieldIcon}>Guardrails</RailHeading>
          {noGuards ? (
            <p className="text-xs text-muted-foreground/60">
              No guardrails — nothing fenced off.
            </p>
          ) : (
            <div className="space-y-3">
              {guardrails.protectedPaths.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] text-muted-foreground/60">
                    Protected paths
                  </div>
                  <div className="space-y-1">
                    {guardrails.protectedPaths.map((p) => (
                      <code
                        key={p}
                        className="block truncate rounded-md bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground"
                        title={p}
                      >
                        {p}
                      </code>
                    ))}
                  </div>
                </div>
              )}
              {guardrails.disallowedTools.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] text-muted-foreground/60">
                    Disallowed tools
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {guardrails.disallowedTools.map((t) => (
                      <Badge
                        key={t}
                        variant="outline"
                        className="font-mono text-[10px]"
                      >
                        {t}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <RailHeading icon={GlobeIcon}>URLs</RailHeading>
          {urlEntries.length === 0 ? (
            <p className="text-xs text-muted-foreground/60">
              No URLs configured.
            </p>
          ) : (
            <div className="space-y-1">
              {urlEntries.map(([label, url]) => (
                <div
                  key={label}
                  className="flex items-baseline justify-between gap-3 rounded-md bg-muted/40 px-2 py-1"
                >
                  <span className="shrink-0 text-xs font-medium capitalize">
                    {label}
                  </span>
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                    title={url}
                  >
                    {url}
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <RailHeading icon={ServerIcon}>MCP servers</RailHeading>
          {serverEntries.length === 0 ? (
            <p className="text-xs text-muted-foreground/60">
              No MCP servers configured.
            </p>
          ) : (
            <div className="space-y-1">
              {serverEntries.map(([sName, cfg]) => {
                const st =
                  cfg.transport === "http" ? status[sName] : undefined;
                const enabled = cfg.enabled !== false;
                const needsAuth =
                  cfg.transport === "http" && st?.health === "needs-auth";
                return (
                  <div
                    key={sName}
                    className={cn(
                      "flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1",
                      !enabled && "opacity-60",
                    )}
                  >
                    <HealthDot transport={cfg.transport} status={st} />
                    <span
                      className="min-w-0 flex-1 truncate text-xs font-medium"
                      title={sName}
                    >
                      {sName}
                    </span>
                    {!enabled ? (
                      <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground/70 uppercase">
                        off
                      </span>
                    ) : needsAuth ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 shrink-0 gap-1 px-2 text-[11px]"
                        onClick={() => void connect(sName)}
                        disabled={connecting === sName}
                      >
                        {connecting === sName ? (
                          <Spinner />
                        ) : (
                          <LinkIcon className="size-3" />
                        )}
                        Connect
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <Link
          href={`/projects/${encodeURIComponent(name)}/settings`}
          className="block text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          Edit configuration in settings →
        </Link>
      </CardContent>
    </Card>
  );
}

// The archive control sits beside the row link (never nested inside the
// anchor) and reveals on hover. Archiving broadcasts telar:refresh, which the
// page listens for and reloads — the row drops out (default exclude).
function SessionRow({ name, chat }: { name: string; chat: ChatMeta }) {
  const model = modelById(chat.model)?.name ?? chat.model;
  return (
    <div className="group flex items-center transition-colors hover:bg-muted/40">
      <Link
        href={`/projects/${encodeURIComponent(name)}/sessions/${chat.id}`}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {chat.title || "Untitled session"}
          </div>
          {chat.preview && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground/80">
              {chat.preview}
            </div>
          )}
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-mono">{model}</span>
            <span className="text-border">·</span>
            <span>
              {chat.turns} {chat.turns === 1 ? "turn" : "turns"}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <span className="font-mono text-xs">{fmtCost(chat.costUsd)}</span>
          <span className="text-xs text-muted-foreground">
            {fmtAgo(chat.updatedAt)}
          </span>
        </div>
      </Link>
      <div className="shrink-0 pr-2 pl-1">
        <ArchiveButton
          id={chat.id}
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        />
      </div>
    </div>
  );
}

// A subtle, collapsed-by-default drawer of this project's archived sessions.
// Expanding it lazily fetches archived=only (never eagerly) and lists each with
// a restore control; telar:refresh (fired by any archive/restore) keeps an open
// drawer fresh and invalidates a closed one so reopening refetches.
function ArchivedSessions({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ChatMeta[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchArchived = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/chats?project=${encodeURIComponent(name)}&archived=only`,
      );
      if (!res.ok) throw new Error(`Couldn't load archived sessions (${res.status}).`);
      const d = (await res.json()) as { chats?: ChatMeta[] };
      setRows(d.chats ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    if (open && rows === null) void fetchArchived();
  }, [open, rows, fetchArchived]);

  useEffect(() => {
    const onRefresh = () => {
      if (open) void fetchArchived();
      else setRows(null); // invalidate so the next expand refetches
    };
    window.addEventListener("telar:refresh", onRefresh);
    return () => window.removeEventListener("telar:refresh", onRefresh);
  }, [open, fetchArchived]);

  const count = rows?.length ?? 0;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
      <CollapsibleTrigger className="group/arch flex w-fit items-center gap-1.5 px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase transition-colors hover:text-foreground">
        <ChevronRightIcon
          className={cn(
            "size-3.5 transition-transform",
            open && "rotate-90",
          )}
        />
        Archived
        {rows !== null && count > 0 && (
          <span className="font-mono text-[10px] normal-case">({count})</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {loading ? (
          <ListSkeleton rows={1} />
        ) : error ? (
          <SectionError message={error} onRetry={() => void fetchArchived()} />
        ) : count === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            No archived sessions.
          </p>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
            {rows?.map((chat) => (
              <div
                key={chat.id}
                className="flex items-center gap-3 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-foreground/80">
                    {chat.title || "Untitled session"}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {fmtAgo(chat.updatedAt)}
                  </div>
                </div>
                <ArchiveButton
                  id={chat.id}
                  archived
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                />
              </div>
            ))}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function LoomRow({ loom }: { loom: Loom }) {
  const attempts = loom.attempts.length;
  return (
    <Link
      href={`/looms/${loom.id}`}
      className="relative flex items-center gap-3 py-2.5 pr-3 pl-4 transition-colors hover:bg-muted/40"
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full",
          stateRailClass(loom.state),
        )}
      />
      <StateBadge state={loom.state} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {loom.title}
          </span>
          <WeaveChip loom={loom} />
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-mono">{loom.kind}</span>
          <span className="text-border">·</span>
          <span>
            {attempts} {attempts === 1 ? "attempt" : "attempts"}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="font-mono text-xs tabular-nums">
          {fmtCost(sumCost(loom.attempts))}
        </span>
        <span className="text-xs text-muted-foreground">
          {fmtAgo(loom.updatedAt)}
        </span>
      </div>
    </Link>
  );
}

// A collapsible loom group for the project-detail looms section — same grouping
// vocabulary (Running / Needs you / Recent) as the global looms index.
function LoomGroup({
  icon,
  label,
  tint,
  looms,
  defaultOpen,
}: {
  icon: typeof ActivityIcon;
  label: string;
  tint?: string;
  looms: Loom[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (looms.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <GroupHeader
        icon={icon}
        label={label}
        count={looms.length}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        tint={tint}
      />
      <div className="divide-y divide-border">
        {open && looms.map((l) => <LoomRow key={l.id} loom={l} />)}
      </div>
    </section>
  );
}

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = use(params);

  const [project, setProject] = useState<ProjectEntry | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatMeta[] | null>(null);
  const [looms, setLooms] = useState<Loom[] | null>(null);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [loomsError, setLoomsError] = useState<string | null>(null);
  const [showAllSessions, setShowAllSessions] = useState(false);

  const sessionsHref = `/projects/${encodeURIComponent(name)}/sessions/new`;
  const newLoomHref = `/looms?new=1&project=${encodeURIComponent(name)}`;

  const load = useCallback(async () => {
    let projectsRes: Response;
    let chatsRes: Response;
    let loomsRes: Response;
    try {
      [projectsRes, chatsRes, loomsRes] = await Promise.all([
        fetch("/api/projects"),
        fetch(`/api/chats?project=${encodeURIComponent(name)}`),
        fetch("/api/looms"),
      ]);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setStatus((prev) => (prev === "loading" ? "error" : prev));
      return;
    }

    // Registry entry governs whether the page renders at all.
    try {
      if (!projectsRes.ok)
        throw new Error(`Couldn't reach the registry (${projectsRes.status})`);
      const data = (await projectsRes.json()) as { projects?: ProjectEntry[] };
      const match =
        (data.projects ?? []).find((p) => p.entry.name === name) ?? null;
      if (!match) {
        setStatus("missing");
        return;
      }
      setProject(match);
      setStatus("ready");
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setStatus((prev) => (prev === "loading" ? "error" : prev));
      return;
    }

    // Sessions + looms are section-scoped — a failure degrades a section, not
    // the page. An HTTP-level failure surfaces a retryable error in the section
    // instead of leaving it stuck on the loading skeleton forever.
    if (chatsRes.ok) {
      try {
        const d = (await chatsRes.json()) as { chats?: ChatMeta[] };
        setChats(d.chats ?? []);
        setChatsError(null);
      } catch {
        setChatsError("Couldn't parse the sessions response.");
      }
    } else {
      setChatsError(`Couldn't load sessions (${chatsRes.status}).`);
    }
    if (loomsRes.ok) {
      try {
        const d = (await loomsRes.json()) as { looms?: Loom[] };
        setLooms((d.looms ?? []).filter((r) => r.project === name));
        setLoomsError(null);
      } catch {
        setLoomsError("Couldn't parse the looms response.");
      }
    } else {
      setLoomsError(`Couldn't load looms (${loomsRes.status}).`);
    }
  }, [name]);

  useEffect(() => {
    void load();
  }, [load]);

  // Sibling mutations broadcast telar:refresh — refetch on it.
  useEffect(() => {
    const onRefresh = () => void load();
    window.addEventListener("telar:refresh", onRefresh);
    return () => window.removeEventListener("telar:refresh", onRefresh);
  }, [load]);

  // Poll while any of this project's looms is still in flight.
  useEffect(() => {
    if (!looms) return;
    const inFlight = looms.some((r) => !isTerminal(r.state));
    if (!inFlight) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [looms, load]);

  // Unknown project — designed error state.
  if (status === "missing") {
    return (
      <div className="flex h-dvh flex-col">
        <PageHeader title="Project" leading={<BackLink />} />
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            className="border-none"
            icon={FolderXIcon}
            title="Project not found"
            description={
              <>
                No project named{" "}
                <code className="font-mono text-foreground">{name}</code> is
                registered on the loom.
              </>
            }
            action={
              <Button variant="outline" render={<Link href="/projects" />}>
                Back to projects
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  // First-load registry failure.
  if (status === "error") {
    return (
      <div className="flex h-dvh flex-col">
        <PageHeader title="Project" leading={<BackLink />} />
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            className="border-none"
            icon={TriangleAlertIcon}
            iconClassName="text-destructive/60"
            title="Couldn't load this project"
            description={
              <span className="font-mono text-xs break-words">
                {loadError}
              </span>
            }
            action={
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RotateCwIcon />
                Retry
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  // Loading.
  if (status === "loading" || !project) {
    return (
      <div className="flex h-dvh flex-col">
        <PageHeader
          leading={<BackLink />}
          title={<Skeleton className="h-5 w-40" />}
          actions={<Skeleton className="h-7 w-28 rounded-lg" />}
        />
        <div className="mx-auto grid w-full max-w-5xl gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-6">
            <ListSkeleton />
            <ListSkeleton />
          </div>
          <Skeleton className="h-56 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  const { entry, manifest, error: manifestError } = project;
  const title = manifest?.name ?? entry.name;
  const root = manifest?.root ?? entry.root;

  return (
    <div className="flex h-dvh flex-col">
      <PageHeader
        className="flex-wrap"
        leading={<BackLink />}
        title={title}
        description={
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {manifest ? (
                <>
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    {manifest.adapter}
                  </Badge>
                  <Badge variant="outline" className="text-[10px]">
                    {manifest.account}
                  </Badge>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {manifest.baseBranch}
                  </Badge>
                </>
              ) : (
                <Badge variant="destructive" className="text-[10px]">
                  manifest error
                </Badge>
              )}
            </div>
            <code
              className="truncate font-mono text-[11px] text-muted-foreground/80"
              title={root}
            >
              {root}
            </code>
          </div>
        }
        actions={
          <>
            <Button size="sm" render={<Link href={sessionsHref} />}>
              <MessagesSquareIcon />
              New session
            </Button>
            <Button
              variant="outline"
              size="sm"
              render={<Link href={newLoomHref} />}
            >
              <PlayIcon />
              New loom session
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              aria-label="Project settings"
              render={
                <Link
                  href={`/projects/${encodeURIComponent(entry.name)}/settings`}
                />
              }
            >
              <SettingsIcon />
            </Button>
            <UnregisterButton name={entry.name} />
          </>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-5xl gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-6">
            {/* Sessions */}
            <section className="flex flex-col gap-2">
              <SectionLabel count={chats?.length}>Sessions</SectionLabel>
              {chats !== null ? (
                chats.length === 0 ? (
                  <EmptyState
                    icon={MessagesSquareIcon}
                    title="No sessions yet"
                    description="Sessions explore and prepare; looms execute."
                    action={
                      <Button
                        variant="outline"
                        render={<Link href={sessionsHref} />}
                      >
                        <MessagesSquareIcon />
                        New session
                      </Button>
                    }
                  />
                ) : (
                  <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                    {(showAllSessions ? chats : chats.slice(0, 6)).map((chat) => (
                      <SessionRow key={chat.id} name={entry.name} chat={chat} />
                    ))}
                  </div>
                )
              ) : chatsError ? (
                <SectionError message={chatsError} onRetry={() => void load()} />
              ) : (
                <ListSkeleton rows={2} />
              )}
              {chats !== null && chats.length > 6 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-muted-foreground hover:text-foreground"
                  onClick={() => setShowAllSessions((v) => !v)}
                >
                  {showAllSessions
                    ? "Show fewer"
                    : `Show all ${chats.length} sessions`}
                </Button>
              )}
              {chats !== null && <ArchivedSessions name={entry.name} />}
            </section>

            {/* Looms */}
            <section className="flex flex-col gap-2">
              <SectionLabel count={looms?.length}>Looms</SectionLabel>
              {looms !== null ? (
                looms.length === 0 ? (
                  <EmptyState
                    icon={SparklesIcon}
                    title="No looms yet"
                    description="Weave a loom to let Telar make the change and prove it through the gates."
                    action={
                      <Button
                        variant="outline"
                        render={<Link href={newLoomHref} />}
                      >
                        <PlayIcon />
                        New loom session
                      </Button>
                    }
                  />
                ) : (
                  <div className="space-y-3">
                    <LoomGroup
                      icon={ActivityIcon}
                      label="Running now"
                      tint="text-sky-400"
                      looms={looms.filter((l) => isLoomRunning(l.state))}
                      defaultOpen
                    />
                    <LoomGroup
                      icon={TriangleAlertIcon}
                      label="Needs you"
                      tint="text-amber-400"
                      looms={looms.filter((l) => isLoomNeedsYou(l.state))}
                      defaultOpen
                    />
                    <LoomGroup
                      icon={HistoryIcon}
                      label="Recent"
                      looms={looms.filter((l) => isLoomRecent(l.state))}
                      defaultOpen={
                        looms.filter(
                          (l) =>
                            isLoomRunning(l.state) || isLoomNeedsYou(l.state),
                        ).length === 0
                      }
                    />
                  </div>
                )
              ) : loomsError ? (
                <SectionError message={loomsError} onRetry={() => void load()} />
              ) : (
                <ListSkeleton rows={2} />
              )}
            </section>
          </div>

          {/* Manifest / reference rail */}
          <div className="lg:sticky lg:top-4 lg:self-start">
            {manifest ? (
              <ManifestCard name={entry.name} manifest={manifest} />
            ) : (
              <Alert variant="destructive">
                <BanIcon />
                <AlertTitle>Invalid telar.yaml</AlertTitle>
                <AlertDescription className="font-mono text-xs break-words">
                  {manifestError ?? "The manifest could not be read."}
                </AlertDescription>
              </Alert>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
