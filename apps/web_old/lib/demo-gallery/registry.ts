// FROZEN REGISTRY CONTRACT — six redesign lanes build against this in parallel.
// Pure module (NO "use client") so the server index page can call demoGroups()
// directly. Each lane owns exactly one entries file under ./entries/<lane>.tsx
// and overwrites only that file; the shell here never changes once frozen.
import type { ComponentType } from "react";

import { birthEntries } from "./entries/birth";
import { conversationEntries } from "./entries/conversation";
import { deliveryEntries } from "./entries/delivery";
import { homeEntries } from "./entries/home";
import { loomDetailEntries } from "./entries/loom-detail";
import { listsEntries } from "./entries/lists";
import { loomEntries } from "./entries/loom";
import { prepGateEntries } from "./entries/prep-gate";
import { projectEntries } from "./entries/project";
import { ultraEntries } from "./entries/ultra";
import { workspaceEntries } from "./entries/workspace";

// A single redesign candidate rendered full-screen on the stage. `concern` keys
// the entry into a nav group (see GROUP_DEFS). `variant` labels competing takes
// on the same concern (e.g. "Variant A: command center").
export interface DemoEntry {
  id: string; // kebab, unique, lane-prefixed: chat- input- lists- sidebar- settings- loom-
  title: string;
  concern: string; // one of: 1.1 1.2 1.3 1.4 1.5 1.6 1.7 2 3 4 5 6 6.1 7 extra
  summary: string; // one short paragraph: what changed vs the current UI and why
  variant?: string;
  Component: ComponentType;
}

// The whole catalog in lane order. Each lane's array is spliced in as-is so the
// nav/index/pager all read one flat source of truth.
export const allEntries: DemoEntry[] = [
  ...birthEntries,
  ...homeEntries,
  ...loomDetailEntries,
  ...deliveryEntries,
  ...prepGateEntries,
  ...conversationEntries,
  ...listsEntries,
  ...loomEntries,
  ...projectEntries,
  ...ultraEntries,
  ...workspaceEntries,
];

// Nav groups, in walkthrough order. Each group claims a set of concerns; an
// entry lands in the first group whose `concerns` contains its concern. Anything
// unmatched (or concern "extra") falls through to Extras.
export type DemoGroupDef = { key: string; label: string; concerns: string[] };

export const GROUP_DEFS: DemoGroupDef[] = [
  // UX brainstorm 2026-07-23: one section per surface of the loom UX walk.
  // UX 0 sits first on purpose: the birth is the front door the session
  // initially skipped — everything below it is a view the conversation opens.
  { key: "ux-birth", label: "UX 0 · Birth of a loom", concerns: ["ux-birth"] },
  { key: "ux-home", label: "UX 1 · Home", concerns: ["ux-home"] },
  { key: "ux-loom-detail", label: "UX 2 · Loom detail", concerns: ["ux-loom-detail"] },
  { key: "ux-delivery", label: "UX 3 · Delivery card", concerns: ["ux-delivery"] },
  { key: "ux-prep-gate", label: "UX 4 · Readiness gate", concerns: ["ux-prep-gate"] },
  { key: "ux-workspace", label: "UX 5 · Workspace", concerns: ["ux-workspace"] },
  { key: "ux-conversation", label: "UX 6 · Conversation", concerns: ["ux-conversation"] },
  { key: "sessions-chat", label: "Sessions & Chat", concerns: ["1.1", "1.3", "1.4", "1.6", "1.7"] },
  { key: "input-queue", label: "Input Bar & Queue", concerns: ["1.2", "1.5"] },
  { key: "dashboard-lists", label: "Dashboard & Lists", concerns: ["2", "5"] },
  { key: "sidebar-nav", label: "Sidebar & Navigation", concerns: ["3", "7"] },
  { key: "settings", label: "Settings", concerns: ["4"] },
  { key: "loom-threads", label: "Loom & Threads", concerns: ["6", "6.1"] },
  { key: "extras", label: "Extras", concerns: ["extra"] },
];

const EXTRAS_KEY = "extras";

export type DemoGroup = { key: string; label: string; entries: DemoEntry[] };

function groupKeyForConcern(concern: string): string {
  const hit = GROUP_DEFS.find((g) => g.concerns.includes(concern));
  return hit ? hit.key : EXTRAS_KEY;
}

// Bucket allEntries into the fixed groups (preserving catalog order within each
// group). Empty groups are dropped so the nav never renders an empty header.
export function demoGroups(): DemoGroup[] {
  return GROUP_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    entries: allEntries.filter((e) => groupKeyForConcern(e.concern) === def.key),
  })).filter((g) => g.entries.length > 0);
}

// The catalog flattened into nav order — source of truth for the linear pager,
// the "n of N" position and keyboard nav.
export function orderedEntries(): DemoEntry[] {
  return demoGroups().flatMap((g) => g.entries);
}

export function getDemoEntry(id: string): DemoEntry | undefined {
  return allEntries.find((e) => e.id === id);
}
