import { SessionCockpit } from "@/components/session-cockpit";

/**
 * ONE CONVERSATION, NO CHROME — the address the Quest cockpit opens (#576).
 *
 * It differs from its sibling one directory up BY A PROP and by nothing else:
 * the same component, the same live updates, the same composer. What the path
 * buys is what a query flag could not — `app-shell.tsx` reads `usePathname()`
 * and skips the rail's `dynamic()` import here, so the largest chunk in the app
 * is never fetched into a headset that is already rendering a room.
 */
export const dynamic = "force-dynamic";

export default async function SoloSessionPage({
  params,
}: {
  params: Promise<{ projectId: string; sessionId: string }>;
}) {
  const { projectId, sessionId } = await params;
  return <SessionCockpit projectId={projectId} sessionId={sessionId} solo />;
}
