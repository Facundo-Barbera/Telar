/** Update with the exact SDK pin and rerun the real-process adapter smoke. */
export const OPENCODE_VERSION = "1.18.30";

/**
 * HOW FAR A RUNNING OPENCODE MAY BE FROM THE SDK THIS ADAPTER WAS BUILT AGAINST.
 *
 * THIS USED TO DEMAND AN EXACT MATCH, IN TWO PLACES, AND OPENCODE UPDATES
 * ITSELF (#655). A machine pinned at 1.18.30 woke up on 1.18.31 and the whole
 * provider went dark: `requireCli("opencode")` threw, so the model catalogue
 * came back EMPTY — not "Jev is missing", but every OpenCode model missing —
 * and `startOpenCodeRuntime` refused the same way, so no session could run
 * either. Nobody changed anything; the adapter broke on OpenCode's schedule.
 *
 * SO THE RULE IS THE ONE `cliUsable` ALREADY WRITES DOWN, and this is the spec
 * that never implemented it: "a hard gate on every unrecognised version would
 * lock somebody out of their own app the day a CLI ships a release we have not
 * blessed, and the common case — a patch ahead — demonstrably works. Only 'no
 * CLI at all' and 'wrong protocol family' are refusals." Claude Code — a much
 * heavier protocol integration than an OpenAPI client — has worked this way
 * since that module was written.
 *
 * MAJOR.MINOR IS THE PROTOCOL FAMILY. `@opencode-ai/sdk` is a generated client
 * for `opencode serve`'s HTTP surface, and a patch release of the server is not
 * where that surface changes. A minor bump is, so it still refuses — loudly,
 * with the version to install.
 */
export type OpenCodeVersionVerdict = "ok" | "drifted" | "incompatible";

export function openCodeVersionVerdict(found: string | undefined, expected: string = OPENCODE_VERSION): OpenCodeVersionVerdict {
  if (!found) return "incompatible";
  if (found === expected) return "ok";
  const [major, minor] = found.split(".");
  const [wantMajor, wantMinor] = expected.split(".");
  return major === wantMajor && minor === wantMinor ? "drifted" : "incompatible";
}

/** What a reader is told when the version is not the tested one. `drifted` is
 *  usable and says so; `incompatible` names the install that would fix it. */
export function openCodeVersionMessage(found: string | undefined, expected: string = OPENCODE_VERSION): string {
  return openCodeVersionVerdict(found, expected) === "drifted"
    ? `Tested against OpenCode ${expected}; you have ${found}. Usually fine — suspect it first if a session misbehaves.`
    : `OpenCode ${found ?? "unknown"} does not match this adapter. Install opencode-ai@${expected} or choose its binary path in Settings.`;
}
