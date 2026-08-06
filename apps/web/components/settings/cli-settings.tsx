"use client";

// THE TWO CLIs TELAR DOES NOT SHIP, made visible.
//
// Telar runs the user's own Claude Code and Codex. Which binary, at which
// version, is the single fact #28 needed and nobody could get: the resolvers
// print one line per CLI at startup, and in the packaged app that stdout goes
// nowhere. This pane is that line, somewhere a user can actually read it.
//
// A PRESENTER, AND NOTHING ELSE. All resolution happens server-side
// (packages/core/src/cli-resolution.ts) and arrives over GET /api/clis; the
// resolution type is imported TYPE-ONLY so core's child_process/fs never reach
// the client bundle. There is deliberately no update button here — updating a
// CLI mutates the user's machine, needs install-method detection to run the
// right command, and must never be reachable by an agent (#39). Telar reports;
// the human acts, in their own terminal.
import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2Icon,
  AlertTriangleIcon,
  XCircleIcon,
  RotateCwIcon,
  TerminalIcon,
} from "lucide-react";
import type { CliResolution, CliStatus } from "@telar/core";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { SettingsGroup } from "@/components/settings/settings-shell";

// The glyph says what the GATE does, not how tidy the version is: only the two
// statuses that refuse a turn are rendered as failures. "drifted" and "unknown"
// warn — they run, and dressing them up as broken would push a user into
// "fixing" a working install (which, for drift, usually means downgrading a CLI
// when the right move is updating telar).
const GLYPH: Record<CliStatus, { Icon: typeof CheckCircle2Icon; tint: string; label: string }> = {
  ok: { Icon: CheckCircle2Icon, tint: "text-emerald-500", label: "OK" },
  drifted: { Icon: AlertTriangleIcon, tint: "text-amber-500", label: "Version drift" },
  unknown: { Icon: AlertTriangleIcon, tint: "text-amber-500", label: "Unrecognised" },
  // Found AND versioned, with nothing to judge it against — telar could not
  // work out which version it expects to pair with. Not a warning: nothing is
  // wrong with the install, we simply have no opinion about it. Rendering it
  // amber beside a version it DID report is what made this a separate status
  // from `unknown` in the first place.
  unverified: { Icon: CheckCircle2Icon, tint: "text-muted-foreground", label: "Unverified" },
  incompatible: { Icon: XCircleIcon, tint: "text-destructive", label: "Sessions refused" },
  missing: { Icon: XCircleIcon, tint: "text-destructive", label: "Not installed" },
};

const SUMMARY: Record<CliStatus, string> = {
  ok: "Installed and ready.",
  drifted: "Installed and running, at a version this build wasn't tested against.",
  unknown: "Installed, but it would not report a version.",
  unverified: "Installed and running. Telar has no compatible-version to check this against.",
  incompatible: "Installed, but this build of Telar can't talk to it — sessions are refused.",
  missing: "Not installed. Sessions on this provider are refused.",
};

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span
        className={cn("truncate text-[11px] text-foreground/80", mono && "font-mono")}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function CliRow({ cli }: { cli: CliResolution }) {
  const g = GLYPH[cli.status];
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <g.Icon className={cn("mt-0.5 size-4 shrink-0", g.tint)} aria-label={g.label} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{cli.label}</span>
          <Badge variant="outline" className="text-[10px]">
            {cli.status}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{SUMMARY[cli.status]}</p>
        <div className="mt-1.5 flex flex-col gap-0.5">
          <Field label="Installed" value={cli.version ?? "—"} mono />
          {/* Only Claude has an expected version — it is DERIVED from the npm
              wrapper telar depends on. Telar drives Codex's app-server directly
              with no wrapper in between, so there is no pairing to state, and
              saying "any" is the honest answer rather than leaving a blank a
              reader would take for a missing check. */}
          <Field label="Expected" value={cli.expected ?? "any (no declared pairing)"} mono />
          <Field label="Path" value={cli.path ?? "not found"} mono />
        </div>
        {cli.message && (
          <p className="mt-1.5 rounded-md border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
            {cli.message}
          </p>
        )}
      </div>
    </div>
  );
}

export function CliSettings() {
  const [clis, setClis] = useState<CliResolution[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/clis", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { clis: CliResolution[] };
      setClis(data.clis);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // DEFERRED, not called straight from the effect body. `load` sets state
  // immediately (the spinner), which from an event handler is right and from an
  // effect is a cascading render — react-hooks/set-state-in-effect. Scheduling
  // it keeps ONE loader shared with the Re-check button instead of forking the
  // mount path into a second copy that drifts from it. The timer is cleared on
  // unmount so a settings pane closed within the same tick never fetches.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-xs text-muted-foreground">
          Telar runs the Claude Code and Codex CLIs already on this machine — it bundles neither.
          This is which binary each session actually starts, and what it reports as its version.
        </p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Spinner /> : <RotateCwIcon />} Re-check
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          Couldn&apos;t read the CLI status: <span className="font-mono">{error}</span>
        </div>
      )}

      {loading && !clis ? (
        <div className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground">
          <Spinner /> Looking for the CLIs…
        </div>
      ) : (
        <SettingsGroup
          title="Command-line tools"
          description="Resolved fresh on each check, so a CLI that upgraded itself shows its new version here."
        >
          {clis?.map((cli) => <CliRow key={cli.id} cli={cli} />)}
        </SettingsGroup>
      )}

      <SettingsGroup title="Updating">
        <div className="flex items-start gap-3 px-4 py-3">
          <TerminalIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/70" />
          <p className="text-xs text-muted-foreground">
            Update these where you installed them — Telar will not do it for you. It is your
            machine, the right command depends on how each CLI was installed, and an agent must
            never be able to trigger one. Telar notices the new version the next time it resolves.
          </p>
        </div>
      </SettingsGroup>
    </div>
  );
}
