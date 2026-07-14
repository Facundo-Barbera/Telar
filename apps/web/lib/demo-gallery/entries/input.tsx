// LANE: input — Input Bar & Queue (concerns 1.2, 1.5). Owned by the input
// redesign lane; overwrites ONLY this file. Demo components live under
// apps/web/lib/demo-gallery/input/**.
import type { DemoEntry } from "../registry";
import { SettingsPopoverDemo } from "../input/settings-popover";
import { RememberedConfigDemo } from "../input/remembered-config";
import { MessageQueueDemo } from "../input/message-queue";

export const inputEntries: DemoEntry[] = [
  {
    id: "input-settings-popover",
    title: "Settings popover + config chip",
    concern: "1.2",
    variant: "Variant A: one popover",
    summary:
      "The production footer lines up four-to-five selects (provider, account, permission, model, effort) that crowd the composer and wrap on narrow panes. This collapses them into a single compact chip that reads back the active model, permission mode and effort at a glance, with one settings popover behind it (segmented controls for permissions/effort, a proper model list). Auto Mode is the default and is marked as such.",
    Component: SettingsPopoverDemo,
  },
  {
    id: "input-remembered-config",
    title: "Per-project remembered config",
    concern: "1.2",
    variant: "Variant B: project memory",
    summary:
      "Today the composer forgets your model/permission/effort choices between sessions and defaults to Ask-me. This remembers the last configuration per project — switch projects and the chip snaps to that project's saved config — and boots any brand-new project in Auto Mode, so agents run autonomously by default while each repo keeps the settings you last used.",
    Component: RememberedConfigDemo,
  },
  {
    id: "input-message-queue",
    title: "Message queueing while working",
    concern: "1.5",
    summary:
      "There's no way today to line up a follow-up while the agent is mid-turn — you either wait or lose the thought. This adds Claude-Code-style queueing: typing while the agent works stacks messages as editable, removable chips above the composer and dispatches them in order as each turn finishes. Fully interactive against a simulated working agent, including a live 'still working' indicator with current tool and elapsed time.",
    Component: MessageQueueDemo,
  },
];
