"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRoundIcon } from "lucide-react";
import type { RememberedLogin } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import { Row, SettingsGroup } from "@/features/settings";

const api = createEngineApi();

function describeGrantFields(fields: RememberedLogin["fields"]): string {
  return fields
    .map((field) => (field.kind === "otp" ? "one-time code" : field.kind === "field" ? `“${field.label ?? ""}”` : field.kind))
    .join(" + ");
}

function describeLastUsed(grant: RememberedLogin, now = Date.now()): string {
  if (!grant.lastUsedAt) return "never used yet";
  const days = Math.floor((now - grant.lastUsedAt) / 86_400_000);
  if (days <= 0) return "used today";
  if (days === 1) return "used yesterday";
  return `used ${days} days ago`;
}

export function BrowserLoginsSection() {
  const [logins, setLogins] = useState<RememberedLogin[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    try {
      setLogins((await api.browserLogins()).logins);
      setError(undefined);
    } catch {
      setError("The engine did not answer.");
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const revoke = async (id: string) => {
    setBusy(id);
    try {
      await api.revokeBrowserLogin(id);
      await load();
    } catch {
      setError("That login could not be revoked.");
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <SettingsGroup
      title="Remembered logins"
      scope="mac"
      description="Logins you allowed agents to fill without asking again — 1Password still asks to unlock."
    >
      {error && <p className="text-xs text-destructive">{error}</p>}
      {logins === undefined && !error && <Spinner className="size-4" />}
      {logins?.length === 0 && (
        <Row label="No remembered logins" hint="Telar asks before every fill; the approval card offers to remember one." />
      )}
      <div className="flex flex-col gap-2">
        {(logins ?? []).map((grant) => (
          <div key={grant.id} className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
            <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="truncate text-sm font-medium">{grant.itemTitle}</p>
              <p className="truncate font-mono text-3xs text-muted-foreground">{grant.origin}</p>
              <p className="text-xs text-muted-foreground">
                {grant.profileLabel ?? grant.profileId} · {describeGrantFields(grant.fields)}
                {grant.vault && <> · {grant.vault}</>} · {describeLastUsed(grant)}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy === grant.id}
              title="Stop filling this login without asking. Nothing in 1Password changes; agents ask again next time."
              className="text-destructive hover:text-destructive"
              onClick={() => void revoke(grant.id)}
            >
              Revoke
            </Button>
          </div>
        ))}
      </div>
    </SettingsGroup>
  );
}
