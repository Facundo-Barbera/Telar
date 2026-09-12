"use client";

/**
 * "NAME THIS PROFILE" — the one create form for browser profiles, shared by
 * Settings → Integrations and the browser panel's profile picker.
 *
 * WHY A SHARED PROMPT AND NOT TWO FORMS. A profile's name is now required (the
 * registry no longer invents one), and "required" has to mean the same thing in
 * both places or the panel becomes the door that lets an unnamed identity in.
 * Keeping the field, the validation and the wording in one component is what makes
 * that true rather than intended.
 *
 * TWO WAYS IN, ON PURPOSE:
 *   - `<NewBrowserProfileDialog>` for a caller that already has somewhere to hang
 *     open state — the settings pane, which has a button beside a list;
 *   - `promptForNewBrowserProfile()` for a caller that has an event handler and
 *     wants a profile back — a menu item in the panel's picker. It mounts this
 *     same dialog in a root of its own and resolves to the created profile, or
 *     null if the person closed it.
 *
 * THE NATIVE VIEW IS THE CALLER'S PROBLEM, and it has to be said out loud: in the
 * browser panel a WebContentsView is composited ABOVE the renderer's DOM, so a
 * dialog opened while a page is showing is behind that page. Whoever calls from
 * the panel hides or shrinks the view first — this component cannot know which.
 */

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  desktopBrowserProfiles,
  profileNameProblem,
  type BrowserProfile,
} from "@/lib/desktop-browser-profiles";

export type NewProfileOptions = {
  /** A session's scope key: the new profile becomes that session's, which is
   *  nearly always why someone creates one from the panel. */
  scopeKey?: string;
  /** Also assign the session's PROJECT to it, so every later session joins. */
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
  /** Every profile that already exists — only used to refuse a duplicate name. */
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
            {/* Said here rather than discovered later: this field is a note to
                yourself, and nothing in Telar checks a session against it. */}
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

/**
 * Ask for a name, create the profile, hand it back. Resolves null if the person
 * closed the prompt without creating one, and rejects nothing — a failed create
 * is reported inside the dialog, where the field that caused it still is.
 *
 * Mounts in a root of its own so any event handler can call it; the container is
 * removed once the close animation has run.
 */
export function promptForNewBrowserProfile(options: NewProfileOptions = {}): Promise<BrowserProfile | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  const bridge = desktopBrowserProfiles();
  return new Promise((resolve) => {
    void (async () => {
      // Only to refuse a duplicate name. A bridge that will not answer is not a
      // reason to refuse the prompt — the create call reports its own failure.
      const existing = await bridge?.profiles().then((answer) => answer.profiles).catch(() => []);
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      let created: BrowserProfile | null = null;
      const dismiss = () => {
        root.render(
          <NewBrowserProfileDialog open={false} onOpenChange={() => {}} existing={existing ?? []} />,
        );
        // Unmounting inside the dialog's own close handler would tear the tree
        // down mid-commit; this also lets the exit animation finish.
        window.setTimeout(() => {
          root.unmount();
          container.remove();
          resolve(created);
        }, 200);
      };
      root.render(
        <NewBrowserProfileDialog
          open
          existing={existing ?? []}
          {...options}
          onCreated={(profile) => {
            created = profile;
          }}
          onOpenChange={(next) => {
            if (!next) dismiss();
          }}
        />,
      );
    })();
  });
}
