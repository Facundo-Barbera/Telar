import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { ProviderDriverKind } from "@telar/engine-client";
import { sanitizeTitle } from "../src/domains/providers/textgen";
import { runStructured, type TextGenEffort } from "../src/domains/providers/textgen-run";
import { titleContext } from "../src/domains/providers/title-context";
import { buildRegenerateTitlePrompt, buildTitlePrompt } from "../src/domains/providers/title-prompts";
import { titleEvalCases, type TitleEvalCase } from "./title-eval-cases";

export type EvalOptions = { provider: ProviderDriverKind; model?: string; effort?: TextGenEffort; out: string; baseline?: string; initial: boolean; second: boolean };
export type EvalResult = { id: string; title: string | null; latencyMs: number };

const PROVIDERS = ["claude", "codex", "opencode"] as const;
const EFFORTS = ["low", "medium", "high"] as const;

export function parseEvalArgs(argv: string[]): EvalOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      out: { type: "string" },
      baseline: { type: "string" },
      initial: { type: "boolean", default: false },
      second: { type: "boolean", default: false },
    },
  });
  const provider = PROVIDERS.find((name) => name === values.provider);
  if (!provider || !values.out) throw new Error("Use --provider claude|codex|opencode --out <directory> [--model m] [--effort low|medium|high] [--baseline results.json] [--initial | --second].");
  if (values.second && (values.initial || !values.baseline)) throw new Error("--second retitles a --baseline run of --initial titles.");
  const effort = values.effort === undefined ? undefined : EFFORTS.find((name) => name === values.effort);
  if (values.effort !== undefined && !effort) throw new Error("--effort must be low, medium or high.");
  return {
    provider,
    out: values.out,
    initial: values.initial ?? false,
    second: values.second ?? false,
    ...(values.model ? { model: values.model } : {}),
    ...(effort ? { effort } : {}),
    ...(values.baseline ? { baseline: values.baseline } : {}),
  };
}

export function evalPrompt(fixture: TitleEvalCase, initial: boolean, previousTitle = fixture.previousTitle): string {
  if (!initial) return buildRegenerateTitlePrompt(previousTitle, titleContext(fixture.messages));
  const first = fixture.messages.find((message) => message.role === "user");
  if (!first) throw new Error(`${fixture.id} has no user message.`);
  return buildTitlePrompt(first.text);
}

export function blindReview(cases: readonly TitleEvalCase[], results: readonly EvalResult[], baseline: readonly EvalResult[], newFirst: () => boolean) {
  const review = [];
  const answerKey = [];
  for (const fixture of cases) {
    const result = results.find((entry) => entry.id === fixture.id);
    if (!result) throw new Error(`No result for ${fixture.id}.`);
    const previous = baseline.length ? baseline.find((entry) => entry.id === fixture.id) : { title: fixture.previousTitle };
    if (!previous) throw new Error(`The baseline is missing ${fixture.id}.`);
    const first = newFirst();
    review.push({ id: fixture.id, request: fixture.request, rubric: fixture.rubric, A: first ? result.title : previous.title, B: first ? previous.title : result.title, preferred: "" });
    answerKey.push({ id: fixture.id, candidate: first ? "A" : "B" });
  }
  return { review, answerKey };
}

async function main(options: EvalOptions): Promise<void> {
  const baseline = options.baseline ? (JSON.parse(fs.readFileSync(options.baseline, "utf8")) as EvalResult[]) : [];
  const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false };
  const results: EvalResult[] = [];
  for (const fixture of titleEvalCases) {
    const started = performance.now();
    const answer = await runStructured(
      { driver: options.provider, ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}) },
      evalPrompt(fixture, options.initial, options.second ? (baseline.find((entry) => entry.id === fixture.id)?.title ?? undefined) : undefined),
      schema,
    );
    results.push({ id: fixture.id, title: sanitizeTitle(answer?.["title"]) ?? null, latencyMs: Math.round(performance.now() - started) });
    console.log(`${fixture.id}: ${results.at(-1)!.title ?? "(no answer)"}`);
  }
  const { review, answerKey } = blindReview(titleEvalCases, results, baseline, () => Math.random() < 0.5);
  fs.mkdirSync(options.out, { recursive: true });
  for (const [name, report] of Object.entries({ results, review, "answer-key": answerKey })) {
    fs.writeFileSync(path.join(options.out, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`Wrote ${results.length} cases to ${options.out}. Score review.json before opening answer-key.json.`);
}

if (import.meta.main) {
  process.env.TELAR_ALLOW_CLI ??= "1";
  await main(parseEvalArgs(process.argv.slice(2)));
}
