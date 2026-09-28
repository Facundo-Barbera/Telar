
const KNOWN_DEVICE_KINDS = [
  "browser",
  "phone",
  "tablet",
  "desktop",
  "cli",
  "service",
  "unknown",
] as const;
export type KnownDeviceKind = (typeof KNOWN_DEVICE_KINDS)[number];

export type DeviceKind = string;

export interface DeviceIdentity {
  kind: DeviceKind;
  client?: string;
  machine?: string;
  os?: string;
  address?: string;
  origin?: string;
}

export function cleanDeclared(value: unknown, limit = 64): string | undefined {
  if (typeof value !== "string") return undefined;
  const stripped = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return stripped.length === 0 ? undefined : stripped.slice(0, limit);
}

export function cleanKind(value: unknown): DeviceKind | undefined {
  if (typeof value !== "string") return undefined;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length === 0 ? undefined : slug.slice(0, 32);
}

export function isKnownDeviceKind(value: unknown): value is KnownDeviceKind {
  return (
    typeof value === "string" &&
    (KNOWN_DEVICE_KINDS as readonly string[]).includes(value)
  );
}

function kindLabel(kind: DeviceKind | undefined): string | undefined {
  if (!kind || kind === "unknown") return undefined;
  return kind
    .split("-")
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

export function sniffUserAgent(header: string | null | undefined): {
  kind: DeviceKind;
  client?: string;
  os?: string;
} {
  const ua = typeof header === "string" ? header.slice(0, 400) : "";
  if (ua.length === 0) return { kind: "unknown" };

  const embedded = /\bElectron\//.test(ua)
    ? /([A-Za-z][A-Za-z0-9._-]*)\/[\d.]+\s+Chrome\//.exec(ua)?.[1]
    : undefined;

  const client =
    embedded ? embedded
    : /\bElectron\//.test(ua) ? "Electron"
    : /\bEdg\//.test(ua) ? "Edge"
    : /\bOPR\//.test(ua) ? "Opera"
    : /\bFirefox\//.test(ua) ? "Firefox"
    : /\bChrome\//.test(ua) ? "Chrome"
    : /\bSafari\//.test(ua) ? "Safari"
    : undefined;

  const os =
    /\biPhone\b/.test(ua) ? "iOS"
    : /\biPad\b/.test(ua) ? "iPadOS"
    : /\bAndroid\b/.test(ua) ? "Android"
    : /\bMac OS X\b/.test(ua) ? "macOS"
    : /\bWindows NT\b/.test(ua) ? "Windows"
    : /\bLinux\b/.test(ua) ? "Linux"
    : undefined;

  const kind: DeviceKind =
    /\bElectron\//.test(ua) ? "desktop"
    : /\biPhone\b|\bAndroid\b.*\bMobile\b/.test(ua) ? "phone"
    : /\biPad\b|\bTablet\b/.test(ua) ? "tablet"
    : client ? "browser"
    : "unknown";

  return { kind, ...(client ? { client } : {}), ...(os ? { os } : {}) };
}

export function describeDevice(
  identity: DeviceIdentity,
  declaredName?: string,
): string {
  const name = cleanDeclared(declaredName);
  if (name) return name;
  const what = identity.client ?? kindLabel(identity.kind);
  const where = identity.machine ?? identity.os;
  const parts = [what, where].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "Unknown device";
}
