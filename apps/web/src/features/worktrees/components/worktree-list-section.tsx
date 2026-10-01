"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorktreeInventory, WorktreeReclaimResult, WorktreeRow } from "@telar/engine-client";
import { FolderGitIcon, LockIcon, TriangleAlertIcon } from "lucide-react";
import { createEngineApi } from "@/platform/engine";
import { fmtAgo, formatBytes } from "@/ui/format";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Spinner } from "@/ui/spinner";
import { SettingsGroup } from "@/features/settings";

const api = createEngineApi();
const PAGE = 50;

export type ListSort = "size" | "age";

export function visibleRows(rows: readonly WorktreeRow[], query: string, sort: ListSort): WorktreeRow[] {
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? rows.filter((row) => [row.basename, row.branch, row.projectName, row.path].some((field) => field?.toLowerCase().includes(needle)))
    : [...rows];
  return matched.sort((left, right) => (sort === "size" ? (right.bytes ?? -1) - (left.bytes ?? -1) : (left.updatedAt ?? Infinity) - (right.updatedAt ?? Infinity)));
}

const LOCK_TEXT: Record<string, string> = {
  unreadable: "On a drive that is not connected. Nothing was read, so nothing is claimed about it.",
  "in-use": "A session is working in it right now. Removing it would take the directory an agent is writing in.",
  protected: "The repository's own checkout, or the one Telar is running from. Never removable.",
  active: "Held by a session that is still on the rail. Settle it first, and this checkout becomes reclaimable.",
};

const FORCE_TEXT: Record<string, string> = {
  dirty: "has uncommitted changes",
  unmerged: "is not merged",
  unknown: "could not be checked — Telar did not get an answer from git",
  "no-branch": "has no branch to check",
};

export function ownerLabel(row: WorktreeRow): { label: string; tone: "outline" | "secondary" | "destructive" } {
  if (row.owner.kind === "none") return { label: "no session", tone: "destructive" };
  if (row.owner.lifecycle === "archived") return { label: "left behind", tone: "destructive" };
  if (row.owner.lifecycle === "settled") return { label: "settled", tone: "secondary" };
  return { label: "on the rail", tone: "outline" };
}

export function confirmSentence(rows: readonly WorktreeRow[], archiveSettled = false): string {
  const settled = rows.filter((row) => row.owner.kind === "session" && row.owner.lifecycle === "settled");
  const removals = rows.filter((row) => !(row.owner.kind === "session" && row.owner.lifecycle === "settled"));
  const bytes = rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0);
  const parts: string[] = [];
  const n = settled.length;
  if (n > 0 && archiveSettled) {
    parts.push(`Archive ${n} session${n === 1 ? "" : "s"} and give back ${n === 1 ? "its" : "their"} checkout${n === 1 ? "" : "s"}.`);
  } else if (n > 0) {
    parts.push(
      `Release ${n} checkout${n === 1 ? "" : "s"}. ${n === 1 ? "Its session stays and comes" : "Their sessions stay and come"} back on the next message.`,
    );
  }
  if (removals.length > 0) {
    parts.push(`Remove ${removals.length} checkout${removals.length === 1 ? "" : "s"} that no session is holding.`);
  }
  if (bytes > 0) parts.push(`${formatBytes(bytes)} back.`);
  parts.push("Branches are kept.");
  return parts.join(" ");
}

export function armedRows(
  rows: readonly WorktreeRow[],
  cleared: ReadonlySet<string>,
  typed: Readonly<Record<string, string>>,
): WorktreeRow[] {
  return rows.filter((row) => {
    if (cleared.has(row.path)) return false;
    if (row.verdict.kind === "reclaimable") return true;
    if (row.verdict.kind === "needs-force") return (typed[row.path] ?? "").trim() === row.basename;
    return false;
  });
}

export function reclaimPayload(
  rows: readonly WorktreeRow[],
  typed: Readonly<Record<string, string>>,
  archiveSettled = false,
): { path: string; confirm?: string; settled?: "release" | "archive" }[] {
  return rows.map((row) => ({
    path: row.path,
    ...(row.verdict.kind === "needs-force" ? { confirm: typed[row.path] ?? "" } : {}),
    ...(row.owner.kind === "session" && row.owner.lifecycle === "settled" ? { settled: archiveSettled ? "archive" : "release" } : {}),
  }));
}

function StateChips({ row }: { row: WorktreeRow }) {
  const owner = ownerLabel(row);
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge variant={owner.tone}>{owner.label}</Badge>
      {!row.registered && row.onDisk ? <Badge variant="outline">unregistered</Badge> : null}
      {row.merged === true ? <Badge variant="secondary">merged</Badge> : null}
      {row.merged === false ? <Badge variant="outline">not merged</Badge> : null}
      {row.clean === false ? <Badge variant="destructive">uncommitted</Badge> : null}
      {row.incomplete ? <Badge variant="outline">unchecked</Badge> : null}
    </span>
  );
}

