"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

// Unregister with a two-click confirm: the first click arms the destructive
// action, the second commits it. Dropping the registry entry leaves the repo
// and its telar.yaml untouched.
export function SettingsDanger({ name }: { name: string }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const unregister = async () => {
    setBusy(true);
    try {
      await fetch(`/api/projects/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
    } catch {
      // best-effort — navigating away, the list will show the true state
    } finally {
      window.dispatchEvent(new Event("telar:refresh"));
      router.push("/projects");
    }
  };

  return (
    <Card size="sm" className="ring-destructive/25">
      <CardHeader>
        <CardTitle className="text-destructive">Danger zone</CardTitle>
        <CardDescription>
          Unregistering removes this project from the loom. The repo and its
          telar.yaml stay on disk.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5">
          <div className="min-w-0 space-y-0.5">
            <div className="truncate text-sm font-medium">
              Unregister{" "}
              <code className="font-mono text-[13px]">{name}</code>
            </div>
            <div className="text-xs text-muted-foreground">
              Drops the registry entry. Re-register any time by pointing Telar
              back at the repo.
            </div>
          </div>
          {confirm ? (
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirm(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void unregister()}
                disabled={busy}
              >
                {busy ? <Spinner /> : <Trash2Icon />}
                Confirm
              </Button>
            </div>
          ) : (
            <Button
              variant="destructive"
              size="sm"
              className="shrink-0"
              onClick={() => setConfirm(true)}
            >
              <Trash2Icon />
              Unregister
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
