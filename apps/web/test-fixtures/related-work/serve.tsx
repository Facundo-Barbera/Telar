/**
 * A LIGHT FIXTURE for the two #199 surfaces, served on a temp port.
 *
 * Renders the real components against fixed data so the task boundary and the
 * Follow/Unfollow controls can be LOOKED AT. No engine, no packaged app: the
 * page is static markup plus the app's own stylesheet.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMessageBubble } from "../../components/session/conversation-message";
import { RelatedWork } from "../../components/session/related-work";
import { relatedWork, type SidebarSession } from "../../lib/session-list";

const session = (id: string, title: string, extra: Partial<SidebarSession> = {}): SidebarSession =>
  ({ id, title, projectId: "telar", ...extra }) as SidebarSession;

const assignment = (from: string, extra: Record<string, unknown> = {}) =>
  ({ taskRunId: `task_${from}`, fromSessionId: from, receivedAt: 1, runId: `task_${from}`, ...extra }) as never;

const sessions = [
  session("worker_engine", "Plugin host migration", { assignments: [assignment("coord", { scope: "apps/engine only" })] }),
  session("worker_web", "Settings polish", { assignments: [assignment("coord", { outcome: "completed", endedAt: 9 })] }),
  session("worker_free", "Docs sweep", { startedFrom: { sessionId: "coord" } }),
  session("worker_watch", "Nightly runner", { assignments: [assignment("coord")] }),
];

const groups = relatedWork(sessions, { id: "coord" });

export function page(): string {
  const body = renderToStaticMarkup(
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-8">
      <section>
        <h2 className="mb-2 text-sm font-medium">Recipient — an explicit task</h2>
        <AgentMessageBubble
          text={"Port the plugin host onto main.\n\nKeep `latex_*` and `ds_*` names; the wall stays under `telar`."}
          sender={{ sessionId: "session_coordinator" }}
          intent="task"
          scope="apps/engine only"
        />
        <h2 className="mb-2 mt-6 text-sm font-medium">…and a routine report, still collapsed</h2>
        <AgentMessageBubble text="Checkpoint reached." sender={{ sessionId: "session_coordinator" }} intent="report" />
      </section>

      <section className="w-72 rounded-lg border p-2">
        <h2 className="mb-2 px-2 text-sm font-medium">Sidebar — Related work</h2>
        <RelatedWork
          groups={groups}
          coordinatorId="coord"
          following={[
            { id: "sub_1", subscriberSessionId: "coord", targetSessionId: "worker_watch", events: ["turn_completed"], createdAt: 1 },
          ]}
          followed={sessions}
          onFollow={() => {}}
          onUnfollow={() => {}}
          lockFor={(key) => key}
          followFailed={new Set(["local:worker_web"])}
        />
        <p className="px-2 pt-3 text-[0.6875rem] opacity-60">
          Controls reveal on hover; the review row shows a failed follow.
        </p>
      </section>
    </main>,
  );
  return `<!doctype html><html><head><meta charset="utf-8"><title>#199 fixture</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:ui-sans-serif,system-ui;} .group\\/row button,.group\\/follow button{opacity:.7 !important}</style>
</head><body>${body}</body></html>`;
}
