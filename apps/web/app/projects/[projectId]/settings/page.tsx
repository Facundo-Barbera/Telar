import { ProjectSettingsPage } from "@/components/settings/project-settings-page";

/**
 * ONE PROJECT'S SETTINGS.
 *
 * The legacy cockpit had `/projects/[name]/settings` and the rebuild had no
 * equivalent at all, which is why every per-project decision so far has had to
 * pretend to be a machine-wide one. MCP servers are the first thing that
 * genuinely is not — a repo's issue tracker belongs to the repo — so this is
 * where they live.
 */
export const dynamic = "force-dynamic";

export default async function ProjectSettings({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  // `h-full`, not `h-dvh`: this renders inside the app shell's inset, which is
  // already viewport-height, and a second full-viewport box pushes the pane's
  // own scroll container past the fold.
  return (
    <div className="h-full min-h-0">
      <ProjectSettingsPage projectId={projectId} />
    </div>
  );
}
