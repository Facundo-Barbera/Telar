"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Loader2Icon,
  MessageSquarePlusIcon,
  PlayIcon,
  ShieldIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ProjectManifest, RegistryEntry } from "@telar/core";
import { fmtAgo } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function UnregisterButton({
  name,
  onDone,
}: {
  name: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await fetch(`/api/projects/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
    } catch {
      /* best-effort — refetch will reveal the true state */
    } finally {
      setBusy(false);
      setOpen(false);
      onDone();
      window.dispatchEvent(new Event("telar:refresh"));
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            aria-label={`Unregister ${name}`}
          />
        }
      >
        <Trash2Icon />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <PopoverHeader>
          <PopoverTitle>Unregister {name}?</PopoverTitle>
          <PopoverDescription>
            Removes it from the registry. The repo and its telar.yaml stay
            untouched.
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void remove()}
            disabled={busy}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
            Unregister
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ProjectCard({
  entry,
  manifest,
  onChanged,
}: {
  entry: RegistryEntry;
  manifest: ProjectManifest;
  onChanged: () => void;
}) {
  const router = useRouter();
  const { guardrails } = manifest;
  const guards: string[] = [];
  if (guardrails.protectedPaths.length)
    guards.push(plural(guardrails.protectedPaths.length, "protected path"));
  if (guardrails.disallowedTools.length)
    guards.push(plural(guardrails.disallowedTools.length, "disallowed tool"));

  return (
    <Card className="transition-shadow hover:ring-foreground/20">
      <CardHeader>
        <CardTitle className="truncate">
          <Link
            href={`/projects/${encodeURIComponent(entry.name)}`}
            className="underline-offset-4 outline-none hover:underline focus-visible:underline"
            title={manifest.name}
          >
            {manifest.name}
          </Link>
        </CardTitle>
        <CardAction>
          <UnregisterButton name={entry.name} onDone={onChanged} />
        </CardAction>
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <Badge variant="secondary" className="font-mono text-[10px]">
            {manifest.adapter}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {manifest.account}
          </Badge>
          <Badge variant="outline" className="font-mono text-[10px]">
            {manifest.baseBranch}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3">
        <p
          className="truncate font-mono text-xs text-muted-foreground"
          title={manifest.root}
        >
          {manifest.root}
        </p>

        <div className="space-y-1.5">
          <div className="text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">
            Gates
          </div>
          {manifest.gates.length === 0 ? (
            <p className="text-xs text-muted-foreground/60">
              No gates — verdict-only.
            </p>
          ) : (
            <div className="space-y-1">
              {manifest.gates.map((gate, i) => (
                <div
                  key={`${gate.name}-${i}`}
                  className="flex items-baseline justify-between gap-3 rounded-md bg-muted/40 px-2 py-1"
                >
                  <span className="shrink-0 text-xs font-medium">
                    {gate.name}
                  </span>
                  <code
                    className="truncate font-mono text-[11px] text-muted-foreground"
                    title={gate.run}
                  >
                    {gate.run}
                  </code>
                </div>
              ))}
            </div>
          )}
        </div>

        {guards.length > 0 && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldIcon className="size-3.5 shrink-0" />
            {guards.join(" · ")}
          </p>
        )}
      </CardContent>

      <CardFooter className="justify-between gap-2">
        {/* Planning-first: a session (read-only, quick to start) leads; a loom
            (which writes) is the secondary action. */}
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            render={
              <Link
                href={`/projects/${encodeURIComponent(entry.name)}/sessions/new`}
              />
            }
          >
            <MessageSquarePlusIcon />
            New session
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              router.push(`/looms?new=1&project=${encodeURIComponent(entry.name)}`)
            }
          >
            <PlayIcon />
            New loom session
          </Button>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground/60">
          added {fmtAgo(entry.addedAt)}
        </span>
      </CardFooter>
    </Card>
  );
}

export function ProjectErrorCard({
  entry,
  error,
  onChanged,
}: {
  entry: RegistryEntry;
  error: string;
  onChanged: () => void;
}) {
  return (
    <Card className="bg-destructive/5 ring-destructive/25">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 truncate" title={entry.name}>
          <TriangleAlertIcon className="size-4 shrink-0 text-destructive" />
          <span className="truncate">{entry.name}</span>
        </CardTitle>
        <CardAction>
          <UnregisterButton name={entry.name} onDone={onChanged} />
        </CardAction>
        <Badge variant="destructive" className="mt-0.5 w-fit text-[10px]">
          manifest error
        </Badge>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3">
        <p
          className="truncate font-mono text-xs text-muted-foreground"
          title={entry.root}
        >
          {entry.root}
        </p>
        <p className="rounded-md bg-destructive/10 px-2 py-1.5 font-mono text-[11px] break-words text-destructive/90">
          {error}
        </p>
      </CardContent>

      <CardFooter className="justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          Fix the telar.yaml, or unregister it.
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/60">
          added {fmtAgo(entry.addedAt)}
        </span>
      </CardFooter>
    </Card>
  );
}
