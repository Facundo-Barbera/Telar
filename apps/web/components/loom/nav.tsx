"use client";

/**
 * THE LOOMS ARM OF THE RAIL.
 *
 * THE ONE IDEA: the deck shows everything; the SIDEBAR SHOWS ONLY WHAT NEEDS
 * YOU. That is the answer to "the rail would get too crowded" — a rail that
 * lists every loom and every session one spawns is an INVENTORY, and an
 * inventory grows without bound. A queue of demands does not: it is empty most
 * of the time and it is short when it is not.
 *
 * So this carries the deck, the projects, and the count of things blocked on a
 * person. It does not carry looms.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { HandIcon, LayoutListIcon, RadioIcon } from "lucide-react";
import { useLoomOverview } from "@/lib/loom-overview";
import { SidebarGroup, SidebarGroupContent } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

export function LoomsNav() {
  const pathname = usePathname();
  const { overview } = useLoomOverview();
  const asking = overview.looms.filter((loom) => loom.state === "asking").length;
  const assumed = overview.projects.reduce((total, project) => total + project.assumed.length, 0);
  const needsYou = asking + assumed;

  return (
    <div className="flex min-h-0 flex-col">
      <SidebarGroup className="pt-2">
        <SidebarGroupContent className="flex flex-col gap-0.5">
          <Row href="/looms" icon={LayoutListIcon} label="The deck" active={pathname === "/looms"}>
            {needsYou > 0 && (
              <span className="ml-auto flex items-center gap-1 font-mono text-[10px] text-warning">
                <HandIcon className="size-2.5 shrink-0" />
                {needsYou}
              </span>
            )}
          </Row>
        </SidebarGroupContent>
      </SidebarGroup>

      {overview.projects.length > 0 && (
        <SidebarGroup>
          <SidebarGroupContent className="flex flex-col gap-0.5">
            <span className="px-2 pb-1 text-[10px] font-medium tracking-wide text-sidebar-foreground/45 uppercase">
              Orchestrators
            </span>
            {overview.projects.map((project) => {
              const href = `/looms/${encodeURIComponent(project.projectId)}`;
              return (
                <Row key={project.projectId} href={href} icon={RadioIcon} label={project.name || project.projectId} active={pathname === href}>
                  <span
                    className={cn(
                      "ml-auto size-1.5 shrink-0 rounded-full",
                      project.watch.running ? "bg-success" : "bg-sidebar-foreground/25",
                    )}
                    title={project.watch.running ? "watching" : "paused"}
                  />
                </Row>
              );
            })}
          </SidebarGroupContent>
        </SidebarGroup>
      )}
    </div>
  );
}

function Row({
  href,
  icon: Icon,
  label,
  active,
  children,
}: {
  href: string;
  icon: React.ElementType;
  label: string;
  active: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
    >
      <Icon
        className={cn("size-3.5 shrink-0", active ? "text-sidebar-accent-foreground" : "text-sidebar-foreground/50")}
        aria-hidden
      />
      <span className="min-w-0 truncate">{label}</span>
      {children}
    </Link>
  );
}
