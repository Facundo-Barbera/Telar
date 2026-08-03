import type { RuntimeMode } from "@telar/core/runtime-mode";

// Client-safe mirror of the provider-neutral runtime-mode presentation. Core's
// module also contains harness adapters, so importing its values from a client
// component pulls the server package into the browser graph. Keep this tiny
// vocabulary local and pin it against core in runtime-mode-client.test.ts.
export const RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const satisfies readonly RuntimeMode[];

export const isRuntimeMode = (value: unknown): value is RuntimeMode =>
  typeof value === "string" && (RUNTIME_MODES as readonly string[]).includes(value);

export const DEFAULT_RUNTIME_MODE: RuntimeMode = "auto";

export const RUNTIME_MODE_OPTIONS: ReadonlyArray<{
  value: RuntimeMode;
  label: string;
  description: string;
}> = [
  {
    value: "approval-required",
    label: "Supervised",
    description: "Ask before commands and file changes.",
  },
  {
    value: "auto-accept-edits",
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
  },
  {
    value: "auto",
    label: "Auto",
    description: "A reviewer approves routine actions; risky ones still ask.",
  },
  {
    value: "full-access",
    label: "Full access",
    description: "Allow commands and edits without prompts.",
  },
];
