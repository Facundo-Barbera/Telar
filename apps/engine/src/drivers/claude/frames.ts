

/** The frame shape both pumps read; declared once so `handleTaskFrame`
 *  and the turn loop agree on it. */
export type SdkFrame = {
  type?: string;
  subtype?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: unknown;
  /** Result messages only: per-model usage, where `contextWindow`
   *  lives. Tokens in it are cumulative — see `contextMaxFrom`. */
  modelUsage?: unknown;
  compact_result?: string;
  compact_metadata?: unknown;
  message?: { content?: unknown[]; usage?: unknown; stop_reason?: string | null };
  /** The tool's full structured Output — where `structuredPatch` lives. */
  tool_use_result?: unknown;
  /** Set on everything a sub-agent produced: the id of the `Task`
   *  call that launched it. `null` on the main loop's own messages. */
  parent_tool_use_id?: string | null;
  stop_reason?: string | null;
  is_error?: boolean;
  result?: string;
  errors?: unknown[];
  /** The join key of the send this frame answers — see `turnUuid`. On
   *  the first stream frame and the result of a turn only. */
  user_message_uuid?: string;
  /** Set on a turn the CLI started by ITSELF (a background task's
   *  notification, an auto-continuation); absent on a human send. */
  origin?: { kind?: string };
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  task_type?: string;
  is_backgrounded?: boolean;
  workflow_name?: string;
  summary?: string;
  status?: string;
  /** `task_notification` only: where the task's output was written. */
  output_file?: string;
  /** `task_started` only: housekeeping the CLI does not surface as
   *  user work — the SDK says to exclude it from activity. */
  ambient?: boolean;
  /** `background_tasks_changed` only: every live background task
   *  after the change, with REPLACE semantics. */
  tasks?: unknown;
  /** `api_retry` only: the request failed retryably and the SDK is
   *  about to sleep `retry_delay_ms` before attempt `attempt`. */
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  /** `null` for a connection error that never got a response. */
  error_status?: number | null;
  /** `rate_limit_event` only: the account's limit state. */
  rate_limit_info?: unknown;
  /** Result messages: whitelisted lifecycle scalars, for the gated
   *  diagnostic line. Never journalled. */
  duration_ms?: number;
  duration_api_ms?: number;
  ttft_ms?: number;
  num_turns?: number;
  patch?: { status?: string; description?: string; error?: string; is_backgrounded?: boolean };
  /** `system/thinking_tokens` only: the open thought's running size. */
  estimated_tokens?: number;
  /** `session_state_changed` only: `idle | running | requires_action`. */
  state?: string;
  event?: {
    type?: string;
    index?: number;
    /** `id`/`name` on a `tool_use` block only. */
    content_block?: { type?: string; id?: string; name?: string };
    /** `estimated_tokens` rides `thinking_delta` when the CLI omits the
     *  thinking text itself — a running total, not an increment. */
    delta?: { type?: string; text?: string; thinking?: string; estimated_tokens?: number };
    /** `message_delta` only: the response's FINAL output token count.
     *  Every earlier report of it is a placeholder — see the pump. */
    usage?: unknown;
  };
};
