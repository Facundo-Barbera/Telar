import type { ComputerUseGrant } from "@telar/engine-client";
import { ok, type Route } from "../../platform/http/route";
import { grantComputerUseAccess, resetComputerUseAccess, revealComputerUseHelper, type ComputerUseGate } from "./gate";

type Overrides = {
  grant?: () => Promise<ComputerUseGrant>;
  reset?: () => Promise<{ reset: boolean; message?: string }>;
};

/** The GET measures for real, and a `granted` answer is what puts the tools into a claim. */
export function computerUseRoutes(gate: ComputerUseGate, overrides: Overrides = {}): Route[] {
  return [
    { method: "GET", path: "/v2/computer-use", auth: "engine", handle: async () => ok({ computerUse: await gate.measure() }) },
    { method: "POST", path: "/v2/computer-use/grant", auth: "engine", handle: async () => ok(await (overrides.grant ?? grantComputerUseAccess)()) },
    { method: "POST", path: "/v2/computer-use/reveal", auth: "engine", handle: async () => ok(await revealComputerUseHelper()) },
    {
      method: "POST",
      path: "/v2/computer-use/reset",
      auth: "engine",
      async handle() {
        const outcome = await (overrides.reset ?? resetComputerUseAccess)();
        if (outcome.reset) await gate.measure();
        return ok(outcome);
      },
    },
  ];
}
