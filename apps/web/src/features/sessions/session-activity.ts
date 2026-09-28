import type { SessionActivity, SessionActivityDetail, WaitingOn } from "@telar/engine-client";
import { fmtAgo } from "@/lib/format";

export type ActivityBadge = {
  label: string;
  tone: "attention" | "live" | "quiet";
  ticking: boolean;
  hint: string;
};

export function activityBadge(
  session: { activity: SessionActivity; activityDetail?: SessionActivityDetail },
  now = Date.now(),
): ActivityBadge | null {
  const detail = session.activityDetail;
  switch (session.activity) {
    case "blocked":
      return { label: "Waiting on you", tone: "attention", ticking: false, hint: "A question or an approval is waiting for your answer." };
    case "working":
      if (detail?.kind === "tool") return { label: "Waiting", tone: "quiet", ticking: true, hint: WAITING_HINT[detail.waitingOn] };
      return { label: "Working", tone: "live", ticking: true, hint: "A turn is running." };
    case "queued":
      return { label: "Queued", tone: "quiet", ticking: false, hint: "A message is waiting for its turn to start." };
    case "monitoring": {
      const counts = detail?.kind === "background" ? detail : undefined;
      return {
        label: counts ? `Background (${counts.tasks})` : "Background",
        tone: "quiet",
        ticking: true,
        hint: counts ? `The turn has ended. ${backgroundBreakdown(counts)} still running in the background.` : "The turn has ended. Work it started is still running in the background.",
      };
    }
    case "waiting": {
      const awaited = detail?.kind === "session" ? detail : undefined;
      const name = awaited?.title ? `“${awaited.title}”` : "another session";
      const more = awaited && awaited.sessions > 1 ? ` and ${awaited.sessions - 1} more` : "";
      return { label: "Waiting on session", tone: "quiet", ticking: false, hint: `Waiting on ${name}${more}. Its answer will wake this session.` };
    }
    case "scheduled": {
      const at = detail?.kind === "schedule" ? detail.at : undefined;
      return {
        label: at === undefined ? "Scheduled" : `Scheduled ${fmtWake(at, now)}`,
        tone: "quiet",
        ticking: false,
        hint: at === undefined ? "A schedule will wake this session." : `A schedule will wake this session ${fmtWakeLong(at, now)}.`,
      };
    }
    case "idle":
      return null;
  }
}

const WAITING_HINT: Record<WaitingOn, string> = {
  run: "The turn is running, but only waiting for a run to be ready.",
  timer: "The turn is running, but only waiting out a timer.",
  task: "The turn is running, but only waiting for background work to report.",
};

function backgroundBreakdown(counts: { tasks: number; agents: number }): string {
  const processes = counts.tasks - counts.agents;
  const parts = [
    ...(counts.agents > 0 ? [`${counts.agents} ${counts.agents === 1 ? "agent" : "agents"}`] : []),
    ...(processes > 0 ? [`${processes} ${processes === 1 ? "process" : "processes"}`] : []),
  ];
  const verb = counts.tasks === 1 ? "is" : "are";
  return `${parts.join(" and ")} ${verb}`;
}

function fmtWake(at: number, now: number): string {
  const when = new Date(at);
  const clock = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (new Date(now).toDateString() === when.toDateString()) return clock;
  if (at - now < 6 * 86_400_000) return `${when.toLocaleDateString(undefined, { weekday: "short" })} ${clock}`;
  return when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtWakeLong(at: number, now: number): string {
  const when = new Date(at);
  const clock = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (new Date(now).toDateString() === when.toDateString()) return `at ${clock}`;
  return `on ${when.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })} at ${clock}`;
}

export const ACTIVITY_TONE: Record<ActivityBadge["tone"], string> = {
  attention: "text-warning",
  live: "text-primary",
  quiet: "text-muted-foreground",
};

export function rowStatusText(
  session: { activity: SessionActivity; activityDetail?: SessionActivityDetail; activityAt?: number; updatedAt: number },
  now: number,
): { badge: ActivityBadge | null; time: string } {
  const badge = activityBadge(session, now);
  return { badge, time: fmtAgo(session.updatedAt, now) };
}

export function fmtDuration(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function rowSubtitle(
  session: { worktreeBranch?: string; projectBranch?: string; projectName?: string; workspacePath?: string },
  options: { projectShown: boolean } = { projectShown: false },
): { text: string; kind: "branch" | "project" | "path" } | null {
  if (session.worktreeBranch) return { text: session.worktreeBranch, kind: "branch" };
  if (session.projectBranch) return { text: session.projectBranch, kind: "branch" };
  if (session.projectName) return options.projectShown ? null : { text: session.projectName, kind: "project" };
  if (!session.workspacePath) return null;
  const leaf = session.workspacePath.split("/").filter(Boolean).pop();
  return { text: leaf ?? session.workspacePath, kind: "path" };
}
