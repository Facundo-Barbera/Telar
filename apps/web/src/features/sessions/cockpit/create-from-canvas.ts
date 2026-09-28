import type { ProviderDriverKind, Session } from "@telar/engine-client";
import type { createEngineApi } from "@/platform/engine";
import { sessionHref } from "../session-list";
import { newSessionId } from "../session-mutations";

type CanvasSession = {
  projectId: string;
  hostId: string;
  title: string;
  driver: ProviderDriverKind;
  envMode: "local" | "worktree";
  base: { baseRef?: string; branchName?: string };
};

/** Creates a session from the canvas, moving the URL to it first and back to the canvas if the engine refuses. */
export async function createFromCanvas(
  api: ReturnType<typeof createEngineApi>,
  { projectId, hostId, title, driver, envMode, base }: CanvasSession,
): Promise<{ session: Session; canvas: string }> {
  const id = newSessionId();
  const canvas = window.location.pathname;
  window.history.replaceState(null, "", sessionHref({ id, projectId, hostId }));
  const created = await api.createSession(projectId, {
    id,
    title,
    driver,
    envMode,
    ...(envMode === "worktree" && base.baseRef ? { baseRef: base.baseRef } : {}),
    ...(envMode === "worktree" && base.branchName ? { branchName: base.branchName } : {}),
  }).catch((cause: unknown) => {
    window.history.replaceState(null, "", canvas);
    throw cause;
  });
  if (created.session.id !== id) window.history.replaceState(null, "", sessionHref({ id: created.session.id, projectId, hostId }));
  return { session: created.session, canvas };
}
