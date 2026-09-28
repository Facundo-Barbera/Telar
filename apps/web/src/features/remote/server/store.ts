import path from "node:path";
import { canonicalPath, isLegacyTelarHome } from "@/platform/telar-home";

export class RemoteStoreError extends Error {}

export function remoteHome(
  env: { TELAR_HOME?: string; TELAR_COCKPIT?: string } = process.env as { TELAR_HOME?: string; TELAR_COCKPIT?: string },
): string {
  if (env.TELAR_COCKPIT !== "1") {
    throw new RemoteStoreError("Start the cockpit with bun run dev; ordinary web mode has no pairing store.");
  }
  const telarHome = env.TELAR_HOME?.trim();
  if (!telarHome || !path.isAbsolute(telarHome)) {
    throw new RemoteStoreError("Set an absolute TELAR_HOME before opening the cockpit.");
  }
  const canonicalHome = canonicalPath(telarHome);
  if (isLegacyTelarHome(canonicalHome)) {
    throw new RemoteStoreError("TELAR_HOME must not point at legacy Telar state.");
  }
  return path.join(canonicalHome, "remote");
}
