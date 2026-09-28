import type { EngineTransport } from "../platform/transport";
import type { ComputerUseGrant, ComputerUseStatus } from "./schema";

export const computerUseClient = {
  computerUseStatus(this: EngineTransport): Promise<{ computerUse: ComputerUseStatus }> {
    return this.request("GET", "/v2/computer-use");
  },

  /** Asks macOS for Accessibility and Screen Recording and opens the Settings pane to finish in. */
  grantComputerUseAccess(this: EngineTransport): Promise<ComputerUseGrant> {
    return this.request("POST", "/v2/computer-use/grant", {});
  },

  /** `revealed: false` without a bundled helper. */
  revealComputerUseHelper(this: EngineTransport): Promise<{ revealed: boolean }> {
    return this.request("POST", "/v2/computer-use/reveal", {});
  },

  /** Resets only the bundled helper's grants; `reset: false` without one. */
  resetComputerUseAccess(this: EngineTransport): Promise<{ reset: boolean; message?: string }> {
    return this.request("POST", "/v2/computer-use/reset", {});
  },
};
