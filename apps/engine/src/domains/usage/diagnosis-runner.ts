import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageDiagnosis, UsageDigest } from "@telar/engine-client";
import type { EngineStore } from "../../state";
import { usageDigestFor } from "./digest-source";
import { USAGE_DIAGNOSIS_PROMPT_VERSION, usageDiagnosisPrompt } from "./diagnosis-prompt";
import { fallbackReport, parseDiagnosisReport, redactReport } from "./diagnosis-report";

const DEFAULT_MODEL = "sonnet";
const DEFAULT_EFFORT = "medium";
const FINISHED = new Set(["completed", "failed", "stopped", "discarded", "ambiguous"]);

export class UsageDiagnoses {
  constructor(
    private readonly store: EngineStore,
    private readonly digestOf: (store: EngineStore) => Promise<{ digest: UsageDigest; names: Record<string, string> }> = usageDigestFor,
  ) {}

  private get folder(): string {
    return path.join(this.store.paths.diagnostics, "usage");
  }

  private file(id: string, name: string): string {
    return path.join(this.folder, id, name);
  }

  private save(diagnosis: UsageDiagnosis): UsageDiagnosis {
    this.store.kernel.writeDocument(this.file(diagnosis.id, "diagnosis.json"), diagnosis, 0o600);
    return diagnosis;
  }

  private latestRecord(): UsageDiagnosis | undefined {
    let ids: string[];
    try {
      ids = fs.readdirSync(this.folder).filter((id) => id.startsWith("diag_"));
    } catch {
      return undefined;
    }
    return ids
      .map((id) => this.store.kernel.readDocument(this.file(id, "diagnosis.json")) as UsageDiagnosis | undefined)
      .filter((record): record is UsageDiagnosis => record?.id !== undefined)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  async start(input: { model?: string; effort?: string }): Promise<UsageDiagnosis> {
    const running = this.current();
    if (running?.state === "running") return running;
    const id = `diag_${crypto.randomUUID().replaceAll("-", "")}`;
    const model = input.model?.trim() || DEFAULT_MODEL;
    const effort = input.effort?.trim() || DEFAULT_EFFORT;
    const { digest, names } = await this.digestOf(this.store);
    const digestPath = path.relative(this.store.paths.root, this.file(id, "digest.json"));
    fs.mkdirSync(path.join(this.folder, id), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file(id, "digest.json"), JSON.stringify(digest, null, 2), { mode: 0o600 });
    const session = this.store.lifecycle.createSession({ title: "Usage diagnosis", driver: "claude", purpose: "usage-diagnosis", detached: true, model: { model, effort } });
    const runId = `run_${crypto.randomUUID().replaceAll("-", "")}`;
    this.store.intake.submitTurn(session.id, { runId, input: usageDiagnosisPrompt(digestPath) });
    return this.save({ id, sessionId: session.id, runId, state: "running", createdAt: this.store.kernel.now(), model: `${model} · ${effort}`, promptVersion: USAGE_DIAGNOSIS_PROMPT_VERSION, totals: digest.windows["30d"].totals, names });
  }

  current(): UsageDiagnosis | undefined {
    const record = this.latestRecord();
    if (!record || record.state !== "running") return record;
    const turn = this.store.queries.turns(record.sessionId).find((candidate) => candidate.runId === record.runId);
    if (!turn || !FINISHED.has(turn.state)) return record;
    const finishedAt = this.store.kernel.now();
    const digest = JSON.parse(fs.readFileSync(this.file(record.id, "digest.json"), "utf8")) as UsageDigest;
    if (turn.state !== "completed") {
      return this.save({ ...record, state: "failed", finishedAt, error: turn.failure?.message ?? `The diagnosis ${turn.state === "stopped" ? "was stopped" : "did not finish"}.` });
    }
    const parsed = parseDiagnosisReport(turn.resultText ?? "");
    const report = "report" in parsed ? parsed.report : fallbackReport(digest);
    return this.save({ ...record, state: "ready", finishedAt, report: redactReport(report, this.denyList(), digest), ...("error" in parsed ? { fallback: true, error: parsed.error } : {}) });
  }

  stop(): UsageDiagnosis | undefined {
    const record = this.latestRecord();
    if (!record || record.state !== "running") return record;
    this.store.turnLifecycle.stopTurn(record.sessionId, record.runId);
    return this.current() ?? record;
  }

  private denyList(): string[] {
    const words: string[] = [os.hostname(), os.hostname().replace(/\.local$/, ""), os.userInfo().username, path.basename(os.homedir())];
    for (const project of this.store.projectRegistry.list({ includeRemoved: true })) words.push(project.name, path.basename(project.root));
    for (const row of this.store.kernel.executionStore.statement("SELECT title, branch FROM sessions").all()) {
      if (typeof row.title === "string" && row.title.length >= 8 && row.title !== "New session") words.push(row.title);
      if (typeof row.branch === "string") words.push(row.branch, row.branch.split("/").pop() ?? "");
    }
    return words.filter((word) => word.length >= 3);
  }
}
