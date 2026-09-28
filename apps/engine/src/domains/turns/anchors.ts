import type { GitReadFailure, Session } from "@telar/engine-client";
import type { AsyncGitRunner, GitResult } from "../../platform/git/runner";
import type { Kernel } from "../../platform/kernel";
import type { SessionQueues, SessionRecords } from "../sessions";

/** `rev-parse --verify HEAD` reads one file: a probe slower than this is a machine under load, recorded as `read`. */
const ANCHOR_PROBE_MS = 5_000;

export type TurnAnchorsHost = {
  /** Where an anchor is read: the session's checkout, or the project root once it is gone. */
  readRoot(session: Session): string | undefined;
  /** A turn that ended has just written to this checkout, so its cached reads are dropped. */
  forgetReadsUnder(root: string): void;
};

type AnchorPatch = { before?: string; after?: string; read?: GitReadFailure };

/**
 * Stamps where the repository stands at a turn's start and end. Never sync and never inline: the transitions run
 * under the store lock, so the probe is dispatched and its answer written back when it arrives.
 */
export class TurnAnchors {
  constructor(
    private readonly kernel: Kernel,
    private readonly records: SessionRecords,
    private readonly queues: SessionQueues,
    private readonly git: AsyncGitRunner,
    private readonly host: TurnAnchorsHost,
  ) {}

  anchor(sessionId: string, runId: string, side: "before" | "after"): void {
    let cwd: string | undefined;
    try {
      // `require`, not a full read: this runs inside `markRunning`, whose whole-queue parses are pinned by a test.
      cwd = this.host.readRoot(this.records.require(sessionId));
    } catch {
      // A session that vanished between the transition and here has nothing to anchor.
      return;
    }
    if (cwd === undefined) return;
    if (side === "after") this.host.forgetReadsUnder(cwd);
    void this.git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], { timeoutMs: ANCHOR_PROBE_MS })
      .then((result) => this.stamp(sessionId, runId, side, result))
      .catch(() => {
        // The runner reports every failure as a result; a throw here would be the store, and must not take the daemon.
      });
  }

  /**
   * status 0 is a sha; a timeout is `read: "timeout"`; status 1 is a repository with no commits yet, which is nothing
   * to write and nothing wrong; anything else is `read: "failed"`.
   */
  private stamp(sessionId: string, runId: string, side: "before" | "after", result: GitResult): void {
    if (result.timedOut) return this.write(sessionId, runId, { read: "timeout" });
    if (result.status === 0) {
      const sha = result.stdout.trim();
      return this.write(sessionId, runId, sha ? { [side]: sha } : { read: "failed" });
    }
    if (result.status === 1) return;
    this.write(sessionId, runId, { read: "failed" });
  }

  /** Re-reads the turn rather than closing over it: the world moved while git ran. */
  private write(sessionId: string, runId: string, patch: AnchorPatch): void {
    if (Object.keys(patch).length === 0) return;
    try {
      this.kernel.command("stampTurnAnchor", () => {
        const queue = this.queues.read(sessionId);
        const turn = queue.turns.find((candidate) => candidate.runId === runId);
        if (!turn) return;
        const merged = { ...turn.anchor, ...patch };
        // A later good read clears an earlier doubt, but a doubt never erases a sha already observed.
        if (patch.read === undefined) delete merged.read;
        turn.anchor = merged;
        turn.updatedAt = this.kernel.now();
        this.queues.write(sessionId, queue);
      });
    } catch {
      // A session deleted while the probe ran leaves nothing to write to.
    }
  }
}
