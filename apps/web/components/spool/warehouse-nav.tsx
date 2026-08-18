"use client";

/**
 * THE RAIL — `docs/spool-loops.md` §13.2, "the floor plan, and nothing
 * else." Before this pass the rail carried the aperture buttons, quick
 * filters, lanes and tags — controls over a STANCE that squinted at one
 * wide inventory. §13 retired that machine: the rail is FLOOR PLAN ONLY
 * now — Lobby, Today, Scheduled, then the Areas → subjects tree — and
 * every click GOES TO A ROOM. There is no filter here, no lane, no tag, no
 * "widen from this subject": those live inside a subject's room, transient
 * and local to its own Tasks tab, never a shared slot the rail reaches into.
 *
 * Every control here drives STATE THAT `SpoolStance` ALREADY OWNS — which
 * room is open — through `lib/spool-room.ts`, never a second copy of it.
 * This file renders controls; it does not own a single fact.
 *
 * HONEST COUNTS, NEVER A BADGE. The tree's numbers describe what is already
 * on this screen's subject — "what needs you" — the same word the lobby's
 * own card uses, not a notification about something elsewhere. Quiet text,
 * no pill, no red.
 */
import { CalendarDaysIcon, DoorOpenIcon, SunIcon } from "lucide-react";
import { SubjectDot } from "@/components/spool/chips";
import { SpoolSearchControl } from "@/components/spool/search";
import { useSpoolRoom, useSpoolRoomControls, type SpoolRoomAreaLine } from "@/lib/spool-room";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const CAPTION = "text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/45";

/**
 * AREA HEADERS, THE SAME LAW `stance.tsx`'s `groupByArea` OBEYS — stored
 * values only, alphabetical, and the area-less tail sits last under NO
 * header. This is a SEPARATE, smaller grouping function rather than an
 * import of that one: `groupByArea` groups a shape this file has no reason
 * to depend on, and duplicating five lines of grouping is cheaper than
 * coupling two files' shapes together. The law travels with the comment.
 */
export function groupLinesByArea(lines: SpoolRoomAreaLine[]): { area?: string; lines: SpoolRoomAreaLine[] }[] {
  const named = new Map<string, SpoolRoomAreaLine[]>();
  const bare: SpoolRoomAreaLine[] = [];
  for (const line of lines) {
    if (line.area) named.set(line.area, [...(named.get(line.area) ?? []), line]);
    else bare.push(line);
  }
  return [
    ...[...named.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([area, ls]) => ({ area, lines: ls })),
    ...(bare.length > 0 ? [{ lines: bare }] : []),
  ];
}

export function SpoolWarehouseNav() {
  const room = useSpoolRoom();
  const controls = useSpoolRoomControls();

  const groups = groupLinesByArea(room.areas);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
      <SidebarGroup className="pt-2">
        <SidebarGroupContent>
          <SpoolSearchControl onHit={controls.openSearchHit} />
        </SidebarGroupContent>
      </SidebarGroup>

      {/* THE FLOOR PLAN'S THREE FIXED ROOMS — Lobby is home, Today and
          Scheduled are the two day-shaped rooms every subject can appear
          in. No "Everything" any more: the lobby ranks, it does not
          enumerate, so there is no wide inventory left to name. */}
      <SidebarGroup>
        <SidebarGroupContent className="flex flex-col gap-0.5">
          {(
            [
              { kind: "lobby" as const, label: "Lobby", icon: DoorOpenIcon, go: controls.goLobby },
              { kind: "today" as const, label: "Today", icon: SunIcon, go: controls.goToday },
              { kind: "scheduled" as const, label: "Scheduled", icon: CalendarDaysIcon, go: controls.goScheduled },
            ]
          ).map((entry) => (
            <button
              key={entry.kind}
              type="button"
              aria-pressed={room.room.kind === entry.kind}
              onClick={entry.go}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                room.room.kind === entry.kind
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              <entry.icon
                className={cn(
                  "size-3.5 shrink-0",
                  room.room.kind === entry.kind ? "text-sidebar-accent-foreground" : "text-sidebar-foreground/50",
                )}
                aria-hidden
              />
              {entry.label}
            </button>
          ))}
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup className="min-h-0 flex-1">
        <SidebarGroupLabel className={CAPTION}>Areas</SidebarGroupLabel>
        <SidebarGroupContent className="space-y-2.5">
          {groups.length === 0 && (
            <p className="px-2 py-1 text-xs text-sidebar-foreground/50">Nothing filed yet.</p>
          )}
          {groups.map((group, index) => (
            <div key={group.area ?? `__bare-${index}`}>
              {/* A quiet SUBHEADER, not a button — an area is not a
                  control, it is the word the tree hangs its subjects on. */}
              {group.area && (
                <p className="truncate px-2 pb-1 text-[11px] font-medium text-sidebar-foreground/55">{group.area}</p>
              )}
              <div className={cn("space-y-0.5", group.area && "border-l border-sidebar-border/60 pl-2")}>
                {group.lines.map((line) => (
                  <button
                    key={line.subject}
                    type="button"
                    onClick={() => controls.goSubject(line.subject)}
                    aria-pressed={room.room.kind === "subject" && room.room.key === line.subject}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors",
                      room.room.kind === "subject" && room.room.key === line.subject
                        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <SubjectDot color={line.color} />
                    <span className="min-w-0 flex-1 truncate">{line.subject}</span>
                    {/* A quiet count, never a pill — the same "needs you"
                        word the lobby's own card uses, describing this
                        subject's own slice of it, not notifying about it. */}
                    {line.needs > 0 && (
                      <span className="shrink-0 text-xs tabular-nums text-sidebar-foreground/45">{line.needs}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </SidebarGroupContent>
      </SidebarGroup>
    </div>
  );
}
