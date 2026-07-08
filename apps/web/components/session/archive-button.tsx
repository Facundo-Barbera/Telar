"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArchiveIcon, ArchiveRestoreIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

// The per-session archive control. `archived` reflects the row's current
// state: false archives it, true restores it. PATCHes the chat, then
// router.refresh() (re-runs any server-rendered list, e.g. the rail) and
// broadcasts telar:refresh so client surfaces (project detail, dashboard,
// sidebar) refetch too. An optional onDone lets a client parent refetch
// directly without waiting on the broadcast.
export function ArchiveButton({
  id,
  archived = false,
  onDone,
  className,
}: {
  id: string;
  archived?: boolean;
  onDone?: () => void;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const toggle = async (e: React.MouseEvent) => {
    // The control often sits inside (or atop) a link row — never navigate.
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await fetch(`/api/chats/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: !archived }),
      });
    } catch {
      // best-effort — the refresh below reflects the true persisted state
    } finally {
      router.refresh();
      onDone?.();
      window.dispatchEvent(new Event("telar:refresh"));
      setBusy(false);
    }
  };

  const label = archived ? "Restore session" : "Archive session";
  const Icon = archived ? ArchiveRestoreIcon : ArchiveIcon;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={toggle}
      disabled={busy}
      aria-label={label}
      title={label}
      className={cn(
        "text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      {busy ? <Spinner className="size-3" /> : <Icon />}
    </Button>
  );
}
