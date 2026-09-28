import type { Session } from "../protocol/entities";
import type { EngineTransport } from "../platform/transport";
import type { WorktreeInventory, WorktreeMoveResult, WorktreeReclaimItem, WorktreeReclaimOutcome, WorktreesRoot } from "./schema";

const sessionPath = (sessionId: string) => `/v2/sessions/${encodeURIComponent(sessionId)}`;

export const worktreesClient = {
  worktreesRoot(this: EngineTransport): Promise<{ worktreesRoot: WorktreesRoot }> {
    return this.request("GET", "/v2/worktrees-root");
  },

  setWorktreesRoot(this: EngineTransport, root: string | null): Promise<{ worktreesRoot: WorktreesRoot }> {
    return this.request("PUT", "/v2/worktrees-root", { root });
  },

  moveWorktrees(this: EngineTransport): Promise<{ move: WorktreeMoveResult }> {
    return this.request("POST", "/v2/worktrees-root/move", {});
  },

  worktrees(this: EngineTransport, options: { signal?: AbortSignal } = {}): Promise<{ inventory: WorktreeInventory }> {
    return this.request("GET", "/v2/worktrees", undefined, options.signal);
  },

  reclaimWorktrees(this: EngineTransport, items: readonly WorktreeReclaimItem[]): Promise<{ reclaim: WorktreeReclaimOutcome }> {
    return this.request("POST", "/v2/worktrees/reclaim", { items });
  },

  /** Deletes the checkout and keeps branch and conversation; 409 with the reason when it is not safe. */
  releaseSessionWorktree(this: EngineTransport, sessionId: string): Promise<{ session: Session }> {
    return this.request("POST", `${sessionPath(sessionId)}/worktree/release`, {});
  },

  restoreSessionWorktree(this: EngineTransport, sessionId: string): Promise<{ session: Session }> {
    return this.request("POST", `${sessionPath(sessionId)}/worktree/restore`, {});
  },
};
