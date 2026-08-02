import { redirect } from "next/navigation";
import { listProjects } from "@telar/core/manifest";
import DashboardPage from "@/components/dashboard-page";
import { listChats } from "@/lib/store";

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

  const projects = listProjects().filter((project) => project.manifest !== null);
  if (projects.length === 0) return <DashboardPage />;

  const known = new Set(projects.map((project) => project.entry.name));
  const latestProject = listChats(undefined, { archived: "exclude" })
    .filter(
      (chat) =>
        chat.role !== "steerer" &&
        chat.role !== "escalation" &&
        typeof chat.project === "string" &&
        known.has(chat.project),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.project;
  const project = latestProject ?? projects[0].entry.name;
  redirect(`/projects/${encodeURIComponent(project)}/sessions/new`);
}
