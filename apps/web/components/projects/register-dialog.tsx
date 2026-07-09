"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FolderOpenIcon,
  FolderPlusIcon,
  Loader2Icon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useAccounts } from "@/lib/use-accounts";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

type GateRow = { name: string; run: string };

const DEFAULT_GATE: GateRow = { name: "test", run: "bun test" };

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
}: {
  onRegistered: () => void;
}) {
  const router = useRouter();
  const { accounts } = useAccounts();
  const accountNames = accounts.map((a) => a.name);
  const [open, setOpen] = useState(false);
  const [root, setRoot] = useState("");
  const [scaffold, setScaffold] = useState(false);
  const [name, setName] = useState("");
  const [account, setAccount] = useState(accountNames[0] ?? "personal");
  const [gates, setGates] = useState<GateRow[]>([{ ...DEFAULT_GATE }]);
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
    setScaffold(false);
    setName("");
    setAccount(accountNames[0] ?? "personal");
    setGates([{ ...DEFAULT_GATE }]);
    setError(null);
    setSubmitting(false);
    setBrowsing(false);
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) reset();
  };

  const setGate = (index: number, patch: Partial<GateRow>) =>
    setGates((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );

  const submit = async () => {
    const trimmedRoot = root.trim();
    if (!trimmedRoot) {
      setError("Enter the absolute path to a repository.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const manifest = scaffold
        ? {
            name: name.trim() || basename,
            account,
            gates: gates
              .map((g) => ({ name: g.name.trim(), run: g.run.trim() }))
              .filter((g) => g.name && g.run),
          }
        : undefined;

      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: trimmedRoot, create: scaffold, manifest }),
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
      <DialogTrigger render={<Button id="register-project-btn" size="sm" />}>
        <FolderPlusIcon />
        Register project
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Register a project</DialogTitle>
          <DialogDescription>
            Point Telar at a repo. Registering reads its telar.yaml; scaffolding
            writes a fresh one.
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
              <label htmlFor="scaffold" className="text-sm font-medium">
                Scaffold telar.yaml
              </label>
              <p className="text-xs text-muted-foreground">
                Create a manifest for a repo that doesn&apos;t have one yet.
              </p>
            </div>
            <Switch
              id="scaffold"
              checked={scaffold}
              onCheckedChange={(checked) => setScaffold(checked === true)}
            />
          </div>

          {scaffold && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field htmlFor="project-name" label="Name">
                  <Input
                    id="project-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={basename || "project-name"}
                    className="font-mono text-xs"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <Field label="Account">
                  <Select
                    value={account}
                    onValueChange={(v) => v && setAccount(String(v))}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {accountNames.map((a) => (
                        <SelectItem key={a} value={a}>
                          {a}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground">
                    Gates
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Commands whose exit code decides a run.
                  </span>
                </div>
                <div className="space-y-2">
                  {gates.length === 0 && (
                    <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">
                      No gates — runs pass on the agent&apos;s verdict alone.
                    </p>
                  )}
                  {gates.map((gate, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={gate.name}
                        onChange={(e) => setGate(i, { name: e.target.value })}
                        placeholder="name"
                        className="h-8 w-28 shrink-0 text-xs"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={`Gate ${i + 1} name`}
                      />
                      <Input
                        value={gate.run}
                        onChange={(e) => setGate(i, { run: e.target.value })}
                        placeholder="command"
                        className="h-8 flex-1 font-mono text-xs"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={`Gate ${i + 1} command`}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0 text-muted-foreground"
                        onClick={() =>
                          setGates((rows) => rows.filter((_, idx) => idx !== i))
                        }
                        aria-label={`Remove gate ${i + 1}`}
                      >
                        <XIcon />
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setGates((rows) => [...rows, { name: "", run: "" }])
                  }
                >
                  <PlusIcon />
                  Add gate
                </Button>
              </div>
            </>
          )}

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
            {scaffold ? "Scaffold & register" : "Register"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
