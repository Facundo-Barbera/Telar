// ONE DEFINITION, re-exported. The resolution itself moved to
// `packages/core/src/claude-executable.ts`, beside the code that actually
// spawns children (`engine.ts`'s agent(), `ultra/runner.ts`) — those call the
// SDK from core and could not see a resolver that lived only here, so on a
// machine without the SDK's optional binary every interactive session worked
// and every child agent died in milliseconds. This file stays as the app-layer
// import path its three call sites already use; it must never grow a second
// copy of the logic.
export { claudeExecutableOptions } from "@telar/core";
