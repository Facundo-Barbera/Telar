// LANE: conversation (UX BRAINSTORM 2026-07-23) — OWNED by epic 3, story 3.1.
// The Conversation shell (AD-12) exercised against fixtures in every
// configuration the six hand-rebuilt chat lanes need, BEFORE any production
// surface depends on it. Components under
// apps/web/lib/demo-gallery/conversation/**; the shell itself is the real one,
// imported from @/components/conversation.
import type { DemoEntry } from "../registry";
import {
  ConversationApprovalDemo,
  ConversationEmptyAndTombstoneDemo,
  ConversationFullDemo,
  ConversationMinimalDemo,
  ConversationRailDeskDemo,
  ConversationReadOnlyDemo,
} from "../conversation/shell";

export const conversationEntries: DemoEntry[] = [
  {
    id: "conversation-full",
    title: "Conversation — the project session",
    concern: "ux-conversation",
    variant: "1 · header + composer + rail, every kind",
    summary:
      "The donor configuration, now rendered by the extracted shell. All four slots are filled — a header bar, the full composer, the production sub-agents rail, and a transcript of typed items dispatched through the item-kind registry. Every built-in kind appears: a user turn, an assistant turn carrying a collapsed thinking block and a tool-step group, a dashed system marker, and a live approval card at the tail. Nothing here is a copy of production; the shell, the kinds and the registry factory are all imported from @/components/conversation.",
    Component: ConversationFullDemo,
  },
  {
    id: "conversation-minimal",
    title: "Conversation — a loom node chat",
    concern: "ux-conversation",
    variant: "2 · no header, no rail, bare composer",
    summary:
      "The same component with two slots left empty. This is the “talking is free” surface a loom node opens: no identity chrome (the cockpit already carries it), no rail, and a composer stripped to a textarea and a send button. The transcript still renders through the same registry, including an attention marker for a parked node — proving that a configuration is a matter of which props you pass, never of which component you build.",
    Component: ConversationMinimalDemo,
  },
  {
    id: "conversation-readonly",
    title: "Conversation — an agent transcript (read-only)",
    concern: "ux-conversation",
    variant: "3 · no composer · every kind still renders",
    summary:
      "The configuration that proves AD-12's purity rule, and the one that must never be dropped for time. There is no composer and no rail, and — critically — no ambient provider of any kind, yet every registered kind renders, including the approval card. It degrades to read-only because its payload simply omits the resolve callback: the callback being OPTIONAL is the mechanism that makes one kind renderable on every surface. This is what TranscriptView (story 6.6) will be.",
    Component: ConversationReadOnlyDemo,
  },
  {
    id: "conversation-rail-desk",
    title: "Conversation — master chat's Desk",
    concern: "ux-conversation",
    variant: "4 · one slot, many rails",
    summary:
      "The same rail slot, filled with something else entirely: a workspace Desk listing looms and their states instead of the session's sub-agents. Nothing about the shell changes between this and configuration 1 — the rail is a ReactNode a surface supplies, so a new right-hand pane is a prop, not a fork. That is the property epic 5 depends on.",
    Component: ConversationRailDeskDemo,
  },
  {
    id: "conversation-approval",
    title: "Conversation — the gate room",
    concern: "ux-conversation",
    variant: "5 · one ApprovalCard, both vocabularies",
    summary:
      "UX-DR7, and the resolution of readiness finding UX-2: ApprovalCard as a PRIMITIVE any module's kind can render, rather than a namespaced kind one module would have to own. The transcript's own approval speaks the tool vocabulary (Allow once / Always allow / Deny, with the narrow→broad rule disclosure); the node advance below it speaks the gate vocabulary (Approve / Hold) — the same component, with the labels as a prop. Two vocabularies for one moment was the drift; one component with a labelled protocol is the fix.",
    Component: ConversationApprovalDemo,
  },
  {
    id: "conversation-empty-and-tombstone",
    title: "Conversation — empty state and tombstone",
    concern: "ux-conversation",
    variant: "6 · the degradation contract",
    summary:
      "The two behaviours nothing else in the gallery shows. Toggle to the empty state and the shell renders whatever the surface handed it in place of the transcript. Toggle back and the transcript contains one item whose kind (ultra:run-anchor) is registered by a module that is not loaded here: it renders as a tombstone naming the missing id, and every other item renders normally. AD-8 in one screen — a dangling cross-module reference is a tombstone, never a throw.",
    Component: ConversationEmptyAndTombstoneDemo,
  },
];
