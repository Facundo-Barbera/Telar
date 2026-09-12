"use client";

/**
 * REMEMBERED LOGINS — the standing authorizations a person gave on a
 * `secret_access` approval card, and the one place to take them back.
 *
 * WHY THIS PANE HAS TO EXIST. A permission granted inside a modal, mid-task, is
 * only half a permission: the other half is being able to find it again later
 * and say no. So this lists every grant in the words of the decision that made
 * it — which login, in which browser profile, on which exact address, for which
 * fields — and revoking is one button with no confirmation to talk anyone out
 * of it.
 *
 * READ AND REVOKE ONLY. There is no "add" here, deliberately: a grant can be
 * created in exactly one way, by ticking an unchecked box on a fill a person
 * was already approving with the page in front of them. A settings screen that
 * could mint one would be a settings screen that hands out vault access at a
 * distance.
 *
 * NO VALUES, ANYWHERE. Everything below is metadata the engine already shows on
 * the approval card; the vault is still the only thing that holds a secret, and
 * it still asks to unlock on every fill.
 */

import { useCallback, useEffect, useState } from "react";
import { KeyRoundIcon } from "lucide-react";
import type { RememberedLogin } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

/** "username + password", "password + one-time code" — the words the card
 *  used, not the enum. */
export function describeGrantFields(fields: RememberedLogin["fields"]): string {
  return fields
    .map((field) => (field.kind === "otp" ? "one-time code" : field.kind === "field" ? `“${field.label ?? ""}”` : field.kind))
    .join(" + ");
}

export function describeLastUsed(grant: RememberedLogin, now = Date.now()): string {
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
    // THE ENUMERATION WAS THE LIST'S JOB ALL ALONG. This header used to spell
    // out what a grant covers — item, profile, address, fields — which is
    // exactly the four facts every card below already prints. A header that
    // narrates its own list makes the reader parse the sentence and then parse
    // the list to check it. What survives is the scope, plus the one thing no
    // card can show because it happens at fill time: the vault still locks.
    <SettingsGroup
      title="Remembered logins"
      description="Logins you allowed agents to fill without asking again — 1Password still asks to unlock."
    >
      {error && <p className="text-xs text-destructive">{error}</p>}
      {logins === undefined && !error && <Spinner className="size-4" />}
      {/* A row rather than a loose paragraph, so the empty state sits on the
          same grid as the list it replaces. */}
      {logins?.length === 0 && (
        <Row label="No remembered logins" hint="Telar asks before every fill; the approval card offers to remember one." />
      )}
      <div className="flex flex-col gap-2">
        {(logins ?? []).map((grant) => (
          <div key={grant.id} className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
            <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="truncate text-sm font-medium">{grant.itemTitle}</p>
              <p className="truncate font-mono text-[0.625rem] text-muted-foreground">{grant.origin}</p>
              <p className="text-xs text-muted-foreground">
                {grant.profileLabel ?? grant.profileId} · {describeGrantFields(grant.fields)}
                {grant.vault && <> · {grant.vault}</>} · {describeLastUsed(grant)}
              </p>
            </div>
            {/* WHAT REVOKING DOES NOT DESTROY, on the control that does it.
                Nothing leaves 1Password and no password changes — the grant is
                the only thing that goes, and the next fill asks again. Said in
                the tooltip rather than a fourth line on every card, because it
                is the same sentence for all of them and it is only needed at
                the moment the pointer is on the button. */}
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
