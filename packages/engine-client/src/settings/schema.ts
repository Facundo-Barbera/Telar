import { z } from "zod";
import { EnvMode, ProviderDriverKind, RuntimeMode } from "../protocol/common";

export const MIN_AUTO_SETTLE_HOURS = 1;
export const MAX_AUTO_SETTLE_HOURS = 90 * 24;
export const DEFAULT_AUTO_SETTLE_HOURS = 3 * 24;
export const DEFAULT_SETTLE_DELEGATED_AFTER_HOURS = 1;
export const DEFAULT_SETTLED_TERMINAL_LIMIT = 5;
export const MAX_SETTLED_TERMINAL_LIMIT = 99;

const settleHours = z.number().int().min(MIN_AUTO_SETTLE_HOURS).max(MAX_AUTO_SETTLE_HOURS).nullable();

export const InboxPolicy = z.object({
  autoSettleAfterHours: settleHours,
  settleDelegatedAfterHours: settleHours.default(DEFAULT_SETTLE_DELEGATED_AFTER_HOURS),
  settledTerminalLimit: z.number().int().min(0).max(MAX_SETTLED_TERMINAL_LIMIT).default(DEFAULT_SETTLED_TERMINAL_LIMIT),
});
export type InboxPolicy = z.infer<typeof InboxPolicy>;

export const DEFAULT_INBOX_POLICY: InboxPolicy = {
  autoSettleAfterHours: DEFAULT_AUTO_SETTLE_HOURS,
  settleDelegatedAfterHours: DEFAULT_SETTLE_DELEGATED_AFTER_HOURS,
  settledTerminalLimit: DEFAULT_SETTLED_TERMINAL_LIMIT,
};

export const AgentOrientation = z.object({
  preamble: z.boolean(),
  /** Off removes the skill file rather than merely stopping it being refreshed. */
  skill: z.boolean(),
});
export type AgentOrientation = z.infer<typeof AgentOrientation>;

export const DEFAULT_AGENT_ORIENTATION: AgentOrientation = { preamble: true, skill: true };

export const SessionDefaults = z.object({
  envMode: EnvMode,
  resumeAfterRestart: z.boolean().optional(),
  /** Absent keeps the posture's own default; a creator's ceiling still narrows it. */
  runtimeMode: RuntimeMode.optional(),
  /** Absent is on. */
  resumeAfterRateLimit: z.boolean().optional(),
});
export type SessionDefaults = z.infer<typeof SessionDefaults>;

/** `null` clears an optional default. */
export type SessionDefaultsPatch = {
  envMode?: EnvMode;
  resumeAfterRestart?: boolean;
  runtimeMode?: RuntimeMode | null;
  resumeAfterRateLimit?: boolean;
};

export const DEFAULT_SESSION_DEFAULTS: SessionDefaults = { envMode: "local" };

export const MAX_SIDEBAR_PROJECT_ORDER = 1000;
export const MAX_SIDEBAR_SESSION_ORDER = 1000;

const sidebarKey = z.string().min(1).max(200);

export const SidebarMode = z.enum(["grouped", "flat"]);
export type SidebarMode = z.infer<typeof SidebarMode>;

export const SidebarLayout = z.object({
  projectOrder: z.array(sidebarKey).max(MAX_SIDEBAR_PROJECT_ORDER),
  sessionOrder: z.record(sidebarKey, z.array(sidebarKey).max(MAX_SIDEBAR_SESSION_ORDER)).default({}),
  pinnedOrder: z.array(sidebarKey).max(MAX_SIDEBAR_SESSION_ORDER).default([]),
  mode: SidebarMode.default("grouped"),
});
export type SidebarLayout = z.infer<typeof SidebarLayout>;

export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayout = { projectOrder: [], sessionOrder: {}, pinnedOrder: [], mode: "grouped" };

export const TextGenEffort = z.enum(["low", "medium", "high"]);
export type TextGenEffort = z.infer<typeof TextGenEffort>;

export const TextGenPolicy = z.object({
  titles: z.boolean(),
  /** Renames only engine-cut `telar/…` branches, never one a human named. */
  renameBranches: z.boolean(),
  driver: ProviderDriverKind,
  model: z.string().min(1).max(120).optional(),
  effort: TextGenEffort.optional(),
});
export type TextGenPolicy = z.infer<typeof TextGenPolicy>;

export const DEFAULT_TEXT_GEN_POLICY: TextGenPolicy = { titles: true, renameBranches: true, driver: "claude", model: "haiku" };
