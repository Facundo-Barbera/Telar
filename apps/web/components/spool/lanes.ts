/**
 * The one text a lane is called by — and the value-to-label map a Select needs
 * to print it.
 *
 * A LANE'S VALUE IS ITS KEY, WHICH IS NOT ITS NAME (#352, the same bug as
 * #318). base-ui's `Select.Value` renders the raw value when the Root carries
 * no `items` mapping, so all three lane pickers — the tray's Filing row, the
 * task row's Lane, and Add task's — showed the stored `key` in the trigger
 * while the list beside them showed the label the whole time. `items` is the
 * fix the studio's own selects already use.
 *
 * It lives here rather than three times over because the label was written out
 * longhand in each of those files, and a trigger that disagreed with its own
 * list by one em dash would be the same bug wearing a smaller hat.
 */
import type { SpoolLane } from "@telar/engine-client";

export const laneLabel = (lane: SpoolLane): string => `${lane.label}${lane.window ? ` — ${lane.window}` : ""}`;

export const laneItems = (lanes: SpoolLane[]): Record<string, string> =>
  Object.fromEntries(lanes.map((lane) => [lane.key, laneLabel(lane)]));

/**
 * Whose deadline it is, as words. The values are `self` and `external`; the
 * rows have always read "mine" and "external", so a bare `Select.Value`
 * printed "self" under a list that never used that word.
 */
export const DEADLINE_KIND_ITEMS: Record<string, string> = { self: "mine", external: "external" };
