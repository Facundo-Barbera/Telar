import path from "node:path";
import {
  AgentOrientation as AgentOrientationSchema,
  DEFAULT_AGENT_ORIENTATION,
  DEFAULT_INBOX_POLICY,
  DEFAULT_RETENTION_POLICY,
  DEFAULT_SESSION_DEFAULTS,
  DEFAULT_SIDEBAR_LAYOUT,
  DEFAULT_TEXT_GEN_POLICY,
  InboxPolicy as InboxPolicySchema,
  MAX_AUTO_SETTLE_HOURS,
  MAX_RETENTION_DAYS,
  MAX_SETTLED_TERMINAL_LIMIT,
  MAX_SIDEBAR_PROJECT_ORDER,
  MAX_SIDEBAR_SESSION_ORDER,
  MIN_AUTO_SETTLE_HOURS,
  MIN_RETENTION_DAYS,
  RETENTION_BUCKET_DAYS,
  RetentionPolicy as RetentionPolicySchema,
  SessionDefaults as SessionDefaultsSchema,
  SidebarLayout as SidebarLayoutSchema,
  SidebarMode,
  TextGenPolicy as TextGenPolicySchema,
  type AgentOrientation,
  type InboxPolicy,
  type JournalRetirement,
  type RetentionBucket,
  type RetentionPolicy,
  type RuntimeMode,
  type SessionDefaults,
  type SidebarLayout,
  type TextGenPolicy,
} from "@telar/engine-client";
import { EngineStateError, STATE_VERSION, type Kernel } from "../../platform/kernel";

const DAY_MS = 24 * 60 * 60 * 1000;

export const RUNTIME_MODES = new Set<RuntimeMode>(["approval-required", "auto-accept-edits", "auto", "full-access"]);

const blankSidebarLayout = (): SidebarLayout => ({ ...DEFAULT_SIDEBAR_LAYOUT, projectOrder: [], sessionOrder: {}, pinnedOrder: [], mode: "grouped" });

/** Copied out, so a caller never holds a reference into the next write. */
const cloneSidebarLayout = (layout: SidebarLayout): SidebarLayout => ({
  projectOrder: [...layout.projectOrder],
  sessionOrder: Object.fromEntries(Object.entries(layout.sessionOrder).map(([key, ids]) => [key, [...ids]])),
  pinnedOrder: [...layout.pinnedOrder],
  mode: layout.mode,
});

function boolean(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") throw new EngineStateError("invalid_request", message);
  return value;
}

/**
 * The machine-wide preference documents. Every getter falls back to the shipped
 * default on a missing or malformed file: a broken preference costs the
 * preference, never the list, session or turn it configures. Every setter takes
 * `unknown`, validates against the schema, and patches only the keys present.
 */
export class SettingsStore {
  constructor(
    private readonly kernel: Kernel,
    private readonly onTerminalLimitChanged: () => void = () => {},
  ) {}

  inbox(): InboxPolicy {
    try {
      const stored = this.kernel.readDocument(this.kernel.paths.inbox);
      const parsed = InboxPolicySchema.safeParse(stored);
      if (parsed.success) return parsed.data;
      // A document from before the hours move still means what it said.
      const days = (stored as { autoSettleAfterDays?: unknown } | undefined)?.autoSettleAfterDays;
      if (days === null) return { ...DEFAULT_INBOX_POLICY, autoSettleAfterHours: null };
      if (typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 90) {
        return { ...DEFAULT_INBOX_POLICY, autoSettleAfterHours: days * 24 };
      }
      return { ...DEFAULT_INBOX_POLICY };
    } catch {
      return { ...DEFAULT_INBOX_POLICY };
    }
  }

  setInbox(patch: { autoSettleAfterHours?: unknown; settleDelegatedAfterHours?: unknown; settledTerminalLimit?: unknown }): InboxPolicy {
    const next: InboxPolicy = { ...this.inbox() };
    const window = (value: unknown, what: string): number | null => {
      if (value === null) return null;
      const parsed = InboxPolicySchema.shape.autoSettleAfterHours.safeParse(value);
      if (!parsed.success) {
        throw new EngineStateError(
          "invalid_request",
          `${what} must be a whole number of hours between ${MIN_AUTO_SETTLE_HOURS} and ${MAX_AUTO_SETTLE_HOURS}, or null`,
        );
      }
      return parsed.data;
    };
    if (patch.autoSettleAfterHours !== undefined) next.autoSettleAfterHours = window(patch.autoSettleAfterHours, "auto-settle window");
    if (patch.settleDelegatedAfterHours !== undefined) next.settleDelegatedAfterHours = window(patch.settleDelegatedAfterHours, "delegation grace");
    if (patch.settledTerminalLimit !== undefined) {
      const parsed = InboxPolicySchema.shape.settledTerminalLimit.safeParse(patch.settledTerminalLimit);
      if (!parsed.success) {
        throw new EngineStateError("invalid_request", `settled terminal limit must be a whole number between 0 and ${MAX_SETTLED_TERMINAL_LIMIT}`);
      }
      next.settledTerminalLimit = parsed.data;
    }
    this.kernel.writeDocument(this.kernel.paths.inbox, { version: STATE_VERSION, ...next });
    if (patch.settledTerminalLimit !== undefined) this.onTerminalLimitChanged();
    return { ...next };
  }

