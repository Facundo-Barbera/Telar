// LANE: workspace (UX 5) — born in the organization-workspace brainstorm
// (2026-07-23) and integrated into the loom UX walk by the UX/UI session's
// workspace pass: the master chat wears the production session bubble, and
// both loom handoffs (batch weave, packet) now follow the birth doctrine —
// premise + context handed over, the loom DETACHES, receipt in place.
// Components under apps/web/lib/demo-gallery/workspace/**. Not part of the
// frozen six-lane redesign pass.
import type { DemoEntry } from "../registry";
import { WorkspaceHomeDemo } from "../workspace/home";
import { WorkspaceQueueDemo } from "../workspace/queue";
import { WorkspacePacketDemo } from "../workspace/packet";
import { WorkspaceSessionDemo } from "../workspace/session";

export const workspaceEntries: DemoEntry[] = [
  {
    id: "workspace-home",
    title: "Workspace — master chat",
    concern: "ux-workspace",
    variant: "The front door · a project-less session",
    summary:
      "The module's front door: one project-less chat with the master agent — and it IS a session (production bubble idiom, same chat grammar as everywhere; looms it triggers detach like any other birth). Agent-created items land on the RIGHT RAIL — the Desk, same pattern as the session surfaces' sidebar; talk about one and it updates in place; dismiss (✕) drains it to the queue, never deletes. The briefing answers 'where did I stop?': overnight loom results (the aurora delivery, ready to judge on the dashboard), filed captures, the calendar gap, the self-deadline witness. The brain dump returns a receipt whose count matches the input — the conservation law on screen. External sources read via workspace MCP: reference, not inventory. Pull-based: it never notifies, it answers when you arrive.",
    Component: WorkspaceHomeDemo,
  },
  {
    id: "workspace-queue",
    title: "Workspace — queue",
    concern: "ux-workspace",
    variant: "Dense list · dynamic lanes · loom-birthing batches",
    summary:
      "Lanes are DYNAMIC data with structural provenance ('Aurora — split from Office, you accepted Mon'); the list idiom holds: search-first toolbar, filter chips, sticky group headers, dense rows; sub-tasks live INSIDE items so breakdown never grows the queue. The batch handoff now follows the birth doctrine end to end: two exports-module rows selected, the master proposes weaving them as one series, and clicking 'Weave as one loom' yields the UX 0 receipt in place — 'loom created · premise + context: 2 items and their attachments · detached from the workspace' — the rows track the loom and leave only when it lands and you accept.",
    Component: WorkspaceQueueDemo,
  },
  {
    id: "workspace-packet",
    title: "Workspace — a ripening work packet",
    concern: "ux-workspace",
    variant: "Todo that holds files · the loom's premise",
    summary:
      "One rich todo opened up: born as a context-free floating note, fixed and filed by the project's ephemeral expert overnight, then ripened over days — a sync excerpt, a bed-mode-drafted mockup (dashed = proposal), a complexity read recommending a loom. The rail shows the ripening timeline by actor (you / expert / bed mode). The handoff is now literal birth doctrine: 'Plan loom from this packet' hands over premise (the fixed brief + acceptance criteria) and context (the attachments), the loom detaches, and the packet stays behind as the origin receipt — preparation runs on the loom's own graph (UX 4). Agents prepared everything; nothing ran until you clicked.",
    Component: WorkspacePacketDemo,
  },
  {
    id: "workspace-in-session",
    title: "Workspace — from any session",
    concern: "ux-workspace",
    variant: "One substrate",
    summary:
      "Tasks are a Telar-wide substrate, not the Workspace surface's private data. A normal aurora session carries workspace tools (in-process MCP, same pattern as loom-mcp/ultra-mcp): ask 'what are the tasks for this project?' and it lists the project's slice of the queue — same chips, recognizably the same tasks — then creates a new one mid-conversation ('migrate export tests', rank 7, provenance: this session), which lands on the desk and in tomorrow's briefing. Read, create, and modify from anywhere; provenance records which surface did it. Telar feels like a whole.",
    Component: WorkspaceSessionDemo,
  },
];
