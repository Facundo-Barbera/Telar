import { ProjectsCockpit } from "@/components/projects-cockpit";

/**
 * Managing projects: register a root, see what is registered, open a session.
 *
 * IT MOVED HERE FROM `/` so the front door could be a composer. Nothing about
 * the screen changed — what changed is that you now arrive at it on purpose,
 * rather than passing through it on the way to typing something.
 */
export const dynamic = "force-dynamic";

export default function ProjectsPage() {
  return <ProjectsCockpit />;
}
