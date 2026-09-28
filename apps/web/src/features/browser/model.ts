import type { SitePermissionRecord } from "@/lib/desktop-site-permissions";
import { captureFileName } from "./annotation";
import type { DesktopBrowserBridge, DesktopBrowserCapture, DesktopBrowserDownload, DesktopBrowserPresentation, DesktopExtensionStatus } from "./types";

/** ⌘1..⌘9, the same nine the shell claims for a focused page. */
export const TAB_SELECT_CHORDS = Array.from({ length: 9 }, (_, index) => `CommandOrControl+${index + 1}`);

export const APPEARANCES: ReadonlyArray<{ key: "light" | "dark" | "system"; label: string }> = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  { key: "system", label: "System" },
];

/** One short sentence of the extension's real health for the toolbar. */
export function describeExtensionHealth(extension: DesktopExtensionStatus): { tone: "ok" | "warn" | "error"; text: string } {
  if (extension.phase === "failed") return { tone: "error", text: extension.error ?? "failed" };
  if (extension.phase !== "ready") {
    const text = extension.phase === "installing" ? "Installing 1Password…" : extension.phase === "loading" ? "Loading 1Password…" : "1Password starting…";
    return { tone: "warn", text };
  }
  const native = extension.health?.native;
  const errorCount = Object.values(extension.health?.workerErrors ?? {}).reduce((sum, n) => sum + n, 0);
  // Helper availability is app-level; pairing is the extension's to report, so never say "connected".
  if (native?.state === "unavailable") {
    if (native.lastExitCode === 1) return { tone: "error", text: native.hint ?? "1Password app helper unavailable — check this browser is added under 1Password → Settings → Browser." };
    return { tone: "error", text: `1Password app helper stopped unexpectedly${native.lastExitCode != null ? ` (exit ${native.lastExitCode})` : ""}.` };
  }
  if (errorCount) return { tone: "warn", text: `Extension reported ${errorCount} error${errorCount === 1 ? "" : "s"} (${Object.keys(extension.health!.workerErrors).join(", ")})` };
  if (native?.state === "available") return { tone: "ok", text: "1Password app helper available." };
  return { tone: "warn", text: "Loaded; 1Password app helper not seen yet." };
}

export function describeDownload(download: DesktopBrowserDownload): string {
  if (download.state === "started") return `Downloading ${download.filename}…`;
  if (download.state === "completed") return `Downloaded ${download.filename} to ${download.path.slice(0, download.path.length - download.filename.length - 1) || "/"}`;
  return download.state === "cancelled" ? `Download of ${download.filename} was cancelled.` : `Download of ${download.filename} failed.`;
}

export function presentationZoomLabel(presentation: DesktopBrowserPresentation | null | undefined): string {
  const percent = `${Math.round((presentation?.scale ?? 1) * 100)}%`;
  return (presentation?.zoom ?? "fit") === "fit" ? `Fit · ${percent}` : percent;
}

export function zoomLabel(factor: number | undefined): string {
  return `${Math.round((Number.isFinite(factor) && factor ? factor : 1) * 100)}%`;
}

/** The address a person sees: the page's URL, or empty on the blank tab. */
export function addressValue(url: string | undefined): string {
  return !url || url === "about:blank" ? "" : url;
}

/** The origin a permission belongs to; blank tabs, files and extension pages hold none. */
export function originOfUrl(url: string | undefined): string | undefined {
  if (!url || url === "about:blank") return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

// Measured off the address row's classes: back, forward, reload and profile at 22px,
// the lock at 18, the password control at 44, the ⋯ at 22, and seven 4px gaps.
export const ADDRESS_CONTROLS = 4 * 22 + 18 + 44 + 22 + 7 * 4;
export const ADDRESS_ROW_PADDING = 16;
/** Under this the address bar is no longer a place to type a URL. */
export const ADDRESS_INPUT_FLOOR = 200;
/** The camera and the pen, which fold into the ⋯ menu when the row cannot afford them. */
export const ADDRESS_TOOLS = 2 * 22 + 2 * 4;

export function addressInputRoom(rowWidth: number, tools = false): number {
  return rowWidth - ADDRESS_CONTROLS - (tools ? ADDRESS_TOOLS : 0);
}

export function addressRowFitsTools(rowWidth: number): boolean {
  return addressInputRoom(rowWidth, true) >= ADDRESS_INPUT_FLOOR;
}

export function fileFromCapture(shot: DesktopBrowserCapture, kind: "screenshot" | "annotated"): File {
  const binary = atob(shot.data);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  const type = shot.mimeType || "image/png";
  return new File([bytes], captureFileName(shot.url, kind), { type });
}

/** What one site holds in this scope's profile; `[]` for every reason there is no answer. */
export async function readSitePermissionsFor(bridge: DesktopBrowserBridge, scopeKey: string, origin: string | undefined): Promise<SitePermissionRecord[]> {
  if (!bridge.sitePermissions || !origin) return [];
  try {
    const answer = await bridge.sitePermissions({ scopeKey, origin });
    return answer && "kinds" in answer && Array.isArray(answer.kinds) ? (answer.kinds as SitePermissionRecord[]) : [];
  } catch {
    return [];
  }
}

/** Thrown by `bindNow` when the scope changed while it awaited, so the caller aborts. */
export class StaleScopeError extends Error {}
