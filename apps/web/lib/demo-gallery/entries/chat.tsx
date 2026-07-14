// LANE: chat — OWNED by the chat redesign lane. Overwrites ONLY this file.
// Demo components live under apps/web/lib/demo-gallery/chat/**.
import type { DemoEntry } from "../registry";
import {
  SubagentLifecycleDemo,
  SubagentTrayVariantDemo,
} from "../chat/subagent-lifecycle";
import { ThinkingStreamDemo } from "../chat/thinking-stream";
import { WorkingIndicatorDemo } from "../chat/working-indicator";
import { SessionCostDemo } from "../chat/session-cost";
import { ChatSurfaceVariantsDemo } from "../chat/chat-surface";

export const chatEntries: DemoEntry[] = [
  {
    id: "chat-subagent-lifecycle",
    title: "Sub-agent task lifecycle",
    concern: "1.1",
    variant: "Variant A: graceful dismiss",
    summary:
      "Today agent-tabs.tsx keeps a chip/tab per spawn forever, so finished sub-agents crowd the live one. Here a chip exists only while alive: on completion it collapses out of the active row and folds into a single “N done” pill you can expand for full history — the row only ever shows what is running.",
    Component: SubagentLifecycleDemo,
  },
  {
    id: "chat-subagent-tray",
    title: "Sub-agent tasks — docked tray",
    concern: "1.1",
    variant: "Variant B: relocate",
    summary:
      "The alternative the user weighed: chips leave the transcript entirely and live behind a header affordance with a live count. Cleanest flow but hides running work one click deep — shown so the tradeoff against graceful-dismiss is visible.",
    Component: SubagentTrayVariantDemo,
  },
  {
    id: "chat-thinking-stream",
    title: "Thinking block — stream or suppress",
    concern: "1.3",
    summary:
      "Today the SDK's thinking is never persisted, so ThinkingRow renders a collapsible that expands to nothing. Here thinking streams token-by-token into a growing block, then collapses to a duration-stamped “✻ Thought” row — and a hard suppression rule returns null on empty text, so an empty collapsible is impossible.",
    Component: ThinkingStreamDemo,
  },
  {
    id: "chat-working-indicator",
    title: "Working indicator with meaning",
    concern: "1.4",
    summary:
      "Replaces the bare “working · 12s” (and the mid-tool “…”) with the current tool + target + a live elapsed clock and subtle motion, plus an explicit long-silence state (“still working — no output 1m 20s”) so the user always knows the agent is alive and what it is doing.",
    Component: WorkingIndicatorDemo,
  },
  {
    id: "chat-session-cost",
    title: "Session cost — whole-weave total",
    concern: "1.6",
    summary:
      "The heartbeat pill today counts only the main agent's spend. Here it shows the aggregate of main + every sub-agent and expands to a per-agent breakdown (cost, share bar, token split), with a callout of exactly how much sub-agent spend the old number was hiding.",
    Component: SessionCostDemo,
  },
  {
    id: "chat-surface-variants",
    title: "One adaptable ChatSurface",
    concern: "1.7",
    summary:
      "The surface is copy-pasted uniformly today, so a back-to-project button shows inside a loom where it makes no sense. Here one ChatSurface takes a context — standalone / loom-embedded / compact-drawer — and only the chrome adapts; the same fixture conversation renders in all three, shown side by side.",
    Component: ChatSurfaceVariantsDemo,
  },
];