function ReclaimFailures({ results }: { results: readonly WorktreeReclaimResult[] | undefined }) {
  const failed = results?.filter((result) => !result.ok) ?? [];
  if (failed.length === 0) return null;
  return (
    <div className="space-y-1 py-3 text-xs text-muted-foreground">
      {failed.map((result) => (
        <div key={result.path} className="flex items-start gap-2">
          <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
          <span>
            <span className="font-mono">{result.path.split("/").pop()}</span> — {LOCK_TEXT[result.refusal ?? ""] ?? result.detail ?? "was not given back."}
          </span>
        </div>
      ))}
    </div>
  );
}

function ReclaimConfirm({
  selected,
  archiveSettled,
  busy,
  onArchiveSettled,
  onReclaim,
  onCancel,
}: {
  selected: readonly WorktreeRow[];
  archiveSettled: boolean;
  busy: boolean;
  onArchiveSettled: (next: boolean) => void;
  onReclaim: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3 py-3">
      <p className="text-xs text-foreground">{confirmSentence(selected, archiveSettled)}</p>
      {selected.some((row) => row.owner.kind === "session" && row.owner.lifecycle === "settled") && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={archiveSettled} onChange={(event) => onArchiveSettled(event.target.checked)} />
          Archive those sessions instead
        </label>
      )}
      <ul className="max-h-40 space-y-0.5 overflow-auto text-xs text-muted-foreground">
        {selected.map((row) => (
          <li key={row.path} className="font-mono">
            {row.basename}
            {row.owner.kind === "session" && row.owner.lifecycle === "settled" ? (archiveSettled ? " — archives its session" : " — released, session kept") : ""}
          </li>
        ))}
      </ul>
      <span className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={onReclaim}>
          {busy ? "Working…" : "Give them back"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </span>
    </div>
  );
}

