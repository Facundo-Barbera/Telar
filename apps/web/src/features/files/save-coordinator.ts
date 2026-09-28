
export type SaveOutcome = { status: "saved" } | { status: "refused"; reason: string } | { status: "failed"; reason: string };

export type SaveCoordinatorOptions = {
  debounceMs: number;
  persist: (text: string) => Promise<SaveOutcome>;
  onPending: (pending: boolean) => void;
  onSaved: (text: string) => void;
  onProblem: (outcome: Extract<SaveOutcome, { status: "refused" } | { status: "failed" }>) => void;
  setTimer?: (run: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
};

export class SaveCoordinator {
  private timer: number | null = null;
  private latest = "";
  private revision = 0;
  private saved = 0;
  private saving = false;
  private stopped = false;
  private disposed = false;

  constructor(private readonly options: SaveCoordinatorOptions) {}

  change(text: string): void {
    if (this.stopped || this.disposed) return;
    this.latest = text;
    this.revision += 1;
    this.options.onPending(true);
    this.schedule(this.options.debounceMs);
  }

  flush(): Promise<void> {
    this.clear();
    return this.persist();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
    if (this.revision > this.saved) void this.persist();
  }

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
      if (revision === this.revision) {
        this.options.onPending(false);
        return;
      }
      if (this.disposed) return void this.persist();
      this.schedule(this.options.debounceMs);
      return;
    }

    if (outcome.status === "refused") {
      this.stopped = true;
      this.options.onProblem(outcome);
      return;
    }
    this.options.onProblem(outcome);
  }
}
