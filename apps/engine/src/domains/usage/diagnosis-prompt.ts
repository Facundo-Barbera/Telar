import { USAGE_FIX_SETTINGS } from "@telar/engine-client";

export const USAGE_DIAGNOSIS_PROMPT_VERSION = 2;

const LAYOUT = `Telar's data folder (your working folder; every path below is relative to it):
- execution.sqlite: the engine's database. Query it with usage_sql (one SELECT at a time, 200 rows at most). Tables:
  - turn_summaries(session_id, run_id, sequence, origin, state, started_at, ended_at, item_count, answer_chars, usage_input, usage_output, usage_cache_read, usage_cache_create, usage_reasoning, usage_rows): one row per turn with its summed token usage. origin is user, session (a peer message or wake), schedule, restart or provider. Times are epoch milliseconds.
  - sessions(id, project_id, state, archived, settled_override, created_at, updated_at, last_turn_sequence, activity, title, branch): the session index.
  - documents(key, value): JSON documents. key 'sessions/<id>/session.json' is a session: driver, model {model, effort}, runtimeMode, startedFrom {sessionId} (who created it), usage {tokens, contextUsed, contextMax}. Use json_extract(value, '$.model.model').
  - items(session_id, item_id, run_id, ord, value): the transcript rows as JSON. value's detail.type is e.g. command_execution, file_read, mcp_tool_call, context_compaction, provider_wait (detail.wait.kind api_retry, rate_limit or no_response). length(value) is the stored size of a tool output.
  - events(session_id, id, value): the raw journal; value.type 'usage.updated' carries usage.tokens per provider call. Large; filter by session_id.
  - schedules(id, session_id, rule, enabled, next_run_at, last_run_at): rule is JSON, {"kind":"interval","everyMs":…} or {"kind":"fixed",…}.
- diagnostics/usage/<id>/digest.json: the digest this run was given. Start here.
- session-defaults.json, text-generation.json (the model that names sessions), orientation.json, retention.json, cleanup.json, mcp-servers.json, provider-instances.json, model-overlays.json, claude-default-model.json, claude-long-window-migration.json, claude-compaction-migration.json: settings, as JSON.
- usage-scan-cache.json, usage-model-rates.json: the Usage page's caches of the providers' own logs and prices.
- projects.json: registered projects. worktrees/: sessions' git checkouts (people's code; do not read it, it says nothing about usage).
- sessions/<id>/: attachments and setup logs. diagnostics/: engine logs.
Files holding keys, tokens or logins are refused; do not try to read them.`;

const PATTERNS = `How Telar spends tokens:
- Every tool call re-sends the whole context, so cache reads dominate a long session. Cost grows with context size × tool calls, not with the number of messages.
- A session woken by a peer's result, a schedule or a restart runs a whole turn on its existing context.
- An orchestrator fans out builders; each has its own context, model and effort.
- A 1M-token context window lets a context grow far past 200k before it compacts.
- Higher effort (high, xhigh, max) means more thinking and more tool calls.
- The digest's claudeLogs sorts every Claude transcript on this computer by evidence: "store" (a session in this Telar data folder), "telar" (Telar ran it, but not from this data folder: another install, another data folder, or sessions since deleted), and "outside" (no sign of Telar at all). claudeLogs.projects and claudeLogs.models break the same usage down by folder (p1…) and model.
- This data folder may hold only part of the person's Telar use. storeCoverage is the share of Telar-run usage it holds. When it is low, the sessions and turns tables miss most of the heavy runs: say so, and diagnose from claudeLogs.projects and claudeLogs.models instead.

Known patterns and their fixes (fix.setting is one of ${USAGE_FIX_SETTINGS.join(", ")}):
- long_lived_session, no_compaction: start a fresh session per task; lower the compaction threshold (compaction).
- long_context_window: use the standard window unless a task needs 1M (new-sessions-model).
- opus_builders, high_effort, wide_fan_out: run builders on a smaller model at medium effort (new-sessions-model, new-sessions-effort).
- wake_heavy: fewer, batched results to the orchestrator; settle delegated conversations sooner (settle-delegated).
- frequent_schedule: lengthen the schedule or point it at a small, fresh session (schedules).
- rate_limit_loops: turn off continuing after a reset, or run fewer sessions at once (continue-after-reset).
- big_tool_outputs: narrower commands and fewer MCP servers (mcp-servers).
- generated text on a large model: a small model for session names (generated-text-model).
- outside_telar: only "outside" transcripts count, those with no Telar marker. Say what share that is; never conclude Telar is not the cause from the gap between the logs and this data folder (none).
- store_misses_telar_runs: this data folder holds little of the Telar use in the logs. Say so plainly and base findings on claudeLogs (none).`;

const OUTPUT = `Your final message is the report and nothing else: one JSON object, no prose, no code fence.
{
  "window": "24h" | "7d" | "30d",            // the window the findings are about
  "summary": string,                          // ≤ 400 chars: usage, what is elevated, why
  "topConsumers": [{ "id": "s1", "share": 0.42, "reason": string }],   // ≤ 5; share of the window's tokens
  "findings": [{
    "signal": string,                         // a signal id from the digest, or a short id of your own
    "severity": "high" | "medium" | "low",
    "title": string,                          // ≤ 80 chars
    "why": string,                            // ≤ 400 chars
    "evidence": [{ "metric": string, "value": number }],   // ≤ 6; numbers you read, not estimates
    "fix": { "setting": one of the fix settings above, "action": string },   // ≤ 240 chars
    "estSavingsPct": number                   // optional, 0–100
  }]                                          // ≤ 6, most savings first
}`;

const RULES = `Rules:
- You are read-only and nobody will answer questions. Do not ask any; finish with the report.
- Refer to sessions only as s1, s2…, the digest's names, and to projects as p1, p2…. Never write a session id, title, project name, path, branch, prompt, code, host name or person's name.
- Cite only numbers you read from the digest or the database.
- Be brief: a handful of queries is enough. The digest already holds most of what you need.`;

export function usageDiagnosisPrompt(digestPath: string): string {
  return [
    `Diagnose why this person's coding-agent usage is high, and say what to change. The digest is at ${digestPath}.`,
    LAYOUT,
    PATTERNS,
    RULES,
    OUTPUT,
  ].join("\n\n");
}
