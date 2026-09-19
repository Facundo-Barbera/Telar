/**
 * A browser fixture for the REAL model picker (`AgentControl` in
 * components/composer-controls.tsx) on real captured catalogues.
 *
 * Not a mock of the picker: the production component renders against the
 * production family/generation/connection libs; only the catalogue transport
 * is a stub (stubs/model-catalogue-cache.ts) carrying this machine's actual
 * `model/list` and `opencode models` answers — including GPT-6-Astra as
 * Codex's default and gpt-5.6-luna reachable through BOTH the direct OpenAI
 * connection and OpenCode Go. The verdict strip prints the EXACT model id a
 * pick would put on the wire, which is how the duplicate-route case is proven
 * from the outside.
 */
import { createElement as h, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentControl } from "../../components/composer-controls";
import type { ModelChoice } from "../../lib/models";
import type { ProviderDriverKind } from "@telar/engine-client";

function Harness() {
  const [driver, setDriver] = useState<ProviderDriverKind>("opencode");
  const [choice, setChoice] = useState<ModelChoice>({});
  const [picks, setPicks] = useState<string[]>([]);
  const [locked, setLocked] = useState(false);

  return h(
    "div",
    { className: "flex min-h-screen flex-col gap-6 bg-background p-8 text-foreground" },
    h("h1", { className: "text-lg font-semibold" }, "Model picker fixture — real component, captured catalogues"),
    h(
      "p",
      { className: "max-w-xl text-sm text-muted-foreground" },
      "Codex is the installed CLI's Astra-era list; OpenCode is the verbatim 305-row multi-connection catalogue (gpt-5.6-luna exists on both OpenAI direct and OpenCode Go).",
    ),
    h(
      "label",
      { className: "flex items-center gap-2 text-sm" },
      h("input", { type: "checkbox", checked: locked, onChange: () => setLocked((value) => !value) }),
      "Session mode (provider fixed, models still switchable)",
    ),
    h(
      "div",
      { className: "flex items-center gap-2 rounded-lg border border-border bg-card p-3", id: "picker-host" },
      h(AgentControl, {
        driver,
        choice,
        onChange: (next: ModelChoice) => {
          setChoice(next);
          if (next.model) setPicks((previous) => [...previous, `${driver}:${next.model}`]);
        },
        ...(locked ? {} : {
          onDriverChange: (next: ProviderDriverKind) => {
            setDriver(next);
            setChoice({});
          },
        }),
      }),
    ),
    h(
      "div",
      { className: "rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs", id: "verdict" },
      h("div", { id: "verdict-driver" }, `driver: ${driver}`),
      h("div", { id: "verdict-model" }, `choice.model (wire id): ${choice.model ?? "(provider default)"}`),
      h("div", { id: "verdict-picks" }, `picks: ${picks.join("  →  ") || "(none yet)"}`),
    ),
  );
}

createRoot(document.getElementById("root")!).render(h(StrictMode, null, h(Harness)));