  /** The shipped default is `never`: no reading of a broken file starts removing history. */
  retention(): RetentionPolicy {
    try {
      const parsed = RetentionPolicySchema.safeParse(this.kernel.readDocument(this.kernel.paths.retention));
      return parsed.success ? parsed.data : { ...DEFAULT_RETENTION_POLICY };
    } catch {
      return { ...DEFAULT_RETENTION_POLICY };
    }
  }

  /** A window without an export destination is refused rather than silently never swept. */
  setRetention(patch: { idleAfterDays?: unknown; exportTo?: unknown }): RetentionPolicy {
    const next: RetentionPolicy = { ...this.retention() };
    if (patch.idleAfterDays !== undefined) {
      if (patch.idleAfterDays === null) next.idleAfterDays = null;
      else {
        const parsed = RetentionPolicySchema.shape.idleAfterDays.safeParse(patch.idleAfterDays);
        if (!parsed.success)
          throw new EngineStateError(
            "invalid_request",
            `a retention window must be a whole number of days between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}, or null`,
          );
        next.idleAfterDays = parsed.data;
      }
    }
    if (patch.exportTo !== undefined) {
      if (patch.exportTo === null) next.exportTo = null;
      else {
        if (typeof patch.exportTo !== "string" || !patch.exportTo.trim() || !path.isAbsolute(patch.exportTo.trim()))
          throw new EngineStateError("invalid_request", "an export destination must be an absolute path");
        next.exportTo = patch.exportTo.trim();
      }
    }
    if (next.idleAfterDays !== null && !next.exportTo)
      throw new EngineStateError("invalid_request", "choose where the journal is exported before setting a retention window");
    this.kernel.writeDocument(this.kernel.paths.retention, { version: STATE_VERSION, ...next });
    return { ...next };
  }

  /** What each window would take on this store; `bytes` reads rows, so it's opt-in. */
  retentionPreview(options: { bytes?: boolean } = {}): RetentionBucket[] {
    const now = this.kernel.now();
    return RETENTION_BUCKET_DAYS.map((days) => ({
      days,
      ...this.kernel.executionStore.retentionPreview({ idleBefore: now - days * DAY_MS, now }, options),
    }));
  }

  /** Runs only when the policy has both a window and a destination. */
  sweepRetention(): JournalRetirement {
    const policy = this.retention();
    if (policy.idleAfterDays === null || !policy.exportTo) return { retired: 0, skipped: 0, events: 0 };
    const now = this.kernel.now();
    return this.kernel.executionStore.retireJournal({ idleBefore: now - policy.idleAfterDays * DAY_MS, now }, { exportTo: policy.exportTo });
  }

  orientation(): AgentOrientation {
    try {
      const parsed = AgentOrientationSchema.safeParse(this.kernel.readDocument(this.kernel.paths.orientation));
      return parsed.success ? parsed.data : { ...DEFAULT_AGENT_ORIENTATION };
    } catch {
      return { ...DEFAULT_AGENT_ORIENTATION };
    }
  }

  setOrientation(patch: { preamble?: unknown; skill?: unknown }): AgentOrientation {
    const next: AgentOrientation = { ...this.orientation() };
    for (const key of ["preamble", "skill"] as const) {
      if (patch[key] !== undefined) next[key] = boolean(patch[key], `${key} must be true or false`);
    }
    this.kernel.writeDocument(this.kernel.paths.orientation, { version: STATE_VERSION, ...next });
    return { ...next };
  }

  /** Read on the create path, so a broken file must never make sessions unopenable. */
  sessionDefaults(): SessionDefaults {
    try {
      const parsed = SessionDefaultsSchema.safeParse(this.kernel.readDocument(this.kernel.paths.sessionDefaults));
      return parsed.success ? parsed.data : { ...DEFAULT_SESSION_DEFAULTS };
    } catch {
      return { ...DEFAULT_SESSION_DEFAULTS };
    }
  }

  setSessionDefaults(patch: { envMode?: unknown; resumeAfterRestart?: unknown; runtimeMode?: unknown; resumeAfterRateLimit?: unknown }): SessionDefaults {
    const next: SessionDefaults = { ...this.sessionDefaults() };
    if (patch.envMode !== undefined) {
      const parsed = SessionDefaultsSchema.shape.envMode.safeParse(patch.envMode);
      if (!parsed.success) throw new EngineStateError("invalid_request", "default workspace must be local or worktree");
      next.envMode = parsed.data;
    }
    if (patch.resumeAfterRestart !== undefined) next.resumeAfterRestart = boolean(patch.resumeAfterRestart, "resumeAfterRestart must be true or false");
    if (patch.runtimeMode !== undefined) {
      if (patch.runtimeMode === null) delete next.runtimeMode;
      else if (RUNTIME_MODES.has(patch.runtimeMode as RuntimeMode)) next.runtimeMode = patch.runtimeMode as RuntimeMode;
      else throw new EngineStateError("invalid_request", "unknown runtime mode");
    }
    if (patch.resumeAfterRateLimit !== undefined) {
      next.resumeAfterRateLimit = boolean(patch.resumeAfterRateLimit, "resumeAfterRateLimit must be true or false");
    }
    this.kernel.writeDocument(this.kernel.paths.sessionDefaults, { version: STATE_VERSION, ...next });
    return { ...next };
  }

