# The Conversation Component — extracting the chat window as a concept

> Captured at the end of the 2026-07-23 UX/UI session (memlog 110–111). Direction from Facundo: the chat window — the user-facing component — should be extracted from the UI into a proper mutable component, renamed to something reusable; tool calling and the right sidebar should apply in most scenarios. This doc is the teardown judgment. It is a plan, not a change: production code is untouched.

## The evidence

This session rebuilt the same chat surface, by hand, in six different lanes — which is the proof the extraction is due:

| Surface | Where it appeared | What varied |
|---|---|---|
| Project session | production `session-view.tsx` (the donor) | full composer, agent tabs, subagent rail |
| Birth conversation | UX 0 | choice buttons in-conversation, detach marker |
| Loom node chats | UX 4 gate room | chat-history rail, ApprovalCard, "talking is free" composer |
| Intake / steering / escalation | UX 2 cockpit sessions | gate card as last message, composer-as-resume |
| Master chat | UX 5 workspace | Desk right rail, receipt turns, tool pills |
| Agent transcripts | UX 2 thread drill | read-only, streaming, cross-agent markers |

Same anatomy every time: a transcript of typed items, an optional composer, an optional right rail, tool activity rendered inline. Only data, capabilities, and slots differed.

## Naming

- **`Conversation`** is the component family (`components/conversation/`). Neutral, already half-established (`ai-elements/conversation.tsx`), and true at every altitude.
- **"Session" stays a domain word** — a harness run with an owner, cwd, and lifetime (per the verification doctrine). A session is one kind of conversation *owner*, not the UI. Loom graph nodes, intake, steering, escalations, the master chat are conversations with other owners.

## Three layers

**1. Primitives** (mostly exist — consolidate, don't rewrite):
`Message`/`MessageContent` (user bubble, bare assistant), `MessageResponse` (streamdown), `ToolStep`, `WorkingIndicator` + `Shimmer`, `CodeBlock`, the `PromptInput` family, plus two the demos proved out that production lacks:
- **`Marker`** — dashed system-event line inside the transcript (drift detected, loom detached, cross-agent events). State, never prose.
- **`ApprovalCard`** — the rendering of an approval-gated tool call: mono header ("tool call — awaiting your approval"), the proposal text, Approve/Hold. This is now doctrine everywhere (`advance_node`, `weave_batch`, lane splits, the ack-gated Accept). One component, one protocol shape.

**2. The `Conversation` shell** — the extracted "chat window as a concept":
- **Transcript** renders a stream of typed items through an **item-kind registry** (turn, tool step, marker, approval card, receipt, …). Surfaces register custom kinds (gate card, delivery mini-card, detach receipt) without forking the shell.
- **Composer slot** — full `PromptInput` (project session), minimal (node chats), or absent (read-only transcripts); placeholder + footer hint are content ("talking is free", "answering resumes the loom", "Enter queues a message").
- **Right-rail slot** — subagent rail (sessions), the Desk (master chat), chat-history rail (node conversations), evidence rail (transcripts). One slot, many rails.
- **Header slot** — tabs, meters, verbs; owner's business.

Config over inheritance: `<Conversation items composer rail header />`. The shell owns scrolling, auto-follow, streaming affordances; it owns **no data fetching and no session semantics**.

**3. Owner adapters** — each surface provides data + capabilities: `ProjectSessionView` (what `session-view.tsx` becomes), `MasterChat`, `NodeConversation`, `LoomSessionView`, `TranscriptView`. Per-directory state keying, MCP wiring, permission modes: all owner concerns, never shell concerns.

## Migration order

1. **Consolidate primitives** under `components/conversation/` (or keep `ai-elements/` as the primitives layer and add the shell beside it — either way, one roof). Add `Marker` + `ApprovalCard`.
2. **Carve the shell out of `session-view.tsx`** as a pure-render extraction — the transcript loop + composer wiring move; route/state/API stay in the adapter. No behavior change; the 151KB monolith shrinks to the first adapter.
3. **Prove the shell in the demo gallery first** — the gallery lanes (birth, gate room, cockpit sessions, workspace) become its test bed; they already approximate every configuration.
4. **New surfaces build on it from day one** — the master chat and loom node conversations don't exist in production yet, so landing the shell *before* them means they're born on it, not migrated to it.

## Risks / notes

- The extraction's danger is step 2: `session-view.tsx` mixes rendering with session lifecycle. Cut only at the render seam; resist "improving" behavior mid-extraction.
- Codex/Claude differences (tool-step shapes, streaming) live in adapters or item-kind renderers — the shell never branches on harness.
- The right rail is a *slot*, not a component: the Desk and the subagent rail share placement, not implementation.
