import { LoomsBoard } from "./looms-board";

/**
 * The loom front — v0.
 *
 * One screen for the loom lifecycle: objective → threads working in their own
 * worktrees → verification through the environment scheduler → `ready` → a
 * human clicks Accept. The accept button is the moat made visible: it is the
 * only caller of the accept route, and it only lights up on `ready`.
 */
export const dynamic = "force-dynamic";

export default function LoomsPage() {
  return <LoomsBoard />;
}
