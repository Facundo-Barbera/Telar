/**
 * DEBOUNCED AUTOSAVE, WITH NOTHING LOST AT THE EDGES.
 *
 * Ported from t3 code's `FileSaveCoordinator`, which is the right shape and worth
 * copying rather than reinventing. Three behaviours make it correct, and each one
 * is a bug in the version you write first:
 *
 *   - A REVISION PER KEYSTROKE. Without it there is no way to tell "the write I
 *     just finished is the latest text" from "three more characters arrived while
 *     it was in flight", so the last few keystrokes silently never reach disk.
 *   - ONE WRITE AT A TIME, coalesced. Firing a second write while the first is
 *     open races two versions of the same file to the same path, and which one
 *     lands is down to the network.
 *   - FLUSH ON DISPOSE. Closing the tab 200ms after typing must not throw the
 *     last edit away. This is the one people notice, and always too late.
 *
 * WHAT IS OURS RATHER THAN T3'S: a write can be REFUSED (the file changed on
 * disk under you — see the engine's `writeWorkspaceFile`), which is neither a
 * success nor an exception. A refusal stops the loop and hands the reason back,
 * because retrying a conflict on a timer would either spin forever or, worse,
 * eventually win and destroy whatever the agent wrote.
 *
 * PURE AND FRAMEWORK-FREE, so the timing rules above can be tested without a
 * component, a browser, or a real file.
 */

/** What a persist attempt answers. `refused` carries the reason for the surface
 *  and stops the coordinator; `failed` is a transport problem, which is worth one
 *  more attempt when the next keystroke arrives. */
export type SaveOutcome = { status: "saved" } | { status: "refused"; reason: string } | { status: "failed"; reason: string };

export type SaveCoordinatorOptions = {
  debounceMs: number;
  persist: (text: string) => Promise<SaveOutcome>;
  /** Whether there is unsaved text right now — the header's dot. */
  onPending: (pending: boolean) => void;
  /** A write landed. Carries the text that landed, which is what the editor
   *  compares against to know it is clean. */
  onSaved: (text: string) => void;
  /** A write was refused or failed. The coordinator stops; the surface decides
   *  what to offer (re-read, retry, discard). */
  onProblem: (outcome: Extract<SaveOutcome, { status: "refused" } | { status: "failed" }>) => void;
  /** Injected so tests do not wait in real time. */
  setTimer?: (run: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
};

export class SaveCoordinator {
  private timer: number | null = null;
  private latest = "";
  private revision = 0;
  /** The revision that has reached disk. `revision` moving past it is exactly
   *  what "there is unsaved text" means. */
  private saved = 0;
  private saving = false;
  private stopped = false;
  private disposed = false;

  constructor(private readonly options: SaveCoordinatorOptions) {}

  /** Called on every keystroke. Cheap: it moves a counter and resets a timer. */
  change(text: string): void {
    if (this.stopped || this.disposed) return;
    this.latest = text;
    this.revision += 1;
    this.options.onPending(true);
    this.schedule(this.options.debounceMs);
  }

  /**
   * Save now, without waiting out the debounce — what ⌘S does.
   *
   * Returns the promise so a caller can await the outcome. A no-op when there is
   * nothing unsaved, so pressing it twice does not write the same bytes twice.
   */
  flush(): Promise<void> {
    this.clear();
    return this.persist();
  }

  /**
   * The editor is going away.
   *
   * FLUSHES RATHER THAN CANCELS. The pending write is the user's last few
   * keystrokes; dropping them because a tab closed is the failure this whole
   * class exists to prevent.
   */
  dispose(): void {
    this.disposed = true;
    this.clear();
    if (this.revision > this.saved) void this.persist();
  }

  /** After a refusal the surface may re-read and re-apply, which restarts this
   *  coordinator against the new baseline. */
  resume(text: string): void {
    this.stopped = false;
    this.latest = text;
    this.saved = this.revision;
    this.options.onPending(false);
  }

  private schedule(delay: number): void {
    this.clear();
    const set = this.options.setTimer ?? ((run, ms) => window.setTimeout(run, ms));
    this.timer = set(() => {
      this.timer = null;
      void this.persist();
    }, delay);
  }

  private clear(): void {
    if (this.timer === null) return;
    (this.options.clearTimer ?? ((handle: number) => window.clearTimeout(handle)))(this.timer);
    this.timer = null;
  }

  private async persist(): Promise<void> {
    // `saving` is the coalescing gate: a keystroke mid-write bumps the revision
    // and is picked up by the tail of this call rather than starting a second one.
    if (this.saving || this.stopped || this.revision === this.saved) return;
    this.saving = true;
    const text = this.latest;
    const revision = this.revision;
    let outcome: SaveOutcome;
    try {
      outcome = await this.options.persist(text);
    } catch (error) {
      outcome = { status: "failed", reason: error instanceof Error ? error.message : "The save could not be sent." };
    }
    this.saving = false;

    if (outcome.status === "saved") {
      this.saved = revision;
      this.options.onSaved(text);
      // Only clean if nothing arrived while that write was open.
      if (revision === this.revision) {
        this.options.onPending(false);
        return;
      }
      // More text arrived. Straight on rather than after another full debounce:
      // the typing that caused it already paid one.
      if (this.disposed) return void this.persist();
      this.schedule(this.options.debounceMs);
      return;
    }

    if (outcome.status === "refused") {
      // Stop. Retrying a conflict either spins or eventually wins, and winning
      // means overwriting whatever changed the file.
      this.stopped = true;
      this.options.onProblem(outcome);
      return;
    }
    // A transport failure leaves the text pending, so the next keystroke — or a
    // flush — tries again. The surface is told so it can say the file is unsaved
    // rather than letting a silent dot imply otherwise.
    this.options.onProblem(outcome);
  }
}
