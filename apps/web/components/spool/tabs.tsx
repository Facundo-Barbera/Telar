"use client";

/**
 * The Spool's internal nav.
 *
 * `ui-contract.md`'s Shell section: the Spool is ONE top-level destination with
 * TWO tabs — Chat is the front door, the Queue is the drawer behind it. The
 * queue does not pretend to be its own destination, which is why the hrefs run
 * `/spool` for chat and `/spool/queue` beneath it rather than the other way
 * round.
 *
 * BOTH TABS ARE LIVE. Chat was rendered inert here for as long as the
 * project-less session did not exist — "a real href would be a promise this
 * story does not keep" — and the promise is now kept, so the disabled span is
 * gone rather than left wearing a tooltip that lies.
 */
import Link from "next/link";
import { ListTodoIcon, MessageSquareIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors";
const ON = "bg-muted font-medium text-foreground";
const OFF = "text-muted-foreground hover:bg-muted/60 hover:text-foreground";

export function SpoolTabs({ active }: { active: "chat" | "queue" }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border p-0.5">
      <Link
        href="/spool"
        aria-current={active === "chat" ? "page" : undefined}
        className={cn(BASE, active === "chat" ? ON : OFF)}
      >
        <MessageSquareIcon className="size-3.5" />
        Chat
      </Link>
      <Link
        href="/spool/queue"
        aria-current={active === "queue" ? "page" : undefined}
        className={cn(BASE, active === "queue" ? ON : OFF)}
      >
        <ListTodoIcon className="size-3.5" />
        Queue
      </Link>
    </div>
  );
}
