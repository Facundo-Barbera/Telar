import crypto from "node:crypto";
import { EngineClientError, qualifyTelarTool, TELAR_BROWSER_MCP_SERVER } from "@telar/engine-client";
import { runSecretFill } from "../domains/browser";
import type { DriverRequest, DriverRequestOutcome } from "../drivers";
import type { BrowserRefs, TurnHost } from "./host";

const WITHDRAWN_REASON = "the agent withdrew this request before it was answered";

export type TurnGate =BrowserRefs & { askEngine: (request: DriverRequest) => Promise<DriverRequestOutcome> };

/** Everything a claim binds: the engine gate and the browser's gate, navigation sink and secret fill on top of it. */
export function bindTurn(host: TurnHost, sessionId: string, runId: string, claimToken: string, controller: AbortController): TurnGate {
  const { client } = host.options;
  let lateRefusalLogged = false;
  const askEngine = async ({ kind, detail, toolUseId, deadlineMs, default: fallback, signal }: DriverRequest): Promise<DriverRequestOutcome> => {
    const requestId = `req_${toolUseId.replace(/[^A-Za-z0-9_-]/g, "")}`;
    const opened = await client.openRequest(sessionId, runId, claimToken, {
      requestId,
      kind,
      detail,
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
      ...(fallback !== undefined ? { default: fallback } : {}),
    }).catch((error: unknown) => {
      if (error instanceof EngineClientError && error.code === "conflict") {
        if (!lateRefusalLogged) {
          lateRefusalLogged = true;
          console.error(`[worker] tool request refused for ${runId}: ${error.message}`);
        }
        // Worded for the model: an engine refusal must not read as a person declining.
        throw new Error(
          "Telar could not decide this tool call: the turn it was made under has ended, so there was no live claim to open a permission request against. " +
            "Nothing ran, and nobody declined it. Report what you have; the call can be made again from a live turn. " +
            `(engine: ${error.message})`,
        );
      }
      throw error;
    });
    if (opened.state === "resolved") return { decision: opened.decision };
    // Abort must settle a parked request, or a stop during a decision blocks the driver forever.
    return new Promise<DriverRequestOutcome>((resolve) => {
      host.awaiting.set(`${runId}:${requestId}`, resolve);
      const onAbort = () => {
        if (!host.awaiting.delete(`${runId}:${requestId}`)) return;
        resolve({ decision: "cancel" });
      };
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
      const onWithdrawn = () => {
        if (!host.awaiting.delete(`${runId}:${requestId}`)) return;
        resolve({ decision: "cancel" });
        void client.resolveRequest(sessionId, requestId, { decision: "cancel", resolvedBy: "cancelled", reason: WITHDRAWN_REASON }).catch(() => undefined);
      };
      if (signal?.aborted) onWithdrawn();
      else signal?.addEventListener("abort", onWithdrawn, { once: true });
    });
  };
  const gate: BrowserRefs["gate"] = async ({ name, args, readOnly }) => {
    const { decision } = await askEngine({
      kind: readOnly ? "file_read" : "tool_call",
      detail: {
        kind: "tool_call",
        call: { name: qualifyTelarTool(name, TELAR_BROWSER_MCP_SERVER), server: TELAR_BROWSER_MCP_SERVER, input: args },
      },
      toolUseId: `${TELAR_BROWSER_MCP_SERVER}_${name}_${crypto.randomUUID().slice(0, 8)}`,
    });
    return decision === "accept" || decision === "acceptForSession";
  };
  const onNavigated: BrowserRefs["onNavigated"] = async (state) => {
    if (controller.signal.aborted) return;
    await client
      .reportObservations(sessionId, runId, claimToken, [{ kind: "browser.state", provider: state.provider, tabs: state.tabs }])
      .catch(() => undefined);
  };
  const fillSecret: BrowserRefs["fillSecret"] = (args, callBrowser, profile) =>
    runSecretFill(
      {
        callBrowser,
        secrets: host.secrets(),
        ...(profile ? { profile } : {}),
        ...(host.options.loginGrants ? { grants: host.options.loginGrants } : {}),
        ask: async (secret) => {
          const outcome = await askEngine({
            kind: "secret_access",
            detail: { kind: "secret_access", secret },
            toolUseId: `${TELAR_BROWSER_MCP_SERVER}_fill_secret_${crypto.randomUUID().slice(0, 8)}`,
          });
          const item = outcome.answers?.item;
          return {
            decision: outcome.decision,
            ...(typeof item === "string" ? { itemId: item } : {}),
            // Only a person ticking an unchecked box produces this; no mode or default can.
            ...(outcome.answers?.remember === true ? { remember: true } : {}),
          };
        },
      },
      args,
    );
  return { askEngine, gate, onNavigated, fillSecret };
}

/** Points the session's long-lived browser binding at this turn's claim. */
export function repointBrowser(host: TurnHost, sessionId: string, gate: BrowserRefs): boolean {
  const cached = host.browserLeases.get(sessionId);
  if (!cached) return false;
  cached.refs.gate = gate.gate;
  cached.refs.onNavigated = gate.onNavigated;
  cached.refs.fillSecret = gate.fillSecret;
  return true;
}
