import { redirect } from "next/navigation";

// The standalone project-settings route folded into the project hub's Settings
// tab (variant-c). This route now only exists to redirect any bookmarked or
// external links there — no dead route, no duplicate settings UI.
export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  redirect(`/projects/${encodeURIComponent(name)}?tab=settings`);
}