  /** The empty default reads as "alphabetical, nobody has moved anything". */
  sidebarLayout(): SidebarLayout {
    try {
      const parsed = SidebarLayoutSchema.safeParse(this.kernel.readDocument(this.kernel.paths.sidebarLayout));
      return parsed.success ? parsed.data : blankSidebarLayout();
    } catch {
      return blankSidebarLayout();
    }
  }

  /** Each field is its own patch, and a key listed twice is kept once, at its first position. */
  setSidebarLayout(patch: { projectOrder?: unknown; sessionOrder?: unknown; pinnedOrder?: unknown; mode?: unknown }): SidebarLayout {
    const next: SidebarLayout = { ...this.sidebarLayout() };
    if (patch.projectOrder !== undefined) {
      const parsed = SidebarLayoutSchema.shape.projectOrder.safeParse(patch.projectOrder);
      if (!parsed.success) {
        throw new EngineStateError("invalid_request", `projectOrder must be a list of up to ${MAX_SIDEBAR_PROJECT_ORDER} non-empty project group keys`);
      }
      next.projectOrder = [...new Set(parsed.data)];
    }
    if (patch.sessionOrder !== undefined) {
      const parsed = SidebarLayoutSchema.shape.sessionOrder.safeParse(patch.sessionOrder);
      if (!parsed.success) {
        throw new EngineStateError(
          "invalid_request",
          `sessionOrder must map a project group key to a list of up to ${MAX_SIDEBAR_SESSION_ORDER} non-empty session keys`,
        );
      }
      next.sessionOrder = Object.fromEntries(Object.entries(parsed.data).map(([key, ids]) => [key, [...new Set(ids)]]));
    }
    if (patch.pinnedOrder !== undefined) {
      const parsed = SidebarLayoutSchema.shape.pinnedOrder.safeParse(patch.pinnedOrder);
      if (!parsed.success) {
        throw new EngineStateError("invalid_request", `pinnedOrder must be a list of up to ${MAX_SIDEBAR_SESSION_ORDER} non-empty session keys`);
      }
      next.pinnedOrder = [...new Set(parsed.data)];
    }
    if (patch.mode !== undefined) {
      const parsed = SidebarMode.safeParse(patch.mode);
      if (!parsed.success) throw new EngineStateError("invalid_request", 'mode must be "grouped" or "flat"');
      next.mode = parsed.data;
    }
    this.kernel.writeDocument(this.kernel.paths.sidebarLayout, { version: STATE_VERSION, ...next });
    return cloneSidebarLayout(next);
  }

  textGen(): TextGenPolicy {
    try {
      const parsed = TextGenPolicySchema.safeParse(this.kernel.readDocument(this.kernel.paths.textGen));
      return parsed.success ? parsed.data : { ...DEFAULT_TEXT_GEN_POLICY };
    } catch {
      return { ...DEFAULT_TEXT_GEN_POLICY };
    }
  }

  /** A driver change drops the model: model ids mean nothing across harnesses. */
  setTextGen(patch: { titles?: unknown; renameBranches?: unknown; driver?: unknown; model?: unknown; effort?: unknown }): TextGenPolicy {
    const next: TextGenPolicy = { ...this.textGen() };
    if (patch.titles !== undefined) next.titles = boolean(patch.titles, "titles must be a boolean");
    if (patch.renameBranches !== undefined) next.renameBranches = boolean(patch.renameBranches, "renameBranches must be a boolean");
    if (patch.driver !== undefined) {
      if (patch.driver !== "claude" && patch.driver !== "codex" && patch.driver !== "opencode") {
        throw new EngineStateError("invalid_request", "text generation driver must be claude, codex or opencode");
      }
      if (patch.driver !== next.driver) delete next.model;
      next.driver = patch.driver;
    }
    if (patch.model !== undefined) {
      if (patch.model === null) delete next.model;
      else {
        const parsed = TextGenPolicySchema.shape.model.safeParse(patch.model);
        if (!parsed.success || parsed.data === undefined) {
          throw new EngineStateError("invalid_request", "text generation model must be a short model id, or null for the driver's default");
        }
        next.model = parsed.data;
      }
    }
    if (patch.effort !== undefined) {
      if (patch.effort === null) delete next.effort;
      else {
        const parsed = TextGenPolicySchema.shape.effort.safeParse(patch.effort);
        if (!parsed.success || parsed.data === undefined) throw new EngineStateError("invalid_request", "text generation effort must be low, medium or high, or null for low");
        next.effort = parsed.data;
      }
    }
    this.kernel.writeDocument(this.kernel.paths.textGen, { version: STATE_VERSION, ...next });
    return { ...next };
  }
}
