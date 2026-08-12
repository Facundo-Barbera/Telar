"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  FolderOpenIcon,
  FolderPlusIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";

function Field({
  htmlFor,
  label,
  hint,
  children,
}: {
  htmlFor?: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function RegisterProjectDialog({
  onRegistered,
  compact = false,
}: {
  onRegistered: () => void;
  compact?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [root, setRoot] = useState("");
  const [addToGitignore, setAddToGitignore] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Native folder picker on the server host — fills the path input. Only ever
  // fires on an explicit click; a cancelled dialog leaves the field untouched.
  const browse = async () => {
    setBrowsing(true);
    try {
      const res = await fetch("/api/browse", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        path?: string;
        cancelled?: boolean;
      };
      if (data.path) setRoot(data.path);
    } catch {
      /* ignore — the user can still type the path by hand */
    } finally {
      setBrowsing(false);
    }
  };

  const basename =
    root
      .trim()
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? "";

  const reset = () => {
    setRoot("");
    setAddToGitignore(false);
    setName("");
    setError(null);
    setSubmitting(false);
    setBrowsing(false);
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) reset();
  };

  const submit = async () => {
    const trimmedRoot = root.trim();
    if (!trimmedRoot) {
      setError("Enter the absolute path to a repository.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const manifest = { name: name.trim() || basename };

      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: trimmedRoot, manifest, addToGitignore }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        manifest?: { name: string };
      };
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);

      handleOpenChange(false);
      onRegistered();
      window.dispatchEvent(new Event("telar:refresh"));
      if (data.manifest?.name)
        router.push(`/projects/${encodeURIComponent(data.manifest.name)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            id={compact ? "sidebar-new-project-btn" : "register-project-btn"}
            size={compact ? "icon-sm" : "sm"}
            variant={compact ? "ghost" : "default"}
            aria-label={compact ? "New project" : undefined}
            title={compact ? "New project" : undefined}
          />
        }
      >
        <FolderPlusIcon />
        {!compact && "Register project"}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Register a project</DialogTitle>
          <DialogDescription>
            Point Telar at a repo. An existing telar.yaml is preserved; when it
            is missing, Telar creates one automatically.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid max-h-[60dvh] gap-4 overflow-y-auto pr-0.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!submitting) void submit();
          }}
        >
          <Field
            htmlFor="project-root"
            label="Repository path"
            hint="Absolute path to the repo root on this machine."
          >
            <div className="flex items-center gap-2">
              <Input
                id="project-root"
                value={root}
                onChange={(e) => setRoot(e.target.value)}
                placeholder="/Users/you/code/my-repo"
                className="font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                onClick={() => void browse()}
                disabled={browsing}
              >
                {browsing ? <Spinner /> : <FolderOpenIcon />}
                Browse…
              </Button>
            </div>
          </Field>

          <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-2.5">
            <div className="space-y-0.5">
              <label htmlFor="gitignore-telar" className="text-sm font-medium">
                Add telar.yaml and .telar to .gitignore
              </label>
              <p className="text-xs text-muted-foreground">
                Keep the project manifest and Telar&apos;s local state out of Git.
              </p>
            </div>
            <Switch
              id="gitignore-telar"
              checked={addToGitignore}
              onCheckedChange={(checked) => setAddToGitignore(checked === true)}
            />
          </div>

          <Field
            htmlFor="project-name"
            label="Project name (optional)"
            hint={
              basename
                ? `Defaults to the folder name: ${basename}`
                : "Defaults to the repository folder name."
            }
          >
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={basename || "project-name"}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          {error && (
            <Alert variant="destructive">
              <XIcon />
              <AlertTitle>Couldn&apos;t register</AlertTitle>
              <AlertDescription className="font-mono text-xs break-words">
                {error}
              </AlertDescription>
            </Alert>
          )}
        </form>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={submitting || !root.trim()}
          >
            {submitting && <Loader2Icon className="animate-spin" />}
            Register
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
