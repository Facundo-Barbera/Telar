"use client";

import { useCallback, useEffect, useState } from "react";
import {
  KeyRoundIcon,
  RotateCwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/common/empty-state";

// A project's always-allow permission rules. Registry-scoped, so it loads and
// mutates independently of the manifest form — a broken telar.yaml still lets
// you prune stale rules here.
export function SettingsPermissions({ project }: { project: string }) {
  const [rules, setRules] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/permissions/${encodeURIComponent(project)}`,
      );
      if (!res.ok)
        throw new Error(`Couldn't load permission rules (${res.status}).`);
      const data = (await res.json()) as { rules?: string[] };
      setRules(data.rules ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRules(null);
    }
  }, [project]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (rule: string) => {
    setRemoving(rule);
    try {
      await fetch(`/api/permissions/${encodeURIComponent(project)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rule }),
      });
    } catch {
      // best-effort — the reload below reflects the true persisted state
    } finally {
      setRemoving(null);
      void load();
    }
  };

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <KeyRoundIcon className="size-4 text-muted-foreground" />
          Always-allow rules
        </CardTitle>
        <CardDescription>
          Permissions this project auto-approves. Added when you answer
          &ldquo;Always allow&rdquo; to a tool prompt in a session.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rules === null ? (
          error ? (
            <EmptyState
              className="py-10"
              icon={TriangleAlertIcon}
              iconClassName="text-destructive/60"
              title="Couldn't load rules"
              description={
                <span className="font-mono text-xs break-words">{error}</span>
              }
              action={
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  <RotateCwIcon />
                  Retry
                </Button>
              }
            />
          ) : (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full rounded-lg" />
              <Skeleton className="h-8 w-3/4 rounded-lg" />
            </div>
          )
        ) : rules.length === 0 ? (
          <EmptyState
            className="py-10"
            icon={ShieldCheckIcon}
            title="No always-allow rules"
            description="Answer “Always allow” to a tool prompt in a session and the rule lands here."
          />
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {rules.map((rule) => (
              <li
                key={rule}
                className="flex items-center gap-2 px-2.5 py-1.5"
              >
                <code
                  className="min-w-0 flex-1 truncate font-mono text-xs"
                  title={rule}
                >
                  {rule}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => void remove(rule)}
                  disabled={removing === rule}
                  aria-label={`Remove rule ${rule}`}
                >
                  {removing === rule ? <Spinner className="size-3" /> : <XIcon />}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
