import { redirect } from "next/navigation";
import DashboardPage from "@/components/dashboard-page";
import { listAppShellChats, listAppShellProjects } from "@/lib/app-shell-data";

export const dynamic = "force-dynamic";

/**
 * The workspace is Telar's front door. Resolve the destination on the server
 * from local files so opening `/` does not mount a dashboard, issue four API
 * requests, and only then navigate to the composer.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  if (query.overview !== undefined) return <DashboardPage />;

  const projects = listAppShellProjects();
  if (projects.length === 0) return <DashboardPage />;

  const known = new Set(projects.map((project) => project.entry.name));
  const latestProject = listAppShellChats()
    .filter(
      (chat) =>
        !chat.archived &&
        chat.role !== "steerer" &&
        chat.role !== "escalation" &&
        typeof chat.project === "string" &&
        known.has(chat.project),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.project;
  const project = latestProject ?? projects[0].entry.name;
  redirect(`/projects/${encodeURIComponent(project)}/sessions/new`);
}
