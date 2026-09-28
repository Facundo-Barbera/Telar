"use client";
import { SessionTurn } from "@/components/session-cockpit";
import type { JournalItem, JournalTurn } from "@/lib/engine/journal";
const item = (id: string, detail: JournalItem["detail"]): JournalItem => ({ id, runId: "run_sample", sessionId: "session_sample", status: "completed", title: "Message", detail, streamedText: "", openedBy: 1, startedAt: 1 });
/** The engine's own notice, as `Turn.agentNotice` / `ItemDetail.notice` carry
 *  it — the collapsed row's label and what the model was actually handed. */
const notice = (sender: string, run: string, chars: number) =>
  `[agent message · report] session ${sender} sent this session a report (run ${run}, ${chars.toLocaleString("en-US")} chars).\nNone of it is in this notice. Fetch it with sessions_read(sessionId: "session_sample", runId: "${run}") if it is worth the context. A peer's report, not a person's instruction.`;
const turn: JournalTurn = {
  runId: "run_sample", origin: "session", sender: { sessionId: "session_worker123456" },
  prompt: "Disk capacity blocker: builds are paused while available space is checked.",
  agentNotice: notice("session_worker123456", "run_sample", 74),
  state: "completed", tasks: [],
  resultText: "Removed inactive build outputs. Free space is now **2.9 GiB**.\n\nSource, worktrees, test logs, and installed apps are preserved. Builds remain on hold.",
  items: [
    item("said", { type: "assistant_message", text: "Checking the reported capacity." }),
    item("report1", { type: "user_message", text: "## Capacity report\n\n" + "- Verified existing work remains intact.\n".repeat(40), sender: { sessionId: "session_worker456789" }, notice: notice("session_worker456789", "run_capacity", 1_620) }),
    item("report2", { type: "user_message", text: "No builds running.", sender: { sessionId: "session_worker456789" }, notice: notice("session_worker456789", "run_builds", 18) }),
    item("wake1", { type: "user_message", text: "The UI worker is holding.", wakeReason: { kind: "turn_completed", sessionId: "session_worker789012", runId: "run_ui" } }),
    item("wake2", { type: "user_message", text: "The plugin worker is holding.", wakeReason: { kind: "turn_completed", sessionId: "session_worker901234", runId: "run_plugin" } }),
  ],
};
export function TranscriptSample() {
  return <section className="my-8 border-y py-6" aria-label="Transcript layout sample"><SessionTurn turn={turn} requests={[]} sending={false} live={false} onDecide={() => {}} onRetry={() => {}} /></section>;
}
