import type { AsyncGitRunner, GitResult, GitRunner } from "./runner";

const prefetchKey = (cwd: string, args: string[]): string => JSON.stringify([cwd, args]);

/** Only a ref the store's own validation would let through, so a prefetch never puts an unvalidated argument on a command line. */
export const prefetchableRef = (ref: string | undefined): string | undefined =>
  ref === undefined ? "HEAD" : /^[A-Za-z0-9][A-Za-z0-9._/@{}-]{0,200}$/.test(ref) ? ref : undefined;

/**
 * A sqlite command cannot span an await, yet its `rev-parse` refusals must reach the caller. `around` reads them
 * off the pool first and answers them for exactly the synchronous call that follows; anything else runs on `sync`.
 */
export class PrefetchedGit {
  private answers: Map<string, GitResult> | undefined;
  readonly run: GitRunner;

  constructor(
    sync: GitRunner,
    private readonly pool: AsyncGitRunner,
  ) {
    this.run = (cwd, args, options) => this.answers?.get(prefetchKey(cwd, args)) ?? sync(cwd, args, options);
  }

  async around<T>(cwd: string, questions: string[][], work: () => T): Promise<T> {
    const unique = new Map(questions.map((args) => [prefetchKey(cwd, args), args]));
    this.answers = new Map<string, GitResult>(
      await Promise.all([...unique].map(async ([key, args]) => [key, await this.pool(cwd, args)] as const)),
    );
    try {
      return work();
    } finally {
      this.answers = undefined;
    }
  }
}
