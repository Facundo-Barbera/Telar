/**
 * THE METER — what every scenario prints, and the only number this evaluation
 * is allowed to argue from.
 *
 * Two variants on one harness is a comparison, and a comparison made from
 * impressions is a framework choice by assertion, which the issue forbids. So
 * every model call and every tool call is counted here, tokens are read off the
 * message the provider actually returned, and the per-turn prompt size is kept
 * as a series rather than a total — scenario 7's question is not "how many
 * tokens" but "what shape is the curve, and where does it bend".
 */
export type TurnSample = {
  turn: number;
  promptTokens: number;
  completionTokens: number;
  messages: number;
};

export class Meter {
  readonly label: string;
  modelCalls = 0;
  promptTokens = 0;
  completionTokens = 0;
  readonly toolCalls = new Map<string, number>();
  readonly samples: TurnSample[] = [];
  private turn = 0;

  constructor(label: string) {
    this.label = label;
  }

  /** One provider round trip. `messages` is what went INTO it. */
  recordModelCall(input: { promptTokens?: number; completionTokens?: number; messages?: number }): void {
    this.modelCalls += 1;
    this.promptTokens += input.promptTokens ?? 0;
    this.completionTokens += input.completionTokens ?? 0;
    this.samples.push({
      turn: this.samples.length + 1,
      promptTokens: input.promptTokens ?? 0,
      completionTokens: input.completionTokens ?? 0,
      messages: input.messages ?? 0,
    });
  }

  recordToolCall(name: string): void {
    this.toolCalls.set(name, (this.toolCalls.get(name) ?? 0) + 1);
  }

  /** Mark a conversational turn boundary — scenario 7 counts 40 of these. */
  nextTurn(): number {
    this.turn += 1;
    return this.turn;
  }

  get turns(): number {
    return this.turn;
  }

  get totalToolCalls(): number {
    let total = 0;
    for (const count of this.toolCalls.values()) total += count;
    return total;
  }

  summary(): Record<string, unknown> {
    return {
      label: this.label,
      modelCalls: this.modelCalls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      toolCalls: Object.fromEntries([...this.toolCalls].sort(([a], [b]) => a.localeCompare(b))),
      totalToolCalls: this.totalToolCalls,
    };
  }

  print(): void {
    const tools = [...this.toolCalls].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${name}×${count}`);
    console.log(
      `[meter ${this.label}] model calls ${this.modelCalls} · prompt ${this.promptTokens} tok · completion ${this.completionTokens} tok · ` +
        `tools ${this.totalToolCalls}${tools.length ? ` (${tools.join(", ")})` : ""}`,
    );
  }

  /** Scenario 7's table: prompt tokens per turn, so a reader can see where a
   *  framework starts trimming rather than take a total's word for it. */
  printSeries(every = 1): void {
    console.log(`[meter ${this.label}] prompt tokens per model call`);
    for (const sample of this.samples) {
      if (sample.turn % every !== 0 && sample.turn !== this.samples.length) continue;
      console.log(`  call ${String(sample.turn).padStart(3)} · messages ${String(sample.messages).padStart(4)} · prompt ${String(sample.promptTokens).padStart(7)}`);
    }
  }
}
