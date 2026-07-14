// LANE: chat — OWNED by the chat redesign lane. Overwrites ONLY this file.
// Demo components live under apps/web/lib/demo-gallery/chat/**.
import type { DemoEntry } from "../registry";
import {
  SubagentLifecycleDemo,
  SubagentTrayVariantDemo,
} from "../chat/subagent-lifecycle";
import { SubagentSidebarDemo } from "../chat/subagent-sidebar";
import { SessionBlockDemo } from "../chat/session-block";
import { ThinkingStreamDemo } from "../chat/thinking-stream";
import { WorkingIndicatorDemo } from "../chat/working-indicator";
import { SessionCostDemo } from "../chat/session-cost";
import { SessionContextDemo } from "../chat/session-context";
import { ChatSurfaceVariantsDemo } from "../chat/chat-surface";
import { ChatMiniDockDemo } from "../chat/mini-dock";
import {
  LoomNotifyPillDemo,
  LoomNotifyInlineDemo,
  LoomNotifyCardDemo,
} from "../chat/loom-notify";

export const chatEntries: DemoEntry[] = [
  {
    id: "chat-subagent-lifecycle",
    title: "Sub-agent tabs — graceful dismiss",
    concern: "1.1",
    variant: "Variant A: graceful dismiss (retired)",
    summary:
      "RETIRED CANDIDATE — the owner picked Variant C (the session sidebar rail). Kept for the record. Today agent-tabs.tsx keeps a TAB per spawn forever, so finished sub-agents crowd the strip (“Main | Verify P3 Track A | Verify P3 Track B | Reconcile PD-scope | …”). Here a completed tab collapses out of the strip and folds into an expandable “N done” pill at the strip end — every completed transcript stays one click away, so tabs stay navigation, not clutter. Running sub-agents are live switchable tabs; failed ones stay pinned (failure needs eyes).",
    Component: SubagentLifecycleDemo,
  },
  {
    id: "chat-subagent-tray",
    title: "Sub-agent tabs — overflow tray",
    concern: "1.1",
    variant: "Variant B: overflow tray (retired)",
    summary:
      "RETIRED CANDIDATE — the owner picked Variant C (the session sidebar rail). Kept for the record. The same de-cluttered strip with the alternative strip-end treatment: completed tabs collect into an overflow tray with a live count instead of a labelled pill — the popover re-lists them as clickable navigation. Running sub-agents stay live tabs, failed ones stay pinned. Shown so the tradeoff against the graceful-dismiss “N done” pill is visible.",
    Component: SubagentTrayVariantDemo,
  },
  {
    id: "chat-subagent-sidebar",
    title: "Sub-agent sidebar rail",
    concern: "1.1",
    variant: "Variant C: session sidebar (owner-selected)",
    summary:
      "OWNER-SELECTED DIRECTION for 1.1 (“Love the sidebar actually. We better stick with that one.”). Instead of tabs at the top, a right-hand rail beside the conversation lists sub-agents as rich animated cards. Running cards sit up top with the full chip vocabulary — spawn-in, a shimmering current-activity line, live elapsed counting up; failed cards demand attention in destructive; completed cards settle into a compact Done section lower in the rail, one click from their transcript, with cost. The rail collapses to an icon edge carrying a count + status dots. The return path to main is built in: a pinned Main anchor at the very top of the rail (always visible, mirrors the strip's “Main tab first” rule, reachable even when collapsed), and — on any sub-agent transcript — a slim breadcrumb banner (“Main › Viewing <agent>”) that exits via click, chevron, or Escape, so it's unmistakable when you're off the main chat. Same scripted timeline as A/B, replayable.",
    Component: SubagentSidebarDemo,
  },
  {
    id: "chat-session-block",
    title: "Session block — 1.1 in context",
    concern: "1.1",
    variant: "A / B / C, in a real session",
    summary:
      "All three 1.1 sub-agent treatments judged in context, not as isolated widgets: a production-anatomy session — header, then a full agent turn with streamed thinking (1.3), tool steps, and sub-agents that spawn mid-turn and complete one by one — closing with final assistant text and the aggregate cost pill (1.6). A variant switch swaps A (strip → “N done” pill), B (strip → overflow tray) and C (right-hand sidebar rail beside the conversation) in place, all on the same scripted timeline. Replay restarts it. Reuses the exact strip, rail, thinking block, and cost bits from the isolated demos.",
    Component: SessionBlockDemo,
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
      "The heartbeat pill today counts only the main agent's spend. Here it shows the aggregate of main + every sub-agent; hovering the pill floats a per-agent breakdown (cost, share bar, token split) as an anchored overlay that never reflows the bar — click to pin it open — with a callout of exactly how much sub-agent spend the old number was hiding.",
    Component: SessionCostDemo,
  },
  {
    id: "chat-context-breakdown",
    title: "CTX pill → /context breakdown",
    concern: "extra",
    summary:
      "The production CTX pill shows a bare token count with no sense of what fills the window. Modeled on Claude Code's /context, hovering it floats an anchored, zero-reflow overlay: a segmented usage bar + legend splitting the window into system prompt, system tools, MCP tools, memory/CLAUDE.md, messages, and thinking — each with tokens and window-share — plus free space, total used vs 200k, and an autocompact marker showing how much room is left. Click pins it open; same grammar as the 1.6 cost hover, so both breakdowns live in one bar.",
    Component: SessionContextDemo,
  },
  {
    id: "chat-surface-variants",
    title: "One adaptable ChatSurface",
    concern: "1.7",
    summary:
      "The surface is copy-pasted uniformly today, so a back-to-project button shows inside a loom where it makes no sense. Here one ChatSurface takes a context — standalone / loom-embedded / compact-drawer — and only the chrome adapts; the same fixture conversation renders in all three, shown side by side.",
    Component: ChatSurfaceVariantsDemo,
  },
  {
    id: "chat-mini-dock",
    title: "Mini-chat dock — sessions that follow you",
    concern: "extra",
    summary:
      "A Messenger-style dock, pinned bottom-right, that follows you across every route: one chat HEAD per live session (session initial, subtle border) stacked right-to-left, carrying an unread count, a rotating shimmer ring while its agent works, and an amber tint when its loom parks; hover floats a collision-aware fixed tooltip, an X-on-hover dismisses. Click a head to open a small docked panel (~340×480) that IS the approved 1.7 ChatSurface in its compact grammar — minimal-chrome header (title, working dot, pop-out to the full session, minimize, close), the same message body, and a queue-capable composer (1.5: typing while the agent works queues a chip). Panels sit side by side; a third collapses the oldest to its head, and because the dock is out of flow, opening one never reflows the page. A scripted, replayable timeline drives it: a background session gets a reply (head beats + unread) → user expands (badge clears) → the other session starts working → a queued message dispatches. Both themes; a fake nav swaps the backdrop to prove persistence across pages. Wiring is real, not sci-fi: mount the dock once in the app shell above all routes and drive it from the session state that already live-updates.",
    Component: ChatMiniDockDemo,
  },
  {
    id: "loom-notify-pill",
    title: "Loom notify — session-bar pill",
    concern: "extra",
    variant: "A: session-bar pill — RECOMMENDED",
    summary:
      "RECOMMENDED. The production ‘Loom started’ banner is permanent chrome for a momentary event that never reflects the loom's actual state and eats transcript space until dismissed. Here it becomes a compact LIVE aggregate pill sitting with CTX/cost in the session bar — never one pill per loom: solo shows its state + short id, multiple show a count + most-urgent rollup (‘2 looms · 1 needs you’). Tone follows the most-urgent loom (neutral weaving, amber + gentle pulse when a loom parks and needs you, green at ready — the doctrine's human-touchpoints surfacing). On start the pill spawns with a brief highlight beat, no banner; a second loom joins mid-run so it rolls single → aggregate. Hover floats a per-loom overlay (title, state, elapsed, per-row god-view link); click pins — the lane's zero-reflow pill grammar. Data is intentionally minimal — no thread/gate/last-event detail — while the loom UI is still being shaped; a slot is reserved in the overlay for that once it lands. Composes with variant B: the pill is live status, the inline row is the historical record — the recommended combo. Scripted, replayable, both themes.",
    Component: LoomNotifyPillDemo,
  },
  {
    id: "loom-notify-inline",
    title: "Loom notify — inline event rows",
    concern: "extra",
    variant: "B: inline event row",
    summary:
      "No persistent chrome at all. Loom-start renders as a compact in-stream event row at the exact turn (tool-step grammar: glyph + ‘Loom started · <title>’ + elapsed + god-view link) and scrolls away with history. State changes append further compact rows — parked (amber + pulse), resumed, ready (green) — so the transcript IS the record. Handles N naturally: two looms interleave here, and every row carries its short id so the log stays unambiguous. Rows carry no activity/last-event text — data is intentionally minimal while the loom UI is still being shaped. Pairs with variant A as the durable record beneath the live pill. Scripted, replayable, both themes.",
    Component: LoomNotifyInlineDemo,
  },
  {
    id: "loom-notify-card",
    title: "Loom notify — docked live card",
    concern: "extra",
    variant: "C: docked live card",
    summary:
      "A slim card docks under the header with title, short id, state, elapsed, and a god-view button — replacing the static banner with something that tracks the loom. Deliberately minimal: no thread/gate detail or activity line while the loom UI is still being shaped; a slot is reserved for that once it lands. Collapsible to the variant-A pill at any time. When N>1 the cards stack into a slim tray, each with its own live status; collapse the whole tray to the aggregate pill. When a loom parks (needs you) or lands ready the tray auto-re-expands and highlights ONLY the escalating card — momentary attention, never permanent chrome. Scripted, replayable, both themes.",
    Component: LoomNotifyCardDemo,
  },
];
