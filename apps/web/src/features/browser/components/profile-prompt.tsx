"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  desktopBrowserProfiles,
  profileNameProblem,
  type BrowserProfile,
} from "@/lib/desktop-browser-profiles";

export type NewProfileOptions = {
  scopeKey?: string;
  assignProject?: boolean;
};

export function NewBrowserProfileDialog({
  open,
  onOpenChange,
  existing,
  scopeKey,
  assignProject,
  onCreated,
}: NewProfileOptions & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: BrowserProfile[];
  onCreated?: (profile: BrowserProfile) => void;
}) {
  const [label, setLabel] = useState("");
  const [account, setAccount] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const close = (next: boolean) => {
    if (!next) {
      setLabel("");
      setAccount("");
      setError(undefined);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    const problem = profileNameProblem(label, existing);
    if (problem) {
      setError(problem);
      return;
    }
    const bridge = desktopBrowserProfiles();
    if (!bridge) {
      setError("The desktop app owns browser profiles; this tab cannot create one.");
      return;
    }
    setBusy(true);
    try {
      const answer = await bridge.createProfile({
        label: label.trim(),
        ...(account.trim() ? { account: account.trim() } : {}),
        ...(scopeKey ? { scopeKey } : {}),
        ...(assignProject ? { assignProject: true } : {}),
      });
      onCreated?.(answer.active);
      close(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That profile could not be created.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New browser profile</DialogTitle>
          <DialogDescription>
            A separate set of cookies and logins. Projects you assign to it share one sign-in; everything else keeps browsing where it
            already does.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">Name</span>
            <Input
              name="label"
              value={label}
              autoComplete="off"
              placeholder="Work, Personal, Client review…"
              onChange={(event) => {
                setLabel(event.target.value);
                setError(undefined);
              }}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">Expected account (optional)</span>
            <Input
              name="account"
              value={account}
              autoComplete="off"
              placeholder="me@work.example"
              className="font-mono text-xs"
              onChange={(event) => setAccount(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">Who you mean to be signed in as here. A reminder, not a check.</span>
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !label.trim()}>
              Create profile
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