function WorktreeRowItem({
  row,
  checked,
  typed,
  onToggle,
  onType,
}: {
  row: WorktreeRow;
  checked: boolean;
  typed: string;
  onToggle: () => void;
  onType: (value: string) => void;
}) {
  const locked = row.verdict.kind === "locked";
  const forced = row.verdict.kind === "needs-force";
  return (
    <div className="flex items-start gap-3 py-2.5">
      <div className="pt-0.5">
        {locked ? (
          <LockIcon className="size-4 text-muted-foreground/60" />
        ) : forced ? (
          <TriangleAlertIcon className="size-4 text-muted-foreground" />
        ) : (
          <input
            type="checkbox"
            checked={checked}
            aria-label={checked ? `Keep ${row.basename}` : `Give back ${row.basename}`}
            onChange={onToggle}
            className="size-4 accent-primary"
          />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <FolderGitIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-xs-plus text-foreground">{row.basename}</span>
          {row.branch ? <span className="truncate text-xs text-muted-foreground">{row.branch}</span> : null}
          {row.projectName ? <span className="truncate text-xs text-muted-foreground">· {row.projectName}</span> : null}
        </div>
        <StateChips row={row} />
        {locked && row.verdict.kind === "locked" ? <p className="text-xs text-muted-foreground">{LOCK_TEXT[row.verdict.reason]}</p> : null}
        {forced && row.verdict.kind === "needs-force" ? (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              This {row.verdict.reasons.map((reason) => FORCE_TEXT[reason] ?? reason).join(", and ")}. Type{" "}
              <span className="font-mono text-foreground">{row.basename}</span> to give it back anyway.
            </p>
            <Input
              value={typed}
              aria-label={`Type ${row.basename} to confirm`}
              placeholder={row.basename}
              className="h-7 max-w-xs font-mono text-xs"
              onChange={(event) => onType(event.target.value)}
            />
          </div>
        ) : null}
      </div>
      <div className="shrink-0 text-right">
        <div className="font-mono text-xs tabular-nums text-foreground">{row.bytes === undefined ? "—" : formatBytes(row.bytes)}</div>
        {row.updatedAt ? <div className="text-xs text-muted-foreground">{fmtAgo(row.updatedAt)}</div> : null}
      </div>
    </div>
  );
}

function listDescription(rows: readonly WorktreeRow[], busy: boolean, inventory: WorktreeInventory | undefined): string {
  const reclaimable = rows.filter((row) => row.verdict.kind === "reclaimable");
  const total = reclaimable.reduce((sum, row) => sum + (row.bytes ?? 0), 0);
  return [
    rows.length === 0 && !busy ? "No checkouts yet." : `${rows.length} checkout${rows.length === 1 ? "" : "s"}, each checked for merged, clean, and still in use.`,
    reclaimable.length > 0 ? `${reclaimable.length} can go, ${formatBytes(total)}.` : undefined,
    inventory?.partial ? "Something under the checkouts could not be read, so these sizes are a floor." : undefined,
    inventory?.measuring ? "Some sizes are still being measured." : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function ListControls({ query, sort, onQuery, onSort }: { query: string; sort: ListSort; onQuery: (next: string) => void; onSort: (next: ListSort) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-2.5">
      <Input
        value={query}
        aria-label="Search worktrees"
        placeholder="Search by name, branch or project"
        className="h-7 min-w-48 flex-1 text-xs"
        onChange={(event) => onQuery(event.target.value)}
      />
      {(["size", "age"] as const).map((key) => (
        <Button key={key} size="sm" variant={sort === key ? "secondary" : "ghost"} aria-pressed={sort === key} onClick={() => onSort(key)}>
          {key === "size" ? "Largest" : "Oldest"}
        </Button>
      ))}
    </div>
  );
}

function MoreRows({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  return (
    <div className="flex items-center justify-between py-2.5 text-xs text-muted-foreground">
      <span>
        Showing {shown} of {total}
      </span>
      <Button size="sm" variant="ghost" onClick={onMore}>
        Show {Math.min(PAGE, total - shown)} more
      </Button>
    </div>
  );
}

export function WorktreeListSection({ onChanged }: { onChanged?: () => void }) {
  const [inventory, setInventory] = useState<WorktreeInventory>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [archiveSettled, setArchiveSettled] = useState(false);
  const [results, setResults] = useState<WorktreeReclaimResult[]>();
  const [summary, setSummary] = useState<string>();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ListSort>("size");
  const [shown, setShown] = useState(PAGE);

  const inFlight = useRef<AbortController | undefined>(undefined);
  const load = useCallback(async () => {
    inFlight.current?.abort();
    const own = new AbortController();
    inFlight.current = own;
    setBusy(true);
    setFailure(undefined);
    try {
      const { inventory: answer } = await api.worktrees({ signal: own.signal });
      if (!own.signal.aborted) setInventory(answer);
    } catch {
      if (!own.signal.aborted) setFailure("Telar could not list its checkouts — the engine did not answer.");
    } finally {
      if (inFlight.current === own) {
        inFlight.current = undefined;
        setBusy(false);
      }
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(task);
      inFlight.current?.abort();
      inFlight.current = undefined;
    };
  }, [load]);

  const rows = useMemo(() => inventory?.rows ?? [], [inventory]);

  const selected = useMemo(() => armedRows(rows, cleared, typed), [rows, cleared, typed]);

  const toggle = (row: WorktreeRow) =>
    setCleared((current) => {
      const next = new Set(current);
      if (next.has(row.path)) next.delete(row.path);
      else next.add(row.path);
      return next;
    });

  const reclaim = async () => {
    setBusy(true);
    setFailure(undefined);
    setResults(undefined);
    setSummary(undefined);
    try {
      const outcome = (await api.reclaimWorktrees(reclaimPayload(selected, typed, archiveSettled))).reclaim;
      setResults(outcome.results);
      setSummary(outcome.summary);
      setConfirming(false);
      setTyped({});
      setCleared(new Set());
      onChanged?.();
      await load();
    } catch {
      setFailure("Telar could not give those checkouts back — the engine did not answer.");
    } finally {
      setBusy(false);
    }
  };

  if (inventory?.blocker) {
    return (
      <SettingsGroup title="Checkouts" description={inventory.blocker}>
        <div className="py-3 text-xs text-muted-foreground">
          Plug the drive back in and this fills itself.
        </div>
      </SettingsGroup>
    );
  }

  const visible = visibleRows(rows, query, sort);

  return (
    <SettingsGroup
      description={listDescription(rows, busy, inventory)}
      action={
        <span className="flex items-center gap-2">
          {busy ? <Spinner className="size-3.5" /> : null}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
            Refresh
          </Button>
          {selected.length > 0 ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(true)}>
              Give back {selected.length}
            </Button>
          ) : null}
        </span>
      }
    >
      {failure ? <div className="py-3 text-xs text-destructive">{failure}</div> : null}
      {summary ? <div className="py-3 text-xs text-muted-foreground">{summary}</div> : null}
      <ReclaimFailures results={results} />

      {confirming ? (
        <ReclaimConfirm
          selected={selected}
          archiveSettled={archiveSettled}
          busy={busy}
          onArchiveSettled={setArchiveSettled}
          onReclaim={() => void reclaim()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}

      <ListControls
        query={query}
        sort={sort}
        onQuery={(next) => {
          setQuery(next);
          setShown(PAGE);
        }}
        onSort={setSort}
      />

      {visible.slice(0, shown).map((row) => (
        <WorktreeRowItem
          key={row.path}
          row={row}
          checked={row.verdict.kind !== "locked" && selected.some((entry) => entry.path === row.path)}
          typed={typed[row.path] ?? ""}
          onToggle={() => toggle(row)}
          onType={(value) => setTyped((current) => ({ ...current, [row.path]: value }))}
        />
      ))}

      {visible.length > shown ? <MoreRows shown={shown} total={visible.length} onMore={() => setShown((count) => count + PAGE)} /> : null}
    </SettingsGroup>
  );
}
