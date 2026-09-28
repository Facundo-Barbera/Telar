import type { RuntimeMode } from "@telar/engine-client";

export const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

export const RUNTIME_MODE_HELP: Record<RuntimeMode, string> = {
  "approval-required": "Asks before every action",
  "auto-accept-edits": "Other actions still ask",
  auto: "A reviewer waves routine actions through",
  "full-access": "No prompts",
};

export const RUNTIME_MODES: RuntimeMode[] = ["approval-required", "auto-accept-edits", "auto", "full-access"];
