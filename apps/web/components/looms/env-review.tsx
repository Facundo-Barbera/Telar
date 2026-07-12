"use client";

import { useCallback, useMemo, useState } from "react";
import { Loader2Icon, PencilIcon, ServerIcon, XIcon } from "lucide-react";
// Client-safety: type-only from @telar/core (this is a "use client" file).
import type { ServersConfig, ServiceConfig } from "@telar/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Loom } from "@telar/core";

// Render a service's one-shot readiness gate compactly — the proposal's
// `readyCheck` is what proves the app actually came up before the Critic Panel
// runs, so it's worth surfacing (read-only; not part of the Steer surface).
function readyCheckLabel(rc: ServiceConfig["readyCheck"]): string | null {
  if (!rc) return null;
  if (rc.kind === "http") return `http ${rc.path} → ${rc.status}`;
  return `command: ${rc.run}`;
}

function ServiceRow({
  name,
  svc,
  editable,
  onChange,
}: {
  name: string;
  svc: ServiceConfig;
  editable: boolean;
  onChange: (next: ServiceConfig) => void;
}) {
  const ready = readyCheckLabel(svc.readyCheck);
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/30 p-3 ring-1 ring-border">
      <div className="flex items-center gap-2">
        <ServerIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono text-xs font-medium">{name}</span>
        {svc.dependsOn && svc.dependsOn.length > 0 && (
          <span className="font-mono text-[10px] text-muted-foreground/70">
            depends on {svc.dependsOn.join(", ")}
          </span>
        )}
      </div>

      {editable ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
              command
            </span>
            <Input
              value={svc.command}
              onChange={(e) => onChange({ ...svc, command: e.target.value })}
              className="font-mono text-xs"
            />
          </label>
          <div className="flex gap-2">
            <label className="flex flex-1 flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
                port strategy
              </span>
              <Select
                value={svc.portStrategy}
                onValueChange={(v) =>
                  onChange({ ...svc, portStrategy: v as ServiceConfig["portStrategy"] })
                }
              >
                <SelectTrigger className="text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">fixed</SelectItem>
                  <SelectItem value="dynamic">dynamic</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="flex w-28 flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
                port
              </span>
              <Input
                type="number"
                value={svc.port ?? ""}
                placeholder={svc.portStrategy === "dynamic" ? "auto" : "—"}
                disabled={svc.portStrategy === "dynamic"}
                onChange={(e) => {
                  const n = e.target.value.trim();
                  onChange({ ...svc, port: n === "" ? undefined : Number(n) });
                }}
                className="font-mono text-xs"
              />
            </label>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <code className="rounded bg-background/60 px-2 py-1 font-mono text-xs">
            {svc.command}
          </code>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline" className="font-mono text-[10px]">
              {svc.portStrategy}
            </Badge>
            {svc.port !== undefined && (
              <Badge variant="outline" className="font-mono text-[10px]">
                port {svc.port}
              </Badge>
            )}
            {ready && (
              <Badge variant="secondary" className="font-mono text-[10px]">
                {ready}
              </Badge>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function EnvReview({ loom }: { loom: Loom }) {
  const proposal = loom.proposedServers;
  // Steer draft — a full copy of the proposal so untouched fields (readyCheck,
  // env, portInject, restartPolicy…) survive an edit; we mutate only what the
  // form exposes (driver, per-service command / portStrategy / port).
  const [draft, setDraft] = useState<ServersConfig | undefined>(proposal);
  const [steering, setSteering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const services = useMemo(
    () => Object.entries(draft?.services ?? {}),
    [draft],
  );

  // On success, leave `busy=true` — the button stays loading until the page's
  // SSE loop flips loom.state off "env-review" and the gate unmounts this.
  const post = useCallback(
    async (url: string, body?: unknown) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(url, {
          method: "POST",
          ...(body !== undefined
            ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
            : {}),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          throw new Error(data.error ?? "Request failed.");
        }
        window.dispatchEvent(new Event("telar:refresh"));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    },
    [],
  );

  // Accept-as-is sends no body; Steer sends the edited draft config.
  const accept = useCallback(() => {
    if (steering) return post(`/api/looms/${loom.id}/env/approve`, { config: draft });
    return post(`/api/looms/${loom.id}/env/approve`);
  }, [loom.id, steering, draft, post]);

  const reject = useCallback(
    () => post(`/api/looms/${loom.id}/env/reject`),
    [loom.id, post],
  );

  const updateService = useCallback((name: string, next: ServiceConfig) => {
    setDraft((prev) =>
      prev ? { ...prev, services: { ...prev.services, [name]: next } } : prev,
    );
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4">
      <div className="space-y-1 px-1">
        <h2 className="text-sm font-medium">Review the environment</h2>
        <p className="text-sm text-muted-foreground">
          This loom needs a running app to verify, but the project has no server
          recipe. Telar drafted the config below — it has not started anything.
          Accept to persist it and run the verified build, or steer the values
          first.
        </p>
      </div>

      {!proposal || !draft ? (
        <Card>
          <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
            <ServerIcon className="size-4 shrink-0" />
            No environment proposal recorded for this loom.
          </CardContent>
        </Card>
      ) : (
        <Card className="border-l-2 border-l-amber-500/40">
          <CardContent className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                driver
              </span>
              {steering ? (
                <Select
                  value={draft.driver}
                  onValueChange={(v) =>
                    setDraft((prev) =>
                      prev ? { ...prev, driver: v as ServersConfig["driver"] } : prev,
                    )
                  }
                >
                  <SelectTrigger className="h-7 w-44 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="host-process">host-process</SelectItem>
                    <SelectItem value="none">none</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Badge variant="secondary" className="font-mono text-[10px]">
                  {draft.driver}
                </Badge>
              )}
            </div>

            {services.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                The proposal declares no services.
              </p>
            ) : (
              services.map(([name, svc]) => (
                <ServiceRow
                  key={name}
                  name={name}
                  svc={svc}
                  editable={steering}
                  onChange={(next) => updateService(name, next)}
                />
              ))
            )}
          </CardContent>
        </Card>
      )}

      {error && <p className="px-1 text-sm text-destructive">{error}</p>}

      <div className="flex items-center justify-between gap-3 px-1">
        <p className="text-xs text-muted-foreground">
          Accepting persists <code className="font-mono">.telar/servers.yaml</code>{" "}
          and re-runs verification — the Verifier still gates completion.
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={reject} disabled={busy || !proposal}>
            Reject
          </Button>
          {steering ? (
            <Button
              variant="outline"
              onClick={() => {
                setSteering(false);
                setDraft(proposal);
              }}
              disabled={busy}
            >
              <XIcon />
              Cancel edits
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => setSteering(true)}
              disabled={busy || !proposal}
            >
              <PencilIcon />
              Steer
            </Button>
          )}
          <Button onClick={accept} disabled={busy || !proposal}>
            {busy && <Loader2Icon className="animate-spin" />}
            {steering ? "Accept edits" : "Accept"}
          </Button>
        </div>
      </div>
    </div>
  );
}
