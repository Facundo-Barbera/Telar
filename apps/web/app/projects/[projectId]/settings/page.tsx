import { redirect } from "next/navigation";
import { projectSettingsHref } from "@/lib/project-settings-link";

/**
 * THE PER-PROJECT PAGE IS GONE; THIS IS THE DOOR CLOSING BEHIND IT (#363).
 *
 * It was a second settings shell with a second nav, holding MCP servers scoped
 * to the project and each plugin's own editor — the half of "this project's
 * settings" that Settings ▸ Projects had no room for. Both halves are groups on
 * that pane now, so there is one screen and one answer.
 *
 * A REDIRECT RATHER THAN A DELETED ROUTE, for `/projects/page.tsx`'s reason: a
 * bookmark, a reload or a stale history entry would otherwise land on a 404,
 * which is honest and is still a dead end. `?section=` is dropped deliberately —
 * the sections it named are groups on one pane now, so there is nothing left to
 * select.
 */
export const dynamic = "force-dynamic";

export default async function RetiredProjectSettings({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  redirect(projectSettingsHref(projectId));
}
