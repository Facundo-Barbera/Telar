import type { Project, ProjectAvailability, Session } from "@telar/engine-client";
import { prefetchableRef, type PrefetchedGit } from "../../platform/git/prefetch";
import type { SessionLifecycle, SessionRecords } from "../sessions";
import type { SenderProof, TurnIntake } from "./intake";

type RequestPathDeps = {
  records: SessionRecords;
  lifecycle: SessionLifecycle;
  intake: TurnIntake;
  git: PrefetchedGit;
  getProject: (projectId: string) => Project;
  availability: (project: Project) => ProjectAvailability;
  requireSenderClaim: (proof: SenderProof) => { sessionId: string };
};

const cutQuestions = (baseRef: string | undefined): string[][] => {
  const base = prefetchableRef(baseRef);
  return [["rev-parse", "--is-inside-work-tree"], ...(base ? [["rev-parse", base]] : [])];
};

/** The synchronous commands an HTTP request runs, with their git questions read through the pool first. */
export class RequestPath {
  constructor(private readonly deps: RequestPathDeps) {}

  /** A project that is not there skips the prefetch: `createSession` refuses it before asking git anything. */
  async createSession(requested: Parameters<SessionLifecycle["createSession"]>[0], proof?: SenderProof): Promise<Session> {
    const input = proof ? { ...requested, startedFrom: { sessionId: this.deps.requireSenderClaim(proof).sessionId, runId: proof.runId } } : requested;
    let project: Project | undefined;
    try {
      project = input.projectId === undefined ? undefined : this.deps.getProject(input.projectId);
    } catch {
      return this.deps.lifecycle.createSession(input);
    }
    if (project === undefined || this.deps.availability(project) !== "available") return this.deps.lifecycle.createSession(input);
    const questions = [...cutQuestions(input.baseRef), ["rev-parse", "HEAD"]];
    return this.deps.git.around(project.root, questions, () => this.deps.lifecycle.createSession(input));
  }

  /** Only the first send to a worktree draft asks git anything; every other send is the synchronous command. */
  submitTurn(...args: Parameters<TurnIntake["submitTurn"]>): Promise<ReturnType<TurnIntake["submitTurn"]>> {
    return this.promotingDraft(args[0], () => this.deps.intake.submitTurn(...args));
  }

  submitAgentTurn(...args: Parameters<TurnIntake["submitAgentTurn"]>): Promise<ReturnType<TurnIntake["submitAgentTurn"]>> {
    return this.promotingDraft(args[0], () => this.deps.intake.submitAgentTurn(...args));
  }

  private async promotingDraft<T>(sessionId: string, work: () => T): Promise<T> {
    let root: string | undefined;
    let baseRef: string | undefined;
    try {
      const session = this.deps.records.require(sessionId);
      if (session.draft && session.envMode === "worktree" && session.projectId) {
        const project = this.deps.getProject(session.projectId);
        if (this.deps.availability(project) === "available") {
          root = project.root;
          baseRef = session.draft.baseRef;
        }
      }
    } catch {
      // Refused by `work` below, in its own words.
    }
    return root === undefined ? work() : this.deps.git.around(root, cutQuestions(baseRef), work);
  }
}
