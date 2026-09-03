import { GREETINGS } from "@/lib/greetings";
import { findHost } from "@/lib/hosts/store";
import { forward } from "@/lib/hosts/proxy";
import { SessionCockpit } from "@/components/session-cockpit";

/**
 * A NEW CONVERSATION ON ANOTHER MAC. Same front door as the local canvas
 * (app/projects/[projectId]/sessions/new/page.tsx) — nothing is created by
 * arriving — with the project name resolved through that Mac's proxy rather
 * than the local engine, so the first paint names the project as the local
 * one does. Absent when the Mac is away; the id is the honest fallback.
 */
export const dynamic = "force-dynamic";

export default async function RemoteNewSessionPage({ params }: { params: Promise<{ hostId: string; projectId: string }> }) {
  const { hostId, projectId } = await params;
  return <SessionCockpit projectId={projectId} {...(await canvas(hostId, projectId))} />;
}

async function canvas(hostId: string, projectId: string): Promise<{ projectName?: string; greeting: number }> {
  const greeting = Math.floor(Math.random() * GREETINGS.length);
  try {
    const host = findHost(hostId);
    if (!host) return { greeting };
    const answer = await forward(new Request("http://cockpit.local/api/projects"), host, ["projects"]);
    if (!answer.ok) return { greeting };
    const { projects } = (await answer.json()) as { projects: Array<{ id: string; name: string }> };
    const found = projects.find((project) => project.id === projectId);
    return { ...(found ? { projectName: found.name } : {}), greeting };
  } catch {
    return { greeting };
  }
}
