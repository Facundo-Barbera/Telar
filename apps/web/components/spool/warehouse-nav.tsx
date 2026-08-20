"use client";

/**
 * THE RAIL — `docs/spool-loops.md` §13.2, "the floor plan, and nothing
 * else," narrowed again by §13.8 ("the map is content, not chrome"),
 * 2026-08-19. Before this pass the rail ALSO carried the Areas → subjects
 * tree and every one of its drag/rename/reorder/ceiling gestures — added in
 * the 2026-08-18 "hand-management" pass. §13.8 retires that: the tree is
 * CONTENT (a map the user reads and rearranges), not CHROME (a floor plan a
 * user glances at to pick a room), so it moved wholesale into
 * `lobby.tsx`'s own content pane, reachable by walking the map rather than
 * scanning a permanently-open sidebar list. The rail is FLOOR PLAN ONLY
 * again — Lobby, Today, Scheduled, Assistant — and every click GOES TO A
 * ROOM. There is no tree here, no drag, no filter, no lane, no tag: those
 * live inside the room they belong to.
 *
 * Every control here drives STATE THAT `SpoolStance` ALREADY OWNS — which
 * room is open — through `lib/spool-room.ts`, never a second copy of it.
 * This file renders controls; it does not own a single fact.
 *
 * A PINS GROUP WAS ASKED FOR (§13.8: "subjects the user pinned") AND IS
 * OMITTED — no such concept exists yet. `SpoolPin` (`packages/engine-client`'s
 * protocol) is an ITEM's placement on a day, not a subject bookmark; inventing
 * a subject-pin field on the engine's own store is plumbing this web-only
 * pass does not open. The rail below renders exactly its four fixed rooms
 * and nothing else, honestly, until that concept exists.
 *
 * THE WAREHOUSE'S OWN RAIL ENTRY IS ALSO GONE — §13.8 dissolves the room
 * itself (`docs/spool-loops.md` §13.8, and `lib/spool-room.ts`'s own doc
 * comment on the retired `warehouse` room kind).
 */
import { CalendarDaysIcon, DoorOpenIcon, MessageCircleIcon, SunIcon } from "lucide-react";
import { SpoolSearchControl } from "@/components/spool/search";
import { useSpoolRoom, useSpoolRoomControls } from "@/lib/spool-room";
import { SidebarGroup, SidebarGroupContent } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/** Shared caption scale — `app-sidebar.tsx`'s own `BandRule` labels match
 *  this exact string (see idiom.test.ts's cross-file scale pin). No caption
 *  renders in this file any more (the Areas group it used to label is gone),
 *  but the constant stays, declared and unused, so the two rails' scale
 *  stays provably identical. */
const CAPTION = "text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/45";

export function SpoolWarehouseNav() {
  const room = useSpoolRoom();
  const controls = useSpoolRoomControls();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
      <SidebarGroup className="pt-2">
        <SidebarGroupContent>
          <SpoolSearchControl onHit={controls.openSearchHit} />
        </SidebarGroupContent>
      </SidebarGroup>

      {/* THE FLOOR PLAN'S FOUR FIXED ROOMS — Lobby is home (and, since
          §13.8, the map itself), Today and Scheduled are the two
          day-shaped rooms every subject can appear in, and Assistant is
          the conversation's other door (§13.6). */}
      <SidebarGroup>
        <SidebarGroupContent className="flex flex-col gap-0.5">
          {(
            [
              { kind: "lobby" as const, label: "Lobby", icon: DoorOpenIcon, go: controls.goLobby },
              { kind: "today" as const, label: "Today", icon: SunIcon, go: controls.goToday },
              { kind: "scheduled" as const, label: "Scheduled", icon: CalendarDaysIcon, go: controls.goScheduled },
              /**
               * THE ASSISTANT'S OWN ROOM — `docs/spool-loops.md` §13.6, "the
               * assistant's two doors." The rail's fourth and now LAST fixed
               * destination: the same conversation the summoned layer holds,
               * full-width, reached directly rather than only by expanding
               * out of the layer. Same active-state treatment as every other
               * room here — no new `--spool` mark, the quiet glyph carries
               * no hue of its own.
               */
              { kind: "assistant" as const, label: "Assistant", icon: MessageCircleIcon, go: controls.goAssistant },
            ]
          ).map((entry) => {
            // An area page is still the Lobby's own map, one level in — its
            // button stays pressed while walking the map, the same way a
            // subject's own room has no separate rail entry of its own.
            const active = room.room.kind === entry.kind || (entry.kind === "lobby" && room.room.kind === "area");
            return (
              <button
                key={entry.kind}
                type="button"
                aria-pressed={active}
                onClick={entry.go}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  active
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )}
              >
                <entry.icon
                  className={cn("size-3.5 shrink-0", active ? "text-sidebar-accent-foreground" : "text-sidebar-foreground/50")}
                  aria-hidden
                />
                {entry.label}
              </button>
            );
          })}
        </SidebarGroupContent>
      </SidebarGroup>
    </div>
  );
}
