import type { ProviderWaitDetail } from "@telar/engine-client";
import { asRecord, str } from "./mapping";

export function providerWaitFrom(item: {
  type?: string;
  subtype?: string;
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number | null;
  no_response?: unknown;
  rate_limit_info?: unknown;
}): { detail: ProviderWaitDetail; blocking: boolean } | undefined {
  const int = (candidate: unknown): number | undefined =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? Math.trunc(candidate) : undefined;

  if (item.type === "system" && item.subtype === "api_retry") {
    const waited = int(asRecord(item.no_response).waited_ms);
    return {
      blocking: true,
      detail: {
        kind: "api_retry",
        ...(int(item.attempt) && int(item.attempt)! > 0 ? { attempt: int(item.attempt)! } : {}),
        ...(int(item.max_retries) === undefined ? {} : { maxAttempts: int(item.max_retries)! }),
        ...(int(item.retry_delay_ms) === undefined ? {} : { delayMs: int(item.retry_delay_ms)! }),
        // A connection error has no HTTP response, and the SDK reports that as
        // a null status. Absent says "no response" rather than inventing a 0.
        ...(int(item.error_status) === undefined ? {} : { status: int(item.error_status)! }),
        ...(waited === undefined ? {} : { waitedMs: waited }),
      },
    };
  }

  if (item.type !== "rate_limit_event") return undefined;
  const info = asRecord(item.rate_limit_info);
  const status = info.status;
  if (status !== "rejected" && status !== "allowed_warning") return undefined;
  const reported = str(info.rateLimitType);
  return {
    blocking: status === "rejected",
    detail: {
      kind: "rate_limit",
      limitStatus: status,
      // A CLOSED SET WITH A FALLBACK. The provider's field is an open string
      // and the set grows, but a durable row a person reads is the last place
      // an unvetted remote label should land. Anything unrecognised is `other`.
      ...(reported === undefined ? {} : { limitType: KNOWN_RATE_LIMIT_TYPES.has(reported) ? (reported as ProviderWaitDetail["limitType"]) : "other" }),
      ...(int(info.resetsAt) === undefined ? {} : { resetsAt: int(info.resetsAt)! }),
      // Finite: `typeof x === "number"` admits Infinity and NaN, and a meter
      // cannot render either.
      ...(typeof info.utilization === "number" && Number.isFinite(info.utilization) && info.utilization >= 0
        ? { utilization: info.utilization }
        : {}),
    },
  };
}

/** The provider's own vocabulary, verbatim from `SDKRateLimitInfo`. Anything
 *  outside it is reported as `other` rather than forwarded — see above. */
const KNOWN_RATE_LIMIT_TYPES = new Set(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included", "overage"]);

/** What a warning row has already said, so the next frame repeating it says
 *  nothing. Held per turn by both pumps — see `takeProviderWait`. */
export type LimitWarningSeen = { limitType?: ProviderWaitDetail["limitType"]; resetsAt?: number };

export function takeProviderWait(
  detail: ProviderWaitDetail,
  seen: LimitWarningSeen | undefined,
): { emit: boolean; seen: LimitWarningSeen | undefined } {
  if (detail.kind !== "rate_limit") return { emit: true, seen };
  if (detail.limitStatus === "rejected") return { emit: true, seen: undefined };
  if (seen !== undefined && seen.limitType === detail.limitType && seen.resetsAt === detail.resetsAt) return { emit: false, seen };
  return { emit: true, seen: { limitType: detail.limitType, resetsAt: detail.resetsAt } };
}

/** The collapsed label, derived once by the engine like every other row's. */
export function titleForProviderWait(detail: ProviderWaitDetail): string {
  if (detail.kind === "no_response") {
    const waited = detail.waitedMs === undefined ? "" : ` after ${durationText(detail.waitedMs)}`;
    return `The model has not answered${waited}`;
  }
  if (detail.kind === "rate_limit") {
    // `other` names nothing a person can act on, so it earns no parenthetical.
    const limit = detail.limitType && detail.limitType !== "other" ? ` (${detail.limitType.replaceAll("_", " ")})` : "";
    return detail.limitStatus === "rejected" ? `Rate limit reached${limit}` : `Approaching the rate limit${limit}`;
  }
  const attempt = detail.attempt === undefined ? "" : detail.maxAttempts ? ` (attempt ${detail.attempt} of ${detail.maxAttempts})` : ` (attempt ${detail.attempt})`;
  const delay = detail.delayMs === undefined ? "" : ` in ${durationText(detail.delayMs)}`;
  const because =
    detail.waitedMs === undefined
      ? detail.status === undefined
        ? "after a connection error"
        : `after HTTP ${detail.status}`
      : `after ${durationText(detail.waitedMs)} with no response`;
  return `Retrying${delay} ${because}${attempt}`;
}

/** Milliseconds as a person would say them. Sub-second stays in ms; anything
 *  longer reads in seconds to one decimal, because "1085ms" is a measurement
 *  and "1.1s" is a duration. */
function durationText(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 100) / 10}s`;
}

export class RateLimitedError extends Error {
  readonly resumeAt: number;
  readonly limitType?: ProviderWaitDetail["limitType"];
  constructor(resumeAt: number, limitType?: ProviderWaitDetail["limitType"]) {
    const limit = limitType && limitType !== "other" ? `${limitType.replaceAll("_", " ")} ` : "";
    super(`Claude's ${limit}usage limit was reached, so this turn stopped where it stood.`);
    this.name = "RateLimitedError";
    this.resumeAt = resumeAt;
    if (limitType !== undefined) this.limitType = limitType;
  }
}

export const PROVIDER_SILENCE_MS = 30_000;

export const END_TURN_GRACE_MS = 2_000;
