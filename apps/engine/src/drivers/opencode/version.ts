export const OPENCODE_VERSION = "1.18.30";

export type OpenCodeVersionVerdict = "ok" | "drifted" | "incompatible";

export function openCodeVersionVerdict(found: string | undefined, expected: string = OPENCODE_VERSION): OpenCodeVersionVerdict {
  if (!found) return "incompatible";
  if (found === expected) return "ok";
  const [major, minor] = found.split(".");
  const [wantMajor, wantMinor] = expected.split(".");
  return major === wantMajor && minor === wantMinor ? "drifted" : "incompatible";
}

export function openCodeVersionMessage(found: string | undefined, expected: string = OPENCODE_VERSION): string {
  return openCodeVersionVerdict(found, expected) === "drifted"
    ? `Tested against OpenCode ${expected}; you have ${found}. Usually fine — suspect it first if a session misbehaves.`
    : `OpenCode ${found ?? "unknown"} does not match this adapter. Install opencode-ai@${expected} or choose its binary path in Settings.`;
}
