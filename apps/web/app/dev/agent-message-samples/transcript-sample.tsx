"use client";
import { SessionTurn } from "@/components/session-cockpit";
import type { JournalItem, JournalTurn } from "@/lib/engine/journal";
const item = (id: string, detail: JournalItem["detail"]): JournalItem => ({ id, runId: "run_sample", sessionId: "session_sample", status: "completed", title: "Message", detail, streamedText: "", openedBy: 1, startedAt: 1 });
const turn: JournalTurn = {
  runId: "run_sample", origin: "session", sender: { sessionId: "session_worker123456" },
  prompt: "Disk capacity blocker: builds are paused while available space is checked.",
  state: "completed", tasks: [],
  resultText: "Removed inactive build outputs. Free space is now **2.9 GiB**.\n\nSource, worktrees, test logs, and installed apps are preserved. Builds remain on hold.",
  items: [
    item("said", { type: "assistant_message", text: "Checking the reported capacity." }),
    item("report1", { type: "user_message", text: "## Capacity report\n\n" + "- Verified existing work remains intact.\n".repeat(40), sender: { sessionId: "session_worker456789" } }),
    item("report2", { type: "user_message", text: "No builds running.", sender: { sessionId: "session_worker456789" } }),
    item("wake1", { type: "user_message", text: "The UI worker is holding.", wakeReason: { kind: "turn_completed", sessionId: "session_worker789012", runId: "run_ui" } }),
    item("wake2", { type: "user_message", text: "The plugin worker is holding.", wakeReason: { kind: "turn_completed", sessionId: "session_worker901234", runId: "run_plugin" } }),
  ],
};
export function TranscriptSample() {
  return <section className="my-8 border-y py-6" aria-label="Transcript layout sample"><SessionTurn turn={turn} requests={[]} sending={false} live={false} now={1} onDecide={() => {}} onRetry={() => {}} /></section>;
}
