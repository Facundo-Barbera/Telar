"use client";

/**
 * THE LOOMS RAIL — the floor plan of the looms place, in the exact idiom of
 * the Spool's rail (`components/spool/warehouse-nav.tsx`): fixed rooms first,
 * then the open looms as destinations. Every click GOES TO A ROOM; nothing
 * here owns a fact the /api/looms surface does not already own.
 *
 * Accepted looms drop into a collapsed group rather than vanishing — the
 * finished work is still evidence, it just should not crowd the plan.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRightIcon, PlusIcon, WorkflowIcon } from "lucide-react";
import { SidebarGroup, SidebarGroupContent } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const CAPTION = "text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/45";

interface NavLoom {
  id: string;
  title: string;
  slug?: string;
  state: "working" | "verifying" | "ready" | "accepted";
  threads: Array<{ sessionId: string }>;
}

const STATE_DOT: Record<NavLoom["state"], string> = {
  working: "bg-info",
  verifying: "bg-verify",
  ready: "bg-success",
  accepted: "bg-muted-foreground/40",
};

export function LoomsNav() {
  const pathname = usePathname();
  const [looms, setLooms] = useState<NavLoom[]>([]);
  const [acceptedOpen, setAcceptedOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/looms");
      if (r.ok) setLooms(((await r.json()) as { looms: NavLoom[] }).looms);
    } catch {
      // The rail is a floor plan, not a status monitor — a failed poll keeps
      // the last plan rather than blanking it.
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const poll = setInterval(() => void refresh(), 15_000);
    return () => {
      clearTimeout(initial);
      clearInterval(poll);
    };
  }, [refresh]);

  const open = looms.filter((loom) => loom.state !== "accepted");
  const accepted = looms.filter((loom) => loom.state === "accepted");
  const atBoard = pathname === "/looms";

  const row = (loom: NavLoom) => {
    const active = pathname.startsWith(`/looms/${loom.id}`);
    return (
      <Link
        key={loom.id}
        href={`/looms/${loom.id}`}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
          active
            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
            : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        )}
      >
        <span className={cn("size-2 shrink-0 rounded-full", STATE_DOT[loom.state])} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{loom.title}</span>
        <span className="shrink-0 font-mono text-[10px] text-sidebar-foreground/40">{loom.threads.length}</span>
      </Link>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
      <SidebarGroup className="pt-2">
        <SidebarGroupContent className="flex flex-col gap-0.5">
          <Link
            href="/looms"
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              atBoard
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            )}
          >
            <WorkflowIcon
              className={cn("size-3.5 shrink-0", atBoard ? "text-sidebar-accent-foreground" : "text-sidebar-foreground/50")}
              aria-hidden
            />
            All looms
          </Link>
          <Link
            href="/looms/new"
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              pathname === "/looms/new"
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            )}
          >
            <PlusIcon
              className={cn("size-3.5 shrink-0", pathname === "/looms/new" ? "text-sidebar-accent-foreground" : "text-sidebar-foreground/50")}
              aria-hidden
            />
            New loom
          </Link>
        </SidebarGroupContent>
      </SidebarGroup>

      {open.length > 0 ? (
        <SidebarGroup>
          <div className={cn(CAPTION, "px-2 pb-1")}>On the loom</div>
          <SidebarGroupContent className="flex flex-col gap-0.5">{open.map(row)}</SidebarGroupContent>
        </SidebarGroup>
      ) : null}

      {accepted.length > 0 ? (
        <SidebarGroup>
          <button
            type="button"
            onClick={() => setAcceptedOpen((v) => !v)}
            className={cn(CAPTION, "flex w-full items-center gap-1 px-2 pb-1 text-left")}
            aria-expanded={acceptedOpen}
          >
            <ChevronRightIcon className={cn("size-3 transition-transform", acceptedOpen && "rotate-90")} aria-hidden />
            Accepted
            <span className="ml-auto font-mono">{accepted.length}</span>
          </button>
          {acceptedOpen ? (
            <SidebarGroupContent className="flex flex-col gap-0.5">{accepted.map(row)}</SidebarGroupContent>
          ) : null}
        </SidebarGroup>
      ) : null}
    </div>
  );
}
